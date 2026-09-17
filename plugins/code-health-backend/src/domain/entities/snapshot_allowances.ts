import { RequestBudget } from "./request_budget";

/** Everything a snapshot pass spends provider requests on. */
export type SnapshotSource = "repositories" | "sonar" | "wakatime" | "jira" | "confluence";

export const SNAPSHOT_SOURCES: readonly SnapshotSource[] = [
  "repositories",
  "sonar",
  "wakatime",
  "jira",
  "confluence",
];

/** How each source is named in a log line. */
export const SNAPSHOT_SOURCE_LABELS: Readonly<Record<SnapshotSource, string>> = {
  repositories: "The repository loop",
  sonar: "Sonar",
  wakatime: "WakaTime",
  jira: "Jira",
  confluence: "Confluence",
};

/**
 * The setting that sizes each source's allowance, so a warning about a source
 * running out can say where to raise it rather than leaving the operator to
 * find the key.
 *
 * Sonar has no setting of its own: it is asked once per repository the loop
 * reaches, and the loop cannot reach more repositories than it has requests,
 * so the repository allowance bounds both.
 */
export const SNAPSHOT_ALLOWANCE_SETTINGS: Readonly<Record<SnapshotSource, string>> = {
  repositories: "codeHealth.ingestion.requestBudgetPerRun",
  sonar: "codeHealth.ingestion.requestBudgetPerRun",
  wakatime: "codeHealth.wakaTime.requestBudgetPerRun",
  jira: "codeHealth.atlassian.jira.requestBudgetPerRun",
  confluence: "codeHealth.atlassian.confluence.requestBudgetPerRun",
};

/**
 * One request allowance per source, for one snapshot pass.
 *
 * The pass used to hand every source one budget, and the enrichers drew from
 * it before a single repository was captured. Their own ceilings — five hundred
 * Confluence version histories, a thousand Jira issues per project — could
 * each exceed the whole allowance on their own, so one moderately large space
 * left the repository loop, which is the only part of the pass nothing else
 * can record, with nothing at all. Worse, it did so silently and deterministically:
 * the same tail of repositories was skipped on every run, and annotating one
 * component with a large space changed what was captured for every other one.
 *
 * Separate allowances are the fix. A source that spends everything it was
 * given stops on its own and touches nothing else; what each one spent is
 * reported by name, so an operator reading the completion line can see where
 * the requests went rather than inferring it from a total.
 *
 * A source the pass was not given is still answered with a budget, of nothing,
 * so a caller can build every context up front; it is left out of the summary
 * because a zero for an integration nobody configured says nothing.
 */
export class SnapshotAllowances {
  private readonly budgets: ReadonlyMap<SnapshotSource, RequestBudget>;
  private readonly inPlay: readonly SnapshotSource[];

  constructor(limits: Partial<Readonly<Record<SnapshotSource, number>>>) {
    this.inPlay = SNAPSHOT_SOURCES.filter((source) => limits[source] !== undefined);
    this.budgets = new Map(
      SNAPSHOT_SOURCES.map((source) => [source, new RequestBudget(limits[source] ?? 0)]),
    );
  }

  budgetFor(source: SnapshotSource): RequestBudget {
    // Every source has an entry, so the lookup cannot miss.
    return this.budgets.get(source) as RequestBudget;
  }

  /** The sources this pass was given an allowance for, in reporting order. */
  get sources(): readonly SnapshotSource[] {
    return this.inPlay;
  }

  /** What each source spent, zero for the ones not in play. */
  get spent(): Readonly<Record<SnapshotSource, number>> {
    return Object.fromEntries(
      SNAPSHOT_SOURCES.map((source) => [source, this.budgetFor(source).spent]),
    ) as Record<SnapshotSource, number>;
  }

  /** Every source's spend added together. */
  get total(): number {
    return this.inPlay.reduce((sum, source) => sum + this.budgetFor(source).spent, 0);
  }

  /**
   * The sources that asked for a request after their allowance was gone.
   *
   * Refused rather than exhausted: a source that spent its allowance to the
   * unit and wanted nothing more finished, and telling an operator to raise a
   * setting that was exactly enough would send them after a problem that is
   * not there.
   */
  get starved(): readonly SnapshotSource[] {
    return this.inPlay.filter((source) => this.budgetFor(source).refused > 0);
  }

  /** `repositories=310 sonar=150 jira=62`, for the completion line. */
  describe(): string {
    return this.inPlay
      .map((source) => `${source}=${this.budgetFor(source).spent}`)
      .join(" ");
  }
}
