import type {
  ApiExposure,
  DocumentationStatus,
  EntityProfile,
  RepositorySummary,
  WakaTimeDayTotal,
  WakaTimeMetrics,
  WakaTimeProjectMetrics,
} from "@rios0rios0/backstage-plugin-code-health-common";
import {
  buildApiExposure,
  buildDocumentationStatus,
  EMPTY_REPOSITORY_ACTIVITY,
} from "@rios0rios0/backstage-plugin-code-health-common";
import type { ContributorMetricRow } from "../repositories/code_health_store";
import { aggregateActivity } from "./activity";
import type { CodeHealthEvent } from "./code_health_event";
import type {
  RepositoryFileFacts,
  RepositorySnapshotPayload,
} from "./repository_snapshot";
import { repositoryFullName, type TrackedRepository } from "./tracked_repository";

/** The day range a row describes, as the wire type spells it. */
export interface SummaryWindow {
  readonly from: string;
  readonly to: string;
}

/**
 * State for a repository that has never been snapshotted.
 *
 * A freshly discovered repository has activity before it has a snapshot,
 * because ingestion runs every few minutes and the snapshot task runs daily. It
 * renders with its counters and empty state rather than being hidden, which
 * would make the dashboard look like discovery had not worked.
 */
export const unsnapshotted = (
  repository: TrackedRepository,
): RepositorySnapshotPayload => ({
  description: null,
  primaryLanguage: null,
  visibility: "PRIVATE",
  isArchived: repository.archived,
  isFork: false,
  defaultBranch: repository.defaultBranch ?? "",
  updatedAt: repository.discoveredAt.toISOString(),
  ciStatus: null,
  latestRelease: null,
  latestTag: null,
  branches: [],
  complianceStatus: null,
  badgeStatus: null,
  sonarMetrics: null,
  jiraMetrics: null,
  confluenceMetrics: null,
  repositoryFiles: null,
});

/**
 * WakaTime spells a project however the editor plugin derived it from a working
 * directory, and a catalog spells a repository however somebody named the
 * entity. Folding case and separators is what lets `code-health` match
 * `Code_Health` without claiming the two are the same string.
 */
const normalizeProject = (value: string): string =>
  value.trim().toLowerCase().replace(/[\s._-]+/gu, "-");

export interface ProjectTotals {
  readonly name: string;
  totalSeconds: number;
  readonly contributors: Set<string>;
  readonly daily: Map<string, number>;
}

/**
 * Sums the coding time logged against each WakaTime project in the window.
 *
 * Built from the same per-person day rows the contributors tab reads, so the
 * two views can never disagree about how many hours a week held. The project
 * breakdown inside each row is what carries the attribution; WakaTime does not
 * report a project total for an organisation anywhere else.
 */
export const aggregateWakaTimeProjects = (
  rows: readonly ContributorMetricRow<WakaTimeMetrics>[],
): Map<string, ProjectTotals> => {
  const byProject = new Map<string, ProjectTotals>();

  for (const row of rows) {
    for (const project of row.payload.projects) {
      const key = normalizeProject(project.name);
      const totals = byProject.get(key) ?? {
        name: project.name,
        totalSeconds: 0,
        contributors: new Set<string>(),
        daily: new Map<string, number>(),
      };

      totals.totalSeconds += project.totalSeconds;
      // Only somebody who actually logged time counts. A member with a WakaTime
      // seat and a quiet week is not a contributor to this repository.
      if (project.totalSeconds > 0) totals.contributors.add(row.contributorKey);
      totals.daily.set(row.day, (totals.daily.get(row.day) ?? 0) + project.totalSeconds);
      byProject.set(key, totals);
    }
  }

  return byProject;
};

const toProjectMetrics = (
  totals: ProjectTotals,
  window: SummaryWindow,
): WakaTimeProjectMetrics => {
  const daily: WakaTimeDayTotal[] = [...totals.daily.entries()]
    .map(([day, totalSeconds]) => ({ day, totalSeconds }))
    .sort((left, right) => left.day.localeCompare(right.day));

  return {
    projectName: totals.name,
    window,
    totalSeconds: totals.totalSeconds,
    contributors: totals.contributors.size,
    daily,
  };
};

/**
 * Grades documentation from the catalog entry and the repository together.
 *
 * Returns null until both halves are in: the catalog half is known from
 * discovery, but the repository half arrives with the daily snapshot, and a
 * repository graded `missing` on half the evidence would report a gap that is
 * not there. Null reads as "not measured yet" everywhere downstream, the same
 * way an unsnapshotted quality gate does.
 */
const documentationOf = (
  repository: TrackedRepository,
  files: RepositoryFileFacts | null,
  isArchived: boolean,
): DocumentationStatus | null => {
  if (files === null) return null;

  return buildDocumentationStatus({
    hasTechDocs: repository.catalogFacts.techDocsRef !== null,
    hasDocsSource: files.hasDocsSource,
    hasReadme: files.hasReadme,
    hasExternalDocs: repository.catalogFacts.hasExternalDocs,
    isArchived,
  });
};

const apiExposureOf = (
  repository: TrackedRepository,
  files: RepositoryFileFacts | null,
  isArchived: boolean,
): ApiExposure | null => {
  if (files === null) return null;

  return buildApiExposure({
    declaredApis: repository.catalogFacts.providesApis,
    definitionPath: files.apiDefinitionPath,
    entityType: repository.catalogFacts.entityType,
    isArchived,
  });
};

/**
 * The WakaTime project this repository is tracked as.
 *
 * The annotation wins where a catalog entity carries one; otherwise the
 * repository's own name is matched, which is what WakaTime's editor plugins
 * derive a project name from in the overwhelming majority of setups. A
 * repository nothing matched reports null rather than zero — "nobody here has
 * WakaTime installed" and "the project is called something else" are different
 * problems, and a zero would hide both behind the same cell.
 */
const wakaTimeOf = (
  repository: TrackedRepository,
  byProject: ReadonlyMap<string, ProjectTotals>,
  window: SummaryWindow,
): WakaTimeProjectMetrics | null => {
  const name = repository.catalogFacts.wakaTimeProject ?? repository.name;
  const totals = byProject.get(normalizeProject(name));
  return totals === undefined ? null : toProjectMetrics(totals, window);
};

/**
 * One dashboard row for one repository.
 *
 * The counters come from the events handed in; everything else comes from the
 * snapshot payload, which the caller has already resolved to the most recent
 * one at or before the end of the period being described. That split is what
 * lets the same function build the repositories table's row for a window and
 * the trend chart's row for one bucket of it — both are "these events against
 * the state the repository was in at the time", and building them twice is how
 * a chart ends up disagreeing with the table it sits beside.
 */
export const buildRepositorySummary = (
  repository: TrackedRepository,
  payload: RepositorySnapshotPayload,
  events: readonly CodeHealthEvent[] | undefined,
  wakaTimeByProject: ReadonlyMap<string, ProjectTotals>,
  window: SummaryWindow,
  /**
   * The owning entities' names and photographs, keyed by reference. Omitted
   * where no catalog is wired in, which leaves every row's `ownerProfile` null
   * — the same "not resolved" the frontend already renders as the bare slug.
   */
  ownerProfiles?: ReadonlyMap<string, EntityProfile>,
): RepositorySummary => {
  // Undefined on a snapshot written before the scan existed, which is the same
  // "not measured" case as never having been snapshotted at all.
  const files = payload.repositoryFiles ?? null;

  return {
    id: repository.id,
    entityRef: repository.entityRef,
    ownerRef: repository.catalogFacts.ownerRef,
    ownerProfile:
      repository.catalogFacts.ownerRef === null
        ? null
        : (ownerProfiles?.get(repository.catalogFacts.ownerRef) ?? null),
    platform: repository.platform,
    name: repository.name,
    fullName: repositoryFullName(repository),
    url: repository.repoUrl,
    description: payload.description,
    primaryLanguage: payload.primaryLanguage,
    visibility: payload.visibility,
    isArchived: payload.isArchived,
    isFork: payload.isFork,
    defaultBranch: payload.defaultBranch,
    updatedAt: payload.updatedAt,
    ciStatus: payload.ciStatus,
    latestRelease: payload.latestRelease,
    latestTag: payload.latestTag,
    branches: payload.branches,
    sonarMetrics: payload.sonarMetrics,
    complianceStatus: payload.complianceStatus,
    documentation: documentationOf(repository, files, payload.isArchived),
    apiExposure: apiExposureOf(repository, files, payload.isArchived),
    badgeStatus: payload.badgeStatus,
    wakaTimeMetrics: wakaTimeOf(repository, wakaTimeByProject, window),
    // Both come from the snapshot rather than from the window's events: neither
    // product exposes what a project looked like on an arbitrary past day, so
    // the figure is the most recent one taken at or before it.
    //
    // `?? null` for the same reason `repositoryFiles` needs it above: a payload
    // written before these fields existed carries no key, and the store parses
    // stored JSON with a cast rather than a validation. Left undefined it
    // survives every `=== null` guard downstream and reaches code that
    // dereferences it — and picking any range that predates the upgrade
    // reproduces that permanently, not just once after it.
    jiraMetrics: payload.jiraMetrics ?? null,
    confluenceMetrics: payload.confluenceMetrics ?? null,
    activity: events ? aggregateActivity(events) : EMPTY_REPOSITORY_ACTIVITY,
  };
};
