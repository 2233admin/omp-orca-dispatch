import { Type } from "typebox";

export const MIN_SLICES = 2;
export const MAX_SLICES = 3;

const BACKLOG_ACTIONS = ["enqueue", "claim", "complete", "bind", "ack", "list"] as const;
const ITEM_STATES = ["queued", "claimed", "completed", "synced", "pending-triage"] as const;

/** Backlog parameters for Pi (TypeBox). Mirrors createOmpBacklogParameters exactly. */
export function createPiBacklogParameters() {
  return Type.Object({
    action: Type.Union(
      BACKLOG_ACTIONS.map(value => Type.Literal(value)),
      { description: "enqueue, claim, complete, bind, ack, or list" },
    ),
    id: Type.Optional(Type.String({ description: "Item id; required by every action except enqueue and list" })),
    title: Type.Optional(Type.String({ description: "Work item title; required by enqueue" })),
    sourceRef: Type.Optional(
      Type.String({ description: "Opaque traceability label. Never used to build a tracker command" }),
    ),
    syncTarget: Type.Optional(
      Type.Object(
        { kind: Type.Literal("multica"), issueRef: Type.String() },
        { description: "Concrete tracker target; only an item with one can be synced" },
      ),
    ),
    scope: Type.Optional(Type.Array(Type.String(), { description: "Repository-relative paths this item owns" })),
    evidence: Type.Optional(Type.String({ description: "Commits and verification output; required by complete" })),
    issueRef: Type.Optional(Type.String({ description: "Tracker-returned issue reference; required by ack" })),
    commentId: Type.Optional(Type.String({ description: "Tracker-returned comment id; required by ack" })),
    state: Type.Optional(Type.Union(ITEM_STATES.map(value => Type.Literal(value)), { description: "Filter for list" })),
  });
}

/** Sync takes no parameters: it plans writes for whatever is completed in this repository. */
export function createPiSyncParameters() {
  return Type.Object({});
}

export function createPiParameters() {
  return Type.Object({
    task: Type.String({ description: "Complete parent task shared by all slices" }),
    sourceRef: Type.Optional(
      Type.String({ description: "Optional canonical tracker reference, such as an issue key or URL" }),
    ),
    slices: Type.Array(
      Type.Object({
        name: Type.String({ description: "Unique ASCII worktree name" }),
        task: Type.String({ description: "Self-contained deliverable for this worker" }),
        scope: Type.Array(Type.String(), {
          minItems: 1,
          description: "Exclusive repository-relative file or directory paths",
        }),
      }),
      { minItems: MIN_SLICES, maxItems: MAX_SLICES },
    ),
    setup: Type.Optional(
      Type.Union([Type.Literal("skip"), Type.Literal("run"), Type.Literal("inherit")], {
        description: "Orca setup mode; defaults to skip",
      }),
    ),
    agent: Type.Optional(
      Type.String({ description: "Configured Orca agent selector; defaults to ORCA_DISPATCH_AGENT or omp" }),
    ),
    dryRun: Type.Optional(Type.Boolean({ description: "Validate and show plans without creating worktrees" })),
  });
}

export type ZodSchema = {
  optional(): ZodSchema;
  describe(description: string): ZodSchema;
  min(value: number): ZodSchema;
  max(value: number): ZodSchema;
};

export type ZodApi = {
  object(shape: Record<string, ZodSchema>): ZodSchema;
  array(schema: ZodSchema): ZodSchema;
  string(): ZodSchema;
  enum(values: readonly [string, ...string[]]): ZodSchema;
  boolean(): ZodSchema;
};

/** Backlog parameters for OMP (Zod). Mirrors createPiBacklogParameters exactly. */
export function createOmpBacklogParameters(z: ZodApi): ZodSchema {
  return z.object({
    action: z.enum(BACKLOG_ACTIONS).describe("enqueue, claim, complete, bind, ack, or list"),
    id: z.string().optional().describe("Item id; required by every action except enqueue and list"),
    title: z.string().optional().describe("Work item title; required by enqueue"),
    sourceRef: z.string().optional().describe("Opaque traceability label. Never used to build a tracker command"),
    syncTarget: z
      .object({ kind: z.enum(["multica"]), issueRef: z.string() })
      .optional()
      .describe("Concrete tracker target; only an item with one can be synced"),
    scope: z.array(z.string()).optional().describe("Repository-relative paths this item owns"),
    evidence: z.string().optional().describe("Commits and verification output; required by complete"),
    issueRef: z.string().optional().describe("Tracker-returned issue reference; required by ack"),
    commentId: z.string().optional().describe("Tracker-returned comment id; required by ack"),
    state: z.enum(ITEM_STATES).optional().describe("Filter for list"),
  });
}

/** Sync takes no parameters: it plans writes for whatever is completed in this repository. */
export function createOmpSyncParameters(z: ZodApi): ZodSchema {
  return z.object({});
}

export function createOmpParameters(z: ZodApi): ZodSchema {
  return z.object({
    task: z.string().describe("Complete parent task shared by all slices"),
    sourceRef: z.string().optional().describe("Optional canonical tracker reference, such as an issue key or URL"),
    slices: z
      .array(
        z.object({
          name: z.string().describe("Unique ASCII worktree name"),
          task: z.string().describe("Self-contained deliverable for this worker"),
          scope: z.array(z.string()).min(1).describe("Exclusive repository-relative file or directory paths"),
        }),
      )
      .min(MIN_SLICES)
      .max(MAX_SLICES),
    setup: z.enum(["skip", "run", "inherit"]).optional().describe("Orca setup mode; defaults to skip"),
    agent: z.string().optional().describe("Configured Orca agent selector; defaults to ORCA_DISPATCH_AGENT or omp"),
    dryRun: z.boolean().optional().describe("Validate and show plans without creating worktrees"),
  });
}
