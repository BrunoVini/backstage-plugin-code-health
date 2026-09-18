import type {
  ContributorSummary,
  RepositorySummary,
  TimeSeriesPoint,
} from "@rios0rios0/backstage-plugin-code-health-common";
import {
  SONAR_COVERAGE_TARGET,
  computeRate,
  formatCount,
  formatPercent,
} from "@rios0rios0/backstage-plugin-code-health-common";

/** One bar of a ranking chart. */
export interface RankedItem {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  /** Secondary figure shown beside the value, already formatted. */
  readonly detail: string;
  /** Catalog entity to link the label to, when the row resolved to one. */
  readonly entityRef: string | null;
  readonly avatarUrl: string | null;
}

/** One slice of a status breakdown. */
export interface StatusSlice {
  readonly label: string;
  readonly count: number;
  readonly tone: StatusTone;
}

export type StatusTone = "good" | "warning" | "critical" | "unknown";

/** One point of the cadence chart, flattened out of the backend's buckets. */
export interface CadencePoint {
  readonly day: string;
  readonly commits: number;
  readonly pullRequestsMerged: number;
}

/** The headline figures above the charts. */
export interface FleetKpis {
  readonly activeRepositories: number;
  readonly trackedRepositories: number;
  readonly activeContributors: number;
  readonly commits: number;
  readonly pullRequestsMerged: number;
  /**
   * Percentage of pipeline runs that succeeded, over the runs that reached a
   * verdict, or null with none. Cancelled and still-running runs are neither.
   */
  readonly buildSuccessRate: number | null;
  /** Percentage of merged pull requests that carry at least one review. */
  readonly reviewCoverage: number | null;
}

const RANK_SIZE = 5;

const byValueDescending = (left: RankedItem, right: RankedItem): number =>
  right.value - left.value || left.label.localeCompare(right.label);

/**
 * The top {@link RANK_SIZE} rows, dropping anything with nothing to show.
 *
 * Zero-valued rows are filtered rather than padded out: a chart claiming a "top
 * 5" when only two people committed reads as five contributors, three of whom
 * did nothing.
 */
const topOf = (items: readonly RankedItem[]): RankedItem[] =>
  [...items].filter((item) => item.value > 0).sort(byValueDescending).slice(0, RANK_SIZE);

const plural = (count: number, noun: string): string =>
  `${formatCount(count)} ${noun}${count === 1 ? "" : "s"}`;

export const topContributorsByCommits = (
  contributors: readonly ContributorSummary[],
): RankedItem[] =>
  topOf(
    contributors.map((contributor) => ({
      id: contributor.key,
      label: contributor.displayName,
      value: contributor.commits,
      detail: plural(contributor.repositories, "repo"),
      entityRef: contributor.entityRef,
      avatarUrl: contributor.avatarUrl,
    })),
  );

/**
 * Who is reviewing, which is not the same question as who is committing.
 *
 * Review load concentrating on one or two people is the readable form of a bus
 * factor problem, and it is invisible on a commit ranking.
 */
export const topReviewers = (contributors: readonly ContributorSummary[]): RankedItem[] =>
  topOf(
    contributors.map((contributor) => ({
      id: contributor.key,
      label: contributor.displayName,
      value: contributor.reviewsGiven,
      detail: `${formatPercent(contributor.prApprovalRate)} approved`,
      entityRef: contributor.entityRef,
      avatarUrl: contributor.avatarUrl,
    })),
  );

export const topRepositoriesByCommits = (
  repositories: readonly RepositorySummary[],
): RankedItem[] =>
  topOf(
    repositories.map((repository) => ({
      id: repository.id,
      label: repository.name,
      value: repository.activity.commits,
      detail: plural(repository.activity.contributors, "contributor"),
      entityRef: repository.entityRef,
      avatarUrl: null,
    })),
  );

/**
 * Where the fleet stands on its quality gates.
 *
 * Repositories with no Sonar project are counted separately rather than folded
 * into the failures — "not measured" and "measured and failing" call for
 * different actions, and merging them overstates the problem.
 */
export const qualityGateBreakdown = (
  repositories: readonly RepositorySummary[],
): StatusSlice[] => {
  const passing = repositories.filter(
    (repository) => repository.sonarMetrics?.qualityGateStatus === "OK",
  ).length;
  const failing = repositories.filter(
    (repository) => repository.sonarMetrics?.qualityGateStatus === "ERROR",
  ).length;

  return [
    { label: "Passing", count: passing, tone: "good" },
    { label: "Failing", count: failing, tone: "critical" },
    {
      label: "Not measured",
      count: repositories.length - passing - failing,
      tone: "unknown",
    },
  ];
};

/** How much of the fleet meets the branch-protection and build-policy checks. */
export const complianceBreakdown = (
  repositories: readonly RepositorySummary[],
): StatusSlice[] => {
  const count = (color: string) =>
    repositories.filter((repository) => repository.complianceStatus?.color === color).length;

  const compliant = count("green");
  const partial = count("yellow");
  const failing = count("red");

  return [
    { label: "Compliant", count: compliant, tone: "good" },
    { label: "One check missing", count: partial, tone: "warning" },
    { label: "Two or more missing", count: failing, tone: "critical" },
    {
      label: "Not measured",
      count: repositories.length - compliant - partial - failing,
      tone: "unknown",
    },
  ];
};

export const toCadence = (points: readonly TimeSeriesPoint[]): CadencePoint[] =>
  points.map((point) => ({
    day: point.day,
    commits: point.activity.commits,
    pullRequestsMerged: point.activity.pullRequestsMerged,
  }));

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

/**
 * The headline figures.
 *
 * Contributor counts come from the contributors list rather than by adding up
 * `activity.contributors` per repository, which double-counts anyone who worked
 * in more than one.
 */
export const computeKpis = (
  repositories: readonly RepositorySummary[],
  contributors: readonly ContributorSummary[],
): FleetKpis => {
  const succeeded = sum(
    repositories.map((repository) => repository.activity.buildsSucceeded),
  );
  const failed = sum(repositories.map((repository) => repository.activity.buildsFailed));
  // Only the runs that reached a verdict: a run cancelled because a newer push
  // superseded it is neither a success nor a failure, and on a workflow that
  // cancels in-progress runs it would otherwise be most of the denominator.
  const decided = succeeded + failed;
  const merged = sum(
    repositories.map((repository) => repository.activity.pullRequestsMerged),
  );
  const reviews = sum(contributors.map((contributor) => contributor.reviewsGiven));

  return {
    activeRepositories: repositories.filter(
      (repository) => repository.activity.commits > 0,
    ).length,
    trackedRepositories: repositories.length,
    activeContributors: contributors.filter((contributor) => contributor.commits > 0)
      .length,
    commits: sum(repositories.map((repository) => repository.activity.commits)),
    pullRequestsMerged: merged,
    buildSuccessRate: decided > 0 ? computeRate(succeeded, decided) : null,
    // Capped at 100: a pull request can collect more than one review, and a
    // "coverage" figure above 100% is a unit error on its face.
    reviewCoverage: merged > 0 ? Math.min(100, computeRate(reviews, merged)) : null,
  };
};

/**
 * The share a repository has to reach before its coverage stops being a
 * finding. Eighty percent is SonarQube's own default "coverage on new code"
 * gate, so it is the number a team already sees on its quality gate rather
 * than a second target invented here — and the same figure both health scores
 * read, so the Insights tab and a score can never disagree about the target.
 */
export const COVERAGE_TARGET = SONAR_COVERAGE_TARGET;

export interface CoverageStats {
  /** Repositories with a Sonar coverage measure. */
  readonly measured: number;
  readonly tracked: number;
  /** Unweighted mean over the measured repositories, or null with none. */
  readonly average: number | null;
  /** Median, which a handful of empty repositories cannot drag the way a mean can. */
  readonly median: number | null;
  readonly belowTarget: number;
}

const coverageValues = (repositories: readonly RepositorySummary[]): number[] =>
  repositories.flatMap((repository) =>
    repository.sonarMetrics === null ? [] : [repository.sonarMetrics.coverage],
  );

const round = (value: number): number => Math.round(value * 10) / 10;

const medianOf = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : round((sorted[middle - 1] + sorted[middle]) / 2);
};

/**
 * How well the fleet is tested, according to Sonar.
 *
 * The mean is reported *unweighted* — every repository counts once, whatever its
 * size. A weighted mean would be the more honest figure for "how much of our
 * code is covered", but it is not the question this page asks: a hundred-line
 * repository at 0% is a real gap somebody has to close, and weighting would hide
 * it behind one large well-tested service. The median is shown beside it because
 * a mean over a fleet with a long tail of untested repositories says little on
 * its own.
 */
export const coverageStats = (
  repositories: readonly RepositorySummary[],
): CoverageStats => {
  const values = coverageValues(repositories);

  return {
    measured: values.length,
    tracked: repositories.length,
    average:
      values.length === 0 ? null : round(sum(values) / values.length),
    median: medianOf(values),
    belowTarget: values.filter((value) => value < COVERAGE_TARGET).length,
  };
};

/**
 * How coverage is distributed, rather than where its average lands.
 *
 * An average of 62% is the same number whether every repository sits at 62% or
 * half sit at 95% and half at 30%, and those are completely different problems.
 */
export const coverageBreakdown = (
  repositories: readonly RepositorySummary[],
): StatusSlice[] => {
  const values = coverageValues(repositories);
  const between = (low: number, high: number) =>
    values.filter((value) => value >= low && value < high).length;

  return [
    {
      label: `At or above ${COVERAGE_TARGET}%`,
      count: values.filter((value) => value >= COVERAGE_TARGET).length,
      tone: "good",
    },
    { label: `50% to ${COVERAGE_TARGET}%`, count: between(50, COVERAGE_TARGET), tone: "warning" },
    { label: "Below 50%", count: between(-1, 50), tone: "critical" },
    {
      label: "Not measured",
      count: repositories.length - values.length,
      tone: "unknown",
    },
  ];
};

/**
 * The measured repositories with the least coverage.
 *
 * Ascending, and only over repositories Sonar actually measured: sorting the
 * unmeasured ones in as zeroes would fill the chart with repositories that have
 * no Sonar project, which is a different problem with a different fix.
 */
export const lowestCoverageRepositories = (
  repositories: readonly RepositorySummary[],
): RankedItem[] =>
  repositories
    .flatMap((repository) =>
      repository.sonarMetrics === null
        ? []
        : [
            {
              id: repository.id,
              label: repository.name,
              value: repository.sonarMetrics.coverage,
              detail:
                repository.sonarMetrics.qualityGateStatus === "ERROR"
                  ? "gate failing"
                  : plural(repository.sonarMetrics.bugs, "bug"),
              entityRef: repository.entityRef,
              avatarUrl: null,
            },
          ],
    )
    .sort((left, right) => left.value - right.value || left.label.localeCompare(right.label))
    .slice(0, RANK_SIZE);

/** One repository on a gap list, with the reason it is there. */
export interface GapItem {
  readonly id: string;
  readonly label: string;
  readonly entityRef: string | null;
  /** Why the row is listed, already phrased for a reader. */
  readonly reason: string;
}

/** How many rows a gap list shows before it stops and counts the rest. */
export const GAP_LIST_SIZE = 8;

export interface GapList {
  readonly items: readonly GapItem[];
  /** Rows beyond {@link GAP_LIST_SIZE}, so the list never implies it is complete. */
  readonly remaining: number;
}

const toGapList = (items: readonly GapItem[]): GapList => ({
  items: items.slice(0, GAP_LIST_SIZE),
  remaining: Math.max(0, items.length - GAP_LIST_SIZE),
});

const byLabel = (left: GapItem, right: GapItem): number =>
  left.label.localeCompare(right.label);

/**
 * How much of the fleet is documented.
 *
 * "Docs in the repository" is kept apart from "nothing at all" because the two
 * cost completely different amounts to fix: the first is a `techdocs-ref`
 * annotation, the second is somebody sitting down to write.
 */
export const documentationBreakdown = (
  repositories: readonly RepositorySummary[],
): StatusSlice[] => {
  const count = (state: string) =>
    repositories.filter((repository) => repository.documentation?.state === state).length;

  const documented = count("documented");
  const unpublished = count("unpublished");
  const missing = count("missing");

  return [
    { label: "Published to TechDocs", count: documented, tone: "good" },
    { label: "Docs in the repository, not published", count: unpublished, tone: "warning" },
    { label: "No documentation", count: missing, tone: "critical" },
    {
      // The remainder rather than a fourth count: archived repositories and
      // ones the snapshot has not reached yet are both "nobody is being asked
      // to act on this", and keeping them as a residual means the four slices
      // always add up to the fleet.
      label: "Archived or not measured",
      count: repositories.length - documented - unpublished - missing,
      tone: "unknown",
    },
  ];
};

/** Repositories that already write documentation nobody wired into TechDocs. */
export const unpublishedDocumentation = (
  repositories: readonly RepositorySummary[],
): GapList =>
  toGapList(
    repositories
      .filter((repository) => repository.documentation?.state === "unpublished")
      .map((repository) => ({
        id: repository.id,
        label: repository.name,
        entityRef: repository.entityRef,
        reason: repository.documentation?.hasDocsSource
          ? "has a docs/ tree"
          : "links out to documentation",
      }))
      .sort(byLabel),
  );

/** Repositories with no documentation anywhere. */
export const undocumented = (repositories: readonly RepositorySummary[]): GapList =>
  toGapList(
    repositories
      .filter((repository) => repository.documentation?.state === "missing")
      .map((repository) => ({
        id: repository.id,
        label: repository.name,
        entityRef: repository.entityRef,
        reason: repository.documentation?.hasReadme ? "README only" : "nothing found",
      }))
      .sort(byLabel),
  );

/** How much of the fleet describes its APIs to the catalog. */
export const apiExposureBreakdown = (
  repositories: readonly RepositorySummary[],
): StatusSlice[] => {
  const count = (state: string) =>
    repositories.filter((repository) => repository.apiExposure?.state === state).length;

  const declared = count("declared");
  const candidate = count("candidate");
  const expected = count("expected");

  return [
    { label: "Declares an API", count: declared, tone: "good" },
    { label: "Ships a definition, declares none", count: candidate, tone: "critical" },
    { label: "Serves traffic, declares none", count: expected, tone: "warning" },
    {
      label: "No API, or not measured",
      count: repositories.length - declared - candidate - expected,
      tone: "unknown",
    },
  ];
};

/**
 * Repositories that could be an API entity in the catalog and are not.
 *
 * Ones shipping a definition come first: the evidence is in the repository, so
 * the finding is a fact rather than an inference from `spec.type`.
 */
export const apiCandidates = (repositories: readonly RepositorySummary[]): GapList => {
  const gapsFor = (state: string, reason: (path: string | null) => string): GapItem[] =>
    repositories
      .filter((repository) => repository.apiExposure?.state === state)
      .map((repository) => ({
        id: repository.id,
        label: repository.name,
        entityRef: repository.entityRef,
        reason: reason(repository.apiExposure?.definitionPath ?? null),
      }))
      .sort(byLabel);

  return toGapList([
    ...gapsFor("candidate", (path) => (path === null ? "ships a definition" : path)),
    ...gapsFor("expected", () => "typed as a service"),
  ]);
};
