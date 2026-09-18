import { formatCount, formatFixed } from "./number_format";
import type { RepositorySummary } from "./repository_summary";
import {
  combineScore,
  measuredComponent,
  shareOf,
  unmeasuredComponent,
  type Score,
  type ScoreComponent,
  type ScoreComponentDefinition,
} from "./score";
import { SONAR_COVERAGE_TARGET } from "./sonar_metrics";

/**
 * How well a repository is being looked after, as one number with its workings.
 *
 * Every component is absolute — a failing gate is a failing gate whatever the
 * rest of the fleet looks like — and every component that could not be
 * measured is left out rather than scored as zero, with `evidence` saying how
 * much of the weight survived. Three of the Sonar components decay rather than
 * cut off, because "five bugs" and "five hundred bugs" should not read the
 * same, and the constants that shape the curves are named below so the
 * reading is reproducible.
 */
export type RepositoryHealthScore = Score;

/** Bugs plus twice the vulnerabilities at which the defect component is halved. */
export const DEFECTS_HALF_POINT = 5;

/** Technical debt at which that component is halved: five working days. */
export const DEBT_HALF_POINT_MINUTES = 5 * 8 * 60;

/** Duplicated share at which the duplication component reaches zero. */
export const DUPLICATION_CEILING_PERCENT = 20;

export const REPOSITORY_HEALTH_COMPONENTS = {
  qualityGate: { id: "qualityGate", label: "Quality gate", weight: 0.15 },
  coverage: { id: "coverage", label: "Test coverage", weight: 0.15 },
  defects: { id: "defects", label: "Bugs and vulnerabilities", weight: 0.1 },
  duplications: { id: "duplications", label: "Duplication", weight: 0.05 },
  technicalDebt: { id: "technicalDebt", label: "Technical debt", weight: 0.05 },
  ciStatus: { id: "ciStatus", label: "Default branch build", weight: 0.1 },
  buildSuccessRate: { id: "buildSuccessRate", label: "Build success", weight: 0.1 },
  compliance: { id: "compliance", label: "Branch and build policy", weight: 0.1 },
  documentation: { id: "documentation", label: "Documentation", weight: 0.05 },
  reviewCoverage: { id: "reviewCoverage", label: "Review coverage", weight: 0.1 },
  abandonment: { id: "abandonment", label: "Pull requests landed", weight: 0.05 },
} as const satisfies Record<string, ScoreComponentDefinition>;

const NO_SONAR = "no Sonar project is named by the catalog entity";
const NO_SNAPSHOT = "not measured until the first daily snapshot";

const plural = (count: number, noun: string): string =>
  `${formatCount(count)} ${noun}${count === 1 ? "" : "s"}`;

const vulnerabilities = (count: number): string =>
  `${formatCount(count)} ${count === 1 ? "vulnerability" : "vulnerabilities"}`;

/** A curve that starts at one and halves at `halfPoint`, never reaching zero. */
const decay = (value: number, halfPoint: number): number => 1 / (1 + value / halfPoint);

const qualityGateOf = (summary: RepositorySummary): ScoreComponent => {
  const definition = REPOSITORY_HEALTH_COMPONENTS.qualityGate;
  const sonar = summary.sonarMetrics;
  if (sonar === null) return unmeasuredComponent(definition, NO_SONAR);
  if (sonar.qualityGateStatus === "NONE") {
    return unmeasuredComponent(definition, "Sonar reports no gate for the project");
  }
  const passing = sonar.qualityGateStatus === "OK";
  return measuredComponent(
    definition,
    passing ? 1 : 0,
    passing ? 1 : 0,
    passing ? "the quality gate passes" : "the quality gate fails",
  );
};

const coverageOf = (summary: RepositorySummary): ScoreComponent => {
  const definition = REPOSITORY_HEALTH_COMPONENTS.coverage;
  const sonar = summary.sonarMetrics;
  if (sonar === null) return unmeasuredComponent(definition, NO_SONAR);
  return measuredComponent(
    definition,
    sonar.coverage,
    shareOf(sonar.coverage, SONAR_COVERAGE_TARGET),
    `${formatFixed(sonar.coverage)}% covered, against the ${SONAR_COVERAGE_TARGET}% gate`,
  );
};

const defectsOf = (summary: RepositorySummary): ScoreComponent => {
  const definition = REPOSITORY_HEALTH_COMPONENTS.defects;
  const sonar = summary.sonarMetrics;
  if (sonar === null) return unmeasuredComponent(definition, NO_SONAR);
  // A vulnerability counts double: it is the one finding a team cannot leave
  // for the next sprint.
  const weighted = sonar.bugs + 2 * sonar.vulnerabilities;
  return measuredComponent(
    definition,
    weighted,
    decay(weighted, DEFECTS_HALF_POINT),
    `${plural(sonar.bugs, "bug")} and ${vulnerabilities(sonar.vulnerabilities)}; ${DEFECTS_HALF_POINT} bug-equivalents halve this`,
  );
};

const duplicationsOf = (summary: RepositorySummary): ScoreComponent => {
  const definition = REPOSITORY_HEALTH_COMPONENTS.duplications;
  const sonar = summary.sonarMetrics;
  if (sonar === null) return unmeasuredComponent(definition, NO_SONAR);
  return measuredComponent(
    definition,
    sonar.duplications,
    1 - shareOf(sonar.duplications, DUPLICATION_CEILING_PERCENT),
    `${formatFixed(sonar.duplications)}% duplicated; ${DUPLICATION_CEILING_PERCENT}% scores nothing`,
  );
};

const technicalDebtOf = (summary: RepositorySummary): ScoreComponent => {
  const definition = REPOSITORY_HEALTH_COMPONENTS.technicalDebt;
  const sonar = summary.sonarMetrics;
  if (sonar === null) return unmeasuredComponent(definition, NO_SONAR);
  return measuredComponent(
    definition,
    sonar.technicalDebtMinutes,
    decay(sonar.technicalDebtMinutes, DEBT_HALF_POINT_MINUTES),
    `${sonar.technicalDebt} of debt; five working days halve this`,
  );
};

const ciStatusOf = (summary: RepositorySummary): ScoreComponent => {
  const definition = REPOSITORY_HEALTH_COMPONENTS.ciStatus;
  const status = summary.ciStatus;
  if (status === null) return unmeasuredComponent(definition, NO_SNAPSHOT);
  if (status.state === "SUCCESS") {
    return measuredComponent(definition, 1, 1, "the last run on the default branch passed");
  }
  if (status.state === "FAILURE" || status.state === "ERROR") {
    return measuredComponent(definition, 0, 0, "the last run on the default branch failed");
  }
  return unmeasuredComponent(
    definition,
    `the last run on the default branch is ${status.state.toLowerCase()}`,
  );
};

const buildSuccessOf = (summary: RepositorySummary): ScoreComponent => {
  const definition = REPOSITORY_HEALTH_COMPONENTS.buildSuccessRate;
  const decided = summary.activity.buildsSucceeded + summary.activity.buildsFailed;
  if (decided === 0) {
    return unmeasuredComponent(definition, "no build reached a verdict in the window");
  }
  return measuredComponent(
    definition,
    Math.round((summary.activity.buildsSucceeded / decided) * 1000) / 10,
    summary.activity.buildsSucceeded / decided,
    `${formatCount(summary.activity.buildsSucceeded)} of ${plural(decided, "decided build")} succeeded`,
  );
};

const complianceOf = (summary: RepositorySummary): ScoreComponent => {
  const definition = REPOSITORY_HEALTH_COMPONENTS.compliance;
  const compliance = summary.complianceStatus;
  if (compliance === null) return unmeasuredComponent(definition, NO_SNAPSHOT);
  const checks = [
    compliance.pipelineExists,
    compliance.buildPolicyOnPRs,
    compliance.buildPolicyExpiration,
    compliance.branchProtection,
  ];
  const passing = checks.filter(Boolean).length;
  return measuredComponent(
    definition,
    passing,
    shareOf(passing, checks.length),
    `${formatCount(passing)} of ${formatCount(checks.length)} checks pass`,
  );
};

const documentationOf = (summary: RepositorySummary): ScoreComponent => {
  const definition = REPOSITORY_HEALTH_COMPONENTS.documentation;
  const documentation = summary.documentation;
  if (documentation === null) return unmeasuredComponent(definition, NO_SNAPSHOT);
  if (documentation.state === "not-expected") {
    return unmeasuredComponent(definition, "archived, so nobody is asked to document it");
  }
  if (documentation.state === "documented") {
    return measuredComponent(definition, 1, 1, "published to TechDocs");
  }
  if (documentation.state === "unpublished") {
    return measuredComponent(definition, 0.5, 0.5, "written but never published to TechDocs");
  }
  return measuredComponent(definition, 0, 0, "no documentation beyond a README");
};

const reviewCoverageOf = (summary: RepositorySummary): ScoreComponent => {
  const definition = REPOSITORY_HEALTH_COMPONENTS.reviewCoverage;
  const merged = summary.activity.pullRequestsMerged;
  if (merged === 0) {
    return unmeasuredComponent(definition, "no pull request merged in the window");
  }
  return measuredComponent(
    definition,
    summary.activity.reviews,
    shareOf(summary.activity.reviews, merged),
    `${plural(summary.activity.reviews, "review")} against ${plural(merged, "merged pull request")}`,
  );
};

const abandonmentOf = (summary: RepositorySummary): ScoreComponent => {
  const definition = REPOSITORY_HEALTH_COMPONENTS.abandonment;
  const closed = summary.activity.pullRequestsMerged + summary.activity.pullRequestsAbandoned;
  if (closed === 0) {
    return unmeasuredComponent(definition, "no pull request closed in the window");
  }
  return measuredComponent(
    definition,
    summary.activity.pullRequestsMerged,
    shareOf(summary.activity.pullRequestsMerged, closed),
    `${formatCount(summary.activity.pullRequestsMerged)} of ${plural(closed, "closed pull request")} merged rather than abandoned`,
  );
};

export const computeRepositoryHealthScore = (
  summary: RepositorySummary,
): RepositoryHealthScore =>
  combineScore([
    qualityGateOf(summary),
    coverageOf(summary),
    defectsOf(summary),
    duplicationsOf(summary),
    technicalDebtOf(summary),
    ciStatusOf(summary),
    buildSuccessOf(summary),
    complianceOf(summary),
    documentationOf(summary),
    reviewCoverageOf(summary),
    abandonmentOf(summary),
  ]);
