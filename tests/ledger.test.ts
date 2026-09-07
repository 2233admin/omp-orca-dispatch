import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import type { ExecOptions, ExecResult, HostApi, ToolDefinition } from "../src/contracts.js";
import type { BackendRuntime } from "../src/backends/types.js";
import { registerOrcaTaskDispatch } from "../src/dispatcher.js";
import {
  beginRound,
  canonicalJson,
  collectRounds,
  guardedFastForward,
  integrateRound,
  ledgerKey,
  ledgerPaths,
  normalizeIdentity,
  readLedger,
  recordDispatchOutcome,
  replayLedger,
  resolveGatePolicy,
  validateRoundId,
  type DispatchedMember,
  type IntegrateResult,
  type LedgerLocation,
  type LedgerPaths,
} from "../src/ledger.js";

/**
 * Every test builds a throwaway git repository and its own state root, so nothing here touches
 * the real checkout or the real ~/.orca-task-dispatch.
 */
const scratchRoots: string[] = [];
const strayWorktrees: string[] = [];

after(() => {
  for (const path of strayWorktrees) rmSync(path, { recursive: true, force: true });
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
});

/** A real argv-only host: the ledger drives git, so the tests must run git for real. */
const host: HostApi = {
  registerTool() {
    // The ledger tests register through `registeredTool`, which supplies its own collector.
  },
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult> {
    const finished = Promise.withResolvers<ExecResult>();
    execFile(
      command,
      args,
      {
        ...(options?.cwd ? { cwd: options.cwd } : {}),
        ...(options?.timeout ? { timeout: options.timeout } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
        encoding: "utf8",
        maxBuffer: 8_000_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const detail = error as (Error & { code?: unknown }) | null;
        const code = detail ? (typeof detail.code === "number" ? detail.code : 1) : 0;
        finished.resolve({ stdout, stderr, code });
      },
    );
    return finished.promise;
  },
};

const PASSING_GATE = {
  name: "combined-tree",
  // Proves the gate ran on the merged tree rather than on either child or on the parent.
  argv: [process.execPath, "-e", "const fs=require('node:fs');if(!fs.existsSync('src/added.ts')||!fs.existsSync('docs/added.md'))process.exit(3);"],
  env: "inherit" as const,
  timeoutMs: 60_000,
};
const MINIMAL_ENV_GATE = {
  name: "no-inherited-env",
  argv: [process.execPath, "-e", "if(process.env.ORCA_LEDGER_TEST_SECRET)process.exit(4);"],
  env: "none" as const,
  timeoutMs: 60_000,
};

type Fixture = {
  root: string;
  repo: string;
  state: string;
  base: string;
  location: LedgerLocation;
  runtime: BackendRuntime;
  paths: LedgerPaths;
};

async function gitIn(cwd: string, args: string[]): Promise<string> {
  const run = await host.exec("git", args, { cwd });
  assert.equal(run.code, 0, `git ${args.join(" ")} failed: ${run.stderr || run.stdout}`);
  return run.stdout.trim();
}

async function fixture(options: { gates?: unknown } = {}): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "orca-ledger-test-"));
  scratchRoots.push(root);
  const created = join(root, "repo");
  mkdirSync(join(created, "src"), { recursive: true });
  mkdirSync(join(created, "docs"), { recursive: true });
  await gitIn(created, ["init", "--initial-branch=main"]);
  await gitIn(created, ["config", "user.name", "Ledger Test"]);
  await gitIn(created, ["config", "user.email", "ledger@test.invalid"]);
  await gitIn(created, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(created, "src", "core.ts"), "export const core = 1;\n", "utf8");
  writeFileSync(join(created, "docs", "guide.md"), "# guide\n", "utf8");
  writeFileSync(join(created, "README.md"), "# fixture\n", "utf8");
  if (options.gates !== undefined) {
    mkdirSync(join(created, ".orca-task-dispatch"), { recursive: true });
    writeFileSync(join(created, ".orca-task-dispatch", "gates.json"), JSON.stringify(options.gates), "utf8");
  }
  await gitIn(created, ["add", "-A"]);
  await gitIn(created, ["commit", "-m", "base"]);

  // git reports the canonical root; on Windows the temp path can be a short form, so every
  // later comparison uses git's own answer rather than the constructed path.
  const repo = normalizeIdentity(await gitIn(created, ["rev-parse", "--show-toplevel"]));
  const base = await gitIn(repo, ["rev-parse", "HEAD"]);
  const state = join(root, "state");
  const location: LedgerLocation = {
    backendId: "git-worktree",
    repoId: normalizeIdentity(await gitIn(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])),
    parentWorktreeId: repo,
  };
  return { root, repo, state, base, location, runtime: { pi: host, cwd: repo }, paths: ledgerPaths(location, state) };
}

/** One child worktree with one commit, exactly as a dispatched worker leaves it. */
async function child(
  fx: Fixture,
  name: string,
  files: Record<string, string>,
  options: { from?: string; remove?: string[] } = {},
): Promise<{ path: string; sha: string }> {
  const path = join(fx.root, `child-${name}`);
  await gitIn(fx.repo, ["worktree", "add", "-b", name, path, options.from ?? fx.base]);
  for (const [relative, content] of Object.entries(files)) {
    const target = join(path, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  for (const relative of options.remove ?? []) rmSync(join(path, relative), { force: true });
  await gitIn(path, ["add", "-A"]);
  await gitIn(path, ["commit", "-m", `work in ${name}`]);
  return { path, sha: await gitIn(path, ["rev-parse", "HEAD"]) };
}

async function openRound(
  fx: Fixture,
  members: Array<{ name: string; scope: string[] }>,
  supersedes?: string,
): Promise<string> {
  return beginRound(
    fx.location,
    { baseHead: fx.base, members, ...(supersedes ? { supersedes } : {}) },
    fx.state,
  );
}

async function markDispatched(
  fx: Fixture,
  roundId: string,
  members: Array<Partial<DispatchedMember> & { name: string }>,
  failed: Array<{ name: string; message: string }> = [],
): Promise<void> {
  await recordDispatchOutcome(
    fx.location,
    roundId,
    {
      dispatched: members.map(member => ({
        name: member.name,
        branch: member.branch ?? member.name,
        worktreeId: member.worktreeId ?? null,
        worktreePath: member.worktreePath ?? null,
      })),
      failed,
    },
    fx.state,
  );
}

async function commitGates(fx: Fixture, content: string): Promise<void> {
  mkdirSync(join(fx.repo, ".orca-task-dispatch"), { recursive: true });
  writeFileSync(join(fx.repo, ".orca-task-dispatch", "gates.json"), content, "utf8");
  await gitIn(fx.repo, ["add", "-A"]);
  await gitIn(fx.repo, ["commit", "-m", "gate policy"]);
}

function recordKinds(paths: LedgerPaths): string[] {
  if (!existsSync(paths.log)) return [];
  return readFileSync(paths.log, "utf8")
    .split("\n")
    .filter(line => line.trim())
    .map(line => {
      const record: unknown = JSON.parse(line);
      return record !== null && typeof record === "object" && "kind" in record ? String(record.kind) : "";
    });
}

function registeredTool(stateRoot: string): ToolDefinition {
  let definition: ToolDefinition | undefined;
  registerOrcaTaskDispatch(
    {
      exec: host.exec,
      registerTool(tool) {
        definition = tool;
      },
    },
    { type: "object" },
    {},
    stateRoot,
  );
  assert.ok(definition);
  return definition;
}

async function integrate(fx: Fixture, roundId: string): Promise<IntegrateResult> {
  const outcome = await integrateRound({ runtime: fx.runtime, location: fx.location, roundId, stateRoot: fx.state });
  if (outcome.integrationWorktree) strayWorktrees.push(outcome.integrationWorktree);
  return outcome;
}

test("the ledger key keeps parents that differ only by case apart", () => {
  const base = { backendId: "orca", repoId: "id:Repo-1", parentWorktreeId: "id:Parent-1" };
  assert.notEqual(ledgerKey(base), ledgerKey({ ...base, repoId: "id:repo-1" }));
  assert.notEqual(ledgerKey(base), ledgerKey({ ...base, parentWorktreeId: "id:parent-1" }));
  // The backend id is part of the key, so the same repo under two backends never shares a log.
  assert.notEqual(ledgerKey(base), ledgerKey({ ...base, backendId: "git-worktree" }));
  // Separators and one trailing slash are normalized; nothing else is.
  assert.equal(
    ledgerKey({ backendId: "git-worktree", repoId: "D:\\repo\\.git", parentWorktreeId: "D:\\repo\\" }),
    ledgerKey({ backendId: "git-worktree", repoId: "D:/repo/.git", parentWorktreeId: "D:/repo" }),
  );
  assert.equal(normalizeIdentity("D:\\repo\\"), "D:/repo");
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] }), '{"a":[2,{"c":3,"d":4}],"b":1}');
  assert.throws(() => validateRoundId("../escape"), /roundId must be/);
  assert.throws(() => validateRoundId(undefined), /roundId must be/);
});

test("replay tolerates a torn final record and fails on any other corruption", async () => {
  const fx = await fixture();
  const roundId = await openRound(fx, [{ name: "core", scope: ["src"] }]);
  await markDispatched(fx, roundId, [{ name: "core" }]);

  // The interrupted append crash recovery depends on: a half-written final line.
  appendFileSync(fx.paths.log, '{"kind":"held","roundId":"', "utf8");
  const tolerated = replayLedger(fx.paths.log);
  assert.equal(tolerated.get(roundId)?.outcome, undefined);
  assert.equal(tolerated.get(roundId)?.dispatched.length, 1);

  // A torn line that is not final is corruption, not an interrupted append.
  appendFileSync(fx.paths.log, `\n${JSON.stringify({ kind: "held", roundId, at: "2026-01-01T00:00:00.000Z", host: "h", reason: "later" })}\n`, "utf8");
  assert.throws(() => replayLedger(fx.paths.log), /corrupt at line 3 \(json-torn\)/);

  const other = await fixture();
  const otherRound = await openRound(other, [{ name: "core", scope: ["src"] }]);
  // Parses as JSON, violates the schema: dropping it could hide a merged outcome.
  appendFileSync(other.paths.log, `${JSON.stringify({ kind: "merged", roundId: otherRound, at: "2026-01-01T00:00:00.000Z", host: "h" })}\n`, "utf8");
  assert.throws(() => replayLedger(other.paths.log), /schema-invalid/);

  const unknown = await fixture();
  const unknownRound = await openRound(unknown, [{ name: "core", scope: ["src"] }]);
  // An unknown kind is exactly what writing a backlog event into this log would look like.
  appendFileSync(unknown.paths.log, `${JSON.stringify({ kind: "enqueue", roundId: unknownRound, at: "2026-01-01T00:00:00.000Z", host: "h" })}\n`, "utf8");
  assert.throws(() => replayLedger(unknown.paths.log), /schema-invalid/);
});

test("dispatch writes round membership before any child and one record per created child", async () => {
  const fx = await fixture({ gates: { schemaVersion: 1, gates: [PASSING_GATE] } });
  const output = await registeredTool(fx.state).execute(
    "call",
    {
      task: "Split the work",
      backend: "git-worktree",
      slices: [
        { name: "core", task: "Implement core", scope: ["src"] },
        { name: "docs", task: "Write docs", scope: ["docs"] },
      ],
    } as never,
    undefined,
    undefined,
    { cwd: fx.repo },
  );

  assert.equal(output.details.status, "dispatched");
  assert.equal(output.details.roundHeld, false);
  const roundId = String(output.details.roundId);
  assert.match(roundId, /^rd-/);
  // Membership is durable before creation, so the round record precedes every dispatched record.
  assert.deepEqual(recordKinds(fx.paths), ["round", "dispatched", "dispatched"]);
  const round = readLedger(fx.location, fx.state).get(roundId);
  assert.deepEqual(round?.members.map(member => member.name), ["core", "docs"]);
  assert.deepEqual(round?.members.map(member => member.scope), [["src"], ["docs"]]);
  assert.equal(round?.baseHead, fx.base);
  assert.deepEqual(round?.dispatched.map(member => member.branch).sort(), ["core", "docs"]);
  assert.equal(round?.outcome, undefined);
});

test("a creation failure makes the round terminally held with no integration", async () => {
  const fx = await fixture({ gates: { schemaVersion: 1, gates: [PASSING_GATE] } });
  // Occupying the branch name is how a real `git worktree add -b` fails for one slice only.
  await gitIn(fx.repo, ["branch", "docs", fx.base]);
  const output = await registeredTool(fx.state).execute(
    "call",
    {
      task: "Split the work",
      backend: "git-worktree",
      slices: [
        { name: "core", task: "Implement core", scope: ["src"] },
        { name: "docs", task: "Write docs", scope: ["docs"] },
      ],
    } as never,
    undefined,
    undefined,
    { cwd: fx.repo },
  );

  assert.equal(output.details.status, "partial");
  assert.equal(output.details.roundHeld, true);
  assert.equal(output.details.integrationRequired, true);
  const roundId = String(output.details.roundId);
  assert.deepEqual(recordKinds(fx.paths), ["round", "dispatched", "dispatch-failed"]);
  const round = readLedger(fx.location, fx.state).get(roundId);
  assert.equal(round?.outcome, "held");
  assert.match(String(round?.reason), /dispatch-failed: docs/);

  const held = await integrate(fx, roundId);
  assert.equal(held.status, "held");
  assert.match(String(held.reason), /dispatch-failed: docs/);
  assert.equal(held.integrationWorktree, null);
});

test("integrate holds a round whose member never got a dispatched record", async () => {
  const fx = await fixture({ gates: { schemaVersion: 1, gates: [PASSING_GATE] } });
  await child(fx, "core", { "src/added.ts": "export const added = 1;\n" });
  const roundId = await openRound(fx, [
    { name: "core", scope: ["src"] },
    { name: "docs", scope: ["docs"] },
  ]);
  await markDispatched(fx, roundId, [{ name: "core" }]);

  const outcome = await integrate(fx, roundId);
  assert.equal(outcome.status, "held");
  assert.match(String(outcome.reason), /no dispatched record for docs/);
  assert.equal(outcome.integrationWorktree, null);
  assert.equal(recordKinds(fx.paths).includes("attempt"), false);
  assert.equal(await gitIn(fx.repo, ["rev-parse", "HEAD"]), fx.base);
});

test("integrate rejects an unresolvable member and a member still at baseHead", async () => {
  const unresolvable = await fixture({ gates: { schemaVersion: 1, gates: [PASSING_GATE] } });
  const missingRound = await openRound(unresolvable, [{ name: "core", scope: ["src"] }]);
  await markDispatched(unresolvable, missingRound, [{ name: "core", branch: "never-created" }]);
  const missing = await integrate(unresolvable, missingRound);
  assert.equal(missing.status, "held");
  assert.match(String(missing.reason), /member core is unresolvable/);

  const stalled = await fixture({ gates: { schemaVersion: 1, gates: [PASSING_GATE] } });
  await gitIn(stalled.repo, ["branch", "core", stalled.base]);
  const stalledRound = await openRound(stalled, [{ name: "core", scope: ["src"] }]);
  await markDispatched(stalled, stalledRound, [{ name: "core" }]);
  const uncommitted = await integrate(stalled, stalledRound);
  assert.equal(uncommitted.status, "held");
  assert.match(String(uncommitted.reason), /still at baseHead/);
  assert.equal(recordKinds(stalled.paths).includes("attempt"), false);
});

test("integrate holds a pre-merge scope violation with nothing created", async () => {
  const fx = await fixture({ gates: { schemaVersion: 1, gates: [PASSING_GATE] } });
  await child(fx, "core", { "src/added.ts": "export const added = 1;\n", "docs/sneaky.md": "not mine\n" });
  await child(fx, "docs", { "docs/added.md": "# added\n" });
  const roundId = await openRound(fx, [
    { name: "core", scope: ["src"] },
    { name: "docs", scope: ["docs"] },
  ]);
  await markDispatched(fx, roundId, [{ name: "core" }, { name: "docs" }]);

  const worktreesBefore = (await gitIn(fx.repo, ["worktree", "list"])).split("\n").length;
  const outcome = await integrate(fx, roundId);
  assert.equal(outcome.status, "held");
  assert.match(String(outcome.reason), /member core changed 1 path\(s\) outside its owned scope: docs\/sneaky\.md/);
  // Nothing was created: no integration worktree, no attempt, no target movement.
  assert.equal(outcome.integrationWorktree, null);
  assert.equal(outcome.gates.length, 0);
  assert.equal(recordKinds(fx.paths).includes("attempt"), false);
  assert.equal(await gitIn(fx.repo, ["rev-parse", "HEAD"]), fx.base);
  assert.equal((await gitIn(fx.repo, ["worktree", "list"])).split("\n").length, worktreesBefore);
});

test("integrate holds on a combined-tree gate failure and leaves the target unchanged", async () => {
  const fx = await fixture({
    gates: { schemaVersion: 1, gates: [{ name: "red", argv: [process.execPath, "-e", "process.exit(7)"], env: "inherit", timeoutMs: 60_000 }] },
  });
  await child(fx, "core", { "src/added.ts": "export const added = 1;\n" });
  await child(fx, "docs", { "docs/added.md": "# added\n" });
  const roundId = await openRound(fx, [
    { name: "core", scope: ["src"] },
    { name: "docs", scope: ["docs"] },
  ]);
  await markDispatched(fx, roundId, [{ name: "core" }, { name: "docs" }]);

  const outcome = await integrate(fx, roundId);
  assert.equal(outcome.status, "held");
  assert.match(String(outcome.reason), /gate red failed with exit 7 on the combined tree/);
  assert.deepEqual(outcome.gates.map(gate => [gate.name, gate.ok, gate.code]), [["red", false, 7]]);
  assert.equal(outcome.retainedIntegrationWorktree, true);
  // The gate ran on the combined tree, but nothing was recorded as an attempt and the target
  // never moved, so the round is decidable without ancestry.
  assert.equal(recordKinds(fx.paths).includes("attempt"), false);
  assert.equal(await gitIn(fx.repo, ["rev-parse", "HEAD"]), fx.base);
  assert.equal(readLedger(fx.location, fx.state).get(roundId)?.outcome, "held");
});

// The gate timeout is enforced by the operating system against the platform clock, so this one
// test spends a real second: there is no injectable clock inside a spawned gate process.
test("integrate holds when a gate exceeds its timeout", async () => {
  const fx = await fixture({
    gates: {
      schemaVersion: 1,
      gates: [{ name: "slow", argv: [process.execPath, "-e", "setTimeout(()=>{},10000)"], env: "inherit", timeoutMs: 1_000 }],
    },
  });
  await child(fx, "core", { "src/added.ts": "export const added = 1;\n" });
  const roundId = await openRound(fx, [{ name: "core", scope: ["src"] }]);
  await markDispatched(fx, roundId, [{ name: "core" }]);

  const outcome = await integrate(fx, roundId);
  assert.equal(outcome.status, "held");
  assert.match(String(outcome.reason), /gate slow exceeded 1000ms/);
  assert.equal(outcome.gates.at(0)?.timedOut, true);
  assert.equal(recordKinds(fx.paths).includes("attempt"), false);
  assert.equal(await gitIn(fx.repo, ["rev-parse", "HEAD"]), fx.base);
});

test("integrate holds on a merge conflict and retains the tree for inspection", async () => {
  const fx = await fixture({ gates: { schemaVersion: 1, gates: [PASSING_GATE] } });
  await child(fx, "core", { "src/core.ts": "export const core = 2;\n", "src/added.ts": "export const added = 1;\n" });
  await child(fx, "docs", { "docs/added.md": "# added\n" });
  // The target advanced with a conflicting change to the same file, which is reachable whenever
  // the parent keeps working after dispatch.
  writeFileSync(join(fx.repo, "src", "core.ts"), "export const core = 99;\n", "utf8");
  await gitIn(fx.repo, ["commit", "-am", "parent edits core"]);
  const advanced = await gitIn(fx.repo, ["rev-parse", "HEAD"]);
  const roundId = await openRound(fx, [
    { name: "core", scope: ["src"] },
    { name: "docs", scope: ["docs"] },
  ]);
  await markDispatched(fx, roundId, [{ name: "core" }, { name: "docs" }]);

  const outcome = await integrate(fx, roundId);
  assert.equal(outcome.status, "held");
  assert.match(String(outcome.reason), /conflict merging member core/);
  assert.equal(outcome.retainedIntegrationWorktree, true);
  assert.equal(recordKinds(fx.paths).includes("attempt"), false);
  assert.equal(await gitIn(fx.repo, ["rev-parse", "HEAD"]), advanced);
});

test("integrate auto-merges an all-green round and advances the target by fast-forward", async () => {
  const fx = await fixture({ gates: { schemaVersion: 1, gates: [PASSING_GATE, MINIMAL_ENV_GATE] } });
  process.env.ORCA_LEDGER_TEST_SECRET = "leak";
  const core = await child(fx, "core", { "src/added.ts": "export const added = 1;\n" });
  const docs = await child(fx, "docs", { "docs/added.md": "# added\n" });
  const roundId = await openRound(fx, [
    { name: "core", scope: ["src"] },
    { name: "docs", scope: ["docs"] },
  ]);
  await markDispatched(fx, roundId, [
    { name: "core", worktreePath: core.path },
    { name: "docs", worktreePath: docs.path },
  ]);

  let outcome;
  try {
    outcome = await integrate(fx, roundId);
  } finally {
    delete process.env.ORCA_LEDGER_TEST_SECRET;
  }
  assert.equal(outcome.status, "merged", outcome.screen);
  assert.deepEqual(outcome.gates.map(gate => [gate.name, gate.ok]), [
    ["combined-tree", true],
    ["no-inherited-env", true],
  ]);
  assert.deepEqual(outcome.members.map(member => member.sha).sort(), [core.sha, docs.sha].sort());
  // `attempt` is durable before the target moves, which is what makes a crash decidable.
  assert.deepEqual(recordKinds(fx.paths), ["round", "dispatched", "dispatched", "attempt", "merged"]);
  const head = await gitIn(fx.repo, ["rev-parse", "HEAD"]);
  assert.equal(head, outcome.candidateSha);
  assert.equal(head, outcome.targetShaAfter);
  // A fast-forward updates the checked-out tree, not only the ref.
  assert.equal(existsSync(join(fx.repo, "src", "added.ts")), true);
  assert.equal(existsSync(join(fx.repo, "docs", "added.md")), true);
  assert.equal(outcome.retainedIntegrationWorktree, false);
  assert.equal(existsSync(String(outcome.integrationWorktree)), false);

  // Idempotent rerun: no second merge, no new records.
  const before = readFileSync(fx.paths.log, "utf8");
  const again = await integrate(fx, roundId);
  assert.equal(again.status, "merged");
  assert.equal(again.idempotent, true);
  assert.equal(readFileSync(fx.paths.log, "utf8"), before);
  assert.equal(await gitIn(fx.repo, ["rev-parse", "HEAD"]), head);
});

test("a target that advanced after dispatch still integrates cleanly", async () => {
  const fx = await fixture({ gates: { schemaVersion: 1, gates: [PASSING_GATE] } });
  await child(fx, "core", { "src/added.ts": "export const added = 1;\n" });
  await child(fx, "docs", { "docs/added.md": "# added\n" });
  const roundId = await openRound(fx, [
    { name: "core", scope: ["src"] },
    { name: "docs", scope: ["docs"] },
  ]);
  await markDispatched(fx, roundId, [{ name: "core" }, { name: "docs" }]);
  writeFileSync(join(fx.repo, "README.md"), "# fixture moved on\n", "utf8");
  await gitIn(fx.repo, ["commit", "-am", "parent moves on"]);
  const advanced = await gitIn(fx.repo, ["rev-parse", "HEAD"]);

  const outcome = await integrate(fx, roundId);
  assert.equal(outcome.status, "merged", outcome.screen);
  assert.equal(outcome.targetShaBefore, advanced);
  // The candidate was built on the advanced target, so the later commit survives the merge.
  assert.equal(await gitIn(fx.repo, ["merge-base", "--is-ancestor", advanced, "HEAD"]), "");
  assert.equal(readFileSync(join(fx.repo, "README.md"), "utf8"), "# fixture moved on\n");
});

test("integrate refuses to advance a target that moved between snapshot and compare-and-set", async () => {
  const fx = await fixture();
  // The gate itself moves the parent branch, which is the observable form of another integration
  // or the operator committing while the gates run.
  await commitGates(
    fx,
    JSON.stringify({
      schemaVersion: 1,
      gates: [{ name: "racy", argv: ["git", "-C", fx.repo, "commit", "--allow-empty", "-m", "concurrent"], env: "inherit", timeoutMs: 60_000 }],
    }),
  );
  await child(fx, "core", { "src/added.ts": "export const added = 1;\n" });
  const roundId = await openRound(fx, [{ name: "core", scope: ["src"] }]);
  await markDispatched(fx, roundId, [{ name: "core" }]);

  const outcome = await integrate(fx, roundId);
  assert.equal(outcome.status, "held");
  assert.match(String(outcome.reason), /target main moved from/);
  // The attempt is recorded before the guard runs, so a crash here is still decidable.
  assert.deepEqual(recordKinds(fx.paths), ["round", "dispatched", "attempt", "held"]);
  assert.equal(await gitIn(fx.repo, ["rev-parse", "HEAD"]), await gitIn(fx.repo, ["rev-parse", "main"]));
  assert.notEqual(await gitIn(fx.repo, ["rev-parse", "HEAD"]), outcome.candidateSha);
});

test("integrate refuses to advance a dirty parent worktree", async () => {
  const fx = await fixture({ gates: { schemaVersion: 1, gates: [PASSING_GATE] } });
  await child(fx, "core", { "src/added.ts": "export const added = 1;\n" });
  await child(fx, "docs", { "docs/added.md": "# added\n" });
  const roundId = await openRound(fx, [
    { name: "core", scope: ["src"] },
    { name: "docs", scope: ["docs"] },
  ]);
  await markDispatched(fx, roundId, [{ name: "core" }, { name: "docs" }]);
  writeFileSync(join(fx.repo, "README.md"), "# uncommitted\n", "utf8");

  const outcome = await integrate(fx, roundId);
  assert.equal(outcome.status, "held");
  assert.match(String(outcome.reason), /parent worktree is dirty/);
  assert.equal(await gitIn(fx.repo, ["rev-parse", "HEAD"]), fx.base);
  assert.equal(readFileSync(join(fx.repo, "README.md"), "utf8"), "# uncommitted\n");
  assert.deepEqual(recordKinds(fx.paths), ["round", "dispatched", "dispatched", "attempt", "held"]);
});

test("the guarded fast-forward refuses a candidate that is not a descendant of the target", async () => {
  const fx = await fixture();
  // `commit-tree` with `-m` never reads stdin, so it cannot hang under a piped exec; an orphan
  // commit is the only way to get a candidate outside the target's ancestry.
  const tree = await gitIn(fx.repo, ["rev-parse", "HEAD^{tree}"]);
  const orphan = await gitIn(fx.repo, ["commit-tree", tree, "-m", "unrelated"]);

  const refused = await guardedFastForward({
    runtime: fx.runtime,
    parentWorktreePath: fx.repo,
    target: "main",
    expectedSha: fx.base,
    candidateSha: orphan,
  });
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.reason, /is not a descendant of target/);
  assert.equal(await gitIn(fx.repo, ["rev-parse", "HEAD"]), fx.base);

  const stale = await guardedFastForward({
    runtime: fx.runtime,
    parentWorktreePath: fx.repo,
    target: "main",
    expectedSha: orphan,
    candidateSha: fx.base,
  });
  assert.equal(stale.ok, false);
  assert.match(stale.ok ? "" : stale.reason, /moved from/);
  assert.equal(await gitIn(fx.repo, ["rev-parse", "HEAD"]), fx.base);
});

test("every gate-policy failure mode resolves to one outcome", async () => {
  const fx = await fixture();
  const missing = resolveGatePolicy(fx.repo);
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? "" : missing.reason, /missing at \.orca-task-dispatch\/gates\.json/);

  const good = { name: "ok", argv: ["node", "-e", ""], env: "inherit", timeoutMs: 1_000 };
  const cases: Array<[string, string, RegExp]> = [
    ["unparseable", "{not json", /unparseable/],
    ["not an object", "[]", /not a JSON object/],
    ["wrong version", JSON.stringify({ schemaVersion: 2, gates: [good] }), /schemaVersion must be 1/],
    ["no gates", JSON.stringify({ schemaVersion: 1, gates: [] }), /at least one gate/],
    ["gate not an object", JSON.stringify({ schemaVersion: 1, gates: ["npm test"] }), /is not an object/],
    ["empty argv", JSON.stringify({ schemaVersion: 1, gates: [{ ...good, argv: [] }] }), /non-empty array of strings/],
    ["shell string", JSON.stringify({ schemaVersion: 1, gates: [{ ...good, argv: ["  "] }] }), /never a shell string/],
    ["bad env", JSON.stringify({ schemaVersion: 1, gates: [{ ...good, env: "all" }] }), /must be "inherit" or "none"/],
    ["timeout too small", JSON.stringify({ schemaVersion: 1, gates: [{ ...good, timeoutMs: 999 }] }), /between 1000 and 1800000/],
    ["timeout too large", JSON.stringify({ schemaVersion: 1, gates: [{ ...good, timeoutMs: 1_800_001 }] }), /between 1000 and 1800000/],
    ["timeout not integer", JSON.stringify({ schemaVersion: 1, gates: [{ ...good, timeoutMs: 1_500.5 }] }), /between 1000 and 1800000/],
    ["unknown field", JSON.stringify({ schemaVersion: 1, gates: [{ ...good, cwd: "repoRoot" }] }), /unknown field/],
    ["duplicate names", JSON.stringify({ schemaVersion: 1, gates: [good, good] }), /duplicates ok/],
  ];
  for (const [label, content, expected] of cases) {
    await commitGates(fx, content);
    const resolution = resolveGatePolicy(fx.repo);
    assert.equal(resolution.ok, false, label);
    assert.match(resolution.ok ? "" : resolution.reason, expected, label);
  }

  await commitGates(fx, JSON.stringify({ schemaVersion: 1, gates: [good] }));
  const accepted = resolveGatePolicy(fx.repo);
  assert.equal(accepted.ok, true);
  // The digest is over canonical JSON, so key order in the file cannot change it.
  await commitGates(fx, JSON.stringify({ gates: [{ timeoutMs: 1_000, env: "inherit", argv: ["node", "-e", ""], name: "ok" }], schemaVersion: 1 }));
  const reordered = resolveGatePolicy(fx.repo);
  assert.equal(reordered.ok && accepted.ok && reordered.digest === accepted.digest, true);
});

test("a missing gate policy holds the round with nothing created and no attempt", async () => {
  const fx = await fixture();
  await child(fx, "core", { "src/added.ts": "export const added = 1;\n" });
  const roundId = await openRound(fx, [{ name: "core", scope: ["src"] }]);
  await markDispatched(fx, roundId, [{ name: "core" }]);

  const outcome = await integrate(fx, roundId);
  assert.equal(outcome.status, "held");
  assert.match(String(outcome.reason), /gate policy is missing/);
  assert.equal(outcome.integrationWorktree, null);
  assert.equal(outcome.policyDigest, null);
  assert.deepEqual(recordKinds(fx.paths), ["round", "dispatched", "held"]);
  assert.equal(await gitIn(fx.repo, ["rev-parse", "HEAD"]), fx.base);
});

test("collect inspects without appending, without a policy, and without a gate", async () => {
  // No gate policy exists at all, so a collect that resolved one could not succeed here.
  const fx = await fixture();
  const core = await child(fx, "core", { "src/added.ts": "export const added = 1;\n", "src/shared.ts": "export const shared = 1;\n" });
  const roundId = await openRound(fx, [
    { name: "core", scope: ["src"] },
    { name: "docs", scope: ["docs"] },
  ]);
  await markDispatched(fx, roundId, [{ name: "core", worktreePath: core.path }, { name: "docs" }]);

  const before = readFileSync(fx.paths.log, "utf8");
  const beforeSize = statSync(fx.paths.log).size;
  const collected = await collectRounds({ runtime: fx.runtime, location: fx.location, stateRoot: fx.state });
  assert.equal(readFileSync(fx.paths.log, "utf8"), before);
  assert.equal(statSync(fx.paths.log).size, beforeSize);

  const round = collected.rounds.at(0);
  assert.equal(collected.rounds.length, 1);
  assert.equal(round?.roundId, roundId);
  assert.equal(collected.target, "main");
  assert.equal(collected.targetSha, fx.base);
  const observed = round?.members.at(0);
  // The round-one failure: a child that has committed must never read as outstanding.
  assert.equal(observed?.commits, 1);
  assert.equal(observed?.movedOffBase, true);
  assert.equal(observed?.outstanding, false);
  assert.deepEqual(observed?.changedPaths.sort(), ["src/added.ts", "src/shared.ts"]);
  assert.deepEqual(observed?.outsideScope, []);
  assert.deepEqual(round?.outstanding, ["docs"]);
  assert.equal(round?.integratable, false);
  assert.match(collected.screen, /outstanding: docs/);
  assert.match(collected.screen, /collect appends nothing/);

  // Reported, never enforced: an out-of-scope path shows up without holding anything.
  const violating = await fixture();
  await child(violating, "core", { "docs/sneaky.md": "not mine\n" });
  const violatingRound = await openRound(violating, [{ name: "core", scope: ["src"] }]);
  await markDispatched(violating, violatingRound, [{ name: "core" }]);
  const reported = await collectRounds({ runtime: violating.runtime, location: violating.location, stateRoot: violating.state });
  assert.deepEqual(reported.rounds.at(0)?.members.at(0)?.outsideScope, ["docs/sneaky.md"]);
  assert.equal(reported.rounds.at(0)?.integratable, false);
  assert.equal(recordKinds(violating.paths).includes("held"), false);
});

test("collect reports cross-child path overlap and a missing dispatched record", async () => {
  const fx = await fixture();
  await child(fx, "core", { "src/shared.ts": "export const shared = 1;\n" });
  await child(fx, "twin", { "src/shared.ts": "export const shared = 2;\n" });
  const roundId = await openRound(fx, [
    { name: "core", scope: ["src"] },
    { name: "twin", scope: ["src"] },
    { name: "ghost", scope: ["docs"] },
  ]);
  await markDispatched(fx, roundId, [{ name: "core" }, { name: "twin" }]);

  const collected = await collectRounds({ runtime: fx.runtime, location: fx.location, roundId, stateRoot: fx.state });
  const round = collected.rounds.at(0);
  assert.deepEqual(round?.members.at(0)?.overlaps, ["src/shared.ts"]);
  assert.deepEqual(round?.members.at(1)?.overlaps, ["src/shared.ts"]);
  assert.deepEqual(round?.missingDispatch, ["ghost"]);
  assert.match(collected.screen, /never dispatched: ghost/);
  assert.match(collected.screen, /also touched by a sibling: src\/shared\.ts/);
});

test("collect from a different parent resolves a different and empty ledger", async () => {
  const fx = await fixture();
  await child(fx, "core", { "src/added.ts": "export const added = 1;\n" });
  const roundId = await openRound(fx, [{ name: "core", scope: ["src"] }]);
  await markDispatched(fx, roundId, [{ name: "core" }]);

  const elsewhere: LedgerLocation = { ...fx.location, parentWorktreeId: `${fx.location.parentWorktreeId}-other` };
  assert.notEqual(ledgerPaths(elsewhere, fx.state).log, fx.paths.log);
  const collected = await collectRounds({ runtime: fx.runtime, location: elsewhere, stateRoot: fx.state });
  assert.deepEqual(collected.rounds, []);
  assert.match(collected.screen, /no dispatch rounds recorded for this parent/);
  // An integrate from the wrong parent cannot see the round either, and writes nothing.
  const outcome = await integrateRound({ runtime: fx.runtime, location: elsewhere, roundId, stateRoot: fx.state });
  assert.equal(outcome.status, "failed");
  assert.match(String(outcome.reason), /unknown round/);
  assert.equal(existsSync(ledgerPaths(elsewhere, fx.state).log), false);
});

test("a held round is superseded by a new round, never revived in place", async () => {
  const fx = await fixture({ gates: { schemaVersion: 1, gates: [PASSING_GATE] } });
  const held = await openRound(fx, [{ name: "core", scope: ["src"] }]);
  await markDispatched(fx, held, [], [{ name: "core", message: "orca refused" }]);
  assert.equal(readLedger(fx.location, fx.state).get(held)?.outcome, "held");

  const successor = await openRound(fx, [{ name: "core", scope: ["src"] }], held);
  assert.equal(readLedger(fx.location, fx.state).get(successor)?.supersedes, held);
  await assert.rejects(openRound(fx, [{ name: "core", scope: ["src"] }], "rd-zzz-zzzzzz"), /Cannot supersede unknown round/);

  // Only a held round may be superseded: a merged or open round would reinterpret pinned SHAs.
  await assert.rejects(openRound(fx, [{ name: "core", scope: ["src"] }], successor), /Only a held round can be superseded/);
});

test("crash recovery decides the outcome by ancestry from the recorded candidate", async () => {
  const landed = await fixture({ gates: { schemaVersion: 1, gates: [PASSING_GATE] } });
  const core = await child(landed, "core", { "src/added.ts": "export const added = 1;\n" });
  const landedRound = await openRound(landed, [{ name: "core", scope: ["src"] }]);
  await markDispatched(landed, landedRound, [{ name: "core" }]);
  // The merge landed and only the append was lost: main already contains the candidate.
  await gitIn(landed.repo, ["merge", "--ff-only", core.sha]);
  const candidate = await gitIn(landed.repo, ["rev-parse", "HEAD"]);
  appendFileSync(
    landed.paths.log,
    `${JSON.stringify({
      kind: "attempt",
      roundId: landedRound,
      at: new Date().toISOString(),
      host: "crashed",
      policyDigest: "digest",
      target: "main",
      targetSha: landed.base,
      candidateSha: candidate,
      observed: [{ name: "core", sha: core.sha }],
    })}\n`,
    "utf8",
  );

  const recovered = await integrate(landed, landedRound);
  assert.equal(recovered.status, "merged");
  assert.equal(recovered.recovered, true);
  assert.match(String(recovered.reason), /already contains candidate/);
  assert.deepEqual(recordKinds(landed.paths), ["round", "dispatched", "attempt", "merged"]);
  assert.equal(await gitIn(landed.repo, ["rev-parse", "HEAD"]), candidate);
  // A recovered round is merged, so a rerun is idempotent rather than a second merge.
  const again = await integrate(landed, landedRound);
  assert.equal(again.idempotent, true);

  const lost = await fixture({ gates: { schemaVersion: 1, gates: [PASSING_GATE] } });
  const lostChild = await child(lost, "core", { "src/added.ts": "export const added = 1;\n" });
  const lostRound = await openRound(lost, [{ name: "core", scope: ["src"] }]);
  await markDispatched(lost, lostRound, [{ name: "core" }]);
  appendFileSync(
    lost.paths.log,
    `${JSON.stringify({
      kind: "attempt",
      roundId: lostRound,
      at: new Date().toISOString(),
      host: "crashed",
      policyDigest: "digest",
      target: "main",
      targetSha: lost.base,
      candidateSha: lostChild.sha,
      observed: [{ name: "core", sha: lostChild.sha }],
    })}\n`,
    "utf8",
  );

  const nothingLanded = await integrate(lost, lostRound);
  assert.equal(nothingLanded.status, "held");
  assert.match(String(nothingLanded.reason), /does not contain candidate/);
  assert.equal(await gitIn(lost.repo, ["rev-parse", "HEAD"]), lost.base);
  assert.equal(readLedger(lost.location, lost.state).get(lostRound)?.outcome, "held");
});
