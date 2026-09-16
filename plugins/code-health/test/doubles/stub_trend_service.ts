import type {
  GetContributorTrendResponse,
  GetRepositoryTrendResponse,
  RepositorySummary,
  RepositoryTrendPoint,
  TimeSeriesBucket,
  TimeWindow,
} from "@rios0rios0/backstage-plugin-code-health-common";
import { computeRepositoryHealthScore } from "@rios0rios0/backstage-plugin-code-health-common";
import type { TrendService } from "../../src/domain/services/dashboard_service";
import { RepositoryBuilder } from "../builders/repository_builder";

const WINDOW: TimeWindow = { from: "2026-06-09T00:00:00.000Z", to: "2026-09-09T00:00:00.000Z" };

export const aContributorTrend = (
  overrides: Partial<GetContributorTrendResponse> = {},
): GetContributorTrendResponse => ({
  key: "vcs:jane",
  window: WINDOW,
  bucket: "week",
  summary: null,
  score: null,
  fleet: null,
  points: [],
  ...overrides,
});

/**
 * One bucket of a repository's history.
 *
 * The score is derived from the summary rather than passed in, because that is
 * what the backend does: two figures that disagree would let a test assert a
 * combination the API can never produce.
 */
export const aRepositoryTrendPoint = (
  day: string,
  summary: RepositorySummary,
): RepositoryTrendPoint => ({
  day,
  summary,
  score: computeRepositoryHealthScore(summary),
});

export const aRepositoryTrend = (
  overrides: Partial<GetRepositoryTrendResponse> = {},
): GetRepositoryTrendResponse => {
  const summary = overrides.summary ?? RepositoryBuilder.create().build();

  return {
    id: summary.id,
    window: WINDOW,
    bucket: "week",
    score: computeRepositoryHealthScore(summary),
    fleet: null,
    points: [],
    ...overrides,
    summary,
  };
};

export class StubTrendService implements TrendService {
  private contributorResult: GetContributorTrendResponse = aContributorTrend();
  private repositoryResult: GetRepositoryTrendResponse | null = null;
  private error: Error | null = null;

  /** What each call asked for, so a month change is observable. */
  readonly contributorCalls: Array<{ key: string; window: TimeWindow; bucket: TimeSeriesBucket }> = [];
  readonly repositoryCalls: Array<{ id: string; window: TimeWindow; bucket: TimeSeriesBucket }> = [];

  withContributorTrend(result: GetContributorTrendResponse): this {
    this.contributorResult = result;
    return this;
  }

  withRepositoryTrend(result: GetRepositoryTrendResponse): this {
    this.repositoryResult = result;
    return this;
  }

  withError(error: Error): this {
    this.error = error;
    return this;
  }

  async getContributorTrend(
    key: string,
    window: TimeWindow,
    bucket: TimeSeriesBucket,
  ): Promise<GetContributorTrendResponse> {
    this.contributorCalls.push({ key, window, bucket });
    if (this.error) throw this.error;
    return { ...this.contributorResult, key, window, bucket };
  }

  async getRepositoryTrend(
    id: string,
    window: TimeWindow,
    bucket: TimeSeriesBucket,
  ): Promise<GetRepositoryTrendResponse> {
    this.repositoryCalls.push({ id, window, bucket });
    if (this.error) throw this.error;
    if (this.repositoryResult === null) throw new Error(`no repository with id ${id}`);
    return { ...this.repositoryResult, id, window, bucket };
  }
}
