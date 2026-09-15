import { GetRepositoryTimeSeries } from "../../../src/domain/commands/get_repository_time_series";
import { ListContributorSummaries } from "../../../src/domain/commands/list_contributor_summaries";
import { ListRepositorySummaries } from "../../../src/domain/commands/list_repository_summaries";
import type { RepositorySnapshotPayload } from "../../../src/domain/entities/repository_snapshot";
import {
  aConfluenceContributorMetrics,
  aJiraContributorMetrics,
} from "../../builders/atlassian_contributor_metrics_builder";
import { DiscoveredRepositoryBuilder } from "../../builders/discovered_repository_builder";
import { EventBuilder } from "../../builders/event_builder";
import { WakaTimeMetricsBuilder } from "../../builders/wakatime_metrics_builder";
import { InMemoryCodeHealthStore } from "../../doubles/in_memory_code_health_store";
import { StubCatalogReader } from "../../doubles/stub_catalog_reader";
import { StubDirectoryReader } from "../../doubles/stub_directory_reader";

const NOW = new Date("2026-08-10T12:00:00.000Z");
const WINDOW = {
  from: new Date("2026-08-09T00:00:00.000Z"),
  to: new Date("2026-08-11T00:00:00.000Z"),
};

const aSnapshotPayload = (
  overrides: Partial<RepositorySnapshotPayload> = {},
): RepositorySnapshotPayload => ({
  description: "the gateway",
  primaryLanguage: "Go",
  visibility: "PUBLIC",
  isArchived: false,
  isFork: false,
  defaultBranch: "main",
  updatedAt: "2026-08-10T02:00:00.000Z",
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
      .withEntityRef(`component:default/repo-${index}`)
      .withName(`repo-${index}`)
      .build(),
  );
  await store.syncRepositories({ discovered, retentionDays: 365, now: NOW });
  return { store, discovered };
};

const commit = (repositoryId: string, at: string, actor = "dev@example.com") =>
  EventBuilder.commit().withRepository(repositoryId).withActor(actor).at(at).withChurn(10, 2, 1);

describe("ListRepositorySummaries owner profiles", () => {
  it("should resolve each owner to the name and photograph the catalog holds", async () => {
    // given
    const { store, discovered } = await seed(1);
    const [repository] = discovered;
    await store.syncRepositories({
      discovered: [{ ...repository!, catalogFacts: { ...repository!.catalogFacts, ownerRef: "group:default/platform" } }],
      retentionDays: 365,
      now: NOW,
    });
    const catalog = new StubCatalogReader().withProfiles({
      "group:default/platform": { displayName: "Platform", picture: "https://example.com/p.png" },
    });

    // when
    const [summary] = await new ListRepositorySummaries(store, catalog).run(WINDOW);

    // then
    expect(summary?.ownerProfile).toEqual({
      entityRef: "group:default/platform",
      displayName: "Platform",
      picture: "https://example.com/p.png",
    });
  });

  it("should ask once for the distinct owners rather than once per row", async () => {
    // given
    // Two hundred repositories in an organisation share a handful of teams, and
    // a lookup per row would be two hundred catalog queries per dashboard load.
    const { store, discovered } = await seed(3);
    await store.syncRepositories({
      discovered: discovered.map((repository) => ({
        ...repository,
        catalogFacts: { ...repository.catalogFacts, ownerRef: "group:default/platform" },
      })),
      retentionDays: 365,
      now: NOW,
    });
    const catalog = new StubCatalogReader().withProfiles({
      "group:default/platform": { displayName: "Platform" },
    });

    // when
    await new ListRepositorySummaries(store, catalog).run(WINDOW);

    // then
    expect(catalog.profileLookups).toHaveLength(1);
    expect(catalog.profileLookups[0]).toEqual(["group:default/platform"]);
  });

  it("should leave the profile null for an owner the catalog no longer holds", async () => {
    // given
    // A person who has left is a row with no photograph, not a failed request.
    const { store, discovered } = await seed(1);
    const [repository] = discovered;
    await store.syncRepositories({
      discovered: [{ ...repository!, catalogFacts: { ...repository!.catalogFacts, ownerRef: "user:default/ghost" } }],
      retentionDays: 365,
      now: NOW,
    });

    // when
    const [summary] = await new ListRepositorySummaries(store, new StubCatalogReader()).run(
      WINDOW,
    );

    // then
    expect(summary?.ownerRef).toBe("user:default/ghost");
    expect(summary?.ownerProfile).toBeNull();
  });

  it("should render slugs rather than failing when the catalog is unreachable", async () => {
    // given
    // Every other field on these rows came out of this plugin's own database
    // and is already in hand; refusing to render two hundred repositories
    // because a decoration could not be fetched trades a complete answer for
    // no answer.
    const { store, discovered } = await seed(1);
    const [repository] = discovered;
    await store.syncRepositories({
      discovered: [{ ...repository!, catalogFacts: { ...repository!.catalogFacts, ownerRef: "group:default/platform" } }],
      retentionDays: 365,
      now: NOW,
    });
    const catalog = new StubCatalogReader().withFailure(new Error("catalog is down"));

    // when
    const [summary] = await new ListRepositorySummaries(store, catalog).run(WINDOW);

    // then
    expect(summary?.ownerRef).toBe("group:default/platform");
    expect(summary?.ownerProfile).toBeNull();
  });

  it("should render slugs rather than failing when no catalog is wired in", async () => {
    // given
    const { store } = await seed(1);

    // when
    const [summary] = await new ListRepositorySummaries(store).run(WINDOW);

    // then
    expect(summary?.ownerProfile).toBeNull();
  });
});

describe("ListRepositorySummaries", () => {
  it("should read a snapshot written before the integration fields existed", async () => {
    // given
    // The store parses stored JSON with a cast rather than a validation, so an
    // older payload simply has no key. Left undefined it survives every
    // `=== null` guard downstream and reaches code that dereferences it — and
    // any range predating the upgrade reproduces that, not just the first load.
    const { store, discovered } = await seed();
    const [repository] = discovered;
    const { jiraMetrics, confluenceMetrics, ...older } = aSnapshotPayload();
    await store.saveSnapshot({
      repositoryId: repository!.id,
      day: "2026-08-10",
      capturedAt: NOW,
      payload: older as typeof older & {
        jiraMetrics: null;
        confluenceMetrics: null;
      },
    });

    // when
    const [summary] = await new ListRepositorySummaries(store).run(WINDOW);

    // then
    expect(summary?.jiraMetrics).toBeNull();
    expect(summary?.confluenceMetrics).toBeNull();
  });

  it("should render a repository with the counters from its window", async () => {
    // given
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await store.commitIngestion({
      repositoryId: repository.id,
      events: [
        commit(repository.id, "2026-08-09T10:00:00.000Z").build(),
        commit(repository.id, "2026-08-10T10:00:00.000Z").build(),
      ],
      chunk: { repositoryId: repository.id, kinds: ["commit"], days: [], ingestedAt: NOW },
      status: "active",
      now: NOW,
    });

    // when
    const [summary] = await new ListRepositorySummaries(store).run(WINDOW);

    // then
    expect(summary.activity.commits).toBe(2);
    expect(summary.activity.additions).toBe(20);
    expect(summary.name).toBe("repo-0");
  });

  it("should render a repository that has no snapshot yet", async () => {
    // given
    // Ingestion runs every few minutes and the snapshot task runs daily, so a
    // freshly discovered repository has activity before it has state. Hiding it
    // would make the dashboard look as though discovery had not worked.
    const { store } = await seed();

    // when
    const [summary] = await new ListRepositorySummaries(store).run(WINDOW);

    // then
    expect(summary.complianceStatus).toBeNull();
    expect(summary.activity.commits).toBe(0);
  });

  it("should use the snapshot as it was at the end of the window", async () => {
    // given
    // Asking about a past period has to render the repository as it was then;
    // showing today's state against last month's numbers would be a lie the
    // user has no way to notice.
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await store.saveSnapshot({
      repositoryId: repository.id,
      day: "2026-08-09",
      capturedAt: NOW,
      payload: aSnapshotPayload({ primaryLanguage: "Go" }),
    });
    await store.saveSnapshot({
      repositoryId: repository.id,
      day: "2026-08-20",
      capturedAt: NOW,
      payload: aSnapshotPayload({ primaryLanguage: "Rust" }),
    });

    // when
    const [summary] = await new ListRepositorySummaries(store).run(WINDOW);

    // then
    expect(summary.primaryLanguage).toBe("Go");
  });

  it("should sum the coding time its people logged against the matching project", async () => {
    // given
    // WakaTime measures a person and a *project*; a repository's coding time is
    // the sum of what its people logged against the project whose name matches,
    // which is a question about a window rather than about a snapshot's day.
    const { store } = await seed();
    for (const [day, seconds] of [
      ["2026-08-09", 3600],
      ["2026-08-10", 1800],
    ] as const) {
      await store.saveContributorMetrics({
        source: "wakatime",
        day,
        capturedAt: NOW,
        metrics: new Map([
          [
            "jrios",
            WakaTimeMetricsBuilder.aDay(day)
              .withSeconds(seconds)
              .withProject("Repo_0", seconds)
              .build(),
          ],
        ]),
      });
    }

    // when
    const [summary] = await new ListRepositorySummaries(store).run(WINDOW);

    // then
    // `Repo_0` and `repo-0` are the same project: WakaTime spells it however
    // the editor plugin derived it from a working directory, and the catalog
    // spells it however somebody named the entity.
    expect(summary.wakaTimeMetrics).toMatchObject({
      projectName: "Repo_0",
      totalSeconds: 5400,
      contributors: 1,
      daily: [
        { day: "2026-08-09", totalSeconds: 3600 },
        { day: "2026-08-10", totalSeconds: 1800 },
      ],
    });
  });

  it("should not count somebody with a seat and a quiet week as a contributor", async () => {
    // given
    // A member who logged nothing against the project did not work on it.
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await store.saveContributorMetrics({
      source: "wakatime",
      day: "2026-08-09",
      capturedAt: NOW,
      metrics: new Map([
        [
          "quiet",
          WakaTimeMetricsBuilder.aDay("2026-08-09").withProject("repo-0", 0).build(),
        ],
        [
          "busy",
          WakaTimeMetricsBuilder.aDay("2026-08-09")
            .withSeconds(600)
            .withProject("repo-0", 600)
            .build(),
        ],
      ]),
    });

    // when
    const [summary] = await new ListRepositorySummaries(store).run(WINDOW);

    // then
    expect(summary.wakaTimeMetrics?.contributors).toBe(1);
    expect(summary.wakaTimeMetrics?.totalSeconds).toBe(600);
    expect(repository.name).toBe("repo-0");
  });

  it("should report no coding time when nothing matched the repository", async () => {
    // given
    // Null rather than zero: "nobody here has WakaTime installed" and "the
    // project is called something else" are different problems, and a zero
    // would hide both behind the same cell.
    const { store } = await seed();
    await store.saveContributorMetrics({
      source: "wakatime",
      day: "2026-08-09",
      capturedAt: NOW,
      metrics: new Map([
        [
          "jrios",
          WakaTimeMetricsBuilder.aDay("2026-08-09")
            .withSeconds(3600)
            .withProject("something-else", 3600)
            .build(),
        ],
      ]),
    });

    // when
    const [summary] = await new ListRepositorySummaries(store).run(WINDOW);

    // then
    expect(summary.wakaTimeMetrics).toBeNull();
  });

  it("should follow the annotation when the entity names its WakaTime project", async () => {
    // given
    const store = new InMemoryCodeHealthStore();
    await store.syncRepositories({
      discovered: [
        DiscoveredRepositoryBuilder.create()
          .withName("gateway")
          .withCatalogFacts({ wakaTimeProject: "acme-gateway" })
          .build(),
      ],
      retentionDays: 365,
      now: NOW,
    });
    await store.saveContributorMetrics({
      source: "wakatime",
      day: "2026-08-09",
      capturedAt: NOW,
      metrics: new Map([
        [
          "jrios",
          WakaTimeMetricsBuilder.aDay("2026-08-09")
            .withSeconds(120)
            .withProject("acme-gateway", 120)
            .build(),
        ],
      ]),
    });

    // when
    const [summary] = await new ListRepositorySummaries(store).run(WINDOW);

    // then
    expect(summary.wakaTimeMetrics?.totalSeconds).toBe(120);
  });

  it("should keep each repository's events to itself", async () => {
    // given
    const { store, discovered } = await seed(2);
    await store.commitIngestion({
      repositoryId: discovered[0].id,
      events: [commit(discovered[0].id, "2026-08-09T10:00:00.000Z").build()],
      chunk: { repositoryId: discovered[0].id, kinds: ["commit"], days: [], ingestedAt: NOW },
      status: "active",
      now: NOW,
    });

    // when
    const summaries = await new ListRepositorySummaries(store).run(WINDOW);

    // then
    const byName = new Map(summaries.map((summary) => [summary.name, summary]));
    expect(byName.get("repo-0")?.activity.commits).toBe(1);
    expect(byName.get("repo-1")?.activity.commits).toBe(0);
  });

  it("should render the full name with the project level on Azure DevOps", async () => {
    // given
    const store = new InMemoryCodeHealthStore();
    await store.syncRepositories({
      discovered: [
        DiscoveredRepositoryBuilder.create()
          .withName("gateway")
          .asAzureDevOps("example-org", "platform")
          .build(),
      ],
      retentionDays: 365,
      now: NOW,
    });

    // when
    const [summary] = await new ListRepositorySummaries(store).run(WINDOW);

    // then
    expect(summary.fullName).toBe("example-org/platform/gateway");
  });
});

describe("ListContributorSummaries", () => {
  it("should group a window's events by contributor", async () => {
    // given
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await store.commitIngestion({
      repositoryId: repository.id,
      events: [
        commit(repository.id, "2026-08-09T10:00:00.000Z", "dev@example.com").build(),
        commit(repository.id, "2026-08-09T11:00:00.000Z", "dev@example.com").build(),
        commit(repository.id, "2026-08-09T12:00:00.000Z", "other@example.com").build(),
      ],
      chunk: { repositoryId: repository.id, kinds: ["commit"], days: [], ingestedAt: NOW },
      status: "active",
      now: NOW,
    });

    // when
    const contributors = await new ListContributorSummaries({ store }).run(WINDOW);

    // then
    expect(contributors).toHaveLength(2);
    // The key is the account, source-qualified: a row is a person, and an
    // account nobody has linked is a person of one account.
    expect(contributors[0]).toMatchObject({ key: "vcs:dev@example.com", commits: 2 });
  });

  it("should aggregate the Sonar metrics of the repositories a contributor touched", async () => {
    // given
    // Sonar measures projects, not people, so a contributor row can only report
    // the health of the code they worked on. One contributor, two repositories.
    const { store, discovered } = await seed(2);
    const metrics = [
      { bugs: 3, codeSmells: 10, securityHotspots: 1, vulnerabilities: 2, coverage: 80, duplications: 2, technicalDebt: "1h", technicalDebtMinutes: 60, qualityGateStatus: "OK" as const },
      { bugs: 4, codeSmells: 5, securityHotspots: 2, vulnerabilities: 0, coverage: 60, duplications: 4, technicalDebt: "2h", technicalDebtMinutes: 120, qualityGateStatus: "ERROR" as const },
    ];
    for (const [index, repository] of discovered.entries()) {
      await store.saveSnapshot({
        repositoryId: repository.id,
        day: "2026-08-10",
        capturedAt: NOW,
        payload: aSnapshotPayload({ sonarMetrics: metrics[index] }),
      });
      await store.commitIngestion({
        repositoryId: repository.id,
        events: [commit(repository.id, "2026-08-09T10:00:00.000Z").build()],
        chunk: { repositoryId: repository.id, kinds: ["commit"], days: [], ingestedAt: NOW },
        status: "active",
        now: NOW,
      });
    }

    // when
    const [contributor] = await new ListContributorSummaries({ store }).run(WINDOW);

    // then
    expect(contributor?.sonarMetrics).toEqual({
      // counts sum: someone spanning two repositories carries both
      bugs: 7,
      codeSmells: 15,
      securityHotspots: 3,
      vulnerabilities: 2,
      // percentages average: adding two coverage figures is meaningless
      coverage: 70,
      duplications: 3,
      // debt sums, which is why the raw minutes travel with the formatted string
      technicalDebt: "3h",
      technicalDebtMinutes: 180,
      // worst wins, so one failing repository stays visible
      qualityGateStatus: "ERROR",
    });
  });

  it("should not carry the Sonar metrics of a repository somebody only reviewed or built in", async () => {
    // given
    // Sonar measures a project. Reviewing its pull requests or triggering its
    // pipeline does not put a hand on its code, and counting either put every
    // repository's bugs on the row of whoever reviews the most.
    const { store, discovered } = await seed(2);
    const [committed, reviewed] = discovered;
    const metrics = (bugs: number) => ({
      bugs,
      codeSmells: 0,
      securityHotspots: 0,
      vulnerabilities: 0,
      coverage: 50,
      duplications: 0,
      technicalDebt: "1h",
      technicalDebtMinutes: 60,
      qualityGateStatus: "OK" as const,
    });
    for (const [repository, bugs] of [
      [committed, 3],
      [reviewed, 40],
    ] as const) {
      await store.saveSnapshot({
        repositoryId: repository.id,
        day: "2026-08-10",
        capturedAt: NOW,
        payload: aSnapshotPayload({ sonarMetrics: metrics(bugs) }),
      });
    }
    await store.commitIngestion({
      repositoryId: committed.id,
      events: [commit(committed.id, "2026-08-09T10:00:00.000Z").build()],
      chunk: { repositoryId: committed.id, kinds: ["commit"], days: [], ingestedAt: NOW },
      status: "active",
      now: NOW,
    });
    await store.commitIngestion({
      repositoryId: reviewed.id,
      events: [
        EventBuilder.review("approved").withRepository(reviewed.id).withActor("dev@example.com").at("2026-08-09T11:00:00.000Z").build(),
        EventBuilder.build("succeeded").withRepository(reviewed.id).withActor("dev@example.com").at("2026-08-09T12:00:00.000Z").build(),
      ],
      chunk: { repositoryId: reviewed.id, kinds: ["pr_review", "build"], days: [], ingestedAt: NOW },
      status: "active",
      now: NOW,
    });

    // when
    const [contributor] = await new ListContributorSummaries({ store }).run(WINDOW);

    // then
    expect(contributor?.sonarMetrics?.bugs).toBe(3);
    // The review and the run still make it a repository the person was active in.
    expect(contributor?.repositories).toBe(2);
  });

  it("should carry the Sonar metrics of a repository somebody merged a pull request into", async () => {
    // given
    // A merged pull request is code landing, whether or not its commits fell
    // inside the window.
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await store.saveSnapshot({
      repositoryId: repository.id,
      day: "2026-08-10",
      capturedAt: NOW,
      payload: aSnapshotPayload({
        sonarMetrics: {
          bugs: 5,
          codeSmells: 0,
          securityHotspots: 0,
          vulnerabilities: 0,
          coverage: 50,
          duplications: 0,
          technicalDebt: "1h",
          technicalDebtMinutes: 60,
          qualityGateStatus: "OK",
        },
      }),
    });
    await store.commitIngestion({
      repositoryId: repository.id,
      events: [
        EventBuilder.pullRequest("merged").withRepository(repository.id).withActor("dev@example.com").at("2026-08-09T11:00:00.000Z").build(),
      ],
      chunk: { repositoryId: repository.id, kinds: ["pull_request"], days: [], ingestedAt: NOW },
      status: "active",
      now: NOW,
    });

    // when
    const [contributor] = await new ListContributorSummaries({ store }).run(WINDOW);

    // then
    expect(contributor?.sonarMetrics?.bugs).toBe(5);
  });

  it("should report no Sonar metrics when the contributor's repositories have none", async () => {
    // given
    // The annotation is optional, so most repositories have no Sonar project and
    // a row of zeroes would read as a clean bill of health rather than no data.
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await store.saveSnapshot({
      repositoryId: repository.id,
      day: "2026-08-10",
      capturedAt: NOW,
      payload: aSnapshotPayload({ sonarMetrics: null }),
    });
    await store.commitIngestion({
      repositoryId: repository.id,
      events: [commit(repository.id, "2026-08-09T10:00:00.000Z").build()],
      chunk: { repositoryId: repository.id, kinds: ["commit"], days: [], ingestedAt: NOW },
      status: "active",
      now: NOW,
    });

    // when
    const [contributor] = await new ListContributorSummaries({ store }).run(WINDOW);

    // then
    expect(contributor?.sonarMetrics).toBeNull();
  });

  it("should show the catalog's name and photo for a linked account", async () => {
    // given
    // The catalog is the organisation's record of who someone is, so its display
    // name and picture win over whatever the provider attached to the commit.
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await store.commitIngestion({
      repositoryId: repository.id,
      events: [commit(repository.id, "2026-08-09T10:00:00.000Z", "Dev@Example.com").build()],
      chunk: { repositoryId: repository.id, kinds: ["commit"], days: [], ingestedAt: NOW },
      status: "active",
      now: NOW,
    });
    await store.saveIdentityLink({
      source: "vcs",
      sourceKey: "dev@example.com",
      entityRef: "user:default/dev_example.com",
      origin: "catalog-email",
      linkedBy: null,
      linkedAt: NOW,
    });
    const directory = new StubDirectoryReader([
      {
        entityRef: "user:default/dev_example.com",
        displayName: "Dev Eloper",
        email: "dev@example.com",
        picture: "https://example.com/dev.png",
      },
    ]);

    // when
    const [contributor] = await new ListContributorSummaries({ store, directory }).run(WINDOW);

    // then
    expect(contributor).toMatchObject({
      key: "user:default/dev_example.com",
      entityRef: "user:default/dev_example.com",
      displayName: "Dev Eloper",
      avatarUrl: "https://example.com/dev.png",
    });
  });

  it("should merge two accounts linked to one person onto a single row", async () => {
    // given
    // The whole reason a row is a person rather than an account: commits arrive
    // under one address and coding time under a WakaTime username, and keyed by
    // account the same human occupies two rows holding half the story each.
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await store.commitIngestion({
      repositoryId: repository.id,
      events: [commit(repository.id, "2026-08-09T10:00:00.000Z", "dev@example.com").build()],
      chunk: { repositoryId: repository.id, kinds: ["commit"], days: [], ingestedAt: NOW },
      status: "active",
      now: NOW,
    });
    await store.saveContributorMetrics({
      source: "wakatime",
      day: "2026-08-09",
      capturedAt: NOW,
      metrics: new Map([
        ["jrios", WakaTimeMetricsBuilder.aDay("2026-08-09").withSeconds(7200).build()],
      ]),
    });
    for (const identity of [
      { source: "vcs" as const, sourceKey: "dev@example.com" },
      { source: "wakatime" as const, sourceKey: "jrios" },
    ]) {
      await store.saveIdentityLink({
        ...identity,
        entityRef: "user:default/dev",
        origin: "manual",
        linkedBy: "user:default/admin",
        linkedAt: NOW,
      });
    }

    // when
    const contributors = await new ListContributorSummaries({ store }).run(WINDOW);

    // then
    expect(contributors).toHaveLength(1);
    expect(contributors[0]?.commits).toBe(1);
    expect(contributors[0]?.wakaTimeMetrics?.totalSeconds).toBe(7200);
    expect(contributors[0]?.identities.map((identity) => identity.source).sort()).toEqual([
      "vcs",
      "wakatime",
    ]);
  });

  it("should not invent a row from coding time when the call is scoped to a repository", async () => {
    // given
    // Coding time is measured per person across everything they touched, not
    // per repository, so a scoped call would otherwise list people who have
    // never been near it.
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await store.commitIngestion({
      repositoryId: repository!.id,
      events: [commit(repository!.id, "2026-08-09T10:00:00.000Z", "dev@example.com").build()],
      chunk: { repositoryId: repository!.id, kinds: ["commit"], days: [], ingestedAt: NOW },
      status: "active",
      now: NOW,
    });
    await store.saveContributorMetrics({
      source: "wakatime",
      day: "2026-08-09",
      capturedAt: NOW,
      metrics: new Map([
        ["elsewhere", WakaTimeMetricsBuilder.aDay("2026-08-09").withSeconds(3600).build()],
      ]),
    });

    // when
    const scoped = await new ListContributorSummaries({ store }).run({
      ...WINDOW,
      repositoryId: repository!.id,
    });

    // then
    expect(scoped.map((row) => row.key)).toEqual(["vcs:dev@example.com"]);

    // when
    // Unscoped, the same person is a row of their own — a week in an editor
    // without a commit is worth seeing.
    const unscoped = await new ListContributorSummaries({ store }).run(WINDOW);

    // then
    expect(unscoped.map((row) => row.key).sort()).toEqual([
      "vcs:dev@example.com",
      "wakatime:elsewhere",
    ]);
  });

  it("should give somebody with coding time and no commits a row of their own", async () => {
    // given
    // A week spent in an editor without a single commit is worth seeing, and a
    // row that only appears once code lands cannot show it.
    const { store } = await seed();
    await store.saveContributorMetrics({
      source: "wakatime",
      day: "2026-08-09",
      capturedAt: NOW,
      metrics: new Map([
        ["quiet", WakaTimeMetricsBuilder.aDay("2026-08-09").withSeconds(3600).build()],
      ]),
    });

    // when
    const [contributor] = await new ListContributorSummaries({ store }).run(WINDOW);

    // then
    expect(contributor?.key).toBe("wakatime:quiet");
    // And the name falls back to the account key, source and all, so a reader
    // knows which system to go and look in.
    expect(contributor?.displayName).toBe("wakatime:quiet");
    expect(contributor?.commits).toBe(0);
    expect(contributor?.wakaTimeMetrics?.totalSeconds).toBe(3600);
    expect(contributor?.churnUnit).toBe("none");
  });

  it("should merge a person's Jira days across the window", async () => {
    // given
    // Jira is stored a day at a time precisely so a window can be answered
    // honestly rather than by repeating a trailing figure.
    const { store } = await seed();
    for (const [day, created] of [
      ["2026-08-09", 2],
      ["2026-08-10", 3],
    ] as const) {
      await store.saveContributorMetrics({
        source: "jira",
        day,
        capturedAt: NOW,
        metrics: new Map([
          ["557058:abc", aJiraContributorMetrics({ issuesCreated: created })],
        ]),
      });
    }

    // when
    const [contributor] = await new ListContributorSummaries({ store }).run(WINDOW);

    // then
    expect(contributor?.key).toBe("jira:557058:abc");
    expect(contributor?.jiraMetrics?.issuesCreated).toBe(5);
  });

  it("should carry a person's Confluence row from the window's end", async () => {
    // given
    // Confluence's figures describe a trailing window rather than a day, so the
    // row is the most recent one at or before the window's last day.
    const { store } = await seed();
    await store.saveContributorMetrics({
      source: "confluence",
      day: "2026-08-10",
      capturedAt: NOW,
      metrics: new Map([
        ["557058:abc", aConfluenceContributorMetrics({ pagesCreated: 4 })],
      ]),
    });

    // when
    const [contributor] = await new ListContributorSummaries({ store }).run(WINDOW);

    // then
    expect(contributor?.key).toBe("confluence:557058:abc");
    expect(contributor?.confluenceMetrics?.pagesCreated).toBe(4);
  });

  it("should fold two linked Confluence accounts onto one row", async () => {
    // given
    // One human with two Atlassian logins is one contributor, and the figures
    // add up only once the link table has resolved both to the same person.
    const { store } = await seed();
    for (const sourceKey of ["557058:one", "557058:two"]) {
      await store.recordObservedIdentities({
        identities: [
          {
            source: "confluence",
            sourceKey,
            displayName: "Jane Doe",
            email: null,
            avatarUrl: null,
            profileUrl: null,
          },
        ],
        now: NOW,
      });
      await store.saveIdentityLink({
        source: "confluence",
        sourceKey,
        entityRef: "user:default/jane",
        origin: "manual",
        linkedBy: "user:default/admin",
        linkedAt: NOW,
      });
    }
    await store.saveContributorMetrics({
      source: "confluence",
      day: "2026-08-10",
      capturedAt: NOW,
      metrics: new Map([
        ["557058:one", aConfluenceContributorMetrics({ pagesCreated: 1 })],
        ["557058:two", aConfluenceContributorMetrics({ pagesCreated: 2 })],
      ]),
    });

    // when
    const [contributor] = await new ListContributorSummaries({ store }).run(WINDOW);

    // then
    expect(contributor?.key).toBe("user:default/jane");
    expect(contributor?.confluenceMetrics?.pagesCreated).toBe(3);
  });

  it("should not invent a row from a ticket when the call is scoped to a repository", async () => {
    // given
    // Tickets and pages are measured for a person across everything they
    // touched, not per repository, so scoped they would otherwise add people
    // who have never been near it.
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await store.saveContributorMetrics({
      source: "jira",
      day: "2026-08-09",
      capturedAt: NOW,
      metrics: new Map([["557058:abc", aJiraContributorMetrics({ issuesCreated: 2 })]]),
    });
    await store.saveContributorMetrics({
      source: "confluence",
      day: "2026-08-10",
      capturedAt: NOW,
      metrics: new Map([["557058:xyz", aConfluenceContributorMetrics({ pagesCreated: 1 })]]),
    });

    // when
    const scoped = await new ListContributorSummaries({ store }).run({
      ...WINDOW,
      repositoryId: repository.id,
    });

    // then
    expect(scoped).toEqual([]);
  });

  it("should leave an account nobody has linked on a row of its own", async () => {
    // given
    // Bots, service accounts and commits from a personal address have no entity.
    // Hiding them would hide exactly the rows that show the linking still needs
    // doing, and guessing one by display name would merge two different people.
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await store.commitIngestion({
      repositoryId: repository.id,
      events: [commit(repository.id, "2026-08-09T10:00:00.000Z", "bot@ci.local").build()],
      chunk: { repositoryId: repository.id, kinds: ["commit"], days: [], ingestedAt: NOW },
      status: "active",
      now: NOW,
    });

    // when
    const [contributor] = await new ListContributorSummaries({
      store,
      directory: new StubDirectoryReader(),
    }).run(WINDOW);

    // then
    expect(contributor?.entityRef).toBeNull();
    expect(contributor?.key).toBe("vcs:bot@ci.local");
    // The display name falls back to what the provider reported on the commit,
    // which is the only name available for an identity nothing else knows.
    expect(contributor?.displayName).toBe("Dev Example");
  });

  it("should look up only the people on the page, and only the linked ones", async () => {
    // given
    // The directory is routinely thousands of entities and this runs on every
    // dashboard load, so the fetch must be bounded by who was actually active —
    // and an unlinked account has no reference to fetch at all.
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await store.commitIngestion({
      repositoryId: repository.id,
      events: [
        commit(repository.id, "2026-08-09T10:00:00.000Z", "one@example.com").build(),
        commit(repository.id, "2026-08-09T11:00:00.000Z", "two@example.com").build(),
      ],
      chunk: { repositoryId: repository.id, kinds: ["commit"], days: [], ingestedAt: NOW },
      status: "active",
      now: NOW,
    });
    await store.saveIdentityLink({
      source: "vcs",
      sourceKey: "one@example.com",
      entityRef: "user:default/one",
      origin: "catalog-email",
      linkedBy: null,
      linkedAt: NOW,
    });
    const directory = new StubDirectoryReader();

    // when
    await new ListContributorSummaries({ store, directory }).run(WINDOW);

    // then
    expect(directory.refLookups).toEqual([["user:default/one"]]);
    // Never the whole directory: that listing exists for the Identities screen,
    // where somebody deliberately asked for it.
    expect(directory.listUserCalls).toBe(0);
  });

  it("should sort the busiest contributor first", async () => {
    // given
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await store.commitIngestion({
      repositoryId: repository.id,
      events: [
        commit(repository.id, "2026-08-09T10:00:00.000Z", "quiet@example.com").build(),
        commit(repository.id, "2026-08-09T11:00:00.000Z", "busy@example.com").build(),
        commit(repository.id, "2026-08-09T12:00:00.000Z", "busy@example.com").build(),
      ],
      chunk: { repositoryId: repository.id, kinds: ["commit"], days: [], ingestedAt: NOW },
      status: "active",
      now: NOW,
    });

    // when
    const contributors = await new ListContributorSummaries({ store }).run(WINDOW);

    // then
    expect(contributors.map((contributor) => contributor.key)).toEqual([
      "vcs:busy@example.com",
      "vcs:quiet@example.com",
    ]);
  });

  it("should compute an approval rate from the reviews given", async () => {
    // given
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await store.commitIngestion({
      repositoryId: repository.id,
      events: [
        EventBuilder.review("approved").withRepository(repository.id).withActor("r@example.com").at("2026-08-09T10:00:00.000Z").build(),
        EventBuilder.review("approved").withRepository(repository.id).withActor("r@example.com").at("2026-08-09T11:00:00.000Z").build(),
        EventBuilder.review("rejected").withRepository(repository.id).withActor("r@example.com").at("2026-08-09T12:00:00.000Z").build(),
      ],
      chunk: { repositoryId: repository.id, kinds: ["pr_review"], days: [], ingestedAt: NOW },
      status: "active",
      now: NOW,
    });

    // when
    const [contributor] = await new ListContributorSummaries({ store }).run(WINDOW);

    // then
    expect(contributor).toMatchObject({
      reviewsGiven: 3,
      reviewsApproved: 2,
      reviewsRejected: 1,
      prApprovalRate: 66.7,
    });
  });

  it("should compute a pipeline success rate over the runs that reached a verdict", async () => {
    // given
    // A run cancelled because a newer push superseded it, or one still in
    // progress, is neither a success nor a failure; counting it against
    // somebody turns a busy afternoon into a bad success rate.
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await store.commitIngestion({
      repositoryId: repository.id,
      events: [
        EventBuilder.build("succeeded").withRepository(repository.id).withActor("d@example.com").at("2026-08-09T10:00:00.000Z").build(),
        EventBuilder.build("failed").withRepository(repository.id).withActor("d@example.com").at("2026-08-09T11:00:00.000Z").build(),
        EventBuilder.build("canceled").withRepository(repository.id).withActor("d@example.com").at("2026-08-09T12:00:00.000Z").build(),
        EventBuilder.build(null).withRepository(repository.id).withActor("d@example.com").at("2026-08-09T13:00:00.000Z").build(),
      ],
      chunk: { repositoryId: repository.id, kinds: ["build"], days: [], ingestedAt: NOW },
      status: "active",
      now: NOW,
    });

    // when
    const [contributor] = await new ListContributorSummaries({ store }).run(WINDOW);

    // then
    expect(contributor).toMatchObject({
      pipelineRuns: 4,
      pipelineRunsSucceeded: 1,
      pipelineRunsFailed: 1,
      pipelineSuccessRate: 50,
    });
  });

  it("should floor net lines at zero", async () => {
    // given
    // A window in which someone mostly deleted code is a legitimate
    // contribution, not a negative one.
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await store.commitIngestion({
      repositoryId: repository.id,
      events: [
        EventBuilder.commit()
          .withRepository(repository.id)
          .withActor("d@example.com")
          .at("2026-08-09T10:00:00.000Z")
          .withChurn(5, 500)
          .build(),
      ],
      chunk: { repositoryId: repository.id, kinds: ["commit"], days: [], ingestedAt: NOW },
      status: "active",
      now: NOW,
    });

    // when
    const [contributor] = await new ListContributorSummaries({ store }).run(WINDOW);

    // then
    expect(contributor.linesOfCode).toBe(0);
    expect(contributor.linesDeleted).toBe(500);
  });

  it("should narrow to one repository when asked", async () => {
    // given
    const { store, discovered } = await seed(2);
    for (const repository of discovered) {
      await store.commitIngestion({
        repositoryId: repository.id,
        events: [commit(repository.id, "2026-08-09T10:00:00.000Z").build()],
        chunk: { repositoryId: repository.id, kinds: ["commit"], days: [], ingestedAt: NOW },
        status: "active",
        now: NOW,
      });
    }

    // when
    const contributors = await new ListContributorSummaries({ store }).run({
      ...WINDOW,
      repositoryId: discovered[0].id,
    });

    // then
    expect(contributors[0].commits).toBe(1);
    expect(contributors[0].repositories).toBe(1);
  });

  it("should sum a person's WakaTime days across the window", async () => {
    // given
    // Stored per day so a past month can be answered; the row has to add them
    // back up rather than showing whichever day happened to be last.
    const { store } = await seed();
    for (const [day, seconds] of [
      ["2026-08-09", 3600],
      ["2026-08-10", 1800],
      // Outside the window, and must not be counted.
      ["2026-08-12", 9999],
    ] as const) {
      await store.saveContributorMetrics({
        source: "wakatime",
        day,
        capturedAt: NOW,
        metrics: new Map([
          ["dev", WakaTimeMetricsBuilder.aDay(day).withSeconds(seconds).build()],
        ]),
      });
    }

    // when
    const [contributor] = await new ListContributorSummaries({ store }).run(WINDOW);

    // then
    expect(contributor?.wakaTimeMetrics?.totalSeconds).toBe(5400);
    expect(contributor?.wakaTimeMetrics?.measuredDays).toBe(2);
    expect(contributor?.wakaTimeMetrics?.dailyAverageSeconds).toBe(2700);
  });

  it("should count the pull requests a contributor opened and merged", async () => {
    // given
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await store.commitIngestion({
      repositoryId: repository.id,
      events: [
        EventBuilder.pullRequest("open").withRepository(repository.id).withActor("d@example.com").at("2026-08-09T10:00:00.000Z").build(),
        EventBuilder.pullRequest("merged").withRepository(repository.id).withActor("d@example.com").at("2026-08-09T11:00:00.000Z").build(),
        EventBuilder.pullRequest("abandoned").withRepository(repository.id).withActor("d@example.com").at("2026-08-09T12:00:00.000Z").build(),
      ],
      chunk: { repositoryId: repository.id, kinds: ["pull_request"], days: [], ingestedAt: NOW },
      status: "active",
      now: NOW,
    });

    // when
    const [contributor] = await new ListContributorSummaries({ store }).run(WINDOW);

    // then
    // An abandoned pull request counts towards neither, so neither number is
    // inflated by work that was thrown away.
    expect(contributor).toMatchObject({ pullRequestsOpened: 1, pullRequestsMerged: 1 });
  });

  it("should ignore a kind that carries no contributor meaning", async () => {
    // given
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await store.commitIngestion({
      repositoryId: repository.id,
      events: [
        EventBuilder.release().withRepository(repository.id).withActor("d@example.com").at("2026-08-09T10:00:00.000Z").build(),
      ],
      chunk: { repositoryId: repository.id, kinds: [], days: [], ingestedAt: NOW },
      status: "active",
      now: NOW,
    });

    // when
    const [contributor] = await new ListContributorSummaries({ store }).run(WINDOW);

    // then
    // The release still names them as a contributor to the window, but it is
    // not a commit, a review or a pipeline run.
    expect(contributor).toMatchObject({ commits: 0, reviewsGiven: 0, pipelineRuns: 0 });
    expect(contributor.repositories).toBe(1);
  });

  it("should take the display name and avatar from the events", async () => {
    // given
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await store.commitIngestion({
      repositoryId: repository.id,
      events: [
        {
          ...commit(repository.id, "2026-08-09T10:00:00.000Z", "d@example.com").build(),
          actorName: "Dev Example",
          actorAvatarUrl: "https://avatar",
        },
      ],
      chunk: { repositoryId: repository.id, kinds: ["commit"], days: [], ingestedAt: NOW },
      status: "active",
      now: NOW,
    });

    // when
    const [contributor] = await new ListContributorSummaries({ store }).run(WINDOW);

    // then
    expect(contributor.displayName).toBe("Dev Example");
    expect(contributor.avatarUrl).toBe("https://avatar");
  });

  it("should ignore events with no actor", async () => {
    // given
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await store.commitIngestion({
      repositoryId: repository.id,
      events: [
        EventBuilder.release()
          .withRepository(repository.id)
          .withActor(null)
          .at("2026-08-09T10:00:00.000Z")
          .build(),
      ],
      chunk: { repositoryId: repository.id, kinds: [], days: [], ingestedAt: NOW },
      status: "active",
      now: NOW,
    });

    // when
    const contributors = await new ListContributorSummaries({ store }).run(WINDOW);

    // then
    expect(contributors).toEqual([]);
  });
});

describe("GetRepositoryTimeSeries", () => {
  it("should emit a point for every day, including empty ones", async () => {
    // given
    // Closing over a gap would draw a line implying activity that never
    // happened.
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await store.commitIngestion({
      repositoryId: repository.id,
      events: [commit(repository.id, "2026-08-09T10:00:00.000Z").build()],
      chunk: { repositoryId: repository.id, kinds: ["commit"], days: [], ingestedAt: NOW },
      status: "active",
      now: NOW,
    });

    // when
    const points = await new GetRepositoryTimeSeries(store).run({
      repositoryId: repository.id,
      ...WINDOW,
      bucket: "day",
    });

    // then
    expect(points.map((point) => point.day)).toEqual(["2026-08-09", "2026-08-10"]);
    expect(points[0].activity.commits).toBe(1);
    expect(points[1].activity.commits).toBe(0);
  });

  it("should group a week onto its Monday", async () => {
    // given
    // 2026-08-09 is a Sunday, which belongs to the week that started six days
    // earlier rather than to the one beginning the next morning.
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await store.commitIngestion({
      repositoryId: repository.id,
      events: [commit(repository.id, "2026-08-09T10:00:00.000Z").build()],
      chunk: { repositoryId: repository.id, kinds: ["commit"], days: [], ingestedAt: NOW },
      status: "active",
      now: NOW,
    });

    // when
    const points = await new GetRepositoryTimeSeries(store).run({
      repositoryId: repository.id,
      from: new Date("2026-08-09T00:00:00.000Z"),
      to: new Date("2026-08-10T00:00:00.000Z"),
      bucket: "week",
    });

    // then
    expect(points.map((point) => point.day)).toEqual(["2026-08-03"]);
  });

  it("should group a month onto its first day", async () => {
    // given
    const { store, discovered } = await seed();
    const [repository] = discovered;

    // when
    const points = await new GetRepositoryTimeSeries(store).run({
      repositoryId: repository.id,
      from: new Date("2026-08-09T00:00:00.000Z"),
      to: new Date("2026-08-11T00:00:00.000Z"),
      bucket: "month",
    });

    // then
    expect(points.map((point) => point.day)).toEqual(["2026-08-01"]);
  });

  it("should aggregate every repository when none is named", async () => {
    // given
    // The Insights tab charts the whole fleet as one series; asking per
    // repository and adding the answers up in the browser would mean one
    // request per repository on every range change.
    const { store, discovered } = await seed(2);
    for (const repository of discovered) {
      await store.commitIngestion({
        repositoryId: repository.id,
        events: [commit(repository.id, "2026-08-09T10:00:00.000Z").build()],
        chunk: {
          repositoryId: repository.id,
          kinds: ["commit"],
          days: [],
          ingestedAt: NOW,
        },
        status: "active",
        now: NOW,
      });
    }

    // when
    const points = await new GetRepositoryTimeSeries(store).run({
      ...WINDOW,
      bucket: "day",
    });

    // then
    expect(points.map((point) => point.day)).toEqual(["2026-08-09", "2026-08-10"]);
    expect(points[0].activity.commits).toBe(2);
  });

  it("should still scope to one repository when it is named", async () => {
    // given
    const { store, discovered } = await seed(2);
    for (const repository of discovered) {
      await store.commitIngestion({
        repositoryId: repository.id,
        events: [commit(repository.id, "2026-08-09T10:00:00.000Z").build()],
        chunk: {
          repositoryId: repository.id,
          kinds: ["commit"],
          days: [],
          ingestedAt: NOW,
        },
        status: "active",
        now: NOW,
      });
    }

    // when
    const points = await new GetRepositoryTimeSeries(store).run({
      repositoryId: discovered[0].id,
      ...WINDOW,
      bucket: "day",
    });

    // then
    expect(points[0].activity.commits).toBe(1);
  });
});

describe("ListRepositorySummaries documentation and API exposure", () => {
  const snapshotWith = (
    files: RepositorySnapshotPayload["repositoryFiles"],
    overrides: Partial<RepositorySnapshotPayload> = {},
  ) => aSnapshotPayload({ repositoryFiles: files, ...overrides });

  const run = async (
    facts: Parameters<
      ReturnType<typeof DiscoveredRepositoryBuilder.create>["withCatalogFacts"]
    >[0],
    payload: RepositorySnapshotPayload | null,
  ) => {
    const store = new InMemoryCodeHealthStore();
    const discovered = DiscoveredRepositoryBuilder.create()
      .withEntityRef("component:default/gateway")
      .withCatalogFacts(facts)
      .build();
    await store.syncRepositories({
      discovered: [discovered],
      retentionDays: 365,
      now: NOW,
    });
    if (payload !== null) {
      await store.saveSnapshot({
        repositoryId: discovered.id,
        day: "2026-08-10",
        capturedAt: NOW,
        payload,
      });
    }
    const [summary] = await new ListRepositorySummaries(store).run(WINDOW);
    return summary;
  };

  it("should report documentation as not measured before the first snapshot", async () => {
    // given / when
    const summary = await run({ techDocsRef: "dir:." }, null);

    // then
    // The catalog half of the evidence is known from discovery, but the
    // repository half arrives with the snapshot, and grading on half of it
    // would report a gap that is not there.
    expect(summary.documentation).toBeNull();
    expect(summary.apiExposure).toBeNull();
  });

  it("should report documentation as not measured on a snapshot predating the scan", async () => {
    // given / when
    const summary = await run({ techDocsRef: "dir:." }, snapshotWith(null));

    // then
    expect(summary.documentation).toBeNull();
  });

  it("should grade a repository with TechDocs as documented", async () => {
    // given / when
    const summary = await run(
      { techDocsRef: "dir:." },
      snapshotWith({ hasReadme: true, hasDocsSource: true, apiDefinitionPath: null }),
    );

    // then
    expect(summary.documentation?.state).toBe("documented");
  });

  it("should grade a repository that writes docs nobody published as unpublished", async () => {
    // given / when
    const summary = await run(
      {},
      snapshotWith({ hasReadme: true, hasDocsSource: true, apiDefinitionPath: null }),
    );

    // then
    expect(summary.documentation).toMatchObject({
      state: "unpublished",
      hasDocsSource: true,
      hasTechDocs: false,
    });
  });

  it("should grade a repository with only a README as missing", async () => {
    // given / when
    const summary = await run(
      {},
      snapshotWith({ hasReadme: true, hasDocsSource: false, apiDefinitionPath: null }),
    );

    // then
    expect(summary.documentation?.state).toBe("missing");
  });

  it("should grade an archived repository as not expected to be documented", async () => {
    // given / when
    const summary = await run(
      {},
      snapshotWith(
        { hasReadme: false, hasDocsSource: false, apiDefinitionPath: null },
        { isArchived: true },
      ),
    );

    // then
    expect(summary.documentation?.state).toBe("not-expected");
  });

  it("should flag a repository shipping a definition it never declared", async () => {
    // given / when
    const summary = await run(
      { entityType: "service" },
      snapshotWith({
        hasReadme: true,
        hasDocsSource: false,
        apiDefinitionPath: "openapi.yaml",
      }),
    );

    // then
    expect(summary.apiExposure).toMatchObject({
      state: "candidate",
      definitionPath: "openapi.yaml",
      declaredApis: 0,
    });
  });

  it("should leave a repository that already declares an API alone", async () => {
    // given / when
    const summary = await run(
      { entityType: "service", providesApis: 1 },
      snapshotWith({
        hasReadme: true,
        hasDocsSource: false,
        apiDefinitionPath: "openapi.yaml",
      }),
    );

    // then
    expect(summary.apiExposure?.state).toBe("declared");
  });
});

describe("ListContributorSummaries churn unit", () => {
  it("should report lines when the provider reported line counts", async () => {
    // given
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await store.commitIngestion({
      repositoryId: repository.id,
      events: [commit(repository.id, "2026-08-10T10:00:00.000Z").build()],
      chunk: { repositoryId: repository.id, kinds: ["commit"], days: [], ingestedAt: NOW },
      status: "active",
      now: NOW,
    });

    // when
    const [contributor] = await new ListContributorSummaries({ store }).run(WINDOW);

    // then
    expect(contributor.churnUnit).toBe("lines");
    expect(contributor.linesOfCode).toBe(8);
  });

  it("should report files when the provider only reported file counts", async () => {
    // given
    // Azure DevOps carries added, edited and deleted *files* and exposes no
    // line count anywhere in its REST API, so a lines column against an Azure
    // DevOps fleet reads zero on every row.
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await store.commitIngestion({
      repositoryId: repository.id,
      events: [
        EventBuilder.commit()
          .withRepository(repository.id)
          .withActor("dev@example.com")
          .at("2026-08-10T10:00:00.000Z")
          .withFileChurn(7)
          .build(),
      ],
      chunk: { repositoryId: repository.id, kinds: ["commit"], days: [], ingestedAt: NOW },
      status: "active",
      now: NOW,
    });

    // when
    const [contributor] = await new ListContributorSummaries({ store }).run(WINDOW);

    // then
    expect(contributor.churnUnit).toBe("files");
    expect(contributor.changedFiles).toBe(7);
    expect(contributor.linesOfCode).toBe(0);
  });

  it("should report neither when the provider reported no churn at all", async () => {
    // given
    const { store, discovered } = await seed();
    const [repository] = discovered;
    await store.commitIngestion({
      repositoryId: repository.id,
      events: [
        EventBuilder.commit()
          .withRepository(repository.id)
          .withActor("dev@example.com")
          .at("2026-08-10T10:00:00.000Z")
          .build(),
      ],
      chunk: { repositoryId: repository.id, kinds: ["commit"], days: [], ingestedAt: NOW },
      status: "active",
      now: NOW,
    });

    // when
    const [contributor] = await new ListContributorSummaries({ store }).run(WINDOW);

    // then
    // "The provider said zero" and "the provider never said" are different
    // facts, and a table showing 0 for the second is the bug this unit exists
    // to prevent.
    expect(contributor.churnUnit).toBe("none");
  });

  it("should prefer lines when a fleet spans both providers", async () => {
    // given
    const { store, discovered } = await seed(2);
    const [first, second] = discovered;
    for (const [repository, event] of [
      [first, commit(first.id, "2026-08-10T10:00:00.000Z").build()],
      [
        second,
        EventBuilder.commit()
          .withRepository(second.id)
          .withActor("dev@example.com")
          .at("2026-08-10T11:00:00.000Z")
          .withFileChurn(3)
          .build(),
      ],
    ] as const) {
      await store.commitIngestion({
        repositoryId: repository.id,
        events: [event],
        chunk: {
          repositoryId: repository.id,
          kinds: ["commit"],
          days: [],
          ingestedAt: NOW,
        },
        status: "active",
        now: NOW,
      });
    }

    // when
    const [contributor] = await new ListContributorSummaries({ store }).run(WINDOW);

    // then
    // The more precise figure wins where it exists, rather than degrading the
    // whole row to the coarser one.
    expect(contributor.churnUnit).toBe("lines");
  });
});
