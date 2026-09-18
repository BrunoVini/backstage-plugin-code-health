import type {
  ConfluenceContributorMetrics,
  ContributorSummary,
  IntegrationCapabilities,
  JiraContributorMetrics,
  SonarMetrics,
  WakaTimeMetrics,
} from "../src";
import {
  EMPTY_JIRA_INTERACTIONS,
  EMPTY_JIRA_ISSUE_TYPES,
  NO_INTEGRATIONS,
} from "../src";
import {
  computeProductivityScore,
  EMPTY_FLEET_REFERENCE,
  fleetReferenceOf,
  PRODUCTIVITY_COMPONENTS,
  productivityComponentsFor,
} from "../src/productivity_score";
import { WakaTimeMetricsBuilder } from "./builders/wakatime_metrics_builder";

const aContributor = (overrides: Partial<ContributorSummary> = {}): ContributorSummary => ({
  key: "vcs:jane",
  displayName: "Jane",
  avatarUrl: null,
  profileUrl: null,
  entityRef: null,
  identities: [{ source: "vcs", sourceKey: "jane", displayName: "Jane" }],
  commits: 10,
  linesAdded: 500,
  linesDeleted: 100,
  linesOfCode: 400,
  changedFiles: 0,
  churnUnit: "lines",
  pullRequestsOpened: 4,
  pullRequestsMerged: 4,
  reviewsGiven: 6,
  reviewsApproved: 5,
  reviewsRejected: 1,
  prApprovalRate: 83.3,
  pipelineRuns: 10,
  pipelineRunsSucceeded: 8,
  pipelineRunsFailed: 2,
  pipelineSuccessRate: 80,
  repositories: 2,
  sonarMetrics: null,
  wakaTimeMetrics: null,
  jiraMetrics: null,
  confluenceMetrics: null,
  ...overrides,
});

const sonar = (overrides: Partial<SonarMetrics> = {}): SonarMetrics => ({
  bugs: 0,
  codeSmells: 0,
  securityHotspots: 0,
  vulnerabilities: 0,
  coverage: 40,
  duplications: 0,
  technicalDebt: "0min",
  technicalDebtMinutes: 0,
  qualityGateStatus: "OK",
  ...overrides,
});

const wakaTime = (totalSeconds: number): WakaTimeMetrics =>
  WakaTimeMetricsBuilder.aDay().withSeconds(totalSeconds).build();

const jira = (overrides: Partial<JiraContributorMetrics> = {}): JiraContributorMetrics => ({
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

const confluence = (
  overrides: Partial<ConfluenceContributorMetrics> = {},
): ConfluenceContributorMetrics => ({
  window: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-08T00:00:00.000Z" },
  pagesCreated: 0,
  pagesEdited: 0,
  pageVersionsAuthored: 0,
  blogPostsCreated: 0,
  commentsWritten: 0,
  attachmentsAdded: 0,
  spaceKeys: [],
  wordsAdded: null,
  wordsRemoved: null,
  volumeUnit: "none",
  pagesMeasuredForVolume: 0,
  pageViews: null,
  pagesMeasuredForViews: 0,
  analytics: "not-measured",
  ...overrides,
});

const WAKATIME_ONLY: IntegrationCapabilities = { ...NO_INTEGRATIONS, wakatime: true };
const JIRA_ONLY: IntegrationCapabilities = { ...NO_INTEGRATIONS, jira: true };
const CONFLUENCE_ONLY: IntegrationCapabilities = { ...NO_INTEGRATIONS, confluence: true };
const EVERYTHING: IntegrationCapabilities = {
  wakatime: true,
  jira: true,
  confluence: true,
};

const componentById = (
  score: ReturnType<typeof computeProductivityScore>,
  id: string,
) => score.components.find((component) => component.id === id);

const idsOf = (score: ReturnType<typeof computeProductivityScore>): string[] =>
  score.components.map((component) => component.id);

describe("fleetReferenceOf", () => {
  it("should take the mean daily rate of every relative component", () => {
    // given
    // The mean, not the maximum: against the top figure, one person having an
    // extraordinary month pushed everybody else down for reasons that had
    // nothing to do with them.
    const contributors = [
      aContributor({ commits: 3, pullRequestsMerged: 9, reviewsGiven: 1, linesOfCode: 50 }),
      aContributor({ commits: 12, pullRequestsMerged: 2, reviewsGiven: 7, linesOfCode: 900 }),
    ];

    // when
    const reference = fleetReferenceOf(contributors, 10);

    // then
    expect(reference).toEqual({
      days: 10,
      // (3 + 12) / 2 people / 10 days
      commits: 0.75,
      pullRequestsMerged: 0.55,
      reviewsGiven: 0.4,
      linesOfCode: 47.5,
      changedFiles: 0,
      codingSeconds: 0,
      issuesResolved: 0,
      documentationContributions: 0,
    });
  });

  it("should keep churn per unit so files never compete with lines", () => {
    // given
    const contributors = [
      aContributor({ churnUnit: "files", changedFiles: 30, linesOfCode: 0 }),
      aContributor({ churnUnit: "lines", linesOfCode: 400, changedFiles: 0 }),
      aContributor({ churnUnit: "none", linesOfCode: 9999, changedFiles: 9999 }),
    ];

    // when
    const reference = fleetReferenceOf(contributors, 1);

    // then
    // Each unit averages over its own rows alone, so the single lines row is
    // its own mean rather than being divided by all three. The `none` row
    // reports figures the provider never gave and is a reference for nobody.
    expect(reference.linesOfCode).toBe(400);
    expect(reference.changedFiles).toBe(30);
  });

  it("should average the integration figures over the rows they were measured on", () => {
    // given
    // A row with no metrics is an account nobody linked, not somebody who
    // recorded nothing. Counting it as a zero would drag the mean towards
    // nothing and flatter every row that does carry a figure — which matters
    // far more for a mean than it did for a maximum.
    const contributors = [
      aContributor({
        wakaTimeMetrics: wakaTime(7200),
        jiraMetrics: jira({ issuesResolved: 4 }),
        confluenceMetrics: confluence({ pagesCreated: 2, commentsWritten: 3 }),
      }),
      aContributor({
        wakaTimeMetrics: wakaTime(1800),
        jiraMetrics: jira({ issuesResolved: 11 }),
        confluenceMetrics: confluence({ attachmentsAdded: 1 }),
      }),
      aContributor(),
    ];

    // when
    const reference = fleetReferenceOf(contributors, 1);

    // then
    // Two measured rows, not three: (7200 + 1800) / 2, not / 3.
    expect(reference.codingSeconds).toBe(4500);
    expect(reference.issuesResolved).toBe(7.5);
    expect(reference.documentationContributions).toBe(3);
  });

  it("should keep somebody version control never saw out of the version-control means", () => {
    // given
    // A row known only to Jira carries `commits: 0` with no way to say "never
    // asked". Read as a measurement that zero lowered the commit mean and
    // raised every real committer's score; it is not zero commits.
    const contributors = [
      aContributor({ commits: 10, pullRequestsMerged: 4, reviewsGiven: 6 }),
      aContributor({
        key: "jira:acct-1",
        identities: [{ source: "jira", sourceKey: "acct-1", displayName: "Only Jira" }],
        commits: 0,
        pullRequestsMerged: 0,
        reviewsGiven: 0,
        churnUnit: "none",
        jiraMetrics: jira({ issuesResolved: 4 }),
      }),
    ];

    // when
    const reference = fleetReferenceOf(contributors, 1);

    // then
    expect(reference.commits).toBe(10);
    expect(reference.pullRequestsMerged).toBe(4);
    expect(reference.reviewsGiven).toBe(6);
    expect(reference.issuesResolved).toBe(4);
  });

  it("should count a quiet version-control account as a real zero", () => {
    // given
    // The other half of the rule: an account version control knows that did
    // nothing in the window is a measured zero, and it moves the mean.
    const contributors = [
      aContributor({ commits: 10 }),
      aContributor({ key: "vcs:quiet", commits: 0 }),
    ];

    // when
    const reference = fleetReferenceOf(contributors, 1);

    // then
    expect(reference.commits).toBe(5);
  });

  it("should floor the window at a fraction of a day", () => {
    // given
    // The shortest range the dashboard offers is an hour, and a zero
    // denominator would turn every rate into infinity on exactly the range a
    // freshly installed plugin opens with.
    const contributors = [aContributor({ commits: 1 })];

    // when
    const reference = fleetReferenceOf(contributors, 0);

    // then
    expect(Number.isFinite(reference.commits)).toBe(true);
    expect(reference.commits).toBe(24);
  });

  it("should be empty for nobody", () => {
    // given / when / then
    expect(fleetReferenceOf([], 1)).toEqual(EMPTY_FLEET_REFERENCE);
  });
});

describe("productivityComponentsFor", () => {
  it("should weight the components to one whatever is configured", () => {
    // given
    // Three independent flags is exactly what the backend can be configured
    // with, so all eight readings of it are enumerated rather than sampled.
    const combinations: IntegrationCapabilities[] = [false, true].flatMap((wakatime) =>
      [false, true].flatMap((jiraOn) =>
        [false, true].map((confluenceOn) => ({
          wakatime,
          jira: jiraOn,
          confluence: confluenceOn,
        })),
      ),
    );

    // when
    const totals = combinations.map((capabilities) =>
      productivityComponentsFor(capabilities).reduce(
        (sum, definition) => sum + definition.weight,
        0,
      ),
    );

    // then
    expect(totals).toHaveLength(8);
    for (const total of totals) {
      expect(total).toBeCloseTo(1, 10);
    }
  });

  it("should leave the nominal weights adding up to more than one", () => {
    // given / when
    const nominal = Object.values(PRODUCTIVITY_COMPONENTS).reduce(
      (sum, component) => sum + component.weight,
      0,
    );

    // then
    // The nominal figures say what each component is worth against the others,
    // not against a total — which is the whole reason they can be renormalised.
    expect(nominal).toBeCloseTo(1.4, 10);
  });

  it("should share a component's weight out over what is configured", () => {
    // given / when
    const alone = productivityComponentsFor();
    const everything = productivityComponentsFor(EVERYTHING);

    // then
    // Commits are worth a fifth of a score built on code alone, and about a
    // seventh once three more systems are being read alongside it.
    expect(alone.find((definition) => definition.id === "commits")?.weight).toBe(0.2);
    expect(everything.find((definition) => definition.id === "commits")?.weight).toBeCloseTo(
      0.2 / 1.4,
      10,
    );
  });

  it("should offer only the components the configured integrations bring", () => {
    // given / when
    const ids = (capabilities?: IntegrationCapabilities) =>
      productivityComponentsFor(capabilities).map((definition) => definition.id);

    // then
    expect(ids()).not.toContain("codingTime");
    expect(ids(WAKATIME_ONLY)).toContain("codingTime");
    expect(ids(WAKATIME_ONLY)).not.toContain("ticketsResolved");
    expect(ids(JIRA_ONLY)).toEqual(expect.arrayContaining(["ticketsResolved", "reopened"]));
    expect(ids(CONFLUENCE_ONLY)).toContain("documentation");
    expect(ids(EVERYTHING)).toHaveLength(11);
  });
});

describe("computeProductivityScore", () => {
  it("should score an install with no integration exactly as it did before there were any", () => {
    // given
    const contributor = aContributor({ sonarMetrics: sonar({ coverage: 80 }) });
    const reference = fleetReferenceOf([contributor], 1);

    // when
    const score = computeProductivityScore(contributor, reference);

    // then
    // The seven original components at the seven original weights: switching
    // nothing on has to leave the workings where they were.
    expect(score.components.map(({ id, weight }) => [id, weight])).toEqual([
      ["commits", 0.2],
      ["pullRequestsMerged", 0.2],
      ["churn", 0.1],
      ["reviewsGiven", 0.15],
      ["pipelineSuccessRate", 0.15],
      ["qualityGate", 0.1],
      ["coverage", 0.1],
    ]);
    expect(score.evidence).toBe(1);
  });

  it("should score the only person measured at half on every relative component", () => {
    // given
    // They are the team average by definition, and average is half — not the
    // full marks the top-figure reference used to hand out for being alone.
    const contributor = aContributor({ sonarMetrics: sonar({ coverage: 80 }) });
    const reference = fleetReferenceOf([contributor], 1);

    // when
    const score = computeProductivityScore(contributor, reference);

    // then
    expect(componentById(score, "commits")?.normalized).toBe(0.5);
    expect(componentById(score, "churn")?.normalized).toBe(0.5);
  });

  it("should not let a component's sentence contradict the share it explains", () => {
    // given
    // Thirty reviews over a thirty-day window against a fleet mean of half a
    // day. The two halves used to pick their own period, so the detail read
    // "1 review a day against the team's average of 3.5 reviews a week" —
    // well behind the team — beside a normalized score of full marks.
    const contributor = aContributor({ reviewsGiven: 30 });
    const reference = { ...EMPTY_FLEET_REFERENCE, days: 30, reviewsGiven: 0.5 };

    // when
    const score = computeProductivityScore(contributor, reference);
    const reviews = componentById(score, "reviewsGiven");

    // then
    expect(reviews?.normalized).toBe(1);
    // Seven a week against three and a half: the twice-the-team the score says.
    expect(reviews?.detail).toBe(
      "7 reviews a week against the team's average of 3.5 reviews a week",
    );
  });

  it("should give full marks for twice the team's average rate", () => {
    // given
    // Keeping pace scores half and doubling it scores everything, so
    // "average" reads as average rather than as a failure.
    const average = aContributor({ commits: 10, linesOfCode: 400 });
    const double = aContributor({ key: "vcs:sam", commits: 20, linesOfCode: 800 });
    const reference = fleetReferenceOf([average, double], 1);

    // when
    const doubled = computeProductivityScore(double, reference);
    const below = computeProductivityScore(average, reference);

    // then
    // The mean of 10 and 20 is 15; twice that is 30, so 20 lands at two thirds.
    expect(componentById(doubled, "commits")?.normalized).toBeCloseTo(20 / 30, 3);
    expect(componentById(below, "commits")?.normalized).toBeCloseTo(10 / 30, 3);
  });

  it("should not let one outlier flatten everybody else", () => {
    // given
    // The failure the top-figure reference had: one person having an
    // extraordinary month pushed every colleague down for reasons that had
    // nothing to do with them.
    const steady = aContributor({ commits: 10 });
    const peers = [steady, aContributor({ key: "b", commits: 10 }), aContributor({ key: "c", commits: 10 })];

    // when
    const withoutOutlier = computeProductivityScore(steady, fleetReferenceOf(peers, 1));
    const withOutlier = computeProductivityScore(
      steady,
      fleetReferenceOf([...peers, aContributor({ key: "d", commits: 200 })], 1),
    );

    // then
    // Against the maximum this would have collapsed from 0.5 to 0.025. Against
    // the mean it moves by the outlier's share of four people, not by its size.
    expect(componentById(withoutOutlier, "commits")?.normalized).toBe(0.5);
    expect(componentById(withOutlier, "commits")?.normalized).toBeCloseTo(10 / 115, 3);
  });

  it("should read output as a rate against twice the team's average rate", () => {
    // given
    const contributor = aContributor({ commits: 5, pullRequestsMerged: 1, reviewsGiven: 0 });
    const reference = { ...EMPTY_FLEET_REFERENCE, commits: 20, pullRequestsMerged: 4, reviewsGiven: 8, linesOfCode: 800 };

    // when
    const score = computeProductivityScore(contributor, reference);

    // then
    // 5 a day against a mean of 20 a day: a share of the 40 that scores full.
    expect(componentById(score, "commits")).toMatchObject({
      value: 5,
      normalized: 0.125,
      detail: "5 commits a day against the team's average of 20 commits a day",
    });
    expect(componentById(score, "reviewsGiven")).toMatchObject({ value: 0, normalized: 0 });
    expect(componentById(score, "churn")?.normalized).toBe(0.25);
  });

  it("should leave a relative component unmeasured when nobody recorded any", () => {
    // given
    const contributor = aContributor({ reviewsGiven: 0 });
    const reference = { ...fleetReferenceOf([contributor], 1), reviewsGiven: 0 };

    // when
    const score = computeProductivityScore(contributor, reference);

    // then
    // A week with no review anywhere says nothing about anyone.
    expect(componentById(score, "reviewsGiven")).toMatchObject({
      normalized: null,
      detail: "nobody recorded any reviews in this window",
    });
  });

  it("should compare file churn with file churn", () => {
    // given
    const contributor = aContributor({ churnUnit: "files", changedFiles: 15, linesOfCode: 0 });
    const reference = { ...EMPTY_FLEET_REFERENCE, commits: 10, changedFiles: 30, linesOfCode: 5000 };

    // when
    const score = computeProductivityScore(contributor, reference);

    // then
    expect(componentById(score, "churn")).toMatchObject({
      value: 15,
      normalized: 0.25,
      detail: "15 changed files a day against the team's average of 30 changed files a day",
    });
  });

  it("should leave churn unmeasured when the provider reported none", () => {
    // given
    const contributor = aContributor({ churnUnit: "none" });

    // when
    const score = computeProductivityScore(contributor, fleetReferenceOf([contributor], 1));

    // then
    expect(componentById(score, "churn")?.normalized).toBeNull();
  });

  it("should read the pipeline over decided runs and leave it unmeasured with none", () => {
    // given
    const decided = aContributor({ pipelineRunsSucceeded: 3, pipelineRunsFailed: 1, pipelineSuccessRate: 75 });
    const undecided = aContributor({ pipelineRuns: 4, pipelineRunsSucceeded: 0, pipelineRunsFailed: 0, pipelineSuccessRate: 0 });

    // when
    const decidedScore = computeProductivityScore(decided, fleetReferenceOf([decided], 1));
    const undecidedScore = computeProductivityScore(undecided, fleetReferenceOf([undecided], 1));

    // then
    expect(componentById(decidedScore, "pipelineSuccessRate")).toMatchObject({
      value: 75,
      normalized: 0.75,
      detail: "3 of 4 decided runs succeeded",
    });
    // Four cancelled runs are not four failures.
    expect(componentById(undecidedScore, "pipelineSuccessRate")?.normalized).toBeNull();
  });

  it("should score the quality gate and coverage of the code touched", () => {
    // given
    const failing = aContributor({ sonarMetrics: sonar({ qualityGateStatus: "ERROR", coverage: 40 }) });

    // when
    const score = computeProductivityScore(failing, fleetReferenceOf([failing], 1));

    // then
    expect(componentById(score, "qualityGate")).toMatchObject({ value: 0, normalized: 0 });
    // Forty against the eighty percent gate is half way there.
    expect(componentById(score, "coverage")).toMatchObject({ value: 40, normalized: 0.5 });
  });

  it("should leave Sonar components unmeasured without a project or a gate", () => {
    // given
    const unmeasured = aContributor({ sonarMetrics: null });
    const noGate = aContributor({ sonarMetrics: sonar({ qualityGateStatus: "NONE" }) });

    // when
    const unmeasuredScore = computeProductivityScore(unmeasured, fleetReferenceOf([unmeasured], 1));
    const noGateScore = computeProductivityScore(noGate, fleetReferenceOf([noGate], 1));

    // then
    expect(componentById(unmeasuredScore, "qualityGate")?.normalized).toBeNull();
    expect(componentById(unmeasuredScore, "coverage")?.normalized).toBeNull();
    expect(componentById(noGateScore, "qualityGate")?.normalized).toBeNull();
    expect(componentById(noGateScore, "coverage")?.normalized).toBe(0.5);
  });

  it("should have no score for somebody nothing measured", () => {
    // given
    const idle = aContributor({
      commits: 0,
      pullRequestsMerged: 0,
      reviewsGiven: 0,
      churnUnit: "none",
      pipelineRunsSucceeded: 0,
      pipelineRunsFailed: 0,
    });

    // when
    const score = computeProductivityScore(idle, EMPTY_FLEET_REFERENCE);

    // then
    expect(score.value).toBeNull();
    expect(score.evidence).toBe(0);
  });

  it("should leave the version-control components unmeasured for somebody version control never saw", () => {
    // given
    // Their zero commits are not a measurement, and a measured zero would put
    // a nought on the row of somebody whose work all happened in Jira. The
    // absence is named as an unlinked account, which is the one cause
    // somebody can go and fix.
    const onlyJira = aContributor({
      key: "jira:acct-1",
      identities: [{ source: "jira", sourceKey: "acct-1", displayName: "Only Jira" }],
      commits: 0,
      pullRequestsMerged: 0,
      reviewsGiven: 0,
      churnUnit: "none",
      pipelineRunsSucceeded: 0,
      pipelineRunsFailed: 0,
      jiraMetrics: jira({ issuesResolved: 4 }),
    });
    const committer = aContributor({ jiraMetrics: jira({ issuesResolved: 4 }) });
    const reference = fleetReferenceOf([committer, onlyJira], 1);

    // when
    const score = computeProductivityScore(onlyJira, reference, JIRA_ONLY);

    // then
    for (const id of ["commits", "pullRequestsMerged", "churn", "reviewsGiven", "pipelineSuccessRate"]) {
      expect(componentById(score, id)).toMatchObject({
        normalized: null,
        detail: "no version-control account is linked to this person",
      });
    }
    expect(componentById(score, "ticketsResolved")?.normalized).toBe(0.5);
  });

  it("should score only the integrations that are configured, never the ones a row carries", () => {
    // given
    // The row holds all three measures. Whether they count is a question about
    // the backend's configuration, and a row that happens to carry a value
    // cannot answer it — an integration switched off collected these on some
    // earlier run, and one switched on may not have run yet.
    const contributor = aContributor({
      wakaTimeMetrics: wakaTime(3600),
      jiraMetrics: jira({ issuesResolved: 4 }),
      confluenceMetrics: confluence({ pagesCreated: 3 }),
    });
    const reference = fleetReferenceOf([contributor], 1);

    // when
    const off = computeProductivityScore(contributor, reference);
    const jiraOn = computeProductivityScore(contributor, reference, JIRA_ONLY);

    // then
    expect(idsOf(off)).not.toEqual(
      expect.arrayContaining(["codingTime", "ticketsResolved", "reopened", "documentation"]),
    );
    expect(idsOf(jiraOn)).toEqual(expect.arrayContaining(["ticketsResolved", "reopened"]));
    expect(idsOf(jiraOn)).not.toContain("codingTime");
    expect(idsOf(jiraOn)).not.toContain("documentation");
  });

  it("should read coding time as a rate against the team's average", () => {
    // given
    const contributor = aContributor({ wakaTimeMetrics: wakaTime(5400) });
    const reference = { ...fleetReferenceOf([contributor], 1), codingSeconds: 9000 };

    // when
    const score = computeProductivityScore(contributor, reference, WAKATIME_ONLY);

    // then
    expect(componentById(score, "codingTime")).toMatchObject({
      value: 5400,
      normalized: 0.3,
      detail: "1h 30m a day against the team's average of 2h 30m a day",
    });
  });

  it("should leave coding time unmeasured for an account nobody has linked", () => {
    // given
    const contributor = aContributor({ wakaTimeMetrics: null });

    // when
    const score = computeProductivityScore(
      contributor,
      { ...fleetReferenceOf([contributor], 1), codingSeconds: 9000 },
      WAKATIME_ONLY,
    );

    // then
    // Naming the cause is what makes it fixable: it is one link away on the
    // Identities screen, unlike every other reason a figure can be missing.
    expect(componentById(score, "codingTime")).toMatchObject({
      normalized: null,
      detail: "no WakaTime account is linked to this person",
    });
  });

  it("should leave coding time unmeasured when nobody in the fleet logged any", () => {
    // given
    const contributor = aContributor({ wakaTimeMetrics: wakaTime(0) });

    // when
    const score = computeProductivityScore(
      contributor,
      fleetReferenceOf([contributor], 1),
      WAKATIME_ONLY,
    );

    // then
    expect(componentById(score, "codingTime")).toMatchObject({
      normalized: null,
      detail: "nobody recorded any coding time in this window",
    });
  });

  it("should read resolved tickets as a rate against the team's average", () => {
    // given
    const contributor = aContributor({ jiraMetrics: jira({ issuesResolved: 3 }) });
    const reference = { ...fleetReferenceOf([contributor], 1), issuesResolved: 6 };

    // when
    const score = computeProductivityScore(contributor, reference, JIRA_ONLY);

    // then
    expect(componentById(score, "ticketsResolved")).toMatchObject({
      value: 3,
      normalized: 0.25,
      detail: "3 resolved tickets a day against the team's average of 6 resolved tickets a day",
    });
  });

  it("should leave both Jira components unmeasured for an account nobody has linked", () => {
    // given
    const contributor = aContributor({ jiraMetrics: null });
    const reference = { ...fleetReferenceOf([contributor], 1), issuesResolved: 6 };

    // when
    const score = computeProductivityScore(contributor, reference, JIRA_ONLY);

    // then
    expect(componentById(score, "ticketsResolved")).toMatchObject({
      normalized: null,
      detail: "no Jira account is linked to this person",
    });
    expect(componentById(score, "reopened")).toMatchObject({
      normalized: null,
      detail: "no Jira account is linked to this person",
    });
  });

  it("should leave resolved tickets unmeasured when nobody in the fleet resolved any", () => {
    // given
    const contributor = aContributor({ jiraMetrics: jira() });

    // when
    const score = computeProductivityScore(
      contributor,
      fleetReferenceOf([contributor], 1),
      JIRA_ONLY,
    );

    // then
    expect(componentById(score, "ticketsResolved")).toMatchObject({
      normalized: null,
      detail: "nobody recorded any resolved tickets in this window",
    });
  });

  it("should score reopened tickets against this person's own resolved ones", () => {
    // given
    // Absolute, unlike everything else Jira contributes: a ticket coming back
    // is a fact about that ticket rather than a race against other people's.
    const contributor = aContributor({
      jiraMetrics: jira({ issuesResolved: 6, reopened: 1 }),
    });

    // when
    const score = computeProductivityScore(
      contributor,
      { ...fleetReferenceOf([contributor], 1), issuesResolved: 60 },
      JIRA_ONLY,
    );

    // then
    expect(componentById(score, "reopened")).toMatchObject({
      value: 1,
      normalized: 0.8333,
      detail: "1 of 6 resolved tickets was reopened",
    });
  });

  it("should floor reopened tickets at zero rather than below it", () => {
    // given
    // More reopenings than resolutions is ordinary — a ticket can come back
    // twice, and one resolved before the window can come back inside it.
    const contributor = aContributor({
      jiraMetrics: jira({ issuesResolved: 2, reopened: 5 }),
    });

    // when
    const score = computeProductivityScore(
      contributor,
      fleetReferenceOf([contributor], 1),
      JIRA_ONLY,
    );

    // then
    expect(componentById(score, "reopened")).toMatchObject({
      normalized: 0,
      detail: "5 of 2 resolved tickets were reopened",
    });
  });

  it("should leave reopened tickets unmeasured for somebody who resolved none", () => {
    // given
    const contributor = aContributor({ jiraMetrics: jira({ issuesResolved: 0 }) });

    // when
    const score = computeProductivityScore(
      contributor,
      { ...fleetReferenceOf([contributor], 1), issuesResolved: 9 },
      JIRA_ONLY,
    );

    // then
    // Closing no ticket is not the same as failing to keep one closed.
    expect(componentById(score, "reopened")).toMatchObject({
      normalized: null,
      detail: "no ticket resolved",
    });
  });

  it("should read documentation against the team's average over Confluence's trailing window", () => {
    // given
    // Pages, versions, blog posts, comments and attachments together — writing
    // a page and answering three questions on somebody else's both count.
    const contributor = aContributor({
      confluenceMetrics: confluence({ pagesCreated: 2, commentsWritten: 3 }),
    });
    const reference = { ...fleetReferenceOf([contributor], 1), documentationContributions: 10 };

    // when
    const score = computeProductivityScore(contributor, reference, CONFLUENCE_ONLY);

    // then
    expect(componentById(score, "documentation")).toMatchObject({
      value: 5,
      normalized: 0.25,
      detail:
        "5 Confluence contributions against the team's average of 10 over Confluence's trailing window, not the range picked",
    });
  });

  it("should leave documentation unmeasured for an account nobody has linked", () => {
    // given
    const contributor = aContributor({ confluenceMetrics: null });
    const reference = { ...fleetReferenceOf([contributor], 1), documentationContributions: 10 };

    // when
    const score = computeProductivityScore(contributor, reference, CONFLUENCE_ONLY);

    // then
    expect(componentById(score, "documentation")).toMatchObject({
      normalized: null,
      detail: "no Confluence account is linked to this person",
    });
  });

  it("should leave documentation unmeasured when nobody in the fleet wrote any", () => {
    // given
    const contributor = aContributor({ confluenceMetrics: confluence() });

    // when
    const score = computeProductivityScore(
      contributor,
      fleetReferenceOf([contributor], 1),
      CONFLUENCE_ONLY,
    );

    // then
    expect(componentById(score, "documentation")).toMatchObject({
      normalized: null,
      detail: "nobody recorded any Confluence contributions over Confluence's trailing window",
    });
  });

  it("should weigh every component less once the integrations join the score", () => {
    // given
    const contributor = aContributor({
      sonarMetrics: sonar({ coverage: 80 }),
      wakaTimeMetrics: wakaTime(3600),
      jiraMetrics: jira({ issuesResolved: 4, reopened: 0 }),
      confluenceMetrics: confluence({ pagesCreated: 5 }),
    });
    const reference = fleetReferenceOf([contributor], 1);

    // when
    const score = computeProductivityScore(contributor, reference, EVERYTHING);

    // then
    expect(score.components).toHaveLength(11);
    expect(componentById(score, "commits")?.weight).toBeCloseTo(0.2 / 1.4, 10);
    // The only person measured is the team average, so every *relative*
    // component lands at half — including the ones the integrations added.
    expect(componentById(score, "codingTime")?.normalized).toBe(0.5);
    // `reopened` is absolute, so being alone says nothing about it: nothing
    // they resolved came back, which is full marks whoever else is on the team.
    expect(componentById(score, "reopened")?.normalized).toBe(1);
    expect(score.evidence).toBe(1);
  });
});
