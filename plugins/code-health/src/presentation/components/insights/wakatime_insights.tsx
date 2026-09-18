import { InfoCard } from "@backstage/core-components";
import Box from "@material-ui/core/Box";
import Divider from "@material-ui/core/Divider";
import Grid from "@material-ui/core/Grid";
import Typography from "@material-ui/core/Typography";
import type {
  ContributorSummary,
  RepositorySummary,
} from "@rios0rios0/backstage-plugin-code-health-common";
import {
  formatCount,
  formatDuration,
  formatPercent,
  formatTokens,
} from "@rios0rios0/backstage-plugin-code-health-common";
import { useMemo } from "react";
import {
  categoryBreakdown,
  codingTimeSeries,
  editorBreakdown,
  formatOptionalDuration,
  languageBreakdown,
  topContributorsByCodingTime,
  topRepositoriesByCodingTime,
  wakaTimeKpis,
} from "../../../domain/entities/wakatime_insights";
import { RankingChart } from "../charts/ranking_chart";
import { StatTile } from "../charts/stat_tile";
import { usePersonLink, useRepositoryLink } from "./detail_links";

/**
 * WakaTime's three card sets, split by what each one is a question about.
 *
 * The fleet's shape stays on Insights; the ranking of people sits above the
 * contributors table and the ranking of repositories above the repositories
 * table, because a ranking is a way *into* a row and a tab away from the rows
 * it ranks makes a reader carry a name across the screen by hand.
 *
 * All three are rendered as `Grid item` children so each page composes them
 * into its own grid, and so a fleet without WakaTime is a section that is never
 * built rather than one full of empty cards.
 */

export interface WakaTimeFleetInsightsProps {
  readonly contributors: readonly ContributorSummary[];
}

export interface WakaTimeContributorInsightsProps {
  readonly contributors: readonly ContributorSummary[];
}

export interface WakaTimeRepositoryInsightsProps {
  readonly repositories: readonly RepositorySummary[];
}

/**
 * Where the fleet's attention actually went.
 *
 * The one section here that measures effort rather than output. Everything else
 * on the Insights tab counts things a version control provider produced — a
 * commit, a merged pull request, a green pipeline — and none of them can see
 * the afternoon somebody spent reading code that produced no commit at all.
 *
 * The three breakdowns share one card and one row of columns rather than being
 * spread across the page: they are three cuts of the same total, and reading
 * them side by side is the point — an hour that shows up under "code
 * reviewing" is also an hour in some language, in some editor.
 */
export const WakaTimeFleetInsights = ({ contributors }: WakaTimeFleetInsightsProps) => {
  const kpis = useMemo(() => wakaTimeKpis(contributors), [contributors]);
  const languages = useMemo(() => languageBreakdown(contributors), [contributors]);
  const editors = useMemo(() => editorBreakdown(contributors), [contributors]);
  const categories = useMemo(() => categoryBreakdown(contributors), [contributors]);
  const trend = useMemo(() => codingTimeSeries(contributors), [contributors]);

  const busiestDay = useMemo(
    () =>
      trend.reduce<{ day: string; totalSeconds: number } | null>(
        (best, point) =>
          best === null || point.totalSeconds > best.totalSeconds ? point : best,
        null,
      ),
    [trend],
  );

  return (
    <>
      <Grid item xs={12}>
        <InfoCard
          title="Where the time went"
          subheader="Measured in the editor by WakaTime, which sees the work a commit never records"
        >
          <Grid container spacing={3}>
            <Grid item xs={6} sm={4} md={2}>
              <StatTile
                label="Coding time"
                value={formatDuration(kpis.totalSeconds)}
                caption="across the fleet"
                help="Total time WakaTime recorded in an editor inside the window, summed over everybody who has it installed."
              />
            </Grid>
            <Grid item xs={6} sm={4} md={2}>
              <StatTile
                label="Per person"
                value={formatOptionalDuration(kpis.averageSecondsPerContributor)}
                caption={`${formatCount(kpis.measuredContributors)} measured`}
                help="Mean across the people who logged any time at all. Dividing by everybody who committed would make the figure fall whenever somebody without WakaTime installed pushes a commit, which says nothing about how the team works."
              />
            </Grid>
            <Grid item xs={6} sm={4} md={2}>
              <StatTile
                label="Top language"
                value={kpis.topLanguage?.name ?? "—"}
                caption={
                  kpis.topLanguage === null
                    ? undefined
                    : `${formatPercent(kpis.topLanguage.percent)} of the time`
                }
              />
            </Grid>
            <Grid item xs={6} sm={4} md={2}>
              <StatTile
                label="Top editor"
                value={kpis.topEditor?.name ?? "—"}
                caption={
                  kpis.topEditor === null
                    ? undefined
                    : `${formatPercent(kpis.topEditor.percent)} of the time`
                }
              />
            </Grid>
            <Grid item xs={6} sm={4} md={2}>
              <StatTile
                label="AI-written lines"
                value={
                  kpis.aiAuthorshipPercent === null
                    ? "—"
                    : formatPercent(kpis.aiAuthorshipPercent)
                }
                caption="of lines added"
                help="Share of the lines added in an editor that WakaTime attributed to AI rather than to typing. Empty means the AI figures were never collected — set `codeHealth.wakaTime.includeAiMetrics` to start — not that nobody used AI."
              />
            </Grid>
            <Grid item xs={6} sm={4} md={2}>
              <StatTile
                label="AI tokens"
                value={kpis.aiTokens === null ? "—" : formatTokens(kpis.aiTokens)}
                caption="prompt and completion"
                help="The only token count any system here can see. No version control provider knows whether a line was typed or accepted from a completion; WakaTime's editor plugins do."
              />
            </Grid>
          </Grid>

          {busiestDay === null ? null : (
            <>
              <Box my={2}>
                <Divider />
              </Box>
              <Typography variant="caption" color="textSecondary">
                Busiest day: {busiestDay.day} with {formatDuration(busiestDay.totalSeconds)} logged.
              </Typography>
            </>
          )}
        </InfoCard>
      </Grid>

      <Grid item xs={12}>
        <InfoCard
          title="What the time went into"
          subheader="The same hours cut three ways: the kind of work, the language it was in, and the editor it happened in"
        >
          <Grid container spacing={3}>
            <Grid item xs={12} md={4}>
              <Box mb={1} fontWeight={500}>
                Categories
              </Box>
              <RankingChart
                items={categories}
                unit="of coding time"
                formatValue={formatDuration}
                emptyMessage="WakaTime reported no category breakdown for this window. Not every plan returns one."
              />
            </Grid>
            <Grid item xs={12} md={4}>
              <Box mb={1} fontWeight={500}>
                Languages
              </Box>
              <RankingChart
                items={languages}
                unit="of coding time"
                formatValue={formatDuration}
                emptyMessage="No coding time was recorded in this window."
              />
            </Grid>
            <Grid item xs={12} md={4}>
              <Box mb={1} fontWeight={500}>
                Editors
              </Box>
              <RankingChart
                items={editors}
                unit="of coding time"
                formatValue={formatDuration}
                emptyMessage="No coding time was recorded in this window."
              />
            </Grid>
          </Grid>
        </InfoCard>
      </Grid>
    </>
  );
};

/**
 * Who spent the time.
 *
 * Sits above the contributors table because hours in an editor is a ranking of
 * *people*, and a different one from commits: the person who spent the week
 * reading code to find one wrong line shows up here and nowhere else.
 */
export const WakaTimeContributorInsights = ({
  contributors,
}: WakaTimeContributorInsightsProps) => {
  const linkToPerson = usePersonLink();
  const people = useMemo(() => topContributorsByCodingTime(contributors), [contributors]);

  return (
    <Grid item xs={12} md={6}>
      <InfoCard
        title="Who spent the time"
        subheader="Hours in an editor, which is a different ranking from commits"
      >
        <RankingChart
          items={people}
          unit="of coding time"
          showAvatars
          formatValue={formatDuration}
          linkTo={linkToPerson}
          emptyMessage="Nobody logged any coding time in this window."
        />
      </InfoCard>
    </Grid>
  );
};

/**
 * Where the time went, by repository.
 *
 * Sits above the repositories table, where each row is one the reader is about
 * to look up. WakaTime measures a person and a *project*, so this is the sum of
 * what a repository's people logged against the project matching it — which is
 * why a repository can be busy here and quiet in the commit ranking.
 */
export const WakaTimeRepositoryInsights = ({
  repositories,
}: WakaTimeRepositoryInsightsProps) => {
  const linkToRepository = useRepositoryLink();
  const projects = useMemo(() => topRepositoriesByCodingTime(repositories), [repositories]);

  return (
    <Grid item xs={12} md={6}>
      <InfoCard
        title="Where the time went, by repository"
        subheader="Matched to the WakaTime project by name, or by the `wakatime.com/project` annotation"
      >
        <RankingChart
          items={projects}
          unit="of coding time"
          formatValue={formatDuration}
          linkTo={linkToRepository}
          emptyMessage="No repository matched a WakaTime project in this window. Add a `wakatime.com/project` annotation to a catalog entity whose project is named differently."
        />
      </InfoCard>
    </Grid>
  );
};
