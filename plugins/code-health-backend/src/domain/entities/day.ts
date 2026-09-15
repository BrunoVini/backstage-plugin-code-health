import { DateTime, Duration } from "luxon";

/**
 * A calendar day in UTC, as `YYYY-MM-DD`.
 *
 * The whole plugin works in UTC. Ingestion windows, backfill cursors and
 * snapshot keys all use this type, so a backend that moves between time zones —
 * or a deployment spread across them — never disagrees with itself about which
 * day a commit belongs to.
 */
export type Day = string;

export const DAY_FORMAT = "yyyy-MM-dd";

export const toDay = (instant: Date): Day =>
  DateTime.fromJSDate(instant, { zone: "utc" }).toFormat(DAY_FORMAT);

/**
 * The last day a half-open window `[from, to)` reaches into.
 *
 * A window ending exactly at midnight — a calendar month, or any range the
 * dashboard resolves to a day boundary — never touches the day `to` names: its
 * last instant is the millisecond before. Reading `toDay(to)` there would let
 * one extra day of snapshots and per-day measures into every read, and a
 * September would carry the first of October. A window ending mid-day keeps
 * that day, because it does reach into it.
 */
export const lastDayOf = (to: Date): Day => toDay(new Date(to.getTime() - 1));

/** Midnight UTC at the start of the given day. */
export const startOfDay = (day: Day): Date =>
  DateTime.fromFormat(day, DAY_FORMAT, { zone: "utc" }).startOf("day").toJSDate();

export const addDays = (day: Day, days: number): Day =>
  DateTime.fromFormat(day, DAY_FORMAT, { zone: "utc" }).plus({ days }).toFormat(DAY_FORMAT);

/** Whole days from `from` to `to`, negative when `to` precedes `from`. */
export const daysBetween = (from: Day, to: Day): number => {
  const start = DateTime.fromFormat(from, DAY_FORMAT, { zone: "utc" });
  const end = DateTime.fromFormat(to, DAY_FORMAT, { zone: "utc" });
  return Math.round(end.diff(start, "days").days);
};

/** Every day in `[from, to]`, inclusive at both ends, ascending. */
export const daysInRange = (from: Day, to: Day): Day[] => {
  const span = daysBetween(from, to);
  if (span < 0) return [];
  return Array.from({ length: span + 1 }, (_unused, index) => addDays(from, index));
};

/**
 * Normalises whatever a `date` column returns into `YYYY-MM-DD`.
 *
 * SQLite hands back a string, PostgreSQL hands back a `Date` the driver built
 * in local time. Formatting that `Date` as UTC would shift it to the previous
 * day for anyone west of Greenwich, so its components are read directly.
 */
export const fromStoredDate = (value: Date | string): Day => {
  if (typeof value === "string") return value.slice(0, 10);
  const year = value.getFullYear().toString().padStart(4, "0");
  const month = (value.getMonth() + 1).toString().padStart(2, "0");
  const dayOfMonth = value.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${dayOfMonth}`;
};

/**
 * The days a window covers *completely*, from its first instant to its last.
 *
 * A window that starts or ends mid-day does not cover that day, and saying it
 * did would make the dashboard offer a range it can only answer part of. The
 * incremental phase advances in partial days by nature, so this is what keeps
 * "fetched" honest until the day actually finishes.
 */
export const fullyCoveredDays = (from: Date, to: Date): Day[] => {
  const first = from.getTime() === startOfDay(toDay(from)).getTime() ? toDay(from) : addDays(toDay(from), 1);
  const lastCandidate = addDays(toDay(to), -1);
  const endOfLast = startOfDay(addDays(lastCandidate, 1)).getTime();
  const last = endOfLast <= to.getTime() ? lastCandidate : addDays(lastCandidate, -1);
  return daysInRange(first, last);
};

export const isDay = (value: string): boolean =>
  DateTime.fromFormat(value, DAY_FORMAT, { zone: "utc" }).isValid;

/**
 * Parses an ISO 8601 duration such as `P1D` into whole days, falling back to
 * `fallback` when the value is absent, unparseable, or shorter than a day.
 *
 * Sub-day chunks are rejected on purpose: the ingested-chunk table is keyed by
 * day, so a chunk smaller than that could not be recorded as complete.
 */
export const parseChunkDays = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const duration = Duration.fromISO(value);
  if (!duration.isValid) return fallback;
  const days = Math.floor(duration.as("days"));
  return days >= 1 ? days : fallback;
};
