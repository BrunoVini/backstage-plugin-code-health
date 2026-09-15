import { ContentHeader, WarningPanel } from "@backstage/core-components";
import Box from "@material-ui/core/Box";
import Grid from "@material-ui/core/Grid";
import type { IntegrationCapabilities } from "@rios0rios0/backstage-plugin-code-health-common";
import type { CodeHealthConfig } from "../../domain/entities/code_health_config";
import type {
  ContributorService,
  DashboardService,
} from "../../domain/services/dashboard_service";
import { BackfillProgress } from "../components/backfill_progress";
import { ContributorsTable } from "../components/contributors_table";
import { DashboardToolbar } from "../components/dashboard_toolbar";
import { ActivityRankings } from "../components/insights/activity_rankings";
import { ConfluenceContributorInsights } from "../components/insights/confluence_insights";
import { JiraContributorInsights } from "../components/insights/jira_insights";
import { WakaTimeContributorInsights } from "../components/insights/wakatime_insights";
import { useAutoRefresh } from "../hooks/use_auto_refresh";
import { useContributors } from "../hooks/use_contributors";
import type { UseCoverageResult } from "../hooks/use_coverage";
import { useRepositories } from "../hooks/use_repositories";
import { useTimeRange } from "../hooks/use_time_range";

interface ContributorsPageProps {
  contributorService: ContributorService;
  /** For the repository ranking shown above the table. */
  dashboardService: DashboardService;
  coverage: UseCoverageResult;
  config: CodeHealthConfig;
  capabilities: IntegrationCapabilities;
  /** Skips fetching, used while the coverage probe is still in flight. */
  enabled?: boolean;
}

/**
 * Who worked, and on what.
 *
 * The rankings above the table are the tab's summary of itself: the table is
 * ordered on one column at a time, so "who committed most" and "who reviewed
 * most" are two different sorts of it that nobody can see at once. Each row is
 * also the way into a person's or a repository's detail page.
 *
 * Every configured integration adds its own ranking of people to the same grid,
 * because coding time, tickets closed and pages written are all answers to the
 * tab's question and none of them is an answer to the fleet's. They are gated
 * on the capability rather than on the data: inferring it from whether a row
 * carries a value cannot tell a switched-off integration from one that is on
 * and has not collected yet.
 */
export const ContributorsPage = ({
  contributorService,
  dashboardService,
  coverage,
  config,
  capabilities,
  enabled = true,
}: ContributorsPageProps) => {
  const range = useTimeRange(coverage.coverage, config.defaultRange);
  const { contributors, isLoading, error, lastFetchedAt } = useContributors(
    contributorService,
    range.window,
    enabled,
  );
  // A second request over the same window, for the repository ranking alone.
  // Its failure is kept apart from the contributors' — the table is the tab's
  // subject, and hiding it because a card could not be filled would lose the
  // page over a corner of it. The card carries the reason instead.
  const repositoryLoad = useRepositories(dashboardService, range.window, enabled);
  // Refreshing re-reads the clock rather than replaying the stored window — see
  // `useTimeRange.advance`.
  const { interval, setInterval } = useAutoRefresh(range.advance, config.refreshIntervalMs);

  return (
    <>
      <ContentHeader title="Contributors">
        <DashboardToolbar
          lastFetchedAt={lastFetchedAt}
          refreshInterval={interval}
          isLoading={isLoading}
          ranges={range.ranges}
          months={range.months}
          selection={range.selection}
          onRangeChange={range.select}
          onRefresh={range.advance}
          onIntervalChange={setInterval}
        />
      </ContentHeader>

      {coverage.coverage && <BackfillProgress coverage={coverage.coverage} />}

      {error && (
        <Box mb={2}>
          <WarningPanel
            severity="error"
            title="Failed to load contributors"
            message={error}
            defaultExpanded
          />
        </Box>
      )}

      <Box mb={3}>
        <Grid container spacing={3}>
          <ActivityRankings
            repositories={repositoryLoad.repositories}
            contributors={contributors}
            repositoriesError={repositoryLoad.error}
          />

          {capabilities.wakatime ? (
            <WakaTimeContributorInsights contributors={contributors} />
          ) : null}

          {capabilities.jira ? (
            <JiraContributorInsights contributors={contributors} />
          ) : null}

          {capabilities.confluence ? (
            <ConfluenceContributorInsights contributors={contributors} />
          ) : null}
        </Grid>
      </Box>

      <ContributorsTable
        window={range.window}
        contributors={contributors}
        totalCount={contributors.length}
        isLoading={isLoading}
        capabilities={capabilities}
      />
    </>
  );
};
