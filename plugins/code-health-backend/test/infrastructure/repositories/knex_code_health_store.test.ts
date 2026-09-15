import { mockServices, TestDatabases } from "@backstage/backend-test-utils";
import type { CodeHealthEvent } from "../../../src/domain/entities/code_health_event";
import type { Day } from "../../../src/domain/entities/day";
import type { RepositorySnapshotPayload } from "../../../src/domain/entities/repository_snapshot";
import type { ObservedIdentity } from "../../../src/domain/services/identity_resolver";
import { KnexCodeHealthStore } from "../../../src/infrastructure/repositories/knex_code_health_store";
import { DiscoveredRepositoryBuilder } from "../../builders/discovered_repository_builder";

/**
 * These run against a real database with the real migrations applied. That is
 * the only way the schema itself gets tested: a hand-rolled double would happily
 * accept a column the migration never created, and the first real deployment
 * would be where that surfaced.
 */
const databases = TestDatabases.create({ ids: ["SQLITE_3"], disableDocker: true });

const NOW = new Date("2026-08-10T12:00:00.000Z");

const createStore = async () => {
  const knex = await databases.init("SQLITE_3");
  const store = await KnexCodeHealthStore.create({ database: mockServices.database({ knex }) });
  return Object.assign(store, { knex });
};

const aSnapshotPayload = (
  overrides: Partial<RepositorySnapshotPayload> = {},
): RepositorySnapshotPayload => ({
  description: null,
  primaryLanguage: "Go",
  visibility: "PUBLIC",
  isArchived: false,
  isFork: false,
  defaultBranch: "main",
  updatedAt: NOW.toISOString(),
  ciStatus: null,
  latestRelease: null,
  latestTag: null,
  branches: ["main"],
  complianceStatus: null,
  badgeStatus: null,
  sonarMetrics: null,
  jiraMetrics: null,
  confluenceMetrics: null,
  repositoryFiles: null,
  ...overrides,
});

const anEvent = (overrides: Partial<CodeHealthEvent> = {}): CodeHealthEvent => ({
  repositoryId: "unset",
  kind: "commit",
  externalId: "sha-1",
  occurredAt: new Date("2026-08-10T09:00:00.000Z"),
  actorKey: "dev@example.com",
  actorName: "Dev Example",
  actorAvatarUrl: null,
  outcome: null,
  additions: 10,
  deletions: 2,
  changedFiles: 3,
  payload: { messageHeadline: "did the thing" },
  ...overrides,
});

describe("KnexCodeHealthStore", () => {
  describe("syncRepositories", () => {
    it("should insert a repository with a cursor spanning the retention window", async () => {
      // given
      const store = await createStore();
      const repository = DiscoveredRepositoryBuilder.create().build();

      // when
      const result = await store.syncRepositories({
        discovered: [repository],
        retentionDays: 365,
        now: NOW,
      });

      // then
      expect(result.inserted).toEqual([repository.id]);
      const [tracked] = await store.listTrackedRepositories();
      expect(tracked.state.backfillCursor).toBe("2026-08-10");
      expect(tracked.state.backfillFloor).toBe("2025-08-10");
      expect(tracked.state.status).toBe("pending");
    });

    it("should round-trip the catalog facts the metrics read", async () => {
      // given
      const store = await createStore();
      const repository = DiscoveredRepositoryBuilder.create()
        .withCatalogFacts({
          entityKind: "Component",
          entityType: "service",
          ownerRef: "group:default/platform",
          techDocsRef: "dir:.",
          providesApis: 2,
          hasExternalDocs: true,
        })
        .build();

      // when
      await store.syncRepositories({
        discovered: [repository],
        retentionDays: 365,
        now: NOW,
      });

      // then
      const [tracked] = await store.listTrackedRepositories();
      expect(tracked.repository.catalogFacts).toEqual({
        entityKind: "Component",
        entityType: "service",
        ownerRef: "group:default/platform",
        techDocsRef: "dir:.",
        providesApis: 2,
        hasExternalDocs: true,
        jiraProjectKey: null,
        jiraComponent: null,
        confluenceSpaceKey: null,
        wakaTimeProject: null,
      });
    });

    it("should refresh the owner when the entity is handed to another team", async () => {
      // given
      // Ownership moves, and it moves in a YAML file rather than in the
      // provider — so a rediscovery has to pick the edit up rather than keep
      // reporting the team that used to be responsible.
      const store = await createStore();
      const before = DiscoveredRepositoryBuilder.create()
        .withOwner("group:default/platform")
        .build();
      await store.syncRepositories({ discovered: [before], retentionDays: 365, now: NOW });

      // when
      await store.syncRepositories({
        discovered: [
          DiscoveredRepositoryBuilder.create()
            .withEntityRef(before.entityRef)
            .withOwner("group:default/payments")
            .build(),
        ],
        retentionDays: 365,
        now: NOW,
      });

      // then
      const [tracked] = await store.listTrackedRepositories();
      expect(tracked.repository.catalogFacts.ownerRef).toBe("group:default/payments");
    });

    it("should store no owner for an entity that declares none", async () => {
      // given
      // Null rather than an empty string, because "nobody is named" is a real
      // answer the ownership screen has to be able to give.
      const store = await createStore();
      const repository = DiscoveredRepositoryBuilder.create().build();

      // when
      await store.syncRepositories({
        discovered: [repository],
        retentionDays: 365,
        now: NOW,
      });

      // then
      const [tracked] = await store.listTrackedRepositories();
      expect(tracked.repository.catalogFacts.ownerRef).toBeNull();
    });

    it("should refresh the catalog facts when the entity changes", async () => {
      // given
      // These come from a YAML file somebody edits, so a rediscovery has to
      // pick the edit up rather than keep the value it first saw.
      const store = await createStore();
      const before = DiscoveredRepositoryBuilder.create().build();
      await store.syncRepositories({
        discovered: [before],
        retentionDays: 365,
        now: NOW,
      });

      // when
      await store.syncRepositories({
        discovered: [
          DiscoveredRepositoryBuilder.create()
            .withEntityRef(before.entityRef)
            .withCatalogFacts({ techDocsRef: "dir:.", providesApis: 1 })
            .build(),
        ],
        retentionDays: 365,
        now: NOW,
      });

      // then
      const [tracked] = await store.listTrackedRepositories();
      expect(tracked.repository.catalogFacts).toMatchObject({
        techDocsRef: "dir:.",
        providesApis: 1,
      });
    });

    it("should start the incremental cursor a day back so the first run has a window", async () => {
      // given
      const store = await createStore();

      // when
      await store.syncRepositories({
        discovered: [DiscoveredRepositoryBuilder.create().build()],
        retentionDays: 365,
        now: NOW,
      });

      // then
      // Without this the first tick would have nothing to fetch and the
      // dashboard would stay empty until the following one.
      const [tracked] = await store.listTrackedRepositories();
      expect(tracked.state.incrementalThrough).toEqual(new Date("2026-08-09T12:00:00.000Z"));
    });

    it("should refresh an existing repository instead of resetting its cursor", async () => {
      // given
      const store = await createStore();
      const repository = DiscoveredRepositoryBuilder.create().build();
      await store.syncRepositories({ discovered: [repository], retentionDays: 365, now: NOW });
      await store.commitIngestion({
        repositoryId: repository.id,
        events: [],
        chunk: { repositoryId: repository.id, kinds: ["commit"], days: ["2026-08-09"], ingestedAt: NOW },
        backfillCursor: "2026-08-09",
        status: "active",
        now: NOW,
      });

      // when
      const later = new Date("2026-08-11T12:00:00.000Z");
      const result = await store.syncRepositories({
        discovered: [{ ...repository, name: "renamed" }],
        retentionDays: 365,
        now: later,
      });

      // then
      expect(result.inserted).toEqual([]);
      expect(result.updated).toEqual([repository.id]);
      const [tracked] = await store.listTrackedRepositories();
      expect(tracked.repository.name).toBe("renamed");
      expect(tracked.state.backfillCursor).toBe("2026-08-09");
    });

    it("should keep facts learnt from the provider when the catalog reports none", async () => {
      // given
      // The catalog never knows the default branch or the provider-side id, so
      // every rediscovery carries nulls for them. Letting those through would
      // erase what ingestion found out on the previous run.
      const store = await createStore();
      const repository = DiscoveredRepositoryBuilder.create().build();
      await store.syncRepositories({ discovered: [repository], retentionDays: 365, now: NOW });
      await store.updateRepositoryFacts({
        repositoryId: repository.id,
        defaultBranch: "main",
        externalId: "a3f1-guid",
      });

      // when
      await store.syncRepositories({
        discovered: [repository],
        retentionDays: 365,
        now: new Date("2026-08-11T12:00:00.000Z"),
      });

      // then
      const [tracked] = await store.listTrackedRepositories();
      expect(tracked.repository.defaultBranch).toBe("main");
      expect(tracked.repository.externalId).toBe("a3f1-guid");
    });

    it("should soft delete a repository that left the catalog", async () => {
      // given
      const store = await createStore();
      const kept = DiscoveredRepositoryBuilder.create().withEntityRef("component:default/kept").build();
      const dropped = DiscoveredRepositoryBuilder.create()
        .withEntityRef("component:default/dropped")
        .build();
      await store.syncRepositories({ discovered: [kept, dropped], retentionDays: 365, now: NOW });

      // when
      const result = await store.syncRepositories({
        discovered: [kept],
        retentionDays: 365,
        now: NOW,
      });

      // then
      expect(result.removed).toEqual([dropped.id]);
      const tracked = await store.listTrackedRepositories();
      expect(tracked.map((item) => item.repository.id)).toEqual([kept.id]);
    });

    it("should not report the same removal twice", async () => {
      // given
      const store = await createStore();
      const dropped = DiscoveredRepositoryBuilder.create().build();
      await store.syncRepositories({ discovered: [dropped], retentionDays: 365, now: NOW });
      await store.syncRepositories({ discovered: [], retentionDays: 365, now: NOW });

      // when
      const result = await store.syncRepositories({ discovered: [], retentionDays: 365, now: NOW });

      // then
      expect(result.removed).toEqual([]);
    });
  });

  describe("commitIngestion", () => {
    it("should store events, record the days covered and advance the cursor together", async () => {
      // given
      const store = await createStore();
      const repository = DiscoveredRepositoryBuilder.create().build();
      await store.syncRepositories({ discovered: [repository], retentionDays: 365, now: NOW });

      // when
      await store.commitIngestion({
        repositoryId: repository.id,
        events: [anEvent({ repositoryId: repository.id })],
        chunk: {
          repositoryId: repository.id,
          kinds: ["commit"],
          days: ["2026-08-10"],
          ingestedAt: NOW,
        },
        incrementalThrough: NOW,
        status: "active",
        now: NOW,
      });

      // then
      const events = await store.listEvents({
        from: new Date("2026-08-10T00:00:00.000Z"),
        to: new Date("2026-08-11T00:00:00.000Z"),
      });
      expect(events).toHaveLength(1);
      expect(events[0].payload).toEqual({ messageHeadline: "did the thing" });
      const [tracked] = await store.listTrackedRepositories();
      expect(tracked.state.incrementalThrough).toEqual(NOW);
      expect(tracked.state.status).toBe("active");
    });

    it("should record a day that produced no events at all", async () => {
      // given
      // "no data" and "not fetched yet" have to be distinguishable, or the
      // dashboard cannot tell a user which range it is able to answer for.
      const store = await createStore();
      const repository = DiscoveredRepositoryBuilder.create().build();
      await store.syncRepositories({ discovered: [repository], retentionDays: 365, now: NOW });

      // when
      await store.commitIngestion({
        repositoryId: repository.id,
        events: [],
        chunk: {
          repositoryId: repository.id,
          kinds: ["commit", "build"],
          days: ["2026-08-09"],
          ingestedAt: NOW,
        },
        backfillCursor: "2026-08-09",
        status: "active",
        now: NOW,
      });

      // then
      const coverage = await store.getCoverage();
      expect(coverage.earliestDay).toBe("2026-08-09");
      expect(coverage.latestDay).toBe("2026-08-09");
    });

    it("should be idempotent when the same window is ingested twice", async () => {
      // given
      const store = await createStore();
      const repository = DiscoveredRepositoryBuilder.create().build();
      await store.syncRepositories({ discovered: [repository], retentionDays: 365, now: NOW });
      const chunk = {
        repositoryId: repository.id,
        kinds: ["commit"] as const,
        days: ["2026-08-10"],
        ingestedAt: NOW,
      };
      const events = [anEvent({ repositoryId: repository.id })];

      // when
      await store.commitIngestion({
        repositoryId: repository.id,
        events,
        chunk,
        status: "active",
        now: NOW,
      });
      await store.commitIngestion({
        repositoryId: repository.id,
        events,
        chunk,
        status: "active",
        now: NOW,
      });

      // then
      // A retry after a partial failure re-fetches a window that may already be
      // stored; that has to update rows in place rather than double count.
      const stored = await store.listEvents({
        from: new Date("2026-08-10T00:00:00.000Z"),
        to: new Date("2026-08-11T00:00:00.000Z"),
      });
      expect(stored).toHaveLength(1);
    });

    it("should clear a previous failure when a later run succeeds", async () => {
      // given
      const store = await createStore();
      const repository = DiscoveredRepositoryBuilder.create().build();
      await store.syncRepositories({ discovered: [repository], retentionDays: 365, now: NOW });
      await store.recordIngestionFailure({
        repositoryId: repository.id,
        error: "429 from the provider",
        now: NOW,
      });

      // when
      await store.commitIngestion({
        repositoryId: repository.id,
        events: [],
        chunk: {
          repositoryId: repository.id,
          kinds: ["commit"],
          days: ["2026-08-10"],
          ingestedAt: NOW,
        },
        status: "active",
        now: NOW,
      });

      // then
      const [tracked] = await store.listTrackedRepositories();
      expect(tracked.state.failureCount).toBe(0);
      expect(tracked.state.lastError).toBeNull();
    });
  });

  describe("recordIngestionFailure", () => {
    it("should accumulate the failure count across attempts", async () => {
      // given
      const store = await createStore();
      const repository = DiscoveredRepositoryBuilder.create().build();
      await store.syncRepositories({ discovered: [repository], retentionDays: 365, now: NOW });

      // when
      await store.recordIngestionFailure({ repositoryId: repository.id, error: "one", now: NOW });
      await store.recordIngestionFailure({ repositoryId: repository.id, error: "two", now: NOW });

      // then
      const [tracked] = await store.listTrackedRepositories();
      expect(tracked.state.failureCount).toBe(2);
      expect(tracked.state.lastError).toBe("two");
      expect(tracked.state.status).toBe("error");
    });

    it("should truncate an error too long for the column", async () => {
      // given
      const store = await createStore();
      const repository = DiscoveredRepositoryBuilder.create().build();
      await store.syncRepositories({ discovered: [repository], retentionDays: 365, now: NOW });

      // when
      await store.recordIngestionFailure({
        repositoryId: repository.id,
        error: "x".repeat(5000),
        now: NOW,
      });

      // then
      const [tracked] = await store.listTrackedRepositories();
      expect(tracked.state.lastError).toHaveLength(2000);
    });
  });

  describe("listEvents", () => {
    it("should exclude events at the exclusive end of the window", async () => {
      // given
      const store = await createStore();
      const repository = DiscoveredRepositoryBuilder.create().build();
      await store.syncRepositories({ discovered: [repository], retentionDays: 365, now: NOW });
      await store.commitIngestion({
        repositoryId: repository.id,
        events: [
          anEvent({
            repositoryId: repository.id,
            externalId: "inside",
            occurredAt: new Date("2026-08-10T23:59:59.000Z"),
          }),
          anEvent({
            repositoryId: repository.id,
            externalId: "outside",
            occurredAt: new Date("2026-08-11T00:00:00.000Z"),
          }),
        ],
        chunk: {
          repositoryId: repository.id,
          kinds: ["commit"],
          days: ["2026-08-10"],
          ingestedAt: NOW,
        },
        status: "active",
        now: NOW,
      });

      // when
      const events = await store.listEvents({
        from: new Date("2026-08-10T00:00:00.000Z"),
        to: new Date("2026-08-11T00:00:00.000Z"),
      });

      // then
      // Half-open windows are what let consecutive days be requested without
      // counting the boundary event twice.
      expect(events.map((event) => event.externalId)).toEqual(["inside"]);
    });

    it("should filter by kind and by repository", async () => {
      // given
      const store = await createStore();
      const first = DiscoveredRepositoryBuilder.create().withEntityRef("component:default/a").build();
      const second = DiscoveredRepositoryBuilder.create()
        .withEntityRef("component:default/b")
        .build();
      await store.syncRepositories({ discovered: [first, second], retentionDays: 365, now: NOW });
      for (const repository of [first, second]) {
        await store.commitIngestion({
          repositoryId: repository.id,
          events: [
            anEvent({ repositoryId: repository.id, kind: "commit", externalId: "c1" }),
            anEvent({ repositoryId: repository.id, kind: "build", externalId: "b1" }),
          ],
          chunk: {
            repositoryId: repository.id,
            kinds: ["commit", "build"],
            days: ["2026-08-10"],
            ingestedAt: NOW,
          },
          status: "active",
          now: NOW,
        });
      }

      // when
      const events = await store.listEvents({
        from: new Date("2026-08-10T00:00:00.000Z"),
        to: new Date("2026-08-11T00:00:00.000Z"),
        kinds: ["build"],
        repositoryIds: [first.id],
      });

      // then
      expect(events).toHaveLength(1);
      expect(events[0].repositoryId).toBe(first.id);
      expect(events[0].kind).toBe("build");
    });
  });

  describe("listLatestSnapshots", () => {
    it("should return the newest snapshot at or before the requested day", async () => {
      // given
      const store = await createStore();
      const repository = DiscoveredRepositoryBuilder.create().build();
      await store.syncRepositories({ discovered: [repository], retentionDays: 365, now: NOW });
      const payload = {
        description: null,
        primaryLanguage: "Go",
        visibility: "PUBLIC" as const,
        isArchived: false,
        isFork: false,
        defaultBranch: "main",
        updatedAt: NOW.toISOString(),
        ciStatus: null,
        latestRelease: null,
        latestTag: null,
        branches: ["main"],
        complianceStatus: null,
        badgeStatus: null,
        sonarMetrics: null,
        jiraMetrics: null,
        confluenceMetrics: null,
        repositoryFiles: null,
      };
      for (const day of ["2026-08-08", "2026-08-09", "2026-08-11"]) {
        await store.saveSnapshot({
          repositoryId: repository.id,
          day,
          capturedAt: NOW,
          payload: { ...payload, primaryLanguage: day },
        });
      }

      // when
      const snapshots = await store.listLatestSnapshots({ day: "2026-08-10" });

      // then
      // Asking for a past window must render the repository as it was then, not
      // as it is now, so a later snapshot has to be ignored.
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].payload.primaryLanguage).toBe("2026-08-09");
    });

    it("should restrict the result to the requested repositories", async () => {
      // given
      const store = await createStore();
      const first = DiscoveredRepositoryBuilder.create()
        .withEntityRef("component:default/first")
        .build();
      const second = DiscoveredRepositoryBuilder.create()
        .withEntityRef("component:default/second")
        .build();
      await store.syncRepositories({ discovered: [first, second], retentionDays: 365, now: NOW });
      const payload = {
        description: null,
        primaryLanguage: "Go",
        visibility: "PUBLIC" as const,
        isArchived: false,
        isFork: false,
        defaultBranch: "main",
        updatedAt: NOW.toISOString(),
        ciStatus: null,
        latestRelease: null,
        latestTag: null,
        branches: [],
        complianceStatus: null,
        badgeStatus: null,
        sonarMetrics: null,
        jiraMetrics: null,
        confluenceMetrics: null,
        repositoryFiles: null,
      };
      for (const repository of [first, second]) {
        await store.saveSnapshot({
          repositoryId: repository.id,
          day: "2026-08-10",
          capturedAt: NOW,
          payload,
        });
      }

      // when
      const snapshots = await store.listLatestSnapshots({
        day: "2026-08-10",
        repositoryIds: [second.id],
      });

      // then
      expect(snapshots.map((snapshot) => snapshot.repositoryId)).toEqual([second.id]);
    });

    it("should overwrite a snapshot captured twice on the same day", async () => {
      // given
      const store = await createStore();
      const repository = DiscoveredRepositoryBuilder.create().build();
      await store.syncRepositories({ discovered: [repository], retentionDays: 365, now: NOW });
      const payload = {
        description: null,
        primaryLanguage: "Go",
        visibility: "PUBLIC" as const,
        isArchived: false,
        isFork: false,
        defaultBranch: "main",
        updatedAt: NOW.toISOString(),
        ciStatus: null,
        latestRelease: null,
        latestTag: null,
        branches: [],
        complianceStatus: null,
        badgeStatus: null,
        sonarMetrics: null,
        jiraMetrics: null,
        confluenceMetrics: null,
        repositoryFiles: null,
      };

      // when
      await store.saveSnapshot({
        repositoryId: repository.id,
        day: "2026-08-10",
        capturedAt: NOW,
        payload,
      });
      await store.saveSnapshot({
        repositoryId: repository.id,
        day: "2026-08-10",
        capturedAt: NOW,
        payload: { ...payload, primaryLanguage: "Rust" },
      });

      // then
      const snapshots = await store.listLatestSnapshots({ day: "2026-08-10" });
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].payload.primaryLanguage).toBe("Rust");
    });
  });

  describe("listSnapshots", () => {
    it("should return every snapshot in the range, ascending by day", async () => {
      // given
      // The trend routes read the state a repository was in at the end of each
      // bucket. One range read answers every bucket; asking `listLatestSnapshots`
      // per bucket would be one query per point on the chart.
      const store = await createStore();
      const repository = DiscoveredRepositoryBuilder.create().build();
      await store.syncRepositories({ discovered: [repository], retentionDays: 365, now: NOW });
      for (const day of ["2026-08-11", "2026-08-08", "2026-08-09"]) {
        await store.saveSnapshot({
          repositoryId: repository.id,
          day,
          capturedAt: NOW,
          payload: aSnapshotPayload({ primaryLanguage: day }),
        });
      }

      // when
      const snapshots = await store.listSnapshots({ from: "2026-08-08", to: "2026-08-10" });

      // then
      expect(snapshots.map((snapshot) => snapshot.day)).toEqual([
        "2026-08-08",
        "2026-08-09",
      ]);
      expect(snapshots[0].payload.primaryLanguage).toBe("2026-08-08");
    });

    it("should restrict the result to the requested repositories", async () => {
      // given
      const store = await createStore();
      const first = DiscoveredRepositoryBuilder.create()
        .withEntityRef("component:default/ranged-first")
        .build();
      const second = DiscoveredRepositoryBuilder.create()
        .withEntityRef("component:default/ranged-second")
        .build();
      await store.syncRepositories({
        discovered: [first, second],
        retentionDays: 365,
        now: NOW,
      });
      for (const repository of [first, second]) {
        await store.saveSnapshot({
          repositoryId: repository.id,
          day: "2026-08-09",
          capturedAt: NOW,
          payload: aSnapshotPayload(),
        });
      }

      // when
      const snapshots = await store.listSnapshots({
        from: "2026-08-08",
        to: "2026-08-10",
        repositoryIds: [second.id],
      });

      // then
      expect(snapshots.map((snapshot) => snapshot.repositoryId)).toEqual([second.id]);
    });
  });

  describe("resetIngestion", () => {
    const seedRepositoryWithHistory = async (
      store: Awaited<ReturnType<typeof createStore>>,
      entityRef: string,
    ) => {
      const repository = DiscoveredRepositoryBuilder.create()
        .withEntityRef(entityRef)
        .build();
      await store.syncRepositories({ discovered: [repository], retentionDays: 365, now: NOW });
      await store.commitIngestion({
        repositoryId: repository.id,
        events: [
          anEvent({ repositoryId: repository.id, externalId: `${entityRef}-commit` }),
          anEvent({
            repositoryId: repository.id,
            kind: "release",
            externalId: `${entityRef}-release`,
          }),
        ],
        chunk: {
          repositoryId: repository.id,
          kinds: ["commit"],
          days: ["2026-08-10"],
          ingestedAt: NOW,
        },
        backfillCursor: "2026-05-01",
        status: "active",
        now: NOW,
      });
      await store.saveSnapshot({
        repositoryId: repository.id,
        day: "2026-08-10",
        capturedAt: NOW,
        payload: aSnapshotPayload(),
      });
      return repository;
    };

    it("should drop what the walk re-collects and keep what it does not", async () => {
      // given
      const store = await createStore();
      const repository = await seedRepositoryWithHistory(store, "component:default/reset-me");

      // when
      await store.resetIngestion({ days: 30, now: NOW });

      // then
      // Releases and tags come from the daily snapshot rather than the walk, so
      // deleting them would lose history nothing would ever put back.
      const events = await store.listEvents({
        from: new Date("2026-08-01T00:00:00.000Z"),
        to: new Date("2026-08-11T00:00:00.000Z"),
      });
      expect(events.map((event) => event.kind)).toEqual(["release"]);
      expect(
        await store.listLatestSnapshots({ day: "2026-08-10", repositoryIds: [repository.id] }),
      ).toHaveLength(1);
    });

    it("should send the cursors back to the requested reach", async () => {
      // given
      // The floor is the administrator's choice rather than the retention
      // setting: re-reading a year is a day of rate-limited requests, and
      // somebody who wants last month should not pay for the other eleven.
      const store = await createStore();
      await seedRepositoryWithHistory(store, "component:default/reset-cursors");

      // when
      const result = await store.resetIngestion({ days: 30, now: NOW });

      // then
      expect(result.repositories).toBe(1);
      const [tracked] = await store.listTrackedRepositories();
      expect(tracked.state.backfillFloor).toBe("2026-07-11");
      expect(tracked.state.backfillCursor).toBe("2026-08-10");
      expect(tracked.state.status).toBe("pending");
      expect(tracked.state.failureCount).toBe(0);
      expect(tracked.state.lastError).toBeNull();
    });

    it("should forget the days it claimed as fetched", async () => {
      // given
      // A cursor sent back with the chunks left behind would report a repository
      // as having covered days whose rows are gone.
      const store = await createStore();
      await seedRepositoryWithHistory(store, "component:default/reset-chunks");

      // when
      await store.resetIngestion({ days: 30, now: NOW });

      // then
      const coverage = await store.getCoverage();
      expect(coverage.earliestDay).toBeNull();
      expect(coverage.latestDay).toBeNull();
    });

    it("should keep the history older than the reach", async () => {
      // given
      // The floor is raised to the reach in the same transaction and the walk
      // never goes below its floor, so anything older that was deleted would
      // never come back: a thirty-day reach must cost thirty days, not the
      // other eleven months.
      const store = await createStore();
      const repository = await seedRepositoryWithHistory(store, "component:default/reset-older");
      await store.commitIngestion({
        repositoryId: repository.id,
        events: [
          anEvent({
            repositoryId: repository.id,
            externalId: "old-commit",
            occurredAt: new Date("2026-05-02T09:00:00.000Z"),
          }),
        ],
        chunk: {
          repositoryId: repository.id,
          kinds: ["commit"],
          days: ["2026-05-02"],
          ingestedAt: NOW,
        },
        backfillCursor: "2026-05-01",
        status: "active",
        now: NOW,
      });

      // when
      await store.resetIngestion({ days: 30, now: NOW });

      // then
      const older = await store.listEvents({
        from: new Date("2026-05-01T00:00:00.000Z"),
        to: new Date("2026-05-03T00:00:00.000Z"),
      });
      expect(older.map((event) => event.externalId)).toEqual(["old-commit"]);
      const recent = await store.listEvents({
        from: new Date("2026-08-01T00:00:00.000Z"),
        to: new Date("2026-08-11T00:00:00.000Z"),
        kinds: ["commit"],
      });
      expect(recent).toHaveLength(0);
      // The day before the reach stays claimed, so the range picker keeps
      // offering the history that stayed.
      const coverage = await store.getCoverage();
      expect(coverage.earliestDay).toBe("2026-05-02");
      expect(coverage.latestDay).toBe("2026-05-02");
    });

    it("should leave a repository that has left the catalog alone", async () => {
      // given
      // It is never ingested again, so its history — wrong as it may be — is
      // kept rather than deleted with nothing to replace it.
      const store = await createStore();
      const removed = await seedRepositoryWithHistory(store, "component:default/departed");
      await store.syncRepositories({ discovered: [], retentionDays: 365, now: NOW });

      // when
      const result = await store.resetIngestion({ days: 30, now: NOW });

      // then
      expect(result.repositories).toBe(0);
      const events = await store.listEvents({
        from: new Date("2026-08-01T00:00:00.000Z"),
        to: new Date("2026-08-11T00:00:00.000Z"),
        repositoryIds: [removed.id],
      });
      expect(events).toHaveLength(2);
    });

    it("should do nothing at all when nothing is tracked", async () => {
      // given
      const store = await createStore();

      // when
      const result = await store.resetIngestion({ days: 30, now: NOW });

      // then
      expect(result.repositories).toBe(0);
    });
  });

  describe("getCoverage", () => {
    it("should report nothing covered before the first ingestion", async () => {
      // given
      const store = await createStore();
      await store.syncRepositories({
        discovered: [DiscoveredRepositoryBuilder.create().build()],
        retentionDays: 365,
        now: NOW,
      });

      // when
      const coverage = await store.getCoverage();

      // then
      expect(coverage.earliestDay).toBeNull();
      expect(coverage.latestDay).toBeNull();
      expect(coverage.repositories).toBe(1);
      expect(coverage.complete).toBe(0);
    });

    it("should count a completed backfill", async () => {
      // given
      const store = await createStore();
      const repository = DiscoveredRepositoryBuilder.create().build();
      await store.syncRepositories({ discovered: [repository], retentionDays: 365, now: NOW });

      // when
      await store.commitIngestion({
        repositoryId: repository.id,
        events: [],
        chunk: {
          repositoryId: repository.id,
          kinds: ["commit"],
          days: ["2025-08-10"],
          ingestedAt: NOW,
        },
        backfillCursor: "2025-08-10",
        status: "complete",
        now: NOW,
      });

      // then
      const coverage = await store.getCoverage();
      expect(coverage.complete).toBe(1);
      expect(coverage.earliestDay).toBe("2025-08-10");
    });

    it("should exclude a repository that left the catalog from the counts", async () => {
      // given
      const store = await createStore();
      await store.syncRepositories({
        discovered: [DiscoveredRepositoryBuilder.create().build()],
        retentionDays: 365,
        now: NOW,
      });

      // when
      await store.syncRepositories({ discovered: [], retentionDays: 365, now: NOW });

      // then
      const coverage = await store.getCoverage();
      expect(coverage.repositories).toBe(0);
    });
  });

  describe("getTrackedRepository", () => {
    it("should return the repository together with its cursor", async () => {
      // given
      const store = await createStore();
      const repository = DiscoveredRepositoryBuilder.create()
        .withSonarProjectKey("org_repo")
        .build();
      await store.syncRepositories({ discovered: [repository], retentionDays: 365, now: NOW });

      // when
      const result = await store.getTrackedRepository(repository.id);

      // then
      expect(result?.repository.sonarProjectKey).toBe("org_repo");
      expect(result?.state.repositoryId).toBe(repository.id);
    });

    it("should return nothing for an unknown repository", async () => {
      // given
      const store = await createStore();

      // when
      const result = await store.getTrackedRepository("does-not-exist");

      // then
      expect(result).toBeUndefined();
    });
  });
  describe("updateRepositoryFacts", () => {
    it("should leave the row untouched when nothing was supplied", async () => {
      // given
      const store = await createStore();
      const repository = DiscoveredRepositoryBuilder.create().build();
      await store.syncRepositories({ discovered: [repository], retentionDays: 365, now: NOW });
      await store.updateRepositoryFacts({
        repositoryId: repository.id,
        defaultBranch: "main",
      });

      // when
      await store.updateRepositoryFacts({ repositoryId: repository.id });

      // then
      const [tracked] = await store.listTrackedRepositories();
      expect(tracked.repository.defaultBranch).toBe("main");
    });

    it("should mark a repository archived once the provider reports it so", async () => {
      // given
      const store = await createStore();
      const repository = DiscoveredRepositoryBuilder.create().build();
      await store.syncRepositories({ discovered: [repository], retentionDays: 365, now: NOW });

      // when
      await store.updateRepositoryFacts({ repositoryId: repository.id, archived: true });

      // then
      const [tracked] = await store.listTrackedRepositories();
      expect(tracked.repository.archived).toBe(true);
    });
  });

  describe("stored payloads", () => {
    it("should read an event back as null when its payload is not valid JSON", async () => {
      // given
      // A row written by an older version, or corrupted in transit, must not
      // take the whole window's read down with it.
      const store = await createStore();
      const repository = DiscoveredRepositoryBuilder.create().build();
      await store.syncRepositories({ discovered: [repository], retentionDays: 365, now: NOW });
      await store.commitIngestion({
        repositoryId: repository.id,
        events: [anEvent({ repositoryId: repository.id })],
        chunk: {
          repositoryId: repository.id,
          kinds: ["commit"],
          days: ["2026-08-10"],
          ingestedAt: NOW,
        },
        status: "active",
        now: NOW,
      });
      await store.knex("code_health_events").update({ payload: "{not json" });

      // when
      const events = await store.listEvents({
        from: new Date("2026-08-10T00:00:00.000Z"),
        to: new Date("2026-08-11T00:00:00.000Z"),
      });

      // then
      expect(events).toHaveLength(1);
      expect(events[0].payload).toBeNull();
    });

    it("should read an event back as null when its payload is a JSON array", async () => {
      // given
      const store = await createStore();
      const repository = DiscoveredRepositoryBuilder.create().build();
      await store.syncRepositories({ discovered: [repository], retentionDays: 365, now: NOW });
      await store.commitIngestion({
        repositoryId: repository.id,
        events: [anEvent({ repositoryId: repository.id })],
        chunk: {
          repositoryId: repository.id,
          kinds: ["commit"],
          days: ["2026-08-10"],
          ingestedAt: NOW,
        },
        status: "active",
        now: NOW,
      });
      await store.knex("code_health_events").update({ payload: "[1,2,3]" });

      // when
      const events = await store.listEvents({
        from: new Date("2026-08-10T00:00:00.000Z"),
        to: new Date("2026-08-11T00:00:00.000Z"),
      });

      // then
      expect(events[0].payload).toBeNull();
    });

    it("should store an event with no payload at all", async () => {
      // given
      const store = await createStore();
      const repository = DiscoveredRepositoryBuilder.create().build();
      await store.syncRepositories({ discovered: [repository], retentionDays: 365, now: NOW });

      // when
      await store.commitIngestion({
        repositoryId: repository.id,
        events: [anEvent({ repositoryId: repository.id, payload: null })],
        chunk: {
          repositoryId: repository.id,
          kinds: ["commit"],
          days: ["2026-08-10"],
          ingestedAt: NOW,
        },
        status: "active",
        now: NOW,
      });

      // then
      const events = await store.listEvents({
        from: new Date("2026-08-10T00:00:00.000Z"),
        to: new Date("2026-08-11T00:00:00.000Z"),
      });
      expect(events[0].payload).toBeNull();
    });
  });

  describe("contributor measures", () => {
    interface Measure {
      readonly totalSeconds: number;
    }

    const write = (
      store: KnexCodeHealthStore,
      options: { source?: "wakatime" | "jira"; day: Day; seconds: number; key?: string },
    ) =>
      store.saveContributorMetrics<Measure>({
        source: options.source ?? "wakatime",
        day: options.day,
        capturedAt: NOW,
        metrics: new Map([[options.key ?? "dev@example.com", { totalSeconds: options.seconds }]]),
      });

    it("should store and read back measures per contributor", async () => {
      // given
      const store = await createStore();

      // when
      await store.saveContributorMetrics<Measure>({
        source: "wakatime",
        day: "2026-08-10",
        capturedAt: NOW,
        metrics: new Map([
          ["dev@example.com", { totalSeconds: 3600 }],
          ["other@example.com", { totalSeconds: 60 }],
        ]),
      });

      // then
      const rows = await store.listContributorMetrics<Measure>({
        source: "wakatime",
        from: "2026-08-10",
        to: "2026-08-10",
      });
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.contributorKey).sort()).toEqual([
        "dev@example.com",
        "other@example.com",
      ]);
      expect(rows[0]?.day).toBe("2026-08-10");
    });

    it("should keep two integrations' measures for the same person apart", async () => {
      // given
      // The source is part of the key precisely so a WakaTime day and a Jira day
      // for one account cannot overwrite each other.
      const store = await createStore();

      // when
      await write(store, { source: "wakatime", day: "2026-08-10", seconds: 100 });
      await write(store, { source: "jira", day: "2026-08-10", seconds: 900 });

      // then
      const wakatime = await store.listContributorMetrics<Measure>({
        source: "wakatime",
        from: "2026-08-10",
        to: "2026-08-10",
      });
      const jira = await store.listContributorMetrics<Measure>({
        source: "jira",
        from: "2026-08-10",
        to: "2026-08-10",
      });
      expect(wakatime[0]?.payload.totalSeconds).toBe(100);
      expect(jira[0]?.payload.totalSeconds).toBe(900);
    });

    it("should read only the days inside the requested window", async () => {
      // given
      const store = await createStore();
      for (const [day, seconds] of [
        ["2026-08-08", 100],
        ["2026-08-09", 200],
        ["2026-08-11", 300],
      ] as const) {
        await write(store, { day, seconds });
      }

      // when
      const rows = await store.listContributorMetrics<Measure>({
        source: "wakatime",
        from: "2026-08-09",
        to: "2026-08-10",
      });

      // then
      // A later capture must not leak into a past window, or the contributors
      // view would show today's numbers against last month.
      expect(rows.map((row) => row.day)).toEqual(["2026-08-09"]);
    });

    it("should return the most recent row per account at or before the day", async () => {
      // given
      const store = await createStore();
      for (const [day, seconds] of [
        ["2026-08-08", 100],
        ["2026-08-09", 200],
        ["2026-08-11", 300],
      ] as const) {
        await write(store, { day, seconds });
      }

      // when
      const latest = await store.listLatestContributorMetrics<Measure>({
        source: "wakatime",
        day: "2026-08-10",
      });

      // then
      expect(latest.get("dev@example.com")?.totalSeconds).toBe(200);
    });

    it("should list the distinct days a source already covers", async () => {
      // given
      // The caller uses this to skip days it has, so a second person on the same
      // day must not make the day appear twice.
      const store = await createStore();
      await write(store, { day: "2026-08-09", seconds: 1 });
      await write(store, { day: "2026-08-09", seconds: 2, key: "other@example.com" });
      await write(store, { day: "2026-08-11", seconds: 3 });

      // when
      const days = await store.listContributorMetricDays({
        source: "wakatime",
        from: "2026-08-08",
        to: "2026-08-10",
      });

      // then
      expect(days).toEqual(["2026-08-09"]);
    });

    it("should overwrite measures captured twice on the same day", async () => {
      // given
      const store = await createStore();

      // when
      await write(store, { day: "2026-08-10", seconds: 100 });
      await write(store, { day: "2026-08-10", seconds: 250 });

      // then
      const rows = await store.listContributorMetrics<Measure>({
        source: "wakatime",
        from: "2026-08-10",
        to: "2026-08-10",
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload.totalSeconds).toBe(250);
    });

    it("should do nothing when there are no measures to store", async () => {
      // given
      const store = await createStore();

      // when
      await store.saveContributorMetrics({
        source: "wakatime",
        day: "2026-08-10",
        capturedAt: NOW,
        metrics: new Map(),
      });

      // then
      const rows = await store.listContributorMetrics({
        source: "wakatime",
        from: "2026-08-10",
        to: "2026-08-10",
      });
      expect(rows).toHaveLength(0);
    });
  });

  describe("identities", () => {
    const anIdentity = (overrides: Partial<ObservedIdentity> = {}): ObservedIdentity => ({
      source: "wakatime",
      sourceKey: "jrios",
      displayName: "J Rios",
      email: null,
      avatarUrl: null,
      profileUrl: null,
      ...overrides,
    });

    it("should record an account and read it back", async () => {
      // given
      const store = await createStore();

      // when
      await store.recordObservedIdentities({ identities: [anIdentity()], now: NOW });

      // then
      const [identity] = await store.listIdentities();
      expect(identity).toMatchObject({ source: "wakatime", sourceKey: "jrios" });
      expect(identity?.firstSeenAt).toEqual(NOW);
    });

    it("should refresh a known account without moving its first sighting", async () => {
      // given
      // `firstSeenAt` is the one field that has to survive being seen again;
      // merging it would reset every account to "first seen today" every run.
      const store = await createStore();
      const later = new Date("2026-09-01T00:00:00.000Z");
      await store.recordObservedIdentities({ identities: [anIdentity()], now: NOW });

      // when
      await store.recordObservedIdentities({
        identities: [anIdentity({ displayName: "Felipe Rios" })],
        now: later,
      });

      // then
      const [identity] = await store.listIdentities();
      expect(identity?.displayName).toBe("Felipe Rios");
      expect(identity?.firstSeenAt).toEqual(NOW);
      expect(identity?.lastSeenAt).toEqual(later);
    });

    it("should accept a batch naming the same account twice", async () => {
      // given
      // One ingestion window routinely reports the same person on a dozen
      // commits, and an upsert cannot merge a batch that repeats a key.
      const store = await createStore();

      // when
      await store.recordObservedIdentities({
        identities: [anIdentity(), anIdentity({ displayName: "Second" })],
        now: NOW,
      });

      // then
      const identities = await store.listIdentities();
      expect(identities).toHaveLength(1);
      expect(identities[0]?.displayName).toBe("Second");
    });

    it("should do nothing when nothing was observed", async () => {
      // given
      const store = await createStore();

      // when
      await store.recordObservedIdentities({ identities: [], now: NOW });

      // then
      expect(await store.listIdentities()).toEqual([]);
    });

    it("should narrow the listing to the requested sources", async () => {
      // given
      const store = await createStore();
      await store.recordObservedIdentities({
        identities: [anIdentity(), anIdentity({ source: "vcs", sourceKey: "dev@example.com" })],
        now: NOW,
      });

      // when
      const identities = await store.listIdentities({ sources: ["vcs"] });

      // then
      expect(identities.map((identity) => identity.source)).toEqual(["vcs"]);
    });

    it("should store, replace and remove a link", async () => {
      // given
      const store = await createStore();
      const link = {
        source: "wakatime",
        sourceKey: "jrios",
        entityRef: "user:default/jrios",
        origin: "manual",
        linkedBy: "user:default/admin",
        linkedAt: NOW,
      } as const;

      // when
      await store.saveIdentityLink(link);
      await store.saveIdentityLink({ ...link, entityRef: "user:default/felipe" });

      // then
      const [stored] = await store.listIdentityLinks();
      expect(stored?.entityRef).toBe("user:default/felipe");
      expect(stored?.linkedBy).toBe("user:default/admin");

      // when
      await store.deleteIdentityLink({ source: "wakatime", sourceKey: "jrios" });

      // then
      expect(await store.listIdentityLinks()).toEqual([]);
    });

    it("should refuse to let an automatic link overwrite a manual one", async () => {
      // given
      // The reconciliation task runs every few minutes, and quietly undoing
      // somebody's correction is the single failure that would make the
      // Identities screen pointless.
      const store = await createStore();
      await store.saveIdentityLink({
        source: "wakatime",
        sourceKey: "jrios",
        entityRef: "user:default/felipe",
        origin: "manual",
        linkedBy: "user:default/admin",
        linkedAt: NOW,
      });

      // when
      await store.saveIdentityLink({
        source: "wakatime",
        sourceKey: "jrios",
        entityRef: "user:default/somebody-else",
        origin: "catalog-email",
        linkedBy: null,
        linkedAt: new Date("2026-09-01T00:00:00.000Z"),
      });

      // then
      const [stored] = await store.listIdentityLinks();
      expect(stored?.entityRef).toBe("user:default/felipe");
      expect(stored?.origin).toBe("manual");
    });

    it("should store, replace and remove an exclusion", async () => {
      // given
      const store = await createStore();
      const exclusion = {
        source: "vcs",
        sourceKey: "build-service",
        reason: "automated-bot",
        excludedBy: "user:default/admin",
        excludedAt: NOW,
      } as const;

      // when
      await store.saveIdentityExclusion(exclusion);
      // Re-excluding under a different reason is a correction to the one answer
      // rather than a second exclusion.
      await store.saveIdentityExclusion({ ...exclusion, reason: "service-account" });

      // then
      const stored = await store.listIdentityExclusions();
      expect(stored).toHaveLength(1);
      expect(stored[0]?.reason).toBe("service-account");
      expect(stored[0]?.excludedBy).toBe("user:default/admin");
      expect(stored[0]?.excludedAt).toEqual(NOW);

      // when
      await store.deleteIdentityExclusion({ source: "vcs", sourceKey: "build-service" });

      // then
      expect(await store.listIdentityExclusions()).toEqual([]);
    });

    it("should keep an exclusion for an account with no link at all", async () => {
      // given
      // Every bot and every build service is exactly this shape, and a foreign
      // key onto the link table would have made it impossible to record.
      const store = await createStore();

      // when
      await store.saveIdentityExclusion({
        source: "vcs",
        sourceKey: "ghost@nowhere",
        reason: "former-contributor",
        excludedBy: null,
        excludedAt: NOW,
      });

      // then
      expect(await store.listIdentityExclusions()).toHaveLength(1);
      expect(await store.listIdentityLinks()).toEqual([]);
    });

    it("should let a manual link replace an automatic one", async () => {
      // given
      // The correction has to be possible in that direction, or the screen can
      // only ever add links and never fix a wrong one.
      const store = await createStore();
      await store.saveIdentityLink({
        source: "vcs",
        sourceKey: "dev@example.com",
        entityRef: "user:default/wrong",
        origin: "catalog-email",
        linkedBy: null,
        linkedAt: NOW,
      });

      // when
      await store.saveIdentityLink({
        source: "vcs",
        sourceKey: "dev@example.com",
        entityRef: "user:default/right",
        origin: "manual",
        linkedBy: "user:default/admin",
        linkedAt: NOW,
      });

      // then
      const [stored] = await store.listIdentityLinks();
      expect(stored?.entityRef).toBe("user:default/right");
    });
  });
});
