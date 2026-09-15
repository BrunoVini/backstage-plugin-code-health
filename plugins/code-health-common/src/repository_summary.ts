import type { ApiExposure } from "./api_exposure";
import type { BadgeStatus } from "./badge_status";
import type { ComplianceStatus } from "./compliance_status";
import type { ConfluenceSpaceMetrics } from "./confluence_metrics";
import type { JiraRepositoryMetrics } from "./jira_metrics";
import type { DocumentationStatus } from "./documentation_status";
import type { EntityProfile } from "./ownership";
import type { Platform } from "./platform";
import type { Release } from "./release";
import type { SonarMetrics } from "./sonar_metrics";
import type { Tag } from "./tag";
import type { WakaTimeProjectMetrics } from "./wakatime_metrics";
import type { WorkflowStatus } from "./workflow_status";

export type RepositoryVisibility = "PUBLIC" | "PRIVATE";

/**
 * Counts aggregated from the ingested events that fall inside the requested
 * window. Every field is scoped to that window, so the same repository reports
 * different numbers for "last 24 hours" and "last 90 days".
 *
 * Churn semantics differ per platform and this is not smoothed over: GitHub's
 * GraphQL history reports added and deleted *lines*, while Azure DevOps reports
 * added, edited and deleted *files*. `changedFiles` is therefore the only churn
 * figure Azure DevOps can fill in, and `additions`/`deletions` stay at zero
 * there rather than being faked from a different unit.
 */
export interface RepositoryActivity {
  readonly commits: number;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly contributors: number;
  readonly pullRequestsOpened: number;
  readonly pullRequestsMerged: number;
  readonly pullRequestsAbandoned: number;
  readonly builds: number;
  readonly buildsSucceeded: number;
  readonly buildsFailed: number;
  /**
   * Votes cast on the repository's pull requests by somebody other than their
   * author — the same definition a contributor row uses. Kept here so review
   * coverage can be read per repository rather than only fleet-wide.
   */
  readonly reviews: number;
  readonly releases: number;
  readonly tags: number;
}

export const EMPTY_REPOSITORY_ACTIVITY: RepositoryActivity = {
  commits: 0,
  additions: 0,
  deletions: 0,
  changedFiles: 0,
  contributors: 0,
  pullRequestsOpened: 0,
  pullRequestsMerged: 0,
  pullRequestsAbandoned: 0,
  builds: 0,
  buildsSucceeded: 0,
  buildsFailed: 0,
  reviews: 0,
  releases: 0,
  tags: 0,
};

/**
 * One row of the repositories dashboard.
 *
 * The fields above `activity` come from the most recent daily snapshot taken at
 * or before the end of the requested window, so asking for a past window shows
 * the repository as it was then, to the resolution the snapshot task records.
 * `activity` is aggregated from the events inside the window itself.
 */
export interface RepositorySummary {
  /** Stable identifier derived from the catalog entity reference. */
  readonly id: string;
  /** The catalog entity this repository was discovered from. */
  readonly entityRef: string;
  /**
   * The entity's `spec.owner` as a full reference — `group:default/platform`,
   * `user:default/jane` — or null when the entity declares none.
   *
   * Read by discovery from the catalog, like the other catalog facts, because
   * it changes when somebody edits a YAML file rather than on the snapshot's
   * schedule. It is what ties a repository to the people responsible for it,
   * which is a different question from who committed to it.
   */
  readonly ownerRef: string | null;
  /**
   * The owning entity's name and photograph, resolved from the catalog when the
   * row is built.
   *
   * Resolved on read rather than stored beside `owner_ref` by discovery,
   * because a person's name and photograph change in the directory without
   * anything in the repository's YAML moving — a row carrying a copy from
   * whenever discovery last ran would show last year's surname. Null when the
   * entity has no owner, or when the catalog no longer holds the one it names.
   */
  readonly ownerProfile: EntityProfile | null;
  readonly platform: Platform;
  readonly name: string;
  /** `owner/repo` on GitHub, `organization/project/repo` on Azure DevOps. */
  readonly fullName: string;
  readonly url: string;
  readonly description: string | null;
  readonly primaryLanguage: string | null;
  readonly visibility: RepositoryVisibility;
  readonly isArchived: boolean;
  readonly isFork: boolean;
  readonly defaultBranch: string;
  /** When the repository last saw activity, as an ISO 8601 instant. */
  readonly updatedAt: string;
  readonly ciStatus: WorkflowStatus | null;
  readonly latestRelease: Release | null;
  readonly latestTag: Tag | null;
  readonly branches: readonly string[];
  readonly sonarMetrics: SonarMetrics | null;
  readonly complianceStatus: ComplianceStatus | null;
  /**
   * Documentation and catalog-API gaps, or null before the first snapshot.
   *
   * Null is "not measured yet" rather than "nothing found": the catalog half of
   * the evidence is known from discovery, but the repository half — a `docs/`
   * tree, an API definition — is read by the daily snapshot, and grading a
   * repository `missing` on half the evidence would report a gap that is not
   * there.
   */
  readonly documentation: DocumentationStatus | null;
  readonly apiExposure: ApiExposure | null;
  readonly badgeStatus: BadgeStatus | null;
  /**
   * Coding time logged against the matching WakaTime project inside the window.
   *
   * Aggregated on read from the per-person day rows rather than stored on the
   * snapshot: it is a question about a window, and a snapshot only knows about
   * the day it was taken.
   */
  readonly wakaTimeMetrics: WakaTimeProjectMetrics | null;
  readonly jiraMetrics: JiraRepositoryMetrics | null;
  readonly confluenceMetrics: ConfluenceSpaceMetrics | null;
  readonly activity: RepositoryActivity;
}
