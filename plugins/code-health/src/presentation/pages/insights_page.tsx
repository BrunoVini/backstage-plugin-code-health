import { ContentHeader, InfoCard, Progress, WarningPanel } from "@backstage/core-components";
import type {
  IntegrationCapabilities,
  TimeSeriesBucket,
} from "@rios0rios0/backstage-plugin-code-health-common";
import {
  formatCount,
  formatFixed,
  formatPercent,
} from "@rios0rios0/backstage-plugin-code-health-common";
import Box from "@material-ui/core/Box";
import Grid from "@material-ui/core/Grid";
import { useMemo } from "react";
import type { CodeHealthConfig } from "../../domain/entities/code_health_config";
import {
  computeKpis,
  COVERAGE_TARGET,
  coverageBreakdown,
  coverageStats,
  lowestCoverageRepositories,
  toCadence,
} from "../../domain/entities/insights";
import type {
  ContributorService,
  DashboardService,
  TimeSeriesService,
} from "../../domain/services/dashboard_service";
import { BackfillProgress } from "../components/backfill_progress";
import { CadenceChart } from "../components/charts/cadence_chart";
import { RankingChart } from "../components/charts/ranking_chart";
import { StatTile } from "../components/charts/stat_tile";
import { StatusBreakdown } from "../components/charts/status_breakdown";
import { DashboardToolbar } from "../components/dashboard_toolbar";
import { ConfluenceFleetInsights } from "../components/insights/confluence_insights";
import { JiraFleetInsights } from "../components/insights/jira_insights";
import { WakaTimeFleetInsights } from "../components/insights/wakatime_insights";
import { useAutoRefresh } from "../hooks/use_auto_refresh";
import type { UseCoverageResult } from "../hooks/use_coverage";
import { useInsights } from "../hooks/use_insights";
import { useTimeRange } from "../hooks/use_time_range";

interface InsightsPageProps {
  dashboardService: DashboardService;
  contributorService: ContributorService;
  timeSeriesService: TimeSeriesService;
  coverage: UseCoverageResult;
  config: CodeHealthConfig;
  capabilities: IntegrationCapabilities;
  enabled?: boolean;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Buckets chosen from the window's length rather than exposed as a control.
 *
 * A daily bucket over a year is 365 points across roughly 700 pixels, which is
 * noise; a monthly bucket over a week is one point. Deriving it removes a knob
 * whose only correct setting is implied by the range already picked.
 */
const bucketFor = (from: string, to: string): TimeSeriesBucket => {
  const days = (new Date(to).getTime() - new Date(from).getTime()) / DAY;
  if (days > 180) return "month";
  if (days > 45) return "week";
  return "day";
};

const formatOptionalPercent = (value: number | null): string =>
  value === null ? "—" : formatPercent(value);
const formatCoverage = (value: number): string => `${formatFixed(value)}%`;

export const InsightsPage = ({
  dashboardService,
  contributorService,
  timeSeriesService,
  coverage,
  config,
  capabilities,
  enabled = true,
}: InsightsPageProps) => {
  const range = useTimeRange(coverage.coverage, config.defaultRange);
  const bucket = bucketFor(range.window.from, range.window.to);

  const { repositories, contributors, cadence, isLoading, error, lastFetchedAt } =
    useInsights(
      dashboardService,
      contributorService,
      timeSeriesService,
      range.window,
      bucket,
      enabled,
    );
  // Refreshing re-reads the clock rather than replaying the stored window — see
  // `useTimeRange.advance`.
  const { interval, setInterval } = useAutoRefresh(range.advance, config.refreshIntervalMs);

  const kpis = useMemo(
    () => computeKpis(repositories, contributors),
    [repositories, contributors],
  );
  const testCoverage = useMemo(() => coverageStats(repositories), [repositories]);
  const coverageSlices = useMemo(() => coverageBreakdown(repositories), [repositories]);
  const leastCovered = useMemo(
    () => lowestCoverageRepositories(repositories),
    [repositories],
  );
  const cadencePoints = useMemo(() => toCadence(cadence), [cadence]);

  const showEmpty = !isLoading && repositories.length === 0 && error === null;

  return (
    <>
      <ContentHeader title="Insights">
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
            title="Failed to load insights"
            message={error}
            defaultExpanded
          />
        </Box>
      )}

      {isLoading && repositories.length === 0 ? <Progress /> : null}

      {showEmpty ? (
        <WarningPanel
          severity="info"
          title="Nothing to chart yet"
          message="No repositories were tracked in this window. Insights fill in once the backend has discovered catalog entities and ingested their history."
        />
      ) : null}

      {repositories.length > 0 ? (
        <Grid container spacing={3}>
          <Grid item xs={12}>
            <InfoCard title="At a glance">
              <Grid container spacing={3}>
                <Grid item xs={6} sm={4} md={2}>
                  <StatTile
                    label="Active repos"
                    value={formatCount(kpis.activeRepositories)}
                    caption={`of ${formatCount(kpis.trackedRepositories)} tracked`}
                    help="Repositories with at least one commit inside the selected window."
                  />
                </Grid>
                <Grid item xs={6} sm={4} md={2}>
                  <StatTile
                    label="Contributors"
                    value={formatCount(kpis.activeContributors)}
                    caption="committed in window"
                    help="People who committed inside the window. A person's accounts across every system are one row once they are linked on the Identities tab; an account nobody has linked counts on its own."
                  />
                </Grid>
                <Grid item xs={6} sm={4} md={2}>
                  <StatTile label="Commits" value={formatCount(kpis.commits)} />
                </Grid>
                <Grid item xs={6} sm={4} md={2}>
                  <StatTile
                    label="PRs merged"
                    value={formatCount(kpis.pullRequestsMerged)}
                  />
                </Grid>
                <Grid item xs={6} sm={4} md={2}>
                  <StatTile
                    label="Build success"
                    value={formatOptionalPercent(kpis.buildSuccessRate)}
                    caption="of decided runs"
                    help="Succeeded runs as a share of the runs that reached a verdict in the window. Cancelled, skipped and still-running runs are neither a success nor a failure and are left out."
                  />
                </Grid>
                <Grid item xs={6} sm={4} md={2}>
                  <StatTile
                    label="Review coverage"
                    value={formatOptionalPercent(kpis.reviewCoverage)}
                    caption="reviews per merged PR"
                    help="Reviews recorded against merged pull requests, capped at 100%. A low figure means work is merging unreviewed."
                  />
                </Grid>
              </Grid>
            </InfoCard>
          </Grid>

          <Grid item xs={12}>
            <InfoCard
              title="Delivery cadence"
              subheader={`Bucketed by ${bucket}. Both series share one scale.`}
            >
              <CadenceChart points={cadencePoints} />
            </InfoCard>
          </Grid>

          <Grid item xs={12}>
            <InfoCard
              title="Test coverage across the fleet"
              subheader={`From the Sonar project each catalog entity names. ${formatCount(
                testCoverage.measured,
              )} of ${formatCount(testCoverage.tracked)} repositories are measured.`}
            >
              <Grid container spacing={3}>
                <Grid item xs={12} md={4}>
                  <Box mb={3} display="flex" style={{ gap: 24 }} flexWrap="wrap">
                    <StatTile
                      label="Average"
                      value={
                        testCoverage.average === null ? "—" : formatCoverage(testCoverage.average)
                      }
                      caption="per repository"
                      help="Unweighted mean over the measured repositories. Every repository counts once, whatever its size, so one small untested repository is not hidden behind a large well-tested one."
                    />
                    <StatTile
                      label="Median"
                      value={
                        testCoverage.median === null ? "—" : formatCoverage(testCoverage.median)
                      }
                      caption="per repository"
                      help="The middle repository. A long tail of untested repositories moves the mean much further than it moves this."
                    />
                    <StatTile
                      label={`Below ${COVERAGE_TARGET}%`}
                      value={formatCount(testCoverage.belowTarget)}
                      caption="repositories"
                      help={`${COVERAGE_TARGET}% is SonarQube's own default gate on new code, so this is the number a team already sees on its quality gate rather than a second target invented here.`}
                    />
                  </Box>
                  <StatusBreakdown slices={coverageSlices} />
                </Grid>

                <Grid item xs={12} md={8}>
                  <Box mb={1} fontWeight={500}>
                    Least covered
                  </Box>
                  <RankingChart
                    items={leastCovered}
                    unit="coverage"
                    scaleMax={100}
                    formatValue={formatCoverage}
                    emptyMessage="No repository in this window reports a Sonar coverage measure. Add a `sonarqube.org/project-key` annotation to the catalog entity to start collecting one."
                  />
                </Grid>
              </Grid>
            </InfoCard>
          </Grid>

          {/* Only each integration's fleet cards. What it says about a person
              sits above the contributors table and what it says about a
              repository above the repositories table, beside the rows they
              name — the same split the version control cards already follow. */}
          {capabilities.wakatime ? (
            <WakaTimeFleetInsights contributors={contributors} />
          ) : null}

          {capabilities.jira ? (
            <JiraFleetInsights repositories={repositories} contributors={contributors} />
          ) : null}

          {capabilities.confluence ? (
            <ConfluenceFleetInsights
              repositories={repositories}
              contributors={contributors}
            />
          ) : null}
        </Grid>
      ) : null}
    </>
  );
};
