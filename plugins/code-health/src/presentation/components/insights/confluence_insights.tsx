import { InfoCard } from "@backstage/core-components";
import type {
  ConfluenceAnalyticsState,
  ContributorSummary,
  RepositorySummary,
} from "@rios0rios0/backstage-plugin-code-health-common";
import { formatCount } from "@rios0rios0/backstage-plugin-code-health-common";
import Box from "@material-ui/core/Box";
import Divider from "@material-ui/core/Divider";
import Grid from "@material-ui/core/Grid";
import Typography from "@material-ui/core/Typography";
import { useMemo } from "react";
import {
  confluenceFleetStats,
  spaceFreshnessBreakdown,
  stalestSpaces,
  strandedPages,
  topConfluenceAuthors,
  topConfluenceWriters,
} from "../../../domain/entities/confluence_insights";
import { GapList } from "../charts/gap_list";
import { RankingChart } from "../charts/ranking_chart";
import { StatTile } from "../charts/stat_tile";
import { StatusBreakdown } from "../charts/status_breakdown";
import { usePersonLink } from "./detail_links";

/**
 * Confluence's three card sets, split by what each one is a question about.
 *
 * What the fleet wrote stays on Insights; who wrote it sits above the
 * contributors table and where the wiki has rotted above the repositories
 * table, beside the rows each of them names.
 *
 * All three are deliberately their own cards rather than more tiles on "At a
 * glance": documentation is a different kind of work from shipping code,
 * measured over a different window, and mixing the two would put a 90-day
 * figure beside a seven-day one with nothing on screen saying so. They render
 * as `Grid` items so each page keeps one grid and one set of breakpoints.
 */

export interface ConfluenceFleetInsightsProps {
  readonly repositories: readonly RepositorySummary[];
  readonly contributors: readonly ContributorSummary[];
}

export interface ConfluenceContributorInsightsProps {
  readonly contributors: readonly ContributorSummary[];
}

export interface ConfluenceRepositoryInsightsProps {
  readonly repositories: readonly RepositorySummary[];
}

/** An em dash for anything the run did not measure, never a zero. */
const formatMeasured = (value: number | null): string =>
  value === null ? "—" : formatCount(value);

const VIEWS_CAPTIONS: Readonly<Record<ConfluenceAnalyticsState, string>> = {
  measured: "of pages written in the window",
  unavailable: "Premium-only API; not available here",
  "not-measured": "not collected on this run",
};

const WINDOW_NOTE =
  "Confluence measures a trailing window fixed by backend configuration — 90 days by " +
  "default — rather than the range selected above. It reports no per-day history, so " +
  "these figures do not move with the range picker.";

/** What the fleet wrote down. */
export const ConfluenceFleetInsights = ({
  repositories,
  contributors,
}: ConfluenceFleetInsightsProps) => {
  const stats = useMemo(
    () => confluenceFleetStats(repositories, contributors),
    [repositories, contributors],
  );

  return (
    <Grid item xs={12}>
      <InfoCard
        title="Confluence"
        subheader={`${formatCount(stats.spaces)} space${
          stats.spaces === 1 ? "" : "s"
        } named by the catalog. ${WINDOW_NOTE}`}
      >
        <Grid container spacing={3}>
          <Grid item xs={6} sm={4} md={2}>
            <StatTile
              label="Pages written"
              value={formatCount(stats.pagesCreated)}
              caption={`${formatCount(stats.pagesEdited)} edited`}
              help="Pages created inside the measured window, with how many pages were touched at all beside it. A page created and then revised counts in both."
            />
          </Grid>
          <Grid item xs={6} sm={4} md={2}>
            <StatTile
              label="Words written"
              value={formatMeasured(stats.wordsAdded)}
              caption={
                stats.volumeUnit === "words"
                  ? `${formatMeasured(stats.wordsRemoved)} pruned`
                  : "no page could be measured"
              }
              help="Words added to page bodies, from the size of the body either side of each edit. Confluence has no line count and serves no diff between two versions, so words are the unit this can honestly be measured in — and an edit that rewrote a paragraph to the same length measures as nothing."
            />
          </Grid>
          <Grid item xs={6} sm={4} md={2}>
            <StatTile
              label="Contributors"
              value={formatCount(stats.authors)}
              caption="wrote something"
              help="Distinct Atlassian accounts that created a page, edited one, commented or attached something. Accounts linked to the same catalog user count once."
            />
          </Grid>
          <Grid item xs={6} sm={4} md={2}>
            <StatTile
              label="Comments"
              value={formatCount(stats.commentsWritten)}
              caption={`${formatCount(stats.attachmentsAdded)} attachments`}
              help="Comments written on pages, inline and footer together — Confluence's search vocabulary does not separate them, and the endpoints that do cannot be filtered by date."
            />
          </Grid>
          <Grid item xs={6} sm={4} md={2}>
            <StatTile
              label="Stale pages"
              value={formatMeasured(stats.stalePages)}
              caption={
                stats.totalPages === null
                  ? "of an unknown total"
                  : `of ${formatCount(stats.totalPages)} pages`
              }
              help="Pages nobody has edited for the configured staleness period, six months by default. This is the number a platform team actually acts on: it is where a reader stops trusting the wiki."
            />
          </Grid>
          <Grid item xs={6} sm={4} md={2}>
            <StatTile
              label="Page views"
              value={formatMeasured(stats.pageViews)}
              caption={VIEWS_CAPTIONS[stats.analytics]}
              help="Views of the pages written in the window. Confluence's analytics API is a Cloud Premium feature and a Standard site refuses it outright, so an em dash here usually means the plan rather than the readership."
            />
          </Grid>
        </Grid>

        {stats.analytics === "unavailable" ? (
          <Box mt={2}>
            <Typography variant="caption" color="textSecondary">
              This site refused the Confluence analytics API. Page views and viewer
              counts are a Confluence Cloud Premium feature; on Standard there is
              nothing to switch on, and the figure stays empty rather than reading as
              zero.
            </Typography>
          </Box>
        ) : null}
      </InfoCard>
    </Grid>
  );
};

/**
 * Who is documenting.
 *
 * Sits above the contributors table because it ranks people, and because the
 * person at the top of it is usually nowhere near the top of the commit
 * ranking — which is the whole reason to have both on one tab.
 */
export const ConfluenceContributorInsights = ({
  contributors,
}: ConfluenceContributorInsightsProps) => {
  const linkToPerson = usePersonLink();
  const authors = useMemo(() => topConfluenceAuthors(contributors), [contributors]);
  const writers = useMemo(() => topConfluenceWriters(contributors), [contributors]);

  return (
    <Grid item xs={12} md={6}>
      <InfoCard
        title="Who is documenting"
        subheader={`Pages, edits, comments and attachments added together. ${WINDOW_NOTE}`}
      >
        <RankingChart
          items={authors}
          unit="contributions"
          showAvatars
          linkTo={linkToPerson}
          emptyMessage="Nobody wrote anything in Confluence in the measured window."
        />
        <Box my={2}>
          <Divider />
        </Box>
        <Box mb={1} fontWeight={500}>
          By volume written
        </Box>
        <RankingChart
          items={writers}
          unit="words"
          showAvatars
          linkTo={linkToPerson}
          emptyMessage="No page's written volume could be measured. Confluence serves no per-edit change size, so this needs the run to fetch page bodies — raise the page-body allowance, or narrow the spaces it sweeps."
        />
      </InfoCard>
    </Grid>
  );
};

/**
 * Where the wiki has stopped being maintained.
 *
 * Sits above the repositories table: every row is a space a repository's
 * catalog entity pointed at, and closing one of these gaps means opening that
 * space and writing. The rows carry no catalog link because a Confluence space
 * is not a catalog entity — there is nothing to link them to.
 */
export const ConfluenceRepositoryInsights = ({
  repositories,
}: ConfluenceRepositoryInsightsProps) => {
  const freshness = useMemo(() => spaceFreshnessBreakdown(repositories), [repositories]);
  const rotting = useMemo(() => stalestSpaces(repositories), [repositories]);
  const stranded = useMemo(() => strandedPages(repositories), [repositories]);

  return (
    <Grid item xs={12} md={6}>
      <InfoCard
        title="Documentation rot"
        subheader={`Where the wiki has stopped being maintained. ${WINDOW_NOTE}`}
      >
        <StatusBreakdown slices={freshness} />
        <Box my={2}>
          <Divider />
        </Box>
        <Box mb={1} fontWeight={500}>
          Spaces with the most stale pages
        </Box>
        <GapList
          gaps={rotting}
          emptyMessage="No space has pages older than the staleness threshold."
        />
        <Box my={2}>
          <Divider />
        </Box>
        <Box mb={1} fontWeight={500}>
          Pages hanging off nothing
        </Box>
        <GapList
          gaps={stranded}
          emptyMessage="Every page in every tracked space sits under a parent."
        />
        <Box mt={2}>
          <Typography variant="caption" color="textSecondary">
            A page with no parent is unreachable by browsing — somebody has to already
            know the link. Confluence Cloud exposes no backlink query at all, so this
            counts parentless pages rather than the orphans its old server report meant.
          </Typography>
        </Box>
      </InfoCard>
    </Grid>
  );
};
