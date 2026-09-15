import type { RepositorySummary, SonarMetrics } from "../src";
import { EMPTY_REPOSITORY_ACTIVITY } from "../src/repository_summary";
import {
  computeRepositoryHealthScore,
  DEBT_HALF_POINT_MINUTES,
  DEFECTS_HALF_POINT,
  REPOSITORY_HEALTH_COMPONENTS,
} from "../src/repository_health_score";

const aRepository = (overrides: Partial<RepositorySummary> = {}): RepositorySummary => ({
  id: "repo-1",
  entityRef: "component:default/repo-1",
  ownerProfile: null,
  ownerRef: "group:default/platform",
  platform: "github",
  name: "repo-1",
  fullName: "acme/repo-1",
  url: "https://github.com/acme/repo-1",
  description: null,
  primaryLanguage: null,
  visibility: "PRIVATE",
  isArchived: false,
  isFork: false,
  defaultBranch: "main",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ciStatus: null,
  latestRelease: null,
  latestTag: null,
  branches: ["main"],
  sonarMetrics: null,
  complianceStatus: null,
  documentation: null,
  apiExposure: null,
  badgeStatus: null,
  wakaTimeMetrics: null,
  jiraMetrics: null,
  confluenceMetrics: null,
  activity: EMPTY_REPOSITORY_ACTIVITY,
  ...overrides,
});

const sonar = (overrides: Partial<SonarMetrics> = {}): SonarMetrics => ({
  bugs: 0,
  codeSmells: 0,
  securityHotspots: 0,
  vulnerabilities: 0,
  coverage: 80,
  duplications: 0,
  technicalDebt: "0min",
  technicalDebtMinutes: 0,
  qualityGateStatus: "OK",
  ...overrides,
});

const ci = (state: "SUCCESS" | "FAILURE" | "PENDING" | "ERROR") => ({
  state,
  commitSha: "abc",
  commitMessage: "msg",
  commitUrl: "https://example.test",
});

const componentById = (
  score: ReturnType<typeof computeRepositoryHealthScore>,
  id: string,
) => score.components.find((component) => component.id === id);

describe("computeRepositoryHealthScore", () => {
  it("should weight the components to one", () => {
    // given / when
    const total = Object.values(REPOSITORY_HEALTH_COMPONENTS).reduce(
      (sum, component) => sum + component.weight,
      0,
    );

    // then
    expect(total).toBeCloseTo(1, 10);
  });

  it("should give a spotless, well-run repository full marks", () => {
    // given
    const repository = aRepository({
      sonarMetrics: sonar(),
      ciStatus: ci("SUCCESS"),
      complianceStatus: {
        pipelineExists: true,
        buildPolicyOnPRs: true,
        buildPolicyExpiration: true,
        branchProtection: true,
        color: "green",
      },
      documentation: {
        hasTechDocs: true,
        hasDocsSource: true,
        hasReadme: true,
        hasExternalDocs: false,
        state: "documented",
      },
      activity: {
        ...EMPTY_REPOSITORY_ACTIVITY,
        buildsSucceeded: 5,
        pullRequestsMerged: 4,
        reviews: 6,
      },
    });

    // when
    const score = computeRepositoryHealthScore(repository);

    // then
    expect(score.value).toBe(100);
    expect(score.evidence).toBe(1);
  });

  it("should have no score before the first snapshot and with no activity", () => {
    // given / when
    const score = computeRepositoryHealthScore(aRepository());

    // then
    expect(score.value).toBeNull();
    expect(score.evidence).toBe(0);
    expect(componentById(score, "ciStatus")?.detail).toBe(
      "not measured until the first daily snapshot",
    );
  });

  it("should decay the defect component rather than cutting it off", () => {
    // given
    // Five bug-equivalents: three bugs and one vulnerability, which counts double.
    const repository = aRepository({ sonarMetrics: sonar({ bugs: 3, vulnerabilities: 1 }) });

    // when
    const score = computeRepositoryHealthScore(repository);

    // then
    expect(componentById(score, "defects")).toMatchObject({
      value: DEFECTS_HALF_POINT,
      normalized: 0.5,
      detail: "3 bugs and 1 vulnerability; 5 bug-equivalents halve this",
    });
  });

  it("should halve the debt component at five working days", () => {
    // given
    const repository = aRepository({
      sonarMetrics: sonar({ technicalDebtMinutes: DEBT_HALF_POINT_MINUTES, technicalDebt: "5d" }),
    });

    // when
    const score = computeRepositoryHealthScore(repository);

    // then
    expect(componentById(score, "technicalDebt")?.normalized).toBe(0.5);
  });

  it("should score duplication against its ceiling", () => {
    // given
    const repository = aRepository({ sonarMetrics: sonar({ duplications: 10 }) });

    // when
    const score = computeRepositoryHealthScore(repository);

    // then
    expect(componentById(score, "duplications")?.normalized).toBe(0.5);
  });

  it("should read coverage against the Sonar gate and the gate as pass or fail", () => {
    // given
    const repository = aRepository({
      sonarMetrics: sonar({ coverage: 20, qualityGateStatus: "ERROR" }),
    });

    // when
    const score = computeRepositoryHealthScore(repository);

    // then
    expect(componentById(score, "coverage")?.normalized).toBe(0.25);
    expect(componentById(score, "qualityGate")).toMatchObject({ value: 0, normalized: 0 });
  });

  it("should leave a gate Sonar does not report unmeasured", () => {
    // given
    const repository = aRepository({ sonarMetrics: sonar({ qualityGateStatus: "NONE" }) });

    // when
    const score = computeRepositoryHealthScore(repository);

    // then
    expect(componentById(score, "qualityGate")?.normalized).toBeNull();
  });

  it("should treat a pending default-branch run as unmeasured and a failed one as zero", () => {
    // given
    const pending = aRepository({ ciStatus: ci("PENDING") });
    const failed = aRepository({ ciStatus: ci("ERROR") });

    // when
    const pendingScore = computeRepositoryHealthScore(pending);
    const failedScore = computeRepositoryHealthScore(failed);

    // then
    expect(componentById(pendingScore, "ciStatus")).toMatchObject({
      normalized: null,
      detail: "the last run on the default branch is pending",
    });
    expect(componentById(failedScore, "ciStatus")?.normalized).toBe(0);
  });

  it("should read build success over decided builds only", () => {
    // given
    const repository = aRepository({
      activity: { ...EMPTY_REPOSITORY_ACTIVITY, builds: 10, buildsSucceeded: 3, buildsFailed: 1 },
    });

    // when
    const score = computeRepositoryHealthScore(repository);

    // then
    // Six cancelled builds are on neither side.
    expect(componentById(score, "buildSuccessRate")).toMatchObject({
      value: 75,
      normalized: 0.75,
      detail: "3 of 4 decided builds succeeded",
    });
  });

  it("should count the compliance checks that pass", () => {
    // given
    const repository = aRepository({
      complianceStatus: {
        pipelineExists: true,
        buildPolicyOnPRs: false,
        buildPolicyExpiration: true,
        branchProtection: false,
        color: "red",
      },
    });

    // when
    const score = computeRepositoryHealthScore(repository);

    // then
    expect(componentById(score, "compliance")).toMatchObject({
      value: 2,
      normalized: 0.5,
      detail: "2 of 4 checks pass",
    });
  });

  it("should grade documentation by state and skip an archived repository", () => {
    // given
    const documentation = (state: "documented" | "unpublished" | "missing" | "not-expected") =>
      aRepository({
        documentation: {
          hasTechDocs: false,
          hasDocsSource: false,
          hasReadme: true,
          hasExternalDocs: false,
          state,
        },
      });

    // when
    const grades = (["documented", "unpublished", "missing", "not-expected"] as const).map(
      (state) => componentById(computeRepositoryHealthScore(documentation(state)), "documentation")?.normalized,
    );

    // then
    expect(grades).toEqual([1, 0.5, 0, null]);
  });

  it("should cap review coverage at one review per merged pull request", () => {
    // given
    const repository = aRepository({
      activity: { ...EMPTY_REPOSITORY_ACTIVITY, pullRequestsMerged: 2, reviews: 5 },
    });

    // when
    const score = computeRepositoryHealthScore(repository);

    // then
    expect(componentById(score, "reviewCoverage")).toMatchObject({
      value: 5,
      normalized: 1,
      detail: "5 reviews against 2 merged pull requests",
    });
  });

  it("should read abandonment over the pull requests that closed", () => {
    // given
    const repository = aRepository({
      activity: { ...EMPTY_REPOSITORY_ACTIVITY, pullRequestsMerged: 3, pullRequestsAbandoned: 1 },
    });

    // when
    const score = computeRepositoryHealthScore(repository);

    // then
    expect(componentById(score, "abandonment")).toMatchObject({
      value: 3,
      normalized: 0.75,
      detail: "3 of 4 closed pull requests merged rather than abandoned",
    });
  });

  it("should leave the window components unmeasured with nothing in the window", () => {
    // given / when
    const score = computeRepositoryHealthScore(aRepository({ sonarMetrics: sonar() }));

    // then
    expect(componentById(score, "reviewCoverage")?.normalized).toBeNull();
    expect(componentById(score, "abandonment")?.normalized).toBeNull();
    expect(componentById(score, "buildSuccessRate")?.normalized).toBeNull();
    // Only the five Sonar components could be measured.
    expect(score.evidence).toBe(0.5);
  });
});
