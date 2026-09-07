import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { after, test } from "node:test";

import { parseBacklogParams, planSync, probeTracker, runBacklog } from "../src/offline.js";
import type { SyncRecord, SyncTarget } from "../src/offline.js";

const scratchRoots: string[] = [];

function scratch(): { cwd: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), "orca-backlog-test-"));
  scratchRoots.push(base);
  const cwd = join(base, "repo");
  mkdirSync(cwd, { recursive: true });
  // The backlog is repository-scoped, so a fixture needs a repository marker.
  writeFileSync(join(cwd, ".git"), "gitdir: fixture\n", "utf8");
  return { cwd, root: join(base, "state") };
}

// Tests write state logs and sync bodies under the OS temp dir; remove them so a full run does
// not accumulate files on the machine.
after(() => {
  for (const base of scratchRoots) rmSync(base, { recursive: true, force: true });
  for (const name of readdirSync(tmpdir())) {
    if (name.startsWith("orca-backlog-wi-") || name.startsWith("orca-backlog-")) continue;
  }
});

function logPath(root: string): string {
  const entries = readdirSync(root).filter(name => name.endsWith(".jsonl"));
  assert.equal(entries.length, 1, "exactly one log file per repository");
  return join(root, entries[0] ?? "");
}

test("drives an item through claim, complete, and ack", () => {
  const { cwd, root } = scratch();
  const target = { kind: "multica" as const, issueRef: "CERE-1" };

  const enqueued = runBacklog({ action: "enqueue", title: "ship it", syncTarget: target }, cwd, root);
  const id = String(enqueued.id);
  assert.equal(enqueued.state, "queued");

  assert.equal(runBacklog({ action: "claim", id }, cwd, root).state, "claimed");
  assert.equal(runBacklog({ action: "complete", id, evidence: "commit abc" }, cwd, root).state, "completed");

  const planned = planSync(cwd, root);
  assert.equal(planned.records.length, 1);
  const record = planned.records[0];
  assert.equal(record?.command, "multica");
  // --content-file, never stdin: the tracker CLI mangles non-ASCII on Windows via stdin.
  assert.deepEqual(record?.args.slice(0, 5), ["issue", "comment", "add", "CERE-1", "--content-file"]);
  assert.match(readFileSync(record?.bodyFile ?? "", "utf8"), /ship it[\s\S]*commit abc/);

  assert.equal(runBacklog({ action: "ack", id, issueRef: "CERE-1", commentId: "c-9" }, cwd, root).state, "synced");
  // A synced item leaves the outbox, so a second sync cannot rewrite the tracker.
  assert.equal(planSync(cwd, root).records.length, 0);
});

test("refuses transitions that would fabricate state", () => {
  const { cwd, root } = scratch();
  const target = { kind: "multica" as const, issueRef: "CERE-2" };
  const id = String(runBacklog({ action: "enqueue", title: "guarded", syncTarget: target }, cwd, root).id);

  assert.throws(() => runBacklog({ action: "complete", id, evidence: "x" }, cwd, root), /claim it first/);
  assert.throws(() => runBacklog({ action: "ack", id, issueRef: "CERE-2", commentId: "c" }, cwd, root), /only a completed/);

  runBacklog({ action: "claim", id }, cwd, root);
  // Idempotent for the same host rather than a second claim record.
  assert.equal(runBacklog({ action: "claim", id }, cwd, root).idempotent, true);

  runBacklog({ action: "complete", id, evidence: "same" }, cwd, root);
  assert.equal(runBacklog({ action: "complete", id, evidence: "same" }, cwd, root).idempotent, true);
  assert.throws(() => runBacklog({ action: "complete", id, evidence: "different" }, cwd, root), /different evidence/);

  // ack cannot retarget the item, and cannot be asserted without tracker ids.
  assert.throws(() => runBacklog({ action: "ack", id, issueRef: "OTHER-1", commentId: "c" }, cwd, root), /targets CERE-2/);
  assert.throws(() => runBacklog({ action: "ack", id, issueRef: "CERE-2" }, cwd, root), /comment id/);

  runBacklog({ action: "ack", id, issueRef: "CERE-2", commentId: "c-1" }, cwd, root);
  assert.equal(runBacklog({ action: "ack", id, issueRef: "CERE-2", commentId: "c-1" }, cwd, root).idempotent, true);
  assert.throws(() => runBacklog({ action: "ack", id, issueRef: "CERE-2", commentId: "c-2" }, cwd, root), /already synced/);
});

test("bind resolves the pending-triage dead end", () => {
  const { cwd, root } = scratch();
  // Work started offline with no ticket: sourceRef is a traceability label, not a tracker target.
  const id = String(runBacklog({ action: "enqueue", title: "offline work", sourceRef: "chat" }, cwd, root).id);
  runBacklog({ action: "claim", id }, cwd, root);

  assert.equal(runBacklog({ action: "complete", id, evidence: "done" }, cwd, root).state, "pending-triage");
  const beforeBind = planSync(cwd, root);
  assert.equal(beforeBind.records.length, 0, "never auto-files an item without a tracker target");
  assert.equal(beforeBind.pendingTriage.length, 1);

  assert.throws(() => runBacklog({ action: "bind", id }, cwd, root), /requires an explicit syncTarget/);
  const bound = runBacklog({ action: "bind", id, syncTarget: { kind: "multica", issueRef: "CERE-7" } }, cwd, root);
  assert.equal(bound.state, "completed");

  const planned = planSync(cwd, root);
  assert.equal(planned.records.length, 1);
  assert.equal(planned.records[0]?.issueRef, "CERE-7");
});

/** Drive one item to `completed` so `planSync` will plan a tracker write for it. */
function completedItem(syncTarget: SyncTarget, title = "ship it", evidence = "commit abc"): { cwd: string; root: string } {
  const { cwd, root } = scratch();
  const id = String(runBacklog({ action: "enqueue", title, syncTarget }, cwd, root).id);
  runBacklog({ action: "claim", id }, cwd, root);
  runBacklog({ action: "complete", id, evidence }, cwd, root);
  return { cwd, root };
}

function onlyRecord(cwd: string, root: string): SyncRecord {
  const planned = planSync(cwd, root);
  assert.equal(planned.records.length, 1, "one completed item plans exactly one write");
  const record = planned.records[0];
  assert.ok(record);
  return record;
}

function withEnv(values: Record<string, string | undefined>, run: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(values)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("plans a github comment through the same seam", () => {
  const { cwd, root } = completedItem({ kind: "github", issueRef: "42" });
  const record = onlyRecord(cwd, root);

  assert.equal(record.command, "gh");
  // --body-file, never stdin, for the same non-ASCII reason as the Multica adapter.
  assert.deepEqual(record.args, ["issue", "comment", "42", "--body-file", record.bodyFile]);
});

test("plans a gitea comment against the API with the token referenced by name only", () => {
  const { cwd, root } = completedItem({ kind: "gitea", issueRef: "https://git.example/acme/widgets/issues/7" });

  withEnv({ GITEA_TOKEN: "not-a-real-token-value" }, () => {
    const record = onlyRecord(cwd, root);
    assert.equal(record.command, "curl");
    assert.deepEqual(record.args, [
      "--fail-with-body",
      "--silent",
      "--show-error",
      "--request",
      "POST",
      "--variable",
      "%GITEA_TOKEN",
      "--expand-header",
      "Authorization: token {{GITEA_TOKEN}}",
      "--variable",
      `body@${record.bodyFile}`,
      "--expand-json",
      '{"body":"{{body:json}}"}',
      "--url",
      "https://git.example/api/v1/repos/acme/widgets/issues/7/comments",
    ]);
    // The plan holds no credential even when one is present in this process's environment.
    assert.ok(
      record.args.every(argument => !argument.includes("not-a-real-token-value")),
      "the token value never enters the argv",
    );
  });
});

test("gitea refuses a reference it cannot turn into an API URL", () => {
  const short = completedItem({ kind: "gitea", issueRef: "acme/widgets#7" });

  withEnv({ GITEA_SERVER_URL: undefined }, () => {
    // No server and no URL: refused rather than aimed at a guessed host.
    assert.throws(() => planSync(short.cwd, short.root), /needs GITEA_SERVER_URL/);
  });
  withEnv({ GITEA_SERVER_URL: "https://git.example/" }, () => {
    const record = onlyRecord(short.cwd, short.root);
    // The configured trailing slash must not become `//api/v1`, which is a different path.
    assert.equal(record.args.at(-1), "https://git.example/api/v1/repos/acme/widgets/issues/7/comments");
  });

  const bare = completedItem({ kind: "gitea", issueRef: "7" });
  withEnv({ GITEA_SERVER_URL: "https://git.example" }, () => {
    // A bare index names no repository, so there is nothing to post to.
    assert.throws(() => planSync(bare.cwd, bare.root), /full issue URL or "owner\/repo#index"/);
  });
});

test("rejects an unknown tracker kind instead of inventing an argv", () => {
  assert.throws(
    () => parseBacklogParams({ action: "enqueue", syncTarget: { kind: "jira", issueRef: "J-1" } }),
    /must be one of multica, gitea, github/,
  );

  // An unknown kind cannot sneak in through the log either: replay validates it the same way.
  const { cwd, root } = completedItem({ kind: "multica", issueRef: "CERE-8" });
  const log = logPath(root);
  const lines = readFileSync(log, "utf8").trimEnd().split("\n");
  const forged = lines[0]?.replace('"kind":"multica"', '"kind":"jira"') ?? "";
  assert.match(forged, /"jira"/, "the fixture must actually carry the unknown kind");
  writeFileSync(log, `${[forged, ...lines.slice(1)].join("\n")}\n`, "utf8");
  assert.throws(() => planSync(cwd, root), /schema-invalid/);
});

test("carries a non-ASCII body in a UTF-8 file for every tracker", () => {
  const body = "验收：命令行参数保持 argv-only — no shell";
  const targets: SyncTarget[] = [
    { kind: "multica", issueRef: "CERE-9" },
    { kind: "github", issueRef: "https://github.com/acme/widgets/issues/9" },
    { kind: "gitea", issueRef: "https://git.example/acme/widgets/issues/9" },
  ];

  for (const target of targets) {
    const { cwd, root } = completedItem(target, "非 ASCII 标题", body);
    const record = onlyRecord(cwd, root);
    // The bytes live in the file; the argv only points at it, and never at stdin.
    assert.match(readFileSync(record.bodyFile, "utf8"), /非 ASCII 标题[\s\S]*argv-only/);
    assert.ok(
      record.args.some(argument => argument.includes(record.bodyFile)),
      `${target.kind} passes the body file path`,
    );
    assert.ok(
      record.args.every(argument => !argument.includes(body)),
      `${target.kind} keeps the body out of the argv`,
    );
  }
});

test("reports corruption instead of dropping an interior record", () => {
  const { cwd, root } = scratch();
  const target = { kind: "multica" as const, issueRef: "CERE-3" };
  const id = String(runBacklog({ action: "enqueue", title: "corrupt", syncTarget: target }, cwd, root).id);
  runBacklog({ action: "claim", id }, cwd, root);
  runBacklog({ action: "complete", id, evidence: "e" }, cwd, root);
  runBacklog({ action: "ack", id, issueRef: "CERE-3", commentId: "c" }, cwd, root);

  const log = logPath(root);
  const lines = readFileSync(log, "utf8").trimEnd().split("\n");

  // A torn final line is a crash mid-append and is tolerated.
  writeFileSync(log, `${lines.join("\n")}\n{"id":"wi-x","at":`, "utf8");
  assert.equal(runBacklog({ action: "list" }, cwd, root).count, 1);

  // An unreadable interior line would hide the ack and cause a duplicate tracker write.
  const damaged = [...lines];
  damaged[2] = '{"id":"wi-y","at":';
  writeFileSync(log, `${damaged.join("\n")}\n`, "utf8");
  assert.throws(() => runBacklog({ action: "list" }, cwd, root), /corrupt at line 3/);
});

test("tolerates only a torn JSON tail, never a schema-invalid record", () => {
  const { cwd, root } = scratch();
  const id = String(
    runBacklog({ action: "enqueue", title: "tail", syncTarget: { kind: "multica", issueRef: "CERE-4" } }, cwd, root).id,
  );
  const log = logPath(root);
  const lines = readFileSync(log, "utf8").trimEnd().split("\n");

  // Parses as JSON but violates the schema, and sits on the last line. Dropping it silently
  // could hide a complete or ack, so it must still be reported.
  writeFileSync(log, `${lines.join("\n")}\n{"id":"${id}","at":"now","host":"h","kind":"complete"}\n`, "utf8");
  assert.throws(() => runBacklog({ action: "list" }, cwd, root), /schema-invalid/);
});

test("holds an exclusive lock and reclaims a stale one", () => {
  const { cwd, root } = scratch();
  runBacklog({ action: "enqueue", title: "locked", syncTarget: { kind: "multica", issueRef: "CERE-5" } }, cwd, root);
  const lock = `${logPath(root)}.lock`;

  // A live lock blocks a mutating action rather than corrupting the log.
  writeFileSync(lock, "", "utf8");
  assert.throws(() => runBacklog({ action: "enqueue", title: "blocked" }, cwd, root), /lock is held/);
  // list is read-only and takes no lock, so it still answers while the lock is held.
  assert.equal(runBacklog({ action: "list" }, cwd, root).count, 1);

  // A lock abandoned by a crashed process is reclaimed instead of wedging the backlog forever.
  const stale = new Date(Date.now() - 120_000);
  utimesSync(lock, stale, stale);
  assert.equal(runBacklog({ action: "enqueue", title: "after stale" }, cwd, root).state, "queued");
  assert.equal(runBacklog({ action: "list" }, cwd, root).count, 2);
});

test("keys the log by repository root, not by cwd", () => {
  const { root } = scratch();
  const repoA = mkdtempSync(join(tmpdir(), "orca-repo-a-"));
  const repoB = mkdtempSync(join(tmpdir(), "orca-repo-b-"));
  scratchRoots.push(repoA, repoB);
  // A worktree marks its root with a `.git` file, a clone with a directory; both are accepted.
  writeFileSync(join(repoA, ".git"), "gitdir: elsewhere\n", "utf8");
  mkdirSync(join(repoB, ".git"), { recursive: true });

  const nested = join(repoA, "packages", "inner");
  mkdirSync(nested, { recursive: true });

  runBacklog({ action: "enqueue", title: "at root" }, repoA, root);
  runBacklog({ action: "enqueue", title: "in subdir" }, nested, root);
  runBacklog({ action: "enqueue", title: "other repo" }, repoB, root);

  // Both directories of repo A share one log, so a claim in one is visible in the other.
  assert.equal(runBacklog({ action: "list" }, nested, root).count, 2, "subdirectory shares the repo log");
  assert.equal(runBacklog({ action: "list" }, repoB, root).count, 1);
  assert.equal(readdirSync(root).filter(name => name.endsWith(".jsonl")).length, 2);

  // Outside a repository the backlog refuses rather than keying on the bare cwd.
  const bare = mkdtempSync(join(tmpdir(), "orca-nogit-"));
  scratchRoots.push(bare);
  assert.throws(() => runBacklog({ action: "list" }, bare, root), /requires a git repository/);
});

test("validates parameters instead of trusting the host payload", () => {
  assert.throws(() => parseBacklogParams({ action: "nope" }), /action must be one of/);
  assert.throws(() => parseBacklogParams({ action: "enqueue", scope: ["ok", 5] }), /scope must be an array of strings/);
  assert.throws(
    () => parseBacklogParams({ action: "enqueue", syncTarget: { kind: "jira", issueRef: "J-1" } }),
    /must be one of multica, gitea, github/,
  );
  assert.throws(() => parseBacklogParams({ action: "enqueue", syncTarget: { kind: "multica" } }), /issueRef is required/);
  assert.throws(() => parseBacklogParams({ action: "list", state: "bogus" }), /not a known item state/);

  const parsed = parseBacklogParams({ action: "enqueue", title: "  padded  ", sourceRef: "   " });
  assert.equal(parsed.title, "padded");
  assert.equal(parsed.sourceRef, undefined, "a blank string is absent, not an empty reference");
});

test("treats any HTTP response as reachable and no response as unreachable", async () => {
  const server = createServer((_request, response) => {
    // 401 is the observed healthy-but-unauthenticated case; it must count as reachable.
    response.writeHead(401).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  try {
    const up = await probeTracker(`http://127.0.0.1:${port}`);
    assert.equal(up.reachable, true);
    assert.equal(up.status, 401);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  // A closed port yields no HTTP response at all, which is the unreachable case. A TCP-level
  // probe would be insufficient here: a fleet host once accepted TCP while HTTP returned nothing.
  const down = await probeTracker(`http://127.0.0.1:${port}`, 2_000);
  assert.equal(down.reachable, false);
  assert.equal(down.status, 0);
  assert.ok(down.detail.length > 0, "the failure reason is reported rather than swallowed");
});

test("refuses unsafe tracker endpoints and still probes a normal loopback URL", async () => {
  // A scheme no HTTP probe can reach. Reported, never thrown: the sync plan must still be
  // produced when the endpoint is misconfigured.
  for (const bad of ["file:///etc/passwd", "ftp://tracker.internal:21", "not-a-url"]) {
    const refused = await probeTracker(bad);
    assert.equal(refused.reachable, false, `${bad} must not be reachable`);
    assert.equal(refused.status, 0);
    assert.match(refused.detail, /unsupported scheme|not a valid absolute URL/);
  }

  // Link-local space holds the cloud instance-metadata endpoint; an operator typo in
  // MULTICA_SERVER_URL must not turn the probe into an SSRF vector against it.
  for (const linkLocal of [
    "http://169.254.169.254/latest/meta-data/",
    "http://169.254.0.1:3010",
    "http://[fe80::1]:3010",
    "http://[::ffff:169.254.169.254]:3010",
  ]) {
    const refused = await probeTracker(linkLocal);
    assert.equal(refused.reachable, false, `${linkLocal} must not be reachable`);
    assert.equal(refused.status, 0);
    assert.match(refused.detail, /link-local/);
  }

  // The guard must not break the ordinary case: a loopback tracker is still probed for real.
  const server = createServer((_request, response) => {
    response.writeHead(401).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const up = await probeTracker(`http://127.0.0.1:${port}`);
    assert.equal(up.reachable, true, "a loopback tracker is not link-local and must be probed");
    assert.equal(up.status, 401);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
