import type { ContributorSummary } from "../src";
import { computeRate, measuredByVersionControl } from "../src/contributor_summary";

const aContributor = (identities: ContributorSummary["identities"]): ContributorSummary => ({
  key: "vcs:jane",
  displayName: "Jane",
  avatarUrl: null,
  profileUrl: null,
  entityRef: null,
  identities,
  commits: 0,
  linesAdded: 0,
  linesDeleted: 0,
  linesOfCode: 0,
  changedFiles: 0,
  churnUnit: "none",
  pullRequestsOpened: 0,
  pullRequestsMerged: 0,
  reviewsGiven: 0,
  reviewsApproved: 0,
  reviewsRejected: 0,
  prApprovalRate: 0,
  pipelineRuns: 0,
  pipelineRunsSucceeded: 0,
  pipelineRunsFailed: 0,
  pipelineSuccessRate: 0,
  repositories: 0,
  sonarMetrics: null,
  wakaTimeMetrics: null,
  jiraMetrics: null,
  confluenceMetrics: null,
});

describe("measuredByVersionControl", () => {
  it("should be true for a row with a version-control account, however quiet", () => {
    // given
    // Zero commits on an account version control knows is a quiet window,
    // exactly like a quiet week — a measured zero, not an absence.
    const summary = aContributor([
      { source: "jira", sourceKey: "acct-1", displayName: null },
      { source: "vcs", sourceKey: "jane@example.com", displayName: "Jane" },
    ]);

    // when / then
    expect(measuredByVersionControl(summary)).toBe(true);
  });

  it("should be false for a row no version-control account was ever merged onto", () => {
    // given
    const summary = aContributor([{ source: "jira", sourceKey: "acct-1", displayName: null }]);

    // when / then
    expect(measuredByVersionControl(summary)).toBe(false);
  });
});

describe("computeRate", () => {
  it("should return the percentage rounded to one decimal", () => {
    // given / when
    const result = computeRate(1, 3);

    // then
    expect(result).toBe(33.3);
  });

  it("should return 100 when every attempt succeeded", () => {
    // given / when
    const result = computeRate(7, 7);

    // then
    expect(result).toBe(100);
  });

  it("should return 0 when there were no attempts", () => {
    // given / when
    const result = computeRate(0, 0);

    // then
    expect(result).toBe(0);
  });

  it("should return 0 when the total is negative", () => {
    // given / when
    const result = computeRate(5, -1);

    // then
    expect(result).toBe(0);
  });
});
