import { giteaTracker } from "./gitea.js";
import { githubTracker } from "./github.js";
import { multicaTracker } from "./multica.js";
import type { TrackerAdapter, TrackerId } from "./types.js";

/** Every selectable tracker, keyed by the public `syncTarget.kind` value. */
export const TRACKER_ADAPTERS: Record<TrackerId, TrackerAdapter> = {
  multica: multicaTracker,
  gitea: giteaTracker,
  github: githubTracker,
};

export const TRACKER_IDS = Object.keys(TRACKER_ADAPTERS) as TrackerId[];

/**
 * Look an adapter up by tracker id. An unknown id is an explicit error: the outbox must never
 * fall back to a default tracker, because filing a comment on the wrong tracker is unrecoverable
 * from inside this package.
 */
export function resolveTracker(kind: unknown): TrackerAdapter {
  if (typeof kind === "string" && Object.hasOwn(TRACKER_ADAPTERS, kind)) {
    return TRACKER_ADAPTERS[kind as TrackerId];
  }
  throw new Error(`syncTarget.kind must be one of ${TRACKER_IDS.join(", ")}; no other tracker argv is implemented`);
}

export type { PlannedTrackerCommand, TrackerAdapter, TrackerId } from "./types.js";
