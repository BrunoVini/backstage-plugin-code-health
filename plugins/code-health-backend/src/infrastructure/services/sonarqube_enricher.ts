import { formatDebt } from "@rios0rios0/backstage-plugin-code-health-common";
import type {
  AuthService,
  DiscoveryService,
  LoggerService,
} from "@backstage/backend-plugin-api";
import { parseEntityRef } from "@backstage/catalog-model";
import type {
  QualityGateStatus,
  SonarMetrics,
} from "@rios0rios0/backstage-plugin-code-health-common";
import { BudgetExhaustedError } from "../../domain/entities/request_budget";
import type { TrackedRepository } from "../../domain/entities/tracked_repository";
import type {
  EnrichmentContext,
  SonarEnricher,
} from "../../domain/services/snapshot_enricher";
import type { ProviderGateway } from "../http/provider_gateway";

const SONARQUBE_PLUGIN_ID = "sonarqube";

/** Shape of the summary the `sonarqube` backend plugin returns. */
interface SonarSummaryResponse {
  readonly findings?: {
    readonly measures?: readonly {
      readonly metric?: string;
      readonly value?: string;
    }[];
    readonly analysisDate?: string;
  } | null;
}

const METRIC_KEYS = {
  bugs: "bugs",
  codeSmells: "code_smells",
  securityHotspots: "security_hotspots",
  vulnerabilities: "vulnerabilities",
  coverage: "coverage",
  duplications: "duplicated_lines_density",
  technicalDebt: "sqale_index",
  qualityGate: "alert_status",
} as const;

const numeric = (measures: Map<string, string>, key: string): number => {
  const parsed = Number(measures.get(key));
  return Number.isFinite(parsed) ? parsed : 0;
};

const QUALITY_GATES: ReadonlyMap<string, QualityGateStatus> = new Map([
  ["OK", "OK"],
  ["ERROR", "ERROR"],
]);

export interface SonarqubeEnricherOptions {
  readonly gateway: ProviderGateway;
  readonly auth: AuthService;
  readonly discovery: DiscoveryService;
  readonly logger: LoggerService;
}

/**
 * Reads Sonar measures through the `sonarqube` backend plugin rather than
 * talking to Sonar directly.
 *
 * That plugin already holds the Sonar token, so there is no second credential
 * to configure here and none reaches a browser. The call goes over the internal
 * service-to-service channel with a token minted for this plugin, which is why
 * it works without any proxy configuration.
 *
 * Sonar history cannot be backfilled through this route: the plugin exposes only
 * a current summary per entity, with no measures-history passthrough. The trend
 * therefore begins at the first snapshot after installation, which the dashboard
 * has to state rather than draw as a flat line through a year it never observed.
 */
export class SonarqubeEnricher implements SonarEnricher {
  constructor(private readonly options: SonarqubeEnricherOptions) {}

  async fetch(
    repository: TrackedRepository,
    context: EnrichmentContext,
  ): Promise<SonarMetrics | null> {
    // The sonarqube plugin resolves the project key from the entity's own
    // annotation, so an entity without one has nothing to look up.
    if (!repository.sonarProjectKey) return null;

    const { kind, namespace, name } = parseEntityRef(repository.entityRef);

    try {
      const baseUrl =
        await this.options.discovery.getBaseUrl(SONARQUBE_PLUGIN_ID);
      const { token } = await this.options.auth.getPluginRequestToken({
        onBehalfOf: await this.options.auth.getOwnServiceCredentials(),
        targetPluginId: SONARQUBE_PLUGIN_ID,
      });

      const response = await this.options.gateway.request(
        {
          url: `${baseUrl}/entities/${kind}/${namespace}/${name}/summary`,
          headers: { Authorization: `Bearer ${token}` },
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        },
        context.budget,
      );

      return this.toMetrics(JSON.parse(response.body) as SonarSummaryResponse);
    } catch (error) {
      // A spent allowance is a fact about the run, not about this repository,
      // and reading it as "no Sonar project" would leave the snapshot pass
      // unable to say how many readings it never took.
      if (error instanceof BudgetExhaustedError) throw error;
      // The plugin may not be installed, or the project may not exist yet.
      // Neither is a reason to fail the whole snapshot.
      this.options.logger.debug(
        `no Sonar summary for ${repository.entityRef}: ${String(error)}`,
      );
      return null;
    }
  }

  private toMetrics(body: SonarSummaryResponse): SonarMetrics | null {
    const measures = body.findings?.measures;
    if (!measures) return null;

    const values = new Map(
      measures
        .filter((measure) => measure.metric !== undefined)
        .map((measure) => [measure.metric as string, measure.value ?? ""]),
    );

    return {
      bugs: numeric(values, METRIC_KEYS.bugs),
      codeSmells: numeric(values, METRIC_KEYS.codeSmells),
      securityHotspots: numeric(values, METRIC_KEYS.securityHotspots),
      vulnerabilities: numeric(values, METRIC_KEYS.vulnerabilities),
      coverage: numeric(values, METRIC_KEYS.coverage),
      duplications: numeric(values, METRIC_KEYS.duplications),
      technicalDebt: formatDebt(numeric(values, METRIC_KEYS.technicalDebt)),
      technicalDebtMinutes: numeric(values, METRIC_KEYS.technicalDebt),
      qualityGateStatus:
        QUALITY_GATES.get(values.get(METRIC_KEYS.qualityGate) ?? "") ?? "NONE",
    };
  }
}
