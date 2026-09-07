import assert from "node:assert/strict";
import { isAbsolute, join } from "node:path";
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

test("links a checkout directory when --path is given", () => {
  const checkout = fileURLToPath(new URL("..", import.meta.url));

  const parsed = parseArguments(["install", "--path", checkout]);
  assert.equal(parsed.packagePath, checkout);
  assert.equal(parsed.local, false);
  assert.equal(parseArguments(["install", `--path=${checkout}`]).packagePath, checkout);

  // Verified against `omp plugin install <dir>`, which links the directory.
  const action = createHostAction("install", "omp", false, checkout);
  assert.equal(action.command, "omp");
  assert.deepEqual(action.args.slice(0, 2), ["plugin", "install"]);
  assert.ok(isAbsolute(action.args[2] ?? ""), "the directory is resolved to an absolute path");

  // Pi's directory-install syntax is unverified, so a guessed argv is refused.
  assert.throws(() => createHostAction("install", "pi", false, checkout), /only by --host omp/);
  // Uninstall removes by plugin name, so a source path cannot apply even at the argv layer.
  assert.throws(() => createHostAction("uninstall", "omp", false, checkout), /only supported by install/);

  assert.throws(() => parseArguments(["uninstall", "--path", checkout]), /only supported by install/);
  assert.throws(() => parseArguments(["install", "--path", checkout, "--local"]), /mutually exclusive/);
  assert.throws(() => parseArguments(["install", "--path"]), /--path requires a directory/);

  // A path that is not an installable package is refused rather than passed to the host.
  const missing = join(checkout, "does-not-exist-6f3a");
  assert.throws(() => createHostAction("install", "omp", false, missing), /not an installable package/);
});

test("main threads --path through to the host action", async () => {
  const checkout = fileURLToPath(new URL("..", import.meta.url));
  /** @type {string[]} */
  const out: string[] = [];
  const code = await main(["install", "--host", "omp", "--path", checkout, "--dry-run"], {
    stdout: (text: string) => out.push(text),
    stderr: () => {},
  });

  assert.equal(code, 0);
  // The regression this guards: main() previously dropped packagePath, so --path was
  // silently ignored and the npm package name was emitted instead of the directory.
  const emitted = JSON.parse(out.join(""));
  assert.deepEqual(emitted.action.args.slice(0, 2), ["plugin", "install"]);
  assert.ok(isAbsolute(emitted.action.args[2]), "the linked directory reaches the host action");
  assert.ok(!emitted.action.args.some((arg: string) => arg.includes("@0.1.0")), "no package specifier");

  const errors: string[] = [];
  const rejected = await main(["install", "--host", "omp", "--path", join(checkout, "nope-9d2f"), "--dry-run"], {
    stdout: () => {},
    stderr: (text: string) => errors.push(text),
  });
  assert.notEqual(rejected, 0);
  assert.match(errors.join(""), /not an installable package/);
});
test("parses only supported command and flag combinations", () => {
  assert.deepEqual(parseArguments(["install", "--host", "pi", "--local", "--dry-run"]), {
    command: "install",
    host: "pi",
    local: true,
    dryRun: true,
    json: false,
    packagePath: "",
  });
  assert.deepEqual(parseArguments(["doctor", "--host=omp", "--json"]), {
    command: "doctor",
    host: "omp",
    local: false,
    dryRun: false,
    json: true,
    packagePath: "",
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
