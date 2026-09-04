#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const packageMetadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));

export const COMPATIBILITY = Object.freeze({
  node: "22.19.0",
  pi: "0.84.4",
  omp: "18.1.8",
  orca: "1.4.195",
  platforms: Object.freeze(["win32", "linux", "darwin"]),
});

const HELP = `orca-task-dispatch ${packageMetadata.version}

Usage:
  orca-task-dispatch install [--host pi|omp] [--local] [--dry-run]
  orca-task-dispatch uninstall [--host pi|omp] [--local] [--dry-run]
  orca-task-dispatch doctor [--host pi|omp] [--json]
  orca-task-dispatch help
  orca-task-dispatch version

Options:
  --host pi|omp  Select the host; defaults to omp
  --local        Use the host's project-local install or uninstall mode
  --dry-run      Print the exact executable and argv without running it
  --json         Emit machine-readable doctor output
`;

/** @param {string[]} argv */
export function parseArguments(argv) {
  const normalized = [...argv];
  let command = normalized.shift() ?? "help";
  if (command === "--help" || command === "-h") command = "help";
  if (command === "--version" || command === "-v") command = "version";
  if (!new Set(["install", "uninstall", "doctor", "help", "version"]).has(command)) {
    throw new Error(`Unknown command: ${command}`);
  }

  let host = "omp";
  let local = false;
  let dryRun = false;
  let json = false;
  while (normalized.length > 0) {
    const flag = normalized.shift();
    if (flag === "--host") {
      const value = normalized.shift();
      if (!value) throw new Error("--host requires pi or omp");
      host = value;
    } else if (flag?.startsWith("--host=")) {
      host = flag.slice("--host=".length);
    } else if (flag === "--local") {
      local = true;
    } else if (flag === "--dry-run") {
      dryRun = true;
    } else if (flag === "--json") {
      json = true;
    } else {
      throw new Error(`Unknown option: ${flag ?? ""}`);
    }
  }

  if (host !== "pi" && host !== "omp") throw new Error("--host must be pi or omp");
  if ((command === "help" || command === "version") && (local || dryRun || json || host !== "omp")) {
    throw new Error(`${command} does not accept host or action flags`);
  }
  if (command === "doctor" && local) throw new Error("--local is only supported by install and uninstall");
  if (command === "doctor" && dryRun) throw new Error("--dry-run is only supported by install and uninstall");
  if ((command === "install" || command === "uninstall") && json) {
    throw new Error("--json is only supported by doctor");
  }

  return { command, host, local, dryRun, json };
}

/**
 * @param {"install" | "uninstall"} operation
 * @param {"pi" | "omp"} host
 * @param {boolean} local
 */
export function createHostAction(operation, host, local) {
  const versioned = `${packageMetadata.name}@${packageMetadata.version}`;
  if (host === "pi") {
    return {
      command: "pi",
      args: [operation === "install" ? "install" : "remove", `npm:${versioned}`, ...(local ? ["--local"] : [])],
    };
  }
  return {
    command: "omp",
    args: ["plugin", operation === "install" ? "install" : "uninstall", operation === "install" ? versioned : packageMetadata.name, ...(local ? ["--local"] : [])],
  };
}

/** @param {string} version */
function versionTuple(version) {
  const match = version.match(/(?:^|[^0-9])(\d+)\.(\d+)\.(\d+)(?:[^0-9]|$)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** @param {string} actual @param {string} minimum */
function meetsMinimum(actual, minimum) {
  const left = versionTuple(actual);
  const right = versionTuple(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return true;
    if (left[index] < right[index]) return false;
  }
  return true;
}

/** @param {string} path */
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} executable @param {string} platform */
async function findOnPath(executable, platform) {
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const extensions = platform === "win32" ? [".exe", ".com", ".cmd", ".bat"] : [""];
  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = join(directory, `${executable}${extension}`);
      if (await exists(candidate)) return candidate;
    }
  }
  return null;
}
/** @param {{ command: string; args: string[] }} action @param {string} platform */
async function executableAction(action, platform = process.platform) {
  const override = process.env[`ORCA_TASK_DISPATCH_${action.command.toUpperCase()}_COMMAND`];
  const selected = override || (await findOnPath(action.command, platform)) || action.command;
  if (platform === "win32" && action.command === "pi") {
    const base = dirname(selected);
    const candidates = [
      join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
      join(base, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
      join(base, "..", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
    ];
    for (const candidate of candidates) {
      if (await exists(candidate)) return { command: process.execPath, args: [candidate, ...action.args] };
    }
  }
  if (platform !== "win32" || !selected.toLowerCase().endsWith(".cmd")) {
    return { command: selected, args: action.args };
  }
  throw new Error(`Cannot execute Windows command shim without a shell: ${selected}. Set ORCA_TASK_DISPATCH_${action.command.toUpperCase()}_COMMAND to a native executable.`);
}

/** @param {{ command: string; args: string[] }} action */
async function defaultRun(action) {
  const executable = await executableAction(action);
  const { promise, resolve } = Promise.withResolvers();
  const child = spawn(executable.command, executable.args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.on("error", (error) => resolve({ code: 127, stdout: Buffer.concat(stdout).toString("utf8"), stderr: error.message }));
  child.on("close", (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
  return promise;
}

/**
 * @param {"pi" | "omp"} host
 * @param {Partial<import("./orca-task-dispatch.d.mts").DoctorDependencies>} dependencies
 */
export async function runDoctor(host, dependencies = {}) {
  const nodeVersion = dependencies.nodeVersion ?? process.version;
  const platform = dependencies.platform ?? process.platform;
  const root = dependencies.packageRoot ?? packageRoot;
  const run = dependencies.run ?? defaultRun;
  const checks = [];
  checks.push({ name: "Platform", required: true, ok: COMPATIBILITY.platforms.includes(platform), actual: platform, requirement: COMPATIBILITY.platforms.join(", ") });
  checks.push({ name: "Node.js", required: true, ok: meetsMinimum(nodeVersion, COMPATIBILITY.node), actual: nodeVersion, requirement: `>=${COMPATIBILITY.node}` });
  const entrypoint = join(root, "extensions", `${host}.ts`);
  checks.push({ name: `${host.toUpperCase()} entrypoint`, required: true, ok: await exists(entrypoint), actual: entrypoint, requirement: "readable package entrypoint" });

  const hostAction = { command: host, args: ["--version"] };
  const hostResult = await run(hostAction);
  const hostMinimum = COMPATIBILITY[host];
  const hostActual = `${hostResult.stdout}\n${hostResult.stderr}`.trim();
  checks.push({ name: host === "pi" ? "Pi" : "OMP", required: true, ok: hostResult.code === 0 && meetsMinimum(hostActual, hostMinimum), actual: hostActual || `exit ${hostResult.code}`, requirement: `>=${hostMinimum}` });

  const orcaResult = await run({ command: "orca", args: ["status", "--json"] });
  let orcaVersion = "unavailable";
  let orcaReady = false;
  if (orcaResult.code === 0) {
    try {
      const status = JSON.parse(orcaResult.stdout);
      const runtime = status?.result?.runtime;
      orcaVersion = typeof runtime?.appVersion === "string" ? runtime.appVersion : "unavailable";
      orcaReady = status?.ok === true && runtime?.state === "ready" && runtime?.reachable === true;
    } catch {
      orcaVersion = "invalid JSON";
    }
  }
  checks.push({ name: "Orca", required: true, ok: orcaResult.code === 0 && orcaReady && meetsMinimum(orcaVersion, COMPATIBILITY.orca), actual: orcaVersion, requirement: `>=${COMPATIBILITY.orca}, ready and reachable` });
  return { ok: checks.every((check) => !check.required || check.ok), host, compatibility: COMPATIBILITY, checks };
}

/** @param {ReturnType<typeof runDoctor> extends Promise<infer T> ? T : never} report */
function formatDoctor(report) {
  const lines = report.checks.map((check) => `${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.actual} (${check.requirement})`);
  return `${lines.join("\n")}\n\n${report.ok ? "Doctor passed." : "Doctor failed required checks."}\n`;
}

/**
 * @param {string[]} argv
 * @param {Partial<import("./orca-task-dispatch.d.mts").MainDependencies>} dependencies
 */
export async function main(argv, dependencies = {}) {
  const stdout = dependencies.stdout ?? ((value) => process.stdout.write(value));
  const stderr = dependencies.stderr ?? ((value) => process.stderr.write(value));
  try {
    const options = parseArguments(argv);
    if (options.command === "help") {
      stdout(HELP);
      return 0;
    }
    if (options.command === "version") {
      stdout(`${packageMetadata.version}\n`);
      return 0;
    }
    if (options.command === "doctor") {
      const report = await runDoctor(options.host, dependencies);
      stdout(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctor(report));
      return report.ok ? 0 : 1;
    }

    const action = createHostAction(options.command, options.host, options.local);
    if (options.dryRun) {
      stdout(`${JSON.stringify({ dryRun: true, host: options.host, action }, null, 2)}\n`);
      return 0;
    }
    const result = await (dependencies.run ?? defaultRun)(action);
    if (result.stdout) stdout(result.stdout);
    if (result.stderr) stderr(result.stderr);
    return result.code === 0 ? 0 : result.code;
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
