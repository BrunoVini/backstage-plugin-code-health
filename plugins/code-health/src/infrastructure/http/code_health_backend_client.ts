import type { DiscoveryApi, FetchApi } from "@backstage/core-plugin-api";
import type {
  ContributorSummary,
  CoverageInfo,
  ExclusionReason,
  GetAccessResponse,
  GetCapabilitiesResponse,
  GetContributorTrendResponse,
  GetRepositoryTrendResponse,
  GetTimeSeriesResponse,
  IdentityRow,
  IdentitySource,
  IntegrationCapabilities,
  ListContributorsResponse,
  ListIdentitiesResponse,
  ListOwnedRepositoriesResponse,
  ListRepositoriesResponse,
  RepositorySummary,
  ResetIngestionRequest,
  ResetIngestionResponse,
  TimeSeriesBucket,
  TimeSeriesPoint,
  TimeWindow,
} from "@rios0rios0/backstage-plugin-code-health-common";
import {
  CODE_HEALTH_API_VERSION,
  CODE_HEALTH_PLUGIN_ID,
  parseIntegrationCapabilities,
} from "@rios0rios0/backstage-plugin-code-health-common";
import type {
  AdministrationService,
  ContributorService,
  CoverageService,
  DashboardService,
  IdentityService,
  IntegrationsService,
  OwnershipService,
  TimeSeriesService,
  TrendService,
} from "../../domain/services/dashboard_service";

export interface CodeHealthBackendClientOptions {
  readonly discoveryApi: DiscoveryApi;
  readonly fetchApi: FetchApi;
}

/**
 * The only thing the browser talks to.
 *
 * Every provider call now happens in the backend, on a schedule, once for the
 * whole organisation. What used to be thousands of requests per dashboard load
 * — five per repository against Azure DevOps, plus compliance and badge
 * lookups, repeated for every user and every tab switch — is one request here.
 *
 * `fetchApi` already attaches the caller's Backstage identity token, so there is
 * no credential to hold and nothing to store in the browser.
 */
export class CodeHealthBackendClient
  implements
    DashboardService,
    ContributorService,
    CoverageService,
    TimeSeriesService,
    IntegrationsService,
    IdentityService,
    TrendService,
    OwnershipService,
    AdministrationService
{
  constructor(private readonly options: CodeHealthBackendClientOptions) {}

  async listRepositories(window: TimeWindow): Promise<RepositorySummary[]> {
    const body = await this.get<ListRepositoriesResponse>("repositories", {
      from: window.from,
      to: window.to,
    });
    return [...body.items];
  }

  async listContributors(
    window: TimeWindow,
    repositoryId?: string,
  ): Promise<ContributorSummary[]> {
    const body = await this.get<ListContributorsResponse>("contributors", {
      from: window.from,
      to: window.to,
      ...(repositoryId === undefined ? {} : { repositoryId }),
    });
    return [...body.items];
  }

  async getTimeSeries(
    window: TimeWindow,
    bucket: TimeSeriesBucket,
  ): Promise<TimeSeriesPoint[]> {
    const body = await this.get<GetTimeSeriesResponse>("timeseries", {
      from: window.from,
      to: window.to,
      bucket,
    });
    return [...body.points];
  }

  async getCoverage(): Promise<CoverageInfo> {
    return this.get<CoverageInfo>("coverage", {});
  }

  async getCapabilities(): Promise<IntegrationCapabilities> {
    const body = await this.get<GetCapabilitiesResponse>("capabilities", {});
    // Parsed rather than trusted: a frontend one release ahead of its backend
    // asks about integrations that backend has never heard of, and the honest
    // answer to "is Jira on?" from a backend with no Jira is "no", not a
    // dashboard that fails to render.
    return parseIntegrationCapabilities(body.integrations);
  }

  async listIdentities(filter: {
    sources?: readonly IdentitySource[];
    linked?: boolean;
    excluded?: boolean;
  }): Promise<IdentityRow[]> {
    const body = await this.get<ListIdentitiesResponse>("identities", {
      ...(filter.sources === undefined || filter.sources.length === 0
        ? {}
        : { source: [...filter.sources] }),
      ...(filter.linked === undefined ? {} : { linked: String(filter.linked) }),
      ...(filter.excluded === undefined ? {} : { excluded: String(filter.excluded) }),
    });
    return [...body.items];
  }

  async linkIdentity(link: {
    source: IdentitySource;
    sourceKey: string;
    entityRef: string;
  }): Promise<void> {
    await this.send("PUT", `${CODE_HEALTH_API_VERSION}/identities/links`, link);
  }

  async unlinkIdentity(identity: {
    source: IdentitySource;
    sourceKey: string;
  }): Promise<void> {
    await this.send(
      "DELETE",
      `${CODE_HEALTH_API_VERSION}/identities/links/${identity.source}/${encodeURIComponent(
        identity.sourceKey,
      )}`,
    );
  }

  async excludeIdentity(exclusion: {
    source: IdentitySource;
    sourceKey: string;
    reason: ExclusionReason;
  }): Promise<void> {
    await this.send("PUT", `${CODE_HEALTH_API_VERSION}/identities/exclusions`, exclusion);
  }

  async includeIdentity(identity: {
    source: IdentitySource;
    sourceKey: string;
  }): Promise<void> {
    await this.send(
      "DELETE",
      `${CODE_HEALTH_API_VERSION}/identities/exclusions/${identity.source}/${encodeURIComponent(
        identity.sourceKey,
      )}`,
    );
  }

  async refresh(): Promise<void> {
    await this.send("POST", `${CODE_HEALTH_API_VERSION}/refresh`);
  }

  async getContributorTrend(
    key: string,
    window: TimeWindow,
    bucket: TimeSeriesBucket,
  ): Promise<GetContributorTrendResponse> {
    // A person key carries a colon and, for a linked person, a slash, so it is
    // encoded as one path segment rather than spliced in verbatim.
    return this.get<GetContributorTrendResponse>(
      `contributors/${encodeURIComponent(key)}/trend`,
      { from: window.from, to: window.to, bucket },
    );
  }

  async getRepositoryTrend(
    id: string,
    window: TimeWindow,
    bucket: TimeSeriesBucket,
  ): Promise<GetRepositoryTrendResponse> {
    return this.get<GetRepositoryTrendResponse>(
      `repositories/${encodeURIComponent(id)}/trend`,
      { from: window.from, to: window.to, bucket },
    );
  }

  async listOwnedRepositories(
    key: string,
    window: TimeWindow,
  ): Promise<ListOwnedRepositoriesResponse> {
    return this.get<ListOwnedRepositoriesResponse>(
      `contributors/${encodeURIComponent(key)}/repositories`,
      { from: window.from, to: window.to },
    );
  }

  async getAccess(): Promise<GetAccessResponse> {
    return this.get<GetAccessResponse>("access", {});
  }

  async resetIngestion(request: ResetIngestionRequest): Promise<ResetIngestionResponse> {
    const response = await this.send(
      "POST",
      `${CODE_HEALTH_API_VERSION}/ingestion/reset`,
      request,
    );
    return (await response.json()) as ResetIngestionResponse;
  }

  private async send(method: string, path: string, body?: unknown): Promise<Response> {
    const baseUrl = await this.baseUrl();
    const response = await this.options.fetchApi.fetch(`${baseUrl}/${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (!response.ok) throw await this.toError(response, path);
    return response;
  }

  /**
   * Resolved immediately before each request rather than held.
   *
   * The discovery API is documented as something to call per request; a base URL
   * captured at construction goes stale whenever the backend moves, and the
   * failure looks like the plugin being uninstalled.
   */
  private async baseUrl(): Promise<string> {
    return this.options.discoveryApi.getBaseUrl(CODE_HEALTH_PLUGIN_ID);
  }

  /**
   * A list value becomes a repeated parameter, not a comma-joined one.
   *
   * `source=vcs&source=jira` is what the backend parses; `source=vcs,jira` is a
   * single value that matches no known source and is rejected with a 400.
   */
  private async get<T>(
    path: string,
    query: Record<string, string | readonly string[]>,
  ): Promise<T> {
    const baseUrl = await this.baseUrl();
    const parameters = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      for (const entry of Array.isArray(value) ? value : [value as string]) {
        parameters.append(key, entry);
      }
    }
    const suffix = parameters.toString() === "" ? "" : `?${parameters.toString()}`;

    const response = await this.options.fetchApi.fetch(
      `${baseUrl}/${CODE_HEALTH_API_VERSION}/${path}${suffix}`,
    );
    if (!response.ok) throw await this.toError(response, path);

    return (await response.json()) as T;
  }

  /**
   * Turns a failure into something a person can act on.
   *
   * Backstage errors carry a message explaining what was wrong with the request;
   * surfacing that beats "request failed with 400", which tells a user nothing
   * about the range they picked.
   */
  private async toError(response: Response, path: string): Promise<Error> {
    const fallback = `code-health request to ${path} failed with ${response.status}`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      return new Error(body.error?.message ?? fallback);
    } catch {
      return new Error(fallback);
    }
  }
}
