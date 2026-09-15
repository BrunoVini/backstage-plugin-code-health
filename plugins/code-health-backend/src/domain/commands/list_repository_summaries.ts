import type {
  EntityProfile,
  RepositorySummary,
  WakaTimeMetrics,
} from "@rios0rios0/backstage-plugin-code-health-common";
import type { CodeHealthEvent } from "../entities/code_health_event";
import { toDay } from "../entities/day";
import {
  loadPersonDirectory,
  measuredContributorMetrics,
  measuredEvents,
} from "../entities/person_directory";
import {
  aggregateWakaTimeProjects,
  buildRepositorySummary,
  unsnapshotted,
} from "../entities/repository_summary_builder";
import type { CodeHealthStore } from "../repositories/code_health_store";
import type { CatalogReader } from "../services/catalog_reader";

/** Groups a flat list of events by the repository they belong to. */
export const groupEventsByRepository = (
  events: readonly CodeHealthEvent[],
): Map<string, CodeHealthEvent[]> => {
  const byRepository = new Map<string, CodeHealthEvent[]>();
  for (const event of events) {
    const bucket = byRepository.get(event.repositoryId);
    if (bucket) bucket.push(event);
    else byRepository.set(event.repositoryId, [event]);
  }
  return byRepository;
};

/**
 * The owning entities' names and photographs, or nothing at all.
 *
 * A catalog that is briefly unreachable degrades to slugs rather than failing
 * the whole response. Every other field on these rows came out of this
 * plugin's own database and is already in hand; refusing to render two hundred
 * repositories because a decoration could not be fetched trades a complete
 * answer for no answer. It is the same rule the owner column already follows
 * for an entity the catalog does not hold — a row with no photograph, not a
 * broken request.
 */
export const resolveOwnerProfiles = async (
  catalog: Pick<CatalogReader, "getEntityProfiles"> | undefined,
  entityRefs: readonly string[],
): Promise<ReadonlyMap<string, EntityProfile>> => {
  if (catalog === undefined || entityRefs.length === 0) return new Map();
  try {
    return await catalog.getEntityProfiles(entityRefs);
  } catch {
    return new Map();
  }
};

/** The distinct owners of a tracked set — a team list, not a directory. */
export const distinctOwnerRefs = (
  repositories: readonly { repository: { catalogFacts: { ownerRef: string | null } } }[],
): string[] => [
  ...new Set(
    repositories.flatMap(({ repository }) =>
      repository.catalogFacts.ownerRef === null ? [] : [repository.catalogFacts.ownerRef],
    ),
  ),
];

export class ListRepositorySummaries {
  constructor(
    private readonly store: CodeHealthStore,
    /**
     * Resolves an owner reference to a name and a photograph.
     *
     * Optional so the command stays testable without a catalog, and so an
     * install whose catalog is briefly unreachable renders slugs rather than
     * failing the whole table.
     */
    private readonly catalog?: Pick<CatalogReader, "getEntityProfiles">,
  ) {}

  /**
   * Builds one dashboard row per tracked repository.
   *
   * The counters come from the events inside the window; everything else comes
   * from the most recent snapshot taken at or before the *end* of the window,
   * so asking about a past period renders the repository as it was then rather
   * than as it is now.
   *
   * An excluded account's commits, pull requests and reviews are dropped before
   * the counters are built, and its coding time with them, so a repository
   * whose busiest committer is a build service reports what its people did
   * there. Its contributor count in particular is a count of people, and a bot
   * inflating it is the reading somebody would act on. Its builds, releases and
   * tags stay — those are the repository's, whoever triggered them — carrying
   * nobody's credit.
   */
  async run(input: { from: Date; to: Date }): Promise<RepositorySummary[]> {
    const window = { from: toDay(input.from), to: toDay(input.to) };

    const [tracked, collected, snapshots, wakaTimeRows, people] = await Promise.all([
      this.store.listTrackedRepositories(),
      this.store.listEvents({ from: input.from, to: input.to }),
      this.store.listLatestSnapshots({ day: window.to }),
      this.store.listContributorMetrics<WakaTimeMetrics>({
        source: "wakatime",
        ...window,
      }),
      loadPersonDirectory(this.store),
    ]);

    // Both stored measures go through the directory, not just the events. A
    // repository's coding time is the sum of what its people logged against the
    // matching project, so an excluded person's hours reaching it would leave
    // the two tabs disagreeing about the same hours.
    // One query for the whole table, bounded by the distinct owners rather than
    // by the rows: two hundred repositories in an organisation share a handful
    // of teams, and a lookup per row would be two hundred catalog queries per
    // dashboard load.
    const ownerProfiles = await resolveOwnerProfiles(
      this.catalog,
      distinctOwnerRefs(tracked),
    );

    const wakaTimeByProject = aggregateWakaTimeProjects(
      measuredContributorMetrics(wakaTimeRows, people, "wakatime"),
    );
    const eventsByRepository = groupEventsByRepository(measuredEvents(collected, people));
    const snapshotsByRepository = new Map(
      snapshots.map((snapshot) => [snapshot.repositoryId, snapshot.payload]),
    );

    return tracked.map(({ repository }) =>
      buildRepositorySummary(
        repository,
        snapshotsByRepository.get(repository.id) ?? unsnapshotted(repository),
        eventsByRepository.get(repository.id),
        wakaTimeByProject,
        window,
        ownerProfiles,
      ),
    );
  }
}
