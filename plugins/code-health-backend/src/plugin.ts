import { coreServices, createBackendPlugin } from "@backstage/backend-plugin-api";
import { ScmIntegrations } from "@backstage/integration";
import { catalogServiceRef } from "@backstage/plugin-catalog-node";
import type { Platform } from "@rios0rios0/backstage-plugin-code-health-common";
import { CODE_HEALTH_PLUGIN_ID } from "@rios0rios0/backstage-plugin-code-health-common";
import { AuthorizeAdministrator } from "./domain/commands/authorize_administrator";
import { CaptureRepositorySnapshots } from "./domain/commands/capture_repository_snapshots";
import { GetContributorTrend } from "./domain/commands/get_contributor_trend";
import { GetRepositoryTimeSeries } from "./domain/commands/get_repository_time_series";
import { GetRepositoryTrend } from "./domain/commands/get_repository_trend";
import { DiscoverRepositories } from "./domain/commands/discover_repositories";
import { ExcludeIdentity } from "./domain/commands/exclude_identity";
import { IngestRepositoryHistory } from "./domain/commands/ingest_repository_history";
import { LinkIdentity } from "./domain/commands/link_identity";
import { ListContributorSummaries } from "./domain/commands/list_contributor_summaries";
import { ListDirectoryUsers } from "./domain/commands/list_directory_users";
import { ListIdentities } from "./domain/commands/list_identities";
import { ListOwnedRepositories } from "./domain/commands/list_owned_repositories";
import { ListRepositorySummaries } from "./domain/commands/list_repository_summaries";
import { ReconcileIdentities } from "./domain/commands/reconcile_identities";
import { ResetIngestion } from "./domain/commands/reset_ingestion";
import {
  integrationCapabilitiesOf,
  isAtlassianConfigured,
  isWakaTimeConfigured,
} from "./domain/entities/ingestion_settings";
import { codeHealthPermissions } from "./domain/entities/permissions";
import type { VcsCollector } from "./domain/services/vcs_collector";
import { createCodeHealthRouter } from "./infrastructure/controllers/code_health_router";
import { ProviderGateway } from "./infrastructure/http/provider_gateway";
import { KnexCodeHealthStore } from "./infrastructure/repositories/knex_code_health_store";
import { AnnotationRepositoryResolver } from "./infrastructure/services/annotation_repository_resolver";
import { BackstageCatalogReader } from "./infrastructure/services/backstage_catalog_reader";
import { readCodeHealthSettings } from "./infrastructure/services/backstage_settings_reader";
import { AzureDevOpsCollector } from "./infrastructure/services/collectors/azure_devops_collector";
import { GithubCollector } from "./infrastructure/services/collectors/github_collector";
import { IntegrationsCredentialsResolver } from "./infrastructure/services/integrations_credentials_resolver";
import { AtlassianClient } from "./infrastructure/services/atlassian/atlassian_client";
import { ConfluenceApiEnricher } from "./infrastructure/services/atlassian/confluence_enricher";
import { JiraApiEnricher } from "./infrastructure/services/atlassian/jira_enricher";
import { SonarqubeEnricher } from "./infrastructure/services/sonarqube_enricher";
import { StoreIdentityObserver } from "./infrastructure/services/store_identity_observer";
import { WakaTimeApiEnricher } from "./infrastructure/services/wakatime_enricher";

export const DISCOVERY_TASK_ID = "code-health.discover";
export const INGESTION_TASK_ID = "code-health.ingest";
export const SNAPSHOT_TASK_ID = "code-health.snapshot";

/**
 * Code Health backend plugin.
 *
 * Discovers repositories from the Backstage catalog, ingests their history in a
 * rate-limited background job, and serves it to the frontend plugin. It claims
 * the same plugin id as the frontend, which is what makes
 * `discoveryApi.getBaseUrl('code-health')` resolve to this router.
 *
 * @public
 */
export const codeHealthPlugin = createBackendPlugin({
  pluginId: CODE_HEALTH_PLUGIN_ID,
  register(env) {
    env.registerInit({
      deps: {
        auth: coreServices.auth,
        catalog: catalogServiceRef,
        discovery: coreServices.discovery,
        config: coreServices.rootConfig,
        database: coreServices.database,
        httpAuth: coreServices.httpAuth,
        httpRouter: coreServices.httpRouter,
        logger: coreServices.logger,
        permissions: coreServices.permissions,
        permissionsRegistry: coreServices.permissionsRegistry,
        scheduler: coreServices.scheduler,
        userInfo: coreServices.userInfo,
      },
      async init({
        auth,
        catalog,
        config,
        database,
        discovery,
        httpAuth,
        httpRouter,
        logger,
        permissions,
        permissionsRegistry,
        scheduler,
        userInfo,
      }) {
        const settings = readCodeHealthSettings(config, logger);
        const store = await KnexCodeHealthStore.create({ database });
        const integrations = ScmIntegrations.fromConfig(config);
        // Shared by discovery, which reads the tracked entities, by identity
        // reconciliation, which matches accounts to catalog users, and by the
        // contributors route, which resolves a person back to their entity.
        const catalogReader = new BackstageCatalogReader(catalog, auth);
        // Every collector and enricher writes accounts through this rather than
        // through the store, so nothing that only observes people can also move
        // an ingestion cursor.
        const identityObserver = new StoreIdentityObserver(store);

        // Registered so a host's permission policy, or the RBAC plugin, can
        // refuse the reset by name. That is the narrowing half of the decision;
        // `codeHealth.administrators` is the half that makes it restrictive at
        // all, because a stock Backstage policy allows everything.
        permissionsRegistry.addPermissions(codeHealthPermissions);

        // Shared by the repositories table and by the ownership route, which
        // filters the same rows rather than computing a second set that could
        // disagree with the first.
        const repositories = new ListRepositorySummaries(store, catalogReader);

        // Read once and shared, because the capabilities probe and the
        // productivity score have to agree about what is switched on: a
        // dashboard showing Jira columns beside a score that never scored a
        // ticket would be two answers to one question.
        const capabilities = integrationCapabilitiesOf(settings);

        httpRouter.use(
          createCodeHealthRouter({
            store,
            httpAuth,
            scheduler,
            repositories,
            contributors: new ListContributorSummaries({
              store,
              directory: catalogReader,
            }),
            timeSeries: new GetRepositoryTimeSeries(store),
            contributorTrend: new GetContributorTrend({
              store,
              directory: catalogReader,
              capabilities,
            }),
            // Given the table's own command, so the fleet average a repository's
            // page compares against is the average of the rows the table shows —
            // but built without the catalog. The mean never reads an owner's
            // name, and resolving every distinct owner's profile would be the one
            // cost of that read the repositories tab does not already pay on
            // every load of its own.
            repositoryTrend: new GetRepositoryTrend(
              store,
              catalogReader,
              new ListRepositorySummaries(store),
            ),
            owned: new ListOwnedRepositories(repositories, catalogReader),
            identities: new ListIdentities(store, catalogReader),
            directoryUsers: new ListDirectoryUsers(catalogReader),
            links: new LinkIdentity(store, catalogReader),
            exclusions: new ExcludeIdentity(store),
            access: new AuthorizeAdministrator({
              userInfo,
              permissions,
              administrators: settings.administrators,
            }),
            reset: new ResetIngestion({
              store,
              logger: logger.child({ component: "ingestion-reset" }),
            }),
            retentionDays: settings.ingestion.retentionDays,
            capabilities,
            refreshableTaskIds: [DISCOVERY_TASK_ID, INGESTION_TASK_ID, SNAPSHOT_TASK_ID],
            ingestionTaskId: INGESTION_TASK_ID,
          }),
        );
        // The frontend probes this before it renders anything, and a probe that
        // needed a token could not distinguish "not installed" from "not
        // signed in".
        httpRouter.addAuthPolicy({ path: "/health", allow: "unauthenticated" });

        const discover = new DiscoverRepositories({
          store,
          catalog: catalogReader,
          resolver: new AnnotationRepositoryResolver(integrations),
          logger: logger.child({ task: DISCOVERY_TASK_ID }),
        });

        // Runs after both of the tasks that turn up new accounts rather than on
        // a schedule of its own. Discovery brings new catalog users; ingestion
        // brings the commit authors those users have to be matched against, and
        // waiting for the next half-hourly discovery pass would leave a fresh
        // install showing unlinked rows for thirty minutes after it had all the
        // evidence it needed.
        //
        // Running it that often is cheap because it stops before it reaches the
        // catalog: two small table reads, and nothing else once every account
        // with an address is linked.
        const reconcile = new ReconcileIdentities({
          store,
          catalog: catalogReader,
          logger: logger.child({ component: "identities" }),
        });

        await scheduler.scheduleTask({
          ...settings.ingestion.discoverySchedule,
          id: DISCOVERY_TASK_ID,
          fn: async () => {
            const now = new Date();
            await discover.run({
              entityFilters: settings.ingestion.entityFilters,
              retentionDays: settings.ingestion.retentionDays,
              now,
            });
            await reconcile.run({ now });
          },
        });

        const gateway = new ProviderGateway({
          logger: logger.child({ component: "provider-gateway" }),
          concurrencyPerHost: settings.ingestion.concurrencyPerHost,
        });
        const credentials = new IntegrationsCredentialsResolver(integrations);

        // A map rather than a switch, so supporting another platform is a new
        // entry and an implementation of the port, with nothing here to edit.
        const collectors = new Map<Platform, VcsCollector>([
          ["github", new GithubCollector({ gateway, credentials, logger })],
          ["azure-devops", new AzureDevOpsCollector({ gateway, credentials, logger })],
        ]);

        const ingest = new IngestRepositoryHistory({
          store,
          collectors,
          identities: identityObserver,
          settings: settings.ingestion,
          logger: logger.child({ task: INGESTION_TASK_ID }),
        });

        // One client for both products: they share a host, a credential and a
        // per-site rate limit, and two clients would each believe they had the
        // whole allowance while the site counted the sum.
        const atlassian = isAtlassianConfigured(settings.atlassian)
          ? new AtlassianClient({
              gateway,
              settings: settings.atlassian,
              logger: logger.child({ component: "atlassian" }),
            })
          : null;

        const snapshots = new CaptureRepositorySnapshots({
          store,
          collectors,
          sonar: settings.sonar.enabled
            ? new SonarqubeEnricher({ gateway, auth, discovery, logger })
            : null,
          wakaTime: isWakaTimeConfigured(settings.wakaTime)
            ? new WakaTimeApiEnricher({ gateway, settings: settings.wakaTime, logger })
            : null,
          wakaTimeWindow: {
            historyDays: settings.wakaTime.historyDays,
            // Zero when the option is off, so the command has one number to obey
            // rather than a flag and a count that can disagree.
            aiDays: settings.wakaTime.includeAiMetrics ? settings.wakaTime.aiDaysPerRun : 0,
          },
          jira:
            atlassian === null || !settings.atlassian.jira.enabled
              ? null
              : new JiraApiEnricher({
                  client: atlassian,
                  settings: settings.jira,
                  baseUrl: settings.atlassian.baseUrl,
                  // The catalog is the only legitimate source of project keys,
                  // exactly as it is the only source of repositories.
                  // Enumerating the site's projects instead would reintroduce
                  // the "list the whole organisation on every run" behaviour the
                  // gateway exists to stop.
                  listRepositories: async () =>
                    (await store.listTrackedRepositories()).map((entry) => entry.repository),
                  identities: identityObserver,
                  logger: logger.child({ component: "jira" }),
                }),
          confluence:
            atlassian === null || !settings.atlassian.confluence.enabled
              ? null
              : new ConfluenceApiEnricher({
                  client: atlassian,
                  atlassian: settings.atlassian,
                  settings: settings.confluence,
                  identities: identityObserver,
                  logger: logger.child({ component: "confluence" }),
                }),
          identities: identityObserver,
          settings: settings.ingestion,
          logger: logger.child({ task: SNAPSHOT_TASK_ID }),
        });

        await scheduler.scheduleTask({
          ...settings.ingestion.snapshotSchedule,
          id: SNAPSHOT_TASK_ID,
          fn: async (signal) => {
            await snapshots.run({ now: new Date(), signal });
          },
        });

        await scheduler.scheduleTask({
          ...settings.ingestion.schedule,
          id: INGESTION_TASK_ID,
          // The scheduler aborts on timeout; the signal is threaded all the way
          // to the transport so an overrunning run stops issuing requests
          // instead of finishing them after it was told to stop.
          fn: async (signal) => {
            const now = new Date();
            await ingest.run({ now, signal });
            await reconcile.run({ now });
          },
        });
      },
    });
  },
});
