import {
  CREATE_TIMEOUT_MS,
  DISPATCH_COMMENT_PREFIX,
  execJson,
  isObject,
  requireObject,
  text,
} from "./support.js";
import type {
  BackendRuntime,
  ChildRequest,
  CreatedChild,
  ParentContext,
  PlannedCommand,
  WorktreeBackend,
} from "./types.js";

function orcaCommand(): string {
  return text(process.env.ORCA_CLI_COMMAND) || "orca";
}

async function loadContext(runtime: BackendRuntime): Promise<ParentContext> {
  const command = orcaCommand();
  const status = await execJson(runtime, command, ["status", "--json"]);
  const runtimeStatus = requireObject(requireObject(status.result, "Orca status result").runtime, "Orca runtime status");
  if (status.ok !== true || runtimeStatus.state !== "ready" || runtimeStatus.reachable !== true) {
    throw new Error("Orca runtime is not ready and reachable");
  }
  const envelope = await execJson(runtime, command, ["worktree", "current", "--json"]);
  if (envelope.ok !== true) throw new Error("Orca rejected the current-worktree request");
  const current = requireObject(requireObject(envelope.result, "Orca result").worktree, "Orca current worktree");
  if (text(current.comment).startsWith(DISPATCH_COMMENT_PREFIX)) {
    throw new Error("Refusing recursive dispatch from a dispatcher-created worktree");
  }
  const repoId = text(current.repoId);
  const worktreeId = text(current.id);
  const head = text(current.head);
  if (!repoId || !worktreeId || !head) throw new Error("Current Orca worktree lacks repoId, id, or head");
  return { repoId, worktreeId, head };
}

function planChild(request: ChildRequest, context: ParentContext): PlannedCommand[] {
  return [
    {
      command: orcaCommand(),
      args: [
        "worktree",
        "create",
        "--repo",
        `id:${context.repoId}`,
        "--name",
        request.name,
        "--agent",
        request.agent,
        "--prompt",
        request.prompt,
        "--setup",
        request.setup,
        "--base-branch",
        context.head,
        "--comment",
        request.comment,
        "--parent-worktree",
        `id:${context.worktreeId}`,
        "--json",
      ],
    },
  ];
}

async function createChild(
  request: ChildRequest,
  context: ParentContext,
  runtime: BackendRuntime,
): Promise<CreatedChild> {
  const [plan] = planChild(request, context);
  if (!plan) throw new Error("Orca backend produced no creation command");
  const envelope = await execJson(runtime, plan.command, plan.args, { timeout: CREATE_TIMEOUT_MS });
  if (envelope.ok !== true) throw new Error("Orca rejected the worktree creation request");
  const created = requireObject(envelope.result, "Orca create result");
  const worktree = isObject(created.worktree) ? created.worktree : {};
  const terminal = isObject(created.startupTerminal) ? created.startupTerminal : {};
  return {
    worktreeId: text(worktree.id) || text(created.worktreeId) || null,
    worktreePath: text(worktree.path) || text(created.path) || null,
    agentTerminalHandle: text(created.agentTerminalHandle) || text(terminal.handle) || null,
  };
}

/** Original Orca CLI behavior: Orca owns the worktree, the base branch, and the agent terminal. */
export const orcaBackend: WorktreeBackend = { id: "orca", loadContext, planChild, createChild };
