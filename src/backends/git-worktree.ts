import { posix as posixPath } from "node:path";

import type { TaskSlice } from "../contracts.js";
import { CREATE_TIMEOUT_MS, commandFailure, execCommand, execText } from "./support.js";
import type {
  BackendRuntime,
  ChildRequest,
  CreatedChild,
  ParentContext,
  PlannedCommand,
  WorktreeBackend,
} from "./types.js";

const GIT = "git";

/**
 * Recursion marker for plain git. `refs/worktree/*` is per-worktree (git-worktree(1) "REFDIR"),
 * so this ref exists only inside the dispatcher-created child, is invisible to `git status`, and
 * can never be committed or pushed by the worker. If an older git treated it as a shared ref the
 * guard would fail closed by refusing the parent too, never by allowing recursion.
 */
const CHILD_MARKER_REF = "refs/worktree/orca-dispatch-child";

/** Directory holding all siblings, itself a sibling of the parent worktree root. */
function siblingRoot(worktreeRoot: string): string {
  return `${posixPath.dirname(worktreeRoot)}/${posixPath.basename(worktreeRoot)}-worktrees`;
}

function childPath(context: ParentContext, name: string): string {
  return `${siblingRoot(context.worktreeId)}/${name}`;
}

async function loadContext(runtime: BackendRuntime, slices: TaskSlice[]): Promise<ParentContext> {
  const worktreeRoot = (await execText(runtime, GIT, ["rev-parse", "--show-toplevel"])).replaceAll("\\", "/").replace(/\/+$/, "");
  if (!worktreeRoot) throw new Error("git did not report a worktree root for the invoking directory");

  const marker = await execCommand(runtime, GIT, ["rev-parse", "--verify", "--quiet", CHILD_MARKER_REF]);
  if (marker.code === 0) {
    throw new Error("Refusing recursive dispatch from a dispatcher-created worktree");
  }

  const repoId = (await execText(runtime, GIT, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))
    .replaceAll("\\", "/")
    .replace(/\/+$/, "");
  const head = await execText(runtime, GIT, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!repoId || !head) throw new Error("git did not report a repository directory and a committed HEAD");

  // Siblings branch from the committed HEAD, so anything uncommitted in a slice scope - staged,
  // unstaged, or untracked - would be silently excluded from that worker's checkout.
  for (const slice of slices) {
    const status = await execCommand(runtime, GIT, ["--literal-pathspecs", "status", "--porcelain", "--", ...slice.scope], {
      cwd: worktreeRoot,
    });
    if (status.code !== 0) throw commandFailure("git status", status);
    const dirty = status.stdout
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean);
    if (dirty.length > 0) {
      throw new Error(
        `Refusing to dispatch: slice ${slice.name} scope has uncommitted changes (${dirty.length} path(s), first: ${dirty[0]}). Commit or stash them, because siblings branch from the committed HEAD.`,
      );
    }
  }

  return { repoId, worktreeId: worktreeRoot, head };
}

function planChild(request: ChildRequest, context: ParentContext): PlannedCommand[] {
  const path = childPath(context, request.name);
  return [
    { command: GIT, args: ["worktree", "add", "-b", request.name, path, context.head] },
    { command: GIT, args: ["update-ref", CHILD_MARKER_REF, context.head] },
  ];
}

async function createChild(
  request: ChildRequest,
  context: ParentContext,
  runtime: BackendRuntime,
): Promise<CreatedChild> {
  const [create, mark] = planChild(request, context);
  if (!create || !mark) throw new Error("git backend produced an incomplete creation plan");
  const path = childPath(context, request.name);

  const created = await execCommand(runtime, create.command, create.args, {
    cwd: context.worktreeId,
    timeout: CREATE_TIMEOUT_MS,
  });
  if (created.code !== 0) throw commandFailure("git worktree add", created);

  const marked = await execCommand(runtime, mark.command, mark.args, { cwd: path });
  if (marked.code !== 0) {
    throw new Error(
      `${commandFailure("git update-ref", marked).message}. The worktree at ${path} exists without a recursion marker and was left in place for review.`,
    );
  }

  return {
    // Plain git exposes no worktree ID; the created branch is the child's stable identity.
    worktreeId: null,
    worktreePath: path,
    // Plain git launches no agent, so the parent hands the prompt to a worker itself.
    agentTerminalHandle: null,
    extra: { branch: request.name, recursionMarkerRef: CHILD_MARKER_REF, workerPrompt: request.prompt },
  };
}

/** Plain `git worktree` behavior: no Orca CLI, no agent launch, siblings under `<root>-worktrees/`. */
export const gitWorktreeBackend: WorktreeBackend = { id: "git-worktree", loadContext, planChild, createChild };
