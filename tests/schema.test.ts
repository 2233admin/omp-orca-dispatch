import assert from "node:assert/strict";
import { test } from "node:test";

import ompExtension from "../extensions/omp.js";
import piExtension from "../extensions/pi.js";
import type { ExecResult, HostApi, ToolDefinition } from "../src/contracts.js";
import { createOmpParameters, createPiParameters, type ZodApi, type ZodSchema } from "../src/schema.js";

type Recorded = {
  kind: string;
  description?: string;
  minimum?: number;
  maximum?: number;
  optional?: boolean;
  shape?: Record<string, Recorder>;
  item?: Recorder;
  values?: readonly string[];
};

class Recorder implements ZodSchema {
  readonly recorded: Recorded;

  constructor(kind: string, extra: Partial<Recorded> = {}) {
    this.recorded = { kind, ...extra };
  }

  optional(): Recorder {
    this.recorded.optional = true;
    return this;
  }

  describe(description: string): Recorder {
    this.recorded.description = description;
    return this;
  }

  min(value: number): Recorder {
    this.recorded.minimum = value;
    return this;
  }

  max(value: number): Recorder {
    this.recorded.maximum = value;
    return this;
  }
}

function zodRecorder(): ZodApi {
  return {
    object: (shape) => new Recorder("object", { shape: shape as Record<string, Recorder> }),
    array: (schema) => new Recorder("array", { item: schema as Recorder }),
    string: () => new Recorder("string"),
    enum: (values) => new Recorder("enum", { values }),
    boolean: () => new Recorder("boolean"),
  };
}

function host(): HostApi & { definition?: ToolDefinition } {
  return {
    async exec(): Promise<ExecResult> {
      return { code: 0, stdout: "{}", stderr: "" };
    },
    registerTool(definition) {
      this.definition = definition;
    },
  };
}

test("Pi TypeBox metadata exposes required bounds and descriptions", () => {
  const schema = createPiParameters() as unknown as Record<string, unknown> & {
    required: string[];
    properties: Record<string, Record<string, unknown>>;
  };
  assert.deepEqual(schema.required, ["task", "slices"]);
  assert.equal(schema.properties.slices?.minItems, 2);
  assert.equal(schema.properties.slices?.maxItems, 3);
  assert.match(String(schema.properties.sourceRef?.description), /canonical tracker reference/);
});

test("OMP Zod metadata exposes required bounds and descriptions", () => {
  const schema = createOmpParameters(zodRecorder()) as Recorder;
  const shape = schema.recorded.shape;
  assert.ok(shape);
  assert.equal(shape.slices?.recorded.minimum, 2);
  assert.equal(shape.slices?.recorded.maximum, 3);
  assert.equal(shape.sourceRef?.recorded.optional, true);
  assert.match(String(shape.sourceRef?.recorded.description), /canonical tracker reference/);
});

test("explicit Pi and OMP entrypoints load and register host-specific metadata", () => {
  const pi = host();
  piExtension(pi as never);
  assert.equal(pi.definition?.name, "orca_task_dispatch");
  assert.equal(pi.definition?.approval, undefined);

  const omp = Object.assign(host(), { zod: zodRecorder() });
  ompExtension(omp);
  assert.equal(omp.definition?.name, "orca_task_dispatch");
  assert.equal(omp.definition?.approval, "write");
  assert.equal(omp.definition?.loadMode, "essential");
});
