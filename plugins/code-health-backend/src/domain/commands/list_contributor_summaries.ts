import type {
  ConfluenceContributorMetrics,
  ContributorSummary,
  JiraContributorMetrics,
  SonarMetrics,
  WakaTimeMetrics,
} from "@rios0rios0/backstage-plugin-code-health-common";
import {
  accumulateContributors,
  aggregateContributorSummaries,
} from "../entities/contributor_aggregation";
import { toDay } from "../entities/day";
import { loadPersonDirectory } from "../entities/person_directory";
import type { RepositorySnapshot } from "../entities/repository_snapshot";
import type { CodeHealthStore } from "../repositories/code_health_store";
import type { CatalogReader } from "../services/catalog_reader";
import type { DirectoryReader } from "../services/identity_resolver";

/** The Sonar measures of each repository that has any, keyed by repository. */
export const sonarByRepository = (
  snapshots: readonly RepositorySnapshot[],
): Map<string, SonarMetrics> =>
  new Map(
    snapshots.flatMap((snapshot) =>
      snapshot.payload.sonarMetrics === null
        ? []
        : [[snapshot.repositoryId, snapshot.payload.sonarMetrics] as const],
    ),
  );

export interface ListContributorSummariesOptions {
  readonly store: CodeHealthStore;
  readonly catalog?: CatalogReader;
  readonly directory?: DirectoryReader;
}

export class ListContributorSummaries {
  constructor(private readonly options: ListContributorSummariesOptions) {}

  /**
   * Groups a window's activity by person and names the resulting rows.
   *
   * The grouping itself lives in `contributor_aggregation`, because the trend
   * route runs it once per bucket over the same loaded data. Everything this
   * adds is the loading and the one catalog lookup, which is bounded by who was
   * active in the window rather than by the size of the directory.
   */
  async run(input: {
    from: Date;
    to: Date;
    repositoryId?: string;
  }): Promise<ContributorSummary[]> {
    const day = toDay(input.to);

    const [events, wakaTimeRows, jiraRows, confluenceRows, snapshots, people] =
      await Promise.all([
        this.options.store.listEvents({
          from: input.from,
          to: input.to,
          ...(input.repositoryId === undefined
            ? {}
            : { repositoryIds: [input.repositoryId] }),
        }),
        this.options.store.listContributorMetrics<WakaTimeMetrics>({
          source: "wakatime",
          from: toDay(input.from),
          to: day,
        }),
        // Jira is stored a day at a time, so the window can be answered honestly.
        this.options.store.listContributorMetrics<JiraContributorMetrics>({
          source: "jira",
          from: toDay(input.from),
          to: day,
        }),
        // Confluence is not: measuring written volume walks a page's version
        // bodies, and doing that per day would multiply the walks by the length
        // of the window. Its row therefore describes a trailing window, which the
        // column headings say rather than leaving a reader to assume.
        this.options.store.listLatestContributorMetrics<ConfluenceContributorMetrics>({
          source: "confluence",
          day,
        }),
        this.options.store.listLatestSnapshots({ day }),
        loadPersonDirectory(this.options.store),
      ]);

    const byPerson = accumulateContributors({
      events,
      wakaTime: wakaTimeRows,
      jira: jiraRows,
      confluence: confluenceRows,
      people,
      scoped: input.repositoryId !== undefined,
    });

    // Only the people on this page are looked up, so the query is bounded by
    // who was active in the window rather than by the size of the directory.
    const users =
      this.options.directory === undefined
        ? new Map()
        : await this.options.directory.getUsersByRef(
            [...byPerson.keys()].filter((key) => key.startsWith("user:")),
          );

    return aggregateContributorSummaries(byPerson, {
      people,
      users,
      sonarByRepository: sonarByRepository(snapshots),
    });
  }
}
