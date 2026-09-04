export type ExecOptions = {
  cwd?: string;
  signal?: AbortSignal;
  timeout?: number;
};

export type ExecResult = {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
};

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

export type ToolContext = {
  cwd?: string;
};

export type ToolDefinition = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  approval?: "write";
  loadMode?: "essential";
  execute(
    toolCallId: string,
    params: TaskDispatchParams,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: ToolContext,
  ): Promise<ToolResult>;
};

export type HostApi = {
  registerTool(definition: ToolDefinition): void;
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
};

export type SetupMode = "skip" | "run" | "inherit";

export type TaskSlice = {
  name: string;
  task: string;
  scope: string[];
};

export type TaskDispatchParams = {
  task: string;
  sourceRef?: string;
  slices: TaskSlice[];
  setup?: SetupMode;
  agent?: string;
  dryRun?: boolean;
};

export type ToolMetadata = Pick<ToolDefinition, "approval" | "loadMode">;
