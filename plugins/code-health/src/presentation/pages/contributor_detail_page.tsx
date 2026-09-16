import { ContentHeader, InfoCard, Progress, WarningPanel } from "@backstage/core-components";
import { useRouteRef } from "@backstage/core-plugin-api";
import Avatar from "@material-ui/core/Avatar";
import Box from "@material-ui/core/Box";
import Grid from "@material-ui/core/Grid";
import Link from "@material-ui/core/Link";
import Typography from "@material-ui/core/Typography";
import { makeStyles } from "@material-ui/core/styles";
import type {
  ContributorSummary,
  IntegrationCapabilities,
  TimeSeriesBucket,
} from "@rios0rios0/backstage-plugin-code-health-common";
import {
  catalogEntityPath,
  enabledIntegrations,
} from "@rios0rios0/backstage-plugin-code-health-common";
import { useMemo } from "react";
import { Link as RouterLink, useSearchParams } from "react-router-dom";
import type { TrendValues } from "../../domain/entities/contributor_trend";
import {
  CHURN_LABELS,
  CONTRIBUTOR_SERIES,
  churnSeries,
  codingTimeSeries,
  commitSeries,
  hasMeasurement,
  identityLabels,
  pipelineSeries,
  pullRequestSeries,
  reviewSeries,
  scoreSeries,
  sonarCoverageSeries,
  sonarDefectSeries,
  ticketsResolvedSeries,
} from "../../domain/entities/contributor_trend";
import type {
  OwnershipService,
  TrendService,
} from "../../domain/services/dashboard_service";
import { contributorsRouteRef } from "../../routes";
import type { TrendSeries } from "../components/charts/trend_chart";
import { TrendChart } from "../components/charts/trend_chart";
import { OwnedRepositoriesCard } from "../components/owned_repositories_card";
import { ContributorRatesCard } from "../components/contributor_rates_card";
import { ScoreCard } from "../components/score_card";
import { TrendRangePicker } from "../components/trend_range_picker";
import type { UseCoverageResult } from "../hooks/use_coverage";
import { useContributorTrend } from "../hooks/use_contributor_trend";
import { useOwnedRepositories } from "../hooks/use_owned_repositories";
import { useTrendWindow } from "../hooks/use_trend_window";

export interface ContributorDetailPageProps {
  readonly trendService: TrendService;
  readonly ownershipService: OwnershipService;
  readonly coverage: UseCoverageResult;
  readonly capabilities: IntegrationCapabilities;
}

/** The query parameter the Contributors tab links a person's detail page with. */
export const CONTRIBUTOR_KEY_PARAM = "key";

const useStyles = makeStyles((theme) => ({
  person: { display: "flex", alignItems: "center", gap: theme.spacing(2) },
  avatar: { width: 48, height: 48 },
  identities: { display: "block" },
  links: { display: "flex", gap: theme.spacing(2), flexWrap: "wrap" },
  explanation: { color: theme.palette.text.secondary, padding: theme.spacing(2, 0) },
}));

const BUCKET_NOTES: Readonly<Record<TimeSeriesBucket, string>> = {
  day: "Bucketed by day.",
  week: "Bucketed by week.",
  month: "Bucketed by month.",
};

/**
 * What every Sonar figure on this page is a figure of.
 *
 * The same caveat the contributors table carries, for the same reason: a
 * "Bugs" chart on a page with somebody's face at the top reads as that
 * person's bugs, and it is not — Sonar measures a project, and this is the
 * total over the repositories whose code they changed.
 */
const SONAR_CAVEAT =
  "Sonar measures a repository, not a person: this is the total over the repositories this person committed to or merged into in each bucket — what the code they worked on looks like, not what they wrote. It begins at the first snapshot after the plugin was installed, because no provider reports what a project looked like last March.";

/**
 * How the number above it was arrived at, said before anybody has to ask.
 *
 * These figures are read as a measure of people, so the reading has to be on
 * the card rather than in documentation nobody has open. The two halves work
 * differently on purpose: output compared against the fleet means a quiet month
 * for the whole team is a quiet month rather than everybody's failure, while
 * reliability means the same thing whoever else is on the team.
 */
const PRODUCTIVITY_SUBHEADER =
  "Output — commits, merged pull requests, churn and reviews — is read as a rate: the totals below divided by the days this range spans, each against the team's average rate over the same period, with twice that average scoring full marks. A quiet month for the whole team is then a quiet month rather than everybody's failure. The denominator is the range rather than the days this person was active, so these are figures per elapsed day: a mid-range start or a fortnight of leave lowers them. Reliability and quality — the pipeline success rate, and the gate and coverage of the code touched — are absolute. Anything that could not be measured is left out rather than scored as zero, and the weight below says how much of the score survived.";

/**
 * What the configured integrations add to the reading above.
 *
 * Said only where one is on. An install with none configured should not be told
 * about measures it has no way of collecting, and one with them on should not
 * be left to work out for itself why every weight below moved.
 */
const INTEGRATION_SUBHEADER =
  "Coding time and tickets resolved join the score wherever their integration is configured, read as rates against the team's average exactly as output is; documentation written joins it too, but over Confluence's own trailing window, which the range above does not move, so it is compared as a total rather than as a rate. Only how much of somebody's resolved work stayed resolved is absolute. The weights are shared out over whatever is configured, so each component below carries a smaller share than it would on its own.";

const COMMIT_SERIES: readonly TrendSeries[] = [
  { key: CONTRIBUTOR_SERIES.commits, label: "Commits", area: true },
  { key: CONTRIBUTOR_SERIES.pullRequestsMerged, label: "Pull requests merged" },
];

const PULL_REQUEST_SERIES: readonly TrendSeries[] = [
  { key: CONTRIBUTOR_SERIES.pullRequestsOpened, label: "Opened" },
  { key: CONTRIBUTOR_SERIES.pullRequestsMerged, label: "Merged" },
];

const REVIEW_SERIES: readonly TrendSeries[] = [
  { key: CONTRIBUTOR_SERIES.reviewsGiven, label: "Reviews given" },
  { key: CONTRIBUTOR_SERIES.reviewsApproved, label: "Approved" },
];

const PIPELINE_SERIES: readonly TrendSeries[] = [
  { key: CONTRIBUTOR_SERIES.pipelineSuccessRate, label: "Pipeline success rate" },
];

const SCORE_SERIES: readonly TrendSeries[] = [
  { key: CONTRIBUTOR_SERIES.score, label: "Productivity score", area: true },
];

const DEFECT_SERIES: readonly TrendSeries[] = [
  { key: CONTRIBUTOR_SERIES.bugs, label: "Bugs" },
  { key: CONTRIBUTOR_SERIES.vulnerabilities, label: "Vulnerabilities" },
];

const COVERAGE_SERIES: readonly TrendSeries[] = [
  { key: CONTRIBUTOR_SERIES.coverage, label: "Test coverage" },
];

const CODING_TIME_SERIES: readonly TrendSeries[] = [
  { key: CONTRIBUTOR_SERIES.codingHours, label: "Coding time", area: true },
];

const TICKET_SERIES: readonly TrendSeries[] = [
  { key: CONTRIBUTOR_SERIES.ticketsResolved, label: "Tickets resolved", area: true },
];

const formatPercent = (value: number): string => `${Math.round(value * 10) / 10}%`;
const formatHours = (value: number): string => `${Math.round(value * 10) / 10}h`;

/**
 * The points, or none at all when nothing in them was ever measured.
 *
 * The chart breaks its line at an unmeasured bucket, so a series nothing ever
 * measured would draw an empty grid under a legend promising a figure — which
 * reads as a collapse to zero. Handing it no points at all makes it say what
 * actually happened instead.
 */
const whenMeasured = (points: readonly TrendValues[], key: string): readonly TrendValues[] =>
  hasMeasurement(points, key) ? points : [];

/** Up to two initials, from a display name or an e-mail local part. */
const initialsOf = (displayName: string): string =>
  displayName
    .replace(/@.*$/u, "")
    .split(/[\s._-]+/u)
    .filter((word) => word.length > 0)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");

interface ChartCardProps {
  readonly title: string;
  readonly subheader: string;
  readonly points: readonly TrendValues[];
  readonly series: readonly TrendSeries[];
  readonly emptyMessage: string;
  readonly formatValue?: (value: number) => string;
  readonly scaleMax?: number;
}

const ChartCard = ({
  title,
  subheader,
  points,
  series,
  emptyMessage,
  formatValue,
  scaleMax,
}: ChartCardProps) => (
  <Grid item xs={12} md={6}>
    <InfoCard title={title} subheader={subheader}>
      <TrendChart
        points={points}
        series={series}
        emptyMessage={emptyMessage}
        formatValue={formatValue}
        scaleMax={scaleMax}
      />
    </InfoCard>
  </Grid>
);

const ContributorHeader = ({
  summary,
  fallbackName,
  contributorsPath,
}: {
  summary: ContributorSummary | null;
  fallbackName: string;
  contributorsPath: string;
}) => {
  const classes = useStyles();
  const name = summary?.displayName ?? fallbackName;
  const entityRef = summary?.entityRef ?? null;
  const entityPath = entityRef === null ? null : catalogEntityPath(entityRef);
  const identities = summary === null ? [] : identityLabels(summary);

  return (
    <Box mb={2}>
      <Box className={classes.person} mb={1}>
        <Avatar
          src={summary?.avatarUrl ?? undefined}
          alt={name}
          className={classes.avatar}
        >
          {/* Most directories photograph only some of their people, so the
              fallback is initials rather than a silhouette that would make
              every unphotographed person look like the same person. */}
          {initialsOf(name)}
        </Avatar>
        <Box>
          <Typography variant="h5">{name}</Typography>
          {identities.length > 0 ? (
            <Typography
              variant="caption"
              color="textSecondary"
              className={classes.identities}
            >
              {identities.join(" · ")}
            </Typography>
          ) : null}
        </Box>
      </Box>
      <Box className={classes.links}>
        <Link component={RouterLink} to={contributorsPath}>
          Back to contributors
        </Link>
        {entityPath === null ? null : (
          <Link component={RouterLink} to={entityPath}>
            Open in the catalog
          </Link>
        )}
      </Box>
    </Box>
  );
};

/**
 * Churn, or the reason there is none.
 *
 * Azure DevOps exposes no line count anywhere in its REST API, and a provider
 * that reported neither lines nor files has said nothing about churn. An empty
 * chart would read as a person who deleted as much as they wrote; a sentence
 * reads as what it is.
 */
const ChurnSection = ({
  unit,
  points,
  bucketNote,
}: {
  unit: ContributorSummary["churnUnit"];
  points: readonly TrendValues[];
  bucketNote: string;
}) => {
  const classes = useStyles();
  const label = CHURN_LABELS[unit];

  if (label === null) {
    return (
      <Grid item xs={12} md={6}>
        <InfoCard title="Code churn" subheader="Not reported by this provider.">
          <Typography variant="body2" className={classes.explanation}>
            Neither line counts nor changed-file counts were reported for this
            person's commits, so there is no churn to chart. Azure DevOps
            exposes no line count anywhere in its REST API — reconstructing one
            would mean diffing every blob of every commit — which is why the two
            platforms are never charted in the same unit.
          </Typography>
        </InfoCard>
      </Grid>
    );
  }

  return (
    <ChartCard
      title="Code churn"
      subheader={`${label} over the commits this person authored, in the unit their provider reports. A bucket they spent reviewing rather than writing is a measured zero. ${bucketNote}`}
      points={points}
      series={[{ key: CONTRIBUTOR_SERIES.churn, label, area: true }]}
      emptyMessage="No churn was recorded in this window."
    />
  );
};

/**
 * One person over the last one to six months.
 *
 * The page answers a question the contributors table cannot: not "how much did
 * they do" but "is it going anywhere". Every chart is a chart of a column the
 * table already prints, computed by the same code over a bucket instead of a
 * window, so a figure here and a figure there can never disagree — and the
 * score is taken from the wire rather than recomputed, because a bucket's
 * score is read against the fleet's average in that bucket and the browser
 * only ever holds this one person's row.
 *
 * The person arrives in the query string. A person key is `user:default/jane`
 * for somebody linked and `vcs:jane@acme.com` for an account nobody has linked
 * yet; both carry characters a path segment has to encode, and React Router
 * decodes a segment before matching it, so an encoded slash would split the key
 * in two and the route would never match.
 */
export const ContributorDetailPage = ({
  trendService,
  ownershipService,
  coverage,
  capabilities,
}: ContributorDetailPageProps) => {
  const [parameters] = useSearchParams();
  const key = parameters.get(CONTRIBUTOR_KEY_PARAM);
  const contributorsPath = useRouteRef(contributorsRouteRef)();
  const range = useTrendWindow(coverage.coverage);
  const trend = useContributorTrend(trendService, key, range.window, range.bucket);
  const owned = useOwnedRepositories(ownershipService, key, range.window);

  const response = trend.trend;
  const summary = response?.summary ?? null;
  const points = useMemo(() => response?.points ?? [], [response]);
  const churnUnit = summary?.churnUnit ?? "none";

  const commits = useMemo(() => commitSeries(points), [points]);
  const pullRequests = useMemo(() => pullRequestSeries(points), [points]);
  const reviews = useMemo(() => reviewSeries(points), [points]);
  const churn = useMemo(() => churnSeries(points, churnUnit), [points, churnUnit]);
  const pipeline = useMemo(() => pipelineSeries(points), [points]);
  const score = useMemo(() => scoreSeries(points), [points]);
  const defects = useMemo(() => sonarDefectSeries(points), [points]);
  const sonarCoverage = useMemo(() => sonarCoverageSeries(points), [points]);
  const codingTime = useMemo(() => codingTimeSeries(points), [points]);
  const tickets = useMemo(() => ticketsResolvedSeries(points), [points]);

  // Every hook above runs before this: a page opened without a key still has to
  // obey the rules of hooks, and the guard is cheap enough to pay for it.
  if (key === null) {
    return (
      <>
        <ContentHeader title="Contributor" />
        <WarningPanel
          severity="info"
          title="No contributor was named"
          message="This page shows one person, and the link that opened it carried no key. Pick somebody from the contributors table."
          defaultExpanded
        />
        <Box mt={2}>
          <Link component={RouterLink} to={contributorsPath}>
            Back to contributors
          </Link>
        </Box>
      </>
    );
  }

  const bucketNote = BUCKET_NOTES[range.bucket];

  return (
    <>
      <ContributorHeader
        summary={summary}
        fallbackName={key}
        contributorsPath={contributorsPath}
      />

      <ContentHeader title="Trends">
        <TrendRangePicker
          selection={range.selection}
          offered={range.offered}
          months={range.months}
          onChange={range.select}
        />
      </ContentHeader>

      {trend.error === null ? null : (
        <Box mb={2}>
          <WarningPanel
            severity="error"
            title="Failed to load this contributor"
            message={trend.error}
            defaultExpanded
          />
        </Box>
      )}

      {response === null && trend.error === null ? <Progress /> : null}

      {response !== null && summary === null ? (
        <Box mb={2}>
          <WarningPanel
            severity="info"
            title="Nothing was recorded under this key in the selected range"
            message="Either the link that opened this page names an account the backend has never seen — the key of a person who has since been re-linked changes — or this is simply a period in which they recorded nothing. The charts below are the range's real zeroes, not a failure to load; widening the range is the quickest way to tell the two apart."
          />
        </Box>
      ) : null}

      {response === null ? null : (
        <Grid container spacing={3}>
          <Grid item xs={12}>
            <ScoreCard
              title="Productivity score"
              subheader={
                enabledIntegrations(capabilities).length === 0
                  ? PRODUCTIVITY_SUBHEADER
                  : `${PRODUCTIVITY_SUBHEADER} ${INTEGRATION_SUBHEADER}`
              }
              score={response.score}
              emptyMessage="Nothing measurable was recorded under this key in the selected range, so there is no score to show."
            />
          </Grid>

          {/* Directly under the score, because it is the score's own arithmetic
              written out: a reader who disagrees with the number can see which
              row they disagree with. */}
          {summary === null ? null : (
            <Grid item xs={12}>
              <ContributorRatesCard
                summary={summary}
                window={range.window}
                capabilities={capabilities}
                fleet={response.fleet}
              />
            </Grid>
          )}

          <ChartCard
            title="Commits"
            subheader={`Commits authored, with the pull requests of theirs that merged. A merge commit belongs to nobody and a squash belongs to the pull request's author, so merging somebody else's work adds nothing here. ${bucketNote}`}
            points={commits}
            series={COMMIT_SERIES}
            emptyMessage="No commit was recorded in this window."
          />

          <ChartCard
            title="Pull requests"
            subheader={`Opened against merged. Neither is a subset of the other — one opened in one bucket and merged in the next counts in each — so the lines crossing is information rather than an error. ${bucketNote}`}
            points={pullRequests}
            series={PULL_REQUEST_SERIES}
            emptyMessage="No pull request was recorded in this window."
          />

          <ChartCard
            title="Reviews"
            subheader={`Other people's pull requests this person voted on, and how many of those votes were approvals. Their own pull requests are not reviews, and a reviewer who was added and never voted did not review anything. ${bucketNote}`}
            points={reviews}
            series={REVIEW_SERIES}
            emptyMessage="No review was recorded in this window."
          />

          <ChurnSection unit={churnUnit} points={churn} bucketNote={bucketNote} />

          <ChartCard
            title="Pipeline success rate"
            subheader={`Of this person's pipeline runs that reached a verdict, the share that succeeded. A bucket whose runs were all cancelled or skipped has no rate at all, and the line breaks rather than dropping to zero. ${bucketNote}`}
            points={whenMeasured(pipeline, CONTRIBUTOR_SERIES.pipelineSuccessRate)}
            series={PIPELINE_SERIES}
            emptyMessage="No pipeline run reached a verdict in this window."
            formatValue={formatPercent}
            scaleMax={100}
          />

          <ChartCard
            title="Score over time"
            subheader={`The productivity score each bucket earned, against the team's average rate in that same bucket. A bucket in which nothing measurable happened anywhere has no score, and the line breaks.${
              capabilities.confluence
                ? " Documentation written counts in the score above and on no point here: Confluence answers for a trailing window rather than a day, so a bucket cannot measure it."
                : ""
            } ${bucketNote}`}
            points={whenMeasured(score, CONTRIBUTOR_SERIES.score)}
            series={SCORE_SERIES}
            emptyMessage="Nothing measurable was recorded in this window."
            scaleMax={100}
          />

          <ChartCard
            title="Code touched — bugs and vulnerabilities"
            subheader={`${SONAR_CAVEAT} ${bucketNote}`}
            points={whenMeasured(defects, CONTRIBUTOR_SERIES.bugs)}
            series={DEFECT_SERIES}
            emptyMessage="No Sonar project measured the repositories this person touched in this window."
          />

          <ChartCard
            title="Code touched — test coverage"
            subheader={`${SONAR_CAVEAT} ${bucketNote}`}
            points={whenMeasured(sonarCoverage, CONTRIBUTOR_SERIES.coverage)}
            series={COVERAGE_SERIES}
            emptyMessage="No Sonar project measured the repositories this person touched in this window."
            formatValue={formatPercent}
            scaleMax={100}
          />

          {capabilities.wakatime ? (
            <ChartCard
              title="Coding time"
              subheader={`Hours WakaTime recorded for this person. A bucket their editor never reported is unmeasured rather than idle, and the line breaks. ${bucketNote}`}
              points={whenMeasured(codingTime, CONTRIBUTOR_SERIES.codingHours)}
              series={CODING_TIME_SERIES}
              emptyMessage="WakaTime recorded no coding time for this person in this window."
              formatValue={formatHours}
            />
          ) : null}

          {capabilities.jira ? (
            <ChartCard
              title="Tickets resolved"
              subheader={`Issues assigned to this person that reached a done status. Jira records no "closed by", so this is the same attribution the site's own reports use. ${bucketNote}`}
              points={whenMeasured(tickets, CONTRIBUTOR_SERIES.ticketsResolved)}
              series={TICKET_SERIES}
              emptyMessage="No Atlassian account on this row resolved an issue in this window."
            />
          ) : null}

          <Grid item xs={12}>
            <OwnedRepositoriesCard
              ownership={owned.ownership}
              repositories={owned.repositories}
              isLoading={owned.isLoading}
              error={owned.error}
            />
          </Grid>
        </Grid>
      )}
    </>
  );
};
