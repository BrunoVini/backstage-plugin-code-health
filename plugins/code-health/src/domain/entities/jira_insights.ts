import type {
  ContributorSummary,
  JiraIssueTypeCounts,
  JiraRepositoryMetrics,
  RepositorySummary,
} from "@rios0rios0/backstage-plugin-code-health-common";
import {
  EMPTY_JIRA_ISSUE_TYPES,
  addIssueTypeCounts,
  computeBugRatio,
  formatCount,
  formatPercent,
  interactionTotal,
  meanHours,
  totalIssueTypes,
} from "@rios0rios0/backstage-plugin-code-health-common";
import type { GapItem, GapList, RankedItem, StatusSlice } from "./insights";
import { GAP_LIST_SIZE } from "./insights";

/**
 * The Jira half of the Insights tab, computed without touching React.
 *
 * Kept apart from `insights.ts` rather than added to it because every function
 * here is dead weight on an installation with no Atlassian credential — the
 * card that calls them is only mounted when the backend says the integration is
 * on, and a fleet aggregate is exactly the kind of thing that quietly starts
 * dividing by zero when nobody configured the thing it aggregates.
 */

const RANK_SIZE = 5;

const byValueDescending = (left: RankedItem, right: RankedItem): number =>
  right.value - left.value || left.label.localeCompare(right.label);

/**
 * The top {@link RANK_SIZE} rows, dropping anything with nothing to show.
 *
 * Reimplemented rather than imported because `insights.ts` keeps its copy
 * private; the behaviour is deliberately identical, so the Jira rankings and
 * the commit rankings on the same page cannot disagree about what "top five"
 * means. A chart claiming a top five when only two people closed anything reads
 * as five people, three of whom did nothing.
 */
const topOf = (items: readonly RankedItem[]): RankedItem[] =>
  [...items].filter((item) => item.value > 0).sort(byValueDescending).slice(0, RANK_SIZE);

const toGapList = (items: readonly GapItem[]): GapList => ({
  items: items.slice(0, GAP_LIST_SIZE),
  remaining: Math.max(0, items.length - GAP_LIST_SIZE),
});

/**
 * One measurement per Jira project, not one per repository.
 *
 * The backend measures a project once and hands the same value to every
 * repository whose catalog entity names it — which is what stops forty
 * repositories in one project from issuing forty identical queries. The
 * consequence lands here: adding `issuesResolved` across repositories would
 * count a shared project once per repository and report a team closing four
 * times the tickets it closed.
 *
 * Deduplicated on the project and component the measurement itself names rather
 * than on object identity, so the arithmetic stays right even if the API layer
 * ever stops sharing one object between rows.
 */
export const distinctJiraProjects = (
  repositories: readonly RepositorySummary[],
): JiraRepositoryMetrics[] => {
  const byProject = new Map<string, JiraRepositoryMetrics>();

  for (const repository of repositories) {
    const metrics = repository.jiraMetrics;
    if (metrics === null) continue;
    const key = `${metrics.projectKey.toUpperCase()}::${metrics.component?.toLowerCase() ?? ""}`;
    if (!byProject.has(key)) byProject.set(key, metrics);
  }

  return [...byProject.values()];
};

/**
 * Whether any repository names a Jira project the backend could measure.
 *
 * Asked on its own by the cards that are built from repository metrics alone.
 * They live on the Repositories tab, which never fetches contributors, so
 * "somebody commented on a ticket" is not an answer available to them — and it
 * would not fill a backlog chart even if it were.
 */
export const hasJiraRepositoryMetrics = (
  repositories: readonly RepositorySummary[],
): boolean => repositories.some((repository) => repository.jiraMetrics !== null);

/** Whether anybody carries a Jira measurement, for the rankings of people. */
export const hasJiraContributorMetrics = (
  contributors: readonly ContributorSummary[],
): boolean => contributors.some((contributor) => contributor.jiraMetrics !== null);

/** Whether anything on the page has a Jira measurement to show at all. */
export const hasJiraMetrics = (
  repositories: readonly RepositorySummary[],
  contributors: readonly ContributorSummary[],
): boolean =>
  hasJiraRepositoryMetrics(repositories) || hasJiraContributorMetrics(contributors);

export interface JiraFleetStats {
  /** Jira projects the catalog pointed at and the backend could measure. */
  readonly projects: number;
  readonly repositories: number;
  /** People with any Jira measurement, which is not the same as committers. */
  readonly people: number;
  readonly issuesCreated: number;
  readonly issuesResolved: number;
  readonly throughputPerWeek: number | null;
  readonly openIssues: number | null;
  readonly bugRatio: number | null;
  readonly reopened: number;
  /**
   * Mean hours from the start of work to done, across every measured issue.
   *
   * A mean and not a median, and that is a decision rather than an oversight:
   * medians do not combine. Each project reports its own median, and there is
   * no arithmetic that recovers the fleet's median from a list of them — but
   * the totals each project carries beside it do add up, so this figure is the
   * exact mean of the union. The per-repository column still shows that
   * repository's median, where it is meaningful.
   */
  readonly meanCycleHours: number | null;
  readonly meanLeadHours: number | null;
  readonly storyPointsCompleted: number | null;
}

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

/**
 * Adds two nullable totals, treating null as "not measured".
 *
 * One project with a story-point field and one without is a fleet that
 * completed at least the points the first one reports — not a fleet nobody can
 * say anything about. Only when no project measured it does the total stay
 * null, and only then does the tile show an em dash.
 */
const addNullable = (left: number | null, right: number | null): number | null => {
  if (left === null) return right;
  if (right === null) return left;
  return left + right;
};

export const jiraFleetStats = (
  repositories: readonly RepositorySummary[],
  contributors: readonly ContributorSummary[],
): JiraFleetStats => {
  const projects = distinctJiraProjects(repositories);

  const cycleHours = sum(projects.map((project) => project.cycleTime?.totalHours ?? 0));
  const cycleIssues = sum(projects.map((project) => project.cycleTime?.issues ?? 0));
  const leadHours = sum(projects.map((project) => project.leadTime?.totalHours ?? 0));
  const leadIssues = sum(projects.map((project) => project.leadTime?.issues ?? 0));

  const resolvedByType = projects.reduce<JiraIssueTypeCounts>(
    (counts, project) => addIssueTypeCounts(counts, project.resolvedByType),
    EMPTY_JIRA_ISSUE_TYPES,
  );

  const openIssues = projects.reduce<number | null>(
    (total, project) => addNullable(total, project.openIssues),
    null,
  );

  const resolved = sum(projects.map((project) => project.issuesResolved));
  const throughput = projects.flatMap((project) =>
    project.throughputPerWeek === null ? [] : [project.throughputPerWeek],
  );

  return {
    projects: projects.length,
    repositories: repositories.filter((repository) => repository.jiraMetrics !== null).length,
    people: contributors.filter((contributor) => contributor.jiraMetrics !== null).length,
    issuesCreated: sum(projects.map((project) => project.issuesCreated)),
    issuesResolved: resolved,
    // Summed, not averaged: each project's rate is issues per week, and the
    // fleet ships the sum of what its projects ship.
    throughputPerWeek:
      throughput.length === 0 ? null : Math.round(sum(throughput) * 10) / 10,
    openIssues,
    bugRatio: computeBugRatio(resolvedByType),
    reopened: sum(projects.map((project) => project.reopened)),
    meanCycleHours: meanHours({ totalHours: cycleHours, issues: cycleIssues }),
    meanLeadHours: meanHours({ totalHours: leadHours, issues: leadIssues }),
    storyPointsCompleted: projects.reduce<number | null>(
      (total, project) => addNullable(total, project.storyPointsCompleted),
      null,
    ),
  };
};

/**
 * Who closes tickets.
 *
 * Deliberately a different question from who commits: on most teams the two
 * rankings only partly overlap, and the gap between them is usually the person
 * doing the work nobody writes code for.
 */
export const topJiraContributorsByResolved = (
  contributors: readonly ContributorSummary[],
): RankedItem[] =>
  topOf(
    contributors.flatMap((contributor) => {
      const metrics = contributor.jiraMetrics;
      if (metrics === null) return [];
      return [
        {
          id: contributor.key,
          label: contributor.displayName,
          value: metrics.issuesResolved,
          detail: `${formatCount(metrics.issuesCreated)} raised`,
          entityRef: contributor.entityRef,
          avatarUrl: contributor.avatarUrl,
        },
      ];
    }),
  );

/**
 * Who is doing the talking, the booking and the board-moving.
 *
 * Worth its own chart because it is the half of Jira work that closing counts
 * miss entirely: the person who triages, comments and keeps the board honest
 * can close almost nothing and still be the reason the project moves.
 */
export const topJiraContributorsByInteractions = (
  contributors: readonly ContributorSummary[],
): RankedItem[] =>
  topOf(
    contributors.flatMap((contributor) => {
      const metrics = contributor.jiraMetrics;
      if (metrics === null) return [];
      const total = interactionTotal(metrics.interactions);
      return [
        {
          id: contributor.key,
          label: contributor.displayName,
          value: total,
          detail: `${formatCount(metrics.interactions.transitions)} transitions`,
          entityRef: contributor.entityRef,
          avatarUrl: contributor.avatarUrl,
        },
      ];
    }),
  );

/**
 * Whether the fleet's backlogs are growing or shrinking.
 *
 * The one Jira question with a genuinely tonal answer, which is why it is the
 * breakdown on this card rather than an issue-type mix: red and green mean
 * something for "the queue is getting longer" and mean nothing at all for
 * "these were stories and those were tasks". A project that saw no tickets in
 * the window is kept apart from both, because a quiet project is not a healthy
 * one and it is not a failing one either.
 */
export const jiraFlowBreakdown = (
  repositories: readonly RepositorySummary[],
): StatusSlice[] => {
  const projects = distinctJiraProjects(repositories);
  const active = projects.filter(
    (project) => project.issuesCreated > 0 || project.issuesResolved > 0,
  );

  const keepingUp = active.filter(
    (project) => project.issuesResolved >= project.issuesCreated,
  ).length;

  return [
    { label: "Closing at least as much as they open", count: keepingUp, tone: "good" },
    {
      label: "Opening more than they close",
      count: active.length - keepingUp,
      tone: "critical",
    },
    {
      // The residual rather than a fourth count, so the slices always add up to
      // the projects the catalog actually pointed at.
      label: "No tickets in the window",
      count: projects.length - active.length,
      tone: "unknown",
    },
  ];
};

/**
 * The open backlog by priority, in the site's own severity order.
 *
 * The order is Jira's, not this plugin's: the priority endpoint returns
 * priorities from highest to lowest and the backend preserves that order, so
 * the first bar is the site's most severe priority whatever it decided to call
 * it. Nothing here is coloured by severity — a name like `P2` or `Major` says
 * nothing a palette could be derived from without guessing at somebody else's
 * taxonomy, and a wrong guess would paint a healthy backlog red.
 */
export const jiraOpenPriorityRanking = (
  repositories: readonly RepositorySummary[],
): RankedItem[] => {
  const totals = new Map<string, number>();

  for (const project of distinctJiraProjects(repositories)) {
    for (const priority of project.openByPriority) {
      totals.set(priority.name, (totals.get(priority.name) ?? 0) + priority.count);
    }
  }

  const grandTotal = sum([...totals.values()]);

  return [...totals.entries()].map(([name, count]) => ({
    id: name,
    label: name,
    value: count,
    detail:
      grandTotal === 0
        ? ""
        : `${formatPercent((count / grandTotal) * 100, 0)} of the backlog`,
    entityRef: null,
    avatarUrl: null,
  }));
};

/**
 * The repositories sitting on the oldest unfinished work.
 *
 * A backlog size says how much; this says what has been waiting longest, which
 * is the row somebody can actually pick up. The age is the one figure on the
 * card that is not scoped to the window — a ticket opened last March is old
 * whatever period the picker is showing.
 */
export const staleJiraBacklog = (repositories: readonly RepositorySummary[]): GapList =>
  toGapList(
    repositories
      .flatMap((repository) => {
        const oldest = repository.jiraMetrics?.oldestOpenIssue ?? null;
        if (oldest === null) return [];
        return [
          {
            id: repository.id,
            label: repository.name,
            entityRef: repository.entityRef,
            reason: `${oldest.key} · ${formatCount(oldest.ageDays)}d`,
            ageDays: oldest.ageDays,
          },
        ];
      })
      .sort((left, right) => right.ageDays - left.ageDays || left.label.localeCompare(right.label))
      .map(({ ageDays: _ageDays, ...item }) => item),
  );

/**
 * How much of the closed work was defect work.
 *
 * Exposed separately from {@link jiraFleetStats} so a card can list the counts
 * behind the ratio: "18% bugs" is a very different conversation when it is 2 of
 * 11 than when it is 180 of 1000, and a percentage with no denominator invites
 * the wrong one.
 */
export const jiraResolvedByType = (
  repositories: readonly RepositorySummary[],
): { counts: JiraIssueTypeCounts; total: number } => {
  const counts = distinctJiraProjects(repositories).reduce<JiraIssueTypeCounts>(
    (running, project) => addIssueTypeCounts(running, project.resolvedByType),
    EMPTY_JIRA_ISSUE_TYPES,
  );
  return { counts, total: totalIssueTypes(counts) };
};
