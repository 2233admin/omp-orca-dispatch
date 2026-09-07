import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { HostApi, ToolMetadata, ToolResult } from "./contracts.js";

/**
 * Local work backlog and tracker outbox. See docs/offline-backlog-contract.md.
 *
 * Three properties are enforced here rather than left to callers:
 *
 * 1. No tracker credential and no tracker invocation. `planSync` emits an executable plan; the
 *    host runs it and reports back via `ack`.
 * 2. The claim guarantee is host-local. The log is unshared, so it prevents two processes on one
 *    host from claiming an item, never two hosts from claiming the same item.
 * 3. `sourceRef` stays an opaque traceability label, exactly as the dispatch tool treats it. A
 *    tracker write requires a separate, explicitly typed `syncTarget`.
 */

/**
 * Package-neutral state root: this package serves both Pi and OMP, so it must not write into
 * either host's private directory. A host entrypoint may override it.
 */
const DEFAULT_STATE_ROOT = join(homedir(), ".orca-task-dispatch", "backlog");
const LOCK_RETRIES = 50;
const LOCK_RETRY_MS = 20;
/** A lock file older than this is treated as abandoned by a crashed process. */
const LOCK_STALE_MS = 60_000;

export type ItemState = "queued" | "claimed" | "completed" | "synced" | "pending-triage";

/** The only tracker this package knows how to build argv for. */
export type SyncTarget = { kind: "multica"; issueRef: string };

type LogRecord = {
  id: string;
  at: string;
  host: string;
  kind: "enqueue" | "claim" | "complete" | "bind" | "ack";
  // `| undefined` under exactOptionalPropertyTypes: these are built by spreading parsed input,
  // so the absent case must be representable, not merely omittable.
  title?: string | undefined;
  sourceRef?: string | undefined;
  syncTarget?: SyncTarget | undefined;
  scope?: string[] | undefined;
  evidence?: string | undefined;
  issueRef?: string | undefined;
  commentId?: string | undefined;
};

export type Item = {
  id: string;
  state: ItemState;
  title: string;
  host: string;
  // `| undefined` is required under exactOptionalPropertyTypes: replay spreads these fields
  // through, so the absent case must be representable rather than merely omittable.
  sourceRef?: string | undefined;
  syncTarget?: SyncTarget | undefined;
  scope?: string[] | undefined;
  evidence?: string | undefined;
  issueRef?: string | undefined;
  commentId?: string | undefined;
};

export type SyncRecord = {
  id: string;
  issueRef: string;
  bodyFile: string;
  command: string;
  args: string[];
};

export type BacklogAction = "enqueue" | "claim" | "complete" | "bind" | "ack" | "list";

export type BacklogParams = {
  action: BacklogAction;
  // `| undefined` under exactOptionalPropertyTypes: parseBacklogParams builds this object with
  // every field present, so the absent case must be representable rather than merely omittable.
  id?: string | undefined;
  title?: string | undefined;
  sourceRef?: string | undefined;
  syncTarget?: SyncTarget | undefined;
  scope?: string[] | undefined;
  evidence?: string | undefined;
  issueRef?: string | undefined;
  commentId?: string | undefined;
  state?: ItemState | undefined;
};

const ACTIONS: Record<string, true> = { enqueue: true, claim: true, complete: true, bind: true, ack: true, list: true };
const STATES: Record<string, true> = {
  queued: true,
  claimed: true,
  completed: true,
  synced: true,
  "pending-triage": true,
};

function optionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function optionalSyncTarget(source: Record<string, unknown>): SyncTarget | undefined {
  const value = source.syncTarget;
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("syncTarget must be an object");
  }
  if (!("kind" in value) || value.kind !== "multica") {
    throw new Error('syncTarget.kind must be "multica"; no other tracker argv is implemented');
  }
  const issueRef = "issueRef" in value && typeof value.issueRef === "string" ? value.issueRef.trim() : "";
  if (!issueRef) throw new Error("syncTarget.issueRef is required");
  return { kind: "multica", issueRef };
}

/** Validate the host-supplied parameter object instead of asserting its shape. */
export function parseBacklogParams(raw: unknown): BacklogParams {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("parameters must be an object");
  const source: Record<string, unknown> = { ...raw };

  const action = source.action;
  if (typeof action !== "string" || !ACTIONS[action]) {
    throw new Error("action must be one of enqueue, claim, complete, bind, ack, list");
  }

  let scope: string[] | undefined;
  if (source.scope !== undefined) {
    if (!Array.isArray(source.scope) || source.scope.some(entry => typeof entry !== "string")) {
      throw new Error("scope must be an array of strings");
    }
    scope = source.scope.filter((entry): entry is string => typeof entry === "string");
  }

  let state: ItemState | undefined;
  if (source.state !== undefined) {
    if (typeof source.state !== "string" || !STATES[source.state]) throw new Error("state is not a known item state");
    // Narrowed by the STATES table above.
    state = source.state as ItemState;
  }

  return {
    action: action as BacklogAction,
    id: optionalString(source, "id"),
    title: optionalString(source, "title"),
    sourceRef: optionalString(source, "sourceRef"),
    syncTarget: optionalSyncTarget(source),
    scope,
    evidence: optionalString(source, "evidence"),
    issueRef: optionalString(source, "issueRef"),
    commentId: optionalString(source, "commentId"),
    state,
  };
}

/**
 * Walk up to the repository root so every subdirectory of one checkout shares a log. Keying on
 * the raw cwd would give each subdirectory its own log, which would silently defeat the claim
 * guarantee: two processes in sibling directories of the same repo would never see each other.
 */
export function repositoryKey(cwd: string): string {
  let current = resolve(cwd);
  for (;;) {
    // A worktree has `.git` as a file, a normal clone as a directory; both mark the root.
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) {
      // Refused rather than silently keyed on the cwd: falling back would give each directory
      // its own log and quietly downgrade the repository-scoped claim guarantee.
      throw new Error(`Backlog requires a git repository; none found at or above ${resolve(cwd)}`);
    }
    current = parent;
  }
}

function stateFile(cwd: string, stateRoot: string): string {
  // Derived, never caller-supplied: no tool parameter may redirect the log.
  const key = repositoryKey(cwd).toLowerCase();
  let hash = 0;
  for (const char of key) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0;
  return join(stateRoot, `${(hash >>> 0).toString(36)}.jsonl`);
}

/**
 * Exclusive lock via atomic create. POSIX advisory locks are unavailable on Windows, so an
 * exclusive open is the one primitive both platforms honour. A lock left behind by a crashed
 * process is reclaimed once it exceeds LOCK_STALE_MS, otherwise a crash would wedge the backlog
 * permanently.
 */
function withLock<T>(log: string, stateRoot: string, run: () => T): T {
  const lock = `${log}.lock`;
  mkdirSync(stateRoot, { recursive: true });

  for (let attempt = 0; ; attempt++) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch (error) {
      // `in` narrowing rather than an inline cast: an unchecked shape would silently swallow a
      // genuine filesystem failure as lock contention.
      const isBusy = error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST";
      if (!isBusy) throw error;

      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lock);
          continue;
        }
      } catch {
        // The holder released it between our open and stat; retry immediately.
        continue;
      }

      if (attempt >= LOCK_RETRIES) throw new Error(`Backlog lock is held: ${lock}`);
      const until = Date.now() + LOCK_RETRY_MS;
      while (Date.now() < until) {
        // The tool surface is synchronous; spin briefly rather than change that contract.
      }
    }
  }

  try {
    return run();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // A missing lock must not mask the operation's own outcome.
    }
  }
}

type ParseOutcome = { ok: true; record: LogRecord } | { ok: false; reason: "json-torn" | "schema-invalid" };

/**
 * A truncated JSON line is a crash mid-append and may be tolerated at the end of the log.
 * A line that parses but violates the schema is corruption anywhere it appears, including the
 * last line: silently dropping it could hide a complete or ack and cause a duplicate write.
 */
function parseLogRecord(line: string): ParseOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, reason: "json-torn" };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "schema-invalid" };
  // Per-kind required fields are checked below; a record that parses as JSON but violates the
  // schema is corruption, not a torn write, and must not be silently dropped.
  const source: Record<string, unknown> = { ...raw };
  const { id, at, host, kind } = source;
  if (typeof id !== "string" || typeof at !== "string" || typeof host !== "string") return { ok: false, reason: "schema-invalid" };
  if (kind !== "enqueue" && kind !== "claim" && kind !== "complete" && kind !== "bind" && kind !== "ack") {
    return { ok: false, reason: "schema-invalid" };
  }

  let syncTarget: SyncTarget | undefined;
  try {
    syncTarget = optionalSyncTarget(source);
  } catch {
    return { ok: false, reason: "schema-invalid" };
  }

  if (kind === "enqueue" && typeof source.title !== "string") return { ok: false, reason: "schema-invalid" };
  if (kind === "complete" && (typeof source.evidence !== "string" || source.evidence.trim() === "")) return { ok: false, reason: "schema-invalid" };
  if (kind === "bind" && !syncTarget) return { ok: false, reason: "schema-invalid" };
  if (kind === "ack") {
    const ackIssue = source.issueRef;
    const ackComment = source.commentId;
    if (typeof ackIssue !== "string" || typeof ackComment !== "string") return { ok: false, reason: "schema-invalid" };
    if (!ackIssue.trim() || !ackComment.trim()) return { ok: false, reason: "schema-invalid" };
  }

  return {
    ok: true,
    record: {
    id,
    at,
    host,
    kind,
    title: typeof source.title === "string" ? source.title : undefined,
    sourceRef: typeof source.sourceRef === "string" ? source.sourceRef : undefined,
    syncTarget,
    scope: Array.isArray(source.scope) ? source.scope.filter((e): e is string => typeof e === "string") : undefined,
    evidence: typeof source.evidence === "string" ? source.evidence : undefined,
    issueRef: typeof source.issueRef === "string" ? source.issueRef : undefined,
    commentId: typeof source.commentId === "string" ? source.commentId : undefined,
    },
  };
}

/** Replay the log; an item's state is its last record. A torn or invalid line is skipped. */
export function replay(log: string): Map<string, Item> {
  const items = new Map<string, Item>();
  if (!existsSync(log)) return items;

  const lines = readFileSync(log, "utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    const outcome = parseLogRecord(line);
    if (!outcome.ok) {
      // Only a torn JSON tail is tolerated. A schema-invalid record is corruption wherever it
      // appears, because dropping it could hide a completed or acked item and cause a
      // duplicate tracker write.
      const isTrailing = lines.slice(index + 1).every(rest => rest.trim() === "");
      if (outcome.reason === "json-torn" && isTrailing) break;
      throw new Error(`Backlog log is corrupt at line ${index + 1} (${outcome.reason}): ${log}`);
    }
    const record = outcome.record;

    if (record.kind === "enqueue") {
      items.set(record.id, {
        id: record.id,
        state: "queued",
        title: record.title ?? "",
        host: record.host,
        sourceRef: record.sourceRef,
        syncTarget: record.syncTarget,
        scope: record.scope,
      });
      continue;
    }

    const current = items.get(record.id);
    if (!current) continue;
    if (record.kind === "claim") {
      items.set(record.id, { ...current, state: "claimed", host: record.host });
    } else if (record.kind === "bind") {
      // A bound item regains a concrete target and becomes an outbox candidate again.
      items.set(record.id, { ...current, state: "completed", syncTarget: record.syncTarget });
    } else if (record.kind === "complete") {
      // Only an item with a concrete tracker target can be synced; the rest await triage.
      items.set(record.id, {
        ...current,
        state: current.syncTarget ? "completed" : "pending-triage",
        evidence: record.evidence,
      });
    } else {
      items.set(record.id, { ...current, state: "synced", issueRef: record.issueRef, commentId: record.commentId });
    }
  }

  return items;
}

function newId(): string {
  return `wi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function runBacklog(params: BacklogParams, cwd: string, stateRoot = DEFAULT_STATE_ROOT): Record<string, unknown> {
  const log = stateFile(cwd, stateRoot);
  const host = hostname();

  if (params.action === "list") {
    const items = [...replay(log).values()].filter(item => !params.state || item.state === params.state);
    return { action: "list", count: items.length, items };
  }

  return withLock(log, stateRoot, () => {
    const items = replay(log);
    const now = new Date().toISOString();

    if (params.action === "enqueue") {
      if (!params.title) throw new Error("enqueue requires a title");
      const id = newId();
      appendFileSync(
        log,
        `${JSON.stringify({
          id,
          at: now,
          host,
          kind: "enqueue",
          title: params.title,
          sourceRef: params.sourceRef,
          syncTarget: params.syncTarget,
          scope: params.scope,
        })}\n`,
      );
      return { action: "enqueue", id, state: "queued", syncTarget: params.syncTarget ?? null };
    }

    if (!params.id) throw new Error(`${params.action} requires an item id`);
    const item = items.get(params.id);
    if (!item) throw new Error(`Unknown backlog item: ${params.id}`);
    const id = params.id;

    if (params.action === "claim") {
      if (item.state === "claimed" && item.host === host) {
        return { action: "claim", id, state: item.state, idempotent: true };
      }
      if (item.state === "claimed") throw new Error(`Item ${id} is already claimed by ${item.host}`);
      if (item.state !== "queued") throw new Error(`Item ${id} is ${item.state} and cannot be claimed`);
      appendFileSync(log, `${JSON.stringify({ id, at: now, host, kind: "claim" })}\n`);
      return { action: "claim", id, state: "claimed" };
    }

    if (params.action === "complete") {
      if (!params.evidence) throw new Error("complete requires evidence");
      if (item.state === "completed" || item.state === "pending-triage") {
        if (item.evidence === params.evidence) return { action: "complete", id, state: item.state, idempotent: true };
        throw new Error(`Item ${id} is already completed with different evidence`);
      }
      if (item.state !== "claimed") throw new Error(`Item ${id} is ${item.state}; claim it first`);
      if (item.host !== host) throw new Error(`Item ${id} is claimed by ${item.host}`);
      appendFileSync(log, `${JSON.stringify({ id, at: now, host, kind: "complete", evidence: params.evidence })}\n`);
      return { action: "complete", id, state: item.syncTarget ? "completed" : "pending-triage" };
    }

    if (params.action === "bind") {
      // Resolves the pending-triage dead end: work done offline without a ticket becomes
      // syncable once a human supplies the concrete tracker target.
      if (!params.syncTarget) throw new Error("bind requires an explicit syncTarget");
      if (item.state === "completed" && item.syncTarget) {
        if (item.syncTarget.issueRef === params.syncTarget.issueRef) {
          return { action: "bind", id, state: item.state, idempotent: true };
        }
        throw new Error(`Item ${id} already targets ${item.syncTarget.issueRef}`);
      }
      if (item.state !== "pending-triage") {
        throw new Error(`Item ${id} is ${item.state}; only a pending-triage item can be bound`);
      }
      appendFileSync(log, `${JSON.stringify({ id, at: now, host, kind: "bind", syncTarget: params.syncTarget })}\n`);
      return { action: "bind", id, state: "completed", syncTarget: params.syncTarget };
    }

    // ack reports what the tracker returned. The caller cannot assert state directly.
    if (!params.issueRef) throw new Error("ack requires the tracker issue reference");
    if (!params.commentId) throw new Error("ack requires the tracker comment id");
    if (item.state === "synced") {
      if (item.issueRef === params.issueRef && item.commentId === params.commentId) {
        return { action: "ack", id, state: "synced", idempotent: true };
      }
      throw new Error(`Item ${id} is already synced as ${item.issueRef}/${item.commentId}`);
    }
    if (item.state !== "completed") throw new Error(`Item ${id} is ${item.state}; only a completed item can be acked`);
    if (item.syncTarget && item.syncTarget.issueRef !== params.issueRef) {
      throw new Error(`Item ${id} targets ${item.syncTarget.issueRef}, not ${params.issueRef}`);
    }
    appendFileSync(
      log,
      `${JSON.stringify({ id, at: now, host, kind: "ack", issueRef: params.issueRef, commentId: params.commentId })}\n`,
    );
    return { action: "ack", id, state: "synced" };
  });
}

export type Reachability = { reachable: boolean; status: number; detail: string };

/**
 * Probe the tracker with a real HTTP request. A TCP connect test is not sufficient: on one fleet
 * host the mesh address accepted a TCP connection while HTTP returned nothing, whereas the LAN
 * address answered 401. Any HTTP status — including 401 — means the service is up and merely
 * wants credentials; no response at all means unreachable.
 *
 * The ambient proxy is bypassed deliberately. An observed outage was caused by `NO_PROXY`
 * holding the shell-style wildcard `192.168.*`, which Go's proxy resolver ignores, sending an
 * internal address to a proxy port with no listener.
 */
export async function probeTracker(baseUrl: string, timeoutMs = 5_000): Promise<Reachability> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL("/api/daemon/workspaces", baseUrl), {
      method: "GET",
      signal: controller.signal,
      // Undici honours no-proxy semantics per-request; an internal address must not be proxied.
      dispatcher: undefined,
    } as RequestInit);
    return { reachable: true, status: response.status, detail: `HTTP ${response.status}` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { reachable: false, status: 0, detail };
  } finally {
    clearTimeout(timer);
  }
}

/** Turn completed items into an executable plan. Performs no tracker write and holds no token. */
export function planSync(cwd: string, stateRoot = DEFAULT_STATE_ROOT): {
  pendingTriage: Item[];
  records: SyncRecord[];
} {
  const items = [...replay(stateFile(cwd, stateRoot)).values()];
  const pendingTriage = items.filter(item => item.state === "pending-triage");
  const records: SyncRecord[] = [];

  for (const item of items) {
    if (item.state !== "completed" || !item.syncTarget) continue;
    // The body path is produced here, never supplied by a caller.
    const bodyFile = join(tmpdir(), `orca-backlog-${item.id}.md`);
    writeFileSync(bodyFile, `${item.title}\n\n${item.evidence ?? ""}\n`, "utf8");
    records.push({
      id: item.id,
      issueRef: item.syncTarget.issueRef,
      bodyFile,
      command: "multica",
      // --content-file rather than stdin: the tracker CLI documents that stdin mangles
      // non-ASCII bytes on Windows.
      args: ["issue", "comment", "add", item.syncTarget.issueRef, "--content-file", bodyFile],
    });
  }

  return { pendingTriage, records };
}

export function registerOfflineTools(
  pi: HostApi,
  backlogParameters: unknown,
  syncParameters: unknown,
  metadata: ToolMetadata = {},
  stateRoot = DEFAULT_STATE_ROOT,
): void {
  const asResult = (details: Record<string, unknown>): ToolResult => ({
    content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
    details,
  });

  pi.registerTool({
    name: "orca_backlog",
    label: "Orca backlog",
    description:
      "Local work backlog that survives tracker downtime. Actions: enqueue, claim, complete, ack, list. " +
      "Never contacts the tracker. A claim is exclusive per host only, never across hosts. " +
      "Pass syncTarget only when a concrete tracker issue is known; sourceRef stays a traceability label.",
    parameters: backlogParameters,
    ...metadata,
    // `params` arrives typed as the host's declared tool parameter shape; the real contract is
    // enforced at runtime by parseBacklogParams, which takes unknown. No cast is needed.
    async execute(_toolCallId, params, _signal, _onUpdate, context) {
      return asResult(runBacklog(parseBacklogParams(params), context.cwd ?? process.cwd(), stateRoot));
    },
  });

  pi.registerTool({
    name: "orca_outbox_sync",
    label: "Orca outbox sync",
    description:
      "Plan tracker writes for completed backlog items. Emits the exact argv to run and holds no " +
      "credential; the caller executes it and reports the result with orca_backlog ack. Items " +
      "without a syncTarget are reported as pending-triage and never auto-filed.",
    parameters: syncParameters,
    ...metadata,
    async execute(_toolCallId, _params, _signal, _onUpdate, context) {
      const plan = planSync(context.cwd ?? process.cwd(), stateRoot);
      // Read only from the environment. A caller-supplied URL would let a model point this probe
      // at an arbitrary host, turning the tool into an SSRF primitive against the internal
      // network; the operator configures the endpoint instead. Only a base URL is ever read
      // here — never a token, which stays outside this package entirely.
      const trackerUrl = (process.env.MULTICA_SERVER_URL ?? "").trim();
      // The plan is produced either way, so work can be queued with no network at all.
      const reachability = trackerUrl
        ? await probeTracker(trackerUrl)
        : { reachable: false, status: 0, detail: "MULTICA_SERVER_URL is unset; reachability not probed" };
      return asResult({
        records: plan.records,
        pendingTriage: plan.pendingTriage,
        reachability,
        note: reachability.reachable === false
          ? "Tracker unreachable: leave every item queued and retry later."
          : "Run each record's argv, then call orca_backlog ack with the returned issue and comment ids.",
      });
    },
  });
}
