import type { ContributorSummary } from "./contributor_summary";
import type { CoverageInfo } from "./coverage";
import type { IdentityRow } from "./identity";
import type { IntegrationCapabilities } from "./integrations";
import type { OwnershipInfo } from "./ownership";
import type { ProductivityScore } from "./productivity_score";
import type { RepositoryHealthScore } from "./repository_health_score";
import type { RepositorySummary } from "./repository_summary";
import type { TimeSeriesBucket, TimeSeriesPoint } from "./time_series";
import type { ContributorTrendPoint, RepositoryTrendPoint } from "./trend";

/**
 * The plugin id both packages register under. The frontend resolves the backend
 * with `discoveryApi.getBaseUrl(CODE_HEALTH_PLUGIN_ID)`, which only works
 * because the backend plugin claims the same id.
 */
export const CODE_HEALTH_PLUGIN_ID = "code-health";

/** Version prefix of every data route, so a future shape change can coexist. */
export const CODE_HEALTH_API_VERSION = "v1";

/**
 * A half-open window `[from, to)` of ISO 8601 instants. Leaving it out asks for
 * the last 24 hours, which is what a freshly installed plugin can answer before
 * any history exists.
 */
export interface TimeWindow {
  readonly from: string;
  readonly to: string;
}

export interface ListRepositoriesResponse {
  readonly window: TimeWindow;
  readonly items: readonly RepositorySummary[];
}

export interface ListContributorsResponse {
  readonly window: TimeWindow;
  readonly items: readonly ContributorSummary[];
}

export interface GetTimeSeriesResponse {
  readonly window: TimeWindow;
  readonly bucket: TimeSeriesBucket;
  readonly points: readonly TimeSeriesPoint[];
}

export type GetCoverageResponse = CoverageInfo;

/**
 * What the backend is configured to do, asked once before anything is drawn.
 *
 * The alternative — inferring an integration from whether any row happens to
 * carry a value for it — cannot tell a switched-off integration from one that
 * is on and has not run yet, and those want completely different words on the
 * screen. It also makes a freshly configured install look broken for a day.
 */
export interface GetCapabilitiesResponse {
  readonly integrations: IntegrationCapabilities;
}

export interface ListIdentitiesResponse {
  readonly items: readonly IdentityRow[];
}

export interface LinkIdentityRequest {
  readonly source: string;
  readonly sourceKey: string;
  /** A `user:<namespace>/<name>` reference. */
  readonly entityRef: string;
}

/**
 * Takes an account out of every measurement the plugin makes.
 *
 * The reason is required rather than optional. A row vanishing from every
 * table is the largest effect anything on this screen has, and the only thing
 * that makes it reviewable later is the sentence saying why — so there is no
 * shape of this request that omits one.
 */
export interface ExcludeIdentityRequest {
  readonly source: string;
  readonly sourceKey: string;
  /** One of {@link ExclusionReason}. */
  readonly reason: string;
}

export interface RefreshResponse {
  /** Scheduler task ids that were triggered. */
  readonly triggered: readonly string[];
}

/**
 * One person's history, bucketed, from `/v1/contributors/:key/trend`.
 *
 * `summary` and `score` describe the whole window, so the page can head itself
 * with the same row the table shows; `points` carry one summary per bucket.
 * The summary is null when nothing was recorded under the key in the window,
 * which is how a stale link is told apart from a quiet month: the points are
 * still returned, all zero, and the page says which it is.
 */
export interface GetContributorTrendResponse {
  readonly key: string;
  readonly window: TimeWindow;
  readonly bucket: TimeSeriesBucket;
  readonly summary: ContributorSummary | null;
  readonly score: ProductivityScore | null;
  readonly points: readonly ContributorTrendPoint[];
}

/** One repository's history, bucketed, from `/v1/repositories/:id/trend`. */
export interface GetRepositoryTrendResponse {
  readonly id: string;
  readonly window: TimeWindow;
  readonly bucket: TimeSeriesBucket;
  readonly summary: RepositorySummary;
  readonly score: RepositoryHealthScore;
  readonly points: readonly RepositoryTrendPoint[];
}

/**
 * The repositories a person is responsible for, from
 * `/v1/contributors/:key/repositories`.
 *
 * Responsibility is the catalog's `spec.owner`, matched against the person's
 * `User` entity and the groups they belong to — a different question from
 * where they committed, and the one a team lead asking "are they looking
 * after their projects" actually means. The rows are ordinary summaries over
 * the window, so their health is computed the same way the repositories table
 * computes it.
 */
export interface ListOwnedRepositoriesResponse {
  readonly window: TimeWindow;
  readonly ownership: OwnershipInfo;
  readonly items: readonly RepositorySummary[];
}

/**
 * What the caller may do beyond reading, from `/v1/access`.
 *
 * Answered per caller rather than per install, and answered by the backend
 * rather than inferred in the browser, so the button and the route it calls
 * can never disagree about who is allowed to press it.
 */
export interface GetAccessResponse {
  readonly canResetIngestion: boolean;
  /**
   * How far back the backend is configured to keep history, in days. It is
   * the furthest a reset can be asked to reach, so the dialog offers nothing
   * the read API would then refuse to answer for.
   */
  readonly retentionDays: number;
}

/**
 * What an administrator asks for when they start the history collection over.
 *
 * `days` is how far back the walk goes, which is what makes the request
 * worth a dialog: a year of history across two hundred repositories is a
 * day of rate-limited requests, and someone who wants last quarter re-read
 * after a fix should not have to pay for the other three.
 */
export interface ResetIngestionRequest {
  readonly days: number;
}

/** The outcome of `POST /v1/ingestion/reset`. */
export interface ResetIngestionResponse {
  /** Tracked repositories whose history collection was sent back to the start. */
  readonly repositories: number;
  /** The reach that was applied, in days, after bounding by the retention. */
  readonly days: number;
  /** Scheduler task ids that were triggered afterwards. */
  readonly triggered: readonly string[];
}
