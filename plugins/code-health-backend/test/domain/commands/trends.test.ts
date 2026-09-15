import type { SonarMetrics } from "@rios0rios0/backstage-plugin-code-health-common";
import { NO_INTEGRATIONS } from "@rios0rios0/backstage-plugin-code-health-common";
import { GetContributorTrend } from "../../../src/domain/commands/get_contributor_trend";
import { GetRepositoryTrend } from "../../../src/domain/commands/get_repository_trend";
import type { RepositorySnapshotPayload } from "../../../src/domain/entities/repository_snapshot";
import type { Day } from "../../../src/domain/entities/day";
import {
  aConfluenceContributorMetrics,
  aJiraContributorMetrics,
} from "../../builders/atlassian_contributor_metrics_builder";
import { DiscoveredRepositoryBuilder } from "../../builders/discovered_repository_builder";
import { EventBuilder } from "../../builders/event_builder";
import { WakaTimeMetricsBuilder } from "../../builders/wakatime_metrics_builder";
import { InMemoryCodeHealthStore } from "../../doubles/in_memory_code_health_store";
import { StubDirectoryReader } from "../../doubles/stub_directory_reader";

const NOW = new Date("2026-08-10T12:00:00.000Z");

/** Four days, so a daily bucket produces four points and a weekly one produces one. */
const WINDOW = {
  from: new Date("2026-08-05T00:00:00.000Z"),
  to: new Date("2026-08-09T00:00:00.000Z"),
};

const aSonar = (overrides: Partial<SonarMetrics> = {}): SonarMetrics => ({
  bugs: 0,
  codeSmells: 0,
  securityHotspots: 0,
  vulnerabilities: 0,
  coverage: 80,
  duplications: 0,
  technicalDebt: "0min",
  technicalDebtMinutes: 0,
  qualityGateStatus: "OK",
  ...overrides,
});

const aPayload = (
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

const seed = async (repositories = 1) => {
  const store = new InMemoryCodeHealthStore();
  const discovered = Array.from({ length: repositories }, (_unused, index) =>
    DiscoveredRepositoryBuilder.create()
      .withEntityRef(`component:default/trend-${index}`)
      .withName(`trend-${index}`)
      .build(),
  );
  await store.syncRepositories({ discovered, retentionDays: 365, now: NOW });
  return { store, discovered };
};

const commit = (repositoryId: string, at: string, actor: string) =>
  EventBuilder.commit()
    .withRepository(repositoryId)
    .withActor(actor)
    .at(at)
    .withChurn(10, 2, 1)
    .build();

const ingest = async (
  store: InMemoryCodeHealthStore,
  repositoryId: string,
  events: ReturnType<typeof commit>[],
) => {
  await store.commitIngestion({
    repositoryId,
    events,
    chunk: { repositoryId, kinds: ["commit"], days: [], ingestedAt: NOW },
    status: "active",
    now: NOW,
  });
};

const snapshot = async (
  store: InMemoryCodeHealthStore,
  repositoryId: string,
  day: Day,
  payload: RepositorySnapshotPayload,
) => {
  await store.saveSnapshot({ repositoryId, day, capturedAt: NOW, payload });
};

describe("GetContributorTrend", () => {
  it("should emit one point per day of the window, in order", async () => {
    // given
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await ingest(store, repository.id, [
      commit(repository.id, "2026-08-06T10:00:00.000Z", "dev@example.com"),
    ]);

    // when
    const trend = await new GetContributorTrend({ store }).run({
      key: "vcs:dev@example.com",
      ...WINDOW,
      bucket: "day",
    });

    // then
    expect(trend.points.map((point) => point.day)).toEqual([
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
      "2026-08-08",
    ]);
  });

  it("should still emit a point for a bucket the person did nothing in", async () => {
    // given
    // Closing over a quiet fortnight would draw it as a shorter, busier month.
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await ingest(store, repository.id, [
      commit(repository.id, "2026-08-06T10:00:00.000Z", "dev@example.com"),
    ]);

    // when
    const trend = await new GetContributorTrend({ store }).run({
      key: "vcs:dev@example.com",
      ...WINDOW,
      bucket: "day",
    });

    // then
    const quiet = trend.points.find((point) => point.day === "2026-08-07");
    expect(quiet?.summary.commits).toBe(0);
    // Named the way the whole-window row is, so a zero point does not read as a
    // second person appearing in the middle of the series.
    expect(quiet?.summary.displayName).toBe("Dev Example");
    expect(quiet?.summary.key).toBe("vcs:dev@example.com");
  });

  it("should carry the whole window's row and its score", async () => {
    // given
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await ingest(store, repository.id, [
      commit(repository.id, "2026-08-06T10:00:00.000Z", "dev@example.com"),
      commit(repository.id, "2026-08-07T10:00:00.000Z", "dev@example.com"),
    ]);

    // when
    const trend = await new GetContributorTrend({ store }).run({
      key: "vcs:dev@example.com",
      ...WINDOW,
      bucket: "day",
    });

    // then
    expect(trend.summary?.commits).toBe(2);
    // The only person measured is the team average, and average is half — not
    // the full marks the old top-figure reference handed out for being alone.
    expect(trend.score?.value).toBe(50);
  });

  it("should score each bucket against the fleet in that bucket", async () => {
    // given
    // A score is a rate against the team's average rate in the same period.
    // Scored against the whole window's average instead, a normal week beside
    // one exceptional week reads as a collapse.
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await ingest(store, repository.id, [
      commit(repository.id, "2026-08-06T10:00:00.000Z", "dev@example.com"),
      ...Array.from({ length: 9 }, (_unused, index) =>
        commit(repository.id, `2026-08-07T1${index}:00:00.000Z`, "other@example.com"),
      ),
      commit(repository.id, "2026-08-07T09:00:00.000Z", "dev@example.com"),
    ]);

    // when
    const trend = await new GetContributorTrend({ store }).run({
      key: "vcs:dev@example.com",
      ...WINDOW,
      bucket: "day",
    });

    // then
    // Alone on the 6th, so they are the average, which is half. On the 7th one
    // against nine: the mean of 1 and 9 is 5, and twice that is 10, so a tenth.
    const commits = (day: string) =>
      trend.points.find((point) => point.day === day)?.score.components.find(
        (component) => component.id === "commits",
      );
    expect(commits("2026-08-06")?.normalized).toBe(0.5);
    expect(commits("2026-08-07")?.normalized).toBeCloseTo(0.1, 3);
  });

  it("should fill Sonar forward from the baseline into a bucket with no snapshot", async () => {
    // given
    // Sonar cannot be backfilled and the snapshot task can miss a run, so a day
    // with nothing recorded inherits the last measure taken before it — rather
    // than blinking out and reading as a repository that stopped being measured.
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await snapshot(
      store,
      repository.id,
      "2026-08-01",
      aPayload({ sonarMetrics: aSonar({ bugs: 7 }) }),
    );
    await ingest(store, repository.id, [
      commit(repository.id, "2026-08-06T10:00:00.000Z", "dev@example.com"),
    ]);

    // when
    const trend = await new GetContributorTrend({ store }).run({
      key: "vcs:dev@example.com",
      ...WINDOW,
      bucket: "day",
    });

    // then
    const point = trend.points.find((candidate) => candidate.day === "2026-08-06");
    expect(point?.summary.sonarMetrics?.bugs).toBe(7);
  });

  it("should pick up a Sonar measure recorded inside the window", async () => {
    // given
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await snapshot(
      store,
      repository.id,
      "2026-08-01",
      aPayload({ sonarMetrics: aSonar({ bugs: 7 }) }),
    );
    await snapshot(
      store,
      repository.id,
      "2026-08-07",
      aPayload({ sonarMetrics: aSonar({ bugs: 1 }) }),
    );
    await ingest(store, repository.id, [
      commit(repository.id, "2026-08-06T10:00:00.000Z", "dev@example.com"),
      commit(repository.id, "2026-08-08T10:00:00.000Z", "dev@example.com"),
    ]);

    // when
    const trend = await new GetContributorTrend({ store }).run({
      key: "vcs:dev@example.com",
      ...WINDOW,
      bucket: "day",
    });

    // then
    const bugsOn = (day: string) =>
      trend.points.find((point) => point.day === day)?.summary.sonarMetrics?.bugs;
    expect(bugsOn("2026-08-06")).toBe(7);
    expect(bugsOn("2026-08-08")).toBe(1);
  });

  it("should answer a key nothing was recorded under with a null summary", async () => {
    // given
    // A stale link and a quiet month want different words on the screen, so the
    // points are still returned — all zero — and the summary says which it is.
    const { store } = await seed();

    // when
    const trend = await new GetContributorTrend({ store }).run({
      key: "vcs:ghost@example.com",
      ...WINDOW,
      bucket: "day",
    });

    // then
    expect(trend.summary).toBeNull();
    expect(trend.score).toBeNull();
    expect(trend.points).toHaveLength(4);
    expect(trend.points.every((point) => point.summary.commits === 0)).toBe(true);
    expect(trend.points[0].summary.key).toBe("vcs:ghost@example.com");
  });

  it("should bucket by week when asked", async () => {
    // given
    // 2026-08-05 is a Wednesday, so the whole window falls in the week that
    // started on the Monday before it.
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await ingest(store, repository.id, [
      commit(repository.id, "2026-08-06T10:00:00.000Z", "dev@example.com"),
      commit(repository.id, "2026-08-08T10:00:00.000Z", "dev@example.com"),
    ]);

    // when
    const trend = await new GetContributorTrend({ store }).run({
      key: "vcs:dev@example.com",
      ...WINDOW,
      bucket: "week",
    });

    // then
    expect(trend.points.map((point) => point.day)).toEqual(["2026-08-03"]);
    expect(trend.points[0].summary.commits).toBe(2);
  });

  it("should look the person up in the catalog once and only for the key asked about", async () => {
    // given
    // The other rows exist only to work out the fleet's top figures, and a name
    // is not one of those — looking them all up would put a catalog query per
    // bucket on the request path.
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await store.saveIdentityLink({
      source: "vcs",
      sourceKey: "dev@example.com",
      entityRef: "user:default/jane",
      origin: "manual",
      linkedBy: "user:default/admin",
      linkedAt: NOW,
    });
    await ingest(store, repository.id, [
      commit(repository.id, "2026-08-06T10:00:00.000Z", "dev@example.com"),
      commit(repository.id, "2026-08-07T10:00:00.000Z", "other@example.com"),
    ]);
    const directory = new StubDirectoryReader([
      {
        entityRef: "user:default/jane",
        displayName: "Jane Doe",
        email: "jane@example.com",
        picture: null,
      },
    ]);

    // when
    const trend = await new GetContributorTrend({ store, directory }).run({
      key: "user:default/jane",
      ...WINDOW,
      bucket: "day",
    });

    // then
    expect(directory.refLookups).toEqual([["user:default/jane"]]);
    expect(trend.summary?.displayName).toBe("Jane Doe");
  });

  it("should slice a person's coding time and tickets into their buckets", async () => {
    // given
    // Both are stored a day at a time, which is what lets a bucket be answered
    // from the window's rows rather than by asking the store again per point.
    const { store } = await seed();
    for (const [day, seconds] of [
      ["2026-08-06", 3600],
      ["2026-08-08", 1800],
    ] as const) {
      await store.saveContributorMetrics({
        source: "wakatime",
        day,
        capturedAt: NOW,
        metrics: new Map([
          ["dev", WakaTimeMetricsBuilder.aDay(day).withSeconds(seconds).build()],
        ]),
      });
      await store.saveContributorMetrics({
        source: "jira",
        day,
        capturedAt: NOW,
        metrics: new Map([["dev", aJiraContributorMetrics({ issuesCreated: 1 })]]),
      });
    }

    for (const source of ["wakatime", "jira"] as const) {
      await store.saveIdentityLink({
        source,
        sourceKey: "dev",
        entityRef: "user:default/jane",
        origin: "manual",
        linkedBy: "user:default/admin",
        linkedAt: NOW,
      });
    }

    // when
    const trend = await new GetContributorTrend({ store }).run({
      key: "user:default/jane",
      ...WINDOW,
      bucket: "day",
    });

    // then
    const secondsOn = (day: string) =>
      trend.points.find((point) => point.day === day)?.summary.wakaTimeMetrics?.totalSeconds;
    expect(secondsOn("2026-08-06")).toBe(3600);
    expect(secondsOn("2026-08-07")).toBeUndefined();
    expect(secondsOn("2026-08-08")).toBe(1800);
    expect(trend.summary?.wakaTimeMetrics?.totalSeconds).toBe(5400);
    expect(trend.summary?.jiraMetrics?.issuesCreated).toBe(2);
  });

  it("should score a bucket on the integrations the backend was configured with", async () => {
    // given
    // The same stored measures, read twice. Whether a ticket counts towards the
    // score is a question about the backend's configuration, and the row itself
    // cannot answer it — these figures are here either way.
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await ingest(store, repository.id, [
      commit(repository.id, "2026-08-06T10:00:00.000Z", "dev@example.com"),
    ]);
    await store.saveContributorMetrics({
      source: "jira",
      day: "2026-08-06",
      capturedAt: NOW,
      metrics: new Map([["dev@example.com", aJiraContributorMetrics({ issuesResolved: 3 })]]),
    });

    // when
    const withJira = await new GetContributorTrend({
      store,
      capabilities: { ...NO_INTEGRATIONS, jira: true },
    }).run({ key: "jira:dev@example.com", ...WINDOW, bucket: "day" });
    const without = await new GetContributorTrend({ store }).run({
      key: "jira:dev@example.com",
      ...WINDOW,
      bucket: "day",
    });

    // then
    const componentIds = (trend: Awaited<ReturnType<GetContributorTrend["run"]>>) =>
      trend.points
        .find((point) => point.day === "2026-08-06")
        ?.score.components.map((component) => component.id) ?? [];
    expect(componentIds(withJira)).toEqual(
      expect.arrayContaining(["ticketsResolved", "reopened"]),
    );
    expect(componentIds(withJira)).not.toContain("codingTime");
    expect(componentIds(without)).not.toContain("ticketsResolved");
    expect(withJira.score?.components.map((component) => component.id)).toContain(
      "ticketsResolved",
    );
  });

  it("should keep Confluence on the whole-window row and off every bucket", async () => {
    // given
    // Confluence measures a trailing window rather than a day, so repeating one
    // figure on every point would draw a flat line and call it a series.
    const { store } = await seed();
    await store.saveContributorMetrics({
      source: "confluence",
      day: "2026-08-08",
      capturedAt: NOW,
      metrics: new Map([["dev", aConfluenceContributorMetrics({ pagesCreated: 3 })]]),
    });

    // when
    const trend = await new GetContributorTrend({
      store,
      capabilities: { ...NO_INTEGRATIONS, confluence: true },
    }).run({
      key: "confluence:dev",
      ...WINDOW,
      bucket: "day",
    });

    // then
    expect(trend.summary?.confluenceMetrics?.pagesCreated).toBe(3);
    expect(trend.points.every((point) => point.summary.confluenceMetrics === null)).toBe(true);
    // The headline score is folded with documentation in; every bucket's score
    // is folded with it out, rather than carrying it as unmeasured on every
    // point — otherwise the line would sit below the card for the whole window
    // while claiming to be the same quantity.
    const ids = (components: readonly { id: string }[]) => components.map((c) => c.id);
    expect(ids(trend.score?.components ?? [])).toContain("documentation");
    expect(
      trend.points.every((point) => !ids(point.score.components).includes("documentation")),
    ).toBe(true);
  });

  it("should read the Sonar of every repository snapshotted on the same day", async () => {
    // given
    const { store, discovered } = await seed(2);
    const [first, second] = discovered;
    for (const repository of [first, second]) {
      await snapshot(
        store,
        repository.id,
        "2026-08-06",
        aPayload({ sonarMetrics: aSonar({ bugs: 2 }) }),
      );
    }
    await ingest(store, first.id, [
      commit(first.id, "2026-08-06T10:00:00.000Z", "dev@example.com"),
    ]);
    await ingest(store, second.id, [
      commit(second.id, "2026-08-06T11:00:00.000Z", "dev@example.com"),
    ]);

    // when
    const trend = await new GetContributorTrend({ store }).run({
      key: "vcs:dev@example.com",
      ...WINDOW,
      bucket: "day",
    });

    // then
    // Summed across both repositories the person changed the code of.
    const point = trend.points.find((candidate) => candidate.day === "2026-08-06");
    expect(point?.summary.sonarMetrics?.bugs).toBe(4);
  });

  it("should bucket by month when asked", async () => {
    // given
    // The last bucket of a month-shaped window is nearly always partial, and
    // reading a snapshot past the window's end would show today's gate against
    // last March's numbers.
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await ingest(store, repository.id, [
      commit(repository.id, "2026-07-20T10:00:00.000Z", "dev@example.com"),
      commit(repository.id, "2026-08-06T10:00:00.000Z", "dev@example.com"),
    ]);

    // when
    const trend = await new GetContributorTrend({ store }).run({
      key: "vcs:dev@example.com",
      from: new Date("2026-07-01T00:00:00.000Z"),
      to: new Date("2026-08-09T00:00:00.000Z"),
      bucket: "month",
    });

    // then
    expect(trend.points.map((point) => [point.day, point.summary.commits])).toEqual([
      ["2026-07-01", 1],
      ["2026-08-01", 1],
    ]);
  });

  it("should not query the catalog for an unlinked key", async () => {
    // given
    // `vcs:dev@example.com` is not an entity reference; asking the catalog
    // about it is a request that can only come back empty.
    const { store } = await seed();
    const directory = new StubDirectoryReader([]);

    // when
    await new GetContributorTrend({ store, directory }).run({
      key: "vcs:dev@example.com",
      ...WINDOW,
      bucket: "day",
    });

    // then
    expect(directory.refLookups).toEqual([]);
  });
});

describe("GetRepositoryTrend", () => {
  it("should emit one point per bucket with that bucket's counters", async () => {
    // given
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await ingest(store, repository.id, [
      commit(repository.id, "2026-08-06T10:00:00.000Z", "dev@example.com"),
      commit(repository.id, "2026-08-06T11:00:00.000Z", "dev@example.com"),
      commit(repository.id, "2026-08-08T10:00:00.000Z", "dev@example.com"),
    ]);

    // when
    const trend = await new GetRepositoryTrend(store).run({
      repositoryId: repository.id,
      ...WINDOW,
      bucket: "day",
    });

    // then
    expect(
      trend.points.map((point) => [point.day, point.summary.activity.commits]),
    ).toEqual([
      ["2026-08-05", 0],
      ["2026-08-06", 2],
      ["2026-08-07", 0],
      ["2026-08-08", 1],
    ]);
  });

  it("should grade each bucket with the snapshot it had at the time", async () => {
    // given
    // A health score has to move when the quality gate moved, not when the
    // chart was drawn.
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await snapshot(
      store,
      repository.id,
      "2026-08-05",
      aPayload({ sonarMetrics: aSonar({ qualityGateStatus: "ERROR" }) }),
    );
    await snapshot(
      store,
      repository.id,
      "2026-08-08",
      aPayload({ sonarMetrics: aSonar({ qualityGateStatus: "OK" }) }),
    );

    // when
    const trend = await new GetRepositoryTrend(store).run({
      repositoryId: repository.id,
      ...WINDOW,
      bucket: "day",
    });

    // then
    const gateOn = (day: string) =>
      trend.points
        .find((point) => point.day === day)
        ?.score.components.find((component) => component.id === "qualityGate")?.value;
    expect(gateOn("2026-08-06")).toBe(0);
    expect(gateOn("2026-08-08")).toBe(1);
  });

  it("should fall back to the unsnapshotted state before the first snapshot", async () => {
    // given
    // A repository discovered this morning has counters hours before it has
    // anything to grade, and hiding it would make discovery look broken.
    const { store, discovered } = await seed();
    const [repository] = discovered;

    // when
    const trend = await new GetRepositoryTrend(store).run({
      repositoryId: repository.id,
      ...WINDOW,
      bucket: "day",
    });

    // then
    expect(trend.points[0].summary.sonarMetrics).toBeNull();
    expect(trend.points[0].summary.complianceStatus).toBeNull();
    expect(trend.points[0].score.value).toBeNull();
  });

  it("should carry the whole window's row and its score", async () => {
    // given
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await snapshot(
      store,
      repository.id,
      "2026-08-06",
      aPayload({ sonarMetrics: aSonar({ qualityGateStatus: "OK" }) }),
    );
    await ingest(store, repository.id, [
      commit(repository.id, "2026-08-06T10:00:00.000Z", "dev@example.com"),
    ]);

    // when
    const trend = await new GetRepositoryTrend(store).run({
      repositoryId: repository.id,
      ...WINDOW,
      bucket: "day",
    });

    // then
    expect(trend.summary.activity.commits).toBe(1);
    expect(trend.summary.name).toBe("trend-0");
    expect(trend.score.value).not.toBeNull();
  });

  it("should count only its own repository's events", async () => {
    // given
    const { store, discovered } = await seed(2);
    const [first, second] = discovered;
    await ingest(store, first.id, [
      commit(first.id, "2026-08-06T10:00:00.000Z", "dev@example.com"),
    ]);
    await ingest(store, second.id, [
      commit(second.id, "2026-08-06T10:00:00.000Z", "dev@example.com"),
      commit(second.id, "2026-08-06T11:00:00.000Z", "dev@example.com"),
    ]);

    // when
    const trend = await new GetRepositoryTrend(store).run({
      repositoryId: first.id,
      ...WINDOW,
      bucket: "day",
    });

    // then
    expect(trend.summary.activity.commits).toBe(1);
  });

  it("should slice the repository's coding time into its buckets", async () => {
    // given
    // A repository's coding time is the sum of what its people logged against
    // the matching WakaTime project, which is a question about a period rather
    // than about the day a snapshot was taken.
    const { store, discovered } = await seed();
    const [repository] = discovered;
    for (const [day, seconds] of [
      ["2026-08-06", 3600],
      ["2026-08-08", 1800],
    ] as const) {
      await store.saveContributorMetrics({
        source: "wakatime",
        day,
        capturedAt: NOW,
        metrics: new Map([
          [
            "dev",
            WakaTimeMetricsBuilder.aDay(day)
              .withSeconds(seconds)
              .withProject("trend-0", seconds)
              .build(),
          ],
        ]),
      });
    }

    // when
    const trend = await new GetRepositoryTrend(store).run({
      repositoryId: repository.id,
      ...WINDOW,
      bucket: "day",
    });

    // then
    const secondsOn = (day: string) =>
      trend.points.find((point) => point.day === day)?.summary.wakaTimeMetrics?.totalSeconds;
    expect(secondsOn("2026-08-06")).toBe(3600);
    expect(secondsOn("2026-08-07")).toBeUndefined();
    expect(trend.summary.wakaTimeMetrics?.totalSeconds).toBe(5400);
  });

  it("should bound the last bucket at the window's end", async () => {
    // given
    // A month-shaped window nearly always ends inside a bucket, and reading a
    // snapshot "at or before the bucket's last day" without the bound would
    // read one taken after the window the caller asked about.
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await snapshot(
      store,
      repository.id,
      "2026-08-06",
      aPayload({ sonarMetrics: aSonar({ qualityGateStatus: "OK" }) }),
    );
    await snapshot(
      store,
      repository.id,
      "2026-08-20",
      aPayload({ sonarMetrics: aSonar({ qualityGateStatus: "ERROR" }) }),
    );

    // when
    const trend = await new GetRepositoryTrend(store).run({
      repositoryId: repository.id,
      from: new Date("2026-08-01T00:00:00.000Z"),
      to: new Date("2026-08-09T00:00:00.000Z"),
      bucket: "month",
    });

    // then
    expect(trend.points.map((point) => point.day)).toEqual(["2026-08-01"]);
    expect(trend.points[0].summary.sonarMetrics?.qualityGateStatus).toBe("OK");
  });

  it("should refuse a repository it does not track", async () => {
    // given
    // The router answers 404 first; this covers the repository that left the
    // catalog between the two reads, and answers the same way rather than
    // building a row out of nothing.
    const { store } = await seed();

    // when
    const run = new GetRepositoryTrend(store).run({
      repositoryId: "does-not-exist",
      ...WINDOW,
      bucket: "day",
    });

    // then
    await expect(run).rejects.toThrow("no repository with id does-not-exist");
  });
});
