import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  COMPATIBILITY,
  createHostAction,
  main,
  parseArguments,
  runDoctor,
  type CommandAction,
  type DoctorDependencies,
} from "../bin/orca-task-dispatch.mjs";

const cli = fileURLToPath(new URL("../bin/orca-task-dispatch.mjs", import.meta.url));

test("declares Node, Pi, OMP, Orca, and supported OS compatibility", () => {
  assert.deepEqual(COMPATIBILITY, {
    node: "22.19.0",
    pi: "0.84.4",
    omp: "18.1.8",
    orca: "1.4.195",
    platforms: ["win32", "linux", "darwin"],
  });
});

test("builds official host commands as argv arrays with local behavior", () => {
  assert.deepEqual(createHostAction("install", "pi", true), {
    command: "pi",
    args: ["install", "npm:omp-orca-dispatch@0.1.0", "--local"],
  });
  assert.deepEqual(createHostAction("uninstall", "pi", false), {
    command: "pi",
    args: ["remove", "npm:omp-orca-dispatch@0.1.0"],
  });
  assert.deepEqual(createHostAction("install", "omp", true), {
    command: "omp",
    args: ["plugin", "install", "omp-orca-dispatch@0.1.0", "--local"],
  });
  assert.deepEqual(createHostAction("uninstall", "omp", false), {
    command: "omp",
    args: ["plugin", "uninstall", "omp-orca-dispatch"],
  });
});

test("parses only supported command and flag combinations", () => {
  assert.deepEqual(parseArguments(["install", "--host", "pi", "--local", "--dry-run"]), {
    command: "install",
    host: "pi",
    local: true,
    dryRun: true,
    json: false,
  });
  assert.deepEqual(parseArguments(["doctor", "--host=omp", "--json"]), {
    command: "doctor",
    host: "omp",
    local: false,
    dryRun: false,
    json: true,
  });
  assert.throws(() => parseArguments(["doctor", "--local"]), /--local/);
  assert.throws(() => parseArguments(["install", "--json"]), /--json/);
  assert.throws(() => parseArguments(["install", "--host", "other"]), /pi or omp/);
});

test("doctor reports every required check and fails when one fails", async () => {
  const actions: CommandAction[] = [];
  const deps: DoctorDependencies = {
    nodeVersion: "v22.19.0",
    platform: "linux",
    packageRoot: fileURLToPath(new URL("..", import.meta.url)),
    async run(action) {
      actions.push(action);
      if (action.command === "omp") return { code: 0, stdout: "omp/18.1.8", stderr: "" };
      return {
        code: 0,
        stdout: JSON.stringify({ ok: true, result: { runtime: { state: "ready", reachable: true, appVersion: "1.4.194" } } }),
        stderr: "",
      };
    },
  };
  const report = await runDoctor("omp", deps);
  assert.equal(report.ok, false);
  assert.equal(report.checks.every((check) => check.required), true);
  assert.equal(report.checks.find((check) => check.name === "Orca")?.ok, false);
  assert.deepEqual(actions, [
    { command: "omp", args: ["--version"] },
    { command: "orca", args: ["status", "--json"] },
  ]);

  let stdout = "";
  let stderr = "";
  const exitCode = await main(["doctor", "--host", "omp", "--json"], {
    ...deps,
    stdout: (value) => {
      stdout += value;
    },
    stderr: (value) => {
      stderr += value;
    },
  });
  assert.equal(exitCode, 1);
  assert.equal(stderr, "");
  assert.equal(JSON.parse(stdout).ok, false);
});

test("help, version, and dry-run execute without host side effects", () => {
  for (const args of [["help"], ["--help"], ["version"], ["--version"]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.trim());
  }

  const dryRun = spawnSync(
    process.execPath,
    [cli, "install", "--host", "omp", "--local", "--dry-run"],
    { encoding: "utf8" },
  );
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const action = JSON.parse(dryRun.stdout) as { dryRun: boolean; action: CommandAction };
  assert.equal(action.dryRun, true);
  assert.deepEqual(action.action.args, ["plugin", "install", "omp-orca-dispatch@0.1.0", "--local"]);
});
