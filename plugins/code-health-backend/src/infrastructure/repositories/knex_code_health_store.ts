import { resolvePackagePath, type DatabaseService } from "@backstage/backend-plugin-api";
import type {
  EventKind,
  ExclusionReason,
  IdentityLinkOrigin,
  IdentitySource,
  IntegrationId,
  Platform,
} from "@rios0rios0/backstage-plugin-code-health-common";
import type { Knex } from "knex";
import type { CodeHealthEvent, EventOutcome } from "../../domain/entities/code_health_event";
import { eventId } from "../../domain/entities/code_health_event";
import { addDays, daysBetween, fromStoredDate, toDay, type Day } from "../../domain/entities/day";
import type {
  IdentityExclusionRecord,
  IdentityLinkRecord,
  IdentityRecord,
  IdentityRef,
} from "../../domain/entities/identity";
import type { IngestionState } from "../../domain/entities/ingestion_state";
import type {
  RepositorySnapshot,
  RepositorySnapshotPayload,
} from "../../domain/entities/repository_snapshot";
import {
  EMPTY_CATALOG_FACTS,
  type DiscoveredRepository,
  type TrackedRepository,
} from "../../domain/entities/tracked_repository";
import type {
  CodeHealthStore,
  ContributorMetricRow,
  CoverageCounts,
  RecordChunkRequest,
  TrackedRepositoryWithState,
} from "../../domain/repositories/code_health_store";
import type { ObservedIdentity } from "../../domain/services/identity_resolver";

const MIGRATIONS_DIR = resolvePackagePath(
  "@rios0rios0/backstage-plugin-code-health-backend",
  "migrations",
);

const REPOSITORIES = "code_health_repositories";
const INGESTION_STATE = "code_health_ingestion_state";
const EVENTS = "code_health_events";
const CHUNKS = "code_health_ingested_chunks";
const SNAPSHOTS = "code_health_snapshots";
const CONTRIBUTOR_MEASURES = "code_health_contributor_measures";
const IDENTITIES = "code_health_identities";
const IDENTITY_LINKS = "code_health_identity_links";
const IDENTITY_EXCLUSIONS = "code_health_identity_exclusions";

/** Rows are inserted in batches so a large window does not build one huge statement. */
const INSERT_BATCH_SIZE = 200;

interface RepositoryRow {
  id: string;
  entity_ref: string;
  provider: string;
  host: string;
  owner: string;
  project: string | null;
  name: string;
  repo_url: string;
  default_branch: string | null;
  external_id: string | null;
  sonar_project_key: string | null;
  entity_kind: string | null;
  entity_type: string | null;
  owner_ref: string | null;
  techdocs_ref: string | null;
  provides_apis: number | null;
  has_external_docs: boolean | number | null;
  jira_project_key: string | null;
  jira_component: string | null;
  confluence_space_key: string | null;
  wakatime_project: string | null;
  archived: boolean | number;
  discovered_at: Date | string;
  last_seen_at: Date | string;
  removed_at: Date | string | null;
}

interface IngestionStateRow {
  repository_id: string;
  backfill_floor: Date | string;
  backfill_cursor: Date | string;
  incremental_through: Date | string;
  status: string;
  failure_count: number;
  last_error: string | null;
  last_attempt_at: Date | string | null;
}

interface EventRow {
  repository_id: string;
  kind: string;
  external_id: string;
  occurred_at: Date | string;
  actor_key: string | null;
  actor_name: string | null;
  actor_avatar_url: string | null;
  outcome: string | null;
  additions: number | null;
  deletions: number | null;
  changed_files: number | null;
  payload: string | null;
}

interface SnapshotRow {
  repository_id: string;
  day: Date | string;
  captured_at: Date | string;
  payload: string;
}

interface ContributorMeasureRow {
  source: string;
  day: Date | string;
  contributor_key: string;
  captured_at: Date | string;
  payload: string;
}

interface IdentityRow {
  source: string;
  source_key: string;
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
  profile_url: string | null;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
}

interface IdentityLinkRow {
  source: string;
  source_key: string;
  entity_ref: string;
  origin: string;
  linked_by: string | null;
  linked_at: Date | string;
}

interface IdentityExclusionRow {
  source: string;
  source_key: string;
  reason: string;
  excluded_by: string | null;
  excluded_at: Date | string;
}

const toDate = (value: Date | string): Date =>
  value instanceof Date ? value : new Date(value);

const toNullableDate = (value: Date | string | null): Date | null =>
  value === null ? null : toDate(value);

const parsePayload = (value: string | null): Record<string, unknown> | null => {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const toRepository = (row: RepositoryRow): TrackedRepository => ({
  id: row.id,
  entityRef: row.entity_ref,
  platform: row.provider as Platform,
  host: row.host,
  owner: row.owner,
  project: row.project,
  name: row.name,
  repoUrl: row.repo_url,
  defaultBranch: row.default_branch,
  externalId: row.external_id,
  sonarProjectKey: row.sonar_project_key,
  catalogFacts: {
    // A row written before the catalog-facts migration reports null for all of
    // these until the next discovery pass refreshes it, so each falls back to
    // the same "nothing known" value a fresh entity without the field would get.
    entityKind: row.entity_kind ?? EMPTY_CATALOG_FACTS.entityKind,
    entityType: row.entity_type,
    ownerRef: row.owner_ref ?? null,
    techDocsRef: row.techdocs_ref,
    providesApis: row.provides_apis ?? 0,
    hasExternalDocs: Boolean(row.has_external_docs),
    jiraProjectKey: row.jira_project_key ?? null,
    jiraComponent: row.jira_component ?? null,
    confluenceSpaceKey: row.confluence_space_key ?? null,
    wakaTimeProject: row.wakatime_project ?? null,
  },
  archived: Boolean(row.archived),
  discoveredAt: toDate(row.discovered_at),
  lastSeenAt: toDate(row.last_seen_at),
  removedAt: toNullableDate(row.removed_at),
});

const toIngestionState = (row: IngestionStateRow): IngestionState => ({
  repositoryId: row.repository_id,
  backfillFloor: fromStoredDate(row.backfill_floor),
  backfillCursor: fromStoredDate(row.backfill_cursor),
  incrementalThrough: toDate(row.incremental_through),
  status: row.status as IngestionState["status"],
  failureCount: row.failure_count,
  lastError: row.last_error,
  lastAttemptAt: toNullableDate(row.last_attempt_at),
});

const toEvent = (row: EventRow): CodeHealthEvent => ({
  repositoryId: row.repository_id,
  kind: row.kind as EventKind,
  externalId: row.external_id,
  occurredAt: toDate(row.occurred_at),
  actorKey: row.actor_key,
  actorName: row.actor_name,
  actorAvatarUrl: row.actor_avatar_url,
  outcome: row.outcome as EventOutcome | null,
  additions: row.additions,
  deletions: row.deletions,
  changedFiles: row.changed_files,
  payload: parsePayload(row.payload),
});

const toEventRow = (event: CodeHealthEvent) => ({
  id: eventId(event),
  repository_id: event.repositoryId,
  kind: event.kind,
  external_id: event.externalId,
  occurred_at: event.occurredAt,
  actor_key: event.actorKey,
  actor_name: event.actorName,
  actor_avatar_url: event.actorAvatarUrl,
  outcome: event.outcome,
  additions: event.additions,
  deletions: event.deletions,
  changed_files: event.changedFiles,
  payload: event.payload === null ? null : JSON.stringify(event.payload),
});

const toIdentityRecord = (row: IdentityRow): IdentityRecord => ({
  source: row.source as IdentitySource,
  sourceKey: row.source_key,
  displayName: row.display_name,
  email: row.email,
  avatarUrl: row.avatar_url,
  profileUrl: row.profile_url,
  firstSeenAt: toDate(row.first_seen_at),
  lastSeenAt: toDate(row.last_seen_at),
});

const toIdentityLink = (row: IdentityLinkRow): IdentityLinkRecord => ({
  source: row.source as IdentitySource,
  sourceKey: row.source_key,
  entityRef: row.entity_ref,
  origin: row.origin as IdentityLinkOrigin,
  linkedBy: row.linked_by,
  linkedAt: toDate(row.linked_at),
});

const toIdentityExclusion = (row: IdentityExclusionRow): IdentityExclusionRecord => ({
  source: row.source as IdentitySource,
  sourceKey: row.source_key,
  reason: row.reason as ExclusionReason,
  excludedBy: row.excluded_by,
  excludedAt: toDate(row.excluded_at),
});

/** Adds whole days to an instant, preserving the time of day. */
const addDaysToDate = (instant: Date, days: number): Date =>
  new Date(instant.getTime() + days * 24 * 60 * 60 * 1000);

export class KnexCodeHealthStore implements CodeHealthStore {
  private constructor(private readonly client: Knex) {}

  static async create(options: {
    database: DatabaseService;
    skipMigrations?: boolean;
  }): Promise<KnexCodeHealthStore> {
    const client = await options.database.getClient();

    if (!options.database.migrations?.skip && !options.skipMigrations) {
      await client.migrate.latest({ directory: MIGRATIONS_DIR });
    }

    return new KnexCodeHealthStore(client);
  }

  async syncRepositories(options: {
    discovered: readonly DiscoveredRepository[];
    retentionDays: number;
    now: Date;
  }): Promise<{ inserted: string[]; updated: string[]; removed: string[] }> {
    const { discovered, retentionDays, now } = options;
    const today = toDay(now);
    const floor = addDays(today, -retentionDays);
    const discoveredIds = new Set(discovered.map((repository) => repository.id));

    return this.client.transaction(async (trx) => {
      const existing = await trx<RepositoryRow>(REPOSITORIES).select("id", "removed_at");
      const existingIds = new Set(existing.map((row) => row.id));

      const inserted: string[] = [];
      const updated: string[] = [];

      for (const repository of discovered) {
        const row = {
          id: repository.id,
          entity_ref: repository.entityRef,
          provider: repository.platform,
          host: repository.host,
          owner: repository.owner,
          project: repository.project,
          name: repository.name,
          repo_url: repository.repoUrl,
          default_branch: repository.defaultBranch,
          external_id: repository.externalId,
          sonar_project_key: repository.sonarProjectKey,
          entity_kind: repository.catalogFacts.entityKind,
          entity_type: repository.catalogFacts.entityType,
          owner_ref: repository.catalogFacts.ownerRef,
          techdocs_ref: repository.catalogFacts.techDocsRef,
          provides_apis: repository.catalogFacts.providesApis,
          has_external_docs: repository.catalogFacts.hasExternalDocs,
          jira_project_key: repository.catalogFacts.jiraProjectKey,
          jira_component: repository.catalogFacts.jiraComponent,
          confluence_space_key: repository.catalogFacts.confluenceSpaceKey,
          wakatime_project: repository.catalogFacts.wakaTimeProject,
          archived: repository.archived,
          last_seen_at: now,
          removed_at: null,
        };

        if (existingIds.has(repository.id)) {
          // `default_branch` and `external_id` are learnt from the provider
          // during ingestion, not from the catalog, so a rediscovery must not
          // overwrite them with the nulls it always carries.
          const { default_branch, external_id, ...refreshable } = row;
          await trx(REPOSITORIES).where({ id: repository.id }).update(refreshable);
          updated.push(repository.id);
        } else {
          await trx(REPOSITORIES).insert({ ...row, discovered_at: now });
          await trx(INGESTION_STATE).insert({
            repository_id: repository.id,
            backfill_floor: floor,
            backfill_cursor: today,
            // Start one day back so the very first run has a window to fetch
            // and the dashboard can answer for "the last day" immediately.
            incremental_through: addDaysToDate(now, -1),
            status: "pending",
            failure_count: 0,
            last_error: null,
            last_attempt_at: null,
          });
          inserted.push(repository.id);
        }
      }

      const removed = existing
        .filter((row) => !discoveredIds.has(row.id) && row.removed_at === null)
        .map((row) => row.id);

      if (removed.length > 0) {
        await trx(REPOSITORIES).whereIn("id", removed).update({ removed_at: now });
      }

      return { inserted, updated, removed };
    });
  }

  async updateRepositoryFacts(options: {
    repositoryId: string;
    defaultBranch?: string | null;
    externalId?: string | null;
    archived?: boolean;
  }): Promise<void> {
    const update: Record<string, unknown> = {};
    if (options.defaultBranch !== undefined) update.default_branch = options.defaultBranch;
    if (options.externalId !== undefined) update.external_id = options.externalId;
    if (options.archived !== undefined) update.archived = options.archived;
    if (Object.keys(update).length === 0) return;

    await this.client(REPOSITORIES).where({ id: options.repositoryId }).update(update);
  }

  async listTrackedRepositories(): Promise<TrackedRepositoryWithState[]> {
    const rows = await this.client<RepositoryRow>(REPOSITORIES)
      .innerJoin<IngestionStateRow>(
        INGESTION_STATE,
        `${INGESTION_STATE}.repository_id`,
        `${REPOSITORIES}.id`,
      )
      .whereNull(`${REPOSITORIES}.removed_at`)
      .select(`${REPOSITORIES}.*`, `${INGESTION_STATE}.*`);

    return rows.map((row) => ({
      repository: toRepository(row as unknown as RepositoryRow),
      state: toIngestionState(row as unknown as IngestionStateRow),
    }));
  }

  async getTrackedRepository(id: string): Promise<TrackedRepositoryWithState | undefined> {
    const row = await this.client<RepositoryRow>(REPOSITORIES)
      .innerJoin<IngestionStateRow>(
        INGESTION_STATE,
        `${INGESTION_STATE}.repository_id`,
        `${REPOSITORIES}.id`,
      )
      .where(`${REPOSITORIES}.id`, id)
      .select(`${REPOSITORIES}.*`, `${INGESTION_STATE}.*`)
      .first();

    if (!row) return undefined;

    return {
      repository: toRepository(row as unknown as RepositoryRow),
      state: toIngestionState(row as unknown as IngestionStateRow),
    };
  }

  async commitIngestion(options: {
    repositoryId: string;
    events: readonly CodeHealthEvent[];
    chunk: RecordChunkRequest;
    incrementalThrough?: Date;
    backfillCursor?: Day;
    status: IngestionState["status"];
    now: Date;
  }): Promise<void> {
    const { repositoryId, events, chunk, incrementalThrough, backfillCursor, status, now } =
      options;

    await this.client.transaction(async (trx) => {
      for (let index = 0; index < events.length; index += INSERT_BATCH_SIZE) {
        const batch = events.slice(index, index + INSERT_BATCH_SIZE).map(toEventRow);
        await trx(EVENTS).insert(batch).onConflict("id").merge();
      }

      const chunkRows = chunk.kinds.flatMap((kind) =>
        chunk.days.map((day) => ({
          repository_id: chunk.repositoryId,
          kind,
          day,
          ingested_at: chunk.ingestedAt,
        })),
      );

      for (let index = 0; index < chunkRows.length; index += INSERT_BATCH_SIZE) {
        const batch = chunkRows.slice(index, index + INSERT_BATCH_SIZE);
        await trx(CHUNKS)
          .insert(batch)
          .onConflict(["repository_id", "kind", "day"])
          .merge(["ingested_at"]);
      }

      const update: Record<string, unknown> = {
        status,
        failure_count: 0,
        last_error: null,
        last_attempt_at: now,
      };
      if (incrementalThrough !== undefined) update.incremental_through = incrementalThrough;
      if (backfillCursor !== undefined) update.backfill_cursor = backfillCursor;

      await trx(INGESTION_STATE).where({ repository_id: repositoryId }).update(update);
    });
  }

  async recordIngestionFailure(options: {
    repositoryId: string;
    error: string;
    now: Date;
  }): Promise<void> {
    await this.client(INGESTION_STATE)
      .where({ repository_id: options.repositoryId })
      .update({
        status: "error",
        last_error: options.error.slice(0, 2000),
        last_attempt_at: options.now,
        failure_count: this.client.raw("failure_count + 1"),
      });
  }

  async saveSnapshot(snapshot: RepositorySnapshot): Promise<void> {
    await this.client(SNAPSHOTS)
      .insert({
        repository_id: snapshot.repositoryId,
        day: snapshot.day,
        captured_at: snapshot.capturedAt,
        payload: JSON.stringify(snapshot.payload),
      })
      .onConflict(["repository_id", "day"])
      .merge(["captured_at", "payload"]);
  }

  async saveContributorMetrics<T>(options: {
    source: IntegrationId;
    day: Day;
    capturedAt: Date;
    metrics: ReadonlyMap<string, T>;
  }): Promise<void> {
    const rows = [...options.metrics.entries()].map(([contributorKey, metrics]) => ({
      source: options.source,
      day: options.day,
      contributor_key: contributorKey,
      captured_at: options.capturedAt,
      payload: JSON.stringify(metrics),
    }));
    if (rows.length === 0) return;

    for (let index = 0; index < rows.length; index += INSERT_BATCH_SIZE) {
      await this.client(CONTRIBUTOR_MEASURES)
        .insert(rows.slice(index, index + INSERT_BATCH_SIZE))
        .onConflict(["source", "day", "contributor_key"])
        .merge(["captured_at", "payload"]);
    }
  }

  async listContributorMetrics<T>(options: {
    source: IntegrationId;
    from: Day;
    to: Day;
  }): Promise<ContributorMetricRow<T>[]> {
    const rows = await this.client<ContributorMeasureRow>(CONTRIBUTOR_MEASURES)
      .where({ source: options.source })
      .andWhere("day", ">=", options.from)
      .andWhere("day", "<=", options.to)
      .orderBy("day", "asc");

    return rows.map((row) => ({
      day: fromStoredDate(row.day),
      contributorKey: row.contributor_key,
      payload: JSON.parse(row.payload) as T,
    }));
  }

  async listLatestContributorMetrics<T>(options: {
    source: IntegrationId;
    day: Day;
  }): Promise<Map<string, T>> {
    const rows = await this.client<ContributorMeasureRow>(CONTRIBUTOR_MEASURES)
      .where({ source: options.source })
      .andWhere("day", "<=", options.day)
      .orderBy("contributor_key")
      .orderBy("day", "desc");

    const latest = new Map<string, T>();
    for (const row of rows) {
      if (latest.has(row.contributor_key)) continue;
      latest.set(row.contributor_key, JSON.parse(row.payload) as T);
    }
    return latest;
  }

  async listContributorMetricDays(options: {
    source: IntegrationId;
    from: Day;
    to: Day;
  }): Promise<Day[]> {
    // Distinct rather than every row: the caller only wants to know which days
    // it can skip, and a busy organisation has one row per person per day.
    const rows = await this.client<ContributorMeasureRow>(CONTRIBUTOR_MEASURES)
      .where({ source: options.source })
      .andWhere("day", ">=", options.from)
      .andWhere("day", "<=", options.to)
      .distinct("day")
      .orderBy("day", "asc");

    return rows.map((row) => fromStoredDate(row.day));
  }

  async recordObservedIdentities(options: {
    identities: readonly ObservedIdentity[];
    now: Date;
  }): Promise<void> {
    if (options.identities.length === 0) return;

    // Deduplicated in memory first: `onConflict().merge()` cannot handle a
    // batch that names the same key twice, and a single ingestion window
    // routinely reports one person on a dozen commits.
    const byKey = new Map<string, ObservedIdentity>();
    for (const identity of options.identities) {
      byKey.set(`${identity.source}:${identity.sourceKey}`, identity);
    }

    const rows = [...byKey.values()].map((identity) => ({
      source: identity.source,
      source_key: identity.sourceKey,
      display_name: identity.displayName,
      email: identity.email,
      avatar_url: identity.avatarUrl,
      profile_url: identity.profileUrl,
      first_seen_at: options.now,
      last_seen_at: options.now,
    }));

    for (let index = 0; index < rows.length; index += INSERT_BATCH_SIZE) {
      await this.client(IDENTITIES)
        .insert(rows.slice(index, index + INSERT_BATCH_SIZE))
        .onConflict(["source", "source_key"])
        // `first_seen_at` is deliberately absent: it is the one field that must
        // survive being seen again, and merging it would reset every account to
        // "first seen today" on every run.
        .merge(["display_name", "email", "avatar_url", "profile_url", "last_seen_at"]);
    }
  }

  async listIdentities(options?: {
    sources?: readonly IdentitySource[];
  }): Promise<IdentityRecord[]> {
    const query = this.client<IdentityRow>(IDENTITIES);
    if (options?.sources && options.sources.length > 0) {
      query.whereIn("source", [...options.sources]);
    }

    const rows = await query.orderBy("source").orderBy("source_key");
    return rows.map(toIdentityRecord);
  }

  async listIdentityLinks(): Promise<IdentityLinkRecord[]> {
    const rows = await this.client<IdentityLinkRow>(IDENTITY_LINKS);
    return rows.map(toIdentityLink);
  }

  async saveIdentityLink(link: IdentityLinkRecord): Promise<void> {
    await this.client.transaction(async (trx) => {
      const existing = await trx<IdentityLinkRow>(IDENTITY_LINKS)
        .where({ source: link.source, source_key: link.sourceKey })
        .first();

      // A person stating that two accounts are the same human outranks a rule
      // that noticed the addresses matched. Enforced here rather than in every
      // caller, because the failure mode is the reconciliation task silently
      // undoing somebody's correction half an hour after they made it.
      if (existing?.origin === "manual" && link.origin !== "manual") return;

      await trx(IDENTITY_LINKS)
        .insert({
          source: link.source,
          source_key: link.sourceKey,
          entity_ref: link.entityRef,
          origin: link.origin,
          linked_by: link.linkedBy,
          linked_at: link.linkedAt,
        })
        .onConflict(["source", "source_key"])
        .merge(["entity_ref", "origin", "linked_by", "linked_at"]);
    });
  }

  async deleteIdentityLink(identity: IdentityRef): Promise<void> {
    await this.client(IDENTITY_LINKS)
      .where({ source: identity.source, source_key: identity.sourceKey })
      .delete();
  }

  async listIdentityExclusions(): Promise<IdentityExclusionRecord[]> {
    const rows = await this.client<IdentityExclusionRow>(IDENTITY_EXCLUSIONS);
    return rows.map(toIdentityExclusion);
  }

  async saveIdentityExclusion(exclusion: IdentityExclusionRecord): Promise<void> {
    await this.client(IDENTITY_EXCLUSIONS)
      .insert({
        source: exclusion.source,
        source_key: exclusion.sourceKey,
        reason: exclusion.reason,
        excluded_by: exclusion.excludedBy,
        excluded_at: exclusion.excludedAt,
      })
      // Re-excluding an account under a different reason replaces the row
      // rather than failing. There is one answer to "why is this row not
      // measured", and a correction to it is the same statement made again.
      .onConflict(["source", "source_key"])
      .merge(["reason", "excluded_by", "excluded_at"]);
  }

  async deleteIdentityExclusion(identity: IdentityRef): Promise<void> {
    await this.client(IDENTITY_EXCLUSIONS)
      .where({ source: identity.source, source_key: identity.sourceKey })
      .delete();
  }

  async listLatestSnapshots(options: {
    day: Day;
    repositoryIds?: readonly string[];
  }): Promise<RepositorySnapshot[]> {
    const query = this.client<SnapshotRow>(SNAPSHOTS).where("day", "<=", options.day);
    if (options.repositoryIds) {
      query.whereIn("repository_id", [...options.repositoryIds]);
    }

    const rows = await query.orderBy("repository_id").orderBy("day", "desc");

    // One row per repository, the newest at or before the requested day. Doing
    // this in memory rather than with a window function keeps the query
    // portable across SQLite and PostgreSQL; the row count is bounded by the
    // number of tracked repositories times the retention window.
    const latest = new Map<string, SnapshotRow>();
    for (const row of rows) {
      if (!latest.has(row.repository_id)) latest.set(row.repository_id, row);
    }

    return [...latest.values()].map((row) => ({
      repositoryId: row.repository_id,
      day: fromStoredDate(row.day),
      capturedAt: toDate(row.captured_at),
      payload: JSON.parse(row.payload) as RepositorySnapshotPayload,
    }));
  }

  async listSnapshots(options: {
    from: Day;
    to: Day;
    repositoryIds?: readonly string[];
  }): Promise<RepositorySnapshot[]> {
    const query = this.client<SnapshotRow>(SNAPSHOTS)
      .where("day", ">=", options.from)
      .andWhere("day", "<=", options.to);
    if (options.repositoryIds) {
      query.whereIn("repository_id", [...options.repositoryIds]);
    }

    const rows = await query.orderBy("day", "asc").orderBy("repository_id", "asc");

    return rows.map((row) => ({
      repositoryId: row.repository_id,
      day: fromStoredDate(row.day),
      capturedAt: toDate(row.captured_at),
      payload: JSON.parse(row.payload) as RepositorySnapshotPayload,
    }));
  }

  async listEvents(options: {
    from: Date;
    to: Date;
    kinds?: readonly EventKind[];
    repositoryIds?: readonly string[];
  }): Promise<CodeHealthEvent[]> {
    const query = this.client<EventRow>(EVENTS)
      .where("occurred_at", ">=", options.from)
      .andWhere("occurred_at", "<", options.to);

    if (options.kinds) query.whereIn("kind", [...options.kinds]);
    if (options.repositoryIds) query.whereIn("repository_id", [...options.repositoryIds]);

    const rows = await query.orderBy("occurred_at", "asc");
    return rows.map(toEvent);
  }

  async getCoverage(): Promise<CoverageCounts> {
    const [bounds] = await this.client(CHUNKS).select(
      this.client.raw("min(day) as earliest"),
      this.client.raw("max(day) as latest"),
      this.client.raw("max(ingested_at) as last_ingested_at"),
    );

    const states = await this.client<IngestionStateRow>(INGESTION_STATE)
      .innerJoin<RepositoryRow>(REPOSITORIES, `${REPOSITORIES}.id`, `${INGESTION_STATE}.repository_id`)
      .whereNull(`${REPOSITORIES}.removed_at`)
      .select(
        `${INGESTION_STATE}.backfill_floor`,
        `${INGESTION_STATE}.backfill_cursor`,
        `${INGESTION_STATE}.status`,
        `${INGESTION_STATE}.incremental_through`,
      );

    const expectedDays = states.reduce(
      (total, row) =>
        total + Math.max(0, daysBetween(fromStoredDate(row.backfill_floor), toDay(new Date())) + 1),
      0,
    );
    const pendingDays = states.reduce(
      (total, row) =>
        total +
        Math.max(0, daysBetween(fromStoredDate(row.backfill_floor), fromStoredDate(row.backfill_cursor))),
      0,
    );

    const earliest = (bounds as { earliest?: Date | string | null } | undefined)?.earliest;
    const latest = (bounds as { latest?: Date | string | null } | undefined)?.latest;
    const lastIngestedAt = (bounds as { last_ingested_at?: Date | string | null } | undefined)
      ?.last_ingested_at;

    // The *minimum* across repositories, not the maximum: the dashboard can
    // only claim to answer up to the point the least fresh repository reaches.
    const freshUntil = states
      .map((row) => toDate(row.incremental_through).getTime())
      .reduce<number | null>(
        (earliestSoFar, value) =>
          earliestSoFar === null ? value : Math.min(earliestSoFar, value),
        null,
      );

    return {
      freshUntil: freshUntil === null ? null : new Date(freshUntil),
      earliestDay: earliest === null || earliest === undefined ? null : fromStoredDate(earliest),
      latestDay: latest === null || latest === undefined ? null : fromStoredDate(latest),
      lastIngestedAt:
        lastIngestedAt === null || lastIngestedAt === undefined ? null : toDate(lastIngestedAt),
      repositories: states.length,
      complete: states.filter((row) => row.status === "complete").length,
      failing: states.filter((row) => row.status === "error").length,
      ingestedDays: Math.max(0, expectedDays - pendingDays),
      expectedDays,
    };
  }

  async resetIngestion(options: {
    days: number;
    now: Date;
  }): Promise<{ repositories: number }> {
    const today = toDay(options.now);
    const floor = addDays(today, -options.days);
    // The first instant of the floor day, in the calendar the days are kept in.
    const floorInstant = new Date(`${floor}T00:00:00.000Z`);

    return this.client.transaction(async (trx) => {
      const tracked = await trx<RepositoryRow>(REPOSITORIES)
        .whereNull("removed_at")
        .pluck("id");
      if (tracked.length === 0) return { repositories: 0 };

      // Only what the walk re-collects, and only inside the reach. The floor
      // is raised to the reach in this same transaction and the backfill never
      // walks below its floor, so anything older deleted here would never come
      // back — a thirty-day reach would silently throw away the other eleven
      // months. Bounded, the shorter reach re-reads thirty days and leaves the
      // rest exactly as it was, which is what makes it cheaper rather than
      // lossy. Releases and tags come from the daily snapshot, so deleting
      // them would lose history nothing would put back either.
      await trx(EVENTS)
        .whereIn("repository_id", tracked)
        .whereIn("kind", ["commit", "pull_request", "pr_review", "build"])
        .andWhere("occurred_at", ">=", floorInstant)
        .delete();

      // The days inside the reach are forgotten so the walk fetches them
      // again; the days before it stay claimed, because their rows stayed too.
      await trx(CHUNKS)
        .whereIn("repository_id", tracked)
        .andWhere("day", ">=", floor)
        .delete();

      await trx(INGESTION_STATE).whereIn("repository_id", tracked).update({
        // The floor is the administrator's choice rather than the retention
        // setting, because it is the whole point of asking: re-reading a year
        // across two hundred repositories is a day of rate-limited requests,
        // and somebody who wants last quarter re-read after a fix should not
        // have to pay for the other three. The store only ever sets a floor on
        // insert, so the choice sticks until the next reset.
        backfill_floor: floor,
        backfill_cursor: today,
        // A day back, as discovery sets it, so the very first run has a window
        // to fetch and the dashboard can answer for "the last day" immediately.
        incremental_through: addDaysToDate(options.now, -1),
        status: "pending",
        failure_count: 0,
        last_error: null,
      });

      return { repositories: tracked.length };
    });
  }
}
