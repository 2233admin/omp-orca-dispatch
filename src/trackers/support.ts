import type { TrackerId } from "./types.js";

/**
 * Validate an issue reference before it becomes an argv element. Argv-only execution has no
 * quoting layer, so a reference that starts with `-` would be read as an option by every CLI
 * below instead of as an issue; that is rejected rather than escaped.
 */
export function normalizeIssueRef(tracker: TrackerId, issueRef: string): string {
  const ref = issueRef.trim();
  if (!ref) throw new Error(`${tracker} issueRef is required`);
  if (ref.startsWith("-")) throw new Error(`${tracker} issueRef must not start with "-"`);
  return ref;
}
