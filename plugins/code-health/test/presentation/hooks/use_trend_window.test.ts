import { act, renderHook } from "@testing-library/react";
import { useTrendWindow } from "../../../src/presentation/hooks/use_trend_window";
import { aCoverageInfo } from "../../doubles/stub_coverage_service";

const DAY_MS = 24 * 60 * 60 * 1000;

const daysSpanned = (window: { from: string; to: string }): number =>
  Math.round((new Date(window.to).getTime() - new Date(window.from).getTime()) / DAY_MS);

describe("useTrendWindow", () => {
  it("should start at the default count with a full year of history", () => {
    // given
    const coverage = aCoverageInfo({ earliestDay: "2025-01-01" });

    // when
    const { result } = renderHook(() => useTrendWindow(coverage));

    // then
    expect(result.current.selection).toEqual({ kind: "months", months: 3 });
    expect(result.current.offered).toEqual([1, 2, 3, 4, 5, 6]);
    expect(daysSpanned(result.current.window)).toBeGreaterThanOrEqual(89);
    expect(result.current.bucket).toBe("week");
  });

  it("should bucket a single month by day", () => {
    // given
    const coverage = aCoverageInfo({ earliestDay: "2025-01-01" });
    const { result } = renderHook(() => useTrendWindow(coverage, 1));

    // when
    const { bucket, selection } = result.current;

    // then
    expect(selection).toEqual({ kind: "months", months: 1 });
    expect(bucket).toBe("day");
  });

  it("should move the window when another count is selected", () => {
    // given
    const coverage = aCoverageInfo({ earliestDay: "2025-01-01" });
    const { result } = renderHook(() => useTrendWindow(coverage));
    const before = result.current.window;

    // when
    act(() => result.current.select({ kind: "months", months: 6 }));

    // then
    expect(result.current.selection).toEqual({ kind: "months", months: 6 });
    expect(daysSpanned(result.current.window)).toBeGreaterThan(daysSpanned(before));
    // The end does not move: the clock was sampled once, when the page opened.
    expect(result.current.window.to).toBe(before.to);
  });

  it("should offer every calendar month the backfill has reached, newest first", () => {
    // given
    const coverage = aCoverageInfo({ earliestDay: "2025-01-01" });

    // when
    const { result } = renderHook(() => useTrendWindow(coverage));

    // then
    const [newest] = result.current.months;
    const now = new Date();
    expect(newest).toEqual({ year: now.getFullYear(), month: now.getMonth() + 1 });
    expect(result.current.months.length).toBeGreaterThan(6);
  });

  it("should resolve a calendar month to that month's window", () => {
    // given
    const coverage = aCoverageInfo({ earliestDay: "2025-01-01" });
    const { result } = renderHook(() => useTrendWindow(coverage));
    const [, previous] = result.current.months;

    // when
    act(() => result.current.select({ kind: "month", month: previous! }));

    // then
    const from = new Date(result.current.window.from);
    expect(from.getFullYear()).toBe(previous!.year);
    expect(from.getMonth() + 1).toBe(previous!.month);
    expect(from.getDate()).toBe(1);
    // A finished month is bucketed by day, being well under the daily limit.
    expect(result.current.bucket).toBe("day");
  });

  it("should fall back to the widest count offered when the requested one is not covered", () => {
    // given
    const recent = new Date();
    recent.setDate(recent.getDate() - 40);
    const coverage = aCoverageInfo({ earliestDay: recent.toISOString().slice(0, 10) });

    // when
    const { result } = renderHook(() => useTrendWindow(coverage, 6));

    // then
    // Forty days of history covers one month, not six.
    expect(result.current.offered).toEqual([1]);
    expect(result.current.selection).toEqual({ kind: "months", months: 1 });
  });

  it("should fall back to a rolling count when the month picked is no longer covered", () => {
    // given
    // The coverage floor moves forward as history ages out of the retention, so
    // a month that was offered yesterday can stop being answerable.
    const coverage = aCoverageInfo({ earliestDay: "2025-01-01" });
    const { result } = renderHook(() => useTrendWindow(coverage));

    // when
    act(() => result.current.select({ kind: "month", month: { year: 1999, month: 4 } }));

    // then
    // The widest count the backfill covers, which is the same fallback a
    // too-wide rolling count gets: show as much as there is rather than a
    // period that would come back empty.
    expect(result.current.selection).toEqual({ kind: "months", months: 6 });
  });

  it("should offer the shortest count before coverage is known", () => {
    // given / when
    const { result } = renderHook(() => useTrendWindow(null));

    // then
    expect(result.current.offered).toEqual([1]);
    expect(result.current.selection).toEqual({ kind: "months", months: 1 });
  });
});
