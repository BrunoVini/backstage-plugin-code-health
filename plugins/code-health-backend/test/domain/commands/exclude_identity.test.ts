import { computeRepositoryHealthScore } from "@rios0rios0/backstage-plugin-code-health-common";
import { ExcludeIdentity } from "../../../src/domain/commands/exclude_identity";
import { GetContributorTrend } from "../../../src/domain/commands/get_contributor_trend";
import { GetRepositoryTimeSeries } from "../../../src/domain/commands/get_repository_time_series";
import { UnknownIdentityError } from "../../../src/domain/commands/link_identity";
import { ListContributorSummaries } from "../../../src/domain/commands/list_contributor_summaries";
import { ListIdentities } from "../../../src/domain/commands/list_identities";
import { GetRepositoryTrend } from "../../../src/domain/commands/get_repository_trend";
import { ListRepositorySummaries } from "../../../src/domain/commands/list_repository_summaries";
import { DiscoveredRepositoryBuilder } from "../../builders/discovered_repository_builder";
import { EventBuilder } from "../../builders/event_builder";
import { WakaTimeMetricsBuilder } from "../../builders/wakatime_metrics_builder";
import { InMemoryCodeHealthStore } from "../../doubles/in_memory_code_health_store";
import { StubDirectoryReader } from "../../doubles/stub_directory_reader";

const NOW = new Date("2026-08-10T12:00:00.000Z");
const WINDOW = {
  from: new Date("2026-08-09T00:00:00.000Z"),
  to: new Date("2026-08-11T00:00:00.000Z"),
};

const seed = async (
  identities: Array<{
    source: "vcs" | "wakatime" | "jira" | "confluence";
    sourceKey: string;
    displayName?: string | null;
    email?: string | null;
  }>,
) => {
  const store = new InMemoryCodeHealthStore();
  await store.recordObservedIdentities({
    identities: identities.map((identity) => ({
      source: identity.source,
      sourceKey: identity.sourceKey,
      displayName: identity.displayName ?? null,
      email: identity.email ?? null,
      avatarUrl: null,
      profileUrl: null,
    })),
    now: NOW,
  });
  return store;
};

/** One tracked repository, so the repository-shaped reads have a row to build. */
const withRepository = async (store: InMemoryCodeHealthStore) => {
  const discovered = DiscoveredRepositoryBuilder.create()
    .withEntityRef("component:default/gateway")
    .withName("gateway")
    .build();
  await store.syncRepositories({ discovered: [discovered], retentionDays: 365, now: NOW });
  return { store, repositoryId: discovered.id };
};

const commitsBy = (repositoryId: string, actorKey: string, count: number) =>
  Array.from({ length: count }, (_unused, index) =>
    EventBuilder.commit()
      .withRepository(repositoryId)
      .withActor(actorKey)
      .withExternalId(`${actorKey}-${index}`)
      .withChurn(10, 1)
      .at("2026-08-09T12:00:00.000Z")
      .build(),
  );

const buildsBy = (
  repositoryId: string,
  actorKey: string,
  outcomes: readonly ("succeeded" | "failed")[],
) =>
  outcomes.map((outcome, index) =>
    EventBuilder.build(outcome)
      .withRepository(repositoryId)
      .withActor(actorKey)
      .withExternalId(`run-${actorKey}-${index}`)
      .at("2026-08-09T12:00:00.000Z")
      .build(),
  );

const commit = async (
  store: InMemoryCodeHealthStore,
  repositoryId: string,
  events: ReturnType<typeof commitsBy>,
) => {
  await store.commitIngestion({
    repositoryId,
    events,
    chunk: {
      repositoryId,
      kinds: ["commit", "build"],
      days: ["2026-08-09"],
      ingestedAt: NOW,
    },
    status: "complete",
    now: NOW,
  });
};

describe("ExcludeIdentity", () => {
  it("should record the reason the account was excluded", async () => {
    // given
    const store = await seed([{ source: "vcs", sourceKey: "build-service" }]);

    // when
    await new ExcludeIdentity(store).exclude({
      source: "vcs",
      sourceKey: "build-service",
      reason: "service-account",
      excludedBy: "user:default/admin",
      now: NOW,
    });

    // then
    expect(await store.listIdentityExclusions()).toEqual([
      {
        source: "vcs",
        sourceKey: "build-service",
        reason: "service-account",
        excludedBy: "user:default/admin",
        excludedAt: NOW,
      },
    ]);
  });

  it("should normalise the key, so a differently cased account is the same one", async () => {
    // given
    // An exclusion recorded on `Build-Service` has to match the events the
    // provider stamped `build-service` on, or it silently measures the row
    // somebody excluded.
    const store = await seed([{ source: "vcs", sourceKey: "build-service" }]);

    // when
    await new ExcludeIdentity(store).exclude({
      source: "vcs",
      sourceKey: "  Build-Service ",
      reason: "automated-bot",
      excludedBy: null,
      now: NOW,
    });

    // then
    expect((await store.listIdentityExclusions())[0]?.sourceKey).toBe("build-service");
  });

  it("should replace the reason when the account is excluded again", async () => {
    // given
    // There is one answer to "why is this row not measured", and correcting it
    // is the same statement made again rather than a second exclusion.
    const store = await seed([{ source: "vcs", sourceKey: "build-service" }]);
    const command = new ExcludeIdentity(store);
    await command.exclude({
      source: "vcs",
      sourceKey: "build-service",
      reason: "automated-bot",
      excludedBy: null,
      now: NOW,
    });

    // when
    await command.exclude({
      source: "vcs",
      sourceKey: "build-service",
      reason: "service-account",
      excludedBy: "user:default/admin",
      now: NOW,
    });

    // then
    const exclusions = await store.listIdentityExclusions();
    expect(exclusions).toHaveLength(1);
    expect(exclusions[0]?.reason).toBe("service-account");
  });

  it("should refuse an account nobody has observed", async () => {
    // given
    // An exclusion on an unknown account matches nothing, the tables look
    // exactly as they did, and the person who made it has no way to tell.
    const store = await seed([{ source: "vcs", sourceKey: "dev@example.com" }]);

    // when / then
    await expect(
      new ExcludeIdentity(store).exclude({
        source: "vcs",
        sourceKey: "ghost",
        reason: "automated-bot",
        excludedBy: null,
        now: NOW,
      }),
    ).rejects.toThrow(UnknownIdentityError);
  });

  it("should measure an account again", async () => {
    // given
    const store = await seed([{ source: "vcs", sourceKey: "build-service" }]);
    const command = new ExcludeIdentity(store);
    await command.exclude({
      source: "vcs",
      sourceKey: "build-service",
      reason: "service-account",
      excludedBy: null,
      now: NOW,
    });

    // when
    await command.include({ source: "vcs", sourceKey: "BUILD-SERVICE" });

    // then
    expect(await store.listIdentityExclusions()).toEqual([]);
  });

  it("should accept including an account that was never excluded", async () => {
    // given
    // Already true, and refusing would leave somebody unable to clear a row for
    // an account that has since aged out of the identity table.
    const store = await seed([]);

    // when / then
    await expect(
      new ExcludeIdentity(store).include({ source: "vcs", sourceKey: "ghost" }),
    ).resolves.toBeUndefined();
  });
});

describe("ListIdentities with exclusions", () => {
  it("should carry the exclusion on the row it was recorded against", async () => {
    // given
    const store = await seed([{ source: "vcs", sourceKey: "build-service" }]);
    await new ExcludeIdentity(store).exclude({
      source: "vcs",
      sourceKey: "build-service",
      reason: "service-account",
      excludedBy: "user:default/admin",
      now: NOW,
    });

    // when
    const rows = await new ListIdentities(store, new StubDirectoryReader()).run({});

    // then
    expect(rows[0]?.exclusion).toEqual({
      source: "vcs",
      sourceKey: "build-service",
      reason: "service-account",
      excludedBy: "user:default/admin",
      excludedAt: NOW.toISOString(),
    });
  });

  it("should carry an exclusion across every account of the same person", async () => {
    // given
    // Excluding a leaver's commit address has to take their coding time with
    // it, or the row holds a third of a story — the exact failure linking
    // exists to remove.
    const store = await seed([
      { source: "vcs", sourceKey: "dev@example.com" },
      { source: "wakatime", sourceKey: "jrios" },
    ]);
    for (const source of ["vcs", "wakatime"] as const) {
      await store.saveIdentityLink({
        source,
        sourceKey: source === "vcs" ? "dev@example.com" : "jrios",
        entityRef: "user:default/felipe",
        origin: "manual",
        linkedBy: "user:default/admin",
        linkedAt: NOW,
      });
    }
    await new ExcludeIdentity(store).exclude({
      source: "vcs",
      sourceKey: "dev@example.com",
      reason: "former-contributor",
      excludedBy: "user:default/admin",
      now: NOW,
    });

    // when
    const rows = await new ListIdentities(store, new StubDirectoryReader()).run({});

    // then
    const wakatime = rows.find((row) => row.identity.source === "wakatime");
    expect(wakatime?.exclusion?.reason).toBe("former-contributor");
    // Named as the account the decision was recorded on, so the screen knows
    // this row has nothing to undo.
    expect(wakatime?.exclusion?.source).toBe("vcs");
    expect(wakatime?.exclusion?.sourceKey).toBe("dev@example.com");
  });

  it("should leave an unlinked sibling account measured", async () => {
    // given
    // Two accounts nobody has joined are two people as far as anything here
    // knows, and excluding one must not take the other with it.
    const store = await seed([
      { source: "vcs", sourceKey: "build-service" },
      { source: "vcs", sourceKey: "dev@example.com" },
    ]);
    await new ExcludeIdentity(store).exclude({
      source: "vcs",
      sourceKey: "build-service",
      reason: "service-account",
      excludedBy: null,
      now: NOW,
    });

    // when
    const rows = await new ListIdentities(store, new StubDirectoryReader()).run({});

    // then
    expect(
      rows.find((row) => row.identity.sourceKey === "dev@example.com")?.exclusion,
    ).toBeNull();
  });

  it("should narrow the listing to the excluded accounts, and to the measured ones", async () => {
    // given
    const store = await seed([
      { source: "vcs", sourceKey: "build-service" },
      { source: "vcs", sourceKey: "dev@example.com" },
    ]);
    await new ExcludeIdentity(store).exclude({
      source: "vcs",
      sourceKey: "build-service",
      reason: "automated-bot",
      excludedBy: null,
      now: NOW,
    });
    const command = new ListIdentities(store, new StubDirectoryReader());

    // when
    const excluded = await command.run({ excluded: true });
    const measured = await command.run({ excluded: false });

    // then
    expect(excluded.map((row) => row.identity.sourceKey)).toEqual(["build-service"]);
    expect(measured.map((row) => row.identity.sourceKey)).toEqual(["dev@example.com"]);
  });
});

describe("Excluding an account from the measuring system", () => {
  it("should remove its contributor row entirely", async () => {
    // given
    const { store, repositoryId } = await withRepository(
      await seed([
        { source: "vcs", sourceKey: "build-service" },
        { source: "vcs", sourceKey: "dev@example.com" },
      ]),
    );
    await commit(store, repositoryId, [
      ...commitsBy(repositoryId, "build-service", 5),
      ...commitsBy(repositoryId, "dev@example.com", 2),
    ]);

    // when
    await new ExcludeIdentity(store).exclude({
      source: "vcs",
      sourceKey: "build-service",
      reason: "service-account",
      excludedBy: null,
      now: NOW,
    });

    // then
    // Not a zeroed row: a row of zeros is still a name on the table, and it
    // still takes part in the fleet reference every relative score is read
    // against.
    const rows = await new ListContributorSummaries({ store }).run(WINDOW);
    expect(rows.map((row) => row.key)).toEqual(["vcs:dev@example.com"]);
  });

  it("should stop it setting the fleet reference everybody is scored against", async () => {
    // given
    // An automation merging hundreds of pull requests a month is otherwise the
    // bar every human on the team is measured against.
    const { store, repositoryId } = await withRepository(
      await seed([
        { source: "vcs", sourceKey: "build-service" },
        { source: "vcs", sourceKey: "dev@example.com" },
      ]),
    );
    await commit(store, repositoryId, [
      ...commitsBy(repositoryId, "build-service", 20),
      ...commitsBy(repositoryId, "dev@example.com", 5),
    ]);
    const trend = new GetContributorTrend({ store });
    const before = await trend.run({
      key: "vcs:dev@example.com",
      ...WINDOW,
      bucket: "day",
    });

    // when
    await new ExcludeIdentity(store).exclude({
      source: "vcs",
      sourceKey: "build-service",
      reason: "automated-bot",
      excludedBy: null,
      now: NOW,
    });

    // then
    const after = await trend.run({ key: "vcs:dev@example.com", ...WINDOW, bucket: "day" });
    expect(after.score?.value ?? 0).toBeGreaterThan(before.score?.value ?? 0);
  });

  it("should take its coding time with it when the accounts are linked", async () => {
    // given
    const { store, repositoryId } = await withRepository(
      await seed([
        { source: "vcs", sourceKey: "dev@example.com" },
        { source: "wakatime", sourceKey: "jrios" },
      ]),
    );
    await commit(store, repositoryId, commitsBy(repositoryId, "dev@example.com", 3));
    for (const [source, sourceKey] of [
      ["vcs", "dev@example.com"],
      ["wakatime", "jrios"],
    ] as const) {
      await store.saveIdentityLink({
        source,
        sourceKey,
        entityRef: "user:default/felipe",
        origin: "manual",
        linkedBy: "user:default/admin",
        linkedAt: NOW,
      });
    }
    await store.saveContributorMetrics({
      source: "wakatime",
      day: "2026-08-09",
      capturedAt: NOW,
      metrics: new Map([
        ["jrios", WakaTimeMetricsBuilder.aDay("2026-08-09").withSeconds(7200).build()],
      ]),
    });

    // when
    await new ExcludeIdentity(store).exclude({
      source: "wakatime",
      sourceKey: "jrios",
      reason: "former-contributor",
      excludedBy: null,
      now: NOW,
    });

    // then
    // The commits go too: they are the same person's work, and half a row is
    // worse than no row.
    const rows = await new ListContributorSummaries({ store }).run(WINDOW);
    expect(rows).toEqual([]);
  });

  it("should stop counting towards a repository's people and its counters", async () => {
    // given
    // A repository's contributor count is a count of people, and a build
    // service inflating it is the reading somebody would act on.
    const { store, repositoryId } = await withRepository(
      await seed([
        { source: "vcs", sourceKey: "build-service" },
        { source: "vcs", sourceKey: "dev@example.com" },
      ]),
    );
    await commit(store, repositoryId, [
      ...commitsBy(repositoryId, "build-service", 4),
      ...commitsBy(repositoryId, "dev@example.com", 1),
    ]);

    // when
    await new ExcludeIdentity(store).exclude({
      source: "vcs",
      sourceKey: "build-service",
      reason: "service-account",
      excludedBy: null,
      now: NOW,
    });

    // then
    const [repository] = await new ListRepositorySummaries(store).run(WINDOW);
    expect(repository?.activity.contributors).toBe(1);
    expect(repository?.activity.commits).toBe(1);
  });

  it("should stop counting towards the fleet cadence", async () => {
    // given
    // Delivery cadence is a statement about what the team shipped, and a build
    // service merging its own work all weekend is not part of it.
    const { store, repositoryId } = await withRepository(
      await seed([{ source: "vcs", sourceKey: "build-service" }]),
    );
    await commit(store, repositoryId, commitsBy(repositoryId, "build-service", 3));

    // when
    await new ExcludeIdentity(store).exclude({
      source: "vcs",
      sourceKey: "build-service",
      reason: "service-account",
      excludedBy: null,
      now: NOW,
    });

    // then
    const points = await new GetRepositoryTimeSeries(store).run({ ...WINDOW, bucket: "day" });
    expect(points.reduce((total, point) => total + point.activity.commits, 0)).toBe(0);
  });

  it("should keep the pipeline runs an excluded account triggered", async () => {
    // given
    // A build is a fact about the repository's machinery that happens to carry
    // whoever triggered it. Dropping it would do at read time exactly what this
    // feature refuses to do at collection time.
    const { store, repositoryId } = await withRepository(
      await seed([{ source: "vcs", sourceKey: "build-service" }]),
    );
    await commit(store, repositoryId, [
      ...buildsBy(repositoryId, "build-service", ["succeeded", "succeeded", "failed"]),
    ]);

    // when
    await new ExcludeIdentity(store).exclude({
      source: "vcs",
      sourceKey: "build-service",
      reason: "service-account",
      excludedBy: null,
      now: NOW,
    });

    // then
    const [repository] = await new ListRepositorySummaries(store).run(WINDOW);
    expect(repository?.activity.builds).toBe(3);
    expect(repository?.activity.buildsSucceeded).toBe(2);
    expect(repository?.activity.buildsFailed).toBe(1);
    // And nobody is credited for them: a contributor count is a count of people.
    expect(repository?.activity.contributors).toBe(0);
  });

  it("should keep the repository health build component measured", async () => {
    // given
    // `buildSuccessRate` carries a tenth of the repository health weight, and
    // `combineScore` redistributes anything unmeasured — so zeroing the runs
    // would silently reweight every repository whose pipelines are scheduled,
    // release or deployment runs, fleet-wide.
    const { store, repositoryId } = await withRepository(
      await seed([{ source: "vcs", sourceKey: "build-service" }]),
    );
    await commit(store, repositoryId, buildsBy(repositoryId, "build-service", ["succeeded"]));

    // when
    await new ExcludeIdentity(store).exclude({
      source: "vcs",
      sourceKey: "build-service",
      reason: "service-account",
      excludedBy: null,
      now: NOW,
    });

    // then
    const [repository] = await new ListRepositorySummaries(store).run(WINDOW);
    const component = computeRepositoryHealthScore(repository!).components.find(
      (candidate) => candidate.id === "buildSuccessRate",
    );
    expect(component?.normalized).toBe(1);
  });

  it("should still keep the pipeline runs off the excluded account's own row", async () => {
    // given
    // Kept for the repository is not the same as credited to somebody.
    const { store, repositoryId } = await withRepository(
      await seed([{ source: "vcs", sourceKey: "build-service" }]),
    );
    await commit(store, repositoryId, buildsBy(repositoryId, "build-service", ["succeeded"]));

    // when
    await new ExcludeIdentity(store).exclude({
      source: "vcs",
      sourceKey: "build-service",
      reason: "service-account",
      excludedBy: null,
      now: NOW,
    });

    // then
    expect(await new ListContributorSummaries({ store }).run(WINDOW)).toEqual([]);
  });

  it("should take an excluded person's coding time off the repository row", async () => {
    // given
    // Otherwise the two tabs disagree about the same hours: gone from the
    // person's contributor row, still on the repository's.
    const { store, repositoryId } = await withRepository(
      await seed([{ source: "wakatime", sourceKey: "jrios" }]),
    );
    await store.saveContributorMetrics({
      source: "wakatime",
      day: "2026-08-09",
      capturedAt: NOW,
      metrics: new Map([
        [
          "jrios",
          WakaTimeMetricsBuilder.aDay("2026-08-09")
            .withSeconds(7200)
            .withProject("gateway", 7200)
            .build(),
        ],
      ]),
    });

    // when
    await new ExcludeIdentity(store).exclude({
      source: "wakatime",
      sourceKey: "jrios",
      reason: "former-contributor",
      excludedBy: null,
      now: NOW,
    });

    // then
    const [repository] = await new ListRepositorySummaries(store).run(WINDOW);
    expect(repository?.wakaTimeMetrics).toBeNull();

    // and the repository's own trend agrees with its row
    const trend = await new GetRepositoryTrend(store).run({
      repositoryId,
      ...WINDOW,
      bucket: "day",
    });
    expect(trend.summary.wakaTimeMetrics).toBeNull();
  });

  it("should restore every window already collected when the account is measured again", async () => {
    // given
    // Nothing was deleted; the exclusion is applied when the row is built, so
    // including it again is retroactive rather than starting from today.
    const { store, repositoryId } = await withRepository(
      await seed([{ source: "vcs", sourceKey: "build-service" }]),
    );
    await commit(store, repositoryId, commitsBy(repositoryId, "build-service", 3));
    const command = new ExcludeIdentity(store);
    await command.exclude({
      source: "vcs",
      sourceKey: "build-service",
      reason: "automated-bot",
      excludedBy: null,
      now: NOW,
    });

    // when
    await command.include({ source: "vcs", sourceKey: "build-service" });

    // then
    const rows = await new ListContributorSummaries({ store }).run(WINDOW);
    expect(rows[0]?.commits).toBe(3);
  });
});
