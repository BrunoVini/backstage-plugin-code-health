import { NotFoundError } from "@backstage/errors";
import type {
  RepositoryHealthScore,
  RepositorySummary,
  RepositoryTrendPoint,
  TimeSeriesBucket,
  WakaTimeMetrics,
} from "@rios0rios0/backstage-plugin-code-health-common";
import { computeRepositoryHealthScore } from "@rios0rios0/backstage-plugin-code-health-common";
import { bucketEnd, bucketsInWindow } from "../entities/bucket";
import type { CodeHealthEvent } from "../entities/code_health_event";
import { lastDayOf, startOfDay, toDay, type Day } from "../entities/day";
import {
  loadPersonDirectory,
  measuredContributorMetrics,
  measuredEvents,
} from "../entities/person_directory";
import type {
  RepositorySnapshot,
  RepositorySnapshotPayload,
} from "../entities/repository_snapshot";
import {
  aggregateWakaTimeProjects,
  buildRepositorySummary,
  unsnapshotted,
} from "../entities/repository_summary_builder";
import type {
  CodeHealthStore,
  ContributorMetricRow,
} from "../repositories/code_health_store";
import type { CatalogReader } from "../services/catalog_reader";
import { resolveOwnerProfiles } from "./list_repository_summaries";

export interface RepositoryTrend {
  readonly summary: RepositorySummary;
  readonly score: RepositoryHealthScore;
  readonly points: readonly RepositoryTrendPoint[];
}

/**
 * The snapshot this repository carried on each day of the window.
 *
 * A day with no snapshot inherits the most recent one before it — the baseline
 * where that is older than the window, and nothing at all before the first
 * snapshot ever taken. Sonar, compliance and badge history cannot be
 * backfilled, so the series genuinely begins at installation, and filling
 * forward is what keeps the days after it from blinking out whenever the
 * snapshot task missed a run.
 */
const snapshotTimeline = (
  baseline: RepositorySnapshot | undefined,
  range: readonly RepositorySnapshot[],
): ((day: Day) => RepositorySnapshotPayload | null) => {
  const ascending = [...range].sort((left, right) => left.day.localeCompare(right.day));

  return (day) => {
    let latest = baseline?.payload ?? null;
    for (const snapshot of ascending) {
      if (snapshot.day > day) break;
      latest = snapshot.payload;
    }
    return latest;
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

/** The per-day WakaTime rows of one bucket, both ends included. */
const rowsWithin = (
  rows: readonly ContributorMetricRow<WakaTimeMetrics>[],
  from: Day,
  to: Day,
): ContributorMetricRow<WakaTimeMetrics>[] =>
  rows.filter((row) => row.day >= from && row.day <= to);

export class GetRepositoryTrend {
  constructor(
    private readonly store: CodeHealthStore,
    /**
     * Resolves the owner to a name and a photograph, so the detail page's
     * header reads the same as the table row it was opened from. Optional for
     * the same reason it is on the table: no catalog means slugs, not a
     * failure.
     */
    private readonly catalog?: Pick<CatalogReader, "getEntityProfiles">,
  ) {}

  /**
   * One repository's history, bucketed, beside the row the table shows.
   *
   * Each point is the bucket's own events against the state the repository was
   * in at the end of that bucket, so a health score moves when the quality gate
   * or the compliance checks moved rather than when the chart was drawn. The
   * whole-window row on top is built the same way with the window's own end,
   * which is what makes the headline and the last point agree.
   */
  async run(input: {
    repositoryId: string;
    from: Date;
    to: Date;
    bucket: TimeSeriesBucket;
  }): Promise<RepositoryTrend> {
    const from = toDay(input.from);
    // The day before `to` when the window ends at midnight — see `lastDayOf`.
    const to = lastDayOf(input.to);
    const repositoryIds = [input.repositoryId];

    const [tracked, collected, collectedWakaTime, [baseline], rangeSnapshots, people] =
      await Promise.all([
        this.store.getTrackedRepository(input.repositoryId),
        this.store.listEvents({ from: input.from, to: input.to, repositoryIds }),
        this.store.listContributorMetrics<WakaTimeMetrics>({
          source: "wakatime",
          from,
          to,
        }),
        this.store.listLatestSnapshots({ day: from, repositoryIds }),
        this.store.listSnapshots({ from, to, repositoryIds }),
        loadPersonDirectory(this.store),
      ]);

    // Both resolved here rather than per bucket, so the headline row and every
    // point under it are built from the same measurements and cannot disagree
    // about who was measured.
    const events = measuredEvents(collected, people);
    const wakaTimeRows = measuredContributorMetrics(collectedWakaTime, people, "wakatime");

    // The router has already answered 404 for an untracked id; this covers the
    // repository that left the catalog between the two reads, and answers the
    // same way rather than building a row out of nothing.
    if (tracked === undefined) {
      throw new NotFoundError(`no repository with id ${input.repositoryId}`);
    }
    const repository = tracked.repository;
    const snapshotAt = snapshotTimeline(baseline, rangeSnapshots);

    // One reference, so one lookup — and resolved once for the whole page
    // rather than per bucket, where the answer could not differ. Through the
    // table's own resolver, so an unreachable catalog degrades to the slug here
    // too rather than failing a trend whose every other figure is already in
    // hand.
    const ownerRef = repository.catalogFacts.ownerRef;
    const ownerProfiles = await resolveOwnerProfiles(
      this.catalog,
      ownerRef === null ? [] : [ownerRef],
    );

    const rowFor = (
      day: Day,
      bucketEvents: readonly CodeHealthEvent[],
      window: { from: Day; to: Day },
    ): RepositorySummary =>
      buildRepositorySummary(
        repository,
        // Null before the first snapshot was ever taken, which is a real state
        // for a repository discovered this morning: it has counters hours
        // before it has anything to grade.
        snapshotAt(day) ?? unsnapshotted(repository),
        bucketEvents,
        aggregateWakaTimeProjects(rowsWithin(wakaTimeRows, window.from, window.to)),
        window,
        ownerProfiles,
      );

    const summary = rowFor(to, events, { from, to });

    const points = bucketsInWindow(input.from, input.to, input.bucket).map((start) => {
      const last = bucketEnd(start, input.bucket, to);
      const row = rowFor(last, eventsWithin(events, start, last), { from: start, to: last });
      return { day: start, summary: row, score: computeRepositoryHealthScore(row) };
    });

    return { summary, score: computeRepositoryHealthScore(summary), points };
  }
}
