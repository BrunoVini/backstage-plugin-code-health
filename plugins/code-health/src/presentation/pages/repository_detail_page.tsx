import {
  ContentHeader,
  InfoCard,
  Progress,
  WarningPanel,
} from "@backstage/core-components";
import { useRouteRef } from "@backstage/core-plugin-api";
import type {
  ConfluenceSpaceMetrics,
  EntityProfile,
  IntegrationCapabilities,
  JiraRepositoryMetrics,
  Platform,
  RepositorySummary,
  RepositoryTrendPoint,
  TimeSeriesBucket,
} from "@rios0rios0/backstage-plugin-code-health-common";
import {
  catalogEntityPath,
  formatHours as formatJiraHours,
  parseEntityRef,
} from "@rios0rios0/backstage-plugin-code-health-common";
import Box from "@material-ui/core/Box";
import Grid from "@material-ui/core/Grid";
import Link from "@material-ui/core/Link";
import Typography from "@material-ui/core/Typography";
import { useMemo } from "react";
import { Link as RouterLink, useParams } from "react-router-dom";
import { topContributorsByCommits } from "../../domain/entities/insights";
import {
  buildSuccessRateTrend,
  buildTrend,
  codeSmellTrend,
  codingTimeTrend,
  commitsTrend,
  COMPLIANCE_CHECK_COUNT,
  complianceTrend,
  contributorsTrend,
  coverageTrend,
  defectTrend,
  pullRequestTrend,
  releaseTrend,
  REPOSITORY_TREND_SERIES,
  reviewsPerMergeTrend,
  scoreTrend,
  technicalDebtTrend,
} from "../../domain/entities/repository_trend";
import type {
  ContributorService,
  TrendService,
} from "../../domain/services/dashboard_service";
import { contributorDetailRouteRef, repositoriesRouteRef } from "../../routes";
import { RankingChart } from "../components/charts/ranking_chart";
import { TrendChart } from "../components/charts/trend_chart";
import { ScoreCard } from "../components/score_card";
import { StateChip } from "../components/state_chip";
import { TrendRangePicker } from "../components/trend_range_picker";
import { useContributors } from "../hooks/use_contributors";
import type { UseCoverageResult } from "../hooks/use_coverage";
import { useRepositoryTrend } from "../hooks/use_repository_trend";
import { useTrendWindow } from "../hooks/use_trend_window";

export interface RepositoryDetailPageProps {
  readonly trendService: TrendService;
  readonly contributorService: ContributorService;
  readonly coverage: UseCoverageResult;
  readonly capabilities: IntegrationCapabilities;
}

/** What each platform is called on the screen. */
const PLATFORM_LABELS: Readonly<Record<Platform, string>> = {
  github: "GitHub",
  "azure-devops": "Azure DevOps",
};

const EM_DASH = "—";

/** Stable, so an absent trend does not recompute every series on every render. */
const NO_POINTS: readonly RepositoryTrendPoint[] = [];

const formatCount = (value: number): string => value.toLocaleString();
const formatPercent = (value: number): string => `${value}%`;
const formatRatio = (value: number): string => value.toFixed(2);
const formatHours = (value: number): string => `${value.toLocaleString()}h`;

/**
 * Why the Sonar and compliance series look coarser than the activity ones.
 *
 * They come from the daily snapshot rather than from the window's events, so
 * they move once a day at best and begin at the first snapshot after the
 * plugin was installed. No provider will say what they looked like last March.
 */
const SNAPSHOT_CAPTION =
  "From the daily snapshot, so this moves at most once a day and starts at the first snapshot after installation.";

const bucketCaption = (bucket: TimeSeriesBucket): string =>
  `Bucketed by ${bucket}.`;

/**
 * The owner's name, as the catalog spells it, plus where to read about them.
 *
 * A reference the catalog cannot address degrades to an em dash rather than to
 * a link that would 404 — the same rule the table's owner column follows.
 */
const OwnerLink = ({
  ownerRef,
  profile,
}: {
  ownerRef: string | null;
  profile: EntityProfile | null;
}) => {
  const parsed = ownerRef === null ? null : parseEntityRef(ownerRef);
  const path = ownerRef === null ? null : catalogEntityPath(ownerRef);

  if (parsed === null || path === null) {
    return (
      <Typography variant="body2" component="span">
        {EM_DASH}
      </Typography>
    );
  }

  return (
    <Link component={RouterLink} to={path}>
      {/* The resolved name, so the header reads the same as the table row this
          page was opened from; the slug is the fallback rather than an error. */}
      {profile?.displayName ?? parsed.name}
    </Link>
  );
};

/**
 * Who and what this repository is, before any of the numbers.
 *
 * Everything here is read off the whole-window summary rather than off the last
 * bucket: a reader arriving from the table expects the row they clicked.
 */
const RepositoryIdentity = ({ summary }: { summary: RepositorySummary }) => {
  const entityPath = catalogEntityPath(summary.entityRef);

  return (
    <Box>
      <Box display="flex" alignItems="center" flexWrap="wrap" gridGap={8}>
        <Typography variant="h6" component="h2">
          {summary.fullName}
        </Typography>
        {summary.isArchived ? <StateChip tone="warning" label="archived" /> : null}
        {summary.isFork ? <StateChip tone="info" label="fork" /> : null}
        {summary.primaryLanguage === null ? null : (
          <StateChip tone="info" label={summary.primaryLanguage} />
        )}
        <StateChip tone="neutral" label={PLATFORM_LABELS[summary.platform]} />
      </Box>

      {summary.description === null ? null : (
        <Box mt={0.5}>
          <Typography variant="body2" color="textSecondary">
            {summary.description}
          </Typography>
        </Box>
      )}

      <Box mt={1} display="flex" alignItems="center" flexWrap="wrap" gridGap={16}>
        <Typography variant="body2" component="span">
          Owner:{" "}
          <OwnerLink ownerRef={summary.ownerRef} profile={summary.ownerProfile} />
        </Typography>
        {entityPath === null ? null : (
          <Link component={RouterLink} to={entityPath}>
            Open in the catalog
          </Link>
        )}
        <Link href={summary.url} target="_blank" rel="noopener noreferrer">
          {`Open on ${PLATFORM_LABELS[summary.platform]}`}
        </Link>
      </Box>
    </Box>
  );
};

/** A number is localised; a string arrives already formatted; null is a dash. */
const formatFigure = (value: number | string | null): string => {
  if (value === null) return EM_DASH;
  return typeof value === "number" ? formatCount(value) : value;
};

/**
 * A figure and its name, for what an integration answers per window rather
 * than per bucket.
 */
const Figure = ({ label, value }: { label: string; value: number | string | null }) => (
  <Box display="flex" justifyContent="space-between" py={0.25}>
    <Typography variant="body2" color="textSecondary">
      {label}
    </Typography>
    <Typography variant="body2">{formatFigure(value)}</Typography>
  </Box>
);

const formatWindowDay = (instant: string): string => {
  const parsed = new Date(instant);
  return Number.isNaN(parsed.getTime())
    ? instant
    : parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
};

/**
 * What the matching Jira project looked like at the end of the window.
 *
 * Figures rather than a chart, for the same reason as the Confluence card: the
 * repository-level Jira measures ride on the daily snapshot and describe a
 * trailing window of `atlassian.historyDays`, not the bucket's own events.
 * Drawn per bucket, consecutive points would overlap by most of a month and a
 * reader would compare a rolling total against a single week's commits. The
 * per-day slicing the contributor page gets is only stored for people.
 */
const JiraFigures = ({ metrics }: { metrics: JiraRepositoryMetrics | null }) => {
  if (metrics === null) {
    return (
      <Typography variant="body2" color="textSecondary">
        No Jira project is named by the catalog entity, so nothing was collected. Add a{" "}
        <code>jira/project-key</code> annotation to start.
      </Typography>
    );
  }

  const scope = metrics.component === null ? metrics.projectKey : `${metrics.projectKey} · ${metrics.component}`;

  return (
    <Box>
      <Box mb={1}>
        <Typography variant="caption" color="textSecondary">
          {`${scope}, ${formatWindowDay(metrics.window.from)} to ${formatWindowDay(
            metrics.window.to,
          )} — the snapshot's own trailing window, not the range picked above`}
        </Typography>
      </Box>
      <Figure label="Tickets resolved" value={metrics.issuesResolved} />
      <Figure label="Tickets created" value={metrics.issuesCreated} />
      <Figure label="Throughput per week" value={metrics.throughputPerWeek} />
      <Figure
        label="Median cycle time"
        value={metrics.cycleTime === null ? null : formatJiraHours(metrics.cycleTime.medianHours)}
      />
      <Figure
        label="Median lead time"
        value={metrics.leadTime === null ? null : formatJiraHours(metrics.leadTime.medianHours)}
      />
      <Figure
        label="Bug ratio"
        value={metrics.bugRatio === null ? null : `${metrics.bugRatio}%`}
      />
      <Figure label="Reopened" value={metrics.reopened} />
      <Figure label="Open right now" value={metrics.openIssues} />
    </Box>
  );
};

/**
 * What the matching Confluence space saw in the window.
 *
 * Figures rather than a chart: the enricher answers for a window, not for a
 * day, so there is no honest way to spread these across the buckets. A null
 * stays an em dash — the walk that would have counted it was capped, which is
 * not the same as nothing having happened.
 */
const ConfluenceFigures = ({ metrics }: { metrics: ConfluenceSpaceMetrics | null }) => {
  if (metrics === null) {
    return (
      <Typography variant="body2" color="textSecondary">
        No Confluence space is named by the catalog entity, so nothing was collected.
      </Typography>
    );
  }

  return (
    <Box>
      <Box mb={1}>
        <Typography variant="caption" color="textSecondary">
          {metrics.space.name ?? metrics.space.key}
        </Typography>
      </Box>
      <Figure label="Pages created" value={metrics.pagesCreated} />
      <Figure label="Pages edited" value={metrics.pagesEdited} />
      <Figure label="Blog posts" value={metrics.blogPostsCreated} />
      <Figure label="Comments written" value={metrics.commentsWritten} />
      <Figure label="Pages in the space" value={metrics.totalPages} />
      <Figure label={`Untouched for ${metrics.staleAfterDays} days`} value={metrics.stalePages} />
    </Box>
  );
};

/**
 * One repository over the last one to six months.
 *
 * Every chart reads the same bucketed summaries the tables read, so a figure
 * here is the same figure the row carried, computed by the same code. A bucket
 * that holds no measurement breaks the line rather than being drawn as zero —
 * a Sonar project wired up halfway through the window must not read as a
 * quality collapse followed by a recovery.
 */
export const RepositoryDetailPage = ({
  trendService,
  contributorService,
  coverage,
  capabilities,
}: RepositoryDetailPageProps) => {
  const { id } = useParams<{ id: string }>();
  const repositoryId = id ?? null;
  const range = useTrendWindow(coverage.coverage);
  const repositoriesPath = useRouteRef(repositoriesRouteRef)();
  const contributorPath = useRouteRef(contributorDetailRouteRef)();

  const { trend, isLoading, error, isMissing } = useRepositoryTrend(
    trendService,
    repositoryId,
    range.window,
    range.bucket,
    true,
  );

  // The card has its own request on purpose: who works on a repository is a
  // question about people, answered by the contributors route, and a failure
  // there must cost the card rather than the page.
  const contributors = useContributors(
    contributorService,
    range.window,
    repositoryId !== null,
    repositoryId ?? undefined,
  );

  const points = trend?.points ?? NO_POINTS;
  const commits = useMemo(() => commitsTrend(points), [points]);
  const pullRequests = useMemo(() => pullRequestTrend(points), [points]);
  const builds = useMemo(() => buildTrend(points), [points]);
  const buildSuccess = useMemo(() => buildSuccessRateTrend(points), [points]);
  const reviews = useMemo(() => reviewsPerMergeTrend(points), [points]);
  const people = useMemo(() => contributorsTrend(points), [points]);
  const score = useMemo(() => scoreTrend(points), [points]);
  const defects = useMemo(() => defectTrend(points), [points]);
  const smells = useMemo(() => codeSmellTrend(points), [points]);
  const sonarCoverage = useMemo(() => coverageTrend(points), [points]);
  const debt = useMemo(() => technicalDebtTrend(points), [points]);
  const compliance = useMemo(() => complianceTrend(points), [points]);
  const releases = useMemo(() => releaseTrend(points), [points]);
  const codingTime = useMemo(() => codingTimeTrend(points), [points]);
  const ranking = useMemo(
    () => topContributorsByCommits(contributors.contributors),
    [contributors.contributors],
  );

  const bucket = trend?.bucket ?? range.bucket;

  return (
    <>
      <Box mb={1}>
        <Link component={RouterLink} to={repositoriesPath}>
          ← Back to repositories
        </Link>
      </Box>

      <ContentHeader title={trend?.summary.name ?? "Repository"}>
        <TrendRangePicker
          selection={range.selection}
          offered={range.offered}
          months={range.months}
          onChange={range.select}
        />
      </ContentHeader>

      {repositoryId === null ? (
        <WarningPanel
          severity="info"
          title="No repository was named"
          message="Open a repository from the table to see its history."
        />
      ) : null}

      {isMissing ? (
        <WarningPanel
          severity="info"
          title="This repository is not tracked"
          message="Nothing in the catalog points at it any more, so no history is being collected. It may have been removed from the catalog, or the link may be older than the entity."
        />
      ) : null}

      {error !== null && !isMissing ? (
        <Box mb={2}>
          <WarningPanel
            severity="error"
            title="Failed to load the repository"
            message={error}
            defaultExpanded
          />
        </Box>
      ) : null}

      {isLoading && trend === null ? <Progress /> : null}

      {trend === null ? null : (
        <Grid container spacing={3}>
          <Grid item xs={12}>
            <InfoCard>
              <RepositoryIdentity summary={trend.summary} />
            </InfoCard>
          </Grid>

          <Grid item xs={12} md={6}>
            <ScoreCard
              title="Health score"
              subheader="Every component is absolute — a failing gate is a failing gate whatever the rest of the fleet looks like — and anything that could not be measured is left out rather than scored as zero."
              score={trend.score}
              emptyMessage="Nothing about this repository could be measured in this window."
            />
          </Grid>

          <Grid item xs={12} md={6}>
            <InfoCard
              title="Who works on it"
              subheader="By commits in the window"
            >
              {contributors.error === null ? (
                <RankingChart
                  items={ranking}
                  unit="commits"
                  showAvatars
                  emptyMessage="Nobody committed to this repository in this window."
                  linkTo={(item) =>
                    `${contributorPath}?key=${encodeURIComponent(item.id)}`
                  }
                />
              ) : (
                <Typography variant="body2" color="textSecondary">
                  {`Contributors could not be read: ${contributors.error}`}
                </Typography>
              )}
            </InfoCard>
          </Grid>

          <Grid item xs={12}>
            <InfoCard
              title="Commits and merges"
              subheader={`${bucketCaption(bucket)} Both series share one scale.`}
            >
              <TrendChart
                points={commits}
                series={[
                  { key: REPOSITORY_TREND_SERIES.commits, label: "Commits", area: true },
                  {
                    key: REPOSITORY_TREND_SERIES.pullRequestsMerged,
                    label: "Pull requests merged",
                  },
                ]}
                formatValue={formatCount}
              />
            </InfoCard>
          </Grid>

          <Grid item xs={12} md={6}>
            <InfoCard
              title="Pull requests"
              subheader={`${bucketCaption(bucket)} Opened against abandoned.`}
            >
              <TrendChart
                points={pullRequests}
                series={[
                  {
                    key: REPOSITORY_TREND_SERIES.pullRequestsOpened,
                    label: "Opened",
                  },
                  {
                    key: REPOSITORY_TREND_SERIES.pullRequestsAbandoned,
                    label: "Abandoned",
                  },
                ]}
                formatValue={formatCount}
              />
            </InfoCard>
          </Grid>

          <Grid item xs={12} md={6}>
            <InfoCard
              title="Builds"
              subheader={`${bucketCaption(bucket)} Only runs that reached a verdict.`}
            >
              <TrendChart
                points={builds}
                series={[
                  { key: REPOSITORY_TREND_SERIES.buildsSucceeded, label: "Succeeded" },
                  { key: REPOSITORY_TREND_SERIES.buildsFailed, label: "Failed" },
                ]}
                formatValue={formatCount}
              />
            </InfoCard>
          </Grid>

          <Grid item xs={12} md={6}>
            <InfoCard
              title="Build success rate"
              subheader="Over the runs that reached a verdict. A bucket where none did is left blank rather than drawn as nothing succeeding."
            >
              <TrendChart
                points={buildSuccess}
                series={[
                  { key: REPOSITORY_TREND_SERIES.buildSuccessRate, label: "Build success" },
                ]}
                scaleMax={100}
                formatValue={formatPercent}
                emptyMessage="No pipeline run reached a verdict in this window."
              />
            </InfoCard>
          </Grid>

          <Grid item xs={12} md={6}>
            <InfoCard
              title="Reviews per merged pull request"
              subheader="Blank where nothing merged: with no denominator the figure means nothing."
            >
              <TrendChart
                points={reviews}
                series={[
                  { key: REPOSITORY_TREND_SERIES.reviewsPerMerge, label: "Reviews per merge" },
                ]}
                formatValue={formatRatio}
              />
            </InfoCard>
          </Grid>

          <Grid item xs={12} md={6}>
            <InfoCard
              title="Active contributors"
              subheader={`${bucketCaption(bucket)} People who committed inside each bucket.`}
            >
              <TrendChart
                points={people}
                series={[{ key: REPOSITORY_TREND_SERIES.contributors, label: "Contributors" }]}
                formatValue={formatCount}
              />
            </InfoCard>
          </Grid>

          <Grid item xs={12} md={6}>
            <InfoCard
              title="Health score over time"
              subheader="Scored bucket by bucket against the same absolute components as the card above."
            >
              <TrendChart
                points={score}
                series={[{ key: REPOSITORY_TREND_SERIES.score, label: "Score" }]}
                scaleMax={100}
                formatValue={formatCount}
              />
            </InfoCard>
          </Grid>

          <Grid item xs={12} md={6}>
            <InfoCard title="Bugs and vulnerabilities" subheader={SNAPSHOT_CAPTION}>
              <TrendChart
                points={defects}
                series={[
                  { key: REPOSITORY_TREND_SERIES.bugs, label: "Bugs" },
                  { key: REPOSITORY_TREND_SERIES.vulnerabilities, label: "Vulnerabilities" },
                ]}
                formatValue={formatCount}
              />
            </InfoCard>
          </Grid>

          <Grid item xs={12} md={6}>
            <InfoCard title="Code smells" subheader={SNAPSHOT_CAPTION}>
              <TrendChart
                points={smells}
                series={[{ key: REPOSITORY_TREND_SERIES.codeSmells, label: "Smells" }]}
                formatValue={formatCount}
              />
            </InfoCard>
          </Grid>

          <Grid item xs={12} md={6}>
            <InfoCard title="Test coverage and duplication" subheader={SNAPSHOT_CAPTION}>
              <TrendChart
                points={sonarCoverage}
                series={[
                  { key: REPOSITORY_TREND_SERIES.coverage, label: "Test coverage" },
                  { key: REPOSITORY_TREND_SERIES.duplications, label: "Duplication" },
                ]}
                scaleMax={100}
                formatValue={formatPercent}
              />
            </InfoCard>
          </Grid>

          <Grid item xs={12} md={6}>
            <InfoCard title="Technical debt" subheader={SNAPSHOT_CAPTION}>
              <TrendChart
                points={debt}
                series={[
                  { key: REPOSITORY_TREND_SERIES.technicalDebtHours, label: "Debt" },
                ]}
                formatValue={formatHours}
              />
            </InfoCard>
          </Grid>

          <Grid item xs={12} md={6}>
            <InfoCard
              title="Compliance checks passing"
              subheader={`Out of ${COMPLIANCE_CHECK_COUNT}. ${SNAPSHOT_CAPTION}`}
            >
              <TrendChart
                points={compliance}
                series={[
                  { key: REPOSITORY_TREND_SERIES.complianceChecks, label: "Checks passing" },
                ]}
                scaleMax={COMPLIANCE_CHECK_COUNT}
                formatValue={formatCount}
              />
            </InfoCard>
          </Grid>

          <Grid item xs={12} md={6}>
            <InfoCard
              title="Releases and tags"
              subheader={bucketCaption(bucket)}
            >
              <TrendChart
                points={releases}
                series={[
                  { key: REPOSITORY_TREND_SERIES.releases, label: "Releases" },
                  { key: REPOSITORY_TREND_SERIES.tags, label: "Tags" },
                ]}
                formatValue={formatCount}
              />
            </InfoCard>
          </Grid>

          {capabilities.wakatime ? (
            <Grid item xs={12} md={6}>
              <InfoCard
                title="Coding time"
                subheader="Hours logged against the matching WakaTime project by everybody who worked on it."
              >
                <TrendChart
                  points={codingTime}
                  series={[
                    { key: REPOSITORY_TREND_SERIES.codingHours, label: "Coding hours" },
                  ]}
                  formatValue={formatHours}
                />
              </InfoCard>
            </Grid>
          ) : null}

          {capabilities.jira ? (
            <Grid item xs={12} md={6}>
              <InfoCard
                title="Jira delivery"
                subheader="Over the snapshot's trailing window rather than per bucket — the project's figures ride on the daily snapshot, so a per-bucket chart would draw the same rolling total once per bucket and call it throughput."
              >
                <JiraFigures metrics={trend.summary.jiraMetrics} />
              </InfoCard>
            </Grid>
          ) : null}

          {capabilities.confluence ? (
            <Grid item xs={12} md={6}>
              <InfoCard
                title="Confluence space"
                subheader="Over the whole window rather than per bucket — Confluence's figures come from walking a page's versions, so a per-bucket slice would repeat the same walk once per bucket and say nothing new."
              >
                <ConfluenceFigures metrics={trend.summary.confluenceMetrics} />
              </InfoCard>
            </Grid>
          ) : null}
        </Grid>
      )}
    </>
  );
};
