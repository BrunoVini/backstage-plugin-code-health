import type {
  RepositorySummary,
  WakaTimeMetrics,
} from "@rios0rios0/backstage-plugin-code-health-common";
import type { CodeHealthEvent } from "../entities/code_health_event";
import { toDay } from "../entities/day";
import { loadPersonDirectory, measuredEvents } from "../entities/person_directory";
import {
  aggregateWakaTimeProjects,
  buildRepositorySummary,
  unsnapshotted,
} from "../entities/repository_summary_builder";
import type { CodeHealthStore } from "../repositories/code_health_store";

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

export class ListRepositorySummaries {
  constructor(private readonly store: CodeHealthStore) {}

  /**
   * Builds one dashboard row per tracked repository.
   *
   * The counters come from the events inside the window; everything else comes
   * from the most recent snapshot taken at or before the *end* of the window,
   * so asking about a past period renders the repository as it was then rather
   * than as it is now.
   *
   * Events from an excluded account are dropped before the counters are built,
   * so a repository whose busiest committer is a build service reports what its
   * people did there. Its contributor count in particular is a count of people,
   * and a bot inflating it is the reading somebody would act on.
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

    const wakaTimeByProject = aggregateWakaTimeProjects(wakaTimeRows);
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
      ),
    );
  }
}
