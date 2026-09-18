import { useCallback, useMemo, useState } from "react";
import { useRouteRef } from "@backstage/core-plugin-api";
import Avatar from "@material-ui/core/Avatar";
import Box from "@material-ui/core/Box";
import Checkbox from "@material-ui/core/Checkbox";
import FormControlLabel from "@material-ui/core/FormControlLabel";
import Link from "@material-ui/core/Link";
import Paper from "@material-ui/core/Paper";
import Tooltip from "@material-ui/core/Tooltip";
import Typography from "@material-ui/core/Typography";
import { makeStyles } from "@material-ui/core/styles";
import HelpOutlineIcon from "@material-ui/icons/HelpOutline";
import LaunchIcon from "@material-ui/icons/Launch";
import type { ColumnDef, ColumnFiltersState, SortingState } from "@tanstack/react-table";
import {
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import type {
  EntityProfile,
  IntegrationCapabilities,
  RepositoryHealthScore,
  RepositorySummary,
  ScoreBand,
} from "@rios0rios0/backstage-plugin-code-health-common";
import {
  catalogEntityPath,
  computeRepositoryHealthScore,
  NO_INTEGRATIONS,
  parseEntityRef,
  scoreBand,
} from "@rios0rios0/backstage-plugin-code-health-common";
import { Link as RouterLink } from "react-router-dom";
import { DEFAULT_EXPECTED_BRANCH } from "../../domain/entities/code_health_config";
import type { StatusTone } from "../../domain/entities/insights";
import type { RepositoryAuditId } from "../../domain/entities/repository_audit";
import { countAuditMatches, filterByAudits } from "../../domain/entities/repository_audit";
import { repositoryDetailRouteRef } from "../../routes";
import { useChartPalette } from "./charts/chart_palette";
import { BadgeStatusCell } from "./badge_status_cell";
import { ComplianceBadge } from "./compliance_badge";
import { DataTable, DEFAULT_PAGE_SIZE, PaginationControls } from "./data_table";
import { ApiExposureBadge } from "./api_exposure_badge";
import { DocumentationBadge } from "./documentation_badge";
import { confluenceRepositoryColumns } from "./columns/confluence_columns";
import { jiraRepositoryColumns } from "./columns/jira_columns";
import { wakaTimeRepositoryColumns } from "./columns/wakatime_columns";
import { EmptyCell } from "./empty_cell";
import { RepositoryAuditFilters } from "./repository_audit_filters";
import { StateChip } from "./state_chip";
import { StatusBadge } from "./status_badge";

interface RepositoryTableProps {
  repositories: RepositorySummary[];
  totalCount: number;
  isLoading: boolean;
  /** Which integrations the backend was configured with. */
  capabilities?: IntegrationCapabilities;
  /**
   * The branch name a repository is expected to have defaulted to, from
   * `codeHealth.expectedDefaultBranch`.
   *
   * Defaulted here as well as in the config reader so a caller embedding the
   * table — and every test that does not care — gets the same expectation the
   * dashboard has rather than an empty one, which would flag the whole fleet.
   */
  expectedDefaultBranch?: string;
}

const formatRelativeDate = (dateString: string): string => {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 30) return `${diffDays}d ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
};

const useBranchStyles = makeStyles((theme) => ({
  anchor: { position: "relative" },
  overlay: { position: "fixed", inset: 0, zIndex: theme.zIndex.modal - 1 },
  popup: {
    position: "absolute",
    left: 0,
    top: "100%",
    zIndex: theme.zIndex.modal,
    marginTop: theme.spacing(0.5),
    width: 224,
    maxHeight: 240,
    overflowY: "auto",
  },
  list: { listStyle: "none", margin: 0, padding: theme.spacing(0.5, 0) },
  item: { padding: theme.spacing(0.5, 1.5) },
  monospace: { fontFamily: "monospace" },
}));

const BranchesCell = ({
  branches,
  defaultBranch,
}: {
  branches: readonly string[];
  defaultBranch: string;
}) => {
  const classes = useBranchStyles();
  const [open, setOpen] = useState(false);
  const nonDefault = branches.filter((b) => b !== defaultBranch);

  const toggle = useCallback(() => setOpen((prev) => !prev), []);

  return (
    <div className={classes.anchor}>
      <StateChip
        tone="neutral"
        label={String(nonDefault.length)}
        onClick={toggle}
        ariaExpanded={open}
      />
      {open && (
        <>
          <div
            data-testid="branches-overlay"
            className={classes.overlay}
            onClick={toggle}
            aria-hidden="true"
          />
          <Paper elevation={8} className={classes.popup} role="menu" aria-label="Branches">
            {nonDefault.length === 0 ? (
              <Box p={1.5}>
                <Typography variant="caption" color="textSecondary">
                  No extra branches
                </Typography>
              </Box>
            ) : (
              <ul className={classes.list}>
                {nonDefault.map((branch) => (
                  <li key={branch} className={classes.item}>
                    <Typography variant="caption">{branch}</Typography>
                  </li>
                ))}
              </ul>
            )}
          </Paper>
        </>
      )}
    </div>
  );
};

const DefaultBranchCell = ({ branch, expected }: { branch: string; expected: string }) => {
  const classes = useBranchStyles();

  if (branch !== expected) {
    return (
      <StateChip
        tone="warning"
        label={branch}
        title={`Default branch is not '${expected}'`}
      />
    );
  }

  return (
    <Typography variant="caption" className={classes.monospace}>
      {branch}
    </Typography>
  );
};

const MetricCell = ({ value }: { value: string | number | null }) =>
  value === null ? <EmptyCell /> : <Typography variant="body2">{value}</Typography>;

const useHealthStyles = makeStyles((theme) => ({
  // Icon-only on purpose: the cell's text is the repository's name, and a second
  // word beside it would read as part of that name in a dense table.
  catalogIcon: {
    fontSize: theme.typography.pxToRem(14),
    color: theme.palette.text.secondary,
    display: "block",
  },
  score: { fontVariantNumeric: "tabular-nums", fontWeight: 500 },
  helpIcon: {
    fontSize: theme.typography.pxToRem(13),
    marginLeft: theme.spacing(0.5),
    verticalAlign: "middle",
    color: theme.palette.text.secondary,
  },
  componentRow: { display: "block" },
}));

const RepositoryNameCell = ({ repository }: { repository: RepositorySummary }) => {
  const classes = useHealthStyles();
  // The name now opens the plugin's own page for the repository: that is where
  // its history, its health score and the people working on it live, and it is
  // the drill-down a reader clicking a row is asking for. The catalog entity —
  // where the owner, docs and other entity tabs are — stays one click away as a
  // secondary icon, because following it leaves the plugin.
  const detailPath = useRouteRef(repositoryDetailRouteRef)({ id: repository.id });
  const entityPath = catalogEntityPath(repository.entityRef);

  return (
    <Box>
      <Box display="flex" alignItems="center" gridGap={8}>
        <Link component={RouterLink} to={detailPath} title="Open the repository's history">
          {repository.fullName}
        </Link>
        {entityPath === null ? null : (
          // A reference the catalog cannot address loses this link rather than
          // rendering one that would 404.
          <Link
            component={RouterLink}
            to={entityPath}
            title="Open in the catalog"
            aria-label={`Open ${repository.fullName} in the catalog`}
          >
            <LaunchIcon className={classes.catalogIcon} />
          </Link>
        )}
        {repository.isArchived && <StateChip tone="warning" label="archived" />}
        {repository.isFork && <StateChip tone="info" label="fork" />}
      </Box>
      {repository.description && (
        <Typography variant="caption" color="textSecondary" noWrap component="p">
          {repository.description}
        </Typography>
      )}
    </Box>
  );
};

const useOwnerStyles = makeStyles((theme) => ({
  row: { display: "flex", alignItems: "center", gap: theme.spacing(1) },
  avatar: { width: 24, height: 24, fontSize: "0.7rem" },
}));

/** Up to two initials, from a display name or an e-mail-shaped slug. */
const ownerInitials = (name: string): string =>
  name
    .replace(/@.*$/u, "")
    .split(/[\s._-]+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");

/**
 * The owner as a person or a team rather than as a slug, linked to the entity.
 *
 * The photograph and the name come from the owning entity's `spec.profile`,
 * resolved by the backend when the row was built — the same fields the
 * contributors table reads, so one human looks the same on both screens. This
 * column used to print `metadata.name`, which for a directory that names users
 * after their address reads `j.doe_example.com` on every row and left a
 * reader translating slugs back into people by hand.
 *
 * The slug is the fallback, not an error: an owner the catalog no longer holds
 * still says who the YAML names. A reference the catalog cannot address at all
 * degrades to an empty cell rather than to a link that would 404 — the same
 * rule the repository name follows.
 */
const OwnerCell = ({
  ownerRef,
  profile,
}: {
  ownerRef: string | null;
  profile: EntityProfile | null;
}) => {
  const classes = useOwnerStyles();
  const parsed = ownerRef === null ? null : parseEntityRef(ownerRef);
  const path = ownerRef === null ? null : catalogEntityPath(ownerRef);

  if (parsed === null || path === null) return <EmptyCell />;

  const name = profile?.displayName ?? parsed.name;

  return (
    <Box className={classes.row}>
      <Avatar src={profile?.picture ?? undefined} alt="" className={classes.avatar}>
        {/* Initials rather than a silhouette, for the same reason the
            contributors table uses them: most directories photograph only some
            of their people, and a generic icon makes every team identical. */}
        {ownerInitials(name)}
      </Avatar>
      <Link component={RouterLink} to={path} title={ownerRef ?? undefined}>
        <Typography variant="body2" component="span">
          {name}
        </Typography>
      </Link>
    </Box>
  );
};

/**
 * The name a `spec.owner` goes under for sorting and filtering.
 *
 * The resolved display name where there is one, so filtering for "Platform"
 * matches what the reader can actually see — a column that sorts and filters
 * on a hidden slug is a column whose order nobody can predict.
 */
const ownerNameOf = (row: RepositorySummary): string =>
  row.ownerProfile?.displayName ??
  (row.ownerRef === null ? "" : (parseEntityRef(row.ownerRef)?.name ?? ""));

/** Which of the reserved status colours each band borrows. */
const HEALTH_BAND_TONES: Readonly<Record<ScoreBand, StatusTone>> = {
  good: "good",
  fair: "warning",
  poor: "critical",
  unknown: "unknown",
};

const HEALTH_HELP =
  "How well a repository is looked after, as one number: its Sonar gate, coverage, defects, duplication and debt; its default-branch build and build success rate; its branch and build policy; its documentation; and how its pull requests were reviewed and landed. Every part is absolute, and a part that could not be measured is left out rather than scored as zero — hover a score for the workings.";

const HealthHeader = () => {
  const classes = useHealthStyles();

  return (
    <>
      Health
      <Tooltip title={HEALTH_HELP}>
        <HelpOutlineIcon className={classes.helpIcon} aria-label="What the health score is" />
      </Tooltip>
    </>
  );
};

/**
 * The score, coloured by its band, with its workings behind a tooltip.
 *
 * The workings travel with the number wherever it goes: a bare 62 on a row is a
 * verdict nobody can act on, and the components' sentences are what turn it back
 * into a list of things somebody can fix.
 */
const HealthScoreCell = ({ score }: { score: RepositoryHealthScore }) => {
  const classes = useHealthStyles();
  const palette = useChartPalette();

  if (score.value === null) return <EmptyCell />;

  const band = scoreBand(score.value);

  return (
    <Tooltip
      title={
        <>
          {score.components.map((component) => (
            <Typography key={component.id} variant="caption" className={classes.componentRow}>
              {`${component.label}: ${component.detail}`}
            </Typography>
          ))}
        </>
      }
    >
      <Typography
        variant="body2"
        className={classes.score}
        style={{ color: palette.status[HEALTH_BAND_TONES[band]] }}
        data-band={band}
      >
        {score.value}
      </Typography>
    </Tooltip>
  );
};

/**
 * Unmeasured rows sort below every measured one.
 *
 * Sorting has to put them somewhere, and below is the only place that does not
 * claim something: above the worst-scoring repository would read as a top
 * ranking, and interleaving them at zero would read as a failing grade. The
 * cell itself stays empty, so nothing on screen ever says minus one.
 */
const UNMEASURED_HEALTH = -1;

/**
 * What the columns need from the data and the configuration before they can be
 * built.
 *
 * The Default Branch column reads both: the cell warns against the configured
 * expectation, and its filter offers the branch names the fleet actually uses
 * rather than a field to type one into. Nobody can filter for `trunk` without
 * first knowing some repository defaults to it, which is exactly what a select
 * built from the data says and a text box does not.
 */
interface ColumnOptions {
  readonly expectedDefaultBranch: string;
  readonly defaultBranches: readonly string[];
}

/**
 * How every select filter words the rows no snapshot has reached.
 *
 * One wording for all of them, because it is one fact about the row rather
 * than a state of each column. The *value* behind it differs — `none` here,
 * `unknown` there — because each accessor already folded null to its own
 * sentinel, which is why offering the option was all these needed: the filter
 * matched it all along and nothing put it on screen.
 */
const NOT_MEASURED = "Not measured";

const buildColumns = ({
  expectedDefaultBranch,
  defaultBranches,
}: ColumnOptions): ColumnDef<RepositorySummary>[] => [
  {
    accessorKey: "fullName",
    header: "Repository",
    cell: ({ row }) => <RepositoryNameCell repository={row.original} />,
    filterFn: "includesString",
  },
  {
    id: "owner",
    accessorFn: ownerNameOf,
    header: "Owner",
    cell: ({ row }) => (
      <OwnerCell
        ownerRef={row.original.ownerRef}
        profile={row.original.ownerProfile}
      />
    ),
    filterFn: "includesString",
  },
  {
    id: "health",
    accessorFn: (row) => computeRepositoryHealthScore(row).value ?? UNMEASURED_HEALTH,
    header: () => <HealthHeader />,
    cell: ({ row }) => <HealthScoreCell score={computeRepositoryHealthScore(row.original)} />,
    enableColumnFilter: false,
  },
  {
    accessorKey: "defaultBranch",
    header: "Default Branch",
    cell: ({ getValue }) => (
      <DefaultBranchCell branch={getValue<string>()} expected={expectedDefaultBranch} />
    ),
    // A select over the branches present, not a text field. Free text could
    // only find a branch the reader had already guessed at — `master` if they
    // thought to try it, never the one `develop` repository they did not know
    // about. "Not `main`" is the same question asked the other way round and
    // is the "Non-standard branch" audit above the table.
    meta: { filterType: "select", options: defaultBranches },
    filterFn: (row, _columnId, filterValue) => {
      if (!filterValue) return true;
      return row.original.defaultBranch === filterValue;
    },
  },
  {
    id: "branches",
    accessorFn: (row) => row.branches.filter((branch) => branch !== row.defaultBranch).length,
    header: "Branches",
    cell: ({ row }) => (
      <BranchesCell branches={row.original.branches} defaultBranch={row.original.defaultBranch} />
    ),
    enableColumnFilter: false,
  },
  {
    id: "ciStatus",
    accessorFn: (row) => row.ciStatus?.state ?? "NONE",
    header: "CI Status",
    cell: ({ row }) => <StatusBadge state={row.original.ciStatus?.state ?? null} />,
    filterFn: (row, _columnId, filterValue) => {
      if (!filterValue || filterValue === "all") return true;
      const state = row.original.ciStatus?.state ?? null;
      if (filterValue === "passing") return state === "SUCCESS";
      if (filterValue === "failing") return state !== null && state !== "SUCCESS";
      if (filterValue === "no-ci") return state === null;
      // The precise fact, rather than the absence of a run standing in for it.
      // `no-ci` is "nothing has run on the default branch", which is also true
      // of a repository whose pipeline exists and only fires on a tag, or one
      // configured this morning. `pipelineExists` is what the provider was
      // actually asked — workflow files on GitHub, build definitions on Azure
      // DevOps — and it was collected all along, readable only inside the
      // compliance chip's tooltip. `=== false` so a repository nothing has
      // snapshotted is not reported as having no pipeline.
      if (filterValue === "no-pipeline") {
        return row.original.complianceStatus?.pipelineExists === false;
      }
      return true;
    },
    meta: {
      filterType: "select",
      options: [
        { value: "passing", label: "Passing" },
        { value: "failing", label: "Failing" },
        { value: "no-ci", label: "No run yet" },
        { value: "no-pipeline", label: "No pipeline defined" },
      ],
    },
  },
  {
    id: "compliance",
    accessorFn: (row) => row.complianceStatus?.color ?? "none",
    header: "Compliance",
    cell: ({ row }) => <ComplianceBadge status={row.original.complianceStatus} />,
    // The badge's own words. The options used to be the stored colours, so the
    // filter said `red` while the chip one cell away said "Non-compliant" and
    // left the reader to pair them up. "Amber or red" — the question somebody
    // managing a fleet actually has — is a negation this select still cannot
    // express, and is the "Non-compliant" audit above the table.
    meta: {
      filterType: "select",
      options: [
        { value: "red", label: "Non-compliant" },
        { value: "yellow", label: "Partial" },
        { value: "green", label: "Compliant" },
        { value: "none", label: NOT_MEASURED },
      ],
    },
    filterFn: (row, _columnId, filterValue) => {
      if (!filterValue) return true;
      return (row.original.complianceStatus?.color ?? "none") === filterValue;
    },
  },
  {
    id: "badges",
    accessorFn: (row) => row.badgeStatus?.color ?? "none",
    header: "Badges",
    cell: ({ row }) => <BadgeStatusCell status={row.original.badgeStatus} />,
    meta: {
      filterType: "select",
      options: [
        { value: "green", label: "Complete" },
        { value: "yellow", label: "Incomplete" },
        { value: "none", label: NOT_MEASURED },
      ],
    },
    filterFn: (row, _columnId, filterValue) => {
      if (!filterValue) return true;
      return (row.original.badgeStatus?.color ?? "none") === filterValue;
    },
  },
  {
    id: "documentation",
    accessorFn: (row) => row.documentation?.state ?? "unknown",
    header: "Docs",
    cell: ({ row }) => <DocumentationBadge status={row.original.documentation} />,
    meta: {
      filterType: "select",
      // Each label is the word `DocumentationBadge` puts in the cell. A filter
      // that invented its own wording would be the same defect as one showing
      // the stored state name.
      options: [
        { value: "documented", label: "TechDocs" },
        { value: "unpublished", label: "Unpublished" },
        { value: "missing", label: "None" },
        { value: "not-expected", label: "Archived" },
        { value: "unknown", label: NOT_MEASURED },
      ],
    },
    filterFn: (row, _columnId, filterValue) => {
      if (!filterValue) return true;
      return (row.original.documentation?.state ?? "unknown") === filterValue;
    },
  },
  {
    id: "apiExposure",
    accessorFn: (row) => row.apiExposure?.state ?? "unknown",
    header: "API",
    cell: ({ row }) => <ApiExposureBadge exposure={row.original.apiExposure} />,
    meta: {
      filterType: "select",
      // As with Docs: the words `ApiExposureBadge` renders, not a second set.
      options: [
        { value: "declared", label: "Declared" },
        { value: "candidate", label: "Undeclared" },
        { value: "expected", label: "Likely" },
        { value: "none", label: "None" },
        { value: "unknown", label: NOT_MEASURED },
      ],
    },
    filterFn: (row, _columnId, filterValue) => {
      if (!filterValue) return true;
      return (row.original.apiExposure?.state ?? "unknown") === filterValue;
    },
  },
  {
    accessorKey: "primaryLanguage",
    header: "Language",
    cell: ({ getValue }) => {
      const lang = getValue<string | null>();
      return lang ? <StateChip tone="info" label={lang} /> : <EmptyCell />;
    },
    filterFn: "includesString",
  },
  {
    id: "latestRelease",
    accessorFn: (row) => row.latestRelease?.tagName ?? "",
    header: "Release",
    cell: ({ row }) => {
      const release = row.original.latestRelease;
      if (!release) return <EmptyCell />;
      return (
        <Link href={release.url} target="_blank" rel="noopener noreferrer">
          <Typography variant="caption" component="span" style={{ fontFamily: "monospace" }}>
            {release.tagName}
          </Typography>{" "}
          <Typography variant="caption" component="span" color="textSecondary">
            {formatRelativeDate(release.publishedAt)}
          </Typography>
        </Link>
      );
    },
    filterFn: "includesString",
  },
  {
    id: "latestTag",
    accessorFn: (row) => row.latestTag?.name ?? "",
    header: "Tag",
    cell: ({ row }) => {
      const tag = row.original.latestTag;
      return tag ? (
        <Typography variant="caption" style={{ fontFamily: "monospace" }}>
          {tag.name}
        </Typography>
      ) : (
        <EmptyCell />
      );
    },
    filterFn: "includesString",
  },
  {
    accessorKey: "updatedAt",
    header: "Updated",
    cell: ({ getValue }) => (
      <Typography variant="caption" color="textSecondary">
        {formatRelativeDate(getValue<string>())}
      </Typography>
    ),
    enableColumnFilter: false,
  },
  {
    accessorKey: "visibility",
    header: "Visibility",
    cell: ({ getValue }) =>
      getValue<string>() === "PRIVATE" ? (
        <StateChip tone="neutral" label="private" />
      ) : (
        <Typography variant="caption" color="textSecondary">
          public
        </Typography>
      ),
    meta: {
      filterType: "select",
      options: [
        { value: "PUBLIC", label: "Public" },
        { value: "PRIVATE", label: "Private" },
      ],
    },
    filterFn: (row, _columnId, filterValue) => {
      if (!filterValue) return true;
      return row.original.visibility === filterValue;
    },
  },
  {
    id: "qualityGate",
    accessorFn: (row) => row.sonarMetrics?.qualityGateStatus ?? "NONE",
    header: "Quality Gate",
    cell: ({ row }) => {
      const status = row.original.sonarMetrics?.qualityGateStatus;
      if (!status || status === "NONE") return <EmptyCell />;
      return status === "OK" ? (
        <StateChip tone="success" label="Passed" />
      ) : (
        <StateChip tone="error" label="Failed" />
      );
    },
    meta: {
      filterType: "select",
      options: [
        { value: "OK", label: "Passed" },
        { value: "ERROR", label: "Failed" },
        { value: "NONE", label: "No Sonar project" },
      ],
    },
    filterFn: (row, _columnId, filterValue) => {
      if (!filterValue) return true;
      return (row.original.sonarMetrics?.qualityGateStatus ?? "NONE") === filterValue;
    },
  },
  {
    id: "sonarBugs",
    accessorFn: (row) => row.sonarMetrics?.bugs ?? null,
    header: "Bugs",
    cell: ({ getValue }) => <MetricCell value={getValue<number | null>()} />,
    enableColumnFilter: false,
  },
  {
    id: "sonarSmells",
    accessorFn: (row) => row.sonarMetrics?.codeSmells ?? null,
    header: "Smells",
    cell: ({ getValue }) => <MetricCell value={getValue<number | null>()} />,
    enableColumnFilter: false,
  },
  {
    id: "sonarVulns",
    accessorFn: (row) => row.sonarMetrics?.vulnerabilities ?? null,
    header: "Vulns",
    cell: ({ getValue }) => <MetricCell value={getValue<number | null>()} />,
    enableColumnFilter: false,
  },
  {
    id: "sonarHotspots",
    accessorFn: (row) => row.sonarMetrics?.securityHotspots ?? null,
    header: "Hotspots",
    cell: ({ getValue }) => <MetricCell value={getValue<number | null>()} />,
    enableColumnFilter: false,
  },
  {
    id: "sonarCoverage",
    accessorFn: (row) => row.sonarMetrics?.coverage ?? null,
    header: "Coverage",
    cell: ({ getValue }) => {
      const v = getValue<number | null>();
      return <MetricCell value={v !== null ? `${v.toFixed(1)}%` : null} />;
    },
    enableColumnFilter: false,
  },
  {
    id: "sonarDups",
    accessorFn: (row) => row.sonarMetrics?.duplications ?? null,
    header: "Dups",
    cell: ({ getValue }) => {
      const v = getValue<number | null>();
      return <MetricCell value={v !== null ? `${v.toFixed(1)}%` : null} />;
    },
    enableColumnFilter: false,
  },
  {
    id: "sonarDebt",
    accessorFn: (row) => row.sonarMetrics?.technicalDebt ?? null,
    header: "Debt",
    cell: ({ getValue }) => <MetricCell value={getValue<string | null>()} />,
    enableColumnFilter: false,
  },
];

export const RepositoryTable = ({
  repositories,
  totalCount,
  isLoading,
  capabilities = NO_INTEGRATIONS,
  expectedDefaultBranch = DEFAULT_EXPECTED_BRANCH,
}: RepositoryTableProps) => {
  const [sorting, setSorting] = useState<SortingState>([{ id: "fullName", desc: false }]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [showForks, setShowForks] = useState(false);
  const [audits, setAudits] = useState<readonly RepositoryAuditId[]>([]);

  const auditContext = useMemo(
    () => ({ expectedDefaultBranch }),
    [expectedDefaultBranch],
  );

  // The two toggles come first, so an archived repository nobody owns is not
  // counted as an ownership gap on a screen that is not showing it.
  const included = useMemo(() => {
    let data = repositories;
    if (!showArchived) data = data.filter((r) => !r.isArchived);
    if (!showForks) data = data.filter((r) => !r.isFork);
    return data;
  }, [repositories, showArchived, showForks]);

  const auditCounts = useMemo(
    () => countAuditMatches(included, auditContext),
    [included, auditContext],
  );

  const filteredData = useMemo(
    () => filterByAudits(included, audits, auditContext),
    [included, audits, auditContext],
  );

  // Built from every row rather than from the filtered ones, so the branches on
  // offer do not disappear as the reader narrows — a select whose options move
  // under the selection is one nobody can navigate back out of.
  const defaultBranches = useMemo(
    () => Array.from(new Set(repositories.map((r) => r.defaultBranch))).sort(),
    [repositories],
  );

  const allColumns = useMemo(
    () => [
      ...buildColumns({ expectedDefaultBranch, defaultBranches }),
      ...(capabilities.wakatime ? wakaTimeRepositoryColumns() : []),
      ...(capabilities.jira ? jiraRepositoryColumns() : []),
      ...(capabilities.confluence ? confluenceRepositoryColumns() : []),
    ],
    [
      expectedDefaultBranch,
      defaultBranches,
      capabilities.wakatime,
      capabilities.jira,
      capabilities.confluence,
    ],
  );

  const table = useReactTable({
    data: filteredData,
    columns: allColumns,
    state: { sorting, columnFilters },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: DEFAULT_PAGE_SIZE } },
  });

  /**
   * Narrowing sends the reader back to the first page.
   *
   * These filters change `data` rather than TanStack's own column filter
   * state, so nothing resets the page index for them: a reader on page three
   * who ticks an audit matching four repositories would otherwise be left
   * looking at an empty table with "3 / 1" under it.
   */
  const resetPage = useCallback(() => table.setPageIndex(0), [table]);

  const toggleAudit = useCallback(
    (id: RepositoryAuditId) => {
      setAudits((current) =>
        current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
      );
      resetPage();
    },
    [resetPage],
  );

  const clearAudits = useCallback(() => {
    setAudits([]);
    resetPage();
  }, [resetPage]);

  if (!isLoading && repositories.length === 0) {
    return (
      <Box py={6} textAlign="center">
        <Typography color="textSecondary">No repositories found.</Typography>
      </Box>
    );
  }

  return (
    <>
      {/* Above the count, because it is the control that decides what the count
          is counting, and because it is the one filter a reader scanning a
          fleet is looking for before they read a single row. */}
      <Box mb={1}>
        <RepositoryAuditFilters
          counts={auditCounts}
          selected={audits}
          context={auditContext}
          onToggle={toggleAudit}
          onClear={clearAudits}
        />
      </Box>

      <Box
        display="flex"
        alignItems="center"
        justifyContent="space-between"
        flexWrap="wrap"
        mb={1}
        gridGap={8}
      >
        <Box display="flex" alignItems="center" gridGap={16}>
          <Typography variant="body2" color="textSecondary">
            {table.getFilteredRowModel().rows.length} of {totalCount} repositories
          </Typography>
          <FormControlLabel
            label="Archived"
            control={
              <Checkbox
                size="small"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
              />
            }
          />
          <FormControlLabel
            label="Forks"
            control={
              <Checkbox
                size="small"
                checked={showForks}
                onChange={(e) => setShowForks(e.target.checked)}
              />
            }
          />
        </Box>
        <PaginationControls table={table} />
      </Box>

      <DataTable table={table} isLoading={isLoading} skeletonRows={8} />
    </>
  );
};
