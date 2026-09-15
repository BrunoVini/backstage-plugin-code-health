/**
 * Types and pure helpers shared by the Code Health frontend and backend plugins.
 *
 * This package is the HTTP wire contract between them. It carries no runtime
 * dependencies and no side effects, so either side can import it freely.
 *
 * @packageDocumentation
 */

export { CODE_HEALTH_API_VERSION, CODE_HEALTH_PLUGIN_ID } from "./api";
export type {
  ExcludeIdentityRequest,
  GetAccessResponse,
  GetCapabilitiesResponse,
  GetContributorTrendResponse,
  GetCoverageResponse,
  GetRepositoryTrendResponse,
  GetTimeSeriesResponse,
  LinkIdentityRequest,
  ListContributorsResponse,
  ListIdentitiesResponse,
  ListOwnedRepositoriesResponse,
  ListRepositoriesResponse,
  RefreshResponse,
  ResetIngestionRequest,
  ResetIngestionResponse,
  TimeWindow,
} from "./api";

export {
  enabledIntegrations,
  INTEGRATION_IDS,
  isIntegrationId,
  NO_INTEGRATIONS,
  parseIntegrationCapabilities,
} from "./integrations";
export type { IntegrationCapabilities, IntegrationId } from "./integrations";

export {
  emailLocalPart,
  IDENTITY_SOURCE_LABELS,
  IDENTITY_SOURCES,
  identityMatchScore,
  isIdentitySource,
  MAX_SUGGESTIONS,
  normalizeIdentityText,
  suggestIdentityMatches,
  SUGGESTION_FLOOR,
} from "./identity";
export type {
  ContributorIdentity,
  DirectoryUser,
  IdentityExclusion,
  IdentityLink,
  IdentityLinkOrigin,
  IdentityRow,
  IdentitySource,
  IdentitySuggestion,
  ObservedIdentity,
} from "./identity";

export {
  EXCLUSION_REASON_DESCRIPTIONS,
  EXCLUSION_REASON_LABELS,
  EXCLUSION_REASONS,
  isExclusionReason,
} from "./identity_exclusion";
export type { ExclusionReason } from "./identity_exclusion";

export {
  API_SERVING_TYPES,
  buildApiExposure,
  computeApiExposureState,
} from "./api_exposure";
export type { ApiExposure, ApiExposureEvidence, ApiExposureState } from "./api_exposure";

export { computeBadgeColor, parseBadgesFromReadme } from "./badge_status";
export type { BadgeCheck, BadgeColor, BadgeStatus } from "./badge_status";

export { computeComplianceColor } from "./compliance_status";
export type { ComplianceColor, ComplianceStatus } from "./compliance_status";

export {
  buildDocumentationStatus,
  computeDocumentationState,
} from "./documentation_status";
export type {
  DocumentationEvidence,
  DocumentationState,
  DocumentationStatus,
} from "./documentation_status";

export {
  confluenceContributions,
  confluenceSpaceIsActive,
  confluenceSpacesContributedTo,
  confluenceStaleShare,
  confluenceViewsPerPage,
  hasConfluenceActivity,
  mergeConfluenceContributorMetrics,
} from "./confluence_metrics";
export type {
  ConfluenceAnalyticsState,
  ConfluenceContributorMetrics,
  ConfluencePageReference,
  ConfluenceSpaceMetrics,
  ConfluenceSpaceReference,
  ConfluenceVolumeUnit,
  ConfluenceWindow,
} from "./confluence_metrics";

export {
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
} from "./jira_metrics";
export type {
  JiraContributorMetrics,
  JiraDurationStats,
  JiraDurationTotals,
  JiraInteractions,
  JiraIssueTypeBucket,
  JiraIssueTypeCounts,
  JiraOpenIssue,
  JiraPriorityCount,
  JiraRepositoryMetrics,
  JiraWindow,
} from "./jira_metrics";

export { computeRate } from "./contributor_summary";
export type { ChurnUnit, ContributorSummary } from "./contributor_summary";

export { EMPTY_BACKFILL_PROGRESS } from "./coverage";
export type { BackfillProgress, CoverageInfo } from "./coverage";

export { EVENT_KINDS, isEventKind } from "./event_kind";
export type { EventKind } from "./event_kind";

export { isPlatform, PLATFORMS } from "./platform";
export type { Platform } from "./platform";

export type { Release } from "./release";

export { EMPTY_REPOSITORY_ACTIVITY } from "./repository_summary";
export type {
  RepositoryActivity,
  RepositorySummary,
  RepositoryVisibility,
} from "./repository_summary";

export type { QualityGateStatus, SonarMetrics } from "./sonar_metrics";
export { formatDebt, SONAR_COVERAGE_TARGET } from "./sonar_metrics";

export {
  combineScore,
  FAIR_SCORE,
  formatScoreValue,
  GOOD_SCORE,
  measuredComponent,
  scoreBand,
  shareOf,
  unmeasuredComponent,
} from "./score";
export type { Score, ScoreBand, ScoreComponent, ScoreComponentDefinition } from "./score";

export {
  computeProductivityScore,
  EMPTY_FLEET_REFERENCE,
  fleetReferenceOf,
  PRODUCTIVITY_COMPONENTS,
  productivityComponentsFor,
} from "./productivity_score";
export type {
  FleetReference,
  ProductivityComponentDefinition,
  ProductivityComponentId,
  ProductivityScore,
} from "./productivity_score";

export {
  computeRepositoryHealthScore,
  DEBT_HALF_POINT_MINUTES,
  DEFECTS_HALF_POINT,
  DUPLICATION_CEILING_PERCENT,
  REPOSITORY_HEALTH_COMPONENTS,
} from "./repository_health_score";
export type { RepositoryHealthScore } from "./repository_health_score";

export {
  DEFAULT_TREND_MONTHS,
  TREND_DAILY_LIMIT_DAYS,
  TREND_MONTHS,
  trendBucketFor,
} from "./trend";
export type { ContributorTrendPoint, RepositoryTrendPoint } from "./trend";

export { DEFAULT_OWNER_KIND, ownerEntityRef } from "./ownership";
export type { OwnershipInfo } from "./ownership";

export type { Tag } from "./tag";

export { isTimeSeriesBucket, TIME_SERIES_BUCKETS } from "./time_series";
export type { TimeSeriesBucket, TimeSeriesPoint } from "./time_series";

export {
  aiAuthorshipShare,
  breakdownTotal,
  formatDuration,
  formatTokens,
  mergeBreakdowns,
  mergeDailyTotals,
  mergeWakaTimeMetrics,
  topBreakdownName,
  totalModelCost,
} from "./wakatime_metrics";
export type {
  WakaTimeAiMetrics,
  WakaTimeBreakdownItem,
  WakaTimeDayTotal,
  WakaTimeMetrics,
  WakaTimeProjectMetrics,
  WakaTimeSeriesPoint,
} from "./wakatime_metrics";

export { CI_STATES, isCIState } from "./workflow_status";
export type { CIState, WorkflowStatus } from "./workflow_status";
export { catalogEntityPath, parseEntityRef } from "./entity_ref";
export type { ParsedEntityRef } from "./entity_ref";
