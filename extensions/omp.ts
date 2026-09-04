import type { HostApi } from "../src/contracts.js";
import { registerOrcaTaskDispatch } from "../src/dispatcher.js";
import { createOmpParameters, type ZodApi } from "../src/schema.js";

type OmpApi = HostApi & { zod: ZodApi };

export default function orcaTaskDispatch(pi: OmpApi): void {
  registerOrcaTaskDispatch(pi, createOmpParameters(pi.zod), {
    approval: "write",
    loadMode: "essential",
  });
}
