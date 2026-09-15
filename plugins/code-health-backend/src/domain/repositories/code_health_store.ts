import type {
  EventKind,
  IdentitySource,
  IntegrationId,
} from "@rios0rios0/backstage-plugin-code-health-common";
import type { CodeHealthEvent } from "../entities/code_health_event";
import type { Day } from "../entities/day";
import type {
  IdentityExclusionRecord,
  IdentityLinkRecord,
  IdentityRecord,
  IdentityRef,
} from "../entities/identity";
import type { IngestionState } from "../entities/ingestion_state";
import type { RepositorySnapshot } from "../entities/repository_snapshot";
import type { ObservedIdentity } from "../services/identity_resolver";
import type { DiscoveredRepository, TrackedRepository } from "../entities/tracked_repository";

/** A repository together with where its ingestion has got to. */
export interface TrackedRepositoryWithState {
  readonly repository: TrackedRepository;
  readonly state: IngestionState;
}

export interface RecordChunkRequest {
  readonly repositoryId: string;
  readonly kinds: readonly EventKind[];
  readonly days: readonly Day[];
  readonly ingestedAt: Date;
}

/** One stored row of an integration's per-person measures. */
export interface ContributorMetricRow<T> {
  readonly day: Day;
  /** The account key the source reported, not a person. */
  readonly contributorKey: string;
  readonly payload: T;
}

export interface CoverageCounts {
  readonly earliestDay: Day | null;
  readonly latestDay: Day | null;
  readonly lastIngestedAt: Date | null;
  /**
   * The instant *every* tracked repository has data through, which is the real
   * ceiling of what the dashboard can answer for. It runs ahead of `latestDay`,
   * because the incremental phase collects part-days that are not recorded as
   * covered until they finish.
   */
  readonly freshUntil: Date | null;
  readonly repositories: number;
  readonly complete: number;
  readonly failing: number;
  readonly ingestedDays: number;
  readonly expectedDays: number;
}

/**
 * Persistence for everything the plugin ingests.
 *
 * This is one port rather than four because the writes are not independent: an
 * ingestion step has to store its events, record the days it covered, and move
 * its cursor as a single unit. Splitting those across separate repositories
 * would put the transaction boundary outside the port, where a partial failure
 * could advance a cursor past events that were never written.
 */
export interface CodeHealthStore {
  /**
   * Reconciles the tracked set with what the catalog currently holds: inserts
   * new repositories with a fresh ingestion cursor, refreshes the ones still
   * present, and soft-deletes the ones that disappeared.
   *
   * @returns the identifiers of repositories that were newly inserted.
   */
  syncRepositories(options: {
    discovered: readonly DiscoveredRepository[];
    retentionDays: number;
    now: Date;
  }): Promise<{ inserted: string[]; updated: string[]; removed: string[] }>;

  /**
   * Records facts learnt from the provider rather than from the catalog — the
   * default branch, the provider-side identifier, whether the repository is
   * archived. Discovery must not overwrite these, because the catalog does not
   * know them and always reports null.
   */
  updateRepositoryFacts(options: {
    repositoryId: string;
    defaultBranch?: string | null;
    externalId?: string | null;
    archived?: boolean;
  }): Promise<void>;

  listTrackedRepositories(): Promise<TrackedRepositoryWithState[]>;

  getTrackedRepository(id: string): Promise<TrackedRepositoryWithState | undefined>;

  /**
   * Stores events, records the days they cover, and advances the cursors — all
   * in one transaction, so a crash can never leave a cursor claiming a window
   * whose events were lost.
   */
  commitIngestion(options: {
    repositoryId: string;
    events: readonly CodeHealthEvent[];
    chunk: RecordChunkRequest;
    incrementalThrough?: Date;
    backfillCursor?: Day;
    status: IngestionState["status"];
    now: Date;
  }): Promise<void>;

  recordIngestionFailure(options: {
    repositoryId: string;
    error: string;
    now: Date;
  }): Promise<void>;

  saveSnapshot(snapshot: RepositorySnapshot): Promise<void>;

  /**
   * Stores one integration's per-person measures for one day.
   *
   * Keyed by the raw account key the source itself uses — a WakaTime username,
   * an Atlassian account id — rather than by a person. Resolving those to a
   * person happens on read, so re-linking somebody's accounts corrects every
   * window that was already collected instead of only the ones collected since.
   * Storing the resolved person instead would bake a guess into the history.
   */
  saveContributorMetrics<T>(options: {
    source: IntegrationId;
    day: Day;
    capturedAt: Date;
    metrics: ReadonlyMap<string, T>;
  }): Promise<void>;

  /** Every stored row for one source across `[from, to]`, ascending by day. */
  listContributorMetrics<T>(options: {
    source: IntegrationId;
    from: Day;
    to: Day;
  }): Promise<ContributorMetricRow<T>[]>;

  /** The most recent row per account at or before `day`, for one source. */
  listLatestContributorMetrics<T>(options: {
    source: IntegrationId;
    day: Day;
  }): Promise<Map<string, T>>;

  /** The days one source already has rows for, within `[from, to]`. */
  listContributorMetricDays(options: {
    source: IntegrationId;
    from: Day;
    to: Day;
  }): Promise<Day[]>;

  /**
   * Records the accounts a source saw, refreshing the profile fields and
   * `lastSeenAt` on one it already knew about.
   */
  recordObservedIdentities(options: {
    identities: readonly ObservedIdentity[];
    now: Date;
  }): Promise<void>;

  listIdentities(options?: {
    sources?: readonly IdentitySource[];
  }): Promise<IdentityRecord[]>;

  listIdentityLinks(): Promise<IdentityLinkRecord[]>;

  /**
   * Writes a link, replacing whatever was there.
   *
   * An automatic link never replaces a manual one — the store enforces that
   * rather than trusting every caller to remember, because the failure mode is
   * a scheduled task quietly undoing somebody's correction.
   */
  saveIdentityLink(link: IdentityLinkRecord): Promise<void>;

  deleteIdentityLink(identity: IdentityRef): Promise<void>;

  listIdentityExclusions(): Promise<IdentityExclusionRecord[]>;

  /**
   * Takes an account out of every measurement, or replaces the reason on one
   * that is already out.
   *
   * Nothing stored is deleted. The events, the snapshots and the per-source
   * measures stay exactly as they were collected and the exclusion is applied
   * when a row is built, which is what makes {@link deleteIdentityExclusion}
   * restore every window ever collected rather than only the ones collected
   * after somebody changed their mind.
   */
  saveIdentityExclusion(exclusion: IdentityExclusionRecord): Promise<void>;

  deleteIdentityExclusion(identity: IdentityRef): Promise<void>;

  /** Most recent snapshot at or before `day`, per repository. */
  listLatestSnapshots(options: {
    day: Day;
    repositoryIds?: readonly string[];
  }): Promise<RepositorySnapshot[]>;

  /**
   * Every snapshot in `[from, to]`, ascending by day.
   *
   * The trend routes need the state a repository was in at the end of each
   * bucket, and asking `listLatestSnapshots` once per bucket would be one query
   * per point on the chart. One range read plus a baseline of the most recent
   * snapshot at or before `from` answers every bucket, because a day with no
   * snapshot inherits the last one taken before it.
   */
  listSnapshots(options: {
    from: Day;
    to: Day;
    repositoryIds?: readonly string[];
  }): Promise<RepositorySnapshot[]>;

  listEvents(options: {
    from: Date;
    to: Date;
    kinds?: readonly EventKind[];
    repositoryIds?: readonly string[];
  }): Promise<CodeHealthEvent[]>;

  getCoverage(): Promise<CoverageCounts>;

  /**
   * Sends every tracked repository's history collection back to the start,
   * reaching `days` back.
   *
   * The walk re-collects commits, pull requests, reviews and builds, so those
   * are dropped along with the days claimed as fetched; snapshots, releases and
   * tags come from the daily snapshot rather than the walk and stay. A
   * repository that has left the catalog is never ingested again, so its
   * history is left alone rather than deleted with nothing to replace it.
   *
   * One transaction, for the same reason `commitIngestion` is one: a crash
   * between deleting the events and moving the cursors would leave a repository
   * claiming to have fetched days whose rows are gone.
   */
  resetIngestion(options: {
    days: number;
    now: Date;
  }): Promise<{ repositories: number }>;
}
