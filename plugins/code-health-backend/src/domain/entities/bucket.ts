import type { TimeSeriesBucket } from "@rios0rios0/backstage-plugin-code-health-common";
import { addDays, daysInRange, lastDayOf, toDay, type Day } from "./day";

/**
 * The first day of the bucket a day belongs to.
 *
 * Weeks start on Monday, which is the convention every calendar the dashboard
 * sits beside uses; months start on the first.
 *
 * This is one definition rather than one per chart on purpose: the cadence
 * series and the two trend series are read side by side, and two functions
 * disagreeing about which Sunday a commit belongs to would put the same commit
 * in two different weeks on two charts of the same window.
 */
export const bucketStart = (day: Day, bucket: TimeSeriesBucket): Day => {
  if (bucket === "day") return day;
  if (bucket === "month") return `${day.slice(0, 7)}-01`;

  const date = new Date(`${day}T00:00:00.000Z`);
  // `getUTCDay` returns 0 for Sunday, which belongs to the week that started
  // six days earlier rather than to the one starting the next morning.
  const weekday = date.getUTCDay();
  return addDays(day, -(weekday === 0 ? 6 : weekday - 1));
};

/**
 * The last day a bucket covers, never past the end of the window it belongs to.
 *
 * The bound matters because the current bucket is nearly always partial: asking
 * for a month by weeks ends inside a week, and reading a snapshot "at or before
 * the bucket's last day" without the bound would read one taken *after* the
 * window the caller asked about — which is how a chart of last March ends up
 * showing today's quality gate.
 */
export const bucketEnd = (
  start: Day,
  bucket: TimeSeriesBucket,
  windowEnd: Day,
): Day => {
  if (bucket === "day") return start < windowEnd ? start : windowEnd;

  const last =
    bucket === "week"
      ? addDays(start, 6)
      : // The day before the first of the next month, which is the only
        // arithmetic that gets February right without a table of lengths.
        addDays(`${addDays(start, 31).slice(0, 7)}-01`, -1);

  return last < windowEnd ? last : windowEnd;
};

/** The buckets a window spans, ascending, including the ones with nothing in. */
export const bucketsInWindow = (
  from: Date,
  to: Date,
  bucket: TimeSeriesBucket,
): Day[] => {
  const starts = new Set<Day>();
  // The window is half-open, so its last instant belongs to the previous day
  // whenever `to` lands exactly on midnight — the same day every other read
  // of the window ends on.
  for (const day of daysInRange(toDay(from), lastDayOf(to))) {
    starts.add(bucketStart(day, bucket));
  }
  return [...starts].sort((left, right) => left.localeCompare(right));
};
