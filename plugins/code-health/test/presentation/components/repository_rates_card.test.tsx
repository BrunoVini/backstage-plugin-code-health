import { renderInTestApp } from "@backstage/test-utils";
import type {
  IntegrationCapabilities,
  JiraRepositoryMetrics,
  RepositoryFleetRates,
} from "@rios0rios0/backstage-plugin-code-health-common";
import {
  EMPTY_JIRA_ISSUE_TYPES,
  NO_INTEGRATIONS,
} from "@rios0rios0/backstage-plugin-code-health-common";
import { screen, within } from "@testing-library/react";
import { RepositoryRatesCard } from "../../../src/presentation/components/repository_rates_card";
import { RepositoryBuilder } from "../../builders/repository_builder";

/** Thirty days, so a daily rate is a thirtieth of the total. */
const THIRTY_DAYS = {
  from: "2026-08-01T00:00:00.000Z",
  to: "2026-08-31T00:00:00.000Z",
};

const ALL_INTEGRATIONS: IntegrationCapabilities = {
  wakatime: true,
  jira: true,
  confluence: true,
};

/** Twenty tickets over Jira's own twenty-day trailing window: one a day. */
const jira: JiraRepositoryMetrics = {
  window: { from: "2026-08-11T00:00:00.000Z", to: "2026-08-31T00:00:00.000Z" },
  projectKey: "GW",
  component: null,
  issuesCreated: 5,
  issuesResolved: 20,
  throughputPerWeek: 7,
  resolvedByType: { ...EMPTY_JIRA_ISSUE_TYPES, story: 20 },
  bugRatio: 0,
  reopened: 0,
  cycleTime: null,
  leadTime: null,
  storyPointsEstimated: null,
  storyPointsCompleted: null,
  openIssues: 3,
  oldestOpenIssue: null,
  openByPriority: [],
  contributors: 2,
};

/** A fleet averaging half a commit a day, with no WakaTime project anywhere. */
const aFleet = (overrides: Partial<RepositoryFleetRates> = {}): RepositoryFleetRates => ({
  days: 30,
  repositories: 12,
  commits: 0.5,
  pullRequestsOpened: 0.2,
  pullRequestsMerged: 0.1,
  reviews: 0.3,
  builds: 2,
  releases: 0.05,
  codingSeconds: null,
  issuesResolved: 0.5,
  ...overrides,
});

const aSummary = () =>
  RepositoryBuilder.create()
    .withName("gateway")
    .withActivity({
      commits: 30,
      pullRequestsOpened: 6,
      pullRequestsMerged: 3,
      reviews: 9,
      builds: 60,
      releases: 3,
    })
    .build();

const renderCard = (props: Partial<React.ComponentProps<typeof RepositoryRatesCard>> = {}) =>
  renderInTestApp(
    <RepositoryRatesCard
      summary={aSummary()}
      window={THIRTY_DAYS}
      capabilities={NO_INTEGRATIONS}
      fleet={null}
      {...props}
    />,
  );

const rowLabelled = (label: string): HTMLElement | undefined =>
  screen
    .getAllByRole("row")
    .find((row) => within(row).queryAllByRole("cell")[0]?.textContent === label);

const cellsOn = (label: string): HTMLElement[] => {
  const row = rowLabelled(label);
  if (row === undefined) throw new Error(`no row labelled ${label}`);
  return within(row).getAllByRole("cell").slice(1);
};

const figuresOn = (label: string): string[] =>
  cellsOn(label)
    .slice(0, 3)
    .map((cell) => cell.querySelector("[data-figure]")?.textContent ?? "");

const fleetFiguresOn = (label: string): string[] =>
  cellsOn(label)
    .slice(0, 3)
    .map((cell) => within(cell).getByText(/^fleet /u).textContent?.replace(/^fleet /u, "") ?? "");

const comparisonOn = (label: string): string => cellsOn(label)[3]?.textContent ?? "";

describe("RepositoryRatesCard", () => {
  it("should divide the window's counters by the days it spans", async () => {
    // given
    // Thirty commits over thirty days: one a day, seven a week, a mean month.
    await renderCard();

    // when / then
    expect(figuresOn("Commits")).toEqual(["1", "7", "30.4"]);
    expect(figuresOn("Pull requests opened")).toEqual(["0.2", "1.4", "6.09"]);
    expect(figuresOn("Pull requests merged")).toEqual(["0.1", "0.7", "3.04"]);
    expect(figuresOn("Reviews")).toEqual(["0.3", "2.1", "9.13"]);
    expect(figuresOn("Pipeline runs")).toEqual(["2", "14", "60.9"]);
    expect(figuresOn("Releases")).toEqual(["0.1", "0.7", "3.04"]);
    expect(screen.getByText(/divided by the 30 days this range spans/u)).toBeInTheDocument();
  });

  it("should print the fleet's figure under each of the repository's, and how far apart they are", async () => {
    // given
    // One commit a day against the fleet's half is twice it: a hundred
    // percent above. The card says busier, not better, because it is.
    await renderCard({ fleet: aFleet() });

    // when / then
    expect(fleetFiguresOn("Commits")).toEqual(["0.5", "3.5", "15.2"]);
    expect(comparisonOn("Commits")).toBe("100% above the fleet");
    expect(comparisonOn("Pipeline runs")).toBe("level with the fleet");
    expect(screen.getByText(/Above the fleet means busier, not better/u)).toBeInTheDocument();
    expect(
      screen.getByText(/The fleet is the 12 active repositories tracked in this range/u),
    ).toBeInTheDocument();
  });

  it("should say so, and compare nothing, when no fleet average was sent", async () => {
    // given / when
    await renderCard({ fleet: null });

    // then
    expect(comparisonOn("Commits")).toBe("—");
    expect(fleetFiguresOn("Commits")).toEqual(["—", "—", "—"]);
    expect(screen.getByText(/No fleet average was sent for this range/u)).toBeInTheDocument();
  });

  it("should list coding time and tickets only for the integrations configured", async () => {
    // given / when
    await renderCard({ capabilities: NO_INTEGRATIONS });

    // then
    expect(rowLabelled("Coding time")).toBeUndefined();
    expect(rowLabelled("Tickets resolved")).toBeUndefined();
  });

  it("should read tickets over Jira's own window and say which window that is", async () => {
    // given
    // The repository's Jira figures ride on the daily snapshot and describe a
    // trailing window the range picker does not move, so the rate is honest
    // only over that window's days — and the row says so.
    const summary = { ...aSummary(), jiraMetrics: jira };

    // when
    await renderCard({ summary, capabilities: ALL_INTEGRATIONS, fleet: aFleet() });

    // then
    expect(figuresOn("Tickets resolved")).toEqual(["1", "7", "30.4"]);
    expect(comparisonOn("Tickets resolved")).toBe("100% above the fleet");
    expect(
      screen.getByText(/Tickets resolved is a rate over Jira's own trailing window, Aug 11 to Aug 31/u),
    ).toBeInTheDocument();
  });

  it("should print an em dash for a configured integration the entity names no project for", async () => {
    // given
    // Jira is on and this repository's catalog entity names no project: the
    // figure is unmeasured, not zero, and the caption says why.
    await renderCard({ capabilities: ALL_INTEGRATIONS, fleet: aFleet() });

    // when / then
    expect(figuresOn("Tickets resolved")).toEqual(["—", "—", "—"]);
    expect(figuresOn("Coding time")).toEqual(["—", "—", "—"]);
    expect(comparisonOn("Tickets resolved")).toBe("—");
    expect(fleetFiguresOn("Coding time")).toEqual(["—", "—", "—"]);
    expect(
      screen.getByText(/no Jira project is named by this repository's catalog entity/u),
    ).toBeInTheDocument();
  });

  it("should say the coding time as a duration", async () => {
    // given
    // Thirty hours over thirty days is an hour a day.
    const summary = {
      ...aSummary(),
      wakaTimeMetrics: {
        projectName: "gateway",
        window: { from: "2026-08-01", to: "2026-08-31" },
        totalSeconds: 108_000,
        contributors: 2,
        daily: [],
      },
    };

    // when
    await renderCard({
      summary,
      capabilities: { ...NO_INTEGRATIONS, wakatime: true },
      fleet: aFleet({ codingSeconds: 7200 }),
    });

    // then
    expect(figuresOn("Coding time")).toEqual(["1h", "7h", "30h 26m"]);
    expect(fleetFiguresOn("Coding time")).toEqual(["2h", "14h", "60h 52m"]);
    expect(comparisonOn("Coding time")).toBe("50% below the fleet");
  });

  it("should call a single active repository a repository", async () => {
    // given / when
    await renderCard({ fleet: aFleet({ repositories: 1 }) });

    // then
    expect(
      screen.getByText(/The fleet is the 1 active repository tracked in this range/u),
    ).toBeInTheDocument();
  });
});
