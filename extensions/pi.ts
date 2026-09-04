import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { HostApi } from "../src/contracts.js";
import { registerOrcaTaskDispatch } from "../src/dispatcher.js";
import { createPiParameters } from "../src/schema.js";

export default function orcaTaskDispatch(pi: ExtensionAPI): void {
  registerOrcaTaskDispatch(pi as unknown as HostApi, createPiParameters());
}
