import type { ContributorSummary } from "@rios0rios0/backstage-plugin-code-health-common";

export type ContributorSortField =
  | "displayName"
  | "linesOfCode"
  | "reviewsApproved"
  | "prApprovalRate"
  | "pipelineSuccessRate"
  | "bugs"
  | "codeSmells"
  | "securityHotspots"
  | "vulnerabilities"
  | "coverage"
  | "duplications"
  | "technicalDebt";

export type SortDirection = "asc" | "desc";

export interface ContributorFilter {
  readonly searchQuery: string;
  readonly sortField: ContributorSortField;
  readonly sortDirection: SortDirection;
  readonly dateFrom: string | null;
  readonly dateTo: string | null;
}

export const DEFAULT_CONTRIBUTOR_FILTER: ContributorFilter = {
  searchQuery: "",
  sortField: "linesOfCode",
  sortDirection: "desc",
  dateFrom: null,
  dateTo: null,
};

export const filterContributors = (
  contributors: readonly ContributorSummary[],
  filter: ContributorFilter,
): ContributorSummary[] => {
  return contributors.filter((contributor) => {
    if (
      filter.searchQuery &&
      !contributor.displayName.toLowerCase().includes(filter.searchQuery.toLowerCase())
    ) {
      return false;
    }
    return true;
  });
};

const parseTechnicalDebt = (debt: string): number => {
  let minutes = 0;
  const dayMatch = debt.match(/(\d+)d/);
  const hourMatch = debt.match(/(\d+)h/);
  const minMatch = debt.match(/(\d+)min/);
  if (dayMatch) minutes += parseInt(dayMatch[1], 10) * 8 * 60;
  if (hourMatch) minutes += parseInt(hourMatch[1], 10) * 60;
  if (minMatch) minutes += parseInt(minMatch[1], 10);
  return minutes;
};

const getSonarNumericValue = (contributor: ContributorSummary, field: ContributorSortField): number => {
  if (!contributor.sonarMetrics) return 0;
  switch (field) {
    case "bugs":
      return contributor.sonarMetrics.bugs;
    case "codeSmells":
      return contributor.sonarMetrics.codeSmells;
    case "securityHotspots":
      return contributor.sonarMetrics.securityHotspots;
    case "vulnerabilities":
      return contributor.sonarMetrics.vulnerabilities;
    case "coverage":
      // A sort key, and only a sort key: this function has one caller, the
      // comparator below, and the coverage column carries no numeric filter,
      // so nothing here decides whether a row is measured. The guard above
      // already orders every unmeasured Sonar figure at zero for all seven
      // fields, and a row with no coverage measure orders where a row with no
      // Sonar project already does. Giving the unmeasured their own place is
      // worth doing, but it is one change to all seven fields and to the
      // comparator's direction handling, not to this branch.
      return contributor.sonarMetrics.coverage ?? 0;
    case "duplications":
      return contributor.sonarMetrics.duplications;
    case "technicalDebt":
      return parseTechnicalDebt(contributor.sonarMetrics.technicalDebt);
    default:
      return 0;
  }
};

export const sortContributors = (
  contributors: readonly ContributorSummary[],
  field: ContributorSortField,
  direction: SortDirection,
): ContributorSummary[] => {
  const sorted = [...contributors].sort((a, b) => {
    switch (field) {
      case "displayName":
        return a.displayName.localeCompare(b.displayName);
      case "linesOfCode":
        return a.linesOfCode - b.linesOfCode;
      case "reviewsApproved":
        return a.reviewsApproved - b.reviewsApproved;
      case "prApprovalRate":
        return a.prApprovalRate - b.prApprovalRate;
      case "pipelineSuccessRate":
        return a.pipelineSuccessRate - b.pipelineSuccessRate;
      case "bugs":
      case "codeSmells":
      case "securityHotspots":
      case "vulnerabilities":
      case "coverage":
      case "duplications":
      case "technicalDebt":
        return getSonarNumericValue(a, field) - getSonarNumericValue(b, field);
      default:
        return 0;
    }
  });
  return direction === "desc" ? sorted.reverse() : sorted;
};
