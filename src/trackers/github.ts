import { normalizeIssueRef } from "./support.js";
import type { PlannedTrackerCommand, TrackerAdapter } from "./types.js";

function planComment(issueRef: string, bodyFile: string): PlannedTrackerCommand {
  const ref = normalizeIssueRef("github", issueRef);
  return {
    command: "gh",
    // `gh issue comment` accepts an issue number or a full issue URL. A bare number resolves
    // against the repository of the executing cwd, which is the caller's checkout — this package
    // never names a repository on the caller's behalf.
    // --body-file rather than stdin, for the same non-ASCII reason as every other adapter.
    args: ["issue", "comment", ref, "--body-file", bodyFile],
  };
}

export const githubTracker: TrackerAdapter = { id: "github", planComment };
