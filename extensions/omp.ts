import type { HostApi } from "../src/contracts.js";
import { registerOrcaTaskDispatch } from "../src/dispatcher.js";
import { registerOfflineTools } from "../src/offline.js";
import { createOmpBacklogParameters, createOmpParameters, createOmpSyncParameters, type ZodApi } from "../src/schema.js";

type OmpApi = HostApi & { zod: ZodApi };

export default function orcaTaskDispatch(pi: OmpApi): void {
  const metadata = { approval: "write", loadMode: "essential" } as const;
  registerOrcaTaskDispatch(pi, createOmpParameters(pi.zod), metadata);
  // Both entrypoints must register the offline tools; adding them to one host only would leave
  // the other without the capability.
  registerOfflineTools(pi, createOmpBacklogParameters(pi.zod), createOmpSyncParameters(pi.zod), metadata);
}
