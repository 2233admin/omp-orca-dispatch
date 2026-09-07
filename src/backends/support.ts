import type { ExecResult } from "../contracts.js";
import type { BackendRuntime } from "./types.js";

export type JsonObject = Record<string, unknown>;

export const PROBE_TIMEOUT_MS = 30_000;
export const CREATE_TIMEOUT_MS = 120_000;
export const DISPATCH_COMMENT_PREFIX = "Orca task dispatch";

export function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n[truncated by dispatcher]`;
}

export function redact(value: string): string {
  return value.replace(/(https?:\/\/)([^/@\s]+)@/gi, "$1[redacted]@");
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireObject(value: unknown, label: string): JsonObject {
  if (!isObject(value)) throw new Error(`${label} is not a JSON object`);
  return value;
}

function parseJson(raw: string, label: string): JsonObject {
  try {
    return requireObject(JSON.parse(raw), label);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function commandFailure(label: string, execution: ExecResult): Error {
  const output = redact([execution.stderr, execution.stdout].filter(Boolean).join("\n").trim());
  return new Error(`${label} failed with exit code ${execution.code}${output ? `: ${truncate(output, 2_000)}` : ""}`);
}

/** Run one executable-plus-argv command under the caller cwd, abort signal, and a finite timeout. */
export async function execCommand(
  runtime: BackendRuntime,
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number } = {},
): Promise<ExecResult> {
  return runtime.pi.exec(command, args, {
    cwd: options.cwd ?? runtime.cwd,
    ...(runtime.signal ? { signal: runtime.signal } : {}),
    timeout: options.timeout ?? PROBE_TIMEOUT_MS,
  });
}

export async function execJson(
  runtime: BackendRuntime,
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number } = {},
): Promise<JsonObject> {
  const execution = await execCommand(runtime, command, args, options);
  if (execution.code !== 0) throw commandFailure(`${command} ${args.slice(0, 2).join(" ")}`, execution);
  return parseJson(execution.stdout, command);
}

/** Run a command that must succeed and return its trimmed stdout. */
export async function execText(
  runtime: BackendRuntime,
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number } = {},
): Promise<string> {
  const execution = await execCommand(runtime, command, args, options);
  if (execution.code !== 0) throw commandFailure(`${command} ${args.slice(0, 2).join(" ")}`, execution);
  return execution.stdout.trim();
}
