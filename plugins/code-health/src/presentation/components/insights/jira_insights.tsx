import { InfoCard } from "@backstage/core-components";
import Box from "@material-ui/core/Box";
import Grid from "@material-ui/core/Grid";
import Typography from "@material-ui/core/Typography";
import type {
  ContributorSummary,
  RepositorySummary,
} from "@rios0rios0/backstage-plugin-code-health-common";
import {
  formatCount,
  formatDecimal,
  formatHours,
  formatPercent,
} from "@rios0rios0/backstage-plugin-code-health-common";
import type { ReactNode } from "react";
import { useMemo } from "react";
import {
  hasJiraContributorMetrics,
  hasJiraMetrics,
  hasJiraRepositoryMetrics,
  jiraFleetStats,
  jiraFlowBreakdown,
  jiraOpenPriorityRanking,
  jiraResolvedByType,
  staleJiraBacklog,
  topJiraContributorsByInteractions,
  topJiraContributorsByResolved,
} from "../../../domain/entities/jira_insights";
import { GapList } from "../charts/gap_list";
import { RankingChart } from "../charts/ranking_chart";
import { StatTile } from "../charts/stat_tile";
import { StatusBreakdown } from "../charts/status_breakdown";
import { usePersonLink } from "./detail_links";

/**
 * Jira's three card sets, split by what each one is a question about.
 *
 * The delivery figures answer for the fleet and stay on Insights; the two
 * rankings of people sit above the contributors table and the three views of
 * the backlog above the repositories table, beside the rows each of them names.
 *
 * All three are rendered as loose `Grid item` children rather than as one card,
 * so each drops into the page's existing grid instead of building a second page
 * inside the first. Each is mounted only when the backend reports the Jira
 * capability, which is why nothing here checks configuration: a switched off
 * integration never reaches this file at all.
 */

export interface JiraFleetInsightsProps {
  readonly repositories: readonly RepositorySummary[];
  readonly contributors: readonly ContributorSummary[];
}

export interface JiraContributorInsightsProps {
  readonly contributors: readonly ContributorSummary[];
}

export interface JiraRepositoryInsightsProps {
  readonly repositories: readonly RepositorySummary[];
}

/**
 * A nullable figure, grouped, keeping a decimal where it has one.
 *
 * Not {@link formatCount}: throughput is issues per week and reads `7.5`,
 * while the open backlog beside it is a whole number of tickets.
 */
const formatOptional = (value: number | null): string =>
  value === null ? "—" : formatDecimal(value);
const formatOptionalPercent = (value: number | null): string =>
  value === null ? "—" : formatPercent(value);
const formatDuration = (value: number | null): string =>
  value === null ? "—" : formatHours(value);

/**
 * Jira is on and there is nothing to draw yet.
 *
 * Each part says it for itself rather than leaving one tab to explain the other
 * two: a reader looking at a blank Contributors tab should not have to visit
 * Insights to learn that no entity carries an annotation. Cards of em dashes
 * look broken; a sentence naming which of two things is missing is something
 * somebody can act on.
 */
const NothingMeasured = ({ children }: { readonly children: ReactNode }) => (
  <Grid item xs={12}>
    <InfoCard title="Jira">
      <Typography variant="body2" color="textSecondary">
        {children}
      </Typography>
    </InfoCard>
  </Grid>
);

/** What the fleet delivered through Jira, across every project it named. */
export const JiraFleetInsights = ({
  repositories,
  contributors,
}: JiraFleetInsightsProps) => {
  const measured = hasJiraMetrics(repositories, contributors);

  const stats = useMemo(
    () => jiraFleetStats(repositories, contributors),
    [repositories, contributors],
  );
  const byType = useMemo(() => jiraResolvedByType(repositories), [repositories]);

  if (!measured) {
    return (
      <NothingMeasured>
        Jira is configured, but nothing has been measured yet. Repositories are
        scoped to a project by a <code>jira/project-key</code> annotation on their
        catalog entity, and the figures fill in after the next daily snapshot.
      </NothingMeasured>
    );
  }

  return (
    <Grid item xs={12}>
      <InfoCard
        title="Jira delivery"
        subheader={`Across ${formatCount(stats.projects)} ${
          stats.projects === 1 ? "project" : "projects"
        } named by ${formatCount(stats.repositories)} ${
          stats.repositories === 1 ? "repository" : "repositories"
        }.`}
      >
        <Grid container spacing={3}>
          <Grid item xs={6} sm={4} md={2}>
            <StatTile
              label="Closed"
              value={formatCount(stats.issuesResolved)}
              caption={`${formatCount(stats.issuesCreated)} raised`}
              help="Tickets that reached a done status inside the window. A project named by several repositories is counted once, not once per repository."
            />
          </Grid>
          <Grid item xs={6} sm={4} md={2}>
            <StatTile
              label="Throughput"
              value={formatOptional(stats.throughputPerWeek)}
              caption="tickets per week"
              help="Closed tickets per week, summed across the projects. Reported as a rate so windows of different lengths can be compared at all."
            />
          </Grid>
          <Grid item xs={6} sm={4} md={2}>
            <StatTile
              label="Cycle time"
              value={formatDuration(stats.meanCycleHours)}
              caption="start of work to done"
              help="The mean across every measured ticket, not a median. Each project reports its own median, but medians cannot be combined — no arithmetic recovers the fleet's median from a list of them — while the totals behind them add up exactly. The per-repository column shows that project's median."
            />
          </Grid>
          <Grid item xs={6} sm={4} md={2}>
            <StatTile
              label="Lead time"
              value={formatDuration(stats.meanLeadHours)}
              caption="raised to done"
              help="The same mean, measured from when the ticket was created. The gap between this and cycle time is how long work waits before anybody starts it."
            />
          </Grid>
          <Grid item xs={6} sm={4} md={2}>
            <StatTile
              label="Bug ratio"
              value={formatOptionalPercent(stats.bugRatio)}
              caption={`${formatCount(byType.counts.bug)} of ${formatCount(byType.total)} closed`}
              help="The share of closed work that was a defect. Matched on Jira's default type names, so a site that invented its own defect type counts as other work."
            />
          </Grid>
          <Grid item xs={6} sm={4} md={2}>
            <StatTile
              label="Open"
              value={formatOptional(stats.openIssues)}
              caption={`${formatCount(stats.reopened)} reopened in window`}
              help="Tickets not in a done status right now, across every measured project. Deliberately not scoped to the window — a backlog is a present-tense fact."
            />
          </Grid>
        </Grid>
      </InfoCard>
    </Grid>
  );
};

/**
 * Who closes tickets, and who keeps the board moving.
 *
 * Two rankings rather than one, and they only partly overlap on most teams: the
 * gap between them is usually the person doing the work nobody writes code for.
 * Both sit above the contributors table, where each row is the way into that
 * person's page.
 */
export const JiraContributorInsights = ({
  contributors,
}: JiraContributorInsightsProps) => {
  const linkToPerson = usePersonLink();

  const closers = useMemo(
    () => topJiraContributorsByResolved(contributors),
    [contributors],
  );
  const active = useMemo(
    () => topJiraContributorsByInteractions(contributors),
    [contributors],
  );

  if (!hasJiraContributorMetrics(contributors)) {
    return (
      <NothingMeasured>
        Jira is configured, but nobody carries a measurement yet, so there is
        nothing to rank. Repositories are scoped to a project by a{" "}
        <code>jira/project-key</code> annotation on their catalog entity, and a
        person appears here once their Atlassian account has done something in
        one of those projects.
      </NothingMeasured>
    );
  }

  return (
    <>
      <Grid item xs={12} md={6}>
        <InfoCard title="Who closes tickets" subheader="By tickets resolved in the window">
          <RankingChart
            items={closers}
            unit="tickets"
            showAvatars
            linkTo={linkToPerson}
            emptyMessage="No tickets were closed in this window."
          />
        </InfoCard>
      </Grid>

      <Grid item xs={12} md={6}>
        <InfoCard
          title="Who keeps the board moving"
          subheader="Comments, worklog and transitions — the work that closes nothing"
        >
          <RankingChart
            items={active}
            unit="interactions"
            showAvatars
            linkTo={linkToPerson}
            emptyMessage="No Jira activity was recorded in this window."
          />
        </InfoCard>
      </Grid>
    </>
  );
};

/**
 * What each project's backlog looks like right now.
 *
 * All three cards name a project a repository pointed at, so they sit above the
 * repositories table. `GapList` rows keep their catalog links: the annotation
 * that scopes a repository to a project is written on the catalog entity, which
 * is where somebody acting on one of these rows is going.
 */
export const JiraRepositoryInsights = ({
  repositories,
}: JiraRepositoryInsightsProps) => {
  const flow = useMemo(() => jiraFlowBreakdown(repositories), [repositories]);
  const priorities = useMemo(() => jiraOpenPriorityRanking(repositories), [repositories]);
  const stale = useMemo(() => staleJiraBacklog(repositories), [repositories]);

  if (!hasJiraRepositoryMetrics(repositories)) {
    return (
      <NothingMeasured>
        Jira is configured, but no repository names a project yet. Add a{" "}
        <code>jira/project-key</code> annotation to a repository's catalog entity,
        and its backlog fills in after the next daily snapshot.
      </NothingMeasured>
    );
  }

  return (
    <>
      <Grid item xs={12} md={6}>
        <InfoCard
          title="Backlog flow"
          subheader="Whether each project is closing as much as it takes on"
        >
          <StatusBreakdown slices={flow} />
        </InfoCard>
      </Grid>

      <Grid item xs={12} md={6}>
        <InfoCard
          title="Open work by priority"
          subheader="In the site's own severity order, highest first"
        >
          {priorities.length === 0 ? (
            <Box py={2}>
              <Typography variant="body2" color="textSecondary">
                No priority breakdown was collected. It is the first thing a run gives
                up when its request allowance is running low, and a site with more
                priorities than a chart can carry is skipped outright.
              </Typography>
            </Box>
          ) : (
            <RankingChart
              items={priorities}
              unit="open tickets"
              emptyMessage="Nothing is open."
            />
          )}
        </InfoCard>
      </Grid>

      <Grid item xs={12}>
        <InfoCard
          title="Oldest open work"
          subheader="The ticket that has been waiting longest in each project"
        >
          <GapList
            gaps={stale}
            emptyMessage="Nothing is open, or no backlog was measured."
          />
        </InfoCard>
      </Grid>
    </>
  );
};
