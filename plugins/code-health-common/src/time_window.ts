import type { TimeWindow } from "./api";

/**
 * The last calendar day a half-open window `[from, to)` reaches into, as a
 * UTC `YYYY-MM-DD`.
 *
 * `to` is an instant the window never reaches. A window ending exactly at
 * midnight — a calendar month, or the trailing window the Jira enricher
 * builds as the start of tomorrow — covers the day *before* it, and printing
 * `to`'s own date as the end would claim one day the window never held. The
 * same rule the backend's `lastDayOf` applies when it reads snapshots by day,
 * so a window is described on the screen exactly as it was read.
 *
 * Null for a `to` that is not an instant at all, so a malformed window prints
 * as it arrived rather than as an invalid date.
 */
export const lastCoveredDayOf = (window: TimeWindow): string | null => {
  const end = new Date(window.to).getTime();
  if (!Number.isFinite(end)) return null;
  return new Date(end - 1).toISOString().slice(0, 10);
};
