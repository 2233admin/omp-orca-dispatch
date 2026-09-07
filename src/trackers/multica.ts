import { normalizeIssueRef } from "./support.js";
import type { PlannedTrackerCommand, TrackerAdapter } from "./types.js";

function planComment(issueRef: string, bodyFile: string): PlannedTrackerCommand {
  const ref = normalizeIssueRef("multica", issueRef);
  return {
    command: "multica",
    // --content-file rather than stdin: the tracker CLI documents that stdin mangles
    // non-ASCII bytes on Windows.
    args: ["issue", "comment", "add", ref, "--content-file", bodyFile],
  };
}

/** The original outbox behavior, unchanged: this argv is what every existing plan already emitted. */
export const multicaTracker: TrackerAdapter = { id: "multica", planComment };
