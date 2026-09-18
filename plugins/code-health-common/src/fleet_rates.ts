import type { ChurnUnit, ContributorSummary } from "./contributor_summary";
import type { ContributorRates, ContributorRateSet } from "./contributor_rates";
import { RATE_PERIODS } from "./contributor_rates";
import { fleetReferenceOf, meanRate, versionControl } from "./productivity_score";

/**
 * The team's **mean daily rate** for every measure the Averages card prints,
 * and how many people it was taken over.
 *
 * This is {@link FleetReference} — the reference the productivity score reads
 * output against — with two additions the score never needed and one
 * distinction it could afford to blur. Pull requests opened and pipeline runs
 * are not components of the score, but they are rows on the card, and a card
 * that compared six of its eight rows against the team would leave a reader
 * wondering what was wrong with the other two. And where the reference folds
 * "measured on nobody" into a zero, because a zero reference reads as
 * unmeasurable in every score, the card has to tell the two apart: a team in
 * which nobody has WakaTime linked has no average coding time, and printing a
 * zero for it would report a team that never opens an editor.
 *
 * Every figure is per elapsed day over the same window the person's own rates
 * are taken over, so the two sides of the comparison are always in one unit.
 * `null` is measured on nobody, never a rate of nothing.
 */
export interface ContributorFleetRates {
  /** Days the window spans, which every figure below is a per-day rate over. */
  readonly days: number;
  /** How many people the window measured, quiet ones included. */
  readonly people: number;
  readonly commits: number;
  readonly pullRequestsOpened: number;
  readonly pullRequestsMerged: number;
  readonly reviewsGiven: number;
  /** Mean over the people whose provider reports lines, or null with none. */
  readonly linesOfCode: number | null;
  /** Mean over the people whose provider reports files, or null with none. */
  readonly changedFiles: number | null;
  readonly pipelineRuns: number;
  /** Mean over the people with a WakaTime account linked, or null with none. */
  readonly codingSeconds: number | null;
  /** Mean over the people with a Jira account linked, or null with none. */
  readonly issuesResolved: number | null;
}

/** Whether any row carries the figure at all, so a mean of nobody stays null. */
const anyMeasured = (
  contributors: readonly ContributorSummary[],
  pick: (contributor: ContributorSummary) => number | null,
): boolean => contributors.some((contributor) => pick(contributor) !== null);

/**
 * The team's rates over a window, taken by the same arithmetic as the score's
 * reference.
 *
 * Built on top of {@link fleetReferenceOf} rather than beside it: the six
 * figures the two share are the reference's own numbers, so the sentence
 * behind a score component and the team column on the card are one figure
 * printed twice, and only the two rows the score does not read are computed
 * here.
 */
export const contributorFleetRatesOf = (
  contributors: readonly ContributorSummary[],
  windowDays: number,
): ContributorFleetRates => {
  const reference = fleetReferenceOf(contributors, windowDays);
  const lines = (row: ContributorSummary) => (row.churnUnit === "lines" ? row.linesOfCode : null);
  const files = (row: ContributorSummary) => (row.churnUnit === "files" ? row.changedFiles : null);
  const coding = (row: ContributorSummary) => row.wakaTimeMetrics?.totalSeconds ?? null;
  const tickets = (row: ContributorSummary) => row.jiraMetrics?.issuesResolved ?? null;

  return {
    days: reference.days,
    people: contributors.length,
    commits: reference.commits,
    pullRequestsOpened: meanRate(
      contributors,
      reference.days,
      versionControl((row) => row.pullRequestsOpened),
    ),
    pullRequestsMerged: reference.pullRequestsMerged,
    reviewsGiven: reference.reviewsGiven,
    linesOfCode: anyMeasured(contributors, lines) ? reference.linesOfCode : null,
    changedFiles: anyMeasured(contributors, files) ? reference.changedFiles : null,
    pipelineRuns: meanRate(contributors, reference.days, versionControl((row) => row.pipelineRuns)),
    codingSeconds: anyMeasured(contributors, coding) ? reference.codingSeconds : null,
    issuesResolved: anyMeasured(contributors, tickets) ? reference.issuesResolved : null,
  };
};

const scaleSet = (daily: ContributorRateSet, factor: number): ContributorRateSet => ({
  commits: daily.commits * factor,
  pullRequestsOpened: daily.pullRequestsOpened * factor,
  pullRequestsMerged: daily.pullRequestsMerged * factor,
  reviewsGiven: daily.reviewsGiven * factor,
  churn: daily.churn === null ? null : daily.churn * factor,
  pipelineRuns: daily.pipelineRuns * factor,
  codingSeconds: daily.codingSeconds === null ? null : daily.codingSeconds * factor,
  issuesResolved: daily.issuesResolved === null ? null : daily.issuesResolved * factor,
  documentationContributions: null,
});

/**
 * The team's rates in the shape one person's are printed in, so the card can
 * put the two side by side row for row.
 *
 * Churn is read in the person's own unit: a person measured in lines is
 * compared with the people measured in lines, never with a mean of files.
 * Documentation stays null on both sides — Confluence is stored per trailing
 * window rather than per day, so it is not a rate of the range picked and the
 * card does not list it.
 */
/** The team's churn in one unit, or null for a person measured in neither. */
const churnIn = (fleet: ContributorFleetRates, churnUnit: ChurnUnit): number | null => {
  if (churnUnit === "lines") return fleet.linesOfCode;
  if (churnUnit === "files") return fleet.changedFiles;
  return null;
};

export const fleetContributorRatesOf = (
  fleet: ContributorFleetRates,
  churnUnit: ChurnUnit,
): ContributorRates => {
  const churn = churnIn(fleet, churnUnit);
  const daily: ContributorRateSet = {
    commits: fleet.commits,
    pullRequestsOpened: fleet.pullRequestsOpened,
    pullRequestsMerged: fleet.pullRequestsMerged,
    reviewsGiven: fleet.reviewsGiven,
    churn,
    pipelineRuns: fleet.pipelineRuns,
    codingSeconds: fleet.codingSeconds,
    issuesResolved: fleet.issuesResolved,
    documentationContributions: null,
  };

  return {
    windowDays: fleet.days,
    churnUnit,
    daily,
    weekly: scaleSet(daily, RATE_PERIODS.weekly.days),
    monthly: scaleSet(daily, RATE_PERIODS.monthly.days),
  };
};

/**
 * How far a rate sits from the team's, as a signed share of the team's:
 * `0.25` is a quarter above it, `-0.4` is forty percent below.
 *
 * Null rather than infinite or zero whenever the comparison would say nothing:
 * a figure nobody measured has no distance from anything, and against a team
 * average of zero every rate is infinitely above it. The period cancels out,
 * so the same share holds per day, per week and per month.
 */
export const rateDeltaOf = (rate: number | null, reference: number | null): number | null => {
  if (rate === null || reference === null) return null;
  if (!Number.isFinite(rate) || !Number.isFinite(reference) || reference <= 0) return null;
  return (rate - reference) / reference;
};

/** Which way a delta points, for a view that colours the direction. */
export type RateDeltaDirection = "above" | "below" | "level";

export const rateDeltaDirection = (delta: number): RateDeltaDirection => {
  const percent = Math.round(delta * 100);
  if (percent > 0) return "above";
  if (percent < 0) return "below";
  return "level";
};

/**
 * A delta said for a reader: `25% above`, `40% below`, or `level` when the
 * rounding leaves nothing between them. Rounded to whole percents, because
 * the count underneath was never measured to a tenth of one.
 */
export const describeRateDelta = (delta: number, against: string = "the team"): string => {
  const direction = rateDeltaDirection(delta);
  if (direction === "level") return `level with ${against}`;
  return `${Math.round(Math.abs(delta) * 100)}% ${direction} ${against}`;
};
