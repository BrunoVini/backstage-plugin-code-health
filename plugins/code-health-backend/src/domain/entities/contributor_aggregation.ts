import type {
  ChurnUnit,
  ConfluenceContributorMetrics,
  ContributorIdentity,
  ContributorSummary,
  DirectoryUser,
  JiraContributorMetrics,
  QualityGateStatus,
  SonarMetrics,
  WakaTimeMetrics,
} from "@rios0rios0/backstage-plugin-code-health-common";
import {
  computeRate,
  formatDebt,
  mergeConfluenceContributorMetrics,
  mergeJiraContributorMetrics,
  mergeWakaTimeMetrics,
} from "@rios0rios0/backstage-plugin-code-health-common";
import type { ContributorMetricRow } from "../repositories/code_health_store";
import type { CodeHealthEvent } from "./code_health_event";
import { identityKey, normalizeSourceKey, type IdentityRef } from "./identity";
import type { PersonDirectory } from "./person_directory";

/** Everything one person did in a window, before it is given a name. */
export interface ContributorTotals {
  displayName: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
  /** The accounts merged onto this row, keyed so a repeat does not duplicate. */
  identities: Map<string, ContributorIdentity>;
  commits: number;
  linesAdded: number;
  linesDeleted: number;
  changedFiles: number;
  /**
   * Whether the provider *reported* the field at all, which is not the same
   * question as whether the number came back above zero. A quiet week is a real
   * measurement of zero; a provider that has no line counts is not.
   */
  sawLines: boolean;
  sawFiles: boolean;
  pullRequestsOpened: number;
  pullRequestsMerged: number;
  reviewsGiven: number;
  reviewsApproved: number;
  reviewsRejected: number;
  pipelineRuns: number;
  pipelineRunsSucceeded: number;
  pipelineRunsFailed: number;
  /** Every repository any event put this person in. */
  repositories: Set<string>;
  /**
   * The repositories this person changed the code of — committed to, or had a
   * pull request merged into. A review or a pipeline run is activity in a
   * repository, but it is not authorship of what Sonar measures there.
   */
  codeRepositories: Set<string>;
  wakaTime: WakaTimeMetrics[];
  jira: JiraContributorMetrics[];
  confluence: ConfluenceContributorMetrics[];
}

/**
 * Which unit this contributor's churn was measured in.
 *
 * Lines win when both are present, because a fleet spanning both providers
 * should show the more precise figure where it exists rather than degrading
 * everything to the coarser one.
 */
const churnUnitOf = (totals: ContributorTotals): ChurnUnit => {
  if (totals.sawLines) return "lines";
  return totals.sawFiles ? "files" : "none";
};

const empty = (): ContributorTotals => ({
  displayName: null,
  avatarUrl: null,
  profileUrl: null,
  identities: new Map(),
  commits: 0,
  linesAdded: 0,
  linesDeleted: 0,
  changedFiles: 0,
  sawLines: false,
  sawFiles: false,
  pullRequestsOpened: 0,
  pullRequestsMerged: 0,
  reviewsGiven: 0,
  reviewsApproved: 0,
  reviewsRejected: 0,
  pipelineRuns: 0,
  pipelineRunsSucceeded: 0,
  pipelineRunsFailed: 0,
  repositories: new Set(),
  codeRepositories: new Set(),
  wakaTime: [],
  jira: [],
  confluence: [],
});

const remember = (
  totals: ContributorTotals,
  identity: IdentityRef,
  displayName: string | null,
): void => {
  totals.identities.set(identityKey(identity), {
    source: identity.source,
    sourceKey: identity.sourceKey,
    displayName,
  });
};

const applyEvent = (totals: ContributorTotals, event: CodeHealthEvent): void => {
  totals.repositories.add(event.repositoryId);
  if (event.actorName) totals.displayName = event.actorName;
  if (event.actorAvatarUrl) totals.avatarUrl = event.actorAvatarUrl;

  switch (event.kind) {
    case "commit":
      totals.codeRepositories.add(event.repositoryId);
      totals.commits += 1;
      totals.linesAdded += event.additions ?? 0;
      totals.linesDeleted += event.deletions ?? 0;
      totals.changedFiles += event.changedFiles ?? 0;
      if (event.additions !== null || event.deletions !== null) {
        totals.sawLines = true;
      }
      if (event.changedFiles !== null) totals.sawFiles = true;
      break;
    case "pull_request":
      if (event.outcome === "open") totals.pullRequestsOpened += 1;
      if (event.outcome === "merged") {
        totals.pullRequestsMerged += 1;
        totals.codeRepositories.add(event.repositoryId);
      }
      break;
    case "pr_review":
      totals.reviewsGiven += 1;
      if (event.outcome === "approved" || event.outcome === "approved_with_suggestions") {
        totals.reviewsApproved += 1;
      }
      if (event.outcome === "rejected") totals.reviewsRejected += 1;
      break;
    case "build":
      totals.pipelineRuns += 1;
      if (event.outcome === "succeeded") totals.pipelineRunsSucceeded += 1;
      if (event.outcome === "failed") totals.pipelineRunsFailed += 1;
      break;
    default:
      break;
  }
};

/**
 * Sonar health of the repositories a contributor changed the code of in the
 * window.
 *
 * This is deliberately *not* an attribution: SonarQube measures projects, not
 * people, and nothing here claims the bugs are theirs. It answers "what does the
 * code this person worked on look like", which is the only honest reading of a
 * per-project measure on a per-person row — and it is why two people on the same
 * repository see the same figures.
 *
 * "Worked on" means committed to or merged into, not reviewed or built.
 * Reviewing a repository's pull requests does not put a hand on its code, and
 * a pipeline run says nothing about who wrote what it ran; counting either put
 * every repository's bugs and debt on the row of whoever reviews the most —
 * usually the person who also merges the most — which reads as though they
 * wrote every defect in the fleet.
 *
 * Counts are summed because a person spanning three repositories carries all
 * three. Percentages are averaged rather than summed, since adding coverage
 * figures is meaningless. The quality gate takes the worst value present, so one
 * failing repository is visible rather than being averaged away.
 */
const aggregateSonar = (
  repositoryIds: ReadonlySet<string>,
  byRepository: ReadonlyMap<string, SonarMetrics>,
): SonarMetrics | null => {
  const present = [...repositoryIds]
    .map((id) => byRepository.get(id))
    .filter((metrics): metrics is SonarMetrics => metrics !== undefined);
  if (present.length === 0) return null;

  const sum = (pick: (metrics: SonarMetrics) => number) =>
    present.reduce((total, metrics) => total + pick(metrics), 0);
  const mean = (pick: (metrics: SonarMetrics) => number) =>
    Math.round((sum(pick) / present.length) * 10) / 10;

  // Ordered rather than nested ternaries: `ERROR` must win over `OK`, and `OK`
  // over `NONE`, so one failing repository stays visible on the row.
  const severity: Record<QualityGateStatus, number> = {
    NONE: 0,
    OK: 1,
    ERROR: 2,
  };
  const worst = present.reduce<QualityGateStatus>(
    (highest, metrics) =>
      severity[metrics.qualityGateStatus] > severity[highest]
        ? metrics.qualityGateStatus
        : highest,
    "NONE",
  );

  const debtMinutes = sum((metrics) => metrics.technicalDebtMinutes);

  return {
    bugs: sum((metrics) => metrics.bugs),
    codeSmells: sum((metrics) => metrics.codeSmells),
    securityHotspots: sum((metrics) => metrics.securityHotspots),
    vulnerabilities: sum((metrics) => metrics.vulnerabilities),
    coverage: mean((metrics) => metrics.coverage),
    duplications: mean((metrics) => metrics.duplications),
    technicalDebt: formatDebt(debtMinutes),
    technicalDebtMinutes: debtMinutes,
    qualityGateStatus: worst,
  };
};

/**
 * What to call somebody nothing has a name for.
 *
 * The account key, not the person key: `wakatime:jrios` on a row tells a reader
 * which system to go and look in, whereas a bare entity reference for an
 * unlinked person would be a key nobody typed and nobody recognises.
 */
const fallbackName = (personKey: string, totals: ContributorTotals): string => {
  const first = [...totals.identities.values()][0];
  return first === undefined ? personKey : identityKey(first);
};

/**
 * Folds one person's Confluence accounts together.
 *
 * Null for an empty list rather than a zeroed row, for the same reason as
 * everywhere else here: somebody who does not write in Confluence must not
 * appear as somebody who wrote nothing.
 */
const mergeConfluence = (
  parts: readonly ConfluenceContributorMetrics[],
): ConfluenceContributorMetrics | null =>
  parts.reduce<ConfluenceContributorMetrics | null>(
    (merged, next) =>
      merged === null ? next : mergeConfluenceContributorMetrics(merged, next),
    null,
  );

const mergeIdentities = (
  seen: ReadonlyMap<string, ContributorIdentity>,
  known: readonly ContributorIdentity[],
): ContributorIdentity[] => {
  const merged = new Map(seen);
  for (const identity of known) {
    const key = identityKey(identity);
    const existing = merged.get(key);
    // The identity table's name is the one the source itself reports, so it
    // wins over the name a provider stamped on a commit — which is whatever the
    // committer had in their git config that day.
    if (existing === undefined || existing.displayName === null) merged.set(key, identity);
  }
  return [...merged.values()];
};

/** Everything a window's rows are accumulated from. */
export interface ContributorAggregationInput {
  readonly events: readonly CodeHealthEvent[];
  readonly wakaTime: readonly ContributorMetricRow<WakaTimeMetrics>[];
  readonly jira: readonly ContributorMetricRow<JiraContributorMetrics>[];
  readonly confluence: ReadonlyMap<string, ConfluenceContributorMetrics>;
  readonly people: PersonDirectory;
  /**
   * True on a call scoped to one repository, where enrichment must never invent
   * a row.
   *
   * Coding time, tickets and pages are measured for a person across everything
   * they touched, not per repository — so scoped, they would otherwise add
   * people who have never been near it. Scoped, they only enrich somebody the
   * events already put on the page; the figures themselves stay whole-fleet,
   * which the column help says.
   */
  readonly scoped?: boolean;
}

/**
 * Groups a window's activity by *person*.
 *
 * A row used to be an account: the commit author e-mail on Azure DevOps, the
 * login on GitHub, and one human under two addresses on two rows. That was
 * survivable while commits were the only thing measured. Once coding time
 * arrives under a WakaTime username and tickets under an Atlassian account id,
 * the same human occupies three rows that each hold a third of the story, and
 * no amount of sorting puts them back together.
 *
 * So accounts are resolved through the link table first, and everything is
 * accumulated against the resulting person key. An account nobody has linked
 * groups under itself and still gets a row — hiding it would hide every bot,
 * every service account, and everybody nobody has got round to linking, which
 * are exactly the rows that show the linking still needs doing.
 *
 * A person with coding time and no commits is a real row too, not an empty one:
 * a week spent in an editor without a single commit is worth seeing.
 *
 * An account somebody has excluded is the one thing that gets no row: a build
 * service, a bot, an outside contributor, a leaver. That is decided by the
 * directory rather than here, so the same rule applies to all four sources and
 * reaches every account of a person whose other account was the one excluded.
 *
 * Split from {@link aggregateContributorSummaries} because the catalog lookup
 * that names the rows can only be bounded by who turned up, and that is not
 * known until the accumulation is done.
 */
export const accumulateContributors = (
  input: ContributorAggregationInput,
): Map<string, ContributorTotals> => {
  const byPerson = new Map<string, ContributorTotals>();

  const totalsFor = (identity: IdentityRef): ContributorTotals | undefined => {
    // An excluded account accumulates nothing at all — not a zeroed row, no
    // row. A row of zeros would still be a name on the contributors table, and
    // it would still take part in the fleet reference every relative score is
    // read against, which is most of the reason for excluding anything.
    if (!input.people.isMeasured(identity)) return undefined;

    const key = input.people.keyOf(identity);
    const existing = byPerson.get(key) ?? empty();
    byPerson.set(key, existing);
    return existing;
  };

  const enrichOnly = (identity: IdentityRef): ContributorTotals | undefined => {
    if (!input.scoped) return totalsFor(identity);
    return byPerson.get(input.people.keyOf(identity));
  };

  for (const event of input.events) {
    if (!event.actorKey) continue;
    const identity: IdentityRef = {
      source: "vcs",
      sourceKey: normalizeSourceKey(event.actorKey),
    };
    const totals = totalsFor(identity);
    if (totals === undefined) continue;
    remember(totals, identity, event.actorName);
    applyEvent(totals, event);
  }

  for (const row of input.wakaTime) {
    const identity: IdentityRef = { source: "wakatime", sourceKey: row.contributorKey };
    const totals = enrichOnly(identity);
    if (totals === undefined) continue;
    remember(totals, identity, null);
    totals.wakaTime.push(row.payload);
  }

  for (const row of input.jira) {
    const identity: IdentityRef = { source: "jira", sourceKey: row.contributorKey };
    const totals = enrichOnly(identity);
    if (totals === undefined) continue;
    remember(totals, identity, null);
    totals.jira.push(row.payload);
  }

  for (const [sourceKey, metrics] of input.confluence) {
    const identity: IdentityRef = { source: "confluence", sourceKey };
    const totals = enrichOnly(identity);
    if (totals === undefined) continue;
    remember(totals, identity, null);
    totals.confluence.push(metrics);
  }

  return byPerson;
};

/** What names and grades the accumulated rows. */
export interface ContributorSummaryContext {
  readonly people: PersonDirectory;
  /** Catalog users for the linked keys, from a lookup bounded by who turned up. */
  readonly users: ReadonlyMap<string, DirectoryUser>;
  readonly sonarByRepository: ReadonlyMap<string, SonarMetrics>;
}

/** Turns the accumulated totals into the rows the contributors table shows. */
export const aggregateContributorSummaries = (
  byPerson: ReadonlyMap<string, ContributorTotals>,
  context: ContributorSummaryContext,
): ContributorSummary[] =>
  [...byPerson.entries()]
    .map(([key, totals]) => {
      const profile = context.people.profileOf(key, {
        displayName: totals.displayName,
        avatarUrl: totals.avatarUrl,
        profileUrl: totals.profileUrl,
      });
      const user = context.users.get(key);

      return {
        key,
        // The catalog is the organisation's own record of who somebody is, so
        // it outranks the name and photo a provider stamped on a commit.
        displayName: user?.displayName ?? profile.displayName ?? fallbackName(key, totals),
        avatarUrl: user?.picture ?? profile.avatarUrl,
        profileUrl: profile.profileUrl,
        entityRef: profile.entityRef,
        // Merged from what was actually seen in this window, unioned with what
        // the directory knows, so a row always names at least the account it
        // came from — including one the identity table has not recorded yet.
        identities: mergeIdentities(totals.identities, profile.identities),
        commits: totals.commits,
        linesAdded: totals.linesAdded,
        linesDeleted: totals.linesDeleted,
        // Floored at zero: a window in which someone mostly deleted code is a
        // legitimate contribution, not a negative one.
        linesOfCode: Math.max(0, totals.linesAdded - totals.linesDeleted),
        changedFiles: totals.changedFiles,
        churnUnit: churnUnitOf(totals),
        pullRequestsOpened: totals.pullRequestsOpened,
        pullRequestsMerged: totals.pullRequestsMerged,
        reviewsGiven: totals.reviewsGiven,
        reviewsApproved: totals.reviewsApproved,
        reviewsRejected: totals.reviewsRejected,
        prApprovalRate: computeRate(totals.reviewsApproved, totals.reviewsGiven),
        pipelineRuns: totals.pipelineRuns,
        pipelineRunsSucceeded: totals.pipelineRunsSucceeded,
        pipelineRunsFailed: totals.pipelineRunsFailed,
        // Over the runs that reached a verdict. A run cancelled because a newer
        // push superseded it, or skipped by a path filter, is neither a success
        // nor a failure, and counting it against somebody turns a busy
        // afternoon into a bad success rate.
        pipelineSuccessRate: computeRate(
          totals.pipelineRunsSucceeded,
          totals.pipelineRunsSucceeded + totals.pipelineRunsFailed,
        ),
        repositories: totals.repositories.size,
        sonarMetrics: aggregateSonar(totals.codeRepositories, context.sonarByRepository),
        wakaTimeMetrics: mergeWakaTimeMetrics(totals.wakaTime),
        jiraMetrics: mergeJiraContributorMetrics(totals.jira),
        confluenceMetrics: mergeConfluence(totals.confluence),
      };
    })
    .sort((left, right) => right.commits - left.commits);

/**
 * A row for somebody who did nothing at all in a period.
 *
 * A bucket a person was absent from still gets a point, so a chart shows the
 * quiet fortnight as a trough rather than closing over it. `identity` carries
 * whatever the whole window already knows about them — their name, their photo,
 * their catalog user — because a point labelled with a bare person key in the
 * middle of a series labelled with a name reads as a second person.
 */
export const zeroContributorSummary = (
  key: string,
  identity?: Pick<
    ContributorSummary,
    "displayName" | "avatarUrl" | "profileUrl" | "entityRef" | "identities"
  >,
): ContributorSummary => ({
  key,
  displayName: identity?.displayName ?? key,
  avatarUrl: identity?.avatarUrl ?? null,
  profileUrl: identity?.profileUrl ?? null,
  entityRef: identity?.entityRef ?? null,
  identities: identity?.identities ?? [],
  commits: 0,
  linesAdded: 0,
  linesDeleted: 0,
  linesOfCode: 0,
  changedFiles: 0,
  churnUnit: "none",
  pullRequestsOpened: 0,
  pullRequestsMerged: 0,
  reviewsGiven: 0,
  reviewsApproved: 0,
  reviewsRejected: 0,
  prApprovalRate: 0,
  pipelineRuns: 0,
  pipelineRunsSucceeded: 0,
  pipelineRunsFailed: 0,
  pipelineSuccessRate: 0,
  repositories: 0,
  sonarMetrics: null,
  wakaTimeMetrics: null,
  jiraMetrics: null,
  confluenceMetrics: null,
});
