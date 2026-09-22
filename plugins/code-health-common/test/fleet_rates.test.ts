import type { ContributorSummary } from "../src";
import {
  contributorFleetRatesOf,
  describeRateDelta,
  fleetContributorRatesOf,
  rateDeltaDirection,
  rateDeltaOf,
} from "../src/fleet_rates";
import { WakaTimeMetricsBuilder } from "./builders/wakatime_metrics_builder";

const aContributor = (overrides: Partial<ContributorSummary> = {}): ContributorSummary => ({
  key: "vcs:jane",
  displayName: "Jane",
  avatarUrl: null,
  profileUrl: null,
  entityRef: null,
  identities: [{ source: "vcs", sourceKey: "jane", displayName: "Jane" }],
  commits: 10,
  linesAdded: 0,
  linesDeleted: 0,
  linesOfCode: 100,
  changedFiles: 0,
  churnUnit: "lines",
  pullRequestsOpened: 4,
  pullRequestsMerged: 2,
  reviewsGiven: 6,
  reviewsRequested: 6,
  reviewsApproved: 0,
  reviewsRejected: 0,
  prApprovalRate: 0,
  pipelineRuns: 20,
  pipelineRunsSucceeded: 0,
  pipelineRunsFailed: 0,
  pipelineSuccessRate: 0,
  repositories: 1,
  sonarMetrics: null,
  wakaTimeMetrics: null,
  jiraMetrics: null,
  confluenceMetrics: null,
  ...overrides,
});

const jira = (issuesResolved: number) => ({
  window: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-11T00:00:00.000Z" },
  issuesCreated: 0,
  issuesResolved,
  interactions: { comments: null, worklogEntries: null, transitions: 0, truncatedIssues: 0 },
  storyPointsEstimated: null,
  storyPointsCompleted: null,
  cycleTime: null,
  leadTime: null,
  resolvedByType: { bug: 0, story: 0, task: 0, epic: 0, other: 0 },
  reopened: 0,
});

describe("contributorFleetRatesOf", () => {
  it("should take the mean of every row as a daily rate, and count the people", () => {
    // given
    // Ten and thirty commits over ten days: a mean of twenty, so two a day.
    const rows = [aContributor({ commits: 10 }), aContributor({ commits: 30 })];

    // when
    const fleet = contributorFleetRatesOf(rows, 10);

    // then
    expect(fleet.days).toBe(10);
    expect(fleet.people).toBe(2);
    expect(fleet.commits).toBe(2);
    expect(fleet.pullRequestsOpened).toBe(0.4);
    expect(fleet.pullRequestsMerged).toBe(0.2);
    expect(fleet.reviewsGiven).toBe(0.6);
    expect(fleet.pipelineRuns).toBe(2);
  });

  it("should agree with the score's own reference on every figure they share", () => {
    // given
    // The card and the score have to say the same team average, or a reader
    // comparing the two would find the same figure with two values.
    const rows = [aContributor({ commits: 3 }), aContributor({ commits: 9, reviewsGiven: 0 })];

    // when
    const fleet = contributorFleetRatesOf(rows, 3);

    // then
    expect(fleet.commits).toBe(2);
    expect(fleet.reviewsGiven).toBe(1);
    expect(fleet.linesOfCode).toBeCloseTo(100 / 3, 10);
  });

  it("should leave a figure null when it could be measured on nobody", () => {
    // given
    // A team in which nobody has WakaTime linked has no average coding time;
    // a zero would report a team that never opens an editor.
    const rows = [aContributor(), aContributor()];

    // when
    const fleet = contributorFleetRatesOf(rows, 1);

    // then
    expect(fleet.codingSeconds).toBeNull();
    expect(fleet.issuesResolved).toBeNull();
    expect(fleet.changedFiles).toBeNull();
    expect(fleet.linesOfCode).toBe(100);
  });

  it("should average an integration over the people it could be measured on", () => {
    // given
    // One person with an hour logged and one with no account: the average is
    // an hour, not half an hour.
    const rows = [
      aContributor({
        wakaTimeMetrics: WakaTimeMetricsBuilder.aDay().withSeconds(3600).build(),
        jiraMetrics: jira(4),
      }),
      aContributor(),
    ];

    // when
    const fleet = contributorFleetRatesOf(rows, 2);

    // then
    expect(fleet.codingSeconds).toBe(1800);
    expect(fleet.issuesResolved).toBe(2);
  });

  it("should keep somebody version control never saw out of the version-control averages", () => {
    // given
    // A row known only to Jira carries a zero for every version-control
    // figure, and none of those zeros is a measurement: read as one it lowers
    // the bar every real committer is compared against on the card.
    const rows = [
      aContributor({ commits: 10, pullRequestsOpened: 4, pipelineRuns: 20 }),
      aContributor({
        key: "jira:acct-1",
        identities: [{ source: "jira", sourceKey: "acct-1", displayName: "Only Jira" }],
        commits: 0,
        pullRequestsOpened: 0,
        pullRequestsMerged: 0,
        reviewsGiven: 0,
        pipelineRuns: 0,
        jiraMetrics: jira(4),
      }),
    ];

    // when
    const fleet = contributorFleetRatesOf(rows, 1);

    // then
    expect(fleet.people).toBe(2);
    expect(fleet.commits).toBe(10);
    expect(fleet.pullRequestsOpened).toBe(4);
    expect(fleet.pipelineRuns).toBe(20);
    expect(fleet.issuesResolved).toBe(4);
  });

  it("should keep churn per unit, so files are never averaged with lines", () => {
    // given
    const rows = [
      aContributor({ churnUnit: "lines", linesOfCode: 50 }),
      aContributor({ churnUnit: "files", changedFiles: 8, linesOfCode: 0 }),
    ];

    // when
    const fleet = contributorFleetRatesOf(rows, 1);

    // then
    expect(fleet.linesOfCode).toBe(50);
    expect(fleet.changedFiles).toBe(8);
  });

  it("should answer for nobody without dividing by zero", () => {
    // given / when
    const fleet = contributorFleetRatesOf([], 7);

    // then
    expect(fleet.people).toBe(0);
    expect(fleet.commits).toBe(0);
    expect(fleet.codingSeconds).toBeNull();
  });
});

describe("fleetContributorRatesOf", () => {
  const fleet = {
    days: 10,
    people: 3,
    commits: 1,
    pullRequestsOpened: 0.5,
    pullRequestsMerged: 0.25,
    reviewsGiven: 2,
    linesOfCode: 40,
    changedFiles: 6,
    pipelineRuns: 3,
    codingSeconds: 3600,
    issuesResolved: null,
  };

  it("should scale the daily means to a week and a mean month", () => {
    // given / when
    const rates = fleetContributorRatesOf(fleet, "lines");

    // then
    expect(rates.windowDays).toBe(10);
    expect(rates.daily.commits).toBe(1);
    expect(rates.weekly.commits).toBe(7);
    expect(rates.monthly.commits).toBeCloseTo(30.44, 2);
    expect(rates.weekly.codingSeconds).toBe(25_200);
  });

  it("should read churn in the person's own unit", () => {
    // given / when
    const lines = fleetContributorRatesOf(fleet, "lines");
    const files = fleetContributorRatesOf(fleet, "files");
    const none = fleetContributorRatesOf(fleet, "none");

    // then
    expect(lines.daily.churn).toBe(40);
    expect(files.daily.churn).toBe(6);
    expect(none.daily.churn).toBeNull();
  });

  it("should keep an unmeasured mean null in every period, and documentation always", () => {
    // given / when
    const rates = fleetContributorRatesOf(fleet, "lines");

    // then
    expect(rates.daily.issuesResolved).toBeNull();
    expect(rates.monthly.issuesResolved).toBeNull();
    expect(rates.weekly.documentationContributions).toBeNull();
  });
});

describe("rateDeltaOf", () => {
  it("should say how far a rate sits from the reference as a share of it", () => {
    // given / when / then
    expect(rateDeltaOf(1.25, 1)).toBeCloseTo(0.25, 10);
    expect(rateDeltaOf(0.6, 1)).toBeCloseTo(-0.4, 10);
    expect(rateDeltaOf(0, 2)).toBe(-1);
  });

  it("should refuse to compare against nothing", () => {
    // given
    // Against an average of zero every rate is infinitely above it, and a
    // figure nobody measured has no distance from anything.

    // when / then
    expect(rateDeltaOf(3, 0)).toBeNull();
    expect(rateDeltaOf(3, null)).toBeNull();
    expect(rateDeltaOf(null, 3)).toBeNull();
    expect(rateDeltaOf(Number.NaN, 3)).toBeNull();
  });
});

describe("describeRateDelta", () => {
  it("should say the direction in words, rounded to whole percents", () => {
    // given / when / then
    expect(describeRateDelta(0.254)).toBe("25% above the team");
    expect(describeRateDelta(-0.4, "the fleet")).toBe("40% below the fleet");
    expect(describeRateDelta(2)).toBe("200% above the team");
  });

  it("should group a delta past a thousand percent", () => {
    // given
    // This is the one percentage on the dashboard with no ceiling: a share of
    // the team's average runs well past a thousand percent for anybody far
    // ahead of it, and `38150% above the team` is five digits nobody reads.

    // when / then
    expect(describeRateDelta(381.5)).toBe("38,150% above the team");
    expect(describeRateDelta(11.1)).toBe("1,110% above the team");
  });

  it("should call a difference the rounding removes level", () => {
    // given / when / then
    expect(describeRateDelta(0.004)).toBe("level with the team");
    expect(rateDeltaDirection(-0.004)).toBe("level");
    expect(rateDeltaDirection(0.01)).toBe("above");
    expect(rateDeltaDirection(-0.01)).toBe("below");
  });
});
