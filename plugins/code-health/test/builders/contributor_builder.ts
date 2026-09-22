import type {
  ConfluenceContributorMetrics,
  ContributorIdentity,
  ContributorSummary,
  JiraContributorMetrics,
  SonarMetrics,
  WakaTimeAiMetrics,
  WakaTimeMetrics,
} from "@rios0rios0/backstage-plugin-code-health-common";

let counter = 0;

export class ContributorBuilder {
  private props: ContributorSummary;

  constructor() {
    counter += 1;
    this.props = {
      key: `vcs:user-${counter}`,
      displayName: `user-${counter}`,
      avatarUrl: `https://avatars.githubusercontent.com/user-${counter}`,
      profileUrl: `https://github.com/user-${counter}`,
      entityRef: null,
      identities: [
        { source: "vcs", sourceKey: `user-${counter}`, displayName: `user-${counter}` },
      ],
      commits: 25,
      linesAdded: 700,
      linesDeleted: 300,
      linesOfCode: 400,
      changedFiles: 40,
      churnUnit: "lines",
      pullRequestsOpened: 10,
      pullRequestsMerged: 8,
      reviewsGiven: 10,
      reviewsRequested: 10,
      reviewsApproved: 5,
      reviewsRejected: 2,
      prApprovalRate: 50,
      pipelineRuns: 10,
      pipelineRunsSucceeded: 9,
      pipelineRunsFailed: 1,
      pipelineSuccessRate: 90,
      repositories: 3,
      sonarMetrics: null,
      wakaTimeMetrics: null,
      jiraMetrics: null,
      confluenceMetrics: null,
    };
  }

  static create(): ContributorBuilder {
    return new ContributorBuilder();
  }

  /** A contributor whose provider reports file churn rather than line churn. */
  withFileChurn(changedFiles: number): this {
    this.props = {
      ...this.props,
      churnUnit: "files",
      changedFiles,
      linesAdded: 0,
      linesDeleted: 0,
      linesOfCode: 0,
    };
    return this;
  }

  withoutChurn(): this {
    this.props = {
      ...this.props,
      churnUnit: "none",
      changedFiles: 0,
      linesAdded: 0,
      linesDeleted: 0,
      linesOfCode: 0,
    };
    return this;
  }

  withPullRequests(opened: number, merged: number): this {
    this.props = {
      ...this.props,
      pullRequestsOpened: opened,
      pullRequestsMerged: merged,
    };
    return this;
  }

  withKey(key: string): this {
    this.props = { ...this.props, key };
    return this;
  }

  withCommits(commits: number): this {
    this.props = { ...this.props, commits };
    return this;
  }

  withReviewsRequested(reviewsRequested: number): this {
    this.props = { ...this.props, reviewsRequested };
    return this;
  }

  withReviewsGiven(reviewsGiven: number): this {
    this.props = { ...this.props, reviewsGiven };
    return this;
  }

  withEntityRef(entityRef: string | null): this {
    this.props = { ...this.props, entityRef };
    return this;
  }

  withAvatarUrl(avatarUrl: string | null): this {
    this.props = { ...this.props, avatarUrl };
    return this;
  }

  withProfileUrl(profileUrl: string | null): this {
    this.props = { ...this.props, profileUrl };
    return this;
  }

  withDisplayName(displayName: string): this {
    this.props = {
      ...this.props,
      key: displayName,
      displayName,
      profileUrl: `https://github.com/${displayName}`,
      avatarUrl: `https://avatars.githubusercontent.com/${displayName}`,
    };
    return this;
  }

  /** A commit author with no linked account, which is common on Azure DevOps. */
  withoutProfile(): this {
    this.props = { ...this.props, avatarUrl: null, profileUrl: null };
    return this;
  }

  withLinesOfCode(lines: number): this {
    this.props = { ...this.props, linesOfCode: lines };
    return this;
  }

  withReviewsApproved(count: number): this {
    this.props = { ...this.props, reviewsApproved: count };
    return this;
  }

  withPrApprovalRate(rate: number): this {
    this.props = { ...this.props, prApprovalRate: rate };
    return this;
  }

  withPipelineSuccessRate(rate: number): this {
    this.props = { ...this.props, pipelineSuccessRate: rate };
    return this;
  }

  /** Every run counted, and the two verdicts among them; the rest were cancelled or skipped. */
  withPipelineRuns(counts: { runs: number; succeeded: number; failed: number }): this {
    const decided = counts.succeeded + counts.failed;
    this.props = {
      ...this.props,
      pipelineRuns: counts.runs,
      pipelineRunsSucceeded: counts.succeeded,
      pipelineRunsFailed: counts.failed,
      pipelineSuccessRate: decided === 0 ? 0 : Math.round((counts.succeeded / decided) * 1000) / 10,
    };
    return this;
  }

  withSonarMetrics(metrics: SonarMetrics): this {
    this.props = { ...this.props, sonarMetrics: metrics };
    return this;
  }

  withWakaTimeMetrics(metrics: WakaTimeMetrics): this {
    this.props = { ...this.props, wakaTimeMetrics: metrics };
    return this;
  }

  withJiraMetrics(metrics: JiraContributorMetrics | null): this {
    this.props = { ...this.props, jiraMetrics: metrics };
    return this;
  }

  withConfluenceMetrics(metrics: ConfluenceContributorMetrics | null): this {
    this.props = { ...this.props, confluenceMetrics: metrics };
    return this;
  }

  withIdentities(identities: readonly ContributorIdentity[]): this {
    this.props = { ...this.props, identities };
    return this;
  }

  build(): ContributorSummary {
    return { ...this.props };
  }
}

const EMPTY_AI: WakaTimeAiMetrics = {
  inputTokens: 0,
  outputTokens: 0,
  linesAddedByAi: 0,
  linesDeletedByAi: 0,
  linesAddedByHuman: 0,
  linesDeletedByHuman: 0,
  prompts: 0,
  sessions: 0,
  modelCosts: {},
  daysMeasured: 1,
};

/**
 * A window's worth of coding time.
 *
 * Written as an already-merged measurement rather than a day, because that is
 * what a contributor row carries: the backend merges the stored days before the
 * browser ever sees them.
 */
export class WakaTimeBuilder {
  private props: WakaTimeMetrics = {
    window: { from: "2026-08-01", to: "2026-08-10" },
    totalSeconds: 36_000,
    dailyAverageSeconds: 3600,
    activeDays: 8,
    measuredDays: 10,
    bestDay: { day: "2026-08-05", totalSeconds: 9000 },
    daily: [
      { day: "2026-08-05", totalSeconds: 9000 },
      { day: "2026-08-06", totalSeconds: 3600 },
    ],
    languages: [{ name: "TypeScript", totalSeconds: 30_000, percent: 83.3 }],
    editors: [{ name: "VS Code", totalSeconds: 36_000, percent: 100 }],
    projects: [{ name: "code-health", totalSeconds: 36_000, percent: 100 }],
    categories: [{ name: "Coding", totalSeconds: 30_000, percent: 83.3 }],
    operatingSystems: [],
    machines: [],
    branches: [{ name: "main", totalSeconds: 20_000, percent: 55.6 }],
    filesTouched: 42,
    ai: null,
  };

  static create(): WakaTimeBuilder {
    return new WakaTimeBuilder();
  }

  withTotalSeconds(totalSeconds: number): this {
    this.props = { ...this.props, totalSeconds };
    return this;
  }

  withBranches(names: readonly string[]): this {
    this.props = {
      ...this.props,
      branches: names.map((name) => ({ name, totalSeconds: 60, percent: 10 })),
    };
    return this;
  }

  withoutFileCount(): this {
    this.props = { ...this.props, filesTouched: null };
    return this;
  }

  withAi(overrides: Partial<WakaTimeAiMetrics> = {}): this {
    this.props = { ...this.props, ai: { ...EMPTY_AI, ...overrides } };
    return this;
  }

  build(): WakaTimeMetrics {
    return { ...this.props };
  }
}
