import { Type } from "typebox";

export const MIN_SLICES = 2;
export const MAX_SLICES = 3;

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
