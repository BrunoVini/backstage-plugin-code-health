import {
  readSchedulerServiceTaskScheduleDefinitionFromConfig,
  type LoggerService,
  type SchedulerServiceTaskScheduleDefinition,
} from "@backstage/backend-plugin-api";
import { parseEntityRef, stringifyEntityRef } from "@backstage/catalog-model";
import type { Config } from "@backstage/config";
import type { ConfluenceSettings } from "../../domain/entities/confluence_settings";
import {
  DEFAULT_CONFLUENCE_MAX_ANALYTICS_LOOKUPS,
  DEFAULT_CONFLUENCE_MAX_PAGES_FOR_VOLUME,
  DEFAULT_CONFLUENCE_MAX_PAGES_PER_RUN,
  DEFAULT_CONFLUENCE_REQUEST_BUDGET_PER_RUN,
  DEFAULT_CONFLUENCE_REQUEST_BUDGET_PER_SPACE,
  DEFAULT_CONFLUENCE_STALE_AFTER_DAYS,
} from "../../domain/entities/confluence_settings";
import { parseChunkDays } from "../../domain/entities/day";
import {
  DEFAULT_JIRA_MAX_ISSUES_PER_PROJECT,
  DEFAULT_JIRA_REQUEST_BUDGET_PER_RUN,
  jiraSettingsFrom,
} from "../../domain/entities/jira_settings";
import {
  DEFAULT_ATLASSIAN_HISTORY_DAYS,
  DEFAULT_ATLASSIAN_MAX_RESULTS_PER_RUN,
  DEFAULT_BACKFILL_CHUNK,
  DEFAULT_CONCURRENCY_PER_HOST,
  DEFAULT_DISCOVERY_SCHEDULE,
  DEFAULT_ENTITY_FILTERS,
  DEFAULT_INGESTION_SCHEDULE,
  DEFAULT_REQUEST_BUDGET_PER_RUN,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_SNAPSHOT_SCHEDULE,
  DEFAULT_WAKATIME_AI_DAYS_PER_RUN,
  DEFAULT_WAKATIME_BASE_URL,
  DEFAULT_WAKATIME_HISTORY_DAYS,
  DEFAULT_WAKATIME_REQUEST_BUDGET_PER_RUN,
  type CodeHealthSettings,
  type EntityFilter,
} from "../../domain/entities/ingestion_settings";

const readSchedule = (
  config: Config | undefined,
  key: string,
  fallback: SchedulerServiceTaskScheduleDefinition,
): SchedulerServiceTaskScheduleDefinition => {
  const scheduleConfig = config?.getOptionalConfig(key);
  if (!scheduleConfig) return fallback;
  return readSchedulerServiceTaskScheduleDefinitionFromConfig(scheduleConfig);
};

const readPositiveNumber = (
  config: Config | undefined,
  key: string,
  fallback: number,
): number => {
  const value = config?.getOptionalNumber(key);
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
};

/** Trailing slashes are stripped so a path can always be appended verbatim. */
const readBaseUrl = (config: Config | undefined, key: string): string | null => {
  const value = config?.getOptionalString(key)?.trim();
  return value === undefined || value === "" ? null : value.replace(/\/+$/u, "");
};

const readStringList = (config: Config | undefined, key: string): readonly string[] => {
  const value = config?.getOptionalStringArray(key);
  return value === undefined ? [] : value.filter((entry) => entry.trim() !== "");
};

/**
 * The cost caps the Confluence sweep obeys.
 *
 * Read as their own block because they bound work rather than describing a
 * credential: a site with fifty thousand pages and a site with fifty want very
 * different ceilings, and neither wants the Jira ones.
 */
const readConfluenceSettings = (config: Config | undefined): ConfluenceSettings => ({
  staleAfterDays: readPositiveNumber(
    config,
    "staleAfterDays",
    DEFAULT_CONFLUENCE_STALE_AFTER_DAYS,
  ),
  maxPagesPerRun: readPositiveNumber(
    config,
    "maxPagesPerRun",
    DEFAULT_CONFLUENCE_MAX_PAGES_PER_RUN,
  ),
  maxPagesForVolume: readPositiveNumber(
    config,
    "maxPagesForVolume",
    DEFAULT_CONFLUENCE_MAX_PAGES_FOR_VOLUME,
  ),
  maxAnalyticsLookups: readPositiveNumber(
    config,
    "maxAnalyticsLookups",
    DEFAULT_CONFLUENCE_MAX_ANALYTICS_LOOKUPS,
  ),
  requestBudgetPerRun: readPositiveNumber(
    config,
    "requestBudgetPerRun",
    DEFAULT_CONFLUENCE_REQUEST_BUDGET_PER_RUN,
  ),
  requestBudgetPerSpace: readPositiveNumber(
    config,
    "requestBudgetPerSpace",
    DEFAULT_CONFLUENCE_REQUEST_BUDGET_PER_SPACE,
  ),
});

/**
 * The administrators, as full entity references.
 *
 * `spec.owner`-style shorthand is accepted for the same reason the catalog
 * accepts it — an operator writes `jane`, not `user:default/jane` — and
 * defaults to a user rather than a group, because the list names people far
 * more often than teams. A malformed entry is skipped with a warning rather
 * than aborting the plugin's startup: one typo in a list of five must not take
 * the dashboard down for everybody, and the warning is what makes the entry
 * that stopped working findable.
 */
const readAdministrators = (
  config: Config | undefined,
  logger: LoggerService | undefined,
): readonly string[] => {
  const configured = readStringList(config, "administrators");

  return configured.flatMap((entry) => {
    try {
      return [
        stringifyEntityRef(
          parseEntityRef(entry.trim(), {
            defaultKind: "user",
            defaultNamespace: "default",
          }),
        ),
      ];
    } catch {
      logger?.warn(
        `ignoring \`codeHealth.administrators\` entry ${entry}: it is not an entity reference`,
      );
      return [];
    }
  });
};

const readEntityFilters = (config: Config | undefined): readonly EntityFilter[] => {
  const filters = config?.getOptional("catalog.entityFilter");
  if (!Array.isArray(filters) || filters.length === 0) return DEFAULT_ENTITY_FILTERS;

  const parsed = filters.filter(
    (filter): filter is EntityFilter =>
      typeof filter === "object" && filter !== null && !Array.isArray(filter),
  );
  return parsed.length > 0 ? parsed : DEFAULT_ENTITY_FILTERS;
};

/**
 * Reads the `codeHealth` block, filling in defaults for everything absent.
 *
 * Provider credentials are intentionally not read here. They come from the host
 * application's `integrations` configuration, so an operator who has already
 * configured Backstage for GitHub or Azure DevOps configures nothing further.
 *
 * The logger is optional so this stays callable from a test that only cares
 * about the numbers; the only thing it reports is a malformed administrator.
 */
export const readCodeHealthSettings = (
  rootConfig: Config,
  logger?: LoggerService,
): CodeHealthSettings => {
  const config = rootConfig.getOptionalConfig("codeHealth");
  const ingestion = config?.getOptionalConfig("ingestion");
  const atlassian = config?.getOptionalConfig("atlassian");

  return {
    administrators: readAdministrators(config, logger),
    ingestion: {
      entityFilters: readEntityFilters(config),
      retentionDays: readPositiveNumber(ingestion, "retentionDays", DEFAULT_RETENTION_DAYS),
      backfillChunkDays: parseChunkDays(
        ingestion?.getOptionalString("backfillChunk") ?? DEFAULT_BACKFILL_CHUNK,
        1,
      ),
      requestBudgetPerRun: readPositiveNumber(
        ingestion,
        "requestBudgetPerRun",
        DEFAULT_REQUEST_BUDGET_PER_RUN,
      ),
      concurrencyPerHost: readPositiveNumber(
        ingestion,
        "concurrencyPerHost",
        DEFAULT_CONCURRENCY_PER_HOST,
      ),
      schedule: readSchedule(ingestion, "schedule", DEFAULT_INGESTION_SCHEDULE),
      discoverySchedule: readSchedule(
        ingestion,
        "discoverySchedule",
        DEFAULT_DISCOVERY_SCHEDULE,
      ),
      snapshotSchedule: readSchedule(ingestion, "snapshotSchedule", DEFAULT_SNAPSHOT_SCHEDULE),
    },
    sonar: {
      enabled: config?.getOptionalBoolean("sonar.enabled") ?? false,
    },
    wakaTime: {
      organization: config?.getOptionalString("wakaTime.organization") ?? null,
      dashboard: config?.getOptionalString("wakaTime.dashboard") ?? null,
      apiKey: config?.getOptionalString("wakaTime.apiKey") ?? null,
      baseUrl: readBaseUrl(config, "wakaTime.baseUrl") ?? DEFAULT_WAKATIME_BASE_URL,
      historyDays: readPositiveNumber(
        config?.getOptionalConfig("wakaTime"),
        "historyDays",
        DEFAULT_WAKATIME_HISTORY_DAYS,
      ),
      includeAiMetrics: config?.getOptionalBoolean("wakaTime.includeAiMetrics") ?? false,
      aiDaysPerRun: readPositiveNumber(
        config?.getOptionalConfig("wakaTime"),
        "aiDaysPerRun",
        DEFAULT_WAKATIME_AI_DAYS_PER_RUN,
      ),
      requestBudgetPerRun: readPositiveNumber(
        config?.getOptionalConfig("wakaTime"),
        "requestBudgetPerRun",
        DEFAULT_WAKATIME_REQUEST_BUDGET_PER_RUN,
      ),
    },
    atlassian: {
      baseUrl: readBaseUrl(config, "atlassian.baseUrl"),
      email: config?.getOptionalString("atlassian.email") ?? null,
      apiToken: config?.getOptionalString("atlassian.apiToken") ?? null,
      maxResultsPerRun: readPositiveNumber(
        atlassian,
        "maxResultsPerRun",
        DEFAULT_ATLASSIAN_MAX_RESULTS_PER_RUN,
      ),
      historyDays: readPositiveNumber(
        atlassian,
        "historyDays",
        DEFAULT_ATLASSIAN_HISTORY_DAYS,
      ),
      jira: {
        // Defaulted on rather than off: configuring the site is the whole of the
        // work, and an operator who pastes an Atlassian token wants both
        // products. Switching one off is the exception, so it is the flag.
        enabled: config?.getOptionalBoolean("atlassian.jira.enabled") ?? true,
        storyPointsField: config?.getOptionalString("atlassian.jira.storyPointsField") ?? null,
      },
      confluence: {
        enabled: config?.getOptionalBoolean("atlassian.confluence.enabled") ?? true,
        spaceKeys: readStringList(config, "atlassian.confluence.spaceKeys"),
      },
    },
    jira: jiraSettingsFrom(
      {
        historyDays: readPositiveNumber(
          atlassian,
          "historyDays",
          DEFAULT_ATLASSIAN_HISTORY_DAYS,
        ),
        jira: {
          enabled: config?.getOptionalBoolean("atlassian.jira.enabled") ?? true,
          storyPointsField:
            config?.getOptionalString("atlassian.jira.storyPointsField") ?? null,
        },
      },
      {
        filter: config?.getOptionalString("atlassian.jira.filter") ?? null,
        maxIssuesPerProject: readPositiveNumber(
          atlassian?.getOptionalConfig("jira"),
          "maxIssuesPerProject",
          DEFAULT_JIRA_MAX_ISSUES_PER_PROJECT,
        ),
        requestBudgetPerRun: readPositiveNumber(
          atlassian?.getOptionalConfig("jira"),
          "requestBudgetPerRun",
          DEFAULT_JIRA_REQUEST_BUDGET_PER_RUN,
        ),
      },
    ),
    confluence: readConfluenceSettings(atlassian?.getOptionalConfig("confluence")),
  };
};
