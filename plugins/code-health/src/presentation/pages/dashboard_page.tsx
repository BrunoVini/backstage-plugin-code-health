import { ContentHeader, WarningPanel } from "@backstage/core-components";
import Box from "@material-ui/core/Box";
import Grid from "@material-ui/core/Grid";
import type { IntegrationCapabilities } from "@rios0rios0/backstage-plugin-code-health-common";
import type { CodeHealthConfig } from "../../domain/entities/code_health_config";
import type { DashboardService } from "../../domain/services/dashboard_service";
import { BackfillProgress } from "../components/backfill_progress";
import { DashboardToolbar } from "../components/dashboard_toolbar";
import { ConfluenceRepositoryInsights } from "../components/insights/confluence_insights";
import { JiraRepositoryInsights } from "../components/insights/jira_insights";
import { RepositoryAudits } from "../components/insights/repository_audits";
import { WakaTimeRepositoryInsights } from "../components/insights/wakatime_insights";
import { RepositoryTable } from "../components/repository_table";
import { useAutoRefresh } from "../hooks/use_auto_refresh";
import type { UseCoverageResult } from "../hooks/use_coverage";
import { useRepositories } from "../hooks/use_repositories";
import { useTimeRange } from "../hooks/use_time_range";

interface DashboardPageProps {
  dashboardService: DashboardService;
  coverage: UseCoverageResult;
  config: CodeHealthConfig;
  capabilities: IntegrationCapabilities;
  /** Skips fetching, used while the coverage probe is still in flight. */
  enabled?: boolean;
}

/**
 * Every tracked repository, with the audits that name one.
 *
 * The audits sit above the table because each of their rows is a repository the
 * reader is about to look up in it, and because all three are closed by editing
 * a repository or its catalog entity rather than by anything the fleet does.
 *
 * Every configured integration adds what it knows about a repository to the
 * same grid, on the same terms: coding time by repository, a backlog scoped to
 * a project a repository named, a space a repository's entity pointed at. They
 * are gated on the capability rather than on the data, so a freshly configured
 * integration reads as one that has not collected yet rather than as broken.
 */
export const DashboardPage = ({
  dashboardService,
  coverage,
  config,
  capabilities,
  enabled = true,
}: DashboardPageProps) => {
  const range = useTimeRange(coverage.coverage, config.defaultRange);
  const { repositories, isLoading, error, lastFetchedAt } = useRepositories(
    dashboardService,
    range.window,
    enabled,
  );
  // Refreshing re-reads the clock rather than replaying the stored window, so a
  // rolling range actually moves forward instead of asking for the same period
  // it was selected with. The new window is what triggers the refetch.
  const { interval, setInterval } = useAutoRefresh(range.advance, config.refreshIntervalMs);

  return (
    <>
      <ContentHeader title="Repositories">
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
            title="Failed to load repositories"
            message={error}
            defaultExpanded
          />
        </Box>
      )}

      <Box mb={3}>
        <Grid container spacing={3}>
          <RepositoryAudits repositories={repositories} />

          {capabilities.wakatime ? (
            <WakaTimeRepositoryInsights repositories={repositories} />
          ) : null}

          {capabilities.jira ? (
            <JiraRepositoryInsights repositories={repositories} />
          ) : null}

          {capabilities.confluence ? (
            <ConfluenceRepositoryInsights repositories={repositories} />
          ) : null}
        </Grid>
      </Box>

      <RepositoryTable
        repositories={repositories}
        totalCount={repositories.length}
        isLoading={isLoading}
        capabilities={capabilities}
        expectedDefaultBranch={config.expectedDefaultBranch}
      />
    </>
  );
};
