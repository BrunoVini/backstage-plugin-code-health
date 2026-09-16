import { renderInTestApp } from "@backstage/test-utils";
import type {
  IntegrationCapabilities,
  JiraContributorMetrics,
} from "@rios0rios0/backstage-plugin-code-health-common";
import { NO_INTEGRATIONS } from "@rios0rios0/backstage-plugin-code-health-common";
import { screen, fireEvent, within } from "@testing-library/react";
import { ContributorsTable } from "../../../src/presentation/components/contributors_table";
import { rootRouteRef } from "../../../src/routes";
import {
  ContributorBuilder,
  WakaTimeBuilder,
} from "../../builders/contributor_builder";

// Every name now links to the person's page, which the table resolves through
// `useRouteRef` — and that throws outside a Backstage app however the markup is
// wrapped. Mounting the plugin root is what gives the sub route a path to
// resolve against, which is also how the app itself renders the table.
const render = (ui: React.ReactElement) =>
  renderInTestApp(ui, { mountedRoutes: { "/": rootRouteRef } });

/**
 * A seven-day window, so every output figure is a rate over a period the test
 * can reason about. The table needs it because the score divides by it.
 */
const WINDOW = { from: "2026-08-01T00:00:00.000Z", to: "2026-08-08T00:00:00.000Z" };

const ALL_INTEGRATIONS: IntegrationCapabilities = {
  wakatime: true,
  jira: true,
  confluence: true,
};

const jiraMetrics = (
  overrides: Partial<JiraContributorMetrics> = {},
): JiraContributorMetrics => ({
  window: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-08T00:00:00.000Z" },
  issuesCreated: 0,
  issuesResolved: 0,
  interactions: { comments: null, worklogEntries: null, transitions: 0, truncatedIssues: 0 },
  storyPointsEstimated: null,
  storyPointsCompleted: null,
  cycleTime: null,
  leadTime: null,
  resolvedByType: { bug: 0, story: 0, task: 0, epic: 0, other: 0 },
  reopened: 0,
  ...overrides,
});

describe("ContributorsTable", () => {
  it("should link a contributor's name to their page here", async () => {
    // given
    // The name used to lead to the catalog entity, which was the wrong
    // destination once this plugin had something of its own to say about a
    // person. The key carries a colon and a slash, so it has to travel encoded.
    const contributors = [
      ContributorBuilder.create()
        .withDisplayName("Dev Eloper")
        .withKey("user:default/dev_example.com")
        .withEntityRef("user:default/dev_example.com")
        .build(),
    ];

    // when
    await render(
      <ContributorsTable window={WINDOW} contributors={contributors} totalCount={1} isLoading={false} />,
    );

    // then
    expect(screen.getByText("Dev Eloper").closest("a")).toHaveAttribute(
      "href",
      "/contributors/person?key=user%3Adefault%2Fdev_example.com",
    );
  });

  it("should keep the catalog entity as a secondary link", async () => {
    // given
    // The catalog is still where ownership, group membership and the rest of
    // the person's entity live — it is just no longer what the name means.
    // A commit author with no provider account is common on Azure DevOps, so
    // the catalog icon has to stand on its own.
    const contributors = [
      ContributorBuilder.create()
        .withDisplayName("Dev Eloper")
        .withEntityRef("user:default/dev_example.com")
        .withoutProfile()
        .build(),
    ];

    // when
    await render(
      <ContributorsTable window={WINDOW} contributors={contributors} totalCount={1} isLoading={false} />,
    );

    // then
    expect(screen.getByRole("link", { name: "Open in the catalog" })).toHaveAttribute(
      "href",
      "/catalog/default/user/dev_example.com",
    );
    expect(
      screen.queryByRole("link", { name: "Open the provider profile" }),
    ).not.toBeInTheDocument();
  });

  it("should still reach the provider profile of an account with no entity", async () => {
    // given
    // Bots and commits from a personal address resolve to no entity, so the
    // provider profile is the only way out to the account itself — and the row
    // still leads to a page here, because a bot with a history is exactly the
    // row somebody needs to look into.
    const contributors = [
      ContributorBuilder.create()
        .withDisplayName("ci-bot")
        .withKey("vcs:ci-bot")
        .withEntityRef(null)
        .withProfileUrl("https://github.com/ci-bot")
        .build(),
    ];

    // when
    await render(
      <ContributorsTable window={WINDOW} contributors={contributors} totalCount={1} isLoading={false} />,
    );

    // then
    expect(screen.getByText("ci-bot").closest("a")).toHaveAttribute(
      "href",
      "/contributors/person?key=vcs%3Aci-bot",
    );
    expect(
      screen.getByRole("link", { name: "Open the provider profile" }),
    ).toHaveAttribute("href", "https://github.com/ci-bot");
    expect(
      screen.queryByRole("link", { name: "Open in the catalog" }),
    ).not.toBeInTheDocument();
  });

  it("should show initials when the catalog user has no picture", async () => {
    // given
    // Most directories populate a photo for only some of their people; a generic
    // silhouette would make every unphotographed contributor look identical.
    const contributors = [
      ContributorBuilder.create()
        .withDisplayName("Ada Lovelace")
        .withAvatarUrl(null)
        .withEntityRef("user:default/ada")
        .build(),
    ];

    // when
    await render(
      <ContributorsTable window={WINDOW} contributors={contributors} totalCount={1} isLoading={false} />,
    );

    // then
    expect(screen.getByText("AL")).toBeInTheDocument();
  });

  const defaultProps = {
    totalCount: 0,
    isLoading: false,
    window: WINDOW,
  };

  it("should render 'No contributors found.' when contributors is empty", async () => {
    // given / when
    await render(<ContributorsTable {...defaultProps} contributors={[]} />);

    // then
    expect(screen.getByText("No contributors found.")).toBeInTheDocument();
  });

  it("should render loading skeleton when isLoading is true", async () => {
    // given / when
    const { container } = await render(
      <ContributorsTable {...defaultProps} contributors={[]} isLoading />,
    );

    // then
    const skeletonRows = container.querySelectorAll("[data-testid=\"loadingRow\"]");
    expect(skeletonRows.length).toBeGreaterThan(0);
  });

  it("should render contributor rows with avatar, displayName, PR counts, and LOC", async () => {
    // given
    const contributors = [
      ContributorBuilder.create()
        .withDisplayName("alice")
        .withReviewsApproved(8)
        .withLinesOfCode(5000)
        .build(),
    ];

    // when
    await render(
      <ContributorsTable
        window={WINDOW}
        contributors={contributors}
        totalCount={1}
        isLoading={false}
      />,
    );

    // then
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("5,000")).toBeInTheDocument();
  });

  it("should render approval rate with green color for rate >= 80", async () => {
    // given
    const contributors = [
      ContributorBuilder.create().withPrApprovalRate(85).build(),
    ];

    // when
    await render(
      <ContributorsTable
        window={WINDOW}
        contributors={contributors}
        totalCount={1}
        isLoading={false}
      />,
    );

    // then
    const rateEl = screen.getByText("85.0%");
    expect(rateEl.getAttribute("data-tone")).toBe("good");
  });

  it("should render approval rate with yellow color for rate >= 50 and < 80", async () => {
    // given
    const contributors = [
      ContributorBuilder.create().withPrApprovalRate(65).build(),
    ];

    // when
    await render(
      <ContributorsTable
        window={WINDOW}
        contributors={contributors}
        totalCount={1}
        isLoading={false}
      />,
    );

    // then
    const rateElements = screen.getAllByText("65.0%");
    const approvalRateEl = rateElements[0];
    expect(approvalRateEl.getAttribute("data-tone")).toBe("fair");
  });

  it("should render approval rate with red color for rate < 50", async () => {
    // given
    const contributors = [
      ContributorBuilder.create().withPrApprovalRate(30).build(),
    ];

    // when
    await render(
      <ContributorsTable
        window={WINDOW}
        contributors={contributors}
        totalCount={1}
        isLoading={false}
      />,
    );

    // then
    const rateElements = screen.getAllByText("30.0%");
    const approvalRateEl = rateElements[0];
    expect(approvalRateEl.getAttribute("data-tone")).toBe("poor");
  });

  it("should show the WakaTime columns when the integration is configured", async () => {
    // given
    // Driven by configuration, not by the data: a WakaTime that was switched on
    // this morning has collected nothing until the nightly pass, and hiding its
    // columns until then makes a working install look broken.
    const contributors = [
      ContributorBuilder.create()
        .withDisplayName("alice")
        .withWakaTimeMetrics(WakaTimeBuilder.create().withTotalSeconds(3600).build())
        .build(),
    ];

    // when
    await render(
      <ContributorsTable
        window={WINDOW}
        contributors={contributors}
        totalCount={1}
        isLoading={false}
        capabilities={{ ...NO_INTEGRATIONS, wakatime: true }}
      />,
    );

    // then
    expect(screen.getByText("Coding time")).toBeInTheDocument();
    expect(screen.getByText("Active days")).toBeInTheDocument();
    expect(screen.getByText("Branches")).toBeInTheDocument();
    expect(screen.getByText("1h")).toBeInTheDocument();
  });

  it("should show the WakaTime columns even before anything was collected", async () => {
    // given
    const contributors = [ContributorBuilder.create().build()];

    // when
    await render(
      <ContributorsTable
        window={WINDOW}
        contributors={contributors}
        totalCount={1}
        isLoading={false}
        capabilities={{ ...NO_INTEGRATIONS, wakatime: true }}
      />,
    );

    // then
    expect(screen.getByText("Coding time")).toBeInTheDocument();
    // And the cells read as unmeasured rather than as zero hours worked.
    expect(screen.getAllByText("-").length).toBeGreaterThan(0);
  });

  it("should show the AI columns only once a row actually carries them", async () => {
    // given
    // The AI figures are collected separately and opting out of them is a
    // supported way to run WakaTime, so a screen of em dashes would read as a
    // fault rather than as a choice.
    const withAi = ContributorBuilder.create()
      .withDisplayName("alice")
      .withWakaTimeMetrics(
        WakaTimeBuilder.create()
          .withAi({ inputTokens: 1200, outputTokens: 300, linesAddedByAi: 30, linesAddedByHuman: 70 })
          .build(),
      )
      .build();
    const withoutAi = ContributorBuilder.create()
      .withDisplayName("bob")
      .withWakaTimeMetrics(WakaTimeBuilder.create().build())
      .build();
    const capabilities = { ...NO_INTEGRATIONS, wakatime: true };

    // when
    const { rerender } = await render(
      <ContributorsTable
        window={WINDOW}
        contributors={[withoutAi]}
        totalCount={1}
        isLoading={false}
        capabilities={capabilities}
      />,
    );

    // then
    expect(screen.queryByText("AI tokens")).not.toBeInTheDocument();

    // when
    rerender(
      <ContributorsTable
        window={WINDOW}
        contributors={[withAi]}
        totalCount={1}
        isLoading={false}
        capabilities={capabilities}
      />,
    );

    // then
    expect(screen.getByText("AI tokens")).toBeInTheDocument();
    expect(screen.getByText("1.5k")).toBeInTheDocument();
    expect(screen.getByText("30%")).toBeInTheDocument();
  });

  it("should hide the WakaTime columns when the integration is not configured", async () => {
    // given
    const contributors = [
      ContributorBuilder.create()
        .withWakaTimeMetrics(WakaTimeBuilder.create().build())
        .build(),
    ];

    // when
    await render(
      <ContributorsTable window={WINDOW} contributors={contributors} totalCount={1} isLoading={false} />,
    );

    // then
    expect(screen.queryByText("Coding time")).not.toBeInTheDocument();
  });

  it("should name the systems merged onto one row", async () => {
    // given
    // A total nobody can trace back to its sources is a number nobody trusts.
    const contributor = ContributorBuilder.create()
      .withDisplayName("alice")
      .withIdentities([
        { source: "vcs", sourceKey: "alice@example.com", displayName: "Alice" },
        { source: "wakatime", sourceKey: "alice", displayName: null },
      ])
      .build();

    // when
    await render(
      <ContributorsTable window={WINDOW} contributors={[contributor]} totalCount={1} isLoading={false} />,
    );

    // then
    expect(screen.getByText("vcs · wakatime")).toBeInTheDocument();
  });

  it("should render contributor count", async () => {
    // given
    const contributors = [
      ContributorBuilder.create().withDisplayName("a").build(),
      ContributorBuilder.create().withDisplayName("b").build(),
    ];

    // when
    await render(
      <ContributorsTable
        window={WINDOW}
        contributors={contributors}
        totalCount={5}
        isLoading={false}
      />,
    );

    // then
    expect(screen.getByText(/2 of 5 contributors/)).toBeInTheDocument();
  });

  it("should show a dash in every Sonar cell of a contributor with no metrics", async () => {
    // given
    const contributors = [
      ContributorBuilder.create().withDisplayName("unmeasured").build(),
    ];
    const sonarHeaders = ["Bugs", "Smells", "Vulns", "Hotspots", "Coverage", "Dups", "Debt"];

    // when
    await render(<ContributorsTable {...defaultProps} contributors={contributors} totalCount={1} />);

    // then
    const headerCells = screen.getAllByRole("columnheader");
    const dataCells = within(screen.getAllByRole("row")[2]).getAllByRole("cell");
    for (const header of sonarHeaders) {
      const index = headerCells.findIndex((cell) => cell.textContent?.includes(header));
      expect(dataCells[index]).toHaveTextContent("-");
    }
  });

  it("should render coverage, duplications and debt when Sonar measured the contributor", async () => {
    // given
    const contributors = [
      ContributorBuilder.create()
        .withDisplayName("measured")
        .withSonarMetrics({
          bugs: 1,
          codeSmells: 2,
          securityHotspots: 3,
          vulnerabilities: 4,
          coverage: 87.5,
          duplications: 3.25,
          technicalDebt: "2h 15min",
          technicalDebtMinutes: 135,
          qualityGateStatus: "OK",
        })
        .build(),
    ];

    // when
    await render(<ContributorsTable {...defaultProps} contributors={contributors} totalCount={1} />);

    // then
    expect(screen.getByText("87.5%")).toBeInTheDocument();
    expect(screen.getByText("3.3%")).toBeInTheDocument();
    expect(screen.getByText("2h 15min")).toBeInTheDocument();
  });

  it("should leave the WakaTime cells empty for a contributor with no tracked time", async () => {
    // given
    const tracked = ContributorBuilder.create().withDisplayName("tracked").build();
    const untracked = ContributorBuilder.create().withDisplayName("untracked").build();
    const contributors = [
      {
        ...tracked,
        wakaTimeMetrics: WakaTimeBuilder.create().withTotalSeconds(9000).build(),
      },
      untracked,
    ];

    // when
    await render(
      <ContributorsTable
        {...defaultProps}
        contributors={contributors}
        totalCount={2}
        capabilities={{ ...NO_INTEGRATIONS, wakatime: true }}
      />,
    );

    // then
    expect(screen.getByText("2h 30m")).toBeInTheDocument();
    // The untracked row reads as unmeasured, never as zero hours worked.
    expect(screen.getAllByText("-").length).toBeGreaterThan(0);
  });

  it("should page through more contributors than fit on one page", async () => {
    // given
    const contributors = Array.from({ length: 30 }, (_, index) =>
      ContributorBuilder.create()
        .withDisplayName(`user-${String(index).padStart(2, "0")}`)
        .withLinesOfCode(index)
        .build(),
    );
    await render(
      <ContributorsTable {...defaultProps} contributors={contributors} totalCount={30} />,
    );

    // when
    fireEvent.click(screen.getByText("Next"));

    // then
    expect(screen.getByText("2 / 2")).toBeInTheDocument();

    // when
    fireEvent.click(screen.getByText("Previous"));

    // then
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
  });

  it("should offer the same page sizes as the repositories table, on one page or ten", async () => {
    // given
    // Under twenty-five people the controls used to vanish, which on any fleet
    // with more repositories than people read as a table that did not page.
    const contributors = Array.from({ length: 12 }, (_, index) =>
      ContributorBuilder.create()
        .withDisplayName(`user-${String(index).padStart(2, "0")}`)
        .withLinesOfCode(index)
        .build(),
    );
    await render(
      <ContributorsTable {...defaultProps} contributors={contributors} totalCount={12} />,
    );
    expect(screen.getByText("1 / 1")).toBeInTheDocument();

    // when
    fireEvent.change(screen.getByLabelText("Rows per page"), { target: { value: "10" } });

    // then
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(12);
  });
});

describe("ContributorsTable churn and pull request columns", () => {
  it("should show net lines with the additions and deletions underneath", async () => {
    // given
    const contributors = [ContributorBuilder.create().withDisplayName("Dev").build()];

    // when
    await render(
      <ContributorsTable window={WINDOW} contributors={contributors} totalCount={1} isLoading={false} />,
    );

    // then
    expect(screen.getByText("+700")).toBeInTheDocument();
    expect(screen.getByText("-300")).toBeInTheDocument();
  });

  it("should count files when the provider reported no line counts", async () => {
    // given
    // Azure DevOps carries added, edited and deleted *files* and exposes no
    // line count anywhere in its REST API, so a lines column against an Azure
    // DevOps fleet reads zero on every row.
    const contributors = [
      ContributorBuilder.create().withDisplayName("Dev").withFileChurn(42).build(),
    ];

    // when
    await render(
      <ContributorsTable window={WINDOW} contributors={contributors} totalCount={1} isLoading={false} />,
    );

    // then
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("files changed")).toBeInTheDocument();
    expect(screen.queryByText("+0")).not.toBeInTheDocument();
  });

  it("should show nothing at all when the provider reported no churn", async () => {
    // given
    const contributors = [
      ContributorBuilder.create().withDisplayName("Dev").withoutChurn().build(),
    ];

    // when
    await render(
      <ContributorsTable window={WINDOW} contributors={contributors} totalCount={1} isLoading={false} />,
    );

    // then
    // "The provider said zero" and "the provider never said" are different
    // facts, and printing 0 for the second is the bug this cell prevents.
    expect(screen.queryByText("files changed")).not.toBeInTheDocument();
    expect(screen.queryByText("+0")).not.toBeInTheDocument();
  });

  it("should report created pull requests apart from reviewed ones", async () => {
    // given
    const contributors = [
      ContributorBuilder.create()
        .withDisplayName("Dev")
        .withPullRequests(14, 11)
        .build(),
    ];

    // when
    await render(
      <ContributorsTable window={WINDOW} contributors={contributors} totalCount={1} isLoading={false} />,
    );

    // then
    // The old single column read "Approved PRs" over a review count, which is
    // not the person's own pull requests at all.
    expect(screen.getByText("PRs created")).toBeInTheDocument();
    expect(screen.getByText("PRs approved")).toBeInTheDocument();
    expect(screen.getByText("/ 11 merged")).toBeInTheDocument();
    expect(screen.getByText("/ 10 reviewed")).toBeInTheDocument();
  });

  it("should explain the approval rate and the pipeline column", async () => {
    // given
    const contributors = [ContributorBuilder.create().build()];

    // when
    await render(
      <ContributorsTable window={WINDOW} contributors={contributors} totalCount={1} isLoading={false} />,
    );

    // then
    // Both divide two numbers the heading does not name, and a reader who
    // guesses wrong reads the column backwards.
    expect(
      screen.getByRole("img", { name: /the share they approved/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: /never to whoever pressed the merge button/ }),
    ).toBeInTheDocument();
  });

  it("should show the pipeline counts over the runs that reached a verdict", async () => {
    // given
    // Cancelled and skipped runs are neither, so the denominator is not the
    // number of runs.
    const contributors = [
      ContributorBuilder.create().withPipelineRuns({ runs: 10, succeeded: 6, failed: 2 }).build(),
    ];

    // when
    await render(
      <ContributorsTable window={WINDOW} contributors={contributors} totalCount={1} isLoading={false} />,
    );

    // then
    expect(screen.getByText("(6/8)")).toBeInTheDocument();
  });

  it("should say on every Sonar heading that the figure is the repository's, not the person's", async () => {
    // given
    const contributors = [ContributorBuilder.create().build()];

    // when
    await render(
      <ContributorsTable window={WINDOW} contributors={contributors} totalCount={1} isLoading={false} />,
    );

    // then
    // Seven Sonar columns, one explanation each: a number in a "Bugs" column
    // on a row carrying a name reads as that person's bugs.
    expect(
      screen.getAllByRole("img", { name: /Sonar measures a repository, not a person/ }),
    ).toHaveLength(7);
  });
});

describe("ContributorsTable productivity column", () => {
  it("should read every figure against the top one anybody recorded", async () => {
    // given
    // Half the commits and half the churn of the person above them, on a fleet
    // of two — so the score has to come out below theirs rather than against
    // some invented "forty commits is a good month".
    const contributors = [
      ContributorBuilder.create()
        .withDisplayName("busy")
        .withCommits(40)
        .withLinesOfCode(4000)
        .build(),
      ContributorBuilder.create()
        .withDisplayName("quiet")
        .withCommits(20)
        .withLinesOfCode(2000)
        .build(),
    ];

    // when
    await render(
      <ContributorsTable window={WINDOW} contributors={contributors} totalCount={2} isLoading={false} />,
    );

    // then
    const scores = screen
      .getAllByRole("row")
      .slice(2)
      .map((row) => within(row).getAllByRole("cell")[1].textContent);
    expect(Number(scores[0])).toBeGreaterThan(Number(scores[1]));
  });

  it("should band the score and show the workings behind it", async () => {
    // given
    // A score on a row carrying somebody's name is an accusation with no
    // evidence until a reader can see which figure pulled it down.
    //
    // Two rows, because the output half of the score is now read against the
    // team's average rate: one person alone is that average by definition and
    // lands mid-band however hard they worked. The leader here is well above
    // it, which is what a "good" band has to mean.
    const contributors = [
      ContributorBuilder.create()
        .withDisplayName("leader")
        .withKey("vcs:leader")
        .withCommits(20)
        .withPullRequests(10, 10)
        .withReviewsGiven(10)
        .withLinesOfCode(1000)
        .withPipelineRuns({ runs: 10, succeeded: 9, failed: 1 })
        .build(),
      ContributorBuilder.create()
        .withDisplayName("quiet")
        .withKey("vcs:quiet")
        .withCommits(1)
        .withPullRequests(1, 1)
        .withReviewsGiven(1)
        .withLinesOfCode(10)
        .build(),
    ];

    // when
    await render(
      <ContributorsTable
        window={WINDOW}
        contributors={contributors}
        totalCount={2}
        isLoading={false}
      />,
    );

    // then
    const cell = within(screen.getAllByRole("row")[2]).getAllByRole("cell")[1];
    const score = within(cell).getByText(/^\d+$/u);
    expect(score).toHaveAttribute("data-band", "good");
    expect(score.closest("[title]")?.getAttribute("title")).toContain(
      "9 of 10 decided runs succeeded",
    );
  });

  it("should band the only person measured as average rather than as excellent", async () => {
    // given
    // Being the sole row is not an achievement: they are the team average, and
    // the old top-figure reference used to hand them full marks for it.
    const contributors = [ContributorBuilder.create().withDisplayName("solo").build()];

    // when
    await render(
      <ContributorsTable
        window={WINDOW}
        contributors={contributors}
        totalCount={1}
        isLoading={false}
      />,
    );

    // then
    const cell = within(screen.getAllByRole("row")[2]).getAllByRole("cell")[1];
    expect(within(cell).getByText(/^\d+$/u)).toHaveAttribute("data-band", "fair");
  });

  it("should show a dash rather than a zero when nothing could be measured", async () => {
    // given
    // Nobody recorded anything in the window, which says nothing about anyone —
    // and a zero would say a great deal.
    const contributors = [
      ContributorBuilder.create()
        .withDisplayName("idle")
        .withCommits(0)
        .withPullRequests(0, 0)
        .withReviewsGiven(0)
        .withoutChurn()
        .withPipelineRuns({ runs: 0, succeeded: 0, failed: 0 })
        .build(),
    ];

    // when
    await render(
      <ContributorsTable window={WINDOW} contributors={contributors} totalCount={1} isLoading={false} />,
    );

    // then
    const cell = within(screen.getAllByRole("row")[2]).getAllByRole("cell")[1];
    expect(cell).toHaveTextContent("—");
  });

  it("should sort on the score", async () => {
    // given
    const contributors = [
      ContributorBuilder.create().withDisplayName("quiet").withCommits(2).build(),
      ContributorBuilder.create().withDisplayName("busy").withCommits(90).build(),
    ];
    await render(
      <ContributorsTable window={WINDOW} contributors={contributors} totalCount={2} isLoading={false} />,
    );
    const leadingName = () =>
      within(screen.getAllByRole("row")[2]).getAllByRole("cell")[0].textContent;

    // when
    // A numeric column leads with its highest, which is what somebody looking
    // for the strongest quarter expects to see first.
    fireEvent.click(screen.getByText("Productivity"));

    // then
    expect(leadingName()).toContain("busy");

    // when
    fireEvent.click(screen.getByText("Productivity"));

    // then
    expect(leadingName()).toContain("quiet");
  });

  it("should explain what the score is composed of on its heading", async () => {
    // given
    const contributors = [ContributorBuilder.create().build()];

    // when
    await render(
      <ContributorsTable window={WINDOW} contributors={contributors} totalCount={1} isLoading={false} />,
    );

    // then
    expect(
      screen.getByRole("img", { name: /against the team's average rate over the same period/u }),
    ).toBeInTheDocument();
  });

  it("should name the components on the heading, and only the configured ones", async () => {
    // given
    const contributors = [ContributorBuilder.create().build()];

    // when
    await render(
      <ContributorsTable
        window={WINDOW}
        contributors={contributors}
        totalCount={1}
        isLoading={false}
        capabilities={ALL_INTEGRATIONS}
      />,
    );

    // then
    // Read off the same definitions the score is folded from, so the heading
    // cannot name a component this install does not score on — nor go stale
    // when the weights are shared out differently.
    expect(
      screen.getByRole("img", {
        name: /Coding time, Tickets resolved, Tickets that stayed done and Documentation written/u,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: /shared out over whatever is configured/u }),
    ).toBeInTheDocument();
  });

  it("should leave the integration components off the heading when none is configured", async () => {
    // given
    const contributors = [ContributorBuilder.create().build()];

    // when
    await render(
      <ContributorsTable window={WINDOW} contributors={contributors} totalCount={1} isLoading={false} />,
    );

    // then
    expect(screen.queryByRole("img", { name: /Coding time/u })).not.toBeInTheDocument();
  });

  it("should score on the integrations the caller says are configured", async () => {
    // given
    // The row carries the same Jira figures either way. Whether they count is a
    // fact about the backend's configuration, and the row cannot answer it.
    const contributors = [
      ContributorBuilder.create()
        .withDisplayName("dev")
        .withJiraMetrics(jiraMetrics({ issuesResolved: 4, reopened: 2 }))
        .build(),
    ];
    const scoreText = () =>
      within(screen.getAllByRole("row")[2]).getAllByRole("cell")[1].textContent;

    // when
    const off = await render(
      <ContributorsTable window={WINDOW} contributors={contributors} totalCount={1} isLoading={false} />,
    );
    const withoutJira = scoreText();
    off.unmount();
    await render(
      <ContributorsTable
        window={WINDOW}
        contributors={contributors}
        totalCount={1}
        isLoading={false}
        capabilities={{ ...NO_INTEGRATIONS, jira: true }}
      />,
    );

    // then
    // Half of what they resolved came back, which the score only knows about
    // once somebody has told it Jira is switched on — and which pulls the
    // number down when it does. The absolute figure is lower than it used to
    // be on both sides because the only row measured is the team average.
    expect(withoutJira).toBe("57");
    expect(Number(scoreText())).toBeLessThan(Number(withoutJira));
  });
});

describe("ContributorsTable header tooltips", () => {
  it("should make every help tooltip reachable from the keyboard", async () => {
    // given
    const contributors = [ContributorBuilder.create().build()];

    // when
    await render(
      <ContributorsTable window={WINDOW} contributors={contributors} totalCount={1} isLoading={false} />,
    );

    // then
    // Two separate failures are guarded here. An icon with no accessible name
    // is stamped `aria-hidden` by `SvgIcon`, so a screen reader is told to skip
    // it however it is labelled — `getAllByRole` would find nothing at all. And
    // an SVG has no focus event of its own, so without a tab stop the tooltip
    // never opens for anybody not using a pointer.
    // Scoped to the headings: a contributor avatar is an `img` too, and so are
    // the two icons that link a row out to the catalog and to the provider.
    const helps = screen
      .getAllByRole("columnheader")
      .flatMap((header) => within(header).queryAllByRole("img"))
      .filter((element) => element.tagName.toLowerCase() === "svg");
    // Productivity, five rate and count columns, and the seven Sonar columns
    // that share one explanation.
    expect(helps).toHaveLength(13);
    for (const help of helps) {
      expect(help).toHaveAttribute("tabindex", "0");
      expect(help).not.toHaveAttribute("aria-hidden", "true");
    }
  });

  it("should not promise a negative churn figure it cannot show", async () => {
    // given
    const contributors = [ContributorBuilder.create().build()];

    // when
    await render(
      <ContributorsTable window={WINDOW} contributors={contributors} totalCount={1} isLoading={false} />,
    );

    // then
    // `linesOfCode` is floored at zero, so wording that implies a negative net
    // is describing a value the column can never render.
    expect(screen.getByRole("img", { name: /floored at zero/ })).toBeInTheDocument();
  });
});
