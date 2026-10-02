import { formatCount } from "./number_format";

export type QualityGateStatus = "OK" | "ERROR" | "NONE";

/**
 * The coverage a repository has to reach before it stops being a finding.
 *
 * Eighty percent is SonarQube's own default "coverage on new code" gate, so
 * it is the number a team already sees on its quality gate rather than a
 * second target invented here. Both scores and the Insights tab read it.
 */
export const SONAR_COVERAGE_TARGET = 80;

export interface SonarMetrics {
  readonly bugs: number;
  readonly codeSmells: number;
  readonly securityHotspots: number;
  readonly vulnerabilities: number;
  /**
   * Line coverage, or null where the project reports none.
   *
   * Nullable because "no coverage measure" and "nothing is covered" are
   * different facts and only one of them is a finding. A project SonarQube
   * cannot measure coverage for — Terraform, configuration, anything with no
   * executable lines — publishes no `coverage` measure at all, and reading
   * that absence as `0` puts a repository at the bottom of a scale it was
   * never on. The same rule the quality gate already follows: unknown is not
   * failing.
   */
  readonly coverage: number | null;
  readonly duplications: number;
  /** Formatted for display, e.g. `2d 3h`. */
  readonly technicalDebt: string;
  /**
   * The same value in minutes, as SonarQube's `sqale_index` reports it.
   *
   * Kept alongside the formatted string because the formatting is lossy — it
   * drops the residual minutes once there are whole days — so anything that has
   * to add two debts together cannot work backwards from `technicalDebt`.
   */
  readonly technicalDebtMinutes: number;
  readonly qualityGateStatus: QualityGateStatus;
}

/**
 * Sonar reports technical debt as a minute count; the dashboard shows a
 * duration. Lives here rather than beside the collector because the contributor
 * aggregation formats a summed debt with the same rules, and two copies would
 * drift.
 *
 * The day count is grouped. A contributor row sums the debt of every repository
 * the person touched, and a fleet of any size runs to four figures of working
 * days there — `2451d` is a number a reader has to count.
 */
export const formatDebt = (minutes: number): string => {
  if (minutes <= 0) return "0min";
  const days = Math.floor(minutes / (60 * 8));
  const hours = Math.floor((minutes % (60 * 8)) / 60);
  const remainder = minutes % 60;
  if (days > 0)
    return hours > 0 ? `${formatCount(days)}d ${hours}h` : `${formatCount(days)}d`;
  if (hours > 0)
    return remainder > 0 ? `${hours}h ${remainder}min` : `${hours}h`;
  return `${remainder}min`;
};
