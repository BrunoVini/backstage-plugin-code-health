import type { RepositorySummary } from "../src";
import { EMPTY_REPOSITORY_ACTIVITY } from "../src";
import {
  fleetRepositoryRatesOf,
  repositoryFleetRatesOf,
  repositoryRatesOf,
} from "../src/repository_rates";

const aRepository = (overrides: Partial<RepositorySummary> = {}): RepositorySummary => ({
  id: "repo",
  entityRef: "component:default/repo",
  ownerRef: null,
  ownerProfile: null,
  platform: "github",
  name: "repo",
  fullName: "acme/repo",
  url: "https://github.com/acme/repo",
  description: null,
  primaryLanguage: null,
  visibility: "PUBLIC",
  isArchived: false,
  isFork: false,
  defaultBranch: "main",
  updatedAt: "2026-08-10T00:00:00.000Z",
  ciStatus: null,
  latestRelease: null,
  latestTag: null,
  branches: ["main"],
  sonarMetrics: null,
  complianceStatus: null,
  badgeStatus: null,
  documentation: null,
  apiExposure: null,
  wakaTimeMetrics: null,
  jiraMetrics: null,
  confluenceMetrics: null,
  activity: {
    ...EMPTY_REPOSITORY_ACTIVITY,
    commits: 70,
    pullRequestsOpened: 14,
    pullRequestsMerged: 7,
    reviews: 21,
    builds: 35,
    releases: 1,
  },
  ...overrides,
});

const wakaTime = (totalSeconds: number) => ({
  projectName: "repo",
  window: { from: "2026-08-01", to: "2026-08-08" },
  totalSeconds,
  contributors: 1,
  daily: [],
});

/** Ten tickets over a twenty-day Jira window: half a ticket a day. */
const jira = (issuesResolved: number) => ({
  window: { from: "2026-07-20T00:00:00.000Z", to: "2026-08-09T00:00:00.000Z" },
  projectKey: "RP",
  component: null,
  issuesCreated: 0,
  issuesResolved,
  throughputPerWeek: 0,
  resolvedByType: { bug: 0, story: 0, task: 0, epic: 0, other: 0 },
  bugRatio: null,
  reopened: 0,
  cycleTime: null,
  leadTime: null,
  storyPointsEstimated: null,
  storyPointsCompleted: null,
  openIssues: 0,
  oldestOpenIssue: null,
  openByPriority: [],
  contributors: 0,
});

describe("repositoryRatesOf", () => {
  it("should divide every counter by the days the window spans", () => {
    // given
    // Seventy commits over seven days is ten a day, whatever range was picked.
    const rates = repositoryRatesOf(aRepository(), 7);

    // when / then
    expect(rates.windowDays).toBe(7);
    expect(rates.daily.commits).toBe(10);
    expect(rates.daily.pullRequestsOpened).toBe(2);
    expect(rates.daily.pullRequestsMerged).toBe(1);
    expect(rates.daily.reviews).toBe(3);
    expect(rates.daily.builds).toBe(5);
    expect(rates.weekly.releases).toBe(1);
    expect(rates.monthly.commits).toBeCloseTo(304.4, 1);
  });

  it("should leave an integration null where its project is not named", () => {
    // given / when
    const rates = repositoryRatesOf(aRepository(), 7);

    // then
    expect(rates.daily.codingSeconds).toBeNull();
    expect(rates.monthly.issuesResolved).toBeNull();
  });

  it("should read coding time over the window and tickets over Jira's own window", () => {
    // given
    // The Jira figures ride on the daily snapshot and describe a trailing
    // window the range picker does not move, so their only honest divisor is
    // that window's own days.
    const rates = repositoryRatesOf(
      aRepository({ wakaTimeMetrics: wakaTime(7 * 3600), jiraMetrics: jira(10) }),
      7,
    );

    // when / then
    expect(rates.daily.codingSeconds).toBe(3600);
    expect(rates.daily.issuesResolved).toBe(0.5);
    expect(rates.weekly.issuesResolved).toBe(3.5);
  });

  it("should floor the window at a fraction of a day", () => {
    // given / when
    const rates = repositoryRatesOf(aRepository(), 0);

    // then
    expect(Number.isFinite(rates.daily.commits)).toBe(true);
    expect(rates.windowDays).toBeCloseTo(1 / 24, 10);
  });
});

describe("repositoryFleetRatesOf", () => {
  it("should take the mean daily rate over the active repositories", () => {
    // given
    // Seventy and one hundred and forty commits over seven days: ten and
    // twenty a day, so fifteen.
    const busy = aRepository({ activity: { ...aRepository().activity, commits: 140 } });

    // when
    const fleet = repositoryFleetRatesOf([aRepository(), busy], 7);

    // then
    expect(fleet.days).toBe(7);
    expect(fleet.repositories).toBe(2);
    expect(fleet.commits).toBe(15);
    expect(fleet.builds).toBe(5);
  });

  it("should leave archived repositories out of the average", () => {
    // given
    // One that cannot receive a commit is not a peer of the ones that can.
    const archived = aRepository({
      isArchived: true,
      activity: { ...EMPTY_REPOSITORY_ACTIVITY },
    });

    // when
    const fleet = repositoryFleetRatesOf([aRepository(), archived], 7);

    // then
    expect(fleet.repositories).toBe(1);
    expect(fleet.commits).toBe(10);
  });

  it("should average an integration over the repositories it could be measured on", () => {
    // given
    const measured = aRepository({ wakaTimeMetrics: wakaTime(7200), jiraMetrics: jira(20) });

    // when
    const fleet = repositoryFleetRatesOf([measured, aRepository()], 1);

    // then
    expect(fleet.codingSeconds).toBe(7200);
    expect(fleet.issuesResolved).toBe(1);
  });

  it("should leave an integration null when no repository carries it", () => {
    // given / when
    const fleet = repositoryFleetRatesOf([aRepository()], 1);

    // then
    expect(fleet.codingSeconds).toBeNull();
    expect(fleet.issuesResolved).toBeNull();
  });

  it("should answer for an empty fleet with zeros rather than not a number", () => {
    // given / when
    const fleet = repositoryFleetRatesOf([], 7);

    // then
    expect(fleet.repositories).toBe(0);
    expect(fleet.commits).toBe(0);
    expect(fleet.releases).toBe(0);
  });
});

describe("fleetRepositoryRatesOf", () => {
  it("should scale the fleet's daily means to a week and a mean month", () => {
    // given
    const fleet = repositoryFleetRatesOf([aRepository({ wakaTimeMetrics: wakaTime(7 * 60) })], 7);

    // when
    const rates = fleetRepositoryRatesOf(fleet);

    // then
    expect(rates.windowDays).toBe(7);
    expect(rates.daily.commits).toBe(10);
    expect(rates.weekly.commits).toBe(70);
    expect(rates.monthly.reviews).toBeCloseTo(91.3, 1);
    expect(rates.weekly.codingSeconds).toBe(420);
    expect(rates.monthly.issuesResolved).toBeNull();
  });
});
