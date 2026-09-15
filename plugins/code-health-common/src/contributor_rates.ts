import type { TimeWindow } from "./api";
import { confluenceContributions } from "./confluence_metrics";
import type { ChurnUnit, ContributorSummary } from "./contributor_summary";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The periods a total is averaged over.
 *
 * A month is the mean Gregorian month rather than thirty days, so twelve
 * monthly figures add back up to the yearly one instead of drifting five days
 * out over a year.
 */
export const RATE_PERIODS = {
  daily: { id: "daily", label: "Per day", days: 1 },
  weekly: { id: "weekly", label: "Per week", days: 7 },
  monthly: { id: "monthly", label: "Per month", days: 365.25 / 12 },
} as const;

export type RatePeriodId = keyof typeof RATE_PERIODS;

export const RATE_PERIOD_IDS: readonly RatePeriodId[] = ["daily", "weekly", "monthly"];

/**
 * How many days a window spans, as a positive number.
 *
 * Floored at a fraction of a day rather than at zero: the shortest range the
 * dashboard offers is an hour, and a zero denominator would turn every rate
 * into infinity on exactly the range a freshly installed plugin opens with.
 */
export const windowDaysOf = (window: TimeWindow): number => {
  const span = new Date(window.to).getTime() - new Date(window.from).getTime();
  if (!Number.isFinite(span)) return 1;
  return Math.max(span / MS_PER_DAY, 1 / 24);
};

/**
 * One period's worth of somebody's output.
 *
 * Null where the figure was never measured, never zero: a provider that
 * reports no line counts has not reported a churn of nothing, and an account
 * with no WakaTime linked to it has not logged no hours. The same rule the
 * scores follow, for the same reason — "we do not know" and "they did nothing"
 * are different claims on a row people are evaluated by.
 */
export interface ContributorRateSet {
  readonly commits: number;
  readonly pullRequestsOpened: number;
  readonly pullRequestsMerged: number;
  readonly reviewsGiven: number;
  /** In whatever unit the provider reported, which {@link ContributorRates} names. */
  readonly churn: number | null;
  readonly pipelineRuns: number;
  readonly codingSeconds: number | null;
  readonly issuesResolved: number | null;
  readonly documentationContributions: number | null;
}

/**
 * Somebody's output as a rate, over each period a reader thinks in.
 *
 * A window total answers "how much in these three months", which is not a
 * figure anybody can compare against a colleague who joined in the second
 * month or was on leave for the first. Dividing by the days the window spans
 * gives a figure that means the same thing whatever range is picked — and it
 * is what the productivity score reads, so the number on the card and the
 * number behind the score cannot disagree.
 *
 * `documentationContributions` is the exception the rest of the plugin already
 * makes for Confluence: it is stored per trailing window rather than per day,
 * so its rate is against Confluence's own window and not the range picked.
 * The card that renders it says so.
 */
export interface ContributorRates {
  readonly windowDays: number;
  readonly churnUnit: ChurnUnit;
  readonly daily: ContributorRateSet;
  readonly weekly: ContributorRateSet;
  readonly monthly: ContributorRateSet;
}

const churnTotalOf = (summary: ContributorSummary): number | null => {
  if (summary.churnUnit === "lines") return summary.linesOfCode;
  if (summary.churnUnit === "files") return summary.changedFiles;
  return null;
};

/** Every total a rate can be taken of, before any division. */
const totalsOf = (summary: ContributorSummary): ContributorRateSet => ({
  commits: summary.commits,
  pullRequestsOpened: summary.pullRequestsOpened,
  pullRequestsMerged: summary.pullRequestsMerged,
  reviewsGiven: summary.reviewsGiven,
  churn: churnTotalOf(summary),
  pipelineRuns: summary.pipelineRuns,
  codingSeconds: summary.wakaTimeMetrics?.totalSeconds ?? null,
  issuesResolved: summary.jiraMetrics?.issuesResolved ?? null,
  documentationContributions:
    summary.confluenceMetrics === null
      ? null
      : confluenceContributions(summary.confluenceMetrics),
});

const scale = (totals: ContributorRateSet, factor: number): ContributorRateSet => ({
  commits: totals.commits * factor,
  pullRequestsOpened: totals.pullRequestsOpened * factor,
  pullRequestsMerged: totals.pullRequestsMerged * factor,
  reviewsGiven: totals.reviewsGiven * factor,
  churn: totals.churn === null ? null : totals.churn * factor,
  pipelineRuns: totals.pipelineRuns * factor,
  codingSeconds: totals.codingSeconds === null ? null : totals.codingSeconds * factor,
  issuesResolved: totals.issuesResolved === null ? null : totals.issuesResolved * factor,
  documentationContributions:
    totals.documentationContributions === null
      ? null
      : totals.documentationContributions * factor,
});

/** One person's output per day, per week and per month over a window. */
export const contributorRatesOf = (
  summary: ContributorSummary,
  windowDays: number,
): ContributorRates => {
  const days = Math.max(windowDays, 1 / 24);
  const totals = totalsOf(summary);

  return {
    windowDays: days,
    churnUnit: summary.churnUnit,
    daily: scale(totals, RATE_PERIODS.daily.days / days),
    weekly: scale(totals, RATE_PERIODS.weekly.days / days),
    monthly: scale(totals, RATE_PERIODS.monthly.days / days),
  };
};

/**
 * A rate rounded for a reader rather than for arithmetic.
 *
 * Two decimals below ten and one above, so `0.07 a day` keeps its meaning
 * while `41.3 a month` does not pretend to a precision the underlying count
 * never had.
 */
export const formatRate = (rate: number): string => {
  if (!Number.isFinite(rate)) return "—";
  if (rate === 0) return "0";

  const fixed = rate >= 10 ? rate.toFixed(1) : rate.toFixed(2);
  // Trailing zeros are stripped because they claim a precision the underlying
  // count never had: "5.00 commits a day" reads as a measurement to the
  // hundredth, when it is five commits in one day.
  return fixed.includes(".") ? fixed.replace(/0+$/u, "").replace(/\.$/u, "") : fixed;
};

/**
 * The period a rate reads most naturally in, and the rate in it.
 *
 * A team merging a pull request each a fortnight has a daily rate of `0.07`,
 * which is a number nobody can picture. Promoting it to the shortest period in
 * which it reaches one keeps every sentence in figures a person recognises,
 * and the period is named alongside so the two can never be confused.
 */
export const legibleRate = (
  perDay: number,
): { readonly value: number; readonly period: RatePeriodId } => {
  if (perDay >= 1 || perDay <= 0) return { value: perDay, period: "daily" };
  const weekly = perDay * RATE_PERIODS.weekly.days;
  if (weekly >= 1) return { value: weekly, period: "weekly" };
  return { value: perDay * RATE_PERIODS.monthly.days, period: "monthly" };
};

/** What each period is called in the middle of a sentence. */
const PERIOD_SUFFIX: Readonly<Record<RatePeriodId, string>> = {
  daily: "a day",
  weekly: "a week",
  monthly: "a month",
};

/** How a rate is said in a sentence: `0.8 commits a day`. */
export const describeRate = (perDay: number, noun: string): string => {
  const { value, period } = legibleRate(perDay);
  return `${formatRate(value)} ${noun}${value === 1 ? "" : "s"} ${PERIOD_SUFFIX[period]}`;
};
