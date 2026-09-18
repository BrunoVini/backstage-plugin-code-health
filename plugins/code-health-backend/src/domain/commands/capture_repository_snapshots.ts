import type { LoggerService } from "@backstage/backend-plugin-api";
import type {
  ConfluenceContributorMetrics,
  JiraContributorMetrics,
  Platform,
  SonarMetrics,
} from "@rios0rios0/backstage-plugin-code-health-common";
import { addDays, daysInRange, toDay, type Day } from "../entities/day";
import type { IdentityObserver } from "../services/identity_resolver";
import type { IngestionSettings } from "../entities/ingestion_settings";
import { CircuitOpenError } from "../entities/provider_errors";
import { BudgetExhaustedError } from "../entities/request_budget";
import {
  SNAPSHOT_ALLOWANCE_SETTINGS,
  SNAPSHOT_SOURCE_LABELS,
  SnapshotAllowances,
  type SnapshotSource,
} from "../entities/snapshot_allowances";
import type { TrackedRepository } from "../entities/tracked_repository";
import type {
  CodeHealthStore,
  TrackedRepositoryWithState,
} from "../repositories/code_health_store";
import type { ConfluenceEnricher } from "../services/confluence_enricher";
import type { JiraEnricher } from "../services/jira_enricher";
import type {
  EnrichmentContext,
  SonarEnricher,
  WakaTimeEnricher,
} from "../services/snapshot_enricher";
import type { SnapshotContext, VcsCollector } from "../services/vcs_collector";

export interface SnapshotRunResult {
  readonly captured: number;
  /** Accounts WakaTime reported, whether or not they logged any time. */
  readonly wakaTimeMembers: number;
  readonly failures: number;
  /** Every source's spend added together. */
  readonly requestsSpent: number;
  /** What each source spent of its own allowance; zero for one not in play. */
  readonly requestsBySource: Readonly<Record<SnapshotSource, number>>;
  /** The sources that asked for a request after their allowance was gone. */
  readonly starvedSources: readonly SnapshotSource[];
  /** Whether the repository loop stopped because its own allowance ran out. */
  readonly budgetExhausted: boolean;
  /** Repositories the loop never reached. They go first on the next pass. */
  readonly unvisited: number;
  /** Repositories with a Sonar project the pass could not ask Sonar about. */
  readonly sonarSkipped: number;
  readonly skippedHosts: readonly string[];
}

export interface CaptureRepositorySnapshotsOptions {
  readonly store: CodeHealthStore;
  readonly collectors: ReadonlyMap<Platform, VcsCollector>;
  readonly sonar: SonarEnricher | null;
  readonly wakaTime: WakaTimeEnricher | null;
  /**
   * How much WakaTime history to read, and how many of its most recent days to
   * also pull AI figures for. `aiDays` is zero when the option is off, so the
   * command has one number to obey rather than a flag and a number that can
   * disagree.
   */
  readonly wakaTimeWindow: { readonly historyDays: number; readonly aiDays: number };
  readonly jira: JiraEnricher | null;
  readonly confluence: ConfluenceEnricher | null;
  /**
   * Requests each optional source may spend in one pass, each on an allowance
   * of its own.
   *
   * The repository loop and the Sonar readings taken beside it spend
   * `settings.requestBudgetPerRun`; nothing here draws on that one. A source
   * given more than it needs costs nothing, and a source given less stops on
   * its own and touches nothing else — which is the property one shared budget
   * could not offer.
   *
   * Confluence is two allowances: `confluence` for the contributor sweep, and
   * `confluencePerSpace` for each space the catalog names, pooled over the
   * per-space reports. Their costs scale with different things, and one number
   * sized for the sweep's caps would be spent by the reports on a fleet with
   * enough annotated spaces.
   */
  readonly requestBudgets: {
    readonly wakaTime: number;
    readonly jira: number;
    readonly confluence: number;
    readonly confluencePerSpace: number;
  };
  readonly identities: IdentityObserver;
  readonly settings: IngestionSettings;
  readonly logger: LoggerService;
}

/**
 * How many spaces the catalog names, however the annotations spell them.
 *
 * An upper bound on what the Confluence space sweep will measure — an
 * allow-list may drop some — which is the right side to size an allowance
 * from.
 */
const countAnnotatedSpaces = (repositories: readonly TrackedRepository[]): number =>
  new Set(
    repositories.flatMap((repository) => {
      const key = repository.catalogFacts.confluenceSpaceKey;
      return key === null ? [] : [key.toLowerCase()];
    }),
  ).size;

/**
 * Captures each repository's current state once a day.
 *
 * Everything here is a fact no provider will report retroactively — compliance
 * checks, README badges, Sonar measures, the branch list. Their history
 * therefore starts at the first snapshot after installation rather than at the
 * retention floor, and the dashboard has to say so rather than draw a flat line
 * back through a year it never observed.
 *
 * The repository loop is the only part of the pass nothing else can record, so
 * the pass is built around it. Every source spends an allowance of its own:
 * the enrichers used to draw on one shared budget before a single repository
 * was captured, and one moderately large Confluence space could leave the loop
 * with nothing — silently, and for the same repositories every night, because
 * the loop walked the tracked set in a fixed order and stopped where the
 * allowance ran out. The loop now takes the repositories the last pass never
 * reached first, and a pass that stops short says how many it left.
 *
 * The loop runs before the contributor sweeps for the same reason. The
 * allowances bound the requests, not the minutes, and the task's timeout is
 * shared: a Confluence sweep that walks five hundred version histories should
 * time out having stored the day's snapshots rather than before the first one.
 * Only the per-repository figures Jira and Confluence contribute go ahead of
 * the loop, because they ride on the snapshot row itself — and the Confluence
 * ones spend an allowance sized per annotated space, so what sits ahead of
 * the loop is bounded by the annotation count rather than by the sweep's caps.
 *
 * The pass shares one project cache across repositories, which is what turns
 * Azure DevOps branch policies from a per-repository download into a
 * per-project one.
 */
export class CaptureRepositorySnapshots {
  constructor(private readonly options: CaptureRepositorySnapshotsOptions) {}

  async run(input: { now: Date; signal?: AbortSignal }): Promise<SnapshotRunResult> {
    const { store, settings, logger, sonar, wakaTime, jira, confluence } = this.options;

    const tracked = await this.staleFirst(await store.listTrackedRepositories());
    const repositories = tracked.map((entry) => entry.repository);
    const annotatedSpaces = confluence === null ? 0 : countAnnotatedSpaces(repositories);

    const allowances = new SnapshotAllowances({
      repositories: settings.requestBudgetPerRun,
      // Sonar is asked once per repository the loop reaches, and the loop
      // cannot reach more repositories than it has requests, so the same
      // number bounds both without a setting of its own.
      ...(sonar === null ? {} : { sonar: settings.requestBudgetPerRun }),
      ...(wakaTime === null ? {} : { wakatime: this.options.requestBudgets.wakaTime }),
      ...(jira === null ? {} : { jira: this.options.requestBudgets.jira }),
      ...(confluence === null ? {} : { confluence: this.options.requestBudgets.confluence }),
      // Sized by how many spaces the catalog names, because that is what the
      // reports' cost scales with. With none annotated the sweep asks nothing,
      // so there is nothing to give it or to report on.
      ...(annotatedSpaces === 0
        ? {}
        : { "confluence-spaces": annotatedSpaces * this.options.requestBudgets.confluencePerSpace }),
    });
    const contextFor = (source: SnapshotSource): EnrichmentContext => ({
      budget: allowances.budgetFor(source),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const repositoryContext: SnapshotContext = {
      ...contextFor("repositories"),
      projectCache: new Map<string, unknown>(),
    };
    const sonarContext = contextFor("sonar");
    const jiraContext = contextFor("jira");
    const confluenceContext = contextFor("confluence");

    const day = toDay(input.now);
    const skippedHosts = new Set<string>();
    let captured = 0;
    let failures = 0;
    let sonarSkipped = 0;
    let budgetExhausted = false;

    // Both per-repository sweeps run once for the whole pass: a project or a
    // space is named by several repositories, and asking per repository would
    // multiply one answer by the repository count.
    const jiraByRepository = await this.repositoryMetrics("Jira", () =>
      jira?.fetchRepositories(repositories, jiraContext),
    );
    const confluenceByRepository = await this.repositoryMetrics("Confluence", () =>
      confluence?.fetchRepositories(repositories, contextFor("confluence-spaces")),
    );

    let visited = 0;
    for (const entry of tracked) {
      if (input.signal?.aborted) break;
      if (repositoryContext.budget.isExhausted) {
        budgetExhausted = true;
        break;
      }
      visited += 1;
      if (skippedHosts.has(entry.repository.host)) continue;

      const collector = this.options.collectors.get(entry.repository.platform);
      if (!collector) {
        logger.warn(`no collector is registered for ${entry.repository.platform}`);
        failures += 1;
        continue;
      }

      try {
        const snapshot = await collector.snapshot(entry.repository, repositoryContext);
        const sonarReading = await this.sonarFor(entry.repository, sonarContext);
        if (sonarReading.skipped) sonarSkipped += 1;

        await store.saveSnapshot({
          repositoryId: entry.repository.id,
          day,
          capturedAt: input.now,
          payload: {
            ...snapshot.payload,
            sonarMetrics: sonarReading.metrics,
            jiraMetrics: jiraByRepository.get(entry.repository.id) ?? null,
            confluenceMetrics: confluenceByRepository.get(entry.repository.id) ?? null,
          },
        });

        if (snapshot.repositoryFacts) {
          await store.updateRepositoryFacts({
            repositoryId: entry.repository.id,
            ...snapshot.repositoryFacts,
          });
        }

        if (snapshot.events.length > 0) {
          await store.commitIngestion({
            repositoryId: entry.repository.id,
            events: snapshot.events,
            chunk: {
              repositoryId: entry.repository.id,
              // Releases and tags are recorded as they are observed rather than
              // as a fetched range: neither provider can list them by date, so
              // claiming a day was covered for them would be untrue.
              kinds: [],
              days: [],
              ingestedAt: input.now,
            },
            status: entry.state.status,
            now: input.now,
          });
        }

        captured += 1;
      } catch (error) {
        if (error instanceof BudgetExhaustedError) {
          // The repository it ran out on was not captured, so it is one of the
          // ones the next pass takes first.
          visited -= 1;
          budgetExhausted = true;
          break;
        }
        if (error instanceof CircuitOpenError) {
          skippedHosts.add(entry.repository.host);
          logger.warn(`skipping the rest of ${entry.repository.host}; it is in cooldown`);
          continue;
        }
        failures += 1;
        logger.warn(`snapshot failed for ${entry.repository.entityRef}: ${String(error)}`);
      }
    }
    const unvisited = tracked.length - visited;

    const wakaTimeMembers = await this.harvestWakaTime(day, contextFor("wakatime"), input.now);
    // The Jira scan was paid for by the per-repository sweep above and is
    // cached for the run, so this slices it rather than asking again.
    await this.harvestJira(day, jiraContext, input.now);
    await this.harvestConfluence(day, confluenceContext, input.now);

    logger.info(
      `snapshot pass finished: captured ${captured} of ${tracked.length} repositories, ` +
        `${failures} failures, ${wakaTimeMembers} WakaTime members; ` +
        `requests spent: ${allowances.describe()}`,
    );
    if (unvisited > 0) {
      const why = budgetExhausted
        ? `the repository allowance of ${repositoryContext.budget.limit} requests ran out; ` +
          `raise ${SNAPSHOT_ALLOWANCE_SETTINGS.repositories} to reach more in one pass`
        : "the run was stopped before it reached them";
      logger.warn(
        `snapshot pass left ${unvisited} of ${tracked.length} repositories unvisited: ${why}. ` +
          "They go first on the next pass",
      );
    }
    if (sonarSkipped > 0) {
      logger.warn(
        `Sonar was not asked about ${sonarSkipped} repositories: its allowance of ` +
          `${sonarContext.budget.limit} requests ran out, so their snapshots carry no ` +
          "Sonar measures for today",
      );
    }
    for (const source of allowances.starved) {
      // The two above are said in terms of what they cost, which is the useful
      // way to say it; the enrichers stop on their own and keep what they had.
      if (source === "repositories" || source === "sonar") continue;
      const sizing =
        source === "confluence-spaces"
          ? ` (${this.options.requestBudgets.confluencePerSpace} for each of ` +
            `${annotatedSpaces} annotated spaces)`
          : "";
      logger.warn(
        `${SNAPSHOT_SOURCE_LABELS[source]} spent its whole allowance of ` +
          `${allowances.budgetFor(source).limit} requests${sizing} and stopped early; ` +
          `raise ${SNAPSHOT_ALLOWANCE_SETTINGS[source]} to measure more`,
      );
    }

    return {
      captured,
      wakaTimeMembers,
      failures,
      requestsSpent: allowances.total,
      requestsBySource: allowances.spent,
      starvedSources: allowances.starved,
      budgetExhausted,
      unvisited,
      sonarSkipped,
      skippedHosts: [...skippedHosts],
    };
  }

  /**
   * Never captured first, then the oldest capture first, ties in the store's
   * own order.
   *
   * A pass that stops short leaves its tail without a snapshot for the day,
   * which is exactly what puts that tail at the front of the next pass — the
   * same staleness-first rule the ingestion actor follows, and it needs no
   * cursor of its own. A fixed order stopped at the same place every night,
   * and the repositories past it never recovered on their own.
   */
  private async staleFirst(
    tracked: TrackedRepositoryWithState[],
  ): Promise<TrackedRepositoryWithState[]> {
    const latest = await this.options.store.listLatestSnapshotDays();
    const dayOf = (entry: TrackedRepositoryWithState): string =>
      latest.get(entry.repository.id) ?? "";
    return [...tracked].sort((left, right) => dayOf(left).localeCompare(dayOf(right)));
  }

  /**
   * One repository's Sonar measures, or none once the Sonar allowance is gone.
   *
   * Sonar is read beside the provider snapshot rather than instead of it, so a
   * spent Sonar allowance costs the day's Sonar measures for the rest of the
   * loop and nothing else — the snapshot itself is still stored. `skipped`
   * says when that happened, because a null on a repository that has a Sonar
   * project reads as "no project" everywhere else and somebody has to say
   * otherwise.
   */
  private async sonarFor(
    repository: TrackedRepository,
    context: EnrichmentContext,
  ): Promise<{ readonly metrics: SonarMetrics | null; readonly skipped: boolean }> {
    const { sonar } = this.options;
    if (sonar === null) return { metrics: null, skipped: false };

    if (context.budget.isExhausted) {
      // The enricher asks nothing for a repository with no project, so only
      // one with a project has been skipped.
      return { metrics: null, skipped: repository.sonarProjectKey !== null };
    }

    try {
      return { metrics: await sonar.fetch(repository, context), skipped: false };
    } catch (error) {
      if (error instanceof BudgetExhaustedError) return { metrics: null, skipped: true };
      throw error;
    }
  }

  /**
   * Collects WakaTime for the whole configured history in one pass.
   *
   * The window is re-read in full on every run rather than only for the days
   * not yet stored, because it costs the same: the summaries resource answers
   * for an arbitrary span in a single request per member, so asking for thirty
   * days is one request and asking for one day is also one request. Re-reading
   * also repairs a day that was collected while somebody's editor was offline
   * and has since synchronised.
   *
   * The AI figures are the opposite shape — the durations resource takes a
   * single date — so only the most recent few days are asked for each run. That
   * means AI history accumulates forwards from the day the option was switched
   * on rather than being backfilled, which is stated in the documentation
   * because a chart that starts in the middle otherwise looks like a bug.
   */
  private async harvestWakaTime(
    today: Day,
    context: EnrichmentContext,
    now: Date,
  ): Promise<number> {
    const { store, logger, wakaTime, wakaTimeWindow, identities } = this.options;
    if (wakaTime === null) return 0;

    const from = addDays(today, -(wakaTimeWindow.historyDays - 1));
    const aiDays =
      wakaTimeWindow.aiDays > 0
        ? daysInRange(addDays(today, -(wakaTimeWindow.aiDays - 1)), today)
        : [];

    const harvest = await wakaTime
      .fetchWindow({ from, to: today, aiDays, context })
      .catch((error: unknown) => {
        logger.warn(`WakaTime enrichment failed: ${String(error)}`);
        return null;
      });

    if (harvest === null) return 0;

    // Recorded before the measures, and whether or not anything was logged: an
    // account that coded nothing all month is still an account somebody may
    // need to link, and the Identities screen is where they would look for it.
    await identities.observe(harvest.identities, now);

    for (const [day, metrics] of harvest.byDay) {
      if (metrics.size === 0) continue;
      await store.saveContributorMetrics({
        source: "wakatime",
        day,
        capturedAt: now,
        metrics,
      });
    }

    return harvest.identities.length;
  }

  /**
   * Per-repository measures from one optional enricher.
   *
   * A failing integration costs its own numbers and nothing else. The snapshot
   * is the only pass that can record the day's compliance and quality state at
   * all, so losing it to somebody's expired Atlassian token would be a far
   * larger hole than the one it was trying to fill.
   */
  private async repositoryMetrics<T>(
    label: string,
    fetch: () => Promise<ReadonlyMap<string, T>> | undefined,
  ): Promise<ReadonlyMap<string, T>> {
    const result = fetch();
    if (result === undefined) return new Map<string, T>();

    return result.catch((error: unknown) => {
      this.options.logger.warn(`${label} repository enrichment failed: ${String(error)}`);
      return new Map<string, T>();
    });
  }

  /**
   * Jira, stored a day at a time.
   *
   * The per-day slice costs nothing extra — the enricher fetches the window's
   * issues once and slices them arithmetically — and it is the difference
   * between a range picker that can answer for last March and one that shows a
   * trailing window relabelled with March's dates. Days with no activity are
   * absent rather than empty, so "nobody did anything" stays distinguishable
   * from "not collected".
   */
  private async harvestJira(
    today: Day,
    context: EnrichmentContext,
    now: Date,
  ): Promise<void> {
    const { store, logger, jira } = this.options;
    if (jira === null) return;

    const byDay = await jira.fetchContributorsByDay(context).catch((error: unknown) => {
      logger.warn(`Jira enrichment failed: ${String(error)}`);
      return new Map<Day, ReadonlyMap<string, JiraContributorMetrics>>();
    });

    for (const [day, metrics] of byDay) {
      if (metrics.size === 0) continue;
      await store.saveContributorMetrics({
        source: "jira",
        day,
        capturedAt: now,
        metrics,
      });
    }

    if (byDay.size === 0) {
      logger.debug(`no Jira activity to record for the window ending ${today}`);
    }
  }

  /**
   * Confluence, stored as one row for the whole window.
   *
   * Unlike Jira, the sweep cannot be sliced per day for free: measuring written
   * volume walks a page's version bodies, and doing that per day would multiply
   * the walks by the length of the window. The figures therefore describe a
   * trailing window rather than the range the picker is showing, which the
   * columns and the card say out loud rather than leaving a reader to assume.
   */
  private async harvestConfluence(
    day: Day,
    context: EnrichmentContext,
    now: Date,
  ): Promise<void> {
    const { store, logger, confluence } = this.options;
    if (confluence === null) return;

    const metrics = await confluence.fetchContributors(context).catch((error: unknown) => {
      logger.warn(`Confluence enrichment failed: ${String(error)}`);
      return new Map<string, ConfluenceContributorMetrics>();
    });

    if (metrics.size === 0) return;
    await store.saveContributorMetrics({
      source: "confluence",
      day,
      capturedAt: now,
      metrics,
    });
  }
}
