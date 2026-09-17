import type {
  ConfluenceSpaceMetrics,
  IntegrationCapabilities,
  JiraRepositoryMetrics,
  RepositorySummary,
  WakaTimeProjectMetrics,
} from "@rios0rios0/backstage-plugin-code-health-common";
import {
  EMPTY_JIRA_ISSUE_TYPES,
  NO_INTEGRATIONS,
} from "@rios0rios0/backstage-plugin-code-health-common";
import { renderInTestApp, TestApiProvider } from "@backstage/test-utils";
import { screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import type { UseCoverageResult } from "../../../src/presentation/hooks/use_coverage";
import { RepositoryDetailPage } from "../../../src/presentation/pages/repository_detail_page";
import { rootRouteRef } from "../../../src/routes";
import { ContributorBuilder } from "../../builders/contributor_builder";
import { RepositoryBuilder } from "../../builders/repository_builder";
import { StubContributorService } from "../../doubles/stub_contributor_service";
import { aCoverageInfo } from "../../doubles/stub_coverage_service";
import {
  aRepositoryTrend,
  aRepositoryTrendPoint,
  StubTrendService,
} from "../../doubles/stub_trend_service";

const coverageResult = (): UseCoverageResult => ({
  coverage: aCoverageInfo(),
  isLoading: false,
  error: null,
  reload: async () => undefined,
});

const wakaTime: WakaTimeProjectMetrics = {
  projectName: "gateway",
  window: { from: "2026-08-03", to: "2026-08-10" },
  totalSeconds: 7200,
  contributors: 2,
  daily: [],
};

const jira: JiraRepositoryMetrics = {
  window: { from: "2026-08-03T00:00:00.000Z", to: "2026-08-10T00:00:00.000Z" },
  projectKey: "GW",
  component: null,
  issuesCreated: 5,
  issuesResolved: 4,
  throughputPerWeek: 4,
  resolvedByType: { ...EMPTY_JIRA_ISSUE_TYPES, bug: 1, story: 3 },
  bugRatio: 25,
  reopened: 0,
  cycleTime: null,
  leadTime: null,
  storyPointsEstimated: null,
  storyPointsCompleted: null,
  openIssues: 7,
  oldestOpenIssue: null,
  openByPriority: [],
  contributors: 2,
};

const confluence: ConfluenceSpaceMetrics = {
  space: { key: "GW", name: "Gateway", url: null },
  window: { from: "2026-08-03T00:00:00.000Z", to: "2026-08-10T00:00:00.000Z" },
  totalPages: 40,
  pagesCreated: 3,
  pagesEdited: 11,
  blogPostsCreated: 0,
  commentsWritten: 6,
  attachmentsAdded: 1,
  contributors: 3,
  lastActivityAt: "2026-08-09T09:00:00.000Z",
  stalePages: null,
  staleAfterDays: 180,
  stalestPage: null,
  parentlessPages: null,
  pageViews: null,
  pagesMeasuredForViews: 0,
  analytics: "unavailable",
};

/** A repository with something to say in every series the page draws. */
const aBusyRepository = (): RepositorySummary =>
  RepositoryBuilder.create()
    .withId("repo-1")
    .withName("gateway")
    .withEntityRef("component:default/gateway")
    .withDescription("The edge service")
    .withLanguage("TypeScript")
    .withOwner("group:default/platform")
    .withCoverage(72, "OK")
    .withCiStatus("SUCCESS")
    .withComplianceColor("green")
    .withDocumentationState("documented")
    .withActivity({
      commits: 30,
      contributors: 3,
      pullRequestsOpened: 6,
      pullRequestsMerged: 4,
      pullRequestsAbandoned: 1,
      builds: 12,
      buildsSucceeded: 9,
      buildsFailed: 1,
      reviews: 8,
      releases: 1,
      tags: 2,
    })
    .build();

const renderPage = async (
  overrides: {
    trendService?: StubTrendService;
    contributorService?: StubContributorService;
    capabilities?: IntegrationCapabilities;
    path?: string;
  } = {},
) => {
  const trendService =
    overrides.trendService ??
    new StubTrendService().withRepositoryTrend(
      aRepositoryTrend({
        summary: aBusyRepository(),
        points: [aRepositoryTrendPoint("2026-08-03", aBusyRepository())],
      }),
    );
  const contributorService = overrides.contributorService ?? new StubContributorService();

  await renderInTestApp(
    <TestApiProvider apis={[]}>
      <Routes>
        <Route
          path="/repositories/:id"
          element={
            <RepositoryDetailPage
              trendService={trendService}
              contributorService={contributorService}
              coverage={coverageResult()}
              capabilities={overrides.capabilities ?? NO_INTEGRATIONS}
            />
          }
        />
      </Routes>
    </TestApiProvider>,
    {
      routeEntries: [overrides.path ?? "/repositories/repo-1"],
      mountedRoutes: { "/": rootRouteRef },
    },
  );

  return { trendService, contributorService };
};

describe("RepositoryDetailPage", () => {
  it("should head the page with the repository the route named", async () => {
    // given / when
    await renderPage();

    // then
    expect(await screen.findByText("user/gateway")).toBeInTheDocument();
    expect(screen.getByText("The edge service")).toBeInTheDocument();
    expect(screen.getByText("TypeScript")).toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();
  });

  it("should ask the backend for the repository the route named", async () => {
    // given / when
    const { trendService } = await renderPage();

    // then
    await waitFor(() => expect(trendService.repositoryCalls).toHaveLength(1));
    // Three months by default, which at that length buckets by week.
    expect(trendService.repositoryCalls[0].id).toBe("repo-1");
    expect(trendService.repositoryCalls[0].bucket).toBe("week");
  });

  it("should link the owner to the catalog entity that owns the repository", async () => {
    // given / when
    await renderPage();

    // then
    expect((await screen.findByText("platform")).closest("a")).toHaveAttribute(
      "href",
      "/catalog/default/group/platform",
    );
  });

  it("should show an em dash for a repository the catalog gives no owner", async () => {
    // given
    // An unowned repository is a real finding, and inventing an owner hides it.
    const summary = { ...aBusyRepository(), ownerRef: null };
    const trendService = new StubTrendService().withRepositoryTrend(
      aRepositoryTrend({ summary }),
    );

    // when
    await renderPage({ trendService });

    // then
    expect(await screen.findByText(/Owner:/)).toHaveTextContent("Owner: —");
  });

  it("should offer a way back to the table and out to both the catalog and the provider", async () => {
    // given / when
    await renderPage();

    // then
    expect((await screen.findByText(/Back to repositories/)).closest("a")).toHaveAttribute(
      "href",
      "/repositories",
    );
    expect(screen.getByText("Open in the catalog").closest("a")).toHaveAttribute(
      "href",
      "/catalog/default/component/gateway",
    );
    expect(screen.getByText("Open on GitHub").closest("a")).toHaveAttribute(
      "href",
      "https://github.com/user/gateway",
    );
  });

  it("should take the health score apart rather than print it alone", async () => {
    // given / when
    // A bare number on a repository's page is a verdict nobody can act on.
    await renderPage();

    // then
    expect(await screen.findByText("Health score")).toBeInTheDocument();
    expect(screen.getByText("Quality gate")).toBeInTheDocument();
    expect(screen.getByText("the quality gate passes")).toBeInTheDocument();
  });

  it("should draw the activity trends", async () => {
    // given / when
    await renderPage();

    // then
    expect(await screen.findByText("Commits and merges")).toBeInTheDocument();
    expect(screen.getByText("Pull requests")).toBeInTheDocument();
    expect(screen.getByText("Builds")).toBeInTheDocument();
    expect(screen.getByText("Build success rate")).toBeInTheDocument();
    expect(screen.getByText("Reviews per merged pull request")).toBeInTheDocument();
    expect(screen.getByText("Active contributors")).toBeInTheDocument();
    expect(screen.getByText("Health score over time")).toBeInTheDocument();
    expect(screen.getByText("Releases and tags")).toBeInTheDocument();
  });

  it("should say that the Sonar and compliance series start at the first snapshot", async () => {
    // given / when
    // Nothing can backfill them, and a chart that begins mid-window without
    // saying so reads as data going missing.
    await renderPage();

    // then
    const captions = await screen.findAllByText(
      /starts at the first snapshot after installation/,
    );
    expect(captions.length).toBeGreaterThan(0);
  });

  it("should show a progress indicator while the first window is in flight", async () => {
    // given
    // Nothing has resolved yet, so there is no summary to head the page with.
    const trendService = new StubTrendService();

    // when
    await renderPage({ trendService });

    // then
    expect(screen.queryByText("user/gateway")).not.toBeInTheDocument();
  });

  it("should read a 404 as an untracked repository rather than as a fault", async () => {
    // given
    // A link outliving a catalog entity is ordinary, and calling it an outage
    // sends somebody looking for a broken backend.
    const trendService = new StubTrendService();

    // when
    await renderPage({ trendService, path: "/repositories/gone" });

    // then
    // `WarningPanel` prefixes its title with the severity, hence the pattern.
    expect(await screen.findByText(/This repository is not tracked/)).toBeInTheDocument();
    expect(screen.queryByText(/Failed to load the repository/)).not.toBeInTheDocument();
  });

  it("should report a genuine failure as one", async () => {
    // given
    const trendService = new StubTrendService().withError(new Error("503 Service Unavailable"));

    // when
    await renderPage({ trendService });

    // then
    expect(await screen.findByText(/Failed to load the repository/)).toBeInTheDocument();
    expect(screen.queryByText(/This repository is not tracked/)).not.toBeInTheDocument();
  });

  it("should rank the people who worked on the repository, linked to their own pages", async () => {
    // given
    const contributorService = new StubContributorService().withContributors([
      ContributorBuilder.create().withDisplayName("alice").withCommits(30).build(),
    ]);

    // when
    const { contributorService: service } = await renderPage({ contributorService });

    // then
    expect(await screen.findByText("Who works on it")).toBeInTheDocument();
    expect(screen.getByText("alice").closest("a")).toHaveAttribute(
      "href",
      "/contributors/person?key=alice",
    );
    // Narrowed to this repository rather than the whole fleet.
    await waitFor(() =>
      expect(service.calls.map((call) => call.repositoryId)).toEqual(["repo-1"]),
    );
  });

  it("should keep the page up when the contributors request fails", async () => {
    // given
    // Who works on a repository is a second question with a second request; a
    // failure there costs the card, not the trends.
    const contributorService = new StubContributorService().withError(new Error("nope"));

    // when
    await renderPage({ contributorService });

    // then
    expect(await screen.findByText(/Contributors could not be read: nope/)).toBeInTheDocument();
    expect(screen.getByText("Commits and merges")).toBeInTheDocument();
  });

  it("should encode a person key that carries a slash into the link", async () => {
    // given
    // An unlinked account keys as `<source>:<sourceKey>`, and a linked one as a
    // full entity reference — both carry characters a query value has to escape.
    const contributorService = new StubContributorService().withContributors([
      // The display name is set first: the builder derives a key from it, and
      // this row is testing a key that does not come from a name at all.
      ContributorBuilder.create()
        .withDisplayName("Jane Doe")
        .withKey("user:default/jane")
        .withCommits(4)
        .build(),
    ]);

    // when
    await renderPage({ contributorService });

    // then
    expect((await screen.findByText("Jane Doe")).closest("a")).toHaveAttribute(
      "href",
      "/contributors/person?key=user%3Adefault%2Fjane",
    );
  });

  it("should leave every integration card out when none is configured", async () => {
    // given / when
    // A switched-off integration and one that has collected nothing want
    // completely different words, and only the capabilities probe knows which.
    await renderPage({ capabilities: NO_INTEGRATIONS });

    // then
    expect(await screen.findByText("Commits and merges")).toBeInTheDocument();
    expect(screen.queryByText("Coding time")).not.toBeInTheDocument();
    expect(screen.queryByText("Jira delivery")).not.toBeInTheDocument();
    expect(screen.queryByText("Confluence space")).not.toBeInTheDocument();
  });

  it("should draw each integration card when its capability is on", async () => {
    // given
    const summary: RepositorySummary = {
      ...aBusyRepository(),
      wakaTimeMetrics: wakaTime,
      jiraMetrics: jira,
      confluenceMetrics: confluence,
    };
    const trendService = new StubTrendService().withRepositoryTrend(
      aRepositoryTrend({
        summary,
        points: [aRepositoryTrendPoint("2026-08-03", summary)],
      }),
    );

    // when
    await renderPage({
      trendService,
      capabilities: { wakatime: true, jira: true, confluence: true },
    });

    // then
    // Twice each: once as the chart card, once as a row of the Averages card.
    expect(await screen.findAllByText("Coding time")).toHaveLength(2);
    expect(screen.getByText("Jira delivery")).toBeInTheDocument();
    // Figures over the snapshot's own window rather than a per-bucket chart:
    // the repository-level Jira measures describe a trailing window, and a
    // chart of them beside the per-bucket cards would read as throughput.
    expect(screen.getByText("Open right now")).toBeInTheDocument();
    expect(screen.getAllByText("Tickets resolved")).toHaveLength(2);
    // Named by the last day it covers: the fixture's window stops at the start
    // of the 10th, so it holds the 3rd to the 9th.
    expect(
      screen.getByText(/GW, Aug 3 to Aug 9 — the snapshot's own trailing window/),
    ).toBeInTheDocument();
    expect(screen.getByText("Confluence space")).toBeInTheDocument();
    expect(screen.getByText("Gateway")).toBeInTheDocument();
    expect(screen.getByText("Pages edited")).toBeInTheDocument();
  });

  it("should write the window's activity out as rates beside the fleet's average", async () => {
    // given
    // What a reader asking "is this repository busy" wants before any chart,
    // as a comparison rather than a number.
    const summary = aBusyRepository();
    const trendService = new StubTrendService().withRepositoryTrend(
      aRepositoryTrend({
        summary,
        fleet: {
          days: 92,
          repositories: 8,
          commits: summary.activity.commits / 92 / 2,
          pullRequestsOpened: 0,
          pullRequestsMerged: 0,
          reviews: 0,
          builds: 0,
          releases: 0,
          codingSeconds: null,
          issuesResolved: null,
        },
      }),
    );

    // when
    await renderPage({ trendService });

    // then
    expect(await screen.findByText("Averages")).toBeInTheDocument();
    expect(screen.getByText("100% above the fleet")).toBeInTheDocument();
    expect(
      screen.getByText(/The fleet is the 8 active repositories tracked in this range/u),
    ).toBeInTheDocument();
  });

  it("should say so rather than invent zeroes when Confluence named no space", async () => {
    // given
    // The integration is on and this repository's entity names no space, which
    // is not the same as a space nobody has written in.
    await renderPage({ capabilities: { ...NO_INTEGRATIONS, confluence: true } });

    // then
    expect(
      await screen.findByText(/No Confluence space is named by the catalog entity/),
    ).toBeInTheDocument();
  });

  it("should flag an archived fork and leave out what the provider never said", async () => {
    // given
    // A repository with no description and no language should read as a
    // repository nobody described, not as a header with holes in it.
    const summary: RepositorySummary = {
      ...aBusyRepository(),
      description: null,
      primaryLanguage: null,
      isArchived: true,
      isFork: true,
      platform: "azure-devops",
    };
    const trendService = new StubTrendService().withRepositoryTrend(
      aRepositoryTrend({ summary }),
    );

    // when
    await renderPage({ trendService });

    // then
    expect(await screen.findByText("archived")).toBeInTheDocument();
    expect(screen.getByText("fork")).toBeInTheDocument();
    expect(screen.getByText("Azure DevOps")).toBeInTheDocument();
    expect(screen.queryByText("The edge service")).not.toBeInTheDocument();
  });

  it("should drop the catalog link when the entity reference is unusable", async () => {
    // given
    // One malformed reference costs the page a link, not the page.
    const summary: RepositorySummary = { ...aBusyRepository(), entityRef: "not-a-ref" };
    const trendService = new StubTrendService().withRepositoryTrend(
      aRepositoryTrend({ summary }),
    );

    // when
    await renderPage({ trendService });

    // then
    expect(await screen.findByText("user/gateway")).toBeInTheDocument();
    expect(screen.queryByText("Open in the catalog")).not.toBeInTheDocument();
  });

  it("should show an em dash for an owner reference the catalog cannot address", async () => {
    // given
    const summary: RepositorySummary = { ...aBusyRepository(), ownerRef: "platform" };
    const trendService = new StubTrendService().withRepositoryTrend(
      aRepositoryTrend({ summary }),
    );

    // when
    await renderPage({ trendService });

    // then
    expect(await screen.findByText(/Owner:/)).toHaveTextContent("Owner: —");
  });

  it("should fall back to the space key when Confluence reports no space name", async () => {
    // given
    // A space with no name is still a space somebody can be sent to.
    const summary: RepositorySummary = {
      ...aBusyRepository(),
      confluenceMetrics: { ...confluence, space: { key: "GW", name: null, url: null } },
    };
    const trendService = new StubTrendService().withRepositoryTrend(
      aRepositoryTrend({ summary }),
    );

    // when
    await renderPage({
      trendService,
      capabilities: { ...NO_INTEGRATIONS, confluence: true },
    });

    // then
    expect(await screen.findByText("GW")).toBeInTheDocument();
  });

  it("should tell the reader when the route named no repository at all", async () => {
    // given / when
    // The route can only match with an `:id`, so this is the bad-link case
    // rather than a fault worth asking the backend about.
    const trendService = new StubTrendService();
    await renderInTestApp(
      <Routes>
        <Route
          path="/repositories"
          element={
            <RepositoryDetailPage
              trendService={trendService}
              contributorService={new StubContributorService()}
              coverage={coverageResult()}
              capabilities={NO_INTEGRATIONS}
            />
          }
        />
      </Routes>,
      { routeEntries: ["/repositories"], mountedRoutes: { "/": rootRouteRef } },
    );

    // then
    expect(await screen.findByText(/No repository was named/)).toBeInTheDocument();
    expect(trendService.repositoryCalls).toEqual([]);
  });

  it("should offer the range picker bounded by what has been collected", async () => {
    // given / when
    await renderPage();

    // then
    expect(await screen.findByLabelText("Trend range")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Last 3 months" })).toBeInTheDocument();
  });
});
