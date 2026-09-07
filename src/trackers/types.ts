/**
 * Trackers this package knows how to build a comment argv for. A `syncTarget.kind` outside this
 * union is rejected rather than guessed: filing a comment against the wrong tracker is worse
 * than refusing to file it.
 */
export type TrackerId = "multica" | "gitea" | "github";

/** One executable-plus-argv invocation. Adapters never build shell command strings. */
export type PlannedTrackerCommand = {
  command: string;
  args: string[];
};

export type TrackerAdapter = {
  readonly id: TrackerId;
  /**
   * Argv that posts the contents of `bodyFile` as a comment on `issueRef`.
   *
   * Two properties every adapter must keep:
   *
   * 1. The body travels as a UTF-8 file, never on stdin. Stdin mangles non-ASCII bytes on
   *    Windows, which is how a comment loses its content silently.
   * 2. No credential appears in the returned argv. An adapter may reference a host environment
   *    variable *by name* so the executing host supplies the value; it never reads or embeds one.
   *
   * Throws when `issueRef` cannot address an issue on this tracker.
   */
  planComment(issueRef: string, bodyFile: string): PlannedTrackerCommand;
};
