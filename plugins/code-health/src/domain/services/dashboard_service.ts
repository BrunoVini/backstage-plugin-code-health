import type {
  ContributorSummary,
  CoverageInfo,
  DirectoryUser,
  ExclusionReason,
  GetAccessResponse,
  GetContributorTrendResponse,
  GetRepositoryTrendResponse,
  IdentityRow,
  IdentitySource,
  IntegrationCapabilities,
  ListOwnedRepositoriesResponse,
  RepositorySummary,
  ResetIngestionRequest,
  ResetIngestionResponse,
  TimeSeriesBucket,
  TimeSeriesPoint,
  TimeWindow,
} from "@rios0rios0/backstage-plugin-code-health-common";

/**
 * Everything the dashboard reads.
 *
 * All three are answered by the Code Health backend from data it already
 * ingested, so the browser never contacts a version control provider and a
 * dashboard load costs the same regardless of how many repositories exist.
 */
export interface DashboardService {
  listRepositories(window: TimeWindow): Promise<RepositorySummary[]>;
}

export interface ContributorService {
  listContributors(window: TimeWindow, repositoryId?: string): Promise<ContributorSummary[]>;
}

/**
 * How much history the backend has collected.
 *
 * The dashboard uses this to bound its range picker: a freshly installed plugin
 * can only answer for the last few hours, and the selectable window widens
 * backwards from today as the backfill advances.
 */
export interface CoverageService {
  getCoverage(): Promise<CoverageInfo>;
  /** Asks the backend to run its ingestion tasks now. */
  refresh(): Promise<void>;
}

/**
 * Fleet-wide activity over time.
 *
 * Answered from the same ingested events the tables read, bucketed by the
 * backend so the browser never receives one row per commit.
 */
export interface TimeSeriesService {
  getTimeSeries(window: TimeWindow, bucket: TimeSeriesBucket): Promise<TimeSeriesPoint[]>;
}

/**
 * Which optional integrations the backend was configured with.
 *
 * Asked once, before anything is drawn. Inferring it from whether any row
 * carries a value cannot tell a switched-off integration from one that is on
 * and has not collected yet, and those want completely different words on the
 * screen — as well as making a freshly configured install look broken for a day.
 */
export interface IntegrationsService {
  getCapabilities(): Promise<IntegrationCapabilities>;
}

/**
 * The accounts the plugin has seen, which person each belongs to, and which of
 * them are measured at all.
 *
 * These are the only writes the dashboard makes. Everything else is a read of
 * what a scheduled task already collected; both of these are statements only a
 * person can make — that two accounts are one human, and that an account is not
 * a human being measured — and between them they are what turns three partial
 * rows into one and keep a build service off the list entirely.
 */
export interface IdentityService {
  listIdentities(filter: {
    sources?: readonly IdentitySource[];
    linked?: boolean;
    excluded?: boolean;
  }): Promise<IdentityRow[]>;

  /**
   * The catalog users whose name, address or entity name contains `query`,
   * for the picker behind a link. Answered by the backend, which is the only
   * side that can read the directory, and asked only once the typing pauses.
   */
  listDirectoryUsers(query: string): Promise<DirectoryUser[]>;

  linkIdentity(link: {
    source: IdentitySource;
    sourceKey: string;
    entityRef: string;
  }): Promise<void>;

  unlinkIdentity(identity: {
    source: IdentitySource;
    sourceKey: string;
  }): Promise<void>;

  /** Takes the account out of every figure the plugin reports, and says why. */
  excludeIdentity(exclusion: {
    source: IdentitySource;
    sourceKey: string;
    reason: ExclusionReason;
  }): Promise<void>;

  /**
   * Puts it back, retroactively — nothing was deleted, so every window the
   * plugin ever collected reports the account again from the next read.
   */
  includeIdentity(identity: {
    source: IdentitySource;
    sourceKey: string;
  }): Promise<void>;
}

/**
 * One person's or one repository's history, bucketed.
 *
 * Bucketed by the backend, like the fleet cadence, so a six-month trend is a
 * few dozen points rather than every event the person ever produced. Each
 * point carries the same summary row the tables show, so a chart of any
 * column is a chart of the same number the table prints.
 */
export interface TrendService {
  getContributorTrend(
    key: string,
    window: TimeWindow,
    bucket: TimeSeriesBucket,
  ): Promise<GetContributorTrendResponse>;

  getRepositoryTrend(
    id: string,
    window: TimeWindow,
    bucket: TimeSeriesBucket,
  ): Promise<GetRepositoryTrendResponse>;
}

/**
 * The repositories a person is responsible for, by the catalog's `spec.owner`.
 *
 * A different question from where somebody committed: this is what a team
 * lead asking "are they looking after their projects" means, and it is
 * answered by the backend because only the backend can walk the person's
 * group memberships without putting a catalog query on every render.
 */
export interface OwnershipService {
  listOwnedRepositories(key: string, window: TimeWindow): Promise<ListOwnedRepositoriesResponse>;
}

/**
 * The one thing on the dashboard reserved for administrators.
 *
 * Starting the history collection over throws away every commit, pull
 * request, review and run already stored and re-reads them from the
 * providers, which is a day of rate-limited requests on a large fleet. Who may
 * ask for that is decided by the backend, and asked of it before the button is
 * drawn, so the control and the route can never disagree.
 */
export interface AdministrationService {
  getAccess(): Promise<GetAccessResponse>;
  resetIngestion(request: ResetIngestionRequest): Promise<ResetIngestionResponse>;
}
