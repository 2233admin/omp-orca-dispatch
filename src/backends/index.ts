import { gitWorktreeBackend } from "./git-worktree.js";
import { orcaBackend } from "./orca.js";
import type { DispatchBackend, WorktreeBackend } from "./types.js";

/** Every selectable backend, keyed by the public `backend` parameter value. */
export const WORKTREE_BACKENDS: Record<DispatchBackend, WorktreeBackend> = {
  orca: orcaBackend,
  "git-worktree": gitWorktreeBackend,
};

export type { DispatchBackend, WorktreeBackend } from "./types.js";
