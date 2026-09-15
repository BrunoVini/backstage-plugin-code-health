import type { ContributorSummary } from "../src";
import {
  contributorRatesOf,
  describeRate,
  formatRate,
  legibleRate,
  RATE_PERIODS,
  windowDaysOf,
} from "../src/contributor_rates";
import { WakaTimeMetricsBuilder } from "./builders/wakatime_metrics_builder";

const aContributor = (overrides: Partial<ContributorSummary> = {}): ContributorSummary => ({
  key: "vcs:jane",
  displayName: "Jane",
  avatarUrl: null,
  profileUrl: null,
  entityRef: null,
  identities: [],
  commits: 70,
  linesAdded: 0,
  linesDeleted: 0,
  linesOfCode: 700,
  changedFiles: 0,
  churnUnit: "lines",
  pullRequestsOpened: 14,
  pullRequestsMerged: 7,
  reviewsGiven: 21,
  reviewsApproved: 0,
  reviewsRejected: 0,
  prApprovalRate: 0,
  pipelineRuns: 35,
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

describe("windowDaysOf", () => {
  it("should count the days a window spans", () => {
    // given / when / then
    expect(
      windowDaysOf({ from: "2026-08-01T00:00:00.000Z", to: "2026-08-08T00:00:00.000Z" }),
    ).toBe(7);
  });

  it("should floor a window at a fraction of a day", () => {
    // given
    // The shortest range the dashboard offers is an hour, and a zero
    // denominator would turn every rate into infinity on exactly the range a
    // freshly installed plugin opens with.

    // when
    const days = windowDaysOf({
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-01T00:00:00.000Z",
    });

    // then
    expect(days).toBeCloseTo(1 / 24, 10);
  });

  it("should fall back to a day for a window it cannot read", () => {
    // given / when / then
    expect(windowDaysOf({ from: "not a date", to: "2026-08-08T00:00:00.000Z" })).toBe(1);
  });
});

describe("contributorRatesOf", () => {
  it("should divide every total by the days the window spans", () => {
    // given
    // Seventy commits over seven days is ten a day, whatever range was picked.
    const summary = aContributor();

    // when
    const rates = contributorRatesOf(summary, 7);

    // then
    expect(rates.daily.commits).toBe(10);
    expect(rates.daily.pullRequestsMerged).toBe(1);
    expect(rates.daily.reviewsGiven).toBe(3);
    expect(rates.daily.pipelineRuns).toBe(5);
    expect(rates.windowDays).toBe(7);
  });

  it("should scale the same totals into weeks and months", () => {
    // given
    const summary = aContributor();

    // when
    const rates = contributorRatesOf(summary, 7);

    // then
    expect(rates.weekly.commits).toBe(70);
    expect(rates.monthly.commits).toBeCloseTo(10 * RATE_PERIODS.monthly.days, 10);
  });

  it("should take churn in whatever unit the provider reported", () => {
    // given
    const lines = aContributor({ churnUnit: "lines", linesOfCode: 700 });
    const files = aContributor({ churnUnit: "files", changedFiles: 140, linesOfCode: 0 });

    // when / then
    expect(contributorRatesOf(lines, 7).daily.churn).toBe(100);
    expect(contributorRatesOf(files, 7).daily.churn).toBe(20);
    expect(contributorRatesOf(lines, 7).churnUnit).toBe("lines");
  });

  it("should leave an unmeasured figure null rather than rating it as zero", () => {
    // given
    // A provider that reports no line counts has not reported a churn of
    // nothing, and an account with no WakaTime linked has not logged no hours.
    const summary = aContributor({ churnUnit: "none" });

    // when
    const rates = contributorRatesOf(summary, 7);

    // then
    expect(rates.daily.churn).toBeNull();
    expect(rates.daily.codingSeconds).toBeNull();
    expect(rates.daily.issuesResolved).toBeNull();
    expect(rates.daily.documentationContributions).toBeNull();
    expect(rates.monthly.churn).toBeNull();
  });

  it("should rate the integration figures a row does carry", () => {
    // given
    const summary = aContributor({
      wakaTimeMetrics: WakaTimeMetricsBuilder.aDay().withSeconds(7000).build(),
      jiraMetrics: {
        window: { from: "2026-08-01", to: "2026-08-08" },
        issuesCreated: 0,
        issuesResolved: 14,
        interactions: {
          comments: null,
          worklogEntries: null,
          transitions: 0,
          truncatedIssues: 0,
        },
        storyPointsEstimated: null,
        storyPointsCompleted: null,
        cycleTime: null,
        leadTime: null,
        resolvedByType: { bug: 0, story: 0, task: 0, epic: 0, other: 0 },
        reopened: 0,
      },
    });

    // when
    const rates = contributorRatesOf(summary, 7);

    // then
    expect(rates.daily.codingSeconds).toBe(1000);
    expect(rates.daily.issuesResolved).toBe(2);
  });

  it("should floor the window so a rate is never infinite", () => {
    // given / when
    const rates = contributorRatesOf(aContributor(), 0);

    // then
    expect(Number.isFinite(rates.daily.commits)).toBe(true);
  });
});

describe("formatRate", () => {
  it("should keep a small rate meaningful and a large one honest", () => {
    // given / when / then
    expect(formatRate(0.07)).toBe("0.07");
    expect(formatRate(41.34)).toBe("41.3");
  });

  it("should strip trailing zeros rather than claim a precision nobody measured", () => {
    // given
    // "5.00 commits a day" reads as a measurement to the hundredth, when it is
    // five commits in one day.

    // when / then
    expect(formatRate(5)).toBe("5");
    expect(formatRate(0.7)).toBe("0.7");
    expect(formatRate(20)).toBe("20");
  });

  it("should say zero plainly and refuse a figure that is not one", () => {
    // given / when / then
    expect(formatRate(0)).toBe("0");
    expect(formatRate(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatRate(Number.NaN)).toBe("—");
  });
});

describe("legibleRate", () => {
  it("should leave a rate of one or more per day alone", () => {
    // given / when / then
    expect(legibleRate(2.5)).toEqual({ value: 2.5, period: "daily" });
    expect(legibleRate(0)).toEqual({ value: 0, period: "daily" });
  });

  it("should promote a rate nobody can picture to the period it reaches one in", () => {
    // given
    // A team merging a pull request each a fortnight has a daily rate of 0.07.

    // when
    const weekly = legibleRate(0.5);
    const monthly = legibleRate(0.07);

    // then
    expect(weekly.period).toBe("weekly");
    expect(weekly.value).toBeCloseTo(3.5, 10);
    expect(monthly.period).toBe("monthly");
    expect(monthly.value).toBeGreaterThan(1);
  });
});

describe("describeRate", () => {
  it("should say a rate in the period a reader recognises", () => {
    // given / when / then
    expect(describeRate(5, "commit")).toBe("5 commits a day");
    expect(describeRate(0.5, "review")).toBe("3.5 reviews a week");
    expect(describeRate(0.02, "merged pull request")).toBe(
      "0.61 merged pull requests a month",
    );
  });

  it("should not pluralise exactly one of something", () => {
    // given / when / then
    expect(describeRate(1, "commit")).toBe("1 commit a day");
  });
});
