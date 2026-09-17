import { RATE_PERIODS, windowDaysOf } from "./contributor_rates";
import type { RepositorySummary } from "./repository_summary";

/**
 * One period's worth of a repository's activity.
 *
 * The same rule the contributor set follows: null where the figure was never
 * measured, never zero. A repository whose catalog entity names no WakaTime
 * project has no coding time, and one that names no Jira project has resolved
 * no tickets that anybody counted.
 */
export interface RepositoryRateSet {
  readonly commits: number;
  readonly pullRequestsOpened: number;
  readonly pullRequestsMerged: number;
  /** Votes on the repository's pull requests by somebody other than their author. */
  readonly reviews: number;
  /** Pipeline runs, whatever their verdict. */
  readonly builds: number;
  readonly releases: number;
  readonly codingSeconds: number | null;
  /**
   * Tickets resolved in the matching Jira project — over **Jira's own trailing
   * window**, not the range picked, because the repository-level Jira figures
   * ride on the daily snapshot and describe `atlassian.historyDays`. The rate
   * is honest; the period it was taken over is the one the card has to name.
   */
  readonly issuesResolved: number | null;
}

/**
 * A repository's activity as a rate, over each period a reader thinks in.
 *
 * The same arithmetic as a person's: every total divided by the days the
 * window spans, so "0.8 commits a day" means the same thing whichever range
 * was picked. The denominator is the window, not the days anything happened
 * in — a repository quiet for a fortnight has a lower rate, and is meant to.
 */
export interface RepositoryRates {
  readonly windowDays: number;
  readonly daily: RepositoryRateSet;
  readonly weekly: RepositoryRateSet;
  readonly monthly: RepositoryRateSet;
}

const scale = (daily: RepositoryRateSet, factor: number): RepositoryRateSet => ({
  commits: daily.commits * factor,
  pullRequestsOpened: daily.pullRequestsOpened * factor,
  pullRequestsMerged: daily.pullRequestsMerged * factor,
  reviews: daily.reviews * factor,
  builds: daily.builds * factor,
  releases: daily.releases * factor,
  codingSeconds: daily.codingSeconds === null ? null : daily.codingSeconds * factor,
  issuesResolved: daily.issuesResolved === null ? null : daily.issuesResolved * factor,
});

const periodsOf = (windowDays: number, daily: RepositoryRateSet): RepositoryRates => ({
  windowDays,
  daily,
  weekly: scale(daily, RATE_PERIODS.weekly.days),
  monthly: scale(daily, RATE_PERIODS.monthly.days),
});

/**
 * Tickets resolved per day of the Jira figures' own window, or null with no
 * project. Jira's window is the snapshot's trailing one rather than the range
 * picked, so it is the only honest divisor for that figure.
 */
const jiraDailyRateOf = (summary: RepositorySummary): number | null =>
  summary.jiraMetrics === null
    ? null
    : summary.jiraMetrics.issuesResolved / windowDaysOf(summary.jiraMetrics.window);

/** A repository's per-day activity over a window. */
const dailyRatesOf = (summary: RepositorySummary, days: number): RepositoryRateSet => ({
  commits: summary.activity.commits / days,
  pullRequestsOpened: summary.activity.pullRequestsOpened / days,
  pullRequestsMerged: summary.activity.pullRequestsMerged / days,
  reviews: summary.activity.reviews / days,
  builds: summary.activity.builds / days,
  releases: summary.activity.releases / days,
  codingSeconds:
    summary.wakaTimeMetrics === null ? null : summary.wakaTimeMetrics.totalSeconds / days,
  issuesResolved: jiraDailyRateOf(summary),
});

/** One repository's activity per day, per week and per month over a window. */
export const repositoryRatesOf = (
  summary: RepositorySummary,
  windowDays: number,
): RepositoryRates => {
  const days = Math.max(windowDays, 1 / 24);
  return periodsOf(days, dailyRatesOf(summary, days));
};

/**
 * The fleet's **mean daily rate** for every measure the repository Averages
 * card prints, and how many repositories it was taken over.
 *
 * Archived repositories are left out. One cannot receive a commit, so it is
 * not a peer of the ones that can, and a fleet with a long tail of archived
 * projects would otherwise report an average nobody active is anywhere near.
 * Forks stay: a fork somebody works in is a repository like any other.
 *
 * Each nullable mean is taken over the repositories the figure could be
 * measured on, and is null when that is none of them — the same rule the
 * contributor fleet follows, for the same reason: averaging silence in as zero
 * flatters every row that does carry a figure.
 */
export interface RepositoryFleetRates {
  /** Days the window spans, which every figure below is a per-day rate over. */
  readonly days: number;
  /** How many repositories the means were taken over. */
  readonly repositories: number;
  readonly commits: number;
  readonly pullRequestsOpened: number;
  readonly pullRequestsMerged: number;
  readonly reviews: number;
  readonly builds: number;
  readonly releases: number;
  readonly codingSeconds: number | null;
  readonly issuesResolved: number | null;
}

/** The mean of the rates that could be measured, or null when none could. */
const meanOf = (
  rates: readonly RepositoryRateSet[],
  pick: (rate: RepositoryRateSet) => number | null,
): number | null => {
  const measured = rates.flatMap((rate) => {
    const value = pick(rate);
    return value === null ? [] : [value];
  });
  if (measured.length === 0) return null;
  return measured.reduce((total, value) => total + value, 0) / measured.length;
};

/** The fleet's rates over a window, taken over its active repositories. */
export const repositoryFleetRatesOf = (
  summaries: readonly RepositorySummary[],
  windowDays: number,
): RepositoryFleetRates => {
  const days = Math.max(windowDays, 1 / 24);
  const rates = summaries
    .filter((summary) => !summary.isArchived)
    .map((summary) => dailyRatesOf(summary, days));

  return {
    days,
    repositories: rates.length,
    commits: meanOf(rates, (rate) => rate.commits) ?? 0,
    pullRequestsOpened: meanOf(rates, (rate) => rate.pullRequestsOpened) ?? 0,
    pullRequestsMerged: meanOf(rates, (rate) => rate.pullRequestsMerged) ?? 0,
    reviews: meanOf(rates, (rate) => rate.reviews) ?? 0,
    builds: meanOf(rates, (rate) => rate.builds) ?? 0,
    releases: meanOf(rates, (rate) => rate.releases) ?? 0,
    codingSeconds: meanOf(rates, (rate) => rate.codingSeconds),
    issuesResolved: meanOf(rates, (rate) => rate.issuesResolved),
  };
};

/**
 * The fleet's rates in the shape one repository's are printed in, so the card
 * can put the two side by side row for row.
 */
export const fleetRepositoryRatesOf = (fleet: RepositoryFleetRates): RepositoryRates =>
  periodsOf(fleet.days, {
    commits: fleet.commits,
    pullRequestsOpened: fleet.pullRequestsOpened,
    pullRequestsMerged: fleet.pullRequestsMerged,
    reviews: fleet.reviews,
    builds: fleet.builds,
    releases: fleet.releases,
    codingSeconds: fleet.codingSeconds,
    issuesResolved: fleet.issuesResolved,
  });
