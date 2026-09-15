import { confluenceContributions } from "./confluence_metrics";
import { describeRate } from "./contributor_rates";
import type { ContributorSummary } from "./contributor_summary";
import type { IntegrationCapabilities, IntegrationId } from "./integrations";
import { NO_INTEGRATIONS } from "./integrations";
import {
  combineScore,
  measuredComponent,
  shareOf,
  unmeasuredComponent,
  type Score,
  type ScoreComponent,
  type ScoreComponentDefinition,
} from "./score";
import { SONAR_COVERAGE_TARGET } from "./sonar_metrics";
import { formatDuration } from "./wakatime_metrics";

/**
 * A person's productivity over a window, as one number with its workings.
 *
 * These figures are read as a measure of people, so what goes into the number
 * matters more than the number. Four rules decide it:
 *
 * - **Output is a rate, measured against the fleet's average rate.** Commits,
 *   merged pull requests, churn and reviews — and, wherever the integration is
 *   configured, coding time, resolved tickets and documentation written — are
 *   divided by the days the window spans and read against the *mean* rate
 *   across the people measured in it, with twice that mean scoring full marks.
 *   A quiet month for the whole team is then a quiet month rather than
 *   everybody's failure, and there is no invented "forty commits is a good
 *   month" to argue with.
 *
 *   The mean, not the maximum. Against the top figure, one person having an
 *   extraordinary month pushed everybody else's score down for reasons that
 *   had nothing to do with them, and a single automation nobody had excluded
 *   yet could flatten a whole team at once. Against the mean, keeping pace
 *   with the team scores half, doubling it scores full, and one outlier moves
 *   the reference by a fraction of its own size instead of setting it outright.
 *
 *   A rate, not a total, because a total answers "how much in these three
 *   months" — which is not comparable between somebody who was there for all
 *   of it and somebody who joined in the second month. The division cancels
 *   out of the comparison itself, so the score is the same number either way;
 *   what it buys is that every sentence explaining it reads in figures that
 *   mean the same thing whatever range was picked.
 * - **Reliability and quality are absolute.** A pipeline success rate, a
 *   quality gate, and the share of somebody's resolved tickets that stayed
 *   resolved mean the same thing whoever else is on the team.
 * - **What was not measured is left out, never scored as zero.** Somebody whose
 *   pipeline never ran has no success rate; somebody working on a repository
 *   with no Sonar project has an unknown gate; somebody with no WakaTime
 *   account linked to them has no coding time. Their weight goes to the
 *   components that could be measured, and `evidence` says how much survived.
 * - **Which components exist at all is decided by configuration.** An
 *   integration the backend was never configured with contributes no component
 *   rather than an unmeasured one, and the rest are renormalised over what is
 *   left. Inferring it from whether a row happens to carry a value cannot tell
 *   a switched-off integration from one that is on and has collected nothing
 *   yet, which would make a freshly configured install look as though half its
 *   people had stopped working.
 *
 * Sonar figures on a contributor row describe the repositories the person
 * changed the code of, not what they wrote — the same reading the table gives
 * them — which is why those two components carry the least weight.
 */
export type ProductivityScore = Score;

/**
 * The fleet's **mean daily rate** for each relative component, and the window
 * those rates were taken over.
 *
 * A mean rather than a maximum, and per day rather than per window — see the
 * reasoning on {@link ProductivityScore}. `days` travels with the figures
 * because every sentence the score produces is phrased as a rate, and a rate
 * separated from the period it was taken over is a number nobody can check.
 *
 * Churn is kept per unit because the two providers do not report the same
 * thing: GitHub reports lines, Azure DevOps reports files, and a person on one
 * platform is only ever compared with people measured in their own unit.
 *
 * Each mean is taken over the rows the component could be *measured* on, not
 * over everybody. A row whose metrics are null has not recorded a zero —
 * nothing was ever asked on its behalf — and averaging silence in as zero drags
 * the reference down towards nothing, which would flatter every row that does
 * carry a figure. It is the same rule the maximum followed, and it matters more
 * here: a maximum ignores a wrong zero, a mean is moved by every one of them.
 */
export interface FleetReference {
  /** Days the window spans, which every figure below is a per-day rate over. */
  readonly days: number;
  readonly commits: number;
  readonly pullRequestsMerged: number;
  readonly reviewsGiven: number;
  readonly linesOfCode: number;
  readonly changedFiles: number;
  readonly codingSeconds: number;
  readonly issuesResolved: number;
  readonly documentationContributions: number;
}

export const EMPTY_FLEET_REFERENCE: FleetReference = {
  days: 1,
  commits: 0,
  pullRequestsMerged: 0,
  reviewsGiven: 0,
  linesOfCode: 0,
  changedFiles: 0,
  codingSeconds: 0,
  issuesResolved: 0,
  documentationContributions: 0,
};

/**
 * The mean of whatever each row could be measured for, as a daily rate.
 *
 * Rows the figure is absent from are skipped entirely rather than counted as
 * zeros, so the divisor is "the people this could be measured for" rather than
 * "everybody who turned up". With nobody qualifying the mean is zero, which
 * every reading treats as unmeasurable rather than as a bar of nothing.
 */
const meanRate = (
  contributors: readonly ContributorSummary[],
  days: number,
  pick: (contributor: ContributorSummary) => number | null,
): number => {
  const measured = contributors.flatMap((contributor) => {
    const value = pick(contributor);
    return value === null ? [] : [value];
  });
  if (measured.length === 0) return 0;
  return measured.reduce((total, value) => total + value, 0) / measured.length / days;
};

export const fleetReferenceOf = (
  contributors: readonly ContributorSummary[],
  windowDays: number,
): FleetReference => {
  const days = Math.max(windowDays, 1 / 24);

  return {
    days,
    commits: meanRate(contributors, days, (row) => row.commits),
    pullRequestsMerged: meanRate(contributors, days, (row) => row.pullRequestsMerged),
    reviewsGiven: meanRate(contributors, days, (row) => row.reviewsGiven),
    linesOfCode: meanRate(contributors, days, (row) =>
      row.churnUnit === "lines" ? row.linesOfCode : null,
    ),
    changedFiles: meanRate(contributors, days, (row) =>
      row.churnUnit === "files" ? row.changedFiles : null,
    ),
    codingSeconds: meanRate(
      contributors,
      days,
      (row) => row.wakaTimeMetrics?.totalSeconds ?? null,
    ),
    issuesResolved: meanRate(
      contributors,
      days,
      (row) => row.jiraMetrics?.issuesResolved ?? null,
    ),
    documentationContributions: meanRate(contributors, days, (row) =>
      row.confluenceMetrics === null
        ? null
        : confluenceContributions(row.confluenceMetrics),
    ),
  };
};

/**
 * Every component, with the weight it carries before renormalisation.
 *
 * These are *nominal*: with all three integrations configured they add up to
 * 1.40 rather than to one, and {@link productivityComponentsFor} is what shares
 * them out over whatever is switched on. Declaring them this way lets a weight
 * say what its component is worth against the others rather than against a
 * total that differs per install — turning Jira on should not mean rewriting
 * the six numbers it has nothing to do with.
 */
export const PRODUCTIVITY_COMPONENTS = {
  commits: { id: "commits", label: "Commits", weight: 0.2 },
  pullRequestsMerged: {
    id: "pullRequestsMerged",
    label: "Pull requests merged",
    weight: 0.2,
  },
  churn: { id: "churn", label: "Code churn", weight: 0.1 },
  reviewsGiven: { id: "reviewsGiven", label: "Reviews given", weight: 0.15 },
  pipelineSuccessRate: {
    id: "pipelineSuccessRate",
    label: "Pipeline success",
    weight: 0.15,
  },
  qualityGate: {
    id: "qualityGate",
    label: "Quality gate of code touched",
    weight: 0.1,
  },
  coverage: {
    id: "coverage",
    label: "Test coverage of code touched",
    weight: 0.1,
  },
  codingTime: { id: "codingTime", label: "Coding time", weight: 0.1 },
  ticketsResolved: {
    id: "ticketsResolved",
    label: "Tickets resolved",
    weight: 0.15,
  },
  reopened: { id: "reopened", label: "Tickets that stayed done", weight: 0.05 },
  documentation: {
    id: "documentation",
    label: "Documentation written",
    weight: 0.1,
  },
} as const satisfies Record<string, ScoreComponentDefinition>;

/** Every component the productivity score knows how to read. */
export type ProductivityComponentId = keyof typeof PRODUCTIVITY_COMPONENTS;

/** A component's fixed part, with its id narrowed to the ones above. */
export interface ProductivityComponentDefinition extends ScoreComponentDefinition {
  readonly id: ProductivityComponentId;
}

const plural = (count: number, noun: string): string =>
  `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;

/**
 * How much of the fleet's mean rate scores full marks.
 *
 * Twice it, so keeping pace with the team scores half and doubling it scores
 * everything. A multiplier of one would make the mean itself full marks and
 * hand the same score to somebody matching the team and somebody tripling it;
 * anything higher makes the average look like a failure. Two is the setting
 * that leaves "average" reading as average.
 */
export const FLEET_RATE_CEILING = 2;

/**
 * A rate read against twice the fleet's mean rate in the same window.
 *
 * With nobody recording any, the component is unmeasurable rather than zero: a
 * week in which no pull request merged anywhere says nothing about anyone.
 *
 * `value` stays the raw total, because that is the figure the table prints and
 * a component whose value disagreed with its own column would be unreadable.
 * Only `normalized` and the sentence are in rates.
 */
const relative = (
  definition: ScoreComponentDefinition,
  value: number,
  fleetRate: number,
  days: number,
  noun: string,
): ScoreComponent =>
  fleetRate <= 0
    ? unmeasuredComponent(definition, `nobody recorded any ${noun}s in this window`)
    : measuredComponent(
        definition,
        value,
        shareOf(value / days, fleetRate * FLEET_RATE_CEILING),
        `${describeRate(value / days, noun)} against the team's average of ${describeRate(
          fleetRate,
          noun,
        )}`,
      );

const churnOf = (
  definition: ScoreComponentDefinition,
  summary: ContributorSummary,
  reference: FleetReference,
): ScoreComponent => {
  if (summary.churnUnit === "lines") {
    return relative(
      definition,
      summary.linesOfCode,
      reference.linesOfCode,
      reference.days,
      "net line",
    );
  }
  if (summary.churnUnit === "files") {
    return relative(
      definition,
      summary.changedFiles,
      reference.changedFiles,
      reference.days,
      "changed file",
    );
  }
  return unmeasuredComponent(definition, "the provider reported no churn figure");
};

const pipelineOf = (
  definition: ScoreComponentDefinition,
  summary: ContributorSummary,
): ScoreComponent => {
  const decided = summary.pipelineRunsSucceeded + summary.pipelineRunsFailed;
  if (decided === 0) {
    return unmeasuredComponent(definition, "no pipeline run reached a verdict");
  }
  return measuredComponent(
    definition,
    summary.pipelineSuccessRate,
    summary.pipelineRunsSucceeded / decided,
    `${summary.pipelineRunsSucceeded.toLocaleString()} of ${plural(decided, "decided run")} succeeded`,
  );
};

const qualityGateOf = (
  definition: ScoreComponentDefinition,
  summary: ContributorSummary,
): ScoreComponent => {
  const sonar = summary.sonarMetrics;
  if (sonar === null || sonar.qualityGateStatus === "NONE") {
    return unmeasuredComponent(definition, "no Sonar project measures the code touched");
  }
  const passing = sonar.qualityGateStatus === "OK";
  return measuredComponent(
    definition,
    passing ? 1 : 0,
    passing ? 1 : 0,
    passing
      ? "every repository touched passes its quality gate"
      : "a repository touched is failing its quality gate",
  );
};

const coverageOf = (
  definition: ScoreComponentDefinition,
  summary: ContributorSummary,
): ScoreComponent => {
  const sonar = summary.sonarMetrics;
  if (sonar === null) {
    return unmeasuredComponent(definition, "no Sonar project measures the code touched");
  }
  return measuredComponent(
    definition,
    sonar.coverage,
    shareOf(sonar.coverage, SONAR_COVERAGE_TARGET),
    `${sonar.coverage.toFixed(1)}% covered, against the ${SONAR_COVERAGE_TARGET}% gate`,
  );
};

/**
 * Coding time, against the team's average over the same window.
 *
 * Phrased in hours and minutes rather than in seconds because the sentence is
 * only ever read by a person, and thirty thousand of anything is not a duration
 * anybody can picture.
 *
 * An unlinked account is named as the cause rather than folded into the generic
 * "nothing was measured", because it is the one reason the figure can be
 * missing that somebody can go and fix, on the Identities screen.
 */
const codingTimeOf = (
  definition: ScoreComponentDefinition,
  summary: ContributorSummary,
  reference: FleetReference,
): ScoreComponent => {
  const wakaTime = summary.wakaTimeMetrics;
  if (wakaTime === null) {
    return unmeasuredComponent(definition, "no WakaTime account is linked to this person");
  }
  if (reference.codingSeconds <= 0) {
    return unmeasuredComponent(definition, "nobody recorded any coding time in this window");
  }
  // Said as a duration a day rather than through `describeRate`, because
  // "1.23 seconds a day" is a sentence nobody can read and hours are what
  // coding time is thought in everywhere else on the page.
  return measuredComponent(
    definition,
    wakaTime.totalSeconds,
    shareOf(
      wakaTime.totalSeconds / reference.days,
      reference.codingSeconds * FLEET_RATE_CEILING,
    ),
    `${formatDuration(
      wakaTime.totalSeconds / reference.days,
    )} a day against the team's average of ${formatDuration(reference.codingSeconds)} a day`,
  );
};

const ticketsResolvedOf = (
  definition: ScoreComponentDefinition,
  summary: ContributorSummary,
  reference: FleetReference,
): ScoreComponent => {
  const jira = summary.jiraMetrics;
  if (jira === null) {
    return unmeasuredComponent(definition, "no Jira account is linked to this person");
  }
  return relative(
    definition,
    jira.issuesResolved,
    reference.issuesResolved,
    reference.days,
    "resolved ticket",
  );
};

/**
 * How much of somebody's resolved work stayed resolved.
 *
 * Absolute rather than relative, and the only Jira component that is: a ticket
 * coming back is a fact about that ticket, not a race against how often other
 * people's came back. Capped at one so a fortnight in which everything reopened
 * scores zero rather than below it, and unmeasured with nothing resolved —
 * somebody who closed no ticket has not failed to keep any closed.
 */
const reopenedOf = (
  definition: ScoreComponentDefinition,
  summary: ContributorSummary,
): ScoreComponent => {
  const jira = summary.jiraMetrics;
  if (jira === null) {
    return unmeasuredComponent(definition, "no Jira account is linked to this person");
  }
  if (jira.issuesResolved <= 0) {
    return unmeasuredComponent(definition, "no ticket resolved");
  }
  return measuredComponent(
    definition,
    jira.reopened,
    1 - Math.min(1, jira.reopened / jira.issuesResolved),
    `${jira.reopened.toLocaleString()} of ${plural(jira.issuesResolved, "resolved ticket")} ${
      jira.reopened === 1 ? "was" : "were"
    } reopened`,
  );
};

/**
 * Documentation written, read against the team's average — but over
 * Confluence's own trailing window, not the one the reader picked.
 *
 * Confluence is the one integration stored per window rather than per day: its
 * figures describe the backend's trailing `atlassian.historyDays` and do not
 * move with the range picker, so this component cannot honestly claim "in the
 * same window" the way coding time and tickets can. The detail says so rather
 * than borrowing the wording of the other relative components, because a
 * ninety-day figure labelled as "last 24 hours" is exactly the misreading the
 * rest of the dashboard refuses to leave implicit.
 */
const documentationOf = (
  definition: ScoreComponentDefinition,
  summary: ContributorSummary,
  reference: FleetReference,
): ScoreComponent => {
  const confluence = summary.confluenceMetrics;
  if (confluence === null) {
    return unmeasuredComponent(definition, "no Confluence account is linked to this person");
  }
  const top = reference.documentationContributions;
  if (top <= 0) {
    return unmeasuredComponent(
      definition,
      "nobody recorded any Confluence contributions over Confluence's trailing window",
    );
  }
  // Compared as totals rather than as rates: both sides describe Confluence's
  // own trailing window, so dividing by the *picked* range's days would label
  // a ninety-day figure as a daily one. The ratio is the same either way.
  const value = confluenceContributions(confluence);
  const average = top * reference.days;
  return measuredComponent(
    definition,
    value,
    shareOf(value, average * FLEET_RATE_CEILING),
    `${plural(value, "Confluence contribution")} against the team's average of ${
      Math.round(average * 10) / 10
    } over Confluence's trailing window, not the range picked`,
  );
};

/** How one component is read, and what has to be configured for it to exist. */
interface ComponentReading {
  /**
   * The integration this component needs, or null when it is always part of the
   * score. Configuration decides this, never whether a row carries a value.
   */
  readonly integration: IntegrationId | null;
  readonly read: (
    definition: ProductivityComponentDefinition,
    summary: ContributorSummary,
    reference: FleetReference,
  ) => ScoreComponent;
}

/**
 * Component to its reading, in the order a reader meets them.
 *
 * A lookup rather than a chain of conditionals, so adding a component means
 * adding an entry here and one in {@link PRODUCTIVITY_COMPONENTS} — and the two
 * cannot drift, because the type requires an entry for every id.
 */
const READINGS: Readonly<Record<ProductivityComponentId, ComponentReading>> = {
  commits: {
    integration: null,
    read: (definition, summary, reference) =>
      relative(definition, summary.commits, reference.commits, reference.days, "commit"),
  },
  pullRequestsMerged: {
    integration: null,
    read: (definition, summary, reference) =>
      relative(
        definition,
        summary.pullRequestsMerged,
        reference.pullRequestsMerged,
        reference.days,
        "merged pull request",
      ),
  },
  churn: { integration: null, read: churnOf },
  reviewsGiven: {
    integration: null,
    read: (definition, summary, reference) =>
      relative(
        definition,
        summary.reviewsGiven,
        reference.reviewsGiven,
        reference.days,
        "review",
      ),
  },
  pipelineSuccessRate: { integration: null, read: pipelineOf },
  qualityGate: { integration: null, read: qualityGateOf },
  coverage: { integration: null, read: coverageOf },
  codingTime: { integration: "wakatime", read: codingTimeOf },
  ticketsResolved: { integration: "jira", read: ticketsResolvedOf },
  reopened: { integration: "jira", read: reopenedOf },
  documentation: { integration: "confluence", read: documentationOf },
};

/**
 * The components a given install actually scores on, weighted to sum to one.
 *
 * Exported because the number and every sentence explaining it have to come
 * from the same place. The weights move with configuration — with all three
 * integrations on, commits carry 0.2/1.4, about 14%, rather than 20% — so a
 * column header, a card subheader or a page of documentation that wrote those
 * percentages out by hand would be wrong on most installs, and wrong in a way
 * nobody would ever notice.
 */
export const productivityComponentsFor = (
  capabilities: IntegrationCapabilities = NO_INTEGRATIONS,
): readonly ProductivityComponentDefinition[] => {
  const enabled = Object.values(PRODUCTIVITY_COMPONENTS).filter((definition) => {
    const { integration } = READINGS[definition.id];
    return integration === null || capabilities[integration];
  });
  const nominal = enabled.reduce((total, definition) => total + definition.weight, 0);

  return enabled.map((definition) => ({ ...definition, weight: definition.weight / nominal }));
};

export const computeProductivityScore = (
  summary: ContributorSummary,
  reference: FleetReference,
  capabilities: IntegrationCapabilities = NO_INTEGRATIONS,
): ProductivityScore =>
  combineScore(
    productivityComponentsFor(capabilities).map((definition) =>
      READINGS[definition.id].read(definition, summary, reference),
    ),
  );
