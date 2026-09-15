import type { TimeWindow } from "@rios0rios0/backstage-plugin-code-health-common";
import { TREND_MONTHS } from "@rios0rios0/backstage-plugin-code-health-common";
import { toWindow, type MonthSelection } from "./time_range";

const daysInMonth = (year: number, month: number): number => new Date(year, month + 1, 0).getDate();

/**
 * The instant `months` calendar months before `now`, on the same day of the
 * month where it exists.
 *
 * Calendar months rather than thirty-day blocks, because "the last three
 * months" means March to June to the person reading it. The day is clamped
 * rather than rolled over: three months before the thirty-first of May is the
 * twenty-eighth of February, not the third of March.
 */
export const monthsBefore = (now: Date, months: number): Date => {
  const year = now.getFullYear();
  const month = now.getMonth() - months;
  const day = Math.min(now.getDate(), daysInMonth(year, month));
  return new Date(
    year,
    month,
    day,
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
    now.getMilliseconds(),
  );
};

/** The window a detail page asks for: the last `months` months, ending now. */
export const trendWindow = (months: number, now: Date): TimeWindow => ({
  from: monthsBefore(now, months).toISOString(),
  to: now.toISOString(),
});

/**
 * The month counts the backend can actually answer for.
 *
 * A count is offered once its window starts at or after the earliest day any
 * repository has data for, on the same rule the range picker applies. The
 * shortest count is always offered, even before a whole month has been
 * collected: a fresh install then shows the weeks it has rather than nothing,
 * and the page says the rest is still being collected.
 */
export const availableTrendMonths = (
  earliestDay: string | null,
  now: Date,
): readonly number[] => {
  const shortest = TREND_MONTHS.slice(0, 1);
  if (!earliestDay) return shortest;

  const earliest = new Date(`${earliestDay}T00:00:00.000Z`).getTime();
  if (Number.isNaN(earliest)) return shortest;

  const covered = TREND_MONTHS.filter(
    (months) => monthsBefore(now, months).getTime() >= earliest,
  );
  return covered.length > 0 ? covered : shortest;
};

/**
 * What a detail page's range picker is asking for.
 *
 * The same two shapes the tables' picker offers, for the same reason: a
 * rolling count and a calendar month are not two values of one enum, because a
 * month carries a year with it. Reusing `MonthSelection` and `toWindow` rather
 * than declaring a parallel month type is what keeps a month picked on a table
 * and a month picked on a detail page from resolving to different windows.
 */
export type TrendSelection =
  | { readonly kind: "months"; readonly months: number }
  | { readonly kind: "month"; readonly month: MonthSelection };

/**
 * A stable key for a trend selection, so the window can be memoised on a
 * primitive — a fresh window object per render would put the fetching hook in
 * a request loop.
 */
export const trendSelectionKey = (selection: TrendSelection): string =>
  selection.kind === "months"
    ? `months:${selection.months}`
    : `month:${selection.month.year}-${selection.month.month}`;

/**
 * The selection a key encodes — the inverse of {@link trendSelectionKey}.
 *
 * Null for anything unrecognised, including a month ordinal outside 1-12:
 * `Date` would roll `month:2026-99` into a year nobody asked for and a zero
 * into the previous December, so the ordinal is checked here rather than left
 * to arithmetic that never complains.
 */
export const trendSelectionFromKey = (key: string): TrendSelection | null => {
  const month = /^month:(\d{4})-(\d{1,2})$/u.exec(key);
  if (month !== null) {
    const [, year, ordinal] = month;
    const parsed = Number(ordinal);
    if (parsed < 1 || parsed > 12) return null;
    return { kind: "month", month: { year: Number(year), month: parsed } };
  }

  const rolling = /^months:(\d{1,2})$/u.exec(key);
  if (rolling === null) return null;
  const months = Number(rolling[1]);
  return TREND_MONTHS.includes(months) ? { kind: "months", months } : null;
};

/** The window a trend selection asks the backend for. */
export const trendWindowOf = (selection: TrendSelection, now: Date): TimeWindow =>
  selection.kind === "months"
    ? trendWindow(selection.months, now)
    : // The tables' own resolver, so "March" is the same March on both screens,
      // cut off at `now` while the month is still running rather than ending in
      // days nothing could have happened in yet.
      toWindow({ kind: "month", month: selection.month }, now);
