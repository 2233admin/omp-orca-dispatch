import type { HostApi, SetupMode, TaskSlice } from "../contracts.js";

/**
 * Selectable worktree backends. `orca` is the default and keeps the original Orca CLI behavior;
 * `git-worktree` needs nothing beyond a git checkout.
 */
export type DispatchBackend = "orca" | "git-worktree";

/** Runtime a backend may use: argv-only exec, the invoking cwd, and the caller abort signal. */
export type BackendRuntime = {
  pi: HostApi;
  cwd: string;
  signal?: AbortSignal;
};

/** Parent repository identity, parent worktree identity, and the exact committed HEAD siblings branch from. */
export type ParentContext = {
  repoId: string;
  worktreeId: string;
  head: string;
};

/** One executable-plus-argv invocation. Backends never build shell command strings. */
export type PlannedCommand = {
  command: string;
  args: string[];
};

/** One validated sibling to create, with its already-built worker prompt. */
export type ChildRequest = {
  name: string;
  prompt: string;
  comment: string;
  agent: string;
  setup: SetupMode;
  slice: TaskSlice;
};

/** What a backend reports after creating one sibling. */
export type CreatedChild = {
  worktreeId: string | null;
  worktreePath: string | null;
  agentTerminalHandle: string | null;
  /** Additive backend-specific fields merged into the per-slice result; never renames Orca fields. */
  extra?: Record<string, unknown>;
};

export type WorktreeBackend = {
  readonly id: DispatchBackend;
  /**
   * Resolve the parent repo identity, parent worktree identity, and exact committed HEAD.
   * Must refuse a dispatcher-created child before any sibling is created, and may run
   * backend-specific preflight over the requested scopes.
   */
  loadContext(runtime: BackendRuntime, slices: TaskSlice[]): Promise<ParentContext>;
  /** Executable-plus-argv plan for one child, in execution order. First entry creates the sibling. */
  planChild(request: ChildRequest, context: ParentContext): PlannedCommand[];
  /** Create exactly one sibling from `context.head`. */
  createChild(request: ChildRequest, context: ParentContext, runtime: BackendRuntime): Promise<CreatedChild>;
};
