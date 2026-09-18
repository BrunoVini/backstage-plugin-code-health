import type {
  ConfluenceContributorMetrics,
  ConfluenceSpaceMetrics,
  JiraContributorMetrics,
  JiraRepositoryMetrics,
  Platform,
  SonarMetrics,
  WakaTimeMetrics,
} from "@rios0rios0/backstage-plugin-code-health-common";
import { CaptureRepositorySnapshots } from "../../../src/domain/commands/capture_repository_snapshots";
import {
  DEFAULT_DISCOVERY_SCHEDULE,
  DEFAULT_INGESTION_SCHEDULE,
  DEFAULT_SNAPSHOT_SCHEDULE,
  type IngestionSettings,
} from "../../../src/domain/entities/ingestion_settings";
import type { Day } from "../../../src/domain/entities/day";
import { CircuitOpenError } from "../../../src/domain/entities/provider_errors";
import type { TrackedRepository } from "../../../src/domain/entities/tracked_repository";
import type {
  EnrichmentContext,
  SonarEnricher,
  WakaTimeEnricher,
  WakaTimeHarvest,
} from "../../../src/domain/services/snapshot_enricher";
import type { ConfluenceEnricher } from "../../../src/domain/services/confluence_enricher";
import type { ObservedIdentity } from "../../../src/domain/services/identity_resolver";
import type { JiraEnricher } from "../../../src/domain/services/jira_enricher";
import type { VcsCollector } from "../../../src/domain/services/vcs_collector";
import { DiscoveredRepositoryBuilder } from "../../builders/discovered_repository_builder";
import { WakaTimeMetricsBuilder } from "../../builders/wakatime_metrics_builder";
import { InMemoryCodeHealthStore } from "../../doubles/in_memory_code_health_store";
import { RecordingIdentityObserver } from "../../doubles/recording_identity_observer";
import { RecordingLogger } from "../../doubles/recording_logger";
import { StubVcsCollector } from "../../doubles/stub_vcs_collector";

const NOW = new Date("2026-08-10T03:00:00.000Z");

const settings = (overrides: Partial<IngestionSettings> = {}): IngestionSettings => ({
  entityFilters: [{ kind: "Component" }],
  retentionDays: 365,
  backfillChunkDays: 1,
  requestBudgetPerRun: 500,
  concurrencyPerHost: 4,
  schedule: DEFAULT_INGESTION_SCHEDULE,
  discoverySchedule: DEFAULT_DISCOVERY_SCHEDULE,
  snapshotSchedule: DEFAULT_SNAPSHOT_SCHEDULE,
  ...overrides,
});

class StubSonarEnricher implements SonarEnricher {
  private requestsPerFetch = 0;

  constructor(private readonly metrics: SonarMetrics | null) {}

  readonly calls: string[] = [];

  /** Spends this many requests per repository, the way the real one spends one. */
  withRequestCost(requests: number): StubSonarEnricher {
    this.requestsPerFetch = requests;
    return this;
  }

  async fetch(
    repository: TrackedRepository,
    context: EnrichmentContext,
  ): Promise<SonarMetrics | null> {
    this.calls.push(repository.entityRef);
    for (let index = 0; index < this.requestsPerFetch; index += 1) context.budget.consume();
    return this.metrics;
  }
}

/**
 * Spends what it is told on every call and keeps what it was refused, the way
 * the real enrichers stop where the allowance ends and keep what they had.
 */
const spend = (context: EnrichmentContext, requests: number): void => {
  for (let index = 0; index < requests; index += 1) {
    if (!context.budget.tryConsume()) return;
  }
};

class StubJiraEnricher implements JiraEnricher {
  constructor(private readonly requestsPerCall: number) {}

  async fetchContributors(
    context: EnrichmentContext,
  ): Promise<ReadonlyMap<string, JiraContributorMetrics>> {
    spend(context, this.requestsPerCall);
    return new Map();
  }

  async fetchContributorsByDay(
    context: EnrichmentContext,
  ): Promise<ReadonlyMap<Day, ReadonlyMap<string, JiraContributorMetrics>>> {
    spend(context, this.requestsPerCall);
    return new Map();
  }

  async fetchRepositories(
    _repositories: readonly TrackedRepository[],
    context: EnrichmentContext,
  ): Promise<ReadonlyMap<string, JiraRepositoryMetrics>> {
    spend(context, this.requestsPerCall);
    return new Map();
  }
}

class StubConfluenceEnricher implements ConfluenceEnricher {
  /** What the contributor sweep saw when it ran, for a test about ordering. */
  sweptAfter: (() => void) | null = null;

  constructor(private readonly requestsPerCall: number) {}

  async fetchContributors(
    context: EnrichmentContext,
  ): Promise<ReadonlyMap<string, ConfluenceContributorMetrics>> {
    this.sweptAfter?.();
    spend(context, this.requestsPerCall);
    return new Map();
  }

  async fetchRepositories(
    _repositories: readonly TrackedRepository[],
    context: EnrichmentContext,
  ): Promise<ReadonlyMap<string, ConfluenceSpaceMetrics>> {
    spend(context, this.requestsPerCall);
    return new Map();
  }
}

class StubWakaTimeEnricher implements WakaTimeEnricher {
  private failure: Error | null = null;

  callCount = 0;
  /** The window the command asked for, so a test can assert on the span. */
  lastRequest: { from: Day; to: Day; aiDays: readonly Day[] } | null = null;

  constructor(
    private readonly byDay: ReadonlyMap<Day, ReadonlyMap<string, WakaTimeMetrics>> = new Map(),
    private readonly identities: readonly ObservedIdentity[] = [],
  ) {}

  withFailure(failure: Error): StubWakaTimeEnricher {
    this.failure = failure;
    return this;
  }

  async fetchWindow(input: {
    from: Day;
    to: Day;
    aiDays: readonly Day[];
    context: EnrichmentContext;
  }): Promise<WakaTimeHarvest> {
    this.callCount += 1;
    this.lastRequest = { from: input.from, to: input.to, aiDays: input.aiDays };
    if (this.failure) throw this.failure;
    return { identities: this.identities, byDay: this.byDay };
  }
}

const REQUEST_BUDGETS = { wakaTime: 500, jira: 500, confluence: 500, confluencePerSpace: 40 };

const createCommand = async (options: {
  repositories?: number;
  /** Given to every repository, so the Sonar enricher is asked about each. */
  sonarProjectKey?: string;
  /** Confluence space keys, handed out to the repositories in turn. */
  confluenceSpaceKeys?: readonly string[];
  collector?: StubVcsCollector;
  sonar?: SonarEnricher | null;
  wakaTime?: WakaTimeEnricher | null;
  wakaTimeWindow?: { historyDays: number; aiDays: number };
  jira?: JiraEnricher | null;
  confluence?: ConfluenceEnricher | null;
  requestBudgets?: Partial<typeof REQUEST_BUDGETS>;
  overrides?: Partial<IngestionSettings>;
}) => {
  const store = new InMemoryCodeHealthStore();
  const logger = new RecordingLogger();
  const collector = options.collector ?? new StubVcsCollector();

  await store.syncRepositories({
    discovered: Array.from({ length: options.repositories ?? 1 }, (_unused, index) => {
      const spaces = options.confluenceSpaceKeys ?? [];
      const spaceKey = spaces.length === 0 ? null : (spaces[index % spaces.length] ?? null);
      const builder = DiscoveredRepositoryBuilder.create()
        .withEntityRef(`component:default/repo-${index}`)
        .withCatalogFacts({ confluenceSpaceKey: spaceKey });
      return options.sonarProjectKey === undefined
        ? builder.build()
        : builder.withSonarProjectKey(options.sonarProjectKey).build();
    }),
    retentionDays: 365,
    now: NOW,
  });

  const collectors: ReadonlyMap<Platform, VcsCollector> = new Map([["github", collector]]);
  const identities = new RecordingIdentityObserver();
  const command = new CaptureRepositorySnapshots({
    store,
    collectors,
    sonar: options.sonar ?? null,
    wakaTime: options.wakaTime ?? null,
    wakaTimeWindow: options.wakaTimeWindow ?? { historyDays: 30, aiDays: 0 },
    jira: options.jira ?? null,
    confluence: options.confluence ?? null,
    requestBudgets: { ...REQUEST_BUDGETS, ...options.requestBudgets },
    identities,
    settings: settings(options.overrides),
    logger,
  });

  return { command, store, collector, logger, identities };
};

describe("CaptureRepositorySnapshots", () => {
  it("should store a snapshot for each repository under today's date", async () => {
    // given
    const { command, store } = await createCommand({ repositories: 2 });

    // when
    const result = await command.run({ now: NOW });

    // then
    expect(result.captured).toBe(2);
    const snapshots = await store.listLatestSnapshots({ day: "2026-08-10" });
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].day).toBe("2026-08-10");
  });

  it("should carry the provider payload into the stored snapshot", async () => {
    // given
    const collector = new StubVcsCollector().withSnapshot({
      primaryLanguage: "Go",
      defaultBranch: "trunk",
      branches: ["trunk", "release"],
    });
    const { command, store } = await createCommand({ collector });

    // when
    await command.run({ now: NOW });

    // then
    const [snapshot] = await store.listLatestSnapshots({ day: "2026-08-10" });
    expect(snapshot.payload).toMatchObject({
      primaryLanguage: "Go",
      defaultBranch: "trunk",
      branches: ["trunk", "release"],
    });
  });

  it("should share one project cache across the whole pass", async () => {
    // given
    // Azure DevOps branch policies are configured per project. Fetching them
    // once per repository — which is what the previous design did — meant forty
    // repositories in a project downloaded one identical payload forty times.
    const collector = new StubVcsCollector();
    const { command } = await createCommand({ repositories: 3, collector });

    // when
    await command.run({ now: NOW });

    // then
    expect(collector.snapshots).toHaveLength(3);
  });

  it("should attach Sonar measures when the enricher supplies them", async () => {
    // given
    const metrics: SonarMetrics = {
      bugs: 1,
      codeSmells: 2,
      securityHotspots: 3,
      vulnerabilities: 4,
      coverage: 87.5,
      duplications: 1.2,
      technicalDebt: "3h",
      technicalDebtMinutes: 180,
      qualityGateStatus: "OK",
    };
    const sonar = new StubSonarEnricher(metrics);
    const { command, store } = await createCommand({ sonar });

    // when
    await command.run({ now: NOW });

    // then
    const [snapshot] = await store.listLatestSnapshots({ day: "2026-08-10" });
    expect(snapshot.payload.sonarMetrics).toEqual(metrics);
  });

  it("should leave Sonar measures unset when no enricher is configured", async () => {
    // given
    const { command, store } = await createCommand({ sonar: null });

    // when
    await command.run({ now: NOW });

    // then
    const [snapshot] = await store.listLatestSnapshots({ day: "2026-08-10" });
    expect(snapshot.payload.sonarMetrics).toBeNull();
  });

  it("should fetch WakaTime once for the whole pass rather than per repository", async () => {
    // given
    // WakaTime reports per member for the organisation, so asking per
    // repository would multiply one answer by the repository count.
    const monday = WakaTimeMetricsBuilder.aDay("2026-08-10").withSeconds(3600).build();
    const wakaTime = new StubWakaTimeEnricher(
      new Map([["2026-08-10", new Map([["dev@example.com", monday]])]]),
    );
    const { command, store } = await createCommand({ repositories: 4, wakaTime });

    // when
    await command.run({ now: NOW });

    // then
    expect(wakaTime.callCount).toBe(1);
    const rows = await store.listContributorMetrics<WakaTimeMetrics>({
      source: "wakatime",
      from: "2026-08-10",
      to: "2026-08-10",
    });
    expect(rows).toEqual([
      { day: "2026-08-10", contributorKey: "dev@example.com", payload: monday },
    ]);
  });

  it("should ask for the whole configured history, not only today", async () => {
    // given
    // The summaries resource answers for an arbitrary span in one request per
    // member, so asking for a month costs exactly what asking for a day costs.
    const wakaTime = new StubWakaTimeEnricher();
    const { command } = await createCommand({
      wakaTime,
      wakaTimeWindow: { historyDays: 7, aiDays: 0 },
    });

    // when
    await command.run({ now: NOW });

    // then
    expect(wakaTime.lastRequest).toEqual({
      from: "2026-08-04",
      to: "2026-08-10",
      aiDays: [],
    });
  });

  it("should ask for AI figures only on the most recent days", async () => {
    // given
    // The durations resource takes a single date, so a month of AI history
    // would cost thirty times what the coding time costs.
    const wakaTime = new StubWakaTimeEnricher();
    const { command } = await createCommand({
      wakaTime,
      wakaTimeWindow: { historyDays: 30, aiDays: 2 },
    });

    // when
    await command.run({ now: NOW });

    // then
    expect(wakaTime.lastRequest?.aiDays).toEqual(["2026-08-09", "2026-08-10"]);
  });

  it("should record the accounts WakaTime reported even when they logged nothing", async () => {
    // given
    // An account that coded nothing all month is still an account somebody may
    // need to link, and the Identities screen is where they would look for it.
    const wakaTime = new StubWakaTimeEnricher(new Map(), [
      {
        source: "wakatime",
        sourceKey: "quiet",
        displayName: "Quiet Dev",
        email: null,
        avatarUrl: null,
        profileUrl: null,
      },
    ]);
    const { command, identities } = await createCommand({ wakaTime });

    // when
    await command.run({ now: NOW });

    // then
    expect(identities.keys()).toEqual(["wakatime:quiet"]);
  });

  it("should carry on when WakaTime is unreachable", async () => {
    // given
    // A time-tracking outage must not cost the day's compliance and quality
    // snapshot, which is the part the dashboard cannot reconstruct later.
    const wakaTime = new StubWakaTimeEnricher().withFailure(new Error("wakatime down"));
    const { command, logger } = await createCommand({ wakaTime });

    // when
    const result = await command.run({ now: NOW });

    // then
    expect(result.captured).toBe(1);
    expect(logger.at("warn").join(" ")).toContain("WakaTime enrichment failed");
  });

  it("should record the facts the snapshot learnt about the repository", async () => {
    // given
    const collector = new StubVcsCollector().withFacts({
      defaultBranch: "trunk",
      externalId: "guid-9",
      archived: true,
    });
    const { command, store } = await createCommand({ collector });

    // when
    await command.run({ now: NOW });

    // then
    const [tracked] = await store.listTrackedRepositories();
    expect(tracked.repository).toMatchObject({ defaultBranch: "trunk", archived: true });
  });

  it("should store the dated events a snapshot discovered", async () => {
    // given
    const collector = new StubVcsCollector().withSnapshotEvents([
      {
        repositoryId: "unset",
        kind: "release",
        externalId: "v1.2.0",
        occurredAt: new Date("2026-08-09T10:00:00.000Z"),
        actorKey: null,
        actorName: null,
        actorAvatarUrl: null,
        outcome: null,
        additions: null,
        deletions: null,
        changedFiles: null,
        payload: { tagName: "v1.2.0" },
      },
    ]);
    const { command, store } = await createCommand({ collector });

    // when
    await command.run({ now: NOW });

    // then
    const events = await store.listEvents({
      from: new Date("2026-08-09T00:00:00.000Z"),
      to: new Date("2026-08-10T00:00:00.000Z"),
      kinds: ["release"],
    });
    expect(events).toHaveLength(1);
  });

  it("should not claim a fetched day for the events a snapshot discovered", async () => {
    // given
    // Neither provider can list releases or tags by date, so recording a day as
    // covered for them would state something that was never established.
    const collector = new StubVcsCollector().withSnapshotEvents([
      {
        repositoryId: "unset",
        kind: "release",
        externalId: "v1.2.0",
        occurredAt: new Date("2026-08-09T10:00:00.000Z"),
        actorKey: null,
        actorName: null,
        actorAvatarUrl: null,
        outcome: null,
        additions: null,
        deletions: null,
        changedFiles: null,
        payload: null,
      },
    ]);
    const { command, store } = await createCommand({ collector });

    // when
    await command.run({ now: NOW });

    // then
    const coverage = await store.getCoverage();
    expect(coverage.earliestDay).toBeNull();
  });

  it("should overwrite a snapshot taken twice on the same day", async () => {
    // given
    const collector = new StubVcsCollector().withSnapshot({ primaryLanguage: "Go" });
    const { command, store } = await createCommand({ collector });
    await command.run({ now: NOW });

    // when
    collector.withSnapshot({ primaryLanguage: "Rust" });
    await command.run({ now: new Date("2026-08-10T04:00:00.000Z") });

    // then
    const snapshots = await store.listLatestSnapshots({ day: "2026-08-10" });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].payload.primaryLanguage).toBe("Rust");
  });

  it("should carry on past a repository that failed", async () => {
    // given
    const collector = new StubVcsCollector().withFailureFor(
      "component:default/repo-0",
      new Error("boom"),
    );
    const { command, logger } = await createCommand({ repositories: 3, collector });

    // when
    const result = await command.run({ now: NOW });

    // then
    expect(result.captured).toBe(2);
    expect(result.failures).toBe(1);
    expect(logger.at("warn").join(" ")).toContain("snapshot failed");
  });

  it("should skip the rest of a host in cooldown", async () => {
    // given
    const collector = new StubVcsCollector();
    const { command, store } = await createCommand({ repositories: 3, collector });
    for (const entry of await store.listTrackedRepositories()) {
      collector.withFailureFor(entry.repository.entityRef, new CircuitOpenError("github.com", 0));
    }

    // when
    const result = await command.run({ now: NOW });

    // then
    expect(result.failures).toBe(0);
    expect(result.skippedHosts).toEqual(["github.com"]);
  });

  it("should stop when the allowance runs out", async () => {
    // given
    const collector = new StubVcsCollector().withRequestCost(2);
    const { command } = await createCommand({
      repositories: 5,
      collector,
      overrides: { requestBudgetPerRun: 5 },
    });

    // when
    const result = await command.run({ now: NOW });

    // then
    expect(result.captured).toBeLessThan(5);
    expect(result.budgetExhausted).toBe(true);
  });

  it("should keep every repository's snapshot when an enricher spends its whole allowance", async () => {
    // given
    // The enrichers used to draw on the loop's budget first, so one large
    // Confluence space could leave the repository loop — the only part of the
    // pass nothing else can record — with nothing at all.
    const confluence = new StubConfluenceEnricher(1_000);
    const jira = new StubJiraEnricher(1_000);
    const collector = new StubVcsCollector().withRequestCost(2);
    const { command, logger } = await createCommand({
      repositories: 3,
      collector,
      confluence,
      jira,
      requestBudgets: { confluence: 20, jira: 30 },
      overrides: { requestBudgetPerRun: 6 },
    });

    // when
    const result = await command.run({ now: NOW });

    // then
    expect(result.captured).toBe(3);
    expect(result.unvisited).toBe(0);
    expect(result.requestsBySource).toMatchObject({ repositories: 6, confluence: 20, jira: 30 });
    expect(result.starvedSources).toEqual(["jira", "confluence"]);
    const warnings = logger.at("warn").join("\n");
    expect(warnings).toContain(
      "The Confluence contributor sweep spent its whole allowance of 20 requests",
    );
    expect(warnings).toContain("codeHealth.atlassian.confluence.requestBudgetPerRun");
    expect(warnings).toContain("codeHealth.atlassian.jira.requestBudgetPerRun");
  });

  it("should pay for the Confluence space reports per annotated space, apart from the contributor sweep", async () => {
    // given
    // The reports' cost scales with the annotation count and the contributor
    // sweep's with its page caps. On one allowance, enough annotated spaces
    // spent what the caps were sized for before the sweep began, and every
    // person's figures then under-reported as a measured low.
    const confluence = new StubConfluenceEnricher(1_000);
    const { command, logger } = await createCommand({
      repositories: 4,
      confluenceSpaceKeys: ["ENG", "ops", "OPS"],
      confluence,
      requestBudgets: { confluence: 30, confluencePerSpace: 5 },
    });

    // when
    const result = await command.run({ now: NOW });

    // then
    // Two distinct spaces however the annotations spell them, five each.
    expect(result.requestsBySource).toMatchObject({ "confluence-spaces": 10, confluence: 30 });
    expect(result.starvedSources).toEqual(["confluence", "confluence-spaces"]);
    const warnings = logger.at("warn").join("\n");
    expect(warnings).toContain(
      "The Confluence space sweep spent its whole allowance of 10 requests (5 for each of 2 annotated spaces)",
    );
    expect(warnings).toContain("codeHealth.atlassian.confluence.requestBudgetPerSpace");
  });

  it("should give the Confluence space sweep nothing to report on when nothing names a space", async () => {
    // given
    const confluence = new StubConfluenceEnricher(1);
    const { command, logger } = await createCommand({ repositories: 2, confluence });

    // when
    const result = await command.run({ now: NOW });

    // then
    expect(result.starvedSources).toEqual([]);
    expect(logger.at("info").join(" ")).not.toContain("confluence-spaces");
  });

  it("should say what each source spent, by name", async () => {
    // given
    // A total says the allowance went somewhere; only the breakdown says
    // where, which is what an operator sizing the settings needs.
    const sonar = new StubSonarEnricher(null).withRequestCost(1);
    const jira = new StubJiraEnricher(4);
    const collector = new StubVcsCollector().withRequestCost(2);
    const { command, logger } = await createCommand({
      repositories: 3,
      sonarProjectKey: "acme_service",
      collector,
      sonar,
      jira,
    });

    // when
    const result = await command.run({ now: NOW });

    // then
    // Jira is asked twice — once per repository set, once per day — and the
    // stub spends on both.
    expect(result.requestsBySource).toEqual({
      repositories: 6,
      sonar: 3,
      wakatime: 0,
      jira: 8,
      confluence: 0,
      "confluence-spaces": 0,
    });
    expect(result.requestsSpent).toBe(17);
    expect(logger.at("info").join(" ")).toContain(
      "requests spent: repositories=6 sonar=3 jira=8",
    );
  });

  it("should say how many repositories it left unvisited and where to raise the allowance", async () => {
    // given
    // A boolean folded into a summary line said the pass stopped; nothing
    // said how far short of the fleet it stopped.
    const collector = new StubVcsCollector().withRequestCost(2);
    const { command, logger } = await createCommand({
      repositories: 5,
      collector,
      overrides: { requestBudgetPerRun: 5 },
    });

    // when
    const result = await command.run({ now: NOW });

    // then
    // Two captured in full; the third ran out halfway and was not stored, so
    // it counts among the ones the next pass takes first.
    expect(result.captured).toBe(2);
    expect(result.unvisited).toBe(3);
    expect(result.budgetExhausted).toBe(true);
    const warning = logger.at("warn").join(" ");
    expect(warning).toContain("left 3 of 5 repositories unvisited");
    expect(warning).toContain("codeHealth.ingestion.requestBudgetPerRun");
    expect(warning).toContain("go first on the next pass");
  });

  it("should take the repositories the last pass never reached first", async () => {
    // given
    // A fixed order stopped at the same place every night, and the
    // repositories past it never recovered on their own.
    const collector = new StubVcsCollector().withRequestCost(2);
    const { command } = await createCommand({
      repositories: 4,
      collector,
      overrides: { requestBudgetPerRun: 4 },
    });

    // when
    await command.run({ now: NOW });
    await command.run({ now: new Date("2026-08-11T03:00:00.000Z") });
    await command.run({ now: new Date("2026-08-12T03:00:00.000Z") });

    // then
    expect(collector.snapshots).toEqual([
      "component:default/repo-0",
      "component:default/repo-1",
      "component:default/repo-2",
      "component:default/repo-3",
      "component:default/repo-0",
      "component:default/repo-1",
    ]);
  });

  it("should keep storing snapshots when the Sonar allowance runs out", async () => {
    // given
    // Sonar is read beside the provider snapshot, not instead of it. A spent
    // Sonar allowance costs the rest of the loop its Sonar measures for the
    // day — said out loud, because a null on a repository with a project
    // reads as "no project" everywhere else.
    const metrics: SonarMetrics = {
      bugs: 1,
      codeSmells: 0,
      securityHotspots: 0,
      vulnerabilities: 0,
      coverage: 50,
      duplications: 0,
      technicalDebt: "0min",
      technicalDebtMinutes: 0,
      qualityGateStatus: "OK",
    };
    const sonar = new StubSonarEnricher(metrics).withRequestCost(2);
    const collector = new StubVcsCollector().withRequestCost(1);
    const { command, store, logger } = await createCommand({
      repositories: 3,
      sonarProjectKey: "acme_service",
      collector,
      sonar,
      overrides: { requestBudgetPerRun: 4 },
    });

    // when
    const result = await command.run({ now: NOW });

    // then
    expect(result.captured).toBe(3);
    expect(result.sonarSkipped).toBe(1);
    const snapshots = await store.listLatestSnapshots({ day: "2026-08-10" });
    expect(snapshots.map((snapshot) => snapshot.payload.sonarMetrics)).toEqual([
      metrics,
      metrics,
      null,
    ]);
    expect(logger.at("warn").join(" ")).toContain("Sonar was not asked about 1 repositories");
  });

  it("should store the day's snapshots before the contributor sweeps run", async () => {
    // given
    // The allowances bound the requests, not the minutes, and the task's
    // timeout is shared: a Confluence sweep that walks five hundred version
    // histories should time out having stored the snapshots, not before the
    // first one.
    const confluence = new StubConfluenceEnricher(1);
    const { command, collector } = await createCommand({ repositories: 3, confluence });
    let snapshotsBeforeSweep = -1;
    confluence.sweptAfter = () => {
      snapshotsBeforeSweep = collector.snapshots.length;
    };

    // when
    await command.run({ now: NOW });

    // then
    expect(snapshotsBeforeSweep).toBe(3);
  });

  it("should stop when the scheduled task is aborted", async () => {
    // given
    const controller = new AbortController();
    controller.abort();
    const { command, collector } = await createCommand({ repositories: 3 });

    // when
    const result = await command.run({ now: NOW, signal: controller.signal });

    // then
    expect(collector.snapshots).toEqual([]);
    expect(result.captured).toBe(0);
  });

  it("should report a platform with no registered collector", async () => {
    // given
    const store = new InMemoryCodeHealthStore();
    const logger = new RecordingLogger();
    await store.syncRepositories({
      discovered: [
        DiscoveredRepositoryBuilder.create().asAzureDevOps("example-org", "platform").build(),
      ],
      retentionDays: 365,
      now: NOW,
    });
    const command = new CaptureRepositorySnapshots({
      store,
      collectors: new Map(),
      sonar: null,
      wakaTime: null,
      wakaTimeWindow: { historyDays: 30, aiDays: 0 },
      jira: null,
      confluence: null,
      requestBudgets: REQUEST_BUDGETS,
      identities: new RecordingIdentityObserver(),
      settings: settings(),
      logger,
    });

    // when
    const result = await command.run({ now: NOW });

    // then
    expect(result.failures).toBe(1);
    expect(logger.at("warn").join(" ")).toContain("no collector is registered");
  });
});
