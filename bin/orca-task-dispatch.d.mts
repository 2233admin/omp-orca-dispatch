export type Host = "pi" | "omp";
export type Operation = "install" | "uninstall";
export type CommandAction = { command: string; args: string[] };
export type CommandResult = { code: number; stdout: string; stderr: string };
export type DoctorCheck = {
  name: string;
  required: boolean;
  ok: boolean;
  actual: string;
  requirement: string;
};
export type DoctorReport = {
  ok: boolean;
  host: Host;
  compatibility: typeof COMPATIBILITY;
  checks: DoctorCheck[];
};
export type DoctorDependencies = {
  nodeVersion: string;
  platform: string;
  packageRoot: string;
  run(action: CommandAction): Promise<CommandResult>;
};
export type MainDependencies = Partial<DoctorDependencies> & {
  stdout(value: string): void;
  stderr(value: string): void;
};
export const COMPATIBILITY: Readonly<{
  node: "22.19.0";
  pi: "0.84.4";
  omp: "18.1.8";
  orca: "1.4.195";
  platforms: readonly ["win32", "linux", "darwin"];
}>;
export function parseArguments(argv: string[]): {
  command: Operation | "doctor" | "help" | "version";
  host: Host;
  local: boolean;
  dryRun: boolean;
  json: boolean;
  /** Directory to link instead of resolving the published package; empty when unset. */
  packagePath: string;
};
export function createHostAction(
  operation: Operation,
  host: Host,
  local: boolean,
  /** Verified for `--host omp` only; other hosts reject a directory install. */
  packagePath?: string,
): CommandAction;
export function runDoctor(host: Host, dependencies?: Partial<DoctorDependencies>): Promise<DoctorReport>;
export function main(argv: string[], dependencies?: Partial<MainDependencies>): Promise<number>;
