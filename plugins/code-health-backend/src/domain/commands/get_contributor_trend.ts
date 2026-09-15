import type {
  ConfluenceContributorMetrics,
  ContributorSummary,
  ContributorTrendPoint,
  IntegrationCapabilities,
  JiraContributorMetrics,
  ProductivityScore,
  SonarMetrics,
  TimeSeriesBucket,
  WakaTimeMetrics,
} from "@rios0rios0/backstage-plugin-code-health-common";
import {
  computeProductivityScore,
  fleetReferenceOf,
  NO_INTEGRATIONS,
  windowDaysOf,
} from "@rios0rios0/backstage-plugin-code-health-common";
import { bucketEnd, bucketsInWindow } from "../entities/bucket";
import type { CodeHealthEvent } from "../entities/code_health_event";
import {
  accumulateContributors,
  aggregateContributorSummaries,
  zeroContributorSummary,
} from "../entities/contributor_aggregation";
import { daysBetween, startOfDay, toDay, type Day } from "../entities/day";
import { loadPersonDirectory } from "../entities/person_directory";
import type { RepositorySnapshot } from "../entities/repository_snapshot";
import type {
  CodeHealthStore,
  ContributorMetricRow,
} from "../repositories/code_health_store";
import type { DirectoryReader } from "../services/identity_resolver";
import { sonarByRepository } from "./list_contributor_summaries";

export interface ContributorTrend {
  readonly summary: ContributorSummary | null;
  readonly score: ProductivityScore | null;
  readonly points: readonly ContributorTrendPoint[];
}

/**
 * The Sonar measures each repository carried on each day of the window.
 *
 * Snapshots are taken daily but a run can be missed, and a repository with no
 * Sonar project never gets one at all, so a day with nothing recorded inherits
 * the most recent snapshot before it — the baseline where that is older than
 * the window. Filling forward is what stops a chart from showing a repository's
 * quality gate blinking out on the days its snapshot task did not run.
 */
const sonarTimeline = (
  baseline: readonly RepositorySnapshot[],
  range: readonly RepositorySnapshot[],
): { at: (day: Day) => ReadonlyMap<string, SonarMetrics> } => {
  // Ascending, so a walk can stop at the first day past the one being asked
  // about rather than scanning the whole window for every bucket.
  const ascending = [...range].sort((left, right) => left.day.localeCompare(right.day));

  return {
    at: (day) => {
      const latest = new Map(baseline.map((snapshot) => [snapshot.repositoryId, snapshot]));
      for (const snapshot of ascending) {
        if (snapshot.day > day) break;
        latest.set(snapshot.repositoryId, snapshot);
      }
      return sonarByRepository([...latest.values()]);
    },
  };
};

/**
 * The events of one bucket.
 *
 * Compared as instants rather than as day strings, because an event carries a
 * timestamp and the last day of a bucket runs to the following midnight.
 */
const eventsWithin = (
  events: readonly CodeHealthEvent[],
  from: Day,
  to: Day,
): CodeHealthEvent[] => {
  const start = startOfDay(from).getTime();
  const end = startOfDay(to).getTime() + 24 * 60 * 60 * 1000;
  return events.filter((event) => {
    const at = event.occurredAt.getTime();
    return at >= start && at < end;
  });
};

/** The per-day measure rows of one bucket, both ends included. */
const rowsWithin = <T>(
  rows: readonly ContributorMetricRow<T>[],
  from: Day,
  to: Day,
): ContributorMetricRow<T>[] =>
  rows.filter((row) => row.day >= from && row.day <= to);

export interface GetContributorTrendOptions {
  readonly store: CodeHealthStore;
  readonly directory?: DirectoryReader;
  /**
   * Which integrations this backend was configured with, deciding which
   * components the productivity score is built from.
   *
   * Passed in rather than inferred from the rows, for the same reason the
   * dashboard's columns are: a row carrying no coding time could be an account
   * nobody linked, an integration switched off, or one switched on that has not
   * collected yet, and only the configuration can tell the three apart.
   */
  readonly capabilities?: IntegrationCapabilities;
}

export class GetContributorTrend {
  constructor(private readonly options: GetContributorTrendOptions) {}

  /**
   * One person's history, bucketed, beside the same row the table shows.
   *
   * Everything is loaded once for the whole window and sliced in memory. The
   * alternative — running the contributors query per bucket — is one round of
   * seven queries per point on the chart, which is what turns a six-month
   * weekly trend into twenty-six of them.
   *
   * Every bucket is scored against the fleet *in that bucket*, not against the
   * whole window: a score is a share of the top figure anybody recorded in the
   * same period, and comparing a quiet week against a six-month peak would
   * report a normal week as a collapse. It is also why the whole fleet has to
   * be aggregated per bucket rather than only the person being asked about.
   */
  async run(input: {
    key: string;
    from: Date;
    to: Date;
    bucket: TimeSeriesBucket;
  }): Promise<ContributorTrend> {
    const from = toDay(input.from);
    const to = toDay(input.to);
    const capabilities = this.options.capabilities ?? NO_INTEGRATIONS;

    const [
      events,
      wakaTimeRows,
      jiraRows,
      confluenceRows,
      baseline,
      rangeSnapshots,
      people,
    ] = await Promise.all([
      this.options.store.listEvents({ from: input.from, to: input.to }),
      this.options.store.listContributorMetrics<WakaTimeMetrics>({
        source: "wakatime",
        from,
        to,
      }),
      this.options.store.listContributorMetrics<JiraContributorMetrics>({
        source: "jira",
        from,
        to,
      }),
      // Confluence measures a trailing window rather than a day, so it enriches
      // the whole-window row and no bucket. Repeating one trailing figure on
      // every point would draw a flat line nobody could act on and call it a
      // series.
      this.options.store.listLatestContributorMetrics<ConfluenceContributorMetrics>({
        source: "confluence",
        day: to,
      }),
      this.options.store.listLatestSnapshots({ day: from }),
      this.options.store.listSnapshots({ from, to }),
      loadPersonDirectory(this.options.store),
    ]);

    const sonar = sonarTimeline(baseline, rangeSnapshots);

    const wholeWindow = accumulateContributors({
      events,
      wakaTime: wakaTimeRows,
      jira: jiraRows,
      confluence: confluenceRows,
      people,
    });

    // One lookup, for the one person the page is about. The other rows are only
    // ever used to work out the fleet's top figures, and a name is not one.
    const users =
      this.options.directory === undefined || !input.key.startsWith("user:")
        ? new Map()
        : await this.options.directory.getUsersByRef([input.key]);

    const context = { people, users };
    const windowRows = aggregateContributorSummaries(wholeWindow, {
      ...context,
      sonarByRepository: sonar.at(to),
    });
    const summary = windowRows.find((row) => row.key === input.key) ?? null;
    const score =
      summary === null
        ? null
        : computeProductivityScore(
            summary,
            fleetReferenceOf(
              windowRows,
              windowDaysOf({ from: input.from.toISOString(), to: input.to.toISOString() }),
            ),
            capabilities,
          );

    const points = bucketsInWindow(input.from, input.to, input.bucket).map((start) => {
      const last = bucketEnd(start, input.bucket, to);
      // Both ends are days and the last one is inclusive, so a bucket that
      // starts and ends on the same day spans one day rather than none.
      const bucketDays = daysBetween(start, last) + 1;
      const rows = aggregateContributorSummaries(
        accumulateContributors({
          events: eventsWithin(events, start, last),
          wakaTime: rowsWithin(wakaTimeRows, start, last),
          jira: rowsWithin(jiraRows, start, last),
          confluence: new Map<string, ConfluenceContributorMetrics>(),
          people,
        }),
        { ...context, sonarByRepository: sonar.at(last) },
      );

      // A bucket the person was absent from is still a point. Closing over it
      // would draw a fortnight off as a shorter, busier month; an all-zero row
      // carrying the name the whole window already resolved reads as the quiet
      // fortnight it was.
      const row =
        rows.find((candidate) => candidate.key === input.key) ??
        zeroContributorSummary(input.key, summary ?? undefined);

      return {
        day: start,
        summary: row,
        // Confluence is switched off for a bucket's score on purpose. Its
        // figures describe a trailing window and enrich no bucket (see the
        // read above), so with it on the component would be unmeasured on
        // every point while measured on the headline — and a line folded from
        // one component fewer than the card above it would sit below that
        // card for the whole window, claiming to be the same quantity.
        // The bucket's own length, not the window's: a rate is only comparable
        // against a mean taken over the same period, and the last bucket of a
        // weekly series is routinely a part week.
        score: computeProductivityScore(row, fleetReferenceOf(rows, bucketDays), {
          ...capabilities,
          confluence: false,
        }),
      };
    });

    return { summary, score, points };
  }
}
