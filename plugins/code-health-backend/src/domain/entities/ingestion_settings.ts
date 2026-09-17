import type { SchedulerServiceTaskScheduleDefinition } from "@backstage/backend-plugin-api";
import type { IntegrationCapabilities } from "@rios0rios0/backstage-plugin-code-health-common";
import type { ConfluenceSettings } from "./confluence_settings";
import type { JiraSettings } from "./jira_settings";

/** Catalog filters, in the shape `catalog.getEntities` expects. */
export type EntityFilter = Record<string, string | string[]>;

export interface IngestionSettings {
  readonly entityFilters: readonly EntityFilter[];
  readonly retentionDays: number;
  /** Days fetched per backfill step. 1 walks the history a day at a time. */
  readonly backfillChunkDays: number;
  /**
   * Provider requests one run of the ingestion actor may issue, and one
   * snapshot pass may spend on the repository loop — the provider snapshots
   * and the Sonar readings taken beside them.
   *
   * Nothing else draws on it. Each optional integration spends its own
   * allowance during the snapshot pass, because the enrichers used to draw
   * from this one first and one large Confluence space could leave the loop
   * with nothing.
   */
  readonly requestBudgetPerRun: number;
  readonly concurrencyPerHost: number;
  readonly schedule: SchedulerServiceTaskScheduleDefinition;
  readonly discoverySchedule: SchedulerServiceTaskScheduleDefinition;
  readonly snapshotSchedule: SchedulerServiceTaskScheduleDefinition;
}

export interface SonarSettings {
  readonly enabled: boolean;
}

export interface WakaTimeSettings {
  /**
   * The organisation whose dashboard members are summarised.
   *
   * Absent, the key's own account is measured instead. That is the useful
   * behaviour for a small team on personal plans, where there is no
   * organisation to name and the alternative is an integration that silently
   * collects nothing.
   */
  readonly organization: string | null;
  /**
   * Which dashboard inside the organisation. Absent, the first one the API
   * returns is used — WakaTime creates exactly one for most organisations, and
   * failing rather than picking it would be pedantry.
   */
  readonly dashboard: string | null;
  readonly apiKey: string | null;
  readonly baseUrl: string;
  /** How far back the per-day coding history is collected. */
  readonly historyDays: number;
  /**
   * Whether to collect AI authorship and token counts.
   *
   * Off by default because it is the expensive half: coding time for a whole
   * window costs one request per member, while the AI figures come from the
   * durations resource, which is queried one day at a time.
   */
  readonly includeAiMetrics: boolean;
  /**
   * Days of AI figures collected per member per run, newest first.
   *
   * The backfill therefore catches up over several runs rather than spending a
   * whole request budget on its first one — the same trade the repository
   * ingestion already makes with its cursor.
   */
  readonly aiDaysPerRun: number;
  /**
   * Requests one snapshot pass may spend on WakaTime, on an allowance of its
   * own so a large organisation never costs the pass a repository snapshot.
   *
   * A pass costs two requests to find the members, then one per member for the
   * whole coding-time window and one more per member per day of AI figures.
   */
  readonly requestBudgetPerRun: number;
}

/**
 * One Atlassian Cloud site, shared by Jira and Confluence.
 *
 * Deliberately a single credential rather than one per product: they are the
 * same account and the same API token, and asking an operator to paste it twice
 * only creates a way for the two to drift apart.
 */
export interface AtlassianSettings {
  /** e.g. `https://acme.atlassian.net`, with no trailing slash. */
  readonly baseUrl: string | null;
  /** The Atlassian account the API token belongs to. */
  readonly email: string | null;
  readonly apiToken: string | null;
  /** Ceiling on results pulled per run, per resource. */
  readonly maxResultsPerRun: number;
  /** How far back per-day history is collected. */
  readonly historyDays: number;
  readonly jira: { readonly enabled: boolean; readonly storyPointsField: string | null };
  readonly confluence: { readonly enabled: boolean; readonly spaceKeys: readonly string[] };
}

export interface CodeHealthSettings {
  /**
   * Catalog entity references — users or groups — allowed to start the history
   * collection over. Empty means nobody, which is the default.
   *
   * Normalised on the way in, so `jane`, `user:jane` and `user:default/jane`
   * are one entry rather than three that fail to match the reference an
   * identity actually carries.
   */
  readonly administrators: readonly string[];
  readonly ingestion: IngestionSettings;
  readonly sonar: SonarSettings;
  readonly wakaTime: WakaTimeSettings;
  readonly atlassian: AtlassianSettings;
  /**
   * The cost caps each Atlassian product needs beyond the shared credential.
   *
   * They live beside `atlassian` rather than inside it because they are about
   * how much work a run does, not about how it authenticates — and because both
   * products would otherwise have to agree on one ceiling for two very
   * differently shaped sweeps.
   */
  readonly jira: JiraSettings;
  readonly confluence: ConfluenceSettings;
}

export const DEFAULT_ENTITY_FILTERS: readonly EntityFilter[] = [{ kind: "Component" }];

export const DEFAULT_RETENTION_DAYS = 365;
export const DEFAULT_BACKFILL_CHUNK = "P1D";
export const DEFAULT_REQUEST_BUDGET_PER_RUN = 500;
export const DEFAULT_CONCURRENCY_PER_HOST = 4;
export const DEFAULT_WAKATIME_BASE_URL = "https://wakatime.com/api/v1";
export const DEFAULT_WAKATIME_HISTORY_DAYS = 30;
export const DEFAULT_WAKATIME_AI_DAYS_PER_RUN = 3;
/** Room for about 120 members with the AI figures on, or 500 without. */
export const DEFAULT_WAKATIME_REQUEST_BUDGET_PER_RUN = 500;
export const DEFAULT_ATLASSIAN_MAX_RESULTS_PER_RUN = 2000;
export const DEFAULT_ATLASSIAN_HISTORY_DAYS = 90;

/** Whether the WakaTime integration has enough configuration to run at all. */
export const isWakaTimeConfigured = (settings: WakaTimeSettings): boolean =>
  settings.apiKey !== null && settings.apiKey !== "";

export const isAtlassianConfigured = (settings: AtlassianSettings): boolean =>
  settings.baseUrl !== null &&
  settings.email !== null &&
  settings.apiToken !== null &&
  settings.apiToken !== "";

/**
 * Which integrations the frontend should draw columns and cards for.
 *
 * Derived from configuration alone, never from whether any row happens to carry
 * a value: an integration configured this morning has no data until the
 * snapshot task next runs, and a dashboard that hides its columns until then
 * looks broken rather than new. The two Atlassian products light up together
 * because they share one credential — configuring the site is the whole of the
 * work, and switching one off afterwards is the exception.
 */
export const integrationCapabilitiesOf = (
  settings: CodeHealthSettings,
): IntegrationCapabilities => {
  const atlassian = isAtlassianConfigured(settings.atlassian);

  return {
    wakatime: isWakaTimeConfigured(settings.wakaTime),
    jira: atlassian && settings.atlassian.jira.enabled,
    confluence: atlassian && settings.atlassian.confluence.enabled,
  };
};

export const DEFAULT_INGESTION_SCHEDULE: SchedulerServiceTaskScheduleDefinition = {
  frequency: { minutes: 5 },
  timeout: { minutes: 15 },
  initialDelay: { seconds: 30 },
  scope: "global",
};

export const DEFAULT_DISCOVERY_SCHEDULE: SchedulerServiceTaskScheduleDefinition = {
  frequency: { minutes: 30 },
  timeout: { minutes: 10 },
  initialDelay: { seconds: 10 },
  scope: "global",
};

export const DEFAULT_SNAPSHOT_SCHEDULE: SchedulerServiceTaskScheduleDefinition = {
  frequency: { cron: "0 3 * * *" },
  timeout: { hours: 1 },
  initialDelay: { minutes: 2 },
  scope: "global",
};
