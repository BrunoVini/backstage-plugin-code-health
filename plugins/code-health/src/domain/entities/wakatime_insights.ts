import type {
  ContributorSummary,
  RepositorySummary,
  WakaTimeBreakdownItem,
  WakaTimeSeriesPoint,
} from "@rios0rios0/backstage-plugin-code-health-common";
import {
  aiAuthorshipShare,
  formatCount,
  formatDuration,
  formatPercent,
  mergeBreakdowns,
  mergeDailyTotals,
} from "@rios0rios0/backstage-plugin-code-health-common";
import type { RankedItem } from "./insights";

/** How many rows a WakaTime ranking shows before it stops being readable. */
const RANK_SIZE = 8;

/** The headline coding-time figures. */
export interface WakaTimeKpis {
  readonly totalSeconds: number;
  /** People who logged any time at all in the window. */
  readonly measuredContributors: number;
  /** Mean seconds per person who logged any, or null when nobody did. */
  readonly averageSecondsPerContributor: number | null;
  /** The language the fleet spent most of its time in. */
  readonly topLanguage: WakaTimeBreakdownItem | null;
  readonly topEditor: WakaTimeBreakdownItem | null;
  /**
   * Share of added lines WakaTime attributed to AI, or null when no row
   * collected the figure at all.
   *
   * Null rather than zero for the reason it is null everywhere else here:
   * "nobody has the AI collection switched on" and "everybody writes their own
   * code" are different answers, and only one of them is about the team.
   */
  readonly aiAuthorshipPercent: number | null;
  readonly aiTokens: number | null;
}

const withMetrics = (contributors: readonly ContributorSummary[]) =>
  contributors.flatMap((contributor) =>
    contributor.wakaTimeMetrics === null
      ? []
      : [{ contributor, metrics: contributor.wakaTimeMetrics }],
  );

export const wakaTimeKpis = (contributors: readonly ContributorSummary[]): WakaTimeKpis => {
  const measured = withMetrics(contributors);
  const totalSeconds = measured.reduce((total, row) => total + row.metrics.totalSeconds, 0);

  // Only people who logged something count towards the average. Dividing by
  // everybody who committed would report a team average that falls whenever
  // somebody without WakaTime installed pushes a commit, which says nothing
  // about how the team works.
  const active = measured.filter((row) => row.metrics.totalSeconds > 0);

  const languages = mergeBreakdowns(measured.map((row) => row.metrics.languages));
  const editors = mergeBreakdowns(measured.map((row) => row.metrics.editors));

  const ai = measured.flatMap((row) => (row.metrics.ai === null ? [] : [row.metrics.ai]));
  const addedByAi = ai.reduce((total, metrics) => total + metrics.linesAddedByAi, 0);
  const addedByHuman = ai.reduce((total, metrics) => total + metrics.linesAddedByHuman, 0);
  const tokens = ai.reduce(
    (total, metrics) => total + metrics.inputTokens + metrics.outputTokens,
    0,
  );

  return {
    totalSeconds,
    measuredContributors: active.length,
    averageSecondsPerContributor:
      active.length === 0 ? null : Math.round(totalSeconds / active.length),
    topLanguage: languages[0] ?? null,
    topEditor: editors[0] ?? null,
    aiAuthorshipPercent:
      ai.length === 0
        ? null
        : aiAuthorshipShare({
            inputTokens: 0,
            outputTokens: 0,
            linesAddedByAi: addedByAi,
            linesDeletedByAi: 0,
            linesAddedByHuman: addedByHuman,
            linesDeletedByHuman: 0,
            prompts: 0,
            sessions: 0,
            modelCosts: {},
            daysMeasured: ai.length,
          }),
    aiTokens: ai.length === 0 ? null : tokens,
  };
};

const toRanking = (
  items: readonly WakaTimeBreakdownItem[],
  total: number,
): RankedItem[] =>
  items
    .filter((item) => item.totalSeconds > 0)
    .slice(0, RANK_SIZE)
    .map((item) => ({
      id: item.name,
      label: item.name,
      value: item.totalSeconds,
      detail: total === 0 ? "" : formatPercent((item.totalSeconds / total) * 100),
      entityRef: null,
      avatarUrl: null,
    }));

const breakdownRanking = (
  contributors: readonly ContributorSummary[],
  select: (metrics: NonNullable<ContributorSummary["wakaTimeMetrics"]>) => readonly WakaTimeBreakdownItem[],
): RankedItem[] => {
  const merged = mergeBreakdowns(withMetrics(contributors).map((row) => select(row.metrics)));
  const total = merged.reduce((sum, item) => sum + item.totalSeconds, 0);
  return toRanking(merged, total);
};

/** Where the fleet's time goes, by language. */
export const languageBreakdown = (contributors: readonly ContributorSummary[]): RankedItem[] =>
  breakdownRanking(contributors, (metrics) => metrics.languages);

export const editorBreakdown = (contributors: readonly ContributorSummary[]): RankedItem[] =>
  breakdownRanking(contributors, (metrics) => metrics.editors);

/**
 * What kind of work the time went into — coding, code reviewing, debugging,
 * writing tests, browsing.
 *
 * The most interesting of the three breakdowns and the one nothing else in the
 * plugin can answer: a version control provider sees the commit, never the four
 * hours of debugging that preceded it.
 */
export const categoryBreakdown = (contributors: readonly ContributorSummary[]): RankedItem[] =>
  breakdownRanking(contributors, (metrics) => metrics.categories);

/** Who logged the most coding time, which is not the same as who committed most. */
export const topContributorsByCodingTime = (
  contributors: readonly ContributorSummary[],
): RankedItem[] =>
  withMetrics(contributors)
    .filter((row) => row.metrics.totalSeconds > 0)
    .sort((left, right) => right.metrics.totalSeconds - left.metrics.totalSeconds)
    .slice(0, RANK_SIZE)
    .map(({ contributor, metrics }) => ({
      id: contributor.key,
      label: contributor.displayName,
      value: metrics.totalSeconds,
      detail: `${formatCount(metrics.activeDays)} active ${
        metrics.activeDays === 1 ? "day" : "days"
      }`,
      entityRef: contributor.entityRef,
      avatarUrl: contributor.avatarUrl,
    }));

/** Which repositories the fleet's time went into. */
export const topRepositoriesByCodingTime = (
  repositories: readonly RepositorySummary[],
): RankedItem[] =>
  repositories
    .flatMap((repository) =>
      repository.wakaTimeMetrics === null || repository.wakaTimeMetrics.totalSeconds === 0
        ? []
        : [{ repository, metrics: repository.wakaTimeMetrics }],
    )
    .sort((left, right) => right.metrics.totalSeconds - left.metrics.totalSeconds)
    .slice(0, RANK_SIZE)
    .map(({ repository, metrics }) => ({
      id: repository.id,
      label: repository.name,
      value: metrics.totalSeconds,
      detail: `${formatCount(metrics.contributors)} ${
        metrics.contributors === 1 ? "person" : "people"
      }`,
      entityRef: repository.entityRef,
      avatarUrl: null,
    }));

/**
 * The fleet's coding time per day.
 *
 * Summed in the browser from the day series each contributor already carries,
 * rather than asked for separately. That series exists because merging stored
 * days correctly needs it anyway, so the trend costs nothing extra.
 */
export const codingTimeSeries = (
  contributors: readonly ContributorSummary[],
): WakaTimeSeriesPoint[] => {
  const measured = withMetrics(contributors);
  const totals = mergeDailyTotals(measured.map((row) => row.metrics.daily));

  const contributorsByDay = new Map<string, number>();
  for (const row of measured) {
    for (const point of row.metrics.daily) {
      if (point.totalSeconds <= 0) continue;
      contributorsByDay.set(point.day, (contributorsByDay.get(point.day) ?? 0) + 1);
    }
  }

  return totals.map((point) => ({
    day: point.day,
    totalSeconds: point.totalSeconds,
    contributors: contributorsByDay.get(point.day) ?? 0,
  }));
};

/** Coding time as a duration, or an em dash when there is nothing to show. */
export const formatOptionalDuration = (totalSeconds: number | null): string =>
  totalSeconds === null ? "—" : formatDuration(totalSeconds);
