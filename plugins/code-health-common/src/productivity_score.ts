import { confluenceContributions } from "./confluence_metrics";
import { describeRatePair } from "./contributor_rates";
import { CONTRIBUTOR_ROLES, type ContributorRole } from "./contributor_role";
import { measuredByVersionControl, type ContributorSummary } from "./contributor_summary";
import type { IntegrationCapabilities, IntegrationId } from "./integrations";
import { NO_INTEGRATIONS } from "./integrations";
import { formatCount, formatDecimal, formatFixed } from "./number_format";
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
 *   A rate, not a total, so that every figure means the same thing whatever
 *   range was picked: "0.8 commits a day" is comparable with last quarter's
 *   reading, where "12 commits" is only comparable against another twelve
 *   weeks. The division cancels out of the comparison itself, so the score is
 *   the same number either way — what it buys is the wording and the Averages
 *   card, not a different result.
 *
 *   It does **not** correct for tenure or absence, and must not be described as
 *   though it did. Everybody is divided by the same window, so somebody who
 *   joined halfway through it carries half the total and half the rate, and
 *   scores half of a colleague who worked at the same pace throughout. Only a
 *   per-person denominator — the days that person was actually active — would
 *   remove that, and it brings its own distortion: one day worked and two
 *   commits made would read as twice as productive as a steady month.
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
 *
 * The version-control figures follow the same rule through the row's
 * identities rather than through a null, because they have none: somebody
 * known only to Jira carries `commits: 0`, and that zero used to go into the
 * commit mean and lower the bar every real committer was read against. Only a
 * row with a version-control account is measured for commits, pull requests
 * and reviews — and on such a row a zero is a real zero, a quiet window.
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
 *
 * Exported for the fleet rates the Averages card compares against, which are
 * taken by this exact arithmetic so the card and the score cannot disagree
 * about what the team's average is.
 */
export const meanRate = (
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

/**
 * A version-control figure, or null on a row version control never measured.
 *
 * Exported for the fleet rates the Averages card prints, which read the two
 * version-control rows the score does not — pull requests opened and pipeline
 * runs — by the same rule, so the card and the score agree on who the team is.
 */
export const versionControl =
  (pick: (contributor: ContributorSummary) => number) =>
  (contributor: ContributorSummary): number | null =>
    measuredByVersionControl(contributor) ? pick(contributor) : null;

export const fleetReferenceOf = (
  contributors: readonly ContributorSummary[],
  windowDays: number,
): FleetReference => {
  const days = Math.max(windowDays, 1 / 24);

  return {
    days,
    commits: meanRate(contributors, days, versionControl((row) => row.commits)),
    pullRequestsMerged: meanRate(
      contributors,
      days,
      versionControl((row) => row.pullRequestsMerged),
    ),
    reviewsGiven: meanRate(contributors, days, versionControl((row) => row.reviewsGiven)),
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
 * Every component, with the weight it carries for an engineer before
 * renormalisation.
 *
 * These are *nominal*: with all three integrations configured they add up to
 * 1.40 rather than to one, and {@link productivityComponentsFor} is what shares
 * them out over whatever is switched on. Declaring them this way lets a weight
 * say what its component is worth against the others rather than against a
 * total that differs per install — turning Jira on should not mean rewriting
 * the six numbers it has nothing to do with.
 *
 * The weight here is the engineer's, which is the default role and the reading
 * most rows want; {@link DEFAULT_PRODUCTIVITY_WEIGHTS} carries the lead's
 * beside it, and an administrator can replace either set.
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

/** The component ids, in the order a reader meets them. */
export const PRODUCTIVITY_COMPONENT_IDS: readonly ProductivityComponentId[] = Object.keys(
  PRODUCTIVITY_COMPONENTS,
) as ProductivityComponentId[];

/**
 * The nominal weight of every component, for one role.
 *
 * Nominal in the same sense as {@link PRODUCTIVITY_COMPONENTS}: what each is
 * worth against the others, shared out over whatever is configured by
 * {@link productivityComponentsFor}. A weight of zero leaves the component in
 * the score with no say, which is how an administrator switches a component
 * off for one role without switching it off for the other.
 */
export type ProductivityWeights = Readonly<Record<ProductivityComponentId, number>>;

/** One set of weights per role. */
export type ProductivityWeightsByRole = Readonly<Record<ContributorRole, ProductivityWeights>>;

const engineerWeights = (): ProductivityWeights =>
  Object.fromEntries(
    Object.values(PRODUCTIVITY_COMPONENTS).map((definition) => [definition.id, definition.weight]),
  ) as Record<ProductivityComponentId, number>;

/**
 * What each role is scored on until an administrator says otherwise.
 *
 * Both sets add up to 1.00 on an install with no integration and to 1.40 with
 * all three, so switching a role changes how the score is *shared*, never how
 * much of it there is to share.
 *
 * The engineer's weights are the ones the score always had: half of a base
 * install's score is output — commits, merged pull requests and churn — and
 * reviews carry fifteen percent behind it. The lead's turn that around. A lead
 * is expected to review more than they write, so reviews carry forty percent
 * of a base install's score and output a quarter, with reliability and the
 * quality of the code touched left where they were: a pipeline that fails and
 * a gate that fails mean the same thing whoever's row they land on. Where the
 * integrations are on, a lead's documentation counts double and their coding
 * time half, for the same reason — steering a team is written down more than
 * it is typed into an editor.
 *
 * Neither set claims to be right for every organisation, which is why they are
 * defaults rather than constants: the point of a role is that the weights can
 * be argued about per role rather than once for everybody.
 */
export const DEFAULT_PRODUCTIVITY_WEIGHTS: ProductivityWeightsByRole = {
  engineer: engineerWeights(),
  lead: {
    commits: 0.1,
    pullRequestsMerged: 0.1,
    churn: 0.05,
    reviewsGiven: 0.4,
    pipelineSuccessRate: 0.15,
    qualityGate: 0.1,
    coverage: 0.1,
    codingTime: 0.05,
    ticketsResolved: 0.1,
    reopened: 0.05,
    documentation: 0.2,
  },
};

/**
 * Reads one role's weights out of an untyped value, or nothing.
 *
 * Every component has to be there, every weight has to be a finite number of
 * zero or more, and at least one has to be above zero — a set that scores on
 * nothing is not a set of weights. Nothing is defaulted in: a request that
 * names nine components has forgotten two, and quietly filling them would
 * store a set the administrator never saw.
 */
export const parseProductivityWeights = (value: unknown): ProductivityWeights | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  const entries: Array<[ProductivityComponentId, number]> = [];
  for (const id of PRODUCTIVITY_COMPONENT_IDS) {
    const weight = record[id];
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) return null;
    entries.push([id, weight]);
  }
  if (!entries.some(([, weight]) => weight > 0)) return null;

  return Object.fromEntries(entries) as Record<ProductivityComponentId, number>;
};

/**
 * Reads every role's weights out of an untyped response body, falling back to
 * the defaults for any role that is missing or malformed.
 *
 * Lenient where {@link parseProductivityWeights} is strict, for the same reason
 * `parseIntegrationCapabilities` is: this reads what a backend *sent*, and a
 * backend one release behind sends nothing at all, which has to read as the
 * defaults rather than as a dashboard that fails to score anybody.
 */
export const parseProductivityWeightsByRole = (value: unknown): ProductivityWeightsByRole => {
  const record =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

  return CONTRIBUTOR_ROLES.reduce<Record<ContributorRole, ProductivityWeights>>(
    (weights, role) => ({
      ...weights,
      [role]: parseProductivityWeights(record[role]) ?? DEFAULT_PRODUCTIVITY_WEIGHTS[role],
    }),
    { ...DEFAULT_PRODUCTIVITY_WEIGHTS },
  );
};

const plural = (count: number, noun: string): string =>
  `${formatCount(count)} ${noun}${count === 1 ? "" : "s"}`;

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
  caveat?: string,
): ScoreComponent => {
  if (fleetRate <= 0) {
    return unmeasuredComponent(definition, `nobody recorded any ${noun}s in this window`);
  }

  // Both halves in one period, chosen once. Said independently they land in
  // different units whenever they straddle one a day, and the sentence then
  // contradicts the share it is explaining.
  const said = describeRatePair(value / days, fleetRate, noun);

  return measuredComponent(
    definition,
    value,
    shareOf(value / days, fleetRate * FLEET_RATE_CEILING),
    `${said.value} against the team's average of ${said.reference}${caveat ?? ""}`,
  );
};

/**
 * Churn, read against the fleet and against how much of the window survived.
 *
 * Churn is the one component whose figure can go missing a commit at a time.
 * The total is a sum over every commit in the window, and a commit no provider
 * reported a figure for lands in that sum as a zero, indistinguishable from a
 * commit that changed nothing. `churnUnit` says only that *something* was
 * measured — one commit in eleven carrying a file count is enough to make the
 * whole row read `files` — so the row's own figure cannot say how much of the
 * window it covers. {@link ContributorSummary.churnScope} can, and three
 * decisions follow from it.
 *
 * **A window with commits but no surviving churn figure is scored zero, not
 * dropped.** Dropping it handed the component's weight to the components that
 * *were* measured, which is right for a quality gate nobody ran and exactly
 * wrong here: a contributor whose churn data vanished entirely was scored on
 * their other components alone, while a colleague who kept one commit in
 * eleven was scored on a fraction of their real work. Total loss came out
 * strictly better than partial loss, and the incentive inverted — the worse
 * the data, the better the score. The honest reading is that the unmeasured
 * commits are already in the total, as the zeros they are; keeping the weight
 * makes losing everything the worst case rather than a free pass.
 *
 * **Unless nothing in the fleet measures churn at all.** When no row in the
 * window reports any line or file count, nothing was ever going to be
 * measured, and the component is unmeasurable rather than zero — the same rule
 * {@link relative} already applies to a fleet rate of zero, for the same
 * reason. Only a row that measured nothing *on a team where churn is measured*
 * is a loss. A row an older backend sent carries no scope at all, and is the
 * same case: nothing claims anything went missing.
 *
 * **The measured figure is never scaled up to the full commit count.**
 * Extrapolating assumes the commits that went missing look like the ones that
 * survived, and they need not: one surviving above-average commit multiplied
 * by eighteen scores *higher* than the complete truth would have, which would
 * let somebody gain from losing data — the precise failure this exists to
 * prevent. There is no estimator that both corrects the bias and guarantees no
 * gain, so the correction is refused. The figure stays conservative, and the
 * sentence discloses the scope instead, so a reader can see how much of the
 * window it covers and go and fix the collection rather than argue with the
 * number.
 */
const churnOf = (
  definition: ScoreComponentDefinition,
  summary: ContributorSummary,
  reference: FleetReference,
): ScoreComponent => {
  const scope = summary.churnScope;

  if (summary.churnUnit === "none") {
    const lost = scope?.unmeasured ?? 0;
    const fleetMeasuresChurn = reference.linesOfCode > 0 || reference.changedFiles > 0;
    if (lost === 0 || !fleetMeasuresChurn) {
      return unmeasuredComponent(definition, "the provider reported no churn figure");
    }
    return measuredComponent(
      definition,
      0,
      0,
      `no churn figure survived for any of the ${plural(lost, "commit")} in this window`,
    );
  }

  const caveat =
    scope !== undefined && scope.unmeasured > 0
      ? `, over the ${formatCount(scope.measured)} of ${plural(
          scope.measured + scope.unmeasured,
          "commit",
        )} that carried a figure`
      : undefined;

  if (summary.churnUnit === "lines") {
    return relative(
      definition,
      summary.linesOfCode,
      reference.linesOfCode,
      reference.days,
      "net line",
      caveat,
    );
  }
  return relative(
    definition,
    summary.changedFiles,
    reference.changedFiles,
    reference.days,
    "changed file",
    caveat,
  );
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
    `${formatCount(summary.pipelineRunsSucceeded)} of ${plural(decided, "decided run")} succeeded`,
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
  if (sonar.coverage === null) {
    return unmeasuredComponent(
      definition,
      "no repository touched reports coverage",
    );
  }
  return measuredComponent(
    definition,
    sonar.coverage,
    shareOf(sonar.coverage, SONAR_COVERAGE_TARGET),
    `${formatFixed(sonar.coverage)}% covered, against the ${SONAR_COVERAGE_TARGET}% gate`,
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
  // Said as a duration a day rather than through `describeRatePair`, because
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
    `${formatCount(jira.reopened)} of ${plural(jira.issuesResolved, "resolved ticket")} ${
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
    `${plural(value, "Confluence contribution")} against the team's average of ${formatDecimal(
      average,
    )} over Confluence's trailing window, not the range picked`,
  );
};

/**
 * A version-control reading, unmeasured for somebody version control never saw.
 *
 * Their zero commits are not a measurement, and scoring them would put a zero
 * on the row of somebody whose work all happened in Jira. The absence is named
 * as an unlinked account rather than folded into the generic "nothing was
 * measured", because it is the one cause somebody can go and fix, on the
 * Identities screen — the same wording the integrations use.
 */
const versionControlReading =
  (
    read: (
      definition: ProductivityComponentDefinition,
      summary: ContributorSummary,
      reference: FleetReference,
    ) => ScoreComponent,
  ) =>
  (
    definition: ProductivityComponentDefinition,
    summary: ContributorSummary,
    reference: FleetReference,
  ): ScoreComponent =>
    measuredByVersionControl(summary)
      ? read(definition, summary, reference)
      : unmeasuredComponent(definition, "no version-control account is linked to this person");

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
    read: versionControlReading((definition, summary, reference) =>
      relative(definition, summary.commits, reference.commits, reference.days, "commit"),
    ),
  },
  pullRequestsMerged: {
    integration: null,
    read: versionControlReading((definition, summary, reference) =>
      relative(
        definition,
        summary.pullRequestsMerged,
        reference.pullRequestsMerged,
        reference.days,
        "merged pull request",
      ),
    ),
  },
  churn: { integration: null, read: versionControlReading(churnOf) },
  reviewsGiven: {
    integration: null,
    read: versionControlReading((definition, summary, reference) =>
      relative(
        definition,
        summary.reviewsGiven,
        reference.reviewsGiven,
        reference.days,
        "review",
      ),
    ),
  },
  pipelineSuccessRate: { integration: null, read: versionControlReading(pipelineOf) },
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
 *
 * `weights` is one role's nominal set, the engineer's by default. A set whose
 * enabled components all weigh nothing yields every component at zero rather
 * than dividing by it, and the score then reads as unmeasured.
 */
export const productivityComponentsFor = (
  capabilities: IntegrationCapabilities = NO_INTEGRATIONS,
  weights: ProductivityWeights = DEFAULT_PRODUCTIVITY_WEIGHTS.engineer,
): readonly ProductivityComponentDefinition[] => {
  const enabled = Object.values(PRODUCTIVITY_COMPONENTS).filter((definition) => {
    const { integration } = READINGS[definition.id];
    return integration === null || capabilities[integration];
  });
  const nominal = enabled.reduce((total, definition) => total + weights[definition.id], 0);

  return enabled.map((definition) => ({
    ...definition,
    weight: nominal <= 0 ? 0 : weights[definition.id] / nominal,
  }));
};

/**
 * The score, read through the weights of the row's own role.
 *
 * The role travels on the row and the weights arrive as one set per role,
 * so a caller holding the fleet's rows and the backend's configuration scores
 * every row without deciding anything itself — which is what keeps the table
 * in the browser and the trend on the backend folding the same number.
 */
export const computeProductivityScore = (
  summary: ContributorSummary,
  reference: FleetReference,
  capabilities: IntegrationCapabilities = NO_INTEGRATIONS,
  weights: ProductivityWeightsByRole = DEFAULT_PRODUCTIVITY_WEIGHTS,
): ProductivityScore =>
  combineScore(
    productivityComponentsFor(capabilities, weights[summary.role]).map((definition) =>
      READINGS[definition.id].read(definition, summary, reference),
    ),
  );
