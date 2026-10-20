/**
 * The shape every composite score on the dashboard shares.
 *
 * A score is only worth showing when a reader can take it apart: a bare `62`
 * on a person's row is an accusation with no evidence, and one on a
 * repository's row is a number nobody can act on. So a score always carries
 * its components — what was measured, how much of the total it carried, and
 * the sentence explaining how the figure was read — and the dashboard renders
 * them beside the number rather than behind it.
 */
export type ScoreBand = "good" | "fair" | "poor" | "unknown";

export interface ScoreComponent {
  readonly id: string;
  readonly label: string;
  /**
   * Share of the score this component carries when it could be measured, in
   * `0..1`. The weights of a score's components add up to one.
   */
  readonly weight: number;
  /** The raw figure the component was read from, or null when there was none. */
  readonly value: number | null;
  /** Where the figure lands between worst and best, in `0..1`, or null when unmeasurable. */
  readonly normalized: number | null;
  /** How the figure was read, phrased for a reader. */
  readonly detail: string;
}

export interface Score {
  /**
   * `0..100`, rounded to a whole number, or null when nothing could be
   * measured — or, for a productivity score, when version control never saw
   * the person.
   */
  readonly value: number | null;
  /**
   * The summed weight of the components that could be measured, in `0..1`.
   *
   * A score built on a single component is still a score, but it is a weaker
   * claim than one built on all of them, and this is what lets a view say so.
   */
  readonly evidence: number;
  readonly components: readonly ScoreComponent[];
}

/** A score at or above this reads as healthy. */
export const GOOD_SCORE = 75;

/** A score at or above this, but below {@link GOOD_SCORE}, reads as fair. */
export const FAIR_SCORE = 50;

const clampUnit = (value: number): number => Math.min(1, Math.max(0, value));

const round = (value: number, places: number): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/**
 * Folds components into one figure.
 *
 * A component that could not be measured is left out and its weight is shared
 * among the ones that could, rather than being scored as zero: a repository
 * with no Sonar project has an unknown quality gate, not a failing one, and a
 * person whose pipeline never ran has no success rate, not a bad one. The
 * `evidence` field carries how much of the total weight survived, so a score
 * resting on one component cannot pass for one resting on all of them.
 */
export const combineScore = (components: readonly ScoreComponent[]): Score => {
  const measured = components.filter((component) => component.normalized !== null);
  const evidence = measured.reduce((total, component) => total + component.weight, 0);
  if (evidence <= 0) return { value: null, evidence: 0, components };

  const weighted = measured.reduce(
    (total, component) => total + component.weight * clampUnit(component.normalized ?? 0),
    0,
  );

  return {
    value: Math.round((weighted / evidence) * 100),
    evidence: round(evidence, 2),
    components,
  };
};

export const scoreBand = (value: number | null): ScoreBand => {
  if (value === null) return "unknown";
  if (value >= GOOD_SCORE) return "good";
  if (value >= FAIR_SCORE) return "fair";
  return "poor";
};

/** The fixed part of a component: what it is and how much it carries. */
export interface ScoreComponentDefinition {
  readonly id: string;
  readonly label: string;
  readonly weight: number;
}

export const measuredComponent = (
  definition: ScoreComponentDefinition,
  value: number,
  normalized: number,
  detail: string,
): ScoreComponent => ({
  ...definition,
  value,
  normalized: round(clampUnit(normalized), 4),
  detail,
});

export const unmeasuredComponent = (
  definition: ScoreComponentDefinition,
  detail: string,
): ScoreComponent => ({ ...definition, value: null, normalized: null, detail });

/**
 * `part` as a share of `total`, capped at one.
 *
 * Capped because several ratios here can legitimately exceed their ceiling —
 * a pull request can collect three reviews — and a share above one hundred
 * percent is a unit error on its face.
 */
export const shareOf = (part: number, total: number): number =>
  total <= 0 ? 0 : clampUnit(part / total);

export const formatScoreValue = (value: number | null): string =>
  value === null ? "—" : String(value);
