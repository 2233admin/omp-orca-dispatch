import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { HostApi } from "../src/contracts.js";
import { registerOrcaTaskDispatch } from "../src/dispatcher.js";
import { registerOfflineTools } from "../src/offline.js";
import { createPiBacklogParameters, createPiParameters, createPiSyncParameters } from "../src/schema.js";

export default function orcaTaskDispatch(pi: ExtensionAPI): void {
  const host = pi as unknown as HostApi;
  registerOrcaTaskDispatch(host, createPiParameters());
  // Both entrypoints must register the offline tools; adding them to one host only would leave
  // the other without the capability.
  registerOfflineTools(host, createPiBacklogParameters(), createPiSyncParameters());
}
