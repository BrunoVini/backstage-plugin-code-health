import type {
  ContributorSummary,
  ContributorTrendPoint,
  FleetReference,
  IntegrationCapabilities,
  ProductivityScore,
} from "@rios0rios0/backstage-plugin-code-health-common";
import {
  computeProductivityScore,
  fleetReferenceOf,
  NO_INTEGRATIONS,
} from "@rios0rios0/backstage-plugin-code-health-common";

/**
 * One bucket of a person's history.
 *
 * The score is computed rather than invented, by the same function the backend
 * uses, so a test asserting on a chart of scores is asserting on the arithmetic
 * that actually ships. The reference defaults to the bucket's own row, which
 * makes a lone contributor the team average in their own window — the shape a
 * one-person fixture would really have.
 *
 * The capabilities default to none for the same reason the backend's do: a
 * fixture that says nothing about integrations is a fixture for an install with
 * none configured, and the score it carries has to be that install's.
 */
export const aTrendPoint = (
  day: string,
  summary: ContributorSummary,
  reference: FleetReference = fleetReferenceOf([summary], 1),
  capabilities: IntegrationCapabilities = NO_INTEGRATIONS,
): ContributorTrendPoint => ({
  day,
  summary,
  score: computeProductivityScore(summary, reference, capabilities),
});

const unmeasurableScore = (): ProductivityScore => ({
  value: null,
  evidence: 0,
  components: [],
});

/** A bucket whose score nothing could be read from, e.g. a week nobody worked. */
export const anUnscoredTrendPoint = (
  day: string,
  summary: ContributorSummary,
): ContributorTrendPoint => ({
  day,
  summary,
  score: unmeasurableScore(),
});
