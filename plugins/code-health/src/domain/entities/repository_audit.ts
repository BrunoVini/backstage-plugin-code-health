import type { RepositorySummary } from "@rios0rios0/backstage-plugin-code-health-common";

/**
 * The gaps a repository can have, as things somebody can filter the fleet down
 * to.
 *
 * Every one of these facts was already on the row and none of them was
 * reachable from a filter. The table's filter vocabulary is a substring match
 * or an equality select, and the four columns that carry the audit facts are
 * exactly the ones that cannot be asked about that way: "no owner" is the
 * *absence* of a value, "not `main`" is a *negation*, "non-compliant" is
 * *either* of two values, and "no pipeline" is a boolean buried inside the
 * compliance chip's tooltip. So the reader could see the blanks and the amber
 * chips and had no way to select them.
 *
 * The division of labour with the column filters is deliberate: an audit
 * answers "which repositories have this gap", a column filter answers "which
 * value does this column have". Absence and negation belong here; picking
 * `master` out of the branches the fleet actually uses belongs there.
 */
export type RepositoryAuditId =
  | "unowned"
  | "no-pipeline"
  | "no-branch-protection"
  | "non-standard-branch"
  | "non-compliant"
  | "unmeasured";

/** What an audit needs to know beyond the row itself. */
export interface RepositoryAuditContext {
  /** The branch name the fleet has standardised on. */
  readonly expectedDefaultBranch: string;
}

export interface RepositoryAudit {
  readonly id: RepositoryAuditId;
  /** The chip's label — short, because six of them share one row. */
  readonly label: string;
  /**
   * What the chip matches, and where it deliberately stops. Every one of these
   * says what it does *not* match, because the pairs that look alike here
   * ("no pipeline" against "no run yet", "non-compliant" against "never
   * measured") are the ones a reader would otherwise mistake for each other.
   */
  readonly describe: (context: RepositoryAuditContext) => string;
  readonly matches: (repository: RepositorySummary, context: RepositoryAuditContext) => boolean;
}

/**
 * The audits, in the order the chips are drawn.
 *
 * Ownership first because it is the one gap nothing else on the screen reports
 * at all, then the two policy facts that need a provider setting changed, then
 * the branch, then the two summaries.
 *
 * Note what every compliance-derived audit does *not* do: it never treats a
 * missing `complianceStatus` as a failure. `pipelineExists === false` is a
 * measurement, `complianceStatus === null` is the absence of one, and the
 * plugin's rule everywhere else is that an unmeasured thing is left out rather
 * than scored as zero — a repository that has never been snapshotted has an
 * unknown pipeline, not a missing one. That is what the `unmeasured` audit is
 * for, and why it is its own chip rather than folded into the others.
 */
export const REPOSITORY_AUDITS: readonly RepositoryAudit[] = [
  {
    id: "unowned",
    label: "No owner",
    describe: () =>
      "The catalog entity declares no `spec.owner`, so nothing says who is responsible for this repository.",
    matches: (repository) => repository.ownerRef === null,
  },
  {
    id: "no-pipeline",
    label: "No pipeline",
    describe: () =>
      "No workflow or build definition exists at all. A repository that has one which simply has not run yet is not matched — that is the CI column's “no run yet”.",
    matches: (repository) => repository.complianceStatus?.pipelineExists === false,
  },
  {
    id: "no-branch-protection",
    label: "No branch protection",
    describe: () => "Nothing blocks a direct push to the default branch.",
    matches: (repository) => repository.complianceStatus?.branchProtection === false,
  },
  {
    id: "non-standard-branch",
    label: "Non-standard branch",
    describe: ({ expectedDefaultBranch }) =>
      `The default branch is not \`${expectedDefaultBranch}\`. This is the only audit that reads a configured expectation rather than a measurement — set \`codeHealth.expectedDefaultBranch\` if the fleet standardised on something else.`,
    // The empty string is "never measured", not "wrong". `defaultBranch` is
    // typed `string`, but the backend folds an unknown one into `""` rather
    // than into null: discovery does not learn a default branch, only
    // ingestion does, and `unsnapshotted` fills the gap with `""`. Without
    // this guard a fresh install reports its entire fleet as being on the
    // wrong branch, on the very rows the "Never measured" chip is counting —
    // two chips contradicting each other, with the one actionable gap buried
    // in a count of everything. A repository whose ingestion never learned a
    // branch, an empty one or one whose provider call failed, would stay
    // flagged indefinitely.
    matches: (repository, { expectedDefaultBranch }) =>
      repository.defaultBranch !== "" && repository.defaultBranch !== expectedDefaultBranch,
  },
  {
    id: "non-compliant",
    label: "Non-compliant",
    describe: () =>
      "At least one of the four policy checks failed — the Compliance column's amber and red together, which is the question a reader actually has and the one thing that column's filter could not express. A repository nothing has measured yet is not matched.",
    matches: (repository) =>
      repository.complianceStatus !== null && repository.complianceStatus.color !== "green",
  },
  {
    id: "unmeasured",
    label: "Never measured",
    describe: () =>
      "No snapshot has been taken, so the policy, documentation and API columns are blank rather than failing. On a fresh install this is the whole fleet until the first nightly pass.",
    matches: (repository) => repository.complianceStatus === null,
  },
];

/**
 * The audits by id, so a selection is dispatched through a lookup rather than
 * through a chain of comparisons. Adding an audit is adding an entry to
 * {@link REPOSITORY_AUDITS}; nothing here has to be edited for it.
 */
const AUDITS_BY_ID: ReadonlyMap<RepositoryAuditId, RepositoryAudit> = new Map(
  REPOSITORY_AUDITS.map((audit) => [audit.id, audit]),
);

export const repositoryAuditById = (id: RepositoryAuditId): RepositoryAudit | undefined =>
  AUDITS_BY_ID.get(id);

/**
 * How many repositories each audit matches.
 *
 * Counted over the rows handed in rather than over the selection's result, so
 * the number beside a chip is the size of that population and does not flicker
 * as other chips are picked. The "N of M repositories" line above the table is
 * what reports the intersection.
 */
export const countAuditMatches = (
  repositories: readonly RepositorySummary[],
  context: RepositoryAuditContext,
): ReadonlyMap<RepositoryAuditId, number> =>
  new Map(
    REPOSITORY_AUDITS.map((audit) => [
      audit.id,
      repositories.filter((repository) => audit.matches(repository, context)).length,
    ]),
  );

/**
 * The repositories matching every selected audit.
 *
 * Intersection rather than union, for two reasons: every other filter on the
 * table narrows, so a set of chips that widened would make the two kinds of
 * control disagree about what picking more of them does; and each chip already
 * carries its own count, so the populations are legible one at a time without
 * needing a union. An empty selection is not a filter.
 *
 * An id with no audit behind it is ignored rather than throwing — the selection
 * can outlive a release that removed one.
 */
export const filterByAudits = (
  repositories: readonly RepositorySummary[],
  selected: readonly RepositoryAuditId[],
  context: RepositoryAuditContext,
): RepositorySummary[] => {
  const audits = selected
    .map((id) => AUDITS_BY_ID.get(id))
    .filter((audit): audit is RepositoryAudit => audit !== undefined);

  if (audits.length === 0) return [...repositories];

  return repositories.filter((repository) =>
    audits.every((audit) => audit.matches(repository, context)),
  );
};
