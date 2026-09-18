import type {
  ComplianceStatus,
  WorkflowStatus,
} from "@rios0rios0/backstage-plugin-code-health-common";
import type { FilterOption } from "../data_table";

/**
 * The filter vocabulary every table shares, in one place.
 *
 * The repositories table and the owned-repositories card render the same facts
 * through the same `DataTable`, so a reader who filters Compliance by
 * "Non-compliant" on the tab and clicks into a person has to find that same
 * word on their card. When these lists were written out in both files they
 * diverged the moment one was corrected — which is the argument for them being
 * one list rather than two that agree today.
 *
 * Every label is the word the column's own badge renders, not a second
 * vocabulary invented for the filter: the selects used to offer the stored
 * values, so Compliance said `red` while the chip one cell away said
 * "Non-compliant" and left the reader to pair them up.
 */

/**
 * How every select words the rows no snapshot has reached.
 *
 * One wording for all of them, because it is one fact about the row rather
 * than a state of each column. The *value* behind it differs — `none` here,
 * `unknown` there, `NONE` for Sonar — because each accessor already folded
 * null to its own sentinel, which is why offering the option was all these
 * needed: the filter matched it all along and nothing put it on screen.
 */
export const NOT_MEASURED = "Not measured";

export const CI_FILTER_OPTIONS: readonly FilterOption[] = [
  { value: "passing", label: "Passing" },
  { value: "failing", label: "Failing" },
  { value: "no-ci", label: "No run yet" },
  { value: "no-pipeline", label: "No pipeline defined" },
];

export const COMPLIANCE_FILTER_OPTIONS: readonly FilterOption[] = [
  { value: "red", label: "Non-compliant" },
  { value: "yellow", label: "Partial" },
  { value: "green", label: "Compliant" },
  { value: "none", label: NOT_MEASURED },
];

/** The words `BadgeStatusCell` puts in the cell. */
export const BADGE_FILTER_OPTIONS: readonly FilterOption[] = [
  { value: "green", label: "Complete" },
  { value: "yellow", label: "Incomplete" },
  { value: "none", label: NOT_MEASURED },
];

/** The words `DocumentationBadge` puts in the cell. */
export const DOCUMENTATION_FILTER_OPTIONS: readonly FilterOption[] = [
  { value: "documented", label: "TechDocs" },
  { value: "unpublished", label: "Unpublished" },
  { value: "missing", label: "None" },
  { value: "not-expected", label: "Archived" },
  { value: "unknown", label: NOT_MEASURED },
];

/** The words `ApiExposureBadge` puts in the cell. */
export const API_EXPOSURE_FILTER_OPTIONS: readonly FilterOption[] = [
  { value: "declared", label: "Declared" },
  { value: "candidate", label: "Undeclared" },
  { value: "expected", label: "Likely" },
  { value: "none", label: "None" },
  { value: "unknown", label: NOT_MEASURED },
];

export const VISIBILITY_FILTER_OPTIONS: readonly FilterOption[] = [
  { value: "PUBLIC", label: "Public" },
  { value: "PRIVATE", label: "Private" },
];

/**
 * The gate cell prints "Passed" and "Failed" and leaves the third state empty,
 * so that one is named rather than quoted — an empty cell has no word to
 * borrow, and "no Sonar project" is what the emptiness means.
 */
export const QUALITY_GATE_FILTER_OPTIONS: readonly FilterOption[] = [
  { value: "OK", label: "Passed" },
  { value: "ERROR", label: "Failed" },
  { value: "NONE", label: "No Sonar project" },
];

/** What the CI filter reads off a row, whichever table the row came from. */
export interface CiFilterSubject {
  readonly ciStatus: WorkflowStatus | null;
  readonly complianceStatus: ComplianceStatus | null;
}

/**
 * One predicate per CI filter value, dispatched by lookup.
 *
 * `no-ci` and `no-pipeline` are the pair worth keeping apart. The first is the
 * absence of a *run* on the default branch, which is also true of a pipeline
 * that only fires on a tag and of one configured this morning. The second is
 * the provider saying no definition exists — workflow files on GitHub, build
 * definitions on Azure DevOps — which was collected all along and readable
 * only inside the compliance chip's tooltip. It reads `=== false` so a
 * repository nothing has snapshotted is not reported as having no pipeline: an
 * unknown pipeline is not a missing one.
 */
const CI_FILTERS: ReadonlyMap<string, (subject: CiFilterSubject) => boolean> = new Map([
  ["passing", ({ ciStatus }: CiFilterSubject) => ciStatus?.state === "SUCCESS"],
  [
    "failing",
    ({ ciStatus }: CiFilterSubject) => ciStatus !== null && ciStatus.state !== "SUCCESS",
  ],
  ["no-ci", ({ ciStatus }: CiFilterSubject) => ciStatus === null],
  [
    "no-pipeline",
    ({ complianceStatus }: CiFilterSubject) => complianceStatus?.pipelineExists === false,
  ],
]);

/**
 * Whether a row survives the CI filter.
 *
 * A value no predicate is registered under is no filter at all, which covers
 * the blank "any" option and the literal `all` these selects used to carry
 * beside it. Saying it once here is what lets both tables answer the filter
 * identically rather than each keeping its own chain of comparisons — the
 * shape in which they drifted apart.
 */
export const matchesCiFilter = (subject: CiFilterSubject, filterValue: string): boolean => {
  const predicate = CI_FILTERS.get(filterValue);
  return predicate === undefined || predicate(subject);
};
