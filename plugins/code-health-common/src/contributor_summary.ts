import type { ClaudeMetrics } from "./claude_metrics";
import type { ConfluenceContributorMetrics } from "./confluence_metrics";
import type { ContributorRole } from "./contributor_role";
import type { ContributorIdentity } from "./identity";
import type { JiraContributorMetrics } from "./jira_metrics";
import type { SonarMetrics } from "./sonar_metrics";
import type { WakaTimeMetrics } from "./wakatime_metrics";

/**
 * One row of the contributors dashboard, aggregated from the events inside the
 * requested window.
 *
 * A row is a *person*, not an account. `key` is the catalog `User` entity the
 * row's accounts resolved to, and falls back to `<source>:<sourceKey>` for an
 * account nobody has linked yet — so an unlinked identity still gets a row
 * rather than disappearing.
 *
 * This is the change that makes the row worth reading at all once more than one
 * system is being measured. A person's commits arrive under a GitHub login,
 * their coding time under a WakaTime username, their tickets under an Atlassian
 * `accountId`, and none of the three matches the others. Keyed by account, the
 * same human occupied three rows that each held a third of the story; keyed by
 * person, the row adds up. {@link identities} names what was merged, because a
 * total nobody can trace back to its sources is a number nobody trusts.
 */
/**
 * Which unit a contributor's churn is actually measured in.
 *
 * The two providers do not report the same thing and cannot be made to. GitHub's
 * commit history carries added and deleted *lines*; Azure DevOps carries added,
 * edited and deleted *files* and exposes no line count anywhere in its REST API
 * — reconstructing one would mean diffing every blob of every commit.
 *
 * Carrying the unit explicitly is what lets a view render the figure it has
 * instead of rendering a zero. The alternative, inferring the unit from which
 * number is non-zero, misreads a real quiet week as a missing measurement.
 */
export type ChurnUnit = "lines" | "files" | "none";

/**
 * The scope of a contributor row's coverage average: how many of the
 * repositories behind it reported a coverage measure, and how many SonarQube
 * analysed without reporting one.
 *
 * Counted over the repositories the person committed to or merged into that
 * have a Sonar project at all. A repository with no Sonar project is in
 * neither count, because nothing was ever going to measure it.
 */
export interface CoverageScope {
  /** Repositories touched that reported a coverage measure. */
  readonly measured: number;
  /** Repositories touched that SonarQube analyses but reports no coverage for. */
  readonly unreported: number;
}

/**
 * The scope of a contributor row's churn total: how many of the commits behind
 * it carried a figure in the unit the row is measured in, and how many carried
 * none.
 *
 * Counted in the row's own {@link ChurnUnit}, because that is the unit the
 * figure is read and scored in. A row spanning both providers is measured in
 * `lines`, and the Azure DevOps commits on it reported only files — they are
 * genuinely unmeasured against the number the row prints, however much the
 * provider did report about them.
 *
 * The total alone cannot say this. A commit the provider said nothing about
 * contributes a zero to the sum exactly like a commit that changed nothing, so
 * a window in which one commit of eighteen survived prints a small, confident
 * figure with nothing to mark it as a fraction of the real work.
 */
export interface ChurnScope {
  /** Commits that carried a figure in this row's churn unit. */
  readonly measured: number;
  /** Commits that carried none. */
  readonly unmeasured: number;
}

export interface ContributorSummary {
  readonly key: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly profileUrl: string | null;
  /**
   * The catalog `User` this person resolved to, or null when no account on the
   * row is linked to one.
   *
   * A link is made two ways. An account whose e-mail matches a `User` profile
   * is linked on sight, because that is the same rule the catalog itself uses
   * to decide who somebody is. Everything else — a WakaTime username, an
   * Atlassian `accountId`, a commit from a personal address — is *offered* as a
   * ranked suggestion on the Identities screen and linked only when a person
   * confirms it. Nothing is merged on a name resemblance alone: two people who
   * share a surname would silently become one contributor, and a merge nobody
   * asked for is far harder to notice than a row that stayed separate.
   */
  readonly entityRef: string | null;
  /**
   * Every account that was merged into this row, in the order they were
   * observed. A single-account row carries one entry, never zero.
   */
  readonly identities: readonly ContributorIdentity[];
  /**
   * What this person is scored as: the role whose weights the productivity
   * score is read through.
   *
   * Resolved by the backend from the role an administrator assigned, through
   * the same directory that resolves accounts to people, so a role assigned to
   * one of somebody's accounts is the role of the row all their accounts share.
   * An engineer until somebody says otherwise.
   */
  readonly role: ContributorRole;
  readonly commits: number;
  readonly linesAdded: number;
  readonly linesDeleted: number;
  /** Net lines contributed: `linesAdded - linesDeleted`, floored at zero. */
  readonly linesOfCode: number;
  readonly changedFiles: number;
  /**
   * What `linesOfCode` and `changedFiles` mean for this contributor: `lines`
   * when the provider reported line counts, `files` when it only reported file
   * counts, `none` when it reported neither.
   */
  readonly churnUnit: ChurnUnit;
  /**
   * How many of this row's commits actually carried a figure in
   * {@link churnUnit}, and how many did not.
   *
   * The churn total is a sum over every commit in the window, and a commit the
   * provider reported nothing for enters it as a zero — indistinguishable from
   * a commit that genuinely changed nothing. So the total is silent about its
   * own scope in exactly the way an average is: somebody whose window kept one
   * commit out of eighteen shows a figure that looks like the whole window.
   * `churnUnit` alone cannot tell the two apart, because it says `files` as
   * soon as *one* commit carried a file count.
   *
   * That silence is what the productivity score reads, which is why this is
   * carried rather than left to a view: a window that measured none of its
   * commits must not score as a window that was never going to be measured.
   *
   * Optional because an older backend does not send it, which is a different
   * thing from a window in which nothing was lost.
   */
  readonly churnScope?: ChurnScope;
  readonly pullRequestsOpened: number;
  readonly pullRequestsMerged: number;
  /**
   * Other people's pull requests this contributor reviewed, whatever the vote.
   *
   * A vote on one's own pull request is not a review, and on Azure DevOps a
   * reviewer who was added and never voted did not review either.
   */
  readonly reviewsGiven: number;
  readonly reviewsApproved: number;
  readonly reviewsRejected: number;
  /** `reviewsApproved / reviewsGiven` as a percentage, or 0 with no reviews. */
  readonly prApprovalRate: number;
  /**
   * Pipeline runs credited to this person, whatever their outcome.
   *
   * A run is credited to the author of the change it built: the pull request
   * whose merge produced the commit, else the commit's own author, else whoever
   * the provider says requested it. It is never credited to somebody merely for
   * pressing the merge button.
   */
  readonly pipelineRuns: number;
  readonly pipelineRunsSucceeded: number;
  readonly pipelineRunsFailed: number;
  /**
   * `pipelineRunsSucceeded / (pipelineRunsSucceeded + pipelineRunsFailed)` as a
   * percentage, or 0 with no run that reached a verdict. Cancelled, skipped and
   * still-running runs are left out of both sides: a run superseded by a newer
   * push is not a failure.
   */
  readonly pipelineSuccessRate: number;
  /** Repositories any of this person's events landed in, reviews included. */
  readonly repositories: number;
  /**
   * Sonar measures summed over the repositories this person committed to or
   * merged into in the window, or null with none measured.
   *
   * Sonar measures a project, not a person: nothing here claims the bugs are
   * theirs, only that this is what the code they changed looks like. Reviewing
   * or building in a repository does not count as changing its code.
   */
  readonly sonarMetrics: SonarMetrics | null;
  /**
   * How many of the repositories behind `sonarMetrics.coverage` reported one.
   *
   * The coverage on this row is a mean over the repositories that report a
   * measure, because folding an unmeasurable project in as a zero would drag
   * the row down for code that was never on the scale. That average is honest,
   * but it is silent about its own scope: somebody who touched one measured
   * repository and one unmeasurable one shows the first one's figure with
   * nothing saying the second exists. `sonarMetrics.coverage` is null only
   * when *every* repository is unmeasurable, so the partial case — the common
   * one — has no other signal.
   *
   * Optional because an older backend does not send it, which is a different
   * thing from a person having touched nothing.
   */
  readonly coverageScope?: CoverageScope;
  readonly wakaTimeMetrics: WakaTimeMetrics | null;
  /** Optional for compatibility with backends predating Claude collection. */
  readonly claudeMetrics?: ClaudeMetrics | null;
  readonly jiraMetrics: JiraContributorMetrics | null;
  readonly confluenceMetrics: ConfluenceContributorMetrics | null;
}

/**
 * Whether version control measured this person at all.
 *
 * A row exists for anybody any source reported, and its version-control
 * figures are plain numbers with no way to say "never asked". Somebody known
 * only to Jira, WakaTime or Confluence therefore carries `commits: 0`, and
 * read as a measurement that zero would go into every version-control mean
 * and score them as somebody who committed nothing. It is not zero commits;
 * nothing was ever counted on their behalf. A person who does have a
 * version-control account and was quiet is the opposite case — a measured
 * zero, exactly like a quiet week — and the difference between the two is
 * whether any account on the row came from version control, which the row's
 * identities name.
 */
export const measuredByVersionControl = (summary: ContributorSummary): boolean =>
  summary.identities.some((identity) => identity.source === "vcs");

/** Percentage of `part` within `total`, rounded to one decimal, 0 when `total` is 0. */
export const computeRate = (part: number, total: number): number => {
  if (total <= 0) return 0;
  return Math.round((part / total) * 1000) / 10;
};
