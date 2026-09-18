import { renderInTestApp } from "@backstage/test-utils";
import type {
  ContributorFleetRates,
  IntegrationCapabilities,
} from "@rios0rios0/backstage-plugin-code-health-common";
import { NO_INTEGRATIONS } from "@rios0rios0/backstage-plugin-code-health-common";
import { screen, within } from "@testing-library/react";
import { ContributorRatesCard } from "../../../src/presentation/components/contributor_rates_card";
import { ContributorBuilder, WakaTimeBuilder } from "../../builders/contributor_builder";

/** Thirty days, so a daily rate is a thirtieth of the total and a monthly one just over it. */
const THIRTY_DAYS = {
  from: "2026-08-01T00:00:00.000Z",
  to: "2026-08-31T00:00:00.000Z",
};

const ALL_INTEGRATIONS: IntegrationCapabilities = {
  wakatime: true,
  jira: true,
  confluence: true,
};

const jiraMetrics = {
  window: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-31T00:00:00.000Z" },
  issuesCreated: 3,
  issuesResolved: 15,
  interactions: { comments: 2, worklogEntries: 1, transitions: 4, truncatedIssues: 0 },
  storyPointsEstimated: null,
  storyPointsCompleted: null,
  cycleTime: null,
  leadTime: null,
  resolvedByType: { bug: 5, story: 5, task: 5, epic: 0, other: 0 },
  reopened: 0,
};

/** A team averaging four fifths of a commit a day, with nobody on WakaTime. */
const aFleet = (overrides: Partial<ContributorFleetRates> = {}): ContributorFleetRates => ({
  days: 30,
  people: 4,
  commits: 0.8,
  pullRequestsOpened: 0.5,
  pullRequestsMerged: 0.25,
  reviewsGiven: 1,
  linesOfCode: 20,
  changedFiles: null,
  pipelineRuns: 0.4,
  codingSeconds: null,
  issuesResolved: 1,
  ...overrides,
});

const renderCard = (props: Partial<React.ComponentProps<typeof ContributorRatesCard>> = {}) =>
  renderInTestApp(
    <ContributorRatesCard
      summary={ContributorBuilder.create().withCommits(30).build()}
      window={THIRTY_DAYS}
      capabilities={NO_INTEGRATIONS}
      fleet={null}
      {...props}
    />,
  );

/** The row whose first cell carries the label, or undefined when the card has none. */
const rowLabelled = (label: string): HTMLElement | undefined =>
  screen
    .getAllByRole("row")
    .find((row) => within(row).queryAllByRole("cell")[0]?.textContent === label);

const cellsOn = (label: string): HTMLElement[] => {
  const row = rowLabelled(label);
  if (row === undefined) throw new Error(`no row labelled ${label}`);
  return within(row).getAllByRole("cell").slice(1);
};

/** The per-day, per-week and per-month figures printed on a row. */
const figuresOn = (label: string): string[] =>
  cellsOn(label)
    .slice(0, 3)
    .map((cell) => cell.querySelector("[data-figure]")?.textContent ?? "");

/** The team's figures printed under the person's, per period. */
const teamFiguresOn = (label: string): string[] =>
  cellsOn(label)
    .slice(0, 3)
    .map((cell) => within(cell).getByText(/^team /u).textContent?.replace(/^team /u, "") ?? "");

/** What the last column says about the row against the team. */
const comparisonOn = (label: string): string => cellsOn(label)[3]?.textContent ?? "";

describe("ContributorRatesCard", () => {
  it("should divide each total by the days the range spans, for a day, a week and a month", async () => {
    // given
    // Thirty commits over thirty days: one a day, seven a week, and a mean
    // Gregorian month's worth — 30.44 — rather than thirty, so twelve monthly
    // figures add back up to a year.
    await renderCard();

    // when
    const figures = figuresOn("Commits");

    // then
    expect(figures).toEqual(["1", "7", "30.4"]);
    expect(screen.getByText(/divided by the 30 days this range spans/u)).toBeInTheDocument();
  });

  it("should group every figure past a thousand, the team's average and the comparison with it", async () => {
    // given
    // The monthly column is where this bites: 9,180 commits over thirty days
    // is 9,313.9 a month, which ungrouped is five digits a reader counts
    // rather than reads — and the team's 24.4 beneath it turns the comparison
    // into a counting exercise. The delta has no ceiling either: against a
    // team averaging four fifths of a commit a day, 306 a day is well past a
    // thousand percent.
    await renderCard({
      summary: ContributorBuilder.create().withCommits(9180).build(),
      fleet: aFleet(),
    });

    // when
    const figures = figuresOn("Commits");

    // then
    expect(figures).toEqual(["306", "2,142", "9,313.9"]);
    expect(teamFiguresOn("Commits")).toEqual(["0.8", "5.6", "24.4"]);
    expect(comparisonOn("Commits")).toBe("38,150% above the team");
  });

  it("should print the team's figure under each of the person's, in the same period", async () => {
    // given
    // The comparison is right beneath the number rather than across the row,
    // so a reader never carries a figure from one column to another by hand.
    await renderCard({ fleet: aFleet() });

    // when
    const team = within(rowLabelled("Commits") as HTMLElement).getAllByText(/^team /u);

    // then
    expect(team.map((element) => element.textContent)).toEqual([
      "team 0.8",
      "team 5.6",
      "team 24.4",
    ]);
  });

  it("should say how far above or below the team each rate sits", async () => {
    // given
    // One commit a day against the team's four fifths is a quarter above;
    // eight merged pull requests over thirty days is 0.27 a day against 0.25,
    // which rounds to seven percent above.
    await renderCard({ fleet: aFleet() });

    // when / then
    expect(comparisonOn("Commits")).toBe("25% above the team");
    expect(comparisonOn("Pull requests merged")).toBe("7% above the team");
    expect(comparisonOn("Reviews given")).toBe("67% below the team");
    expect(screen.getByText("25% above the team")).toHaveAttribute("data-direction", "above");
    expect(screen.getByText("67% below the team")).toHaveAttribute("data-direction", "below");
  });

  it("should call a rate that matches the team level", async () => {
    // given
    await renderCard({
      summary: ContributorBuilder.create().withCommits(24).build(),
      fleet: aFleet(),
    });

    // when / then
    expect(comparisonOn("Commits")).toBe("level with the team");
  });

  it("should print an em dash where the team has no average for a row", async () => {
    // given
    // A team in which nobody has WakaTime linked has no average coding time;
    // a zero would report a team that never opens an editor, and comparing
    // against nothing says nothing.
    await renderCard({
      summary: ContributorBuilder.create()
        .withWakaTimeMetrics(WakaTimeBuilder.create().withTotalSeconds(108_000).build())
        .build(),
      capabilities: ALL_INTEGRATIONS,
      fleet: aFleet(),
    });

    // when / then
    expect(figuresOn("Coding time")).toEqual(["1h", "7h", "30h 26m"]);
    expect(teamFiguresOn("Coding time")).toEqual(["—", "—", "—"]);
    expect(comparisonOn("Coding time")).toBe("—");
  });

  it("should say who the team is", async () => {
    // given / when
    await renderCard({ fleet: aFleet({ people: 4 }) });

    // then
    expect(
      screen.getByText(/The team is the 4 people measured in this range/u),
    ).toBeInTheDocument();
  });

  it("should say so, and compare nothing, when no team average was sent", async () => {
    // given
    // A backend from before the fleet rates sends none, and the card has to
    // read that as nothing to compare against rather than as a team of zero.
    await renderCard({ fleet: null });

    // when / then
    expect(comparisonOn("Commits")).toBe("—");
    expect(teamFiguresOn("Commits")).toEqual(["—", "—", "—"]);
    expect(screen.getByText(/No team average was sent for this range/u)).toBeInTheDocument();
  });

  it("should print an em dash where a figure was never measured and a zero where nothing happened", async () => {
    // given
    // A provider that reports no churn has not reported a churn of nothing,
    // while no commits in the range is a real measurement of none.
    await renderCard({
      summary: ContributorBuilder.create().withCommits(0).withoutChurn().build(),
      fleet: aFleet(),
    });

    // when
    const commits = figuresOn("Commits");
    const churn = figuresOn("Churn");

    // then
    expect(commits).toEqual(["0", "0", "0"]);
    expect(churn).toEqual(["—", "—", "—"]);
    expect(comparisonOn("Commits")).toBe("100% below the team");
    expect(comparisonOn("Churn")).toBe("—");
  });

  it("should name the churn row after the unit the provider reported, and compare it in that unit", async () => {
    // given
    // Azure DevOps reports changed files and no line count; the row has to say
    // which of the two it is printing rather than calling both "churn", and a
    // files figure is never held up against a mean of lines.
    await renderCard({
      summary: ContributorBuilder.create().withFileChurn(60).build(),
      fleet: aFleet({ changedFiles: 1 }),
    });

    // when
    const files = figuresOn("Files changed");

    // then
    expect(files).toEqual(["2", "14", "60.9"]);
    expect(comparisonOn("Files changed")).toBe("100% above the team");
    expect(rowLabelled("Net lines")).toBeUndefined();
  });

  it("should list coding time and tickets only for the integrations configured", async () => {
    // given
    // Thirty hours over thirty days is an hour a day, said as a duration rather
    // than as a count of seconds; fifteen tickets is one every other day.
    await renderCard({
      summary: ContributorBuilder.create()
        .withWakaTimeMetrics(WakaTimeBuilder.create().withTotalSeconds(108_000).build())
        .withJiraMetrics(jiraMetrics)
        .build(),
      capabilities: ALL_INTEGRATIONS,
      fleet: aFleet({ codingSeconds: 1800 }),
    });

    // when
    const codingTime = figuresOn("Coding time");
    const tickets = figuresOn("Tickets resolved");

    // then
    expect(codingTime).toEqual(["1h", "7h", "30h 26m"]);
    expect(teamFiguresOn("Coding time")).toEqual(["30m", "3h 30m", "15h 13m"]);
    expect(comparisonOn("Coding time")).toBe("100% above the team");
    expect(tickets).toEqual(["0.5", "3.5", "15.2"]);
    expect(comparisonOn("Tickets resolved")).toBe("50% below the team");
  });

  it("should leave the integration rows out when nothing is configured", async () => {
    // given
    // Gated on configuration, not on the row: a row carrying coding time on an
    // install with WakaTime switched off is not a reason to draw the row.
    await renderCard({
      summary: ContributorBuilder.create()
        .withWakaTimeMetrics(WakaTimeBuilder.create().build())
        .withJiraMetrics(jiraMetrics)
        .build(),
      capabilities: NO_INTEGRATIONS,
    });

    // when
    const codingTime = rowLabelled("Coding time");
    const tickets = rowLabelled("Tickets resolved");

    // then
    expect(codingTime).toBeUndefined();
    expect(tickets).toBeUndefined();
  });

  it("should print an em dash for a configured integration the person has no account on", async () => {
    // given
    // WakaTime is on, but nobody has linked an account to this person: the
    // figure is unmeasured, not zero.
    await renderCard({
      summary: ContributorBuilder.create().withJiraMetrics(null).build(),
      capabilities: ALL_INTEGRATIONS,
    });

    // when
    const codingTime = figuresOn("Coding time");
    const tickets = figuresOn("Tickets resolved");

    // then
    expect(codingTime).toEqual(["—", "—", "—"]);
    expect(tickets).toEqual(["—", "—", "—"]);
  });

  it("should say why documentation is not listed only when Confluence is configured", async () => {
    // given
    // Confluence is stored per trailing window rather than per day, so its
    // figures are not a rate of the range picked; the caption says so rather
    // than leaving a reader to wonder where the row went — but only on an
    // install that has Confluence at all.
    await renderCard({ capabilities: ALL_INTEGRATIONS });

    // when
    const explanation = screen.queryByText(/Documentation written is not listed/u);

    // then
    expect(explanation).toBeInTheDocument();
  });

  it("should not mention documentation when Confluence is not configured", async () => {
    // given / when
    await renderCard({ capabilities: NO_INTEGRATIONS });

    // then
    expect(screen.queryByText(/Documentation written is not listed/u)).not.toBeInTheDocument();
  });
});
