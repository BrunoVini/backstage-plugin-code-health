import { formatCount } from "./number_format";

/**
 * The period a Jira measurement covers, as ISO 8601 instants.
 *
 * Carried on the value rather than implied by the row it is stored under,
 * because Jira is the one enriched source that answers historically and the
 * period it answers for is not the period the range picker is showing. Sonar
 * has no history to disagree about; Jira does, and a figure whose window the
 * reader has to guess is worse than no figure.
 */
export interface JiraWindow {
  readonly from: string;
  readonly to: string;
}

/**
 * A duration measured over a set of issues, kept as its total and its count
 * rather than as an average.
 *
 * Identity linking merges every Atlassian account one person holds onto a
 * single contributor row, so every field here has to survive being added to
 * another row's. An average does not: the mean of two means is only correct
 * when both sides counted the same number of issues. Keeping the numerator and
 * the denominator apart makes the merged mean exactly the mean of the union,
 * which is the whole reason this is not stored pre-divided.
 *
 * A median is worse still — it cannot be recovered from two medians under any
 * arithmetic — which is why the contributor payload carries no percentiles and
 * {@link JiraDurationStats} exists only at the repository level.
 */
export interface JiraDurationTotals {
  readonly totalHours: number;
  readonly issues: number;
}

/**
 * The same duration with its shape, which only a repository row can carry.
 *
 * Repository rows are keyed by repository and never merged with one another, so
 * percentiles stay meaningful here. They matter: cycle time has a long right
 * tail — one ticket that sat in review over a holiday drags a mean by days —
 * and a median beside it is what tells a team whether the mean is describing
 * their work or describing one outlier.
 */
export interface JiraDurationStats extends JiraDurationTotals {
  readonly medianHours: number;
  /** The slow tail: five issues in six finished inside this. */
  readonly p85Hours: number;
}

/**
 * Work a person did *on* issues, as opposed to work that was assigned to them.
 *
 * The three are counted separately rather than pre-summed because they are not
 * the same act — a comment is a conversation, a worklog entry is time booked,
 * a transition is moving the board — and a single "interactions" number that
 * cannot be broken down is a number nobody can argue with or learn from.
 *
 * `comments` and `worklogEntries` are nullable because Jira Cloud's enhanced
 * search returns those two fields only on request and caps what it returns; a
 * site that answers with neither field present has not told us there were no
 * comments, it has told us nothing. `transitions` is never null because it
 * comes from the issue changelog, which the same search always expands.
 */
export interface JiraInteractions {
  readonly comments: number | null;
  readonly worklogEntries: number | null;
  readonly transitions: number;
  /**
   * Issues whose comment, worklog or changelog list the search truncated, so
   * the counts above are floors for those issues rather than totals.
   *
   * Kept as a count instead of a boolean so it survives merging and so the
   * dashboard can say *how much* it is unsure about. Zero is the normal case:
   * the daily run measures a short window, and an issue rarely collects twenty
   * comments inside one of those.
   */
  readonly truncatedIssues: number;
}

export const EMPTY_JIRA_INTERACTIONS: JiraInteractions = {
  comments: 0,
  worklogEntries: 0,
  transitions: 0,
  truncatedIssues: 0,
};

/**
 * Closed work split by issue type.
 *
 * The split is a case-insensitive match on the type *name* against the types
 * Jira creates with a new project, because nothing else identifies them: type
 * ids are per-site, and Jira exposes no "this is a defect" flag. A site that
 * renamed `Bug` to `Defect` is matched (both names are checked); a site that
 * invented `Incident` lands in `other`, and the documentation says so rather
 * than the plugin pretending the taxonomy is universal.
 *
 * This matters most for {@link computeBugRatio}: a bug ratio computed over a
 * fleet whose types were renamed would read as zero defects, which is the most
 * flattering possible way to be wrong.
 */
export interface JiraIssueTypeCounts {
  readonly bug: number;
  readonly story: number;
  readonly task: number;
  readonly epic: number;
  readonly other: number;
}

export type JiraIssueTypeBucket = keyof JiraIssueTypeCounts;

export const EMPTY_JIRA_ISSUE_TYPES: JiraIssueTypeCounts = {
  bug: 0,
  story: 0,
  task: 0,
  epic: 0,
  other: 0,
};

const TYPE_NAMES: ReadonlyMap<string, JiraIssueTypeBucket> = new Map([
  ["bug", "bug"],
  ["defect", "bug"],
  ["story", "story"],
  ["user story", "story"],
  ["task", "task"],
  ["sub-task", "task"],
  ["subtask", "task"],
  ["epic", "epic"],
]);

/**
 * Which bucket an issue type falls in.
 *
 * A sub-task is a task whatever it is called: Jira reports the flag separately
 * from the name, and a site that renamed its sub-task type would otherwise
 * scatter half its closed work into `other`.
 */
export const classifyIssueType = (
  name: string | null,
  isSubtask: boolean = false,
): JiraIssueTypeBucket => {
  if (isSubtask) return "task";
  if (name === null) return "other";
  return TYPE_NAMES.get(name.trim().toLowerCase()) ?? "other";
};

export const addIssueTypeCounts = (
  left: JiraIssueTypeCounts,
  right: JiraIssueTypeCounts,
): JiraIssueTypeCounts => ({
  bug: left.bug + right.bug,
  story: left.story + right.story,
  task: left.task + right.task,
  epic: left.epic + right.epic,
  other: left.other + right.other,
});

export const totalIssueTypes = (counts: JiraIssueTypeCounts): number =>
  counts.bug + counts.story + counts.task + counts.epic + counts.other;

/**
 * Share of closed work that was a defect, 0 to 100, or null when nothing
 * closed.
 *
 * Null rather than zero, for the reason absence is null everywhere in this
 * plugin: a team that closed nothing this week is not a team that shipped
 * nothing but working software.
 */
export const computeBugRatio = (counts: JiraIssueTypeCounts): number | null => {
  const total = totalIssueTypes(counts);
  if (total <= 0) return null;
  return Math.round((counts.bug / total) * 1000) / 10;
};

/** An issue nobody has finished, named so a reader can go and look at it. */
export interface JiraOpenIssue {
  readonly key: string;
  readonly summary: string | null;
  /** ISO 8601 instant the issue was created. */
  readonly createdAt: string;
  /** Whole days between creation and the end of the measured window. */
  readonly ageDays: number;
}

/** How many open issues carry one priority. */
export interface JiraPriorityCount {
  /** The site's own priority name — `Highest`, `P1`, whatever it renamed them to. */
  readonly name: string;
  readonly count: number;
}

/**
 * What Jira observed for one person over one window.
 *
 * Every field is summable, and that is a constraint rather than a coincidence:
 * a person routinely holds more than one Atlassian account, identity linking
 * folds them onto one contributor row, and {@link mergeJiraContributorMetrics}
 * is the only thing allowed to do the folding.
 *
 * "Created" is attributed to the issue's reporter and "resolved" to its
 * assignee at the moment it resolved. Neither is a perfect statement of who did
 * the work — Jira records no "closed by" — and both are what the site's own
 * reports use, so the numbers here agree with the numbers a team already sees.
 */
export interface JiraContributorMetrics {
  readonly window: JiraWindow;
  /** Issues this person reported, whose creation falls inside the window. */
  readonly issuesCreated: number;
  /** Issues assigned to this person that reached a done status in the window. */
  readonly issuesResolved: number;
  readonly interactions: JiraInteractions;
  /**
   * Points on the issues this person was assigned in the window, or null when
   * the story-point field could not be resolved for the site.
   *
   * Null is load-bearing here. Story points live on a custom field whose id
   * differs per Jira site and which a site may not have at all, so a zero would
   * be indistinguishable from a team that estimates nothing — and those call
   * for opposite reactions.
   */
  readonly storyPointsEstimated: number | null;
  /** Points on the issues that reached a done status in the window. */
  readonly storyPointsCompleted: number | null;
  /** In-progress to done, over this person's resolved issues. */
  readonly cycleTime: JiraDurationTotals | null;
  /** Created to done, over the same issues. */
  readonly leadTime: JiraDurationTotals | null;
  readonly resolvedByType: JiraIssueTypeCounts;
  /** Issues of theirs that went from a done status back to an open one. */
  readonly reopened: number;
}

/**
 * What Jira observed for one repository's project over one window.
 *
 * Scoped by the `jira/project-key` annotation on the catalog entity, narrowed
 * by `jira/component` when the entity carries one. A repository whose entity
 * names no project has no row at all rather than a row of zeroes — several
 * repositories legitimately share one Jira project, and several more track no
 * work in Jira, and reporting the second group as "no tickets" would put an
 * accusation on the dashboard.
 */
export interface JiraRepositoryMetrics {
  readonly window: JiraWindow;
  readonly projectKey: string;
  readonly component: string | null;
  readonly issuesCreated: number;
  readonly issuesResolved: number;
  /**
   * Issues resolved per week across the window, to one decimal.
   *
   * Reported instead of a raw count so two windows of different lengths can be
   * compared at all, and null when the window is shorter than a day — a rate
   * extrapolated from an hour of evidence is arithmetic, not measurement.
   */
  readonly throughputPerWeek: number | null;
  readonly resolvedByType: JiraIssueTypeCounts;
  readonly bugRatio: number | null;
  readonly reopened: number;
  readonly cycleTime: JiraDurationStats | null;
  readonly leadTime: JiraDurationStats | null;
  readonly storyPointsEstimated: number | null;
  readonly storyPointsCompleted: number | null;
  /**
   * Issues not in a done status right now, or null when the count could not be
   * read.
   *
   * This one figure is deliberately *not* windowed: a backlog is a present-tense
   * fact, and "how much was open last March" is not something Jira will answer
   * without replaying every changelog on the site.
   */
  readonly openIssues: number | null;
  readonly oldestOpenIssue: JiraOpenIssue | null;
  readonly openByPriority: readonly JiraPriorityCount[];
  /** Distinct Atlassian accounts that touched the project inside the window. */
  readonly contributors: number;
}

/**
 * Mean hours over a duration total, or null when nothing was measured.
 *
 * The one place a division happens, so the numerator and denominator can be
 * summed everywhere else first.
 */
export const meanHours = (totals: JiraDurationTotals | null): number | null => {
  if (totals === null || totals.issues <= 0) return null;
  return Math.round((totals.totalHours / totals.issues) * 10) / 10;
};

/**
 * Linear-interpolated percentile over an unsorted sample.
 *
 * Interpolated rather than nearest-rank because these samples are small — a
 * quiet week is four resolved issues — and nearest-rank on four values reports
 * the same number for the median and the 85th percentile, which reads as a
 * team with no variance at all.
 */
export const percentileHours = (hours: readonly number[], percentile: number): number => {
  if (hours.length === 0) return 0;
  const sorted = [...hours].sort((left, right) => left - right);
  const position = (sorted.length - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] ?? 0;
  const high = sorted[upper] ?? low;
  return Math.round((low + (high - low) * (position - lower)) * 10) / 10;
};

/** Totals plus percentiles over a sample of durations, or null when empty. */
export const buildDurationStats = (
  hours: readonly number[],
): JiraDurationStats | null => {
  if (hours.length === 0) return null;
  return {
    totalHours: Math.round(hours.reduce((total, value) => total + value, 0) * 10) / 10,
    issues: hours.length,
    medianHours: percentileHours(hours, 0.5),
    p85Hours: percentileHours(hours, 0.85),
  };
};

const HOURS_PER_DAY = 24;

/**
 * A duration in hours, phrased the way somebody discussing a ticket would.
 *
 * Cycle times span four orders of magnitude — twenty minutes to four months —
 * so a single unit is unreadable at one end whichever unit is chosen.
 */
export const formatHours = (hours: number): string => {
  if (!Number.isFinite(hours) || hours < 0) return "—";
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < HOURS_PER_DAY) {
    const whole = Math.floor(hours);
    const minutes = Math.round((hours - whole) * 60);
    return minutes > 0 ? `${whole}h ${minutes}m` : `${whole}h`;
  }
  // The day count is grouped: a ticket left open across a reorganisation gives
  // a lead time in four figures of days, and the cell it lands in is a cell.
  const days = Math.floor(hours / HOURS_PER_DAY);
  const remainder = Math.round(hours - days * HOURS_PER_DAY);
  return remainder > 0
    ? `${formatCount(days)}d ${remainder}h`
    : `${formatCount(days)}d`;
};

/**
 * Comments, worklog entries and transitions added together.
 *
 * Nulls count as zero, which makes the result a floor rather than a total
 * whenever a site did not return comment or worklog bodies. Callers that need
 * to say so read {@link JiraInteractions} directly — the headline number is
 * still the right thing to rank on, because a person with more of every
 * component still outranks a person with fewer.
 */
export const interactionTotal = (interactions: JiraInteractions): number =>
  (interactions.comments ?? 0) +
  (interactions.worklogEntries ?? 0) +
  interactions.transitions;

/** Whether every component of an interaction count was actually measured. */
export const interactionsAreComplete = (interactions: JiraInteractions): boolean =>
  interactions.comments !== null &&
  interactions.worklogEntries !== null &&
  interactions.truncatedIssues === 0;

/**
 * Adds two nullable counts, treating null as "not measured".
 *
 * Absence is contagious only when *nothing* was measured: one account that
 * reported four comments and one that reported none at all is a person with at
 * least four, not a person nobody can say anything about. Two accounts that
 * both reported nothing stay null.
 */
const addNullable = (left: number | null, right: number | null): number | null => {
  if (left === null) return right;
  if (right === null) return left;
  return left + right;
};

const addTotals = (
  left: JiraDurationTotals | null,
  right: JiraDurationTotals | null,
): JiraDurationTotals | null => {
  if (left === null) return right;
  if (right === null) return left;
  return {
    totalHours: Math.round((left.totalHours + right.totalHours) * 10) / 10,
    issues: left.issues + right.issues,
  };
};

/**
 * Folds several accounts' measurements into one person's row.
 *
 * The union of the windows is taken rather than one of them, so a row assembled
 * from accounts measured at slightly different moments states the period it
 * actually covers. Everything else is a plain sum, which is exactly why the
 * type carries no pre-divided rates: see {@link JiraDurationTotals}.
 *
 * Returns null for an empty list rather than a zeroed value, because a person
 * with no Atlassian account must not appear on the dashboard as somebody who
 * closed no tickets.
 */
export const mergeJiraContributorMetrics = (
  parts: readonly JiraContributorMetrics[],
): JiraContributorMetrics | null => {
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0] ?? null;

  const from = parts.map((part) => part.window.from).sort()[0] ?? "";
  const to = parts.map((part) => part.window.to).sort().at(-1) ?? "";

  const sum = (pick: (part: JiraContributorMetrics) => number): number =>
    parts.reduce((total, part) => total + pick(part), 0);

  return {
    window: { from, to },
    issuesCreated: sum((part) => part.issuesCreated),
    issuesResolved: sum((part) => part.issuesResolved),
    interactions: parts.reduce<JiraInteractions>(
      (merged, part) => ({
        comments: addNullable(merged.comments, part.interactions.comments),
        worklogEntries: addNullable(
          merged.worklogEntries,
          part.interactions.worklogEntries,
        ),
        transitions: merged.transitions + part.interactions.transitions,
        truncatedIssues: merged.truncatedIssues + part.interactions.truncatedIssues,
      }),
      { comments: null, worklogEntries: null, transitions: 0, truncatedIssues: 0 },
    ),
    storyPointsEstimated: parts.reduce<number | null>(
      (total, part) => addNullable(total, part.storyPointsEstimated),
      null,
    ),
    storyPointsCompleted: parts.reduce<number | null>(
      (total, part) => addNullable(total, part.storyPointsCompleted),
      null,
    ),
    cycleTime: parts.reduce<JiraDurationTotals | null>(
      (totals, part) => addTotals(totals, part.cycleTime),
      null,
    ),
    leadTime: parts.reduce<JiraDurationTotals | null>(
      (totals, part) => addTotals(totals, part.leadTime),
      null,
    ),
    resolvedByType: parts.reduce(
      (counts, part) => addIssueTypeCounts(counts, part.resolvedByType),
      EMPTY_JIRA_ISSUE_TYPES,
    ),
    reopened: sum((part) => part.reopened),
  };
};
