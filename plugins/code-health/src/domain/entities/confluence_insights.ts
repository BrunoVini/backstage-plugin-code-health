import type {
  ConfluenceAnalyticsState,
  ConfluenceContributorMetrics,
  ConfluenceSpaceMetrics,
  ConfluenceVolumeUnit,
  ContributorSummary,
  RepositorySummary,
} from "@rios0rios0/backstage-plugin-code-health-common";
import {
  confluenceContributions,
  confluenceStaleShare,
  formatCount,
  formatPercent,
} from "@rios0rios0/backstage-plugin-code-health-common";
import type { GapItem, GapList, RankedItem, StatusSlice } from "./insights";
import { GAP_LIST_SIZE } from "./insights";

/**
 * The Confluence payload on a contributor row.
 *
 * Read through an accessor so that "the backend has Confluence switched off"
 * and "Confluence is on and this person wrote nothing" resolve to the same
 * null in one place, and every caller below renders an em dash rather than a
 * zero without having to remember to.
 */
type WithContributorMetrics = {
  readonly confluenceMetrics?: ConfluenceContributorMetrics | null;
};

type WithSpaceMetrics = {
  readonly confluenceMetrics?: ConfluenceSpaceMetrics | null;
};

export const contributorConfluence = (
  row: ContributorSummary & WithContributorMetrics,
): ConfluenceContributorMetrics | null => row.confluenceMetrics ?? null;

export const repositoryConfluence = (
  row: RepositorySummary & WithSpaceMetrics,
): ConfluenceSpaceMetrics | null => row.confluenceMetrics ?? null;

/** The headline figures above the Confluence cards. */
export interface ConfluenceFleetStats {
  /** Spaces named by a catalog entity and measured. */
  readonly spaces: number;
  readonly pagesCreated: number;
  readonly pagesEdited: number;
  readonly blogPostsCreated: number;
  readonly commentsWritten: number;
  readonly attachmentsAdded: number;
  /** People who did anything in Confluence inside the window. */
  readonly authors: number;
  /** Null when nobody's volume could be measured; never 0 for that case. */
  readonly wordsAdded: number | null;
  readonly wordsRemoved: number | null;
  readonly volumeUnit: ConfluenceVolumeUnit;
  readonly pageViews: number | null;
  readonly analytics: ConfluenceAnalyticsState;
  /** Pages nobody has edited for at least the configured staleness period. */
  readonly stalePages: number | null;
  readonly totalPages: number | null;
}

const RANK_SIZE = 5;

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

const byValueDescending = (left: RankedItem, right: RankedItem): number =>
  right.value - left.value || left.label.localeCompare(right.label);

/**
 * The top rows, dropping anything with nothing to show.
 *
 * Zero-valued rows are filtered rather than padded out, matching the fleet
 * rankings: a chart claiming a "top 5" when only two people wrote anything
 * reads as five contributors, three of whom did nothing.
 */
const topOf = (items: readonly RankedItem[]): RankedItem[] =>
  [...items].filter((item) => item.value > 0).sort(byValueDescending).slice(0, RANK_SIZE);

const toGapList = (items: readonly GapItem[]): GapList => ({
  items: items.slice(0, GAP_LIST_SIZE),
  remaining: Math.max(0, items.length - GAP_LIST_SIZE),
});

const metricsOf = (
  contributors: readonly (ContributorSummary & WithContributorMetrics)[],
): readonly ConfluenceContributorMetrics[] =>
  contributors.flatMap((contributor) => {
    const metrics = contributorConfluence(contributor);
    return metrics === null ? [] : [metrics];
  });

const spacesOf = (
  repositories: readonly (RepositorySummary & WithSpaceMetrics)[],
): readonly ConfluenceSpaceMetrics[] => {
  // De-duplicated by space key. Two components documented in one space carry
  // the same payload, and adding it twice would report a fleet writing twice
  // as much as it does.
  const unique = new Map<string, ConfluenceSpaceMetrics>();
  for (const repository of repositories) {
    const metrics = repositoryConfluence(repository);
    if (metrics === null) continue;
    unique.set(metrics.space.key.toLowerCase(), metrics);
  }
  return [...unique.values()];
};

/**
 * The stronger of two analytics verdicts, folded over the fleet.
 *
 * One site serves every space, so a single "measured" anywhere means the plan
 * allows it and any remaining nulls are a budget question rather than a plan
 * one. A refusal outranks never having asked, because only a refusal is worth
 * explaining on screen.
 */
const foldAnalytics = (
  states: readonly ConfluenceAnalyticsState[],
): ConfluenceAnalyticsState => {
  if (states.includes("measured")) return "measured";
  if (states.includes("unavailable")) return "unavailable";
  return "not-measured";
};

/** Sums the sides that were measured, staying null when none were. */
const sumMeasured = (values: readonly (number | null)[]): number | null => {
  const measured = values.filter((value): value is number => value !== null);
  return measured.length === 0 ? null : sum(measured);
};

export const confluenceFleetStats = (
  repositories: readonly (RepositorySummary & WithSpaceMetrics)[],
  contributors: readonly (ContributorSummary & WithContributorMetrics)[],
): ConfluenceFleetStats => {
  const people = metricsOf(contributors);
  const spaces = spacesOf(repositories);
  const wordsAdded = sumMeasured(people.map((metrics) => metrics.wordsAdded));

  return {
    spaces: spaces.length,
    // From the spaces rather than from the people, because a space count is an
    // exact CQL total while a per-person count only covers whoever the sweep
    // reached before its cap.
    pagesCreated: sum(spaces.map((metrics) => metrics.pagesCreated)),
    pagesEdited: sum(spaces.map((metrics) => metrics.pagesEdited)),
    blogPostsCreated: sum(spaces.map((metrics) => metrics.blogPostsCreated)),
    commentsWritten: sum(spaces.map((metrics) => metrics.commentsWritten)),
    attachmentsAdded: sum(spaces.map((metrics) => metrics.attachmentsAdded)),
    authors: people.filter((metrics) => confluenceContributions(metrics) > 0).length,
    wordsAdded,
    wordsRemoved: sumMeasured(people.map((metrics) => metrics.wordsRemoved)),
    volumeUnit: wordsAdded === null ? "none" : "words",
    pageViews: sumMeasured(people.map((metrics) => metrics.pageViews)),
    analytics: foldAnalytics([
      ...people.map((metrics) => metrics.analytics),
      ...spaces.map((metrics) => metrics.analytics),
    ]),
    stalePages: sumMeasured(spaces.map((metrics) => metrics.stalePages)),
    totalPages: sumMeasured(spaces.map((metrics) => metrics.totalPages)),
  };
};

/**
 * Who is doing the documenting.
 *
 * Ranked on every kind of contribution added together rather than on pages
 * alone: a person who spends a quarter reviewing and correcting other people's
 * runbooks writes very few pages and is doing exactly the work this card exists
 * to make visible.
 */
export const topConfluenceAuthors = (
  contributors: readonly (ContributorSummary & WithContributorMetrics)[],
): RankedItem[] =>
  topOf(
    contributors.flatMap((contributor) => {
      const metrics = contributorConfluence(contributor);
      if (metrics === null) return [];

      return [
        {
          id: contributor.key,
          label: contributor.displayName,
          value: confluenceContributions(metrics),
          detail: `${formatCount(metrics.pagesCreated)} created`,
          entityRef: contributor.entityRef,
          avatarUrl: contributor.avatarUrl,
        },
      ];
    }),
  );

/**
 * Who wrote the most, by volume.
 *
 * Only over people whose volume was actually measured. Ranking an unmeasured
 * person as zero would put them below somebody who deleted a paragraph, which
 * is a statement the data does not support.
 */
export const topConfluenceWriters = (
  contributors: readonly (ContributorSummary & WithContributorMetrics)[],
): RankedItem[] =>
  topOf(
    contributors.flatMap((contributor) => {
      const metrics = contributorConfluence(contributor);
      if (metrics === null || metrics.wordsAdded === null) return [];

      return [
        {
          id: contributor.key,
          label: contributor.displayName,
          value: metrics.wordsAdded,
          detail: `${formatCount(metrics.pagesMeasuredForVolume)} pages measured`,
          entityRef: contributor.entityRef,
          avatarUrl: contributor.avatarUrl,
        },
      ];
    }),
  );

/**
 * The share of a space that has gone stale, above which it is a finding.
 *
 * A third is not a rule of thumb from anywhere in particular; it is the point
 * at which a reader arriving in a space is more likely than not to hit
 * something out of date within their first few clicks, which is when a team
 * stops trusting the space at all.
 */
export const STALE_SPACE_TARGET = 33;

/**
 * How much of the documented fleet has rotted.
 *
 * Split rather than averaged, for the same reason coverage is: a fleet at 25%
 * stale on average could be every space slightly neglected or two spaces
 * abandoned, and those are different conversations with different teams.
 */
export const spaceFreshnessBreakdown = (
  repositories: readonly (RepositorySummary & WithSpaceMetrics)[],
): StatusSlice[] => {
  const spaces = spacesOf(repositories);
  const shares = spaces.flatMap((metrics) => {
    const share = confluenceStaleShare(metrics);
    return share === null ? [] : [share];
  });

  const fresh = shares.filter((share) => share < 10).length;
  const ageing = shares.filter(
    (share) => share >= 10 && share < STALE_SPACE_TARGET,
  ).length;
  const rotting = shares.filter((share) => share >= STALE_SPACE_TARGET).length;

  return [
    { label: "Mostly current", count: fresh, tone: "good" },
    { label: "Ageing", count: ageing, tone: "warning" },
    { label: `Over ${STALE_SPACE_TARGET}% stale`, count: rotting, tone: "critical" },
    {
      // The remainder rather than a fourth count, so the four slices always add
      // up to the spaces the catalog names.
      label: "Not measured",
      count: spaces.length - fresh - ageing - rotting,
      tone: "unknown",
    },
  ];
};

const dateOnly = (instant: string | null): string =>
  instant === null ? "never edited" : instant.slice(0, 10);

/**
 * The spaces carrying the most rot, by name.
 *
 * A bar says how many pages went stale; this says where, because "four hundred
 * stale pages" is not something anybody can act on until they know which space
 * to open. Each row carries the oldest page in it, which is the one somebody
 * should read first.
 */
export const stalestSpaces = (
  repositories: readonly (RepositorySummary & WithSpaceMetrics)[],
): GapList =>
  toGapList(
    spacesOf(repositories)
      .flatMap<GapItem & { readonly share: number }>((metrics) => {
        const share = confluenceStaleShare(metrics);
        if (share === null || share <= 0) return [];

        return [
          {
            id: metrics.space.key,
            label: metrics.space.name ?? metrics.space.key,
            // The space is not a catalog entity, so there is nothing to link
            // the label to. The card links out to Confluence instead.
            entityRef: null,
            reason:
              metrics.stalestPage === null
                ? `${formatPercent(share)} stale`
                : `${formatPercent(share)} stale · oldest ${dateOnly(
                    metrics.stalestPage.lastModifiedAt,
                  )}`,
            share,
          },
        ];
      })
      .sort((left, right) => right.share - left.share || left.label.localeCompare(right.label))
      .map(({ share: _share, ...item }) => item),
  );

/**
 * Spaces where pages hang off nothing.
 *
 * A parentless page is unreachable by browsing — somebody has to already know
 * the URL — which is the cheapest documentation gap there is to close and the
 * one nobody notices, because the person who wrote it has the link.
 */
export const strandedPages = (
  repositories: readonly (RepositorySummary & WithSpaceMetrics)[],
): GapList =>
  toGapList(
    spacesOf(repositories)
      .flatMap<GapItem>((metrics) =>
        metrics.parentlessPages === null || metrics.parentlessPages === 0
          ? []
          : [
              {
                id: metrics.space.key,
                label: metrics.space.name ?? metrics.space.key,
                entityRef: null,
                reason: `${formatCount(metrics.parentlessPages)} with no parent`,
              },
            ],
      )
      .sort((left, right) => left.label.localeCompare(right.label)),
  );
