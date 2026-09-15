import type {
  ChurnUnit,
  ContributorSummary,
  ContributorTrendPoint,
} from "@rios0rios0/backstage-plugin-code-health-common";

/**
 * One bucket as a chart reads it: the bucket's first day, and one value per
 * series with null where the bucket carries no measurement.
 *
 * Declared here rather than imported from the chart component because
 * dependencies point inward — the domain says what a chart is given, the
 * component draws it. It is structurally the component's `TrendPoint`, so the
 * two never need converting.
 */
export interface TrendValues {
  readonly day: string;
  readonly values: Readonly<Record<string, number | null>>;
}

/**
 * The series keys the cards and these helpers share.
 *
 * Every chart names its series twice — once building the points, once in the
 * legend the card hands the component — and a typo in either draws an empty
 * line under a legend that promises a figure, which fails silently. Naming
 * them once removes the failure rather than documenting it.
 */
export const CONTRIBUTOR_SERIES = {
  commits: "commits",
  pullRequestsOpened: "pullRequestsOpened",
  pullRequestsMerged: "pullRequestsMerged",
  reviewsGiven: "reviewsGiven",
  reviewsApproved: "reviewsApproved",
  churn: "churn",
  pipelineSuccessRate: "pipelineSuccessRate",
  score: "score",
  bugs: "bugs",
  vulnerabilities: "vulnerabilities",
  coverage: "coverage",
  codingHours: "codingHours",
  ticketsResolved: "ticketsResolved",
} as const;

/** Reads one bucket's figure for one series, or null when it was not measured. */
type BucketValue = (point: ContributorTrendPoint) => number | null;

const seriesOf = (
  points: readonly ContributorTrendPoint[],
  readers: Readonly<Record<string, BucketValue>>,
): TrendValues[] =>
  points.map((point) => ({
    day: point.day,
    values: Object.fromEntries(
      Object.entries(readers).map(([key, read]) => [key, read(point)]),
    ),
  }));

/**
 * Commits with merged pull requests beside them.
 *
 * Both are plain counts the backend recorded for the bucket, so a bucket
 * somebody spent on holiday is a measured zero rather than a gap: the walk
 * fetched those days, and it found nothing in them.
 */
export const commitSeries = (
  points: readonly ContributorTrendPoint[],
): TrendValues[] =>
  seriesOf(points, {
    [CONTRIBUTOR_SERIES.commits]: (point) => point.summary.commits,
    [CONTRIBUTOR_SERIES.pullRequestsMerged]: (point) => point.summary.pullRequestsMerged,
  });

/**
 * Pull requests opened against pull requests merged.
 *
 * Neither is a subset of the other — one opened in March and merged in April
 * is counted in each month — so the two lines crossing is information rather
 * than an error.
 */
export const pullRequestSeries = (
  points: readonly ContributorTrendPoint[],
): TrendValues[] =>
  seriesOf(points, {
    [CONTRIBUTOR_SERIES.pullRequestsOpened]: (point) => point.summary.pullRequestsOpened,
    [CONTRIBUTOR_SERIES.pullRequestsMerged]: (point) => point.summary.pullRequestsMerged,
  });

export const reviewSeries = (
  points: readonly ContributorTrendPoint[],
): TrendValues[] =>
  seriesOf(points, {
    [CONTRIBUTOR_SERIES.reviewsGiven]: (point) => point.summary.reviewsGiven,
    [CONTRIBUTOR_SERIES.reviewsApproved]: (point) => point.summary.reviewsApproved,
  });

/**
 * Which field carries churn in each unit, and that there is none in `none`.
 *
 * A map rather than a branch because the third case is not a fallback: a
 * provider that reported neither lines nor files has said nothing about churn,
 * and the card draws an explanation instead of a chart.
 */
const CHURN_FIELDS: Readonly<
  Record<ChurnUnit, ((summary: ContributorSummary) => number) | null>
> = {
  lines: (summary) => summary.linesOfCode,
  files: (summary) => summary.changedFiles,
  none: null,
};

/** What a churn axis is counting, or null when the provider reported neither. */
export const CHURN_LABELS: Readonly<Record<ChurnUnit, string | null>> = {
  lines: "Net lines of code",
  files: "Files changed",
  none: null,
};

/**
 * Churn in the unit the whole window was measured in.
 *
 * The unit comes from the window rather than from each bucket, because a
 * bucket in which nobody committed reports no unit at all — and drawing that
 * as a gap would read as a collection failure in the middle of a quiet
 * fortnight. The window having a unit is the provider saying it reports that
 * figure for this person, which makes a quiet bucket a real zero. With no unit
 * at all there is nothing to plot, and the list is empty.
 */
export const churnSeries = (
  points: readonly ContributorTrendPoint[],
  unit: ChurnUnit,
): TrendValues[] => {
  const field = CHURN_FIELDS[unit];
  if (field === null) return [];
  return seriesOf(points, {
    [CONTRIBUTOR_SERIES.churn]: (point) => field(point.summary),
  });
};

/**
 * The success rate over the runs that reached a verdict.
 *
 * Null where none did: a bucket whose only run was cancelled by a newer push
 * has no rate, and plotting it as zero would read as a fortnight of red builds.
 */
export const pipelineSeries = (
  points: readonly ContributorTrendPoint[],
): TrendValues[] =>
  seriesOf(points, {
    [CONTRIBUTOR_SERIES.pipelineSuccessRate]: (point) => {
      const decided =
        point.summary.pipelineRunsSucceeded + point.summary.pipelineRunsFailed;
      return decided === 0 ? null : point.summary.pipelineSuccessRate;
    },
  });

/**
 * The score each bucket earned, taken from the wire rather than recomputed.
 *
 * A bucket's score is read against the fleet's average rate *in that bucket*,
 * which the browser never receives — it holds one person's row, not everyone's
 * — so recomputing it here would silently produce a different number from the
 * one the score card shows.
 */
export const scoreSeries = (
  points: readonly ContributorTrendPoint[],
): TrendValues[] =>
  seriesOf(points, { [CONTRIBUTOR_SERIES.score]: (point) => point.score.value });

/**
 * Bugs and vulnerabilities in the code this person touched.
 *
 * Null for a bucket with no Sonar measurement at all: no project measures the
 * repositories they changed, or the snapshot that would have measured them
 * predates the installation. Zero would claim a clean bill of health nobody
 * issued.
 */
export const sonarDefectSeries = (
  points: readonly ContributorTrendPoint[],
): TrendValues[] =>
  seriesOf(points, {
    [CONTRIBUTOR_SERIES.bugs]: (point) => point.summary.sonarMetrics?.bugs ?? null,
    [CONTRIBUTOR_SERIES.vulnerabilities]: (point) =>
      point.summary.sonarMetrics?.vulnerabilities ?? null,
  });

export const sonarCoverageSeries = (
  points: readonly ContributorTrendPoint[],
): TrendValues[] =>
  seriesOf(points, {
    [CONTRIBUTOR_SERIES.coverage]: (point) => point.summary.sonarMetrics?.coverage ?? null,
  });

const SECONDS_PER_HOUR = 3600;

/** Seconds as hours to one decimal, which is the resolution a chart can show. */
export const hoursOf = (totalSeconds: number): number =>
  Math.round((totalSeconds / SECONDS_PER_HOUR) * 10) / 10;

/**
 * Coding time, in hours.
 *
 * Null where WakaTime measured nothing for the bucket, which is not the same
 * as a bucket in which somebody wrote no code: an editor that was offline, or
 * a person who joined the organisation halfway through the window, reports no
 * measurement rather than a zero.
 */
export const codingTimeSeries = (
  points: readonly ContributorTrendPoint[],
): TrendValues[] =>
  seriesOf(points, {
    [CONTRIBUTOR_SERIES.codingHours]: (point) => {
      const wakaTime = point.summary.wakaTimeMetrics;
      return wakaTime === null ? null : hoursOf(wakaTime.totalSeconds);
    },
  });

/**
 * Issues assigned to this person that reached a done status in the bucket.
 *
 * Null where the person has no Atlassian account on the row at all — somebody
 * whose Jira identity nobody has linked yet is not somebody who closed nothing.
 */
export const ticketsResolvedSeries = (
  points: readonly ContributorTrendPoint[],
): TrendValues[] =>
  seriesOf(points, {
    [CONTRIBUTOR_SERIES.ticketsResolved]: (point) =>
      point.summary.jiraMetrics?.issuesResolved ?? null,
  });

/**
 * Whether any bucket measured a series.
 *
 * The chart breaks a line at an unmeasured bucket, so a series nothing ever
 * measured draws an empty grid under a legend — which reads as a collapse to
 * zero rather than as a source that was never asked. A card checks this and
 * says what happened instead.
 */
export const hasMeasurement = (points: readonly TrendValues[], key: string): boolean =>
  points.some((point) => {
    const value = point.values[key];
    return value !== null && value !== undefined;
  });

/**
 * The accounts merged onto this row, as `source: sourceKey`.
 *
 * The header shows them because a page of totals that nobody can trace back to
 * its sources is a page nobody trusts — and because a row carrying one account
 * where the reader expected three is how a missing identity link is noticed.
 */
export const identityLabels = (summary: ContributorSummary): string[] =>
  summary.identities.map((identity) => `${identity.source}: ${identity.sourceKey}`);
