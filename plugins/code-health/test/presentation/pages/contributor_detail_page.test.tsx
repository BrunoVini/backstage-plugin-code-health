import { renderInTestApp } from "@backstage/test-utils";
import type {
  IntegrationCapabilities,
  SonarMetrics,
} from "@rios0rios0/backstage-plugin-code-health-common";
import { NO_INTEGRATIONS } from "@rios0rios0/backstage-plugin-code-health-common";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { ContributorDetailPage } from "../../../src/presentation/pages/contributor_detail_page";
import type { UseCoverageResult } from "../../../src/presentation/hooks/use_coverage";
import { rootRouteRef } from "../../../src/routes";
import {
  ContributorBuilder,
  WakaTimeBuilder,
} from "../../builders/contributor_builder";
import { aTrendPoint } from "../../builders/contributor_trend_builder";
import { RepositoryBuilder } from "../../builders/repository_builder";
import { aCoverageInfo } from "../../doubles/stub_coverage_service";
import { StubOwnershipService } from "../../doubles/stub_ownership_service";
import { aContributorTrend, StubTrendService } from "../../doubles/stub_trend_service";

const KEY = "user:default/jane";

const ALL_INTEGRATIONS: IntegrationCapabilities = {
  wakatime: true,
  jira: true,
  confluence: true,
};

const sonar: SonarMetrics = {
  bugs: 4,
  codeSmells: 12,
  securityHotspots: 1,
  vulnerabilities: 2,
  coverage: 61.5,
  duplications: 3.2,
  technicalDebt: "1d 2h",
  technicalDebtMinutes: 600,
  qualityGateStatus: "OK",
};

const jiraMetrics = {
  window: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-08T00:00:00.000Z" },
  issuesCreated: 3,
  issuesResolved: 5,
  interactions: { comments: 2, worklogEntries: 1, transitions: 4, truncatedIssues: 0 },
  storyPointsEstimated: null,
  storyPointsCompleted: null,
  cycleTime: null,
  leadTime: null,
  resolvedByType: { bug: 1, story: 2, task: 2, epic: 0, other: 0 },
  reopened: 0,
};

/** A row carrying something for every card the page can draw. */
const aFullSummary = () =>
  ContributorBuilder.create()
    .withKey(KEY)
    .withDisplayName("Jane Roe")
    .withEntityRef("user:default/jane")
    .withIdentities([
      { source: "vcs", sourceKey: "jane@acme.com", displayName: "Jane Roe" },
      { source: "wakatime", sourceKey: "jane", displayName: "jane" },
    ])
    .withSonarMetrics(sonar)
    .withWakaTimeMetrics(WakaTimeBuilder.create().withTotalSeconds(19_800).build())
    .withJiraMetrics(jiraMetrics)
    .build();

const aFullTrend = () => {
  const summary = aFullSummary();
  return aContributorTrend({
    key: KEY,
    summary,
    score: aTrendPoint("2026-08-01", summary).score,
    points: [aTrendPoint("2026-08-01", summary), aTrendPoint("2026-08-08", summary)],
  });
};

const aCoverageResult = (): UseCoverageResult => ({
  coverage: aCoverageInfo({ earliestDay: "2025-01-01" }),
  isLoading: false,
  error: null,
  reload: async () => {},
});

const renderPage = (
  options: {
    trendService?: StubTrendService;
    ownershipService?: StubOwnershipService;
    capabilities?: IntegrationCapabilities;
    /** Left off to exercise the page opened from a link that named nobody. */
    key?: string | null;
  } = {},
) => {
  const trendService = options.trendService ?? new StubTrendService();
  const ownershipService = options.ownershipService ?? new StubOwnershipService();
  const key = options.key === undefined ? KEY : options.key;
  const query = key === null ? "" : `?key=${encodeURIComponent(key)}`;

  return renderInTestApp(
    <ContributorDetailPage
      trendService={trendService}
      ownershipService={ownershipService}
      coverage={aCoverageResult()}
      capabilities={options.capabilities ?? NO_INTEGRATIONS}
    />,
    {
      mountedRoutes: { "/": rootRouteRef },
      routeEntries: [`/contributors/person${query}`],
    },
  );
};

describe("ContributorDetailPage", () => {
  it("should say so, and offer the way back, when the link named nobody", async () => {
    // given
    // The page shows one person; a link that carried no key has nothing to show
    // and asking the backend for the empty key would answer "recorded nothing".
    const trendService = new StubTrendService();

    // when
    await renderPage({ trendService, key: null });

    // then
    expect(screen.getByText(/No contributor was named/u)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to contributors" })).toHaveAttribute(
      "href",
      "/contributors",
    );
    expect(trendService.contributorCalls).toEqual([]);
  });

  it("should show progress until the first answer lands", async () => {
    // given
    const trendService = new StubTrendService();
    trendService.getContributorTrend = () => new Promise(() => {});

    // when
    await renderPage({ trendService });

    // then
    expect(screen.getByTestId("progress")).toBeInTheDocument();
  });

  it("should report a failed read rather than an empty page", async () => {
    // given
    // An empty page and a failed request look identical, and only one of them
    // is worth telling somebody about.
    const trendService = new StubTrendService().withError(new Error("504 Gateway Timeout"));

    // when
    await renderPage({ trendService });

    // then
    expect(
      await screen.findByText(/Failed to load this contributor/u),
    ).toBeInTheDocument();
  });

  it("should head the page with the person, their accounts and their entity", async () => {
    // given
    // A total nobody can trace back to its sources is a total nobody trusts.
    const trendService = new StubTrendService().withContributorTrend(aFullTrend());

    // when
    await renderPage({ trendService });

    // then
    expect(await screen.findByText("Jane Roe")).toBeInTheDocument();
    expect(screen.getByText("vcs: jane@acme.com · wakatime: jane")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open in the catalog" })).toHaveAttribute(
      "href",
      "/catalog/default/user/jane",
    );
    expect(screen.getByRole("link", { name: "Back to contributors" })).toHaveAttribute(
      "href",
      "/contributors",
    );
  });

  it("should ask for the person named in the query string, bucketed for the range", async () => {
    // given
    // The key carries a colon and a slash, so it travels encoded and has to
    // arrive intact.
    const trendService = new StubTrendService().withContributorTrend(aFullTrend());

    // when
    await renderPage({ trendService });

    // then
    await waitFor(() => expect(trendService.contributorCalls).toHaveLength(1));
    expect(trendService.contributorCalls[0].key).toBe(KEY);
    // Three months is the default range, which is bucketed by week.
    expect(trendService.contributorCalls[0].bucket).toBe("week");
    expect(screen.getAllByText(/Bucketed by week\./u).length).toBeGreaterThan(0);
  });

  it("should chart every figure the contributors table prints", async () => {
    // given
    const trendService = new StubTrendService().withContributorTrend(aFullTrend());

    // when
    await renderPage({ trendService });

    // then
    // Each chart is read out by its series, which is also how the card and the
    // helper are proven to agree on the series keys.
    expect(
      await screen.findByRole("img", { name: /Commits and Pull requests merged/u }),
    ).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Opened and Merged/u })).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: /Reviews given and Approved/u }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: /Net lines of code from/u }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: /Pipeline success rate from/u }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: /Productivity score from/u }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: /Bugs and Vulnerabilities/u }),
    ).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Test coverage from/u })).toBeInTheDocument();
  });

  it("should show the productivity score with its workings", async () => {
    // given
    // A bare score on a person's page is an accusation with no evidence.
    const trendService = new StubTrendService().withContributorTrend(aFullTrend());

    // when
    await renderPage({ trendService });

    // then
    // The card's own title and the "Score over time" legend share the words, so
    // the list of components is what identifies the card itself.
    expect(
      await screen.findByRole("list", { name: "Productivity score components" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/against the team's average rate over the same period/u),
    ).toBeInTheDocument();
  });

  it("should say how the integrations join the score once one is configured", async () => {
    // given
    // Every weight on the card moves when an integration is switched on, and a
    // reader who is not told why is left to assume the score was rescaled.
    const trendService = new StubTrendService().withContributorTrend(aFullTrend());

    // when
    await renderPage({ trendService, capabilities: ALL_INTEGRATIONS });

    // then
    expect(
      await screen.findByText(/Coding time and tickets resolved join the score/u),
    ).toBeInTheDocument();
    expect(screen.getByText(/shared out over whatever is configured/u)).toBeInTheDocument();
    // Confluence is the one integration stored per window rather than per
    // day, so its component is named as read over its own trailing window,
    // and the per-bucket chart says it carries no point of it.
    expect(
      screen.getByText(/over Confluence's own trailing window, which the range above does not move/u),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Documentation written counts in the score above and on no point here/u),
    ).toBeInTheDocument();
  });

  it("should not describe integrations to an install that has none", async () => {
    // given
    const trendService = new StubTrendService().withContributorTrend(aFullTrend());

    // when
    await renderPage({ trendService });

    // then
    // Nothing here can collect coding time or tickets, so describing how they
    // would be read is an explanation of a card the reader will never see.
    expect(
      await screen.findByRole("list", { name: "Productivity score components" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Coding time and tickets resolved join the score/u),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Documentation written counts in the score above/u),
    ).not.toBeInTheDocument();
  });

  it("should explain a churn figure the provider never reported", async () => {
    // given
    // Azure DevOps exposes no line count anywhere in its REST API, and an empty
    // chart would read as somebody who deleted as much as they wrote.
    const summary = ContributorBuilder.create().withKey(KEY).withoutChurn().build();
    const trendService = new StubTrendService().withContributorTrend(
      aContributorTrend({ summary, points: [aTrendPoint("2026-08-01", summary)] }),
    );

    // when
    await renderPage({ trendService });

    // then
    expect(
      await screen.findByText(/Neither line counts nor changed-file counts/u),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /Net lines of code/u })).not.toBeInTheDocument();
  });

  it("should chart churn in changed files when that is the unit reported", async () => {
    // given
    const summary = ContributorBuilder.create().withKey(KEY).withFileChurn(58).build();
    const trendService = new StubTrendService().withContributorTrend(
      aContributorTrend({ summary, points: [aTrendPoint("2026-08-01", summary)] }),
    );

    // when
    await renderPage({ trendService });

    // then
    expect(
      await screen.findByRole("img", { name: /Files changed from/u }),
    ).toBeInTheDocument();
  });

  it("should say a series nothing measured was never measured", async () => {
    // given
    // A chart of nulls draws an empty grid under a legend, which reads as a
    // collapse to zero rather than as a source nobody asked.
    const summary = ContributorBuilder.create().withKey(KEY).build();
    const trendService = new StubTrendService().withContributorTrend(
      aContributorTrend({ summary, points: [aTrendPoint("2026-08-01", summary)] }),
    );

    // when
    await renderPage({ trendService });

    // then
    expect(
      await screen.findAllByText(
        /No Sonar project measured the repositories this person touched/u,
      ),
    ).toHaveLength(2);
  });

  it("should distinguish a stale link from a quiet period when nothing was recorded", async () => {
    // given
    // Both answer with no summary, and they call for opposite reactions.
    const trendService = new StubTrendService().withContributorTrend(
      aContributorTrend({ key: KEY, summary: null, score: null, points: [] }),
    );

    // when
    await renderPage({ trendService });

    // then
    expect(
      await screen.findByText(/Nothing was recorded under this key in the selected range/u),
    ).toBeInTheDocument();
    // The key still heads the page, because it is the only name there is.
    expect(screen.getByText(KEY)).toBeInTheDocument();
  });

  it("should leave the integration charts out when the backend has none configured", async () => {
    // given
    // Inferring it from the data cannot tell a switched-off integration from
    // one that is on and has not collected yet.
    const trendService = new StubTrendService().withContributorTrend(aFullTrend());

    // when
    await renderPage({ trendService, capabilities: NO_INTEGRATIONS });

    // then
    await screen.findAllByText("Commits");
    expect(screen.queryByText("Coding time")).not.toBeInTheDocument();
    expect(screen.queryByText("Tickets resolved")).not.toBeInTheDocument();
  });

  it("should chart coding time and tickets when those integrations are configured", async () => {
    // given
    const trendService = new StubTrendService().withContributorTrend(aFullTrend());

    // when
    await renderPage({ trendService, capabilities: ALL_INTEGRATIONS });

    // then
    expect(
      await screen.findByRole("img", { name: /Coding time from/u }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: /Tickets resolved from/u }),
    ).toBeInTheDocument();
  });

  it("should list what the person owns, worst first", async () => {
    // given
    const trendService = new StubTrendService().withContributorTrend(aFullTrend());
    const ownershipService = new StubOwnershipService()
      .withOwnership("user:default/jane", ["user:default/jane"])
      .withRepositories([
        RepositoryBuilder.create().withName("billing").withCoverage(94, "OK").build(),
        RepositoryBuilder.create()
          .withName("legacy-gateway")
          .withCoverage(2, "ERROR")
          .build(),
      ]);

    // when
    await renderPage({ trendService, ownershipService });

    // then
    expect(await screen.findByText("Owned repositories")).toBeInTheDocument();
    const links = await screen.findAllByTitle("Open the repository's page");
    expect(links.map((link) => link.textContent)).toEqual(["legacy-gateway", "billing"]);
  });

  it("should point an unlinked account at the Identities tab instead of an empty list", async () => {
    // given
    // Ownership is a fact about the catalog, and an unlinked account has no
    // entity there to own anything with.
    const trendService = new StubTrendService().withContributorTrend(aFullTrend());
    const ownershipService = new StubOwnershipService().withOwnership(null, []);

    // when
    await renderPage({ trendService, ownershipService });

    // then
    expect(
      await screen.findByRole("link", { name: "Identities tab" }),
    ).toHaveAttribute("href", "/identities");
  });

  it("should say what a linked person was matched against when they own nothing", async () => {
    // given
    const trendService = new StubTrendService().withContributorTrend(aFullTrend());
    const ownershipService = new StubOwnershipService().withOwnership(
      "user:default/jane",
      ["user:default/jane", "group:default/platform"],
    );

    // when
    await renderPage({ trendService, ownershipService });

    // then
    expect(await screen.findByText(/No catalog entity names/u)).toBeInTheDocument();
    expect(
      screen.getByText("Matched against: user:default/jane, group:default/platform."),
    ).toBeInTheDocument();
  });

  it("should ask for a wider range when one is picked, and re-read what is owned", async () => {
    // given
    // Ownership does not move with the window, but the rows are summaries whose
    // health is measured over it.
    const trendService = new StubTrendService().withContributorTrend(aFullTrend());
    const ownershipService = new StubOwnershipService();
    await renderPage({ trendService, ownershipService });
    await waitFor(() => expect(trendService.contributorCalls).toHaveLength(1));

    // when
    fireEvent.change(screen.getByLabelText("Trend range"), {
      target: { value: "months:6" },
    });

    // then
    await waitFor(() => expect(trendService.contributorCalls.length).toBeGreaterThan(1));
    expect(ownershipService.calls.length).toBeGreaterThan(1);
  });
});
