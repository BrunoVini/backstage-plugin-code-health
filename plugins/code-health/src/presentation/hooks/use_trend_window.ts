import type {
  CoverageInfo,
  TimeSeriesBucket,
  TimeWindow,
} from "@rios0rios0/backstage-plugin-code-health-common";
import {
  DEFAULT_TREND_MONTHS,
  trendBucketFor,
} from "@rios0rios0/backstage-plugin-code-health-common";
import { useCallback, useMemo, useState } from "react";
import { availableMonths, type MonthSelection } from "../../domain/entities/time_range";
import {
  availableTrendMonths,
  trendSelectionFromKey,
  trendSelectionKey,
  trendWindowOf,
  type TrendSelection,
} from "../../domain/entities/trend_range";

export interface UseTrendWindowResult {
  /** What the picker is asking for, narrowed to what has been collected. */
  readonly selection: TrendSelection;
  /** The rolling counts the backend has ingested enough history to answer for. */
  readonly offered: readonly number[];
  /** Every calendar month the backfill has reached, newest first. */
  readonly months: readonly MonthSelection[];
  readonly window: TimeWindow;
  readonly bucket: TimeSeriesBucket;
  readonly select: (selection: TrendSelection) => void;
}

/**
 * Holds what a detail page is looking at, bounded by what has been collected.
 *
 * The clock is sampled once when the page opens rather than read per render:
 * the window is a dependency of the fetching hook, and a fresh instant every
 * render would put it in a request loop. A detail page is somewhere a person
 * goes to read one trend and leave, so it does not auto-refresh either.
 *
 * A rolling count wider than the backfill has reached falls back to the widest
 * one offered, and a calendar month the backfill never reached falls back to
 * the default count, rather than asking for a period that would come back
 * empty and look like an outage.
 */
export const useTrendWindow = (
  coverage: CoverageInfo | null,
  defaultMonths: number = DEFAULT_TREND_MONTHS,
): UseTrendWindowResult => {
  const [requested, setRequested] = useState<TrendSelection>({
    kind: "months",
    months: defaultMonths,
  });
  const [now] = useState(() => new Date());

  const earliestDay = coverage?.earliestDay ?? null;
  const offered = useMemo(() => availableTrendMonths(earliestDay, now), [earliestDay, now]);
  const months = useMemo(() => availableMonths(earliestDay, now), [earliestDay, now]);

  /**
   * The selection narrowed to what has been collected, as a key.
   *
   * A key rather than the object, so everything below memoises on a primitive:
   * this is recomputed whenever the coverage does, and a fresh selection object
   * each time would give the fetching hook a new window every render and put it
   * in a request loop.
   */
  const key = useMemo(() => {
    const fallback = trendSelectionKey({
      kind: "months",
      months: offered[offered.length - 1] ?? defaultMonths,
    });

    if (requested.kind === "months") {
      return offered.includes(requested.months) ? trendSelectionKey(requested) : fallback;
    }
    // A month is offered only while the backfill still covers it, and the
    // coverage floor moves forward as history ages out of the retention.
    const covered = months.some(
      (month) =>
        month.year === requested.month.year && month.month === requested.month.month,
    );
    return covered ? trendSelectionKey(requested) : fallback;
  }, [requested, offered, months, defaultMonths]);

  const selection = useMemo<TrendSelection>(
    () => trendSelectionFromKey(key) ?? { kind: "months", months: defaultMonths },
    [key, defaultMonths],
  );

  const window = useMemo(() => trendWindowOf(selection, now), [selection, now]);
  const bucket = trendBucketFor(window.from, window.to);

  const select = useCallback((next: TrendSelection) => setRequested(next), []);

  return { selection, offered, months, window, bucket, select };
};
