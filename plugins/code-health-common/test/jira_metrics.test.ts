import {
  addIssueTypeCounts,
  buildDurationStats,
  classifyIssueType,
  computeBugRatio,
  EMPTY_JIRA_INTERACTIONS,
  EMPTY_JIRA_ISSUE_TYPES,
  formatHours,
  interactionsAreComplete,
  interactionTotal,
  meanHours,
  mergeJiraContributorMetrics,
  percentileHours,
  totalIssueTypes,
  type JiraContributorMetrics,
  type JiraInteractions,
} from "../src/jira_metrics";

const metrics = (
  overrides: Partial<JiraContributorMetrics> = {},
): JiraContributorMetrics => ({
  window: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-08T00:00:00.000Z" },
  issuesCreated: 0,
  issuesResolved: 0,
  interactions: EMPTY_JIRA_INTERACTIONS,
  storyPointsEstimated: null,
  storyPointsCompleted: null,
  cycleTime: null,
  leadTime: null,
  resolvedByType: EMPTY_JIRA_ISSUE_TYPES,
  reopened: 0,
  ...overrides,
});

const interactions = (overrides: Partial<JiraInteractions> = {}): JiraInteractions => ({
  ...EMPTY_JIRA_INTERACTIONS,
  ...overrides,
});

describe("classifyIssueType", () => {
  it("should match Jira's own type names case-insensitively", () => {
    // given
    const names = ["Bug", "  STORY ", "Epic", "Sub-task"];

    // when
    const buckets = names.map((name) => classifyIssueType(name));

    // then
    expect(buckets).toEqual(["bug", "story", "epic", "task"]);
  });

  it("should treat a renamed defect type as a bug", () => {
    // given
    // Several sites rename `Bug` on creation, and a bug ratio that reads zero
    // because of a rename is the most flattering possible way to be wrong.
    const name = "Defect";

    // when
    const bucket = classifyIssueType(name);

    // then
    expect(bucket).toBe("bug");
  });

  it("should count a sub-task as a task whatever its type is called", () => {
    // given
    // Jira reports the sub-task flag separately from the name, so a site that
    // renamed the type would otherwise scatter half its closed work into other.
    const name = "Implementation Step";

    // when
    const bucket = classifyIssueType(name, true);

    // then
    expect(bucket).toBe("task");
  });

  it("should fall back to other for a type this plugin does not know", () => {
    // given
    const cases: (string | null)[] = ["Incident", null];

    // when
    const buckets = cases.map((name) => classifyIssueType(name));

    // then
    expect(buckets).toEqual(["other", "other"]);
  });
});

describe("addIssueTypeCounts", () => {
  it("should add every bucket", () => {
    // given
    const left = { bug: 1, story: 2, task: 3, epic: 4, other: 5 };
    const right = { bug: 5, story: 4, task: 3, epic: 2, other: 1 };

    // when
    const total = addIssueTypeCounts(left, right);

    // then
    expect(total).toEqual({ bug: 6, story: 6, task: 6, epic: 6, other: 6 });
    expect(totalIssueTypes(total)).toBe(30);
  });
});

describe("computeBugRatio", () => {
  it("should report the defect share of closed work", () => {
    // given
    const counts = { ...EMPTY_JIRA_ISSUE_TYPES, bug: 3, story: 5 };

    // when
    const ratio = computeBugRatio(counts);

    // then
    expect(ratio).toBe(37.5);
  });

  it("should report null when nothing closed", () => {
    // given
    // A team that closed nothing this week is not a team that shipped nothing
    // but working software — absence is null, never zero.
    const counts = EMPTY_JIRA_ISSUE_TYPES;

    // when
    const ratio = computeBugRatio(counts);

    // then
    expect(ratio).toBeNull();
  });
});

describe("meanHours", () => {
  it("should divide the total by the count", () => {
    // given
    const totals = { totalHours: 30, issues: 4 };

    // when
    const mean = meanHours(totals);

    // then
    expect(mean).toBe(7.5);
  });

  it("should report null when nothing was measured", () => {
    // given
    const cases = [null, { totalHours: 0, issues: 0 }];

    // when
    const means = cases.map(meanHours);

    // then
    expect(means).toEqual([null, null]);
  });
});

describe("percentileHours", () => {
  it("should interpolate between the two neighbouring samples", () => {
    // given
    // Nearest-rank over four values reports the same number for the median and
    // the 85th percentile, which reads as a team with no variance at all.
    const hours = [1, 2, 3, 10];

    // when
    const median = percentileHours(hours, 0.5);

    // then
    expect(median).toBe(2.5);
  });

  it("should sort the sample before reading a position from it", () => {
    // given
    const hours = [10, 1, 3, 2];

    // when
    const p85 = percentileHours(hours, 0.85);

    // then
    expect(p85).toBe(6.8);
  });

  it("should report zero for an empty sample", () => {
    // given
    const hours: number[] = [];

    // when
    const median = percentileHours(hours, 0.5);

    // then
    expect(median).toBe(0);
  });
});

describe("buildDurationStats", () => {
  it("should carry the totals beside the percentiles", () => {
    // given
    // The totals are what survives merging; the percentiles are what a
    // repository row is allowed to show because it is never merged.
    const hours = [2, 4, 6, 8];

    // when
    const stats = buildDurationStats(hours);

    // then
    expect(stats).toEqual({
      totalHours: 20,
      issues: 4,
      medianHours: 5,
      p85Hours: 7.1,
    });
  });

  it("should report null when no issue was measured", () => {
    // given
    const hours: number[] = [];

    // when
    const stats = buildDurationStats(hours);

    // then
    expect(stats).toBeNull();
  });
});

describe("formatHours", () => {
  it("should phrase a duration the way somebody discussing a ticket would", () => {
    // given
    // Cycle times span four orders of magnitude, so a single unit is unreadable
    // at one end whichever unit is chosen.
    const cases = [0.25, 3, 3.5, 24, 50];

    // when
    const formatted = cases.map(formatHours);

    // then
    expect(formatted).toEqual(["15m", "3h", "3h 30m", "1d", "2d 2h"]);
  });

  it("should group a day count past a thousand", () => {
    // given
    // A ticket left open across a reorganisation gives a lead time in four
    // figures of days, and the cell it lands in is a cell.

    // when / then
    expect(formatHours(30_000)).toBe("1,250d");
    expect(formatHours(30_010)).toBe("1,250d 10h");
  });

  it("should render an em dash for a value that is not a duration", () => {
    // given
    const cases = [Number.NaN, -1];

    // when
    const formatted = cases.map(formatHours);

    // then
    expect(formatted).toEqual(["—", "—"]);
  });
});

describe("interactionTotal", () => {
  it("should add the three components", () => {
    // given
    const counts = interactions({ comments: 4, worklogEntries: 2, transitions: 3 });

    // when
    const total = interactionTotal(counts);

    // then
    expect(total).toBe(9);
  });

  it("should treat an unmeasured component as zero so the total stays a floor", () => {
    // given
    // A site whose search returns no comment bodies has not said there were no
    // comments; the ranking is still right, because a person with more of every
    // measured component still outranks one with fewer.
    const counts = interactions({ comments: null, worklogEntries: null, transitions: 7 });

    // when
    const total = interactionTotal(counts);

    // then
    expect(total).toBe(7);
    expect(interactionsAreComplete(counts)).toBe(false);
  });

  it("should report completeness only when nothing was missing or truncated", () => {
    // given
    const complete = interactions({ comments: 1, worklogEntries: 1, transitions: 1 });
    const truncated = interactions({ comments: 1, worklogEntries: 1, truncatedIssues: 2 });
    const partial = interactions({ comments: 1, worklogEntries: null });

    // when
    const flags = [complete, truncated, partial].map(interactionsAreComplete);

    // then
    expect(flags).toEqual([true, false, false]);
  });
});

describe("mergeJiraContributorMetrics", () => {
  it("should report null when the person holds no Atlassian account", () => {
    // given
    // A zeroed row would put somebody on the dashboard as having closed no
    // tickets, when the truth is that nobody ever measured them.
    const parts: JiraContributorMetrics[] = [];

    // when
    const merged = mergeJiraContributorMetrics(parts);

    // then
    expect(merged).toBeNull();
  });

  it("should return the single measurement untouched", () => {
    // given
    const only = metrics({ issuesResolved: 4 });

    // when
    const merged = mergeJiraContributorMetrics([only]);

    // then
    expect(merged).toBe(only);
  });

  it("should sum the counts and take the union of the windows", () => {
    // given
    // One person, two Atlassian accounts, measured at slightly different
    // moments — the row has to state the period it actually covers.
    const parts = [
      metrics({
        window: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-05T00:00:00.000Z" },
        issuesCreated: 3,
        issuesResolved: 2,
        reopened: 1,
        resolvedByType: { ...EMPTY_JIRA_ISSUE_TYPES, bug: 2 },
        interactions: interactions({ comments: 4, worklogEntries: 1, transitions: 6 }),
      }),
      metrics({
        window: { from: "2026-08-02T00:00:00.000Z", to: "2026-08-09T00:00:00.000Z" },
        issuesCreated: 1,
        issuesResolved: 5,
        reopened: 2,
        resolvedByType: { ...EMPTY_JIRA_ISSUE_TYPES, story: 5 },
        interactions: interactions({ comments: 2, worklogEntries: 3, transitions: 1 }),
      }),
    ];

    // when
    const merged = mergeJiraContributorMetrics(parts);

    // then
    expect(merged).toMatchObject({
      window: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-09T00:00:00.000Z" },
      issuesCreated: 4,
      issuesResolved: 7,
      reopened: 3,
      resolvedByType: { ...EMPTY_JIRA_ISSUE_TYPES, bug: 2, story: 5 },
      interactions: { comments: 6, worklogEntries: 4, transitions: 7, truncatedIssues: 0 },
    });
  });

  it("should keep the merged mean equal to the mean of the union", () => {
    // given
    // The reason durations are stored as a total and a count: the mean of two
    // means is only right when both sides counted the same number of issues.
    const parts = [
      metrics({ cycleTime: { totalHours: 10, issues: 1 } }),
      metrics({ cycleTime: { totalHours: 30, issues: 3 } }),
    ];

    // when
    const merged = mergeJiraContributorMetrics(parts);

    // then
    expect(merged?.cycleTime).toEqual({ totalHours: 40, issues: 4 });
    expect(meanHours(merged?.cycleTime ?? null)).toBe(10);
  });

  it("should keep a nullable measure null only when no account measured it", () => {
    // given
    // One account that reported four points and one that reported nothing at
    // all is a person with at least four, not a person nobody can say anything
    // about.
    const measured = [
      metrics({ storyPointsCompleted: 4 }),
      metrics({ storyPointsCompleted: null }),
    ];
    const neither = [
      metrics({ storyPointsCompleted: null }),
      metrics({ storyPointsCompleted: null }),
    ];

    // when
    const withOne = mergeJiraContributorMetrics(measured);
    const withNone = mergeJiraContributorMetrics(neither);

    // then
    expect(withOne?.storyPointsCompleted).toBe(4);
    expect(withNone?.storyPointsCompleted).toBeNull();
  });

  it("should carry a duration through from whichever side measured it", () => {
    // given
    const parts = [
      metrics({ leadTime: null }),
      metrics({ leadTime: { totalHours: 12.5, issues: 2 } }),
    ];

    // when
    const merged = mergeJiraContributorMetrics(parts);

    // then
    expect(merged?.leadTime).toEqual({ totalHours: 12.5, issues: 2 });
    expect(merged?.cycleTime).toBeNull();
  });
});
