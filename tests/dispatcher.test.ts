import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExecOptions, ExecResult, HostApi, TaskDispatchParams, ToolDefinition } from "../src/contracts.js";
import {
  buildSlicePrompt,
  redact,
  registerOrcaTaskDispatch,
  safeWorktreeName,
  validateTaskDispatch,
} from "../src/dispatcher.js";

function params(overrides: Partial<TaskDispatchParams> = {}): TaskDispatchParams {
  return {
    task: "Ship the portable dispatcher",
    slices: [
      { name: "core", task: "Implement core", scope: ["src"] },
      { name: "docs", task: "Write docs", scope: ["README.md", "docs"] },
    ],
    ...overrides,
  };
}

function registeredTool(exec: HostApi["exec"]): ToolDefinition {
  let definition: ToolDefinition | undefined;
  registerOrcaTaskDispatch(
    {
      exec,
      registerTool(tool) {
        definition = tool;
      },
    },
    { type: "object" },
  );
  assert.ok(definition);
  return definition;
}

test("validates the two-to-three slice boundary", () => {
  assert.throws(() => validateTaskDispatch(params({ slices: [] })), /2 or 3/);
  assert.doesNotThrow(() => validateTaskDispatch(params()));
  assert.doesNotThrow(() =>
    validateTaskDispatch(
      params({
        slices: [
          { name: "a", task: "A", scope: ["a"] },
          { name: "b", task: "B", scope: ["b"] },
          { name: "c", task: "C", scope: ["c"] },
        ],
      }),
    ),
  );
  assert.throws(
    () =>
      validateTaskDispatch(
        params({
          slices: [
            { name: "a", task: "A", scope: ["a"] },
            { name: "b", task: "B", scope: ["b"] },
            { name: "c", task: "C", scope: ["c"] },
            { name: "d", task: "D", scope: ["d"] },
          ],
        }),
      ),
    /2 or 3/,
  );
});

test("normalizes names before duplicate detection", () => {
  assert.equal(safeWorktreeName("  docs & API  "), "docs-API");
  assert.throws(
    () =>
      validateTaskDispatch(
        params({
          slices: [
            { name: "Docs API", task: "A", scope: ["a"] },
            { name: "docs-api", task: "B", scope: ["b"] },
          ],
        }),
      ),
    /Duplicate normalized slice name/,
  );
});

test("rejects overlapping and unsafe literal scopes portably", () => {
  assert.throws(
    () =>
      validateTaskDispatch(
        params({
          slices: [
            { name: "one", task: "A", scope: ["src/API"] },
            { name: "two", task: "B", scope: ["src/api/client.ts"] },
          ],
        }),
      ),
    /overlap/,
  );

  const deduplicated = validateTaskDispatch(
    params({
      slices: [
        { name: "one", task: "A", scope: ["docs/café", "DOCS/cafe\u0301"] },
        { name: "two", task: "B", scope: ["other"] },
      ],
    }),
  );
  assert.deepEqual(deduplicated.slices.at(0)?.scope, ["docs/café"]);

  assert.throws(
    () =>
      validateTaskDispatch(
        params({
          slices: [
            { name: "composed", task: "A", scope: ["docs/café"] },
            { name: "decomposed", task: "B", scope: ["docs/cafe\u0301/guide.md"] },
          ],
        }),
      ),
    /overlap/,
  );

  for (const unsafe of [".", "../outside", "/absolute", "C:\\repo", ".git/config", "src/*.ts", "src/../../escape"]) {
    assert.throws(
      () =>
        validateTaskDispatch(
          params({
            slices: [
              { name: "one", task: "A", scope: [unsafe] },
              { name: "two", task: "B", scope: ["safe"] },
            ],
          }),
        ),
      /scope|repository-relative|literal path/,
      unsafe,
    );
  }

  for (const codePoint of [...Array(32).keys(), 0x7f]) {
    const unsafe = `src/control-${String.fromCodePoint(codePoint)}segment`;
    assert.throws(
      () =>
        validateTaskDispatch(
          params({
            slices: [
              { name: "one", task: "A", scope: [unsafe] },
              { name: "two", task: "B", scope: ["safe"] },
            ],
          }),
        ),
      /control characters/,
      `U+${codePoint.toString(16).padStart(4, "0")}`,
    );
  }
});

test("rejects unsafe agent selectors", () => {
  assert.throws(() => validateTaskDispatch(params({ agent: "omp; rm -rf" })), /agent must be/);
  assert.equal(validateTaskDispatch(params({ agent: "omp.worker-1" })).agent, "omp.worker-1");
});

test("worker prompt preserves trust, ownership, and recursion boundaries", () => {
  const prompt = buildSlicePrompt(
    "Parent requirement",
    "https://tracker.example/T-42",
    { name: "core", task: "Implement core", scope: ["src"] },
    0,
    2,
  );
  assert.match(prompt, /untrusted project data/);
  assert.match(prompt, /Edit only the exclusive scope/);
  assert.match(prompt, /Never create or dispatch another worktree/);
  assert.match(prompt, /Do not push, merge, rebase/);
  assert.match(prompt, /Commit the finished slice/);
});

test("dispatches concurrently from one exact HEAD while returning stable slice order", async () => {
  const calls: Array<{ command: string; args: string[]; options?: ExecOptions }> = [];
  let activeCreates = 0;
  let peakCreates = 0;
  const allStarted = Promise.withResolvers<void>();
  const releases = new Map<string, () => void>();
  const exec = async (command: string, args: string[], options?: ExecOptions): Promise<ExecResult> => {
    calls.push({ command, args, ...(options ? { options } : {}) });
    if (args[0] === "status") {
      return { code: 0, stdout: JSON.stringify({ ok: true, result: { runtime: { state: "ready", reachable: true } } }), stderr: "" };
    }
    if (args[1] === "current") {
      return {
        code: 0,
        stdout: JSON.stringify({ ok: true, result: { worktree: { repoId: "repo-1", id: "parent-1", head: "abc123", comment: "" } } }),
        stderr: "",
      };
    }
    activeCreates += 1;
    peakCreates = Math.max(peakCreates, activeCreates);
    const name = args[args.indexOf("--name") + 1];
    assert.ok(name);
    const release = Promise.withResolvers<void>();
    releases.set(name, release.resolve);
    if (activeCreates === 2) allStarted.resolve();
    await release.promise;
    activeCreates -= 1;
    return {
      code: 0,
      stdout: JSON.stringify({ ok: true, result: { worktree: { id: "id-" + name, path: "/tmp/" + name } } }),
      stderr: "",
    };
  };

  const sourceRef = "https://tracker.example/T-42";
  const pendingOutput = registeredTool(exec).execute("call", params({ sourceRef }), undefined, undefined, { cwd: "/repo" });
  await allStarted.promise;
  releases.get("docs")?.();
  await Promise.resolve();
  releases.get("core")?.();
  const output = await pendingOutput;
  assert.equal(output.details.status, "dispatched");
  assert.equal(output.details.sourceRef, sourceRef);
  assert.deepEqual(
    (output.details.slices as Array<{ name: string }>).map((slice) => slice.name),
    ["core", "docs"],
  );
  assert.equal(peakCreates, 2);
  const creates = calls.filter((call) => call.args[0] === "worktree" && call.args[1] === "create");
  assert.equal(creates.length, 2);
  for (const call of creates) {
    assert.equal(call.args[call.args.indexOf("--base-branch") + 1], "abc123");
    assert.equal(call.args[call.args.indexOf("--parent-worktree") + 1], "id:parent-1");
    assert.match(String(call.args[call.args.indexOf("--comment") + 1]), /tracker\.example\/T-42/);
  }
});

test("reports partial failures without leaking URL credentials", async () => {
  const exec = async (_command: string, args: string[]): Promise<ExecResult> => {
    if (args[0] === "status") {
      return { code: 0, stdout: JSON.stringify({ ok: true, result: { runtime: { state: "ready", reachable: true } } }), stderr: "" };
    }
    if (args[1] === "current") {
      return {
        code: 0,
        stdout: JSON.stringify({ ok: true, result: { worktree: { repoId: "repo", id: "parent", head: "deadbeef" } } }),
        stderr: "",
      };
    }
    const name = args[args.indexOf("--name") + 1];
    return name === "docs"
      ? { code: 1, stdout: "", stderr: "clone https://user:secret@example.invalid/repo failed" }
      : { code: 0, stdout: JSON.stringify({ ok: true, result: { worktreeId: "created" } }), stderr: "" };
  };

  const output = await registeredTool(exec).execute("call", params(), undefined, undefined, { cwd: "/repo" });
  assert.equal(output.details.status, "partial");
  assert.equal(output.details.succeeded, 1);
  assert.equal(output.details.failed, 1);
  assert.equal(JSON.stringify(output.details).includes("user:secret"), false);
  assert.match(JSON.stringify(output.details), /\[redacted\]/);
  assert.equal(redact("https://token@example.invalid/path"), "https://[redacted]@example.invalid/path");
});

test("refuses recursive dispatch before creating children", async () => {
  let createCalls = 0;
  const exec = async (_command: string, args: string[]): Promise<ExecResult> => {
    if (args[0] === "status") {
      return { code: 0, stdout: JSON.stringify({ ok: true, result: { runtime: { state: "ready", reachable: true } } }), stderr: "" };
    }
    if (args[1] === "current") {
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          result: { worktree: { repoId: "repo", id: "child", head: "abc", comment: "Orca task dispatch | slice 1/2" } },
        }),
        stderr: "",
      };
    }
    createCalls += 1;
    return { code: 0, stdout: "{}", stderr: "" };
  };

  const output = await registeredTool(exec).execute("call", params(), undefined, undefined, { cwd: "/repo" });
  assert.equal(output.details.status, "failed");
  assert.match(String(output.details.message), /Refusing recursive dispatch/);
  assert.equal(createCalls, 0);
});
