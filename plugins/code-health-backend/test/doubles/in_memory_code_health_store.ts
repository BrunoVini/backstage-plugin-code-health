import type {
  EventKind,
  IdentitySource,
  IntegrationId,
} from "@rios0rios0/backstage-plugin-code-health-common";
import type { CodeHealthEvent } from "../../src/domain/entities/code_health_event";
import { eventId } from "../../src/domain/entities/code_health_event";
import { addDays, daysBetween, toDay, type Day } from "../../src/domain/entities/day";
import {
  identityKey,
  type IdentityExclusionRecord,
  type IdentityLinkRecord,
  type IdentityRecord,
  type IdentityRef,
} from "../../src/domain/entities/identity";
import type { IngestionState } from "../../src/domain/entities/ingestion_state";
import type { RepositorySnapshot } from "../../src/domain/entities/repository_snapshot";
import type {
  DiscoveredRepository,
  TrackedRepository,
} from "../../src/domain/entities/tracked_repository";
import type {
  CodeHealthStore,
  ContributorMetricRow,
  CoverageCounts,
  RecordChunkRequest,
  TrackedRepositoryWithState,
} from "../../src/domain/repositories/code_health_store";
import type { ObservedIdentity } from "../../src/domain/services/identity_resolver";

const chunkKey = (repositoryId: string, kind: EventKind, day: Day) =>
  `${repositoryId}:${kind}:${day}`;

/** The kinds the history walk produces, and so the ones a reset drops. */
const RE_COLLECTED_KINDS = new Set<EventKind>([
  "commit",
  "pull_request",
  "pr_review",
  "build",
]);

/**
 * In-memory implementation of the persistence port.
 *
 * It mirrors the real store's observable behaviour — idempotent event writes,
 * cursors that only move on success, soft deletes — so commands can be tested
 * without a database. The SQL itself is covered separately, against a real
 * engine, because only the real engine can prove the schema.
 */
export class InMemoryCodeHealthStore implements CodeHealthStore {
  private repositories = new Map<string, TrackedRepository>();
  private states = new Map<string, IngestionState>();
  private events = new Map<string, CodeHealthEvent>();
  private chunks = new Map<string, Date>();
  private snapshots = new Map<string, RepositorySnapshot>();
  private contributorMeasures = new Map<
    string,
    { source: IntegrationId; day: Day; contributorKey: string; payload: unknown }
  >();
  private identities = new Map<string, IdentityRecord>();
  private identityLinks = new Map<string, IdentityLinkRecord>();
  private identityExclusions = new Map<string, IdentityExclusionRecord>();

  /** Number of `commitIngestion` calls, so tests can assert on write volume. */
  commitCount = 0;
  /** Errors passed to `recordIngestionFailure`, newest last. */
  readonly failures: Array<{ repositoryId: string; error: string }> = [];

  async syncRepositories(options: {
    discovered: readonly DiscoveredRepository[];
    retentionDays: number;
    now: Date;
  }): Promise<{ inserted: string[]; updated: string[]; removed: string[] }> {
    const today = toDay(options.now);
    const floor = addDays(today, -options.retentionDays);
    const discoveredIds = new Set(options.discovered.map((item) => item.id));

    const inserted: string[] = [];
    const updated: string[] = [];

    for (const repository of options.discovered) {
      const existing = this.repositories.get(repository.id);
      if (existing) {
        this.repositories.set(repository.id, {
          ...existing,
          ...repository,
          defaultBranch: existing.defaultBranch,
          externalId: existing.externalId,
          lastSeenAt: options.now,
          removedAt: null,
        });
        updated.push(repository.id);
      } else {
        this.repositories.set(repository.id, {
          ...repository,
          discoveredAt: options.now,
          lastSeenAt: options.now,
          removedAt: null,
        });
        this.states.set(repository.id, {
          repositoryId: repository.id,
          backfillFloor: floor,
          backfillCursor: today,
          incrementalThrough: new Date(options.now.getTime() - 24 * 60 * 60 * 1000),
          status: "pending",
          failureCount: 0,
          lastError: null,
          lastAttemptAt: null,
        });
        inserted.push(repository.id);
      }
    }

    const removed: string[] = [];
    for (const [id, repository] of this.repositories) {
      if (discoveredIds.has(id) || repository.removedAt !== null) continue;
      this.repositories.set(id, { ...repository, removedAt: options.now });
      removed.push(id);
    }

    return { inserted, updated, removed };
  }

  async updateRepositoryFacts(options: {
    repositoryId: string;
    defaultBranch?: string | null;
    externalId?: string | null;
    archived?: boolean;
  }): Promise<void> {
    const existing = this.repositories.get(options.repositoryId);
    if (!existing) return;
    this.repositories.set(options.repositoryId, {
      ...existing,
      defaultBranch:
        options.defaultBranch === undefined ? existing.defaultBranch : options.defaultBranch,
      externalId: options.externalId === undefined ? existing.externalId : options.externalId,
      archived: options.archived === undefined ? existing.archived : options.archived,
    });
  }

  async listTrackedRepositories(): Promise<TrackedRepositoryWithState[]> {
    return [...this.repositories.values()]
      .filter((repository) => repository.removedAt === null)
      .map((repository) => ({
        repository,
        state: this.states.get(repository.id)!,
      }));
  }

  async getTrackedRepository(id: string): Promise<TrackedRepositoryWithState | undefined> {
    const repository = this.repositories.get(id);
    const state = this.states.get(id);
    if (!repository || !state) return undefined;
    return { repository, state };
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
    this.commitCount += 1;

    for (const event of options.events) {
      this.events.set(eventId(event), event);
    }

    for (const kind of options.chunk.kinds) {
      for (const day of options.chunk.days) {
        this.chunks.set(
          chunkKey(options.chunk.repositoryId, kind, day),
          options.chunk.ingestedAt,
        );
      }
    }

    const state = this.states.get(options.repositoryId);
    if (!state) return;

    this.states.set(options.repositoryId, {
      ...state,
      incrementalThrough: options.incrementalThrough ?? state.incrementalThrough,
      backfillCursor: options.backfillCursor ?? state.backfillCursor,
      status: options.status,
      failureCount: 0,
      lastError: null,
      lastAttemptAt: options.now,
    });
  }

  async recordIngestionFailure(options: {
    repositoryId: string;
    error: string;
    now: Date;
  }): Promise<void> {
    this.failures.push({ repositoryId: options.repositoryId, error: options.error });

    const state = this.states.get(options.repositoryId);
    if (!state) return;

    this.states.set(options.repositoryId, {
      ...state,
      status: "error",
      failureCount: state.failureCount + 1,
      lastError: options.error,
      lastAttemptAt: options.now,
    });
  }

  async saveSnapshot(snapshot: RepositorySnapshot): Promise<void> {
    this.snapshots.set(`${snapshot.repositoryId}:${snapshot.day}`, snapshot);
  }

  async saveContributorMetrics<T>(options: {
    source: IntegrationId;
    day: Day;
    capturedAt: Date;
    metrics: ReadonlyMap<string, T>;
  }): Promise<void> {
    for (const [contributorKey, payload] of options.metrics) {
      this.contributorMeasures.set(`${options.source}:${options.day}:${contributorKey}`, {
        source: options.source,
        day: options.day,
        contributorKey,
        payload,
      });
    }
  }

  async listContributorMetrics<T>(options: {
    source: IntegrationId;
    from: Day;
    to: Day;
  }): Promise<ContributorMetricRow<T>[]> {
    return [...this.contributorMeasures.values()]
      .filter(
        (row) =>
          row.source === options.source && row.day >= options.from && row.day <= options.to,
      )
      .sort((left, right) => left.day.localeCompare(right.day))
      .map((row) => ({
        day: row.day,
        contributorKey: row.contributorKey,
        payload: row.payload as T,
      }));
  }

  async listLatestContributorMetrics<T>(options: {
    source: IntegrationId;
    day: Day;
  }): Promise<Map<string, T>> {
    const latest = new Map<string, T>();
    for (const row of [...this.contributorMeasures.values()]
      .filter((candidate) => candidate.source === options.source && candidate.day <= options.day)
      .sort((left, right) => left.day.localeCompare(right.day))) {
      latest.set(row.contributorKey, row.payload as T);
    }
    return latest;
  }

  async listContributorMetricDays(options: {
    source: IntegrationId;
    from: Day;
    to: Day;
  }): Promise<Day[]> {
    const days = new Set(
      [...this.contributorMeasures.values()]
        .filter(
          (row) =>
            row.source === options.source && row.day >= options.from && row.day <= options.to,
        )
        .map((row) => row.day),
    );
    return [...days].sort();
  }

  async recordObservedIdentities(options: {
    identities: readonly ObservedIdentity[];
    now: Date;
  }): Promise<void> {
    for (const identity of options.identities) {
      const key = identityKey(identity);
      const existing = this.identities.get(key);
      this.identities.set(key, {
        ...identity,
        // Mirrors the real store's merge: everything refreshes except the first
        // sighting, which is the one field that has to survive being seen again.
        firstSeenAt: existing?.firstSeenAt ?? options.now,
        lastSeenAt: options.now,
      });
    }
  }

  async listIdentities(options?: {
    sources?: readonly IdentitySource[];
  }): Promise<IdentityRecord[]> {
    const wanted = options?.sources === undefined ? null : new Set(options.sources);
    return [...this.identities.values()]
      .filter((identity) => wanted === null || wanted.has(identity.source))
      .sort(
        (left, right) =>
          left.source.localeCompare(right.source) ||
          left.sourceKey.localeCompare(right.sourceKey),
      );
  }

  async listIdentityLinks(): Promise<IdentityLinkRecord[]> {
    return [...this.identityLinks.values()];
  }

  async saveIdentityLink(link: IdentityLinkRecord): Promise<void> {
    const existing = this.identityLinks.get(identityKey(link));
    if (existing?.origin === "manual" && link.origin !== "manual") return;
    this.identityLinks.set(identityKey(link), link);
  }

  async deleteIdentityLink(identity: IdentityRef): Promise<void> {
    this.identityLinks.delete(identityKey(identity));
  }

  async listIdentityExclusions(): Promise<IdentityExclusionRecord[]> {
    return [...this.identityExclusions.values()];
  }

  async saveIdentityExclusion(exclusion: IdentityExclusionRecord): Promise<void> {
    // Replaces whatever was there, mirroring the real store: there is one
    // answer to "why is this row not measured", and re-excluding under a
    // different reason is a correction to it rather than a second exclusion.
    this.identityExclusions.set(identityKey(exclusion), exclusion);
  }

  async deleteIdentityExclusion(identity: IdentityRef): Promise<void> {
    this.identityExclusions.delete(identityKey(identity));
  }

  async listLatestSnapshotDays(): Promise<ReadonlyMap<string, Day>> {
    const latest = new Map<string, Day>();
    for (const snapshot of this.snapshots.values()) {
      const known = latest.get(snapshot.repositoryId);
      if (known === undefined || snapshot.day > known) {
        latest.set(snapshot.repositoryId, snapshot.day);
      }
    }
    return latest;
  }

  async listLatestSnapshots(options: {
    day: Day;
    repositoryIds?: readonly string[];
  }): Promise<RepositorySnapshot[]> {
    const allowed = options.repositoryIds ? new Set(options.repositoryIds) : null;
    const latest = new Map<string, RepositorySnapshot>();

    for (const snapshot of [...this.snapshots.values()].sort((a, b) =>
      a.day.localeCompare(b.day),
    )) {
      if (snapshot.day > options.day) continue;
      if (allowed && !allowed.has(snapshot.repositoryId)) continue;
      latest.set(snapshot.repositoryId, snapshot);
    }

    return [...latest.values()];
  }

  async listSnapshots(options: {
    from: Day;
    to: Day;
    repositoryIds?: readonly string[];
  }): Promise<RepositorySnapshot[]> {
    const allowed = options.repositoryIds ? new Set(options.repositoryIds) : null;

    return [...this.snapshots.values()]
      .filter((snapshot) => snapshot.day >= options.from && snapshot.day <= options.to)
      .filter((snapshot) => (allowed ? allowed.has(snapshot.repositoryId) : true))
      .sort(
        (left, right) =>
          left.day.localeCompare(right.day) ||
          left.repositoryId.localeCompare(right.repositoryId),
      );
  }

  async listEvents(options: {
    from: Date;
    to: Date;
    kinds?: readonly EventKind[];
    repositoryIds?: readonly string[];
  }): Promise<CodeHealthEvent[]> {
    const kinds = options.kinds ? new Set(options.kinds) : null;
    const repositoryIds = options.repositoryIds ? new Set(options.repositoryIds) : null;

    return [...this.events.values()]
      .filter((event) => event.occurredAt >= options.from && event.occurredAt < options.to)
      .filter((event) => (kinds ? kinds.has(event.kind) : true))
      .filter((event) => (repositoryIds ? repositoryIds.has(event.repositoryId) : true))
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  }

  async getCoverage(): Promise<CoverageCounts> {
    const days = [...this.chunks.keys()].map((key) => key.split(":")[2]).sort();
    const states = [...this.states.entries()]
      .filter(([id]) => this.repositories.get(id)?.removedAt === null)
      .map(([, state]) => state);

    const today = toDay(new Date());
    const expectedDays = states.reduce(
      (total, state) => total + Math.max(0, daysBetween(state.backfillFloor, today) + 1),
      0,
    );
    const pendingDays = states.reduce(
      (total, state) =>
        total + Math.max(0, daysBetween(state.backfillFloor, state.backfillCursor)),
      0,
    );

    const freshUntil = states
      .map((state) => state.incrementalThrough.getTime())
      .reduce<number | null>(
        (earliestSoFar, value) =>
          earliestSoFar === null ? value : Math.min(earliestSoFar, value),
        null,
      );

    return {
      freshUntil: freshUntil === null ? null : new Date(freshUntil),
      earliestDay: days.at(0) ?? null,
      latestDay: days.at(-1) ?? null,
      lastIngestedAt: [...this.chunks.values()].sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
      repositories: states.length,
      complete: states.filter((state) => state.status === "complete").length,
      failing: states.filter((state) => state.status === "error").length,
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
    const floorInstant = new Date(`${floor}T00:00:00.000Z`);
    const tracked = [...this.repositories.values()].filter(
      (repository) => repository.removedAt === null,
    );

    for (const repository of tracked) {
      for (const [key, event] of this.events) {
        if (event.repositoryId !== repository.id) continue;
        // Only what the walk re-collects, and only inside the reach, exactly as
        // in the real store: releases and tags come from the daily snapshot,
        // and the walk never goes below the floor it is about to be given, so
        // anything older would never come back.
        if (!RE_COLLECTED_KINDS.has(event.kind)) continue;
        if (event.occurredAt.getTime() < floorInstant.getTime()) continue;
        this.events.delete(key);
      }

      for (const key of this.chunks.keys()) {
        if (!key.startsWith(`${repository.id}:`)) continue;
        // The key is `${repositoryId}:${kind}:${day}`, and a day is the last part.
        const day = key.slice(key.lastIndexOf(":") + 1);
        if (day >= floor) this.chunks.delete(key);
      }

      const state = this.states.get(repository.id);
      if (!state) continue;
      this.states.set(repository.id, {
        ...state,
        backfillFloor: floor,
        backfillCursor: today,
        incrementalThrough: new Date(options.now.getTime() - 24 * 60 * 60 * 1000),
        status: "pending",
        failureCount: 0,
        lastError: null,
      });
    }

    return { repositories: tracked.length };
  }
}
