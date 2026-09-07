import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { CREATE_TIMEOUT_MS, PROBE_TIMEOUT_MS, execText, redact, text, truncate } from "./backends/support.js";
import type { BackendRuntime } from "./backends/types.js";

/**
 * Parent coordination layer: the dispatch ledger, read-only `collect`, and gated `integrate`.
 * See docs/designs/parent-coordination-layer.md.
 *
 * Four properties are enforced here rather than left to callers:
 *
 * 1. Only the parent appends. No child is handed the ledger path and no child is asked to
 *    report state the parent then trusts; the parent resolves each child's branch head itself.
 * 2. Round membership is durable before any child exists, so a partial dispatch cannot shrink
 *    a round into "whatever happened to succeed".
 * 3. Acceptance is parent-owned. The gate policy comes from the parent checkout and runs once,
 *    on the combined tree, in an isolated worktree; a child never defines its own gates.
 * 4. A merge and a ledger append are not atomic, so `attempt` persists the candidate and target
 *    commits before the target is touched and recovery decides by git ancestry.
 *
 * The journal *pattern* comes from `offline.ts` (append-only JSONL, exclusive-create lock,
 * last-record-wins replay, a tolerated torn final record). The store, the schema, and the replay
 * are separate: writing a dispatch event into the backlog log would make that replay throw.
 */

const GIT = "git";
const LOCK_RETRIES = 50;
const LOCK_RETRY_MS = 20;
/** A lock file older than this is treated as abandoned by a crashed process. */
const LOCK_STALE_MS = 60_000;
const GATE_POLICY_SCHEMA_VERSION = 1;
const MIN_GATE_TIMEOUT_MS = 1_000;
const MAX_GATE_TIMEOUT_MS = 1_800_000;
const MAX_GATE_OUTPUT_CHARS = 2_000;
const GATE_OUTPUT_BUFFER = 4_000_000;
const ROUND_ID = /^rd-[a-z0-9]{1,24}-[a-z0-9]{1,16}$/;

/** Parent-owned gate policy, relative to the parent checkout root. */
export const GATE_POLICY_RELATIVE_PATH = ".orca-task-dispatch/gates.json";

/**
 * Package-neutral state root: this package serves both Pi and OMP, so it must not write into
 * either host's private directory. `ORCA_DISPATCH_STATE_ROOT` exists so a test or a fleet
 * operator can redirect every store without a code change.
 */
export function defaultStateRoot(): string {
  return join(text(process.env.ORCA_DISPATCH_STATE_ROOT) || join(homedir(), ".orca-task-dispatch"), "ledger");
}

/**
 * The three identities that select one parent's ledger. `backendId` is `WorktreeBackend.id`;
 * `repoId` and `parentWorktreeId` are `ParentContext.repoId` and `ParentContext.worktreeId`.
 * No new field is added to `ParentContext`.
 */
export type LedgerLocation = {
  backendId: string;
  repoId: string;
  parentWorktreeId: string;
};

export type RequestedMember = { name: string; scope: string[] };

export type DispatchedMember = {
  name: string;
  branch: string;
  worktreeId: string | null;
  worktreePath: string | null;
};

export type ObservedMember = { name: string; sha: string };

export type AttemptState = {
  policyDigest: string;
  target: string;
  targetSha: string;
  candidateSha: string;
  observed: ObservedMember[];
};

export type RoundState = {
  roundId: string;
  at: string;
  host: string;
  baseHead: string;
  members: RequestedMember[];
  // `| undefined` under exactOptionalPropertyTypes: replay builds these by spreading parsed
  // records, so the absent case must be representable rather than merely omittable.
  supersedes?: string | undefined;
  dispatched: DispatchedMember[];
  failedMembers?: string[] | undefined;
  attempt?: AttemptState | undefined;
  outcome?: "merged" | "held" | undefined;
  reason?: string | undefined;
  finalTargetSha?: string | undefined;
};

type LedgerRecord = {
  kind: "round" | "dispatched" | "dispatch-failed" | "attempt" | "merged" | "held";
  roundId: string;
  at: string;
  host: string;
  baseHead?: string | undefined;
  members?: RequestedMember[] | undefined;
  supersedes?: string | undefined;
  member?: string | undefined;
  branch?: string | undefined;
  worktreeId?: string | null | undefined;
  worktreePath?: string | null | undefined;
  failed?: string[] | undefined;
  message?: string | undefined;
  policyDigest?: string | undefined;
  target?: string | undefined;
  targetSha?: string | undefined;
  candidateSha?: string | undefined;
  observed?: ObservedMember[] | undefined;
  reason?: string | undefined;
};

/**
 * Identities are used as supplied, with separators normalized and one trailing slash stripped.
 * They are deliberately **not** lowercased: on a case-sensitive filesystem two distinct parents
 * can differ only by case, and folding them would merge two ledgers into one.
 */
export function normalizeIdentity(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/$/, "");
}

/** `sha256` over canonical JSON of the backend id plus the two `ParentContext` identities. */
export function ledgerKey(location: LedgerLocation): string {
  const canonical = JSON.stringify([
    normalizeIdentity(location.backendId),
    normalizeIdentity(location.repoId),
    normalizeIdentity(location.parentWorktreeId),
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

export type LedgerPaths = { key: string; log: string; lock: string; stateRoot: string };

/** The log and its sibling lock live outside every worktree, so no child can address them. */
export function ledgerPaths(location: LedgerLocation, stateRoot = defaultStateRoot()): LedgerPaths {
  const key = ledgerKey(location);
  return { key, log: join(stateRoot, `${key}.jsonl`), lock: join(stateRoot, `${key}.lock`), stateRoot };
}

function now(): string {
  return new Date().toISOString();
}

function newRoundId(): string {
  return `rd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Round ids are generated here and only ever echoed back; a caller-supplied id is still checked. */
export function validateRoundId(value: unknown): string {
  const roundId = text(value);
  if (!ROUND_ID.test(roundId)) throw new Error("roundId must be a dispatch round id of the form rd-<time>-<random>");
  return roundId;
}

/**
 * Exclusive lock via atomic create, matching `offline.ts`: POSIX advisory locks are unavailable
 * on Windows, so an exclusive open is the one primitive both platforms honour. A lock left by a
 * crashed process is reclaimed after LOCK_STALE_MS, otherwise one crash would wedge the ledger.
 *
 * This variant awaits its body because the target update is a sequence of git invocations that
 * must not interleave with another integration.
 */
async function withLock<T>(paths: LedgerPaths, run: () => Promise<T>): Promise<T> {
  mkdirSync(paths.stateRoot, { recursive: true });

  for (let attempt = 0; ; attempt++) {
    try {
      closeSync(openSync(paths.lock, "wx"));
      break;
    } catch (error) {
      const isBusy = error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST";
      if (!isBusy) throw error;

      try {
        if (Date.now() - statSync(paths.lock).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(paths.lock);
          continue;
        }
      } catch {
        // The holder released it between our open and stat; retry immediately.
        continue;
      }

      if (attempt >= LOCK_RETRIES) throw new Error(`Dispatch ledger lock is held: ${paths.lock}`);
      const retry = Promise.withResolvers<void>();
      setTimeout(retry.resolve, LOCK_RETRY_MS);
      await retry.promise;
    }
  }

  try {
    return await run();
  } finally {
    try {
      unlinkSync(paths.lock);
    } catch {
      // A missing lock must not mask the operation's own outcome.
    }
  }
}

function append(paths: LedgerPaths, record: LedgerRecord): void {
  mkdirSync(paths.stateRoot, { recursive: true });
  appendFileSync(paths.log, `${JSON.stringify(record)}\n`, "utf8");
}

type ParseOutcome = { ok: true; record: LedgerRecord } | { ok: false; reason: "json-torn" | "schema-invalid" };

function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function nullableString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function parseMembers(value: unknown): RequestedMember[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const members: RequestedMember[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const source: Record<string, unknown> = { ...entry };
    const name = stringField(source, "name");
    const scope = source.scope;
    if (!name || !Array.isArray(scope) || scope.length === 0) return undefined;
    if (scope.some(path => typeof path !== "string" || path.trim() === "")) return undefined;
    members.push({ name, scope: scope.filter((path): path is string => typeof path === "string") });
  }
  return members;
}

function parseObserved(value: unknown): ObservedMember[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const observed: ObservedMember[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const source: Record<string, unknown> = { ...entry };
    const name = stringField(source, "name");
    const sha = stringField(source, "sha");
    if (!name || !sha) return undefined;
    observed.push({ name, sha });
  }
  return observed;
}

/**
 * A truncated JSON line is a crash mid-append and may be tolerated at the very end of the log.
 * A line that parses but violates the schema is corruption wherever it appears, including the
 * last line: dropping it could hide a `merged` outcome and invite a second merge.
 */
function parseLedgerRecord(line: string): ParseOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, reason: "json-torn" };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "schema-invalid" };
  const source: Record<string, unknown> = { ...raw };
  const { kind, roundId, at, host } = source;
  if (typeof roundId !== "string" || !roundId.trim()) return { ok: false, reason: "schema-invalid" };
  if (typeof at !== "string" || !at.trim() || typeof host !== "string") return { ok: false, reason: "schema-invalid" };

  const base = { roundId, at, host };
  if (kind === "round") {
    const baseHead = stringField(source, "baseHead");
    const members = parseMembers(source.members);
    if (!baseHead || !members) return { ok: false, reason: "schema-invalid" };
    return { ok: true, record: { kind, ...base, baseHead, members, supersedes: stringField(source, "supersedes") } };
  }
  if (kind === "dispatched") {
    const member = stringField(source, "member");
    const branch = stringField(source, "branch");
    if (!member || !branch) return { ok: false, reason: "schema-invalid" };
    return {
      ok: true,
      record: {
        kind,
        ...base,
        member,
        branch,
        worktreeId: nullableString(source, "worktreeId"),
        worktreePath: nullableString(source, "worktreePath"),
      },
    };
  }
  if (kind === "dispatch-failed") {
    const failed = source.failed;
    if (!Array.isArray(failed) || failed.length === 0) return { ok: false, reason: "schema-invalid" };
    if (failed.some(name => typeof name !== "string" || name.trim() === "")) return { ok: false, reason: "schema-invalid" };
    return {
      ok: true,
      record: {
        kind,
        ...base,
        failed: failed.filter((name): name is string => typeof name === "string"),
        message: stringField(source, "message"),
      },
    };
  }
  if (kind === "attempt") {
    const policyDigest = stringField(source, "policyDigest");
    const target = stringField(source, "target");
    const targetSha = stringField(source, "targetSha");
    const candidateSha = stringField(source, "candidateSha");
    const observed = parseObserved(source.observed);
    if (!policyDigest || !target || !targetSha || !candidateSha || !observed) return { ok: false, reason: "schema-invalid" };
    return { ok: true, record: { kind, ...base, policyDigest, target, targetSha, candidateSha, observed } };
  }
  if (kind === "merged") {
    const targetSha = stringField(source, "targetSha");
    if (!targetSha) return { ok: false, reason: "schema-invalid" };
    return { ok: true, record: { kind, ...base, targetSha, target: stringField(source, "target") } };
  }
  if (kind === "held") {
    const reason = stringField(source, "reason");
    if (!reason) return { ok: false, reason: "schema-invalid" };
    return { ok: true, record: { kind, ...base, reason } };
  }
  return { ok: false, reason: "schema-invalid" };
}

/**
 * Replay the ledger; a round's state is its last record per field. Exactly one malformed final
 * record with no later nonblank line is tolerated, because that is the interrupted append crash
 * recovery depends on. Anything else fails loudly.
 */
export function replayLedger(log: string): Map<string, RoundState> {
  const rounds = new Map<string, RoundState>();
  if (!existsSync(log)) return rounds;

  const lines = readFileSync(log, "utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    const outcome = parseLedgerRecord(line);
    if (!outcome.ok) {
      const isTrailing = lines.slice(index + 1).every(rest => rest.trim() === "");
      if (outcome.reason === "json-torn" && isTrailing) break;
      throw new Error(`Dispatch ledger is corrupt at line ${index + 1} (${outcome.reason}): ${log}`);
    }
    const record = outcome.record;

    if (record.kind === "round") {
      rounds.set(record.roundId, {
        roundId: record.roundId,
        at: record.at,
        host: record.host,
        baseHead: record.baseHead ?? "",
        members: record.members ?? [],
        supersedes: record.supersedes,
        dispatched: [],
      });
      continue;
    }

    const current = rounds.get(record.roundId);
    // A record for a round that was never opened describes nothing this ledger can act on.
    if (!current) continue;

    if (record.kind === "dispatched") {
      const dispatched = current.dispatched.filter(entry => entry.name !== record.member);
      dispatched.push({
        name: record.member ?? "",
        branch: record.branch ?? "",
        worktreeId: record.worktreeId ?? null,
        worktreePath: record.worktreePath ?? null,
      });
      rounds.set(record.roundId, { ...current, dispatched });
    } else if (record.kind === "dispatch-failed") {
      // Terminal by construction: a round that could not be created in full is never integrated.
      const failed = record.failed ?? [];
      rounds.set(record.roundId, {
        ...current,
        failedMembers: failed,
        outcome: "held",
        reason: `dispatch-failed: ${failed.join(", ")}${record.message ? ` (${record.message})` : ""}`,
      });
    } else if (record.kind === "attempt") {
      rounds.set(record.roundId, {
        ...current,
        attempt: {
          policyDigest: record.policyDigest ?? "",
          target: record.target ?? "",
          targetSha: record.targetSha ?? "",
          candidateSha: record.candidateSha ?? "",
          observed: record.observed ?? [],
        },
      });
    } else if (record.kind === "merged") {
      rounds.set(record.roundId, { ...current, outcome: "merged", finalTargetSha: record.targetSha });
    } else {
      rounds.set(record.roundId, { ...current, outcome: "held", reason: record.reason });
    }
  }

  return rounds;
}

/** Read-only view of one parent's ledger. Appends nothing. */
export function readLedger(location: LedgerLocation, stateRoot = defaultStateRoot()): Map<string, RoundState> {
  return replayLedger(ledgerPaths(location, stateRoot).log);
}

export type BeginRoundInput = {
  baseHead: string;
  members: RequestedMember[];
  supersedes?: string | undefined;
};

/**
 * Open a round. Membership is durable **before** any child is created, so a dispatch that partly
 * fails cannot shrink the round to the children that happened to succeed.
 *
 * A superseding round is the only recovery path for a held round, so the reference is validated
 * here rather than trusted: superseding a merged or unknown round would reinterpret pinned SHAs.
 */
export async function beginRound(
  location: LedgerLocation,
  input: BeginRoundInput,
  stateRoot = defaultStateRoot(),
): Promise<string> {
  if (!input.baseHead.trim()) throw new Error("a round requires the exact committed parent HEAD");
  if (input.members.length === 0) throw new Error("a round requires at least one requested member");
  const paths = ledgerPaths(location, stateRoot);

  return withLock(paths, async () => {
    if (input.supersedes !== undefined) {
      const superseded = replayLedger(paths.log).get(input.supersedes);
      if (!superseded) throw new Error(`Cannot supersede unknown round ${input.supersedes}`);
      if (superseded.outcome !== "held") {
        throw new Error(`Only a held round can be superseded; ${input.supersedes} is ${superseded.outcome ?? "still open"}`);
      }
    }
    const roundId = newRoundId();
    append(paths, {
      kind: "round",
      roundId,
      at: now(),
      host: hostname(),
      baseHead: input.baseHead,
      members: input.members.map(member => ({ name: member.name, scope: [...member.scope] })),
      supersedes: input.supersedes,
    });
    return roundId;
  });
}

export type DispatchOutcomeInput = {
  dispatched: DispatchedMember[];
  failed: Array<{ name: string; message: string }>;
};

/**
 * Close the dispatch transaction: one `dispatched` record per created child, then a terminal
 * `dispatch-failed` if any member could not be created. A child never writes either record.
 */
export async function recordDispatchOutcome(
  location: LedgerLocation,
  roundId: string,
  outcome: DispatchOutcomeInput,
  stateRoot = defaultStateRoot(),
): Promise<void> {
  const paths = ledgerPaths(location, stateRoot);
  await withLock(paths, async () => {
    const at = now();
    const host = hostname();
    for (const member of outcome.dispatched) {
      append(paths, {
        kind: "dispatched",
        roundId,
        at,
        host,
        member: member.name,
        branch: member.branch,
        worktreeId: member.worktreeId,
        worktreePath: member.worktreePath,
      });
    }
    if (outcome.failed.length > 0) {
      append(paths, {
        kind: "dispatch-failed",
        roundId,
        at,
        host,
        failed: outcome.failed.map(entry => entry.name),
        message: truncate(redact(outcome.failed.map(entry => `${entry.name}: ${entry.message}`).join("; ")), 600),
      });
    }
  });
}

export type Gate = { name: string; argv: string[]; env: "inherit" | "none"; timeoutMs: number };
export type GatePolicy = { schemaVersion: number; gates: Gate[] };
export type GatePolicyResolution =
  | { ok: true; policy: GatePolicy; digest: string }
  | { ok: false; reason: string };

/** Canonical serialization: sorted object keys, no insignificant whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(entry => canonicalJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(source[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** C0 and DEL in a gate name or executable would corrupt the operator's one-screen report. */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

/**
 * Resolve the parent-owned gate policy. Missing, unparseable, schema-invalid, unsupported
 * version, and out-of-bounds values all resolve to one outcome for the caller: hold the round
 * with the reason recorded and create nothing. A child cannot define or weaken its own gates,
 * and there is no `cwd` field: every gate runs in the isolated integration worktree, because a
 * gate in the parent checkout would test the unchanged target and prove nothing.
 */
export function resolveGatePolicy(parentWorktreePath: string): GatePolicyResolution {
  const file = join(parentWorktreePath, ".orca-task-dispatch", "gates.json");
  if (!existsSync(file)) {
    return { ok: false, reason: `gate policy is missing at ${GATE_POLICY_RELATIVE_PATH}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { ok: false, reason: `gate policy is unparseable: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "gate policy is not a JSON object" };
  }
  const source: Record<string, unknown> = { ...raw };
  if (source.schemaVersion !== GATE_POLICY_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `gate policy schemaVersion must be ${GATE_POLICY_SCHEMA_VERSION}, found ${JSON.stringify(source.schemaVersion)}`,
    };
  }
  const rawGates = source.gates;
  if (!Array.isArray(rawGates) || rawGates.length === 0) {
    // An empty policy cannot establish that the combined tree is green, so it is refused rather
    // than treated as "nothing to check" and auto-merged.
    return { ok: false, reason: "gate policy must list at least one gate" };
  }

  const gates: Gate[] = [];
  const names = new Set<string>();
  for (const [index, entry] of rawGates.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, reason: `gates[${index}] is not an object` };
    }
    const gate: Record<string, unknown> = { ...entry };
    const name = typeof gate.name === "string" ? gate.name.trim() : "";
    if (!name || CONTROL_CHARACTERS.test(name) || name.length > 64) {
      return { ok: false, reason: `gates[${index}].name must be one printable line of at most 64 characters` };
    }
    if (names.has(name)) return { ok: false, reason: `gates[${index}].name duplicates ${name}` };
    names.add(name);
    const argv = gate.argv;
    if (!Array.isArray(argv) || argv.length === 0 || argv.some(arg => typeof arg !== "string")) {
      return { ok: false, reason: `gates[${index}].argv must be a non-empty array of strings` };
    }
    const executable = String(argv[0] ?? "").trim();
    if (!executable || CONTROL_CHARACTERS.test(executable)) {
      return { ok: false, reason: `gates[${index}].argv[0] must be an executable, never a shell string` };
    }
    if (gate.env !== "inherit" && gate.env !== "none") {
      return { ok: false, reason: `gates[${index}].env must be "inherit" or "none"` };
    }
    const timeoutMs = gate.timeoutMs;
    if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < MIN_GATE_TIMEOUT_MS || timeoutMs > MAX_GATE_TIMEOUT_MS) {
      return {
        ok: false,
        reason: `gates[${index}].timeoutMs must be an integer between ${MIN_GATE_TIMEOUT_MS} and ${MAX_GATE_TIMEOUT_MS}`,
      };
    }
    if (Object.keys(gate).some(key => key !== "name" && key !== "argv" && key !== "env" && key !== "timeoutMs")) {
      return { ok: false, reason: `gates[${index}] carries an unknown field; a gate is name, argv, env, and timeoutMs` };
    }
    gates.push({
      name,
      argv: argv.filter((arg): arg is string => typeof arg === "string"),
      env: gate.env,
      timeoutMs,
    });
  }

  const policy: GatePolicy = { schemaVersion: GATE_POLICY_SCHEMA_VERSION, gates };
  return { ok: true, policy, digest: createHash("sha256").update(canonicalJson(policy)).digest("hex") };
}

export type GateOutcome = { name: string; ok: boolean; code: number; timedOut: boolean; output: string };

/**
 * `env: "none"` drops every inherited variable except the minimum needed to locate and start an
 * executable, so a gate cannot silently depend on the operator's shell. The host `exec` contract
 * carries no env option, so gates use `execFile` directly: argv only, never a shell string.
 */
function gateEnv(mode: "inherit" | "none"): NodeJS.ProcessEnv {
  if (mode === "inherit") return { ...process.env };
  const minimal: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "" };
  if (process.platform === "win32") {
    for (const key of ["SystemRoot", "windir", "COMSPEC", "ComSpec", "PATHEXT"]) {
      const value = process.env[key];
      if (value) minimal[key] = value;
    }
  }
  return minimal;
}

function runGate(gate: Gate, cwd: string, signal?: AbortSignal): Promise<GateOutcome> {
  const [command, ...args] = gate.argv;
  const finished = Promise.withResolvers<GateOutcome>();
  execFile(
    command ?? "",
    args,
    {
      cwd,
      env: gateEnv(gate.env),
      timeout: gate.timeoutMs,
      maxBuffer: GATE_OUTPUT_BUFFER,
      windowsHide: true,
      ...(signal ? { signal } : {}),
    },
    (error, stdout, stderr) => {
      const merged = [stderr, stdout].filter(Boolean).join("\n").trim();
      const output = truncate(redact(merged), MAX_GATE_OUTPUT_CHARS);
      if (!error) {
        finished.resolve({ name: gate.name, ok: true, code: 0, timedOut: false, output });
        return;
      }
      const detail = error as Error & { code?: unknown; killed?: boolean };
      // A gate that exceeds its timeout is a gate failure, not an inconclusive run.
      const timedOut = detail.killed === true || detail.name === "AbortError";
      finished.resolve({
        name: gate.name,
        ok: false,
        code: typeof detail.code === "number" ? detail.code : 1,
        timedOut,
        output: output || truncate(redact(detail.message), MAX_GATE_OUTPUT_CHARS),
      });
    },
  );
  return finished.promise;
}

type GitRun = { code: number; out: string; err: string };

async function runGit(runtime: BackendRuntime, cwd: string, args: string[], timeout = PROBE_TIMEOUT_MS): Promise<GitRun> {
  const execution = await runtime.pi.exec(GIT, args, {
    cwd,
    ...(runtime.signal ? { signal: runtime.signal } : {}),
    timeout,
  });
  return { code: execution.code, out: execution.stdout, err: execution.stderr };
}

function gitDetail(run: GitRun): string {
  return truncate(redact([run.err, run.out].filter(Boolean).join("\n").trim()), 600);
}

function short(sha: string): string {
  return sha.slice(0, 10);
}

/** The parent checkout root of the invoking directory. Both backends run inside a git worktree. */
export async function resolveParentWorktreePath(runtime: BackendRuntime): Promise<string> {
  const root = normalizeIdentity(await execText(runtime, GIT, ["rev-parse", "--show-toplevel"]));
  if (!root) throw new Error("git did not report a worktree root for the invoking directory");
  return root;
}

async function resolveTargetBranch(runtime: BackendRuntime, parentWorktreePath: string): Promise<string | null> {
  const run = await runGit(runtime, parentWorktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = run.out.trim();
  return run.code === 0 && branch && branch !== "HEAD" ? branch : null;
}

async function resolveCommit(runtime: BackendRuntime, cwd: string, revision: string): Promise<string | null> {
  const run = await runGit(runtime, cwd, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`]);
  const sha = run.out.trim();
  return run.code === 0 && sha ? sha : null;
}

/**
 * The parent resolves each child's head itself, from the branch it recorded at dispatch and, if
 * that branch is gone, from the child worktree's own HEAD. A child is never asked to report it.
 */
async function resolveMemberSha(
  runtime: BackendRuntime,
  parentWorktreePath: string,
  member: DispatchedMember,
): Promise<string | null> {
  if (member.branch) {
    const fromBranch = await resolveCommit(runtime, parentWorktreePath, member.branch);
    if (fromBranch) return fromBranch;
  }
  if (member.worktreePath && existsSync(member.worktreePath)) {
    return resolveCommit(runtime, member.worktreePath, "HEAD");
  }
  return null;
}

async function changedPaths(
  runtime: BackendRuntime,
  cwd: string,
  base: string,
  sha: string,
): Promise<string[] | null> {
  // `-z` avoids git's path quoting, which would mangle non-ASCII scopes on comparison.
  const run = await runGit(runtime, cwd, ["--literal-pathspecs", "diff", "--name-only", "-z", base, sha]);
  if (run.code !== 0) return null;
  return run.out
    .split("\0")
    .map(path => path.trim())
    .filter(Boolean)
    .map(path => path.replaceAll("\\", "/"));
}

/**
 * Scope containment is case-sensitive after NFC normalization. Folding case would let an edit to
 * a path that differs only by case read as in-scope on Linux, where it is a different file; the
 * strict comparison can only hold a round, never let an out-of-scope edit land.
 */
function outsideScope(paths: string[], scope: string[]): string[] {
  const owned = scope.map(entry => entry.normalize("NFC").replace(/\/$/, ""));
  return paths.filter(path => {
    const candidate = path.normalize("NFC");
    return !owned.some(entry => candidate === entry || candidate.startsWith(`${entry}/`));
  });
}

export type CollectMember = {
  name: string;
  scope: string[];
  dispatched: boolean;
  branch: string | null;
  worktreePath: string | null;
  sha: string | null;
  movedOffBase: boolean;
  commits: number;
  changedPaths: string[];
  outsideScope: string[];
  overlaps: string[];
  outstanding: boolean;
};

export type CollectRound = {
  roundId: string;
  at: string;
  baseHead: string;
  supersedes: string | null;
  outcome: "merged" | "held" | null;
  reason: string | null;
  missingDispatch: string[];
  members: CollectMember[];
  outstanding: string[];
  integratable: boolean;
};

export type CollectResult = {
  status: "collected";
  ledgerKey: string;
  parentWorktree: string;
  target: string | null;
  targetSha: string | null;
  rounds: CollectRound[];
  screen: string;
};

export type CollectOptions = {
  runtime: BackendRuntime;
  location: LedgerLocation;
  roundId?: string | undefined;
  stateRoot?: string | undefined;
};

/**
 * Pure inspection. Reads the ledger and git, reports one screen, and appends nothing. It never
 * resolves the gate policy and never runs a gate, so no command has to write a record before
 * `integrate` may run and a fresh round can never deadlock. "Has this child committed yet" is
 * derived from git here, never stored.
 */
export async function collectRounds(options: CollectOptions): Promise<CollectResult> {
  const { runtime, location } = options;
  const paths = ledgerPaths(location, options.stateRoot ?? defaultStateRoot());
  const parentWorktreePath = await resolveParentWorktreePath(runtime);
  const target = await resolveTargetBranch(runtime, parentWorktreePath);
  const targetSha = target ? await resolveCommit(runtime, parentWorktreePath, target) : null;

  const replayed = [...replayLedger(paths.log).values()].sort((left, right) => right.at.localeCompare(left.at));
  const selected = options.roundId ? replayed.filter(round => round.roundId === options.roundId) : replayed;

  const rounds: CollectRound[] = [];
  for (const round of selected) {
    const dispatched = new Map(round.dispatched.map(entry => [entry.name, entry]));
    const observed = new Map<string, string[]>();
    const members: CollectMember[] = [];

    for (const member of round.members) {
      const child = dispatched.get(member.name);
      const sha = child ? await resolveMemberSha(runtime, parentWorktreePath, child) : null;
      const movedOffBase = sha !== null && sha !== round.baseHead;
      let commits = 0;
      let paths: string[] = [];
      if (sha && movedOffBase) {
        const count = await runGit(runtime, parentWorktreePath, ["rev-list", "--count", `${round.baseHead}..${sha}`]);
        commits = count.code === 0 ? Number.parseInt(count.out.trim(), 10) || 0 : 0;
        paths = (await changedPaths(runtime, parentWorktreePath, round.baseHead, sha)) ?? [];
      }
      observed.set(member.name, paths);
      members.push({
        name: member.name,
        scope: member.scope,
        dispatched: child !== undefined,
        branch: child?.branch ?? null,
        worktreePath: child?.worktreePath ?? null,
        sha,
        movedOffBase,
        commits,
        changedPaths: paths,
        outsideScope: outsideScope(paths, member.scope),
        overlaps: [],
        // An already-committed child is never outstanding: this is the round-one regression.
        outstanding: !movedOffBase,
      });
    }

    for (const member of members) {
      const mine = new Set(observed.get(member.name) ?? []);
      const shared = new Set<string>();
      for (const [name, paths] of observed) {
        if (name === member.name) continue;
        for (const path of paths) if (mine.has(path)) shared.add(path);
      }
      member.overlaps = [...shared].sort();
    }

    const missingDispatch = round.members.filter(member => !dispatched.has(member.name)).map(member => member.name);
    rounds.push({
      roundId: round.roundId,
      at: round.at,
      baseHead: round.baseHead,
      supersedes: round.supersedes ?? null,
      outcome: round.outcome ?? null,
      reason: round.reason ?? null,
      missingDispatch,
      members,
      outstanding: members.filter(member => member.outstanding).map(member => member.name),
      // Reported, never enforced: `integrate` re-derives every one of these from a fresh snapshot.
      integratable:
        round.outcome === undefined &&
        missingDispatch.length === 0 &&
        members.every(member => member.movedOffBase && member.outsideScope.length === 0),
    });
  }

  return {
    status: "collected",
    ledgerKey: paths.key,
    parentWorktree: parentWorktreePath,
    target,
    targetSha,
    rounds,
    screen: formatCollectScreen(parentWorktreePath, target, targetSha, rounds, options.roundId),
  };
}

function formatCollectScreen(
  parentWorktreePath: string,
  target: string | null,
  targetSha: string | null,
  rounds: CollectRound[],
  roundId?: string,
): string {
  const lines = [
    `parent ${parentWorktreePath}  target ${target ?? "(detached)"}${targetSha ? ` @ ${short(targetSha)}` : ""}`,
  ];
  if (rounds.length === 0) {
    lines.push(roundId ? `no round ${roundId} in this parent's ledger` : "no dispatch rounds recorded for this parent");
    return lines.join("\n");
  }
  for (const round of rounds) {
    const state = round.outcome ? round.outcome.toUpperCase() : round.integratable ? "READY" : "OPEN";
    lines.push("", `${round.roundId}  ${state}  base ${short(round.baseHead)}  ${round.at}`);
    if (round.supersedes) lines.push(`  supersedes ${round.supersedes}`);
    if (round.reason) lines.push(`  reason: ${round.reason}`);
    if (round.missingDispatch.length > 0) lines.push(`  never dispatched: ${round.missingDispatch.join(", ")}`);
    for (const member of round.members) {
      const head = member.sha ? short(member.sha) : "unresolved";
      const status = member.dispatched
        ? member.movedOffBase
          ? `${member.commits} commit(s), ${member.changedPaths.length} path(s)`
          : "no commits yet"
        : "no dispatched record";
      lines.push(`  ${member.name.padEnd(16)} ${head.padEnd(11)} ${status}`);
      if (member.outsideScope.length > 0) {
        lines.push(`    outside scope: ${member.outsideScope.slice(0, 8).join(", ")}`);
      }
      if (member.overlaps.length > 0) lines.push(`    also touched by a sibling: ${member.overlaps.slice(0, 8).join(", ")}`);
    }
    lines.push(
      round.outstanding.length > 0
        ? `  outstanding: ${round.outstanding.join(", ")}`
        : `  all members have committed${round.integratable ? "; integrate is unblocked" : ""}`,
    );
  }
  lines.push("", "collect appends nothing, resolves no gate policy, and runs no gate.");
  return lines.join("\n");
}

export type IntegrateResult = {
  status: "merged" | "held" | "failed";
  roundId: string;
  reason: string | null;
  target: string | null;
  targetShaBefore: string | null;
  targetShaAfter: string | null;
  candidateSha: string | null;
  policyDigest: string | null;
  members: ObservedMember[];
  gates: GateOutcome[];
  integrationWorktree: string | null;
  retainedIntegrationWorktree: boolean;
  recovered: boolean;
  idempotent: boolean;
  screen: string;
};

export type IntegrateOptions = {
  runtime: BackendRuntime;
  location: LedgerLocation;
  roundId: string;
  stateRoot?: string | undefined;
};

type IntegrateDraft = Omit<IntegrateResult, "screen">;

function draft(roundId: string): IntegrateDraft {
  return {
    status: "held",
    roundId,
    reason: null,
    target: null,
    targetShaBefore: null,
    targetShaAfter: null,
    candidateSha: null,
    policyDigest: null,
    members: [],
    gates: [],
    integrationWorktree: null,
    retainedIntegrationWorktree: false,
    recovered: false,
    idempotent: false,
  };
}

function finish(state: IntegrateDraft): IntegrateResult {
  return { ...state, screen: formatIntegrateScreen(state) };
}

function formatIntegrateScreen(state: IntegrateDraft): string {
  const lines = [`${state.roundId}  ${state.status.toUpperCase()}${state.idempotent ? " (already merged)" : ""}${state.recovered ? " (recovered by ancestry)" : ""}`];
  if (state.target) {
    lines.push(
      `target ${state.target}  ${state.targetShaBefore ? short(state.targetShaBefore) : "?"} -> ${state.targetShaAfter ? short(state.targetShaAfter) : "unchanged"}`,
    );
  }
  if (state.candidateSha) lines.push(`candidate ${short(state.candidateSha)}`);
  if (state.policyDigest) lines.push(`gate policy ${short(state.policyDigest)} (${GATE_POLICY_RELATIVE_PATH})`);
  for (const member of state.members) lines.push(`  ${member.name.padEnd(16)} ${short(member.sha)}`);
  for (const gate of state.gates) {
    lines.push(`  gate ${gate.name.padEnd(16)} ${gate.ok ? "pass" : gate.timedOut ? "TIMEOUT" : `FAIL (exit ${gate.code})`}`);
    if (!gate.ok && gate.output) lines.push(...gate.output.split("\n").slice(0, 12).map(line => `    ${line}`));
  }
  if (state.reason) lines.push(`reason: ${state.reason}`);
  if (state.integrationWorktree) {
    lines.push(
      state.retainedIntegrationWorktree
        ? `integration worktree retained for inspection: ${state.integrationWorktree}`
        : `integration worktree removed: ${state.integrationWorktree}`,
    );
  }
  if (state.status === "held") lines.push("a held round is terminal; recover with a new round that supersedes it");
  return lines.join("\n");
}

/**
 * Guarded, serialized fast-forward of the target, step 7 of the design. Never `update-ref`,
 * which would leave a checked-out worktree out of sync with its index. Exported because the
 * descendant and compare-and-set guards are the contract this layer rests on.
 */
export async function guardedFastForward(input: {
  runtime: BackendRuntime;
  parentWorktreePath: string;
  target: string;
  expectedSha: string;
  candidateSha: string;
}): Promise<{ ok: true; targetSha: string } | { ok: false; reason: string }> {
  const { runtime, parentWorktreePath, target, expectedSha, candidateSha } = input;
  const status = await runGit(runtime, parentWorktreePath, ["--literal-pathspecs", "status", "--porcelain"]);
  if (status.code !== 0) return { ok: false, reason: `git status failed in the parent worktree: ${gitDetail(status)}` };
  if (status.out.trim()) {
    const dirty = status.out.split("\n").map(line => line.trimEnd()).filter(Boolean);
    return { ok: false, reason: `parent worktree is dirty (${dirty.length} path(s), first: ${dirty[0]}); target left untouched` };
  }
  const current = await resolveCommit(runtime, parentWorktreePath, target);
  if (!current) return { ok: false, reason: `target ${target} does not resolve to a commit` };
  if (current !== expectedSha) {
    return { ok: false, reason: `target ${target} moved from ${short(expectedSha)} to ${short(current)} during integration` };
  }
  const ancestry = await runGit(runtime, parentWorktreePath, ["merge-base", "--is-ancestor", expectedSha, candidateSha]);
  if (ancestry.code !== 0) {
    return { ok: false, reason: `candidate ${short(candidateSha)} is not a descendant of target ${short(expectedSha)}` };
  }
  const merge = await runGit(runtime, parentWorktreePath, ["merge", "--ff-only", candidateSha], CREATE_TIMEOUT_MS);
  if (merge.code !== 0) return { ok: false, reason: `git merge --ff-only refused: ${gitDetail(merge)}` };
  const updated = await resolveCommit(runtime, parentWorktreePath, target);
  if (updated !== candidateSha) {
    return { ok: false, reason: `target ${target} is ${updated ? short(updated) : "unresolvable"} after the fast-forward` };
  }
  return { ok: true, targetSha: candidateSha };
}

/**
 * `integrate <roundId>` in the exact order of design step 6. It takes a round id, never a
 * caller-assembled child list, and trusts no earlier record: every SHA it merges comes from its
 * own snapshot. Any failure records `held` with the reason and leaves the target untouched.
 */
export async function integrateRound(options: IntegrateOptions): Promise<IntegrateResult> {
  const { runtime, location, roundId } = options;
  const paths = ledgerPaths(location, options.stateRoot ?? defaultStateRoot());
  const state = draft(roundId);
  const round = replayLedger(paths.log).get(roundId);
  if (!round) {
    // Nothing to hold: an unknown round has no membership to pin, and this parent's ledger is
    // the only ledger that could describe it.
    return finish({ ...state, status: "failed", reason: `unknown round ${roundId} in this parent's ledger` });
  }

  const parentWorktreePath = await resolveParentWorktreePath(runtime);
  const hold = async (reason: string, patch: Partial<IntegrateDraft> = {}): Promise<IntegrateResult> => {
    await withLock(paths, async () => {
      append(paths, { kind: "held", roundId, at: now(), host: hostname(), reason });
    });
    return finish({ ...state, ...patch, status: "held", reason });
  };

  if (round.outcome === "merged") {
    const target = await resolveTargetBranch(runtime, parentWorktreePath);
    return finish({
      ...state,
      status: "merged",
      idempotent: true,
      target,
      targetShaAfter: round.finalTargetSha ?? null,
      candidateSha: round.attempt?.candidateSha ?? null,
      policyDigest: round.attempt?.policyDigest ?? null,
      members: round.attempt?.observed ?? [],
      reason: "round already merged; nothing to do",
    });
  }
  if (round.outcome === "held") {
    return finish({
      ...state,
      status: "held",
      reason: round.reason ?? "round is held",
      candidateSha: round.attempt?.candidateSha ?? null,
      members: round.attempt?.observed ?? [],
    });
  }

  // Step 8: an attempt with no outcome is decided by ancestry, because 6g persisted the
  // candidate before any target move. The merge may have landed with only the append lost.
  if (round.attempt) {
    const attempt = round.attempt;
    const targetSha = await resolveCommit(runtime, parentWorktreePath, attempt.target);
    if (!targetSha) {
      return hold(`recovery: target ${attempt.target} does not resolve to a commit`, {
        target: attempt.target,
        candidateSha: attempt.candidateSha,
        members: attempt.observed,
        recovered: true,
      });
    }
    const contains = await runGit(runtime, parentWorktreePath, [
      "merge-base",
      "--is-ancestor",
      attempt.candidateSha,
      targetSha,
    ]);
    if (contains.code === 0) {
      await withLock(paths, async () => {
        append(paths, {
          kind: "merged",
          roundId,
          at: now(),
          host: hostname(),
          target: attempt.target,
          targetSha,
        });
      });
      return finish({
        ...state,
        status: "merged",
        recovered: true,
        target: attempt.target,
        targetShaBefore: attempt.targetSha,
        targetShaAfter: targetSha,
        candidateSha: attempt.candidateSha,
        policyDigest: attempt.policyDigest,
        members: attempt.observed,
        reason: `recovered: target ${attempt.target} already contains candidate ${short(attempt.candidateSha)}`,
      });
    }
    return hold(
      `recovery: target ${attempt.target} does not contain candidate ${short(attempt.candidateSha)}; nothing landed`,
      {
        target: attempt.target,
        targetShaBefore: attempt.targetSha,
        candidateSha: attempt.candidateSha,
        policyDigest: attempt.policyDigest,
        members: attempt.observed,
        recovered: true,
      },
    );
  }

  // 6a. Every requested member needs a `dispatched` record, so an incomplete set can never be
  // mistaken for the round.
  const dispatched = new Map(round.dispatched.map(entry => [entry.name, entry]));
  const missing = round.members.filter(member => !dispatched.has(member.name)).map(member => member.name);
  if (missing.length > 0) {
    return hold(`round is incomplete: no dispatched record for ${missing.join(", ")}`);
  }

  // 6b. One snapshot pass over the target and every member.
  const target = await resolveTargetBranch(runtime, parentWorktreePath);
  if (!target) return hold("parent worktree is not on a branch, so there is no target to advance");
  const targetSha = await resolveCommit(runtime, parentWorktreePath, target);
  if (!targetSha) return hold(`target ${target} does not resolve to a commit`, { target });
  state.target = target;
  state.targetShaBefore = targetSha;

  const snapshot: ObservedMember[] = [];
  for (const member of round.members) {
    const child = dispatched.get(member.name);
    if (!child) return hold(`round is incomplete: no dispatched record for ${member.name}`, { target });
    const sha = await resolveMemberSha(runtime, parentWorktreePath, child);
    if (!sha) {
      return hold(`member ${member.name} is unresolvable: branch ${child.branch} has no commit`, { target });
    }
    if (sha === round.baseHead) {
      return hold(`member ${member.name} is still at baseHead ${short(round.baseHead)}, so it has not committed`, {
        target,
      });
    }
    snapshot.push({ name: member.name, sha });
  }
  state.members = snapshot;

  // 6c. Parent-owned policy resolves before anything is written or created.
  const policy = resolveGatePolicy(parentWorktreePath);
  if (!policy.ok) return hold(policy.reason, { target });
  state.policyDigest = policy.digest;

  // 6d. Scope enforcement, pre-merge. `collect` only reports; this is where a violation is caught.
  for (const member of round.members) {
    const observed = snapshot.find(entry => entry.name === member.name);
    if (!observed) return hold(`member ${member.name} vanished from the snapshot`, { target });
    const paths = await changedPaths(runtime, parentWorktreePath, round.baseHead, observed.sha);
    if (paths === null) {
      return hold(`cannot diff ${short(round.baseHead)}..${short(observed.sha)} for member ${member.name}`, { target });
    }
    const violations = outsideScope(paths, member.scope);
    if (violations.length > 0) {
      return hold(
        `member ${member.name} changed ${violations.length} path(s) outside its owned scope: ${violations.slice(0, 8).join(", ")}`,
        { target },
      );
    }
  }

  // 6e. Fresh isolated integration worktree at the snapshotted target, never at baseHead, so a
  // target that legitimately advanced since dispatch can still be advanced.
  const integrationPath = join(tmpdir(), `orca-integrate-${roundId}-${Math.random().toString(36).slice(2, 8)}`);
  const created = await runGit(
    runtime,
    parentWorktreePath,
    ["worktree", "add", "--detach", integrationPath, targetSha],
    CREATE_TIMEOUT_MS,
  );
  if (created.code !== 0) {
    return hold(`cannot create the integration worktree: ${gitDetail(created)}`, { target });
  }
  state.integrationWorktree = integrationPath;

  const removeIntegrationWorktree = async (): Promise<void> => {
    await runGit(runtime, parentWorktreePath, ["worktree", "remove", "--force", integrationPath], CREATE_TIMEOUT_MS);
  };

  for (const member of snapshot) {
    const merge = await runGit(
      runtime,
      integrationPath,
      ["merge", "--no-edit", "-m", `orca-task-dispatch ${roundId}: ${member.name}`, member.sha],
      CREATE_TIMEOUT_MS,
    );
    if (merge.code !== 0) {
      await runGit(runtime, integrationPath, ["merge", "--abort"]);
      // Retained deliberately: the operator needs the conflicting tree, and every run builds a
      // fresh worktree, so nothing is ever reused.
      return hold(`conflict merging member ${member.name} (${short(member.sha)}): ${gitDetail(merge)}`, {
        target,
        retainedIntegrationWorktree: true,
      });
    }
  }

  // 6f. Exactly one gate run, on the combined tree, in that worktree.
  const gates: GateOutcome[] = [];
  for (const gate of policy.policy.gates) {
    const outcome = await runGate(gate, integrationPath, runtime.signal);
    gates.push(outcome);
    if (!outcome.ok) {
      state.gates = gates;
      return hold(
        `gate ${gate.name} ${outcome.timedOut ? `exceeded ${gate.timeoutMs}ms` : `failed with exit ${outcome.code}`} on the combined tree`,
        { target, gates, retainedIntegrationWorktree: true },
      );
    }
  }
  state.gates = gates;

  const candidateSha = await resolveCommit(runtime, integrationPath, "HEAD");
  if (!candidateSha) {
    return hold("integration worktree has no resolvable HEAD after merging the round", {
      target,
      gates,
      retainedIntegrationWorktree: true,
    });
  }
  state.candidateSha = candidateSha;

  // 6g and 7 share one lock section: `attempt` is durable before the target is touched, and the
  // compare-and-set plus fast-forward are serialized against another integration.
  const advanced = await withLock(paths, async () => {
    append(paths, {
      kind: "attempt",
      roundId,
      at: now(),
      host: hostname(),
      policyDigest: policy.digest,
      target,
      targetSha,
      candidateSha,
      observed: snapshot,
    });
    const update = await guardedFastForward({ runtime, parentWorktreePath, target, expectedSha: targetSha, candidateSha });
    if (!update.ok) {
      append(paths, { kind: "held", roundId, at: now(), host: hostname(), reason: update.reason });
      return update;
    }
    append(paths, { kind: "merged", roundId, at: now(), host: hostname(), target, targetSha: update.targetSha });
    return update;
  });

  if (!advanced.ok) {
    return finish({ ...state, status: "held", reason: advanced.reason, retainedIntegrationWorktree: true });
  }
  await removeIntegrationWorktree();
  return finish({ ...state, status: "merged", targetShaAfter: advanced.targetSha, reason: null });
}
