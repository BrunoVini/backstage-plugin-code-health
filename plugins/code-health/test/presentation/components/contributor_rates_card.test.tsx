import { renderInTestApp } from "@backstage/test-utils";
import type { IntegrationCapabilities } from "@rios0rios0/backstage-plugin-code-health-common";
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

const renderCard = (props: Partial<React.ComponentProps<typeof ContributorRatesCard>> = {}) =>
  renderInTestApp(
    <ContributorRatesCard
      summary={ContributorBuilder.create().withCommits(30).build()}
      window={THIRTY_DAYS}
      capabilities={NO_INTEGRATIONS}
      {...props}
    />,
  );

/** The row whose first cell carries the label, or undefined when the card has none. */
const rowLabelled = (label: string): HTMLElement | undefined =>
  screen
    .getAllByRole("row")
    .find((row) => within(row).queryAllByRole("cell")[0]?.textContent === label);

/** The per-day, per-week and per-month figures printed on a row. */
const figuresOn = (label: string): string[] => {
  const row = rowLabelled(label);
  if (row === undefined) throw new Error(`no row labelled ${label}`);
  return within(row)
    .getAllByRole("cell")
    .slice(1)
    .map((cell) => cell.textContent ?? "");
};

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

  it("should print an em dash where a figure was never measured and a zero where nothing happened", async () => {
    // given
    // A provider that reports no churn has not reported a churn of nothing,
    // while no commits in the range is a real measurement of none.
    await renderCard({
      summary: ContributorBuilder.create().withCommits(0).withoutChurn().build(),
    });

    // when
    const commits = figuresOn("Commits");
    const churn = figuresOn("Churn");

    // then
    expect(commits).toEqual(["0", "0", "0"]);
    expect(churn).toEqual(["—", "—", "—"]);
  });

  it("should name the churn row after the unit the provider reported", async () => {
    // given
    // Azure DevOps reports changed files and no line count; the row has to say
    // which of the two it is printing rather than calling both "churn".
    await renderCard({
      summary: ContributorBuilder.create().withFileChurn(60).build(),
    });

    // when
    const files = figuresOn("Files changed");

    // then
    expect(files).toEqual(["2", "14", "60.9"]);
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
    });

    // when
    const codingTime = figuresOn("Coding time");
    const tickets = figuresOn("Tickets resolved");

    // then
    expect(codingTime).toEqual(["1h", "7h", "30h 26m"]);
    expect(tickets).toEqual(["0.5", "3.5", "15.2"]);
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
