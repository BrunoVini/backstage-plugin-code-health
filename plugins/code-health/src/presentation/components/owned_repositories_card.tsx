import { InfoCard, Progress, WarningPanel } from "@backstage/core-components";
import { useRouteRef } from "@backstage/core-plugin-api";
import Box from "@material-ui/core/Box";
import Link from "@material-ui/core/Link";
import Tooltip from "@material-ui/core/Tooltip";
import Typography from "@material-ui/core/Typography";
import { makeStyles } from "@material-ui/core/styles";
import type {
  ColumnDef,
  ColumnFiltersState,
  SortingFn,
  SortingState,
} from "@tanstack/react-table";
import {
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import type {
  OwnershipInfo,
  RepositoryHealthScore,
  RepositorySummary,
  ScoreBand,
} from "@rios0rios0/backstage-plugin-code-health-common";
import {
  computeRepositoryHealthScore,
  formatScoreValue,
  scoreBand,
} from "@rios0rios0/backstage-plugin-code-health-common";
import { useMemo, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import { repositoryDetailRouteRef, rootRouteRef } from "../../routes";
import {
  CI_FILTER_OPTIONS,
  COMPLIANCE_FILTER_OPTIONS,
  DOCUMENTATION_FILTER_OPTIONS,
  matchesCiFilter,
  QUALITY_GATE_FILTER_OPTIONS,
} from "./columns/filter_options";
import { ComplianceBadge } from "./compliance_badge";
import { DataTable, PaginationControls } from "./data_table";
import { DocumentationBadge } from "./documentation_badge";
import { EmptyCell } from "./empty_cell";
import { SCORE_BAND_LABELS } from "./score_card";
import { StateChip } from "./state_chip";
import { StatusBadge } from "./status_badge";

const useStyles = makeStyles((theme) => ({
  score: { fontWeight: 500, fontVariantNumeric: "tabular-nums" },
  owners: { display: "block", marginTop: theme.spacing(1) },
  explanation: { color: theme.palette.text.secondary },
}));

/**
 * Which of the theme's status colours each band borrows.
 *
 * The same three the rate columns already use, so a score of 40 on this card
 * and an approval rate of 40% on the contributors table read as the same
 * degree of bad rather than as two unrelated palettes.
 */
const BAND_COLORS: Readonly<Record<ScoreBand, "success" | "warning" | "error" | "disabled">> =
  {
    good: "success",
    fair: "warning",
    poor: "error",
    unknown: "disabled",
  };

const useBandStyles = makeStyles((theme) => ({
  success: { color: theme.palette.success.main },
  warning: { color: theme.palette.warning.main },
  error: { color: theme.palette.error.main },
  disabled: { color: theme.palette.text.secondary },
}));

/** A repository with its health worked out once, so sorting and rendering agree. */
export interface GradedRepository {
  readonly repository: RepositorySummary;
  readonly score: RepositoryHealthScore;
}

export const gradeRepositories = (
  repositories: readonly RepositorySummary[],
): GradedRepository[] =>
  repositories.map((repository) => ({
    repository,
    score: computeRepositoryHealthScore(repository),
  }));

/**
 * A card that shares its page with a dozen charts opens on ten rows rather
 * than the tables' twenty-five, so what is below it is still on the screen.
 */
export const OWNED_PAGE_SIZE = 10;

const HEALTH_COLUMN = "health";

/**
 * Numbers in order, with the unmeasured after every measured one — whichever
 * way the column is sorted.
 *
 * A repository nothing has measured yet is not the worst one and not the best
 * one; it is a different problem, and belongs at the end of either reading.
 * TanStack multiplies a sorting function's answer by minus one for a
 * descending sort, so keeping the unmeasured at the end in both directions
 * means folding the direction into the answer here rather than letting the
 * table flip it: an unmeasured row answers "after" when ascending and
 * "before" when descending, which the table then flips back to "after".
 */
const measuredFirst =
  <T,>(pick: (row: T) => number | null, descending: boolean): SortingFn<T> =>
  (left, right) => {
    const a = pick(left.original);
    const b = pick(right.original);
    if (a === null && b === null) return 0;
    const toEnd = descending ? -1 : 1;
    if (a === null) return toEnd;
    if (b === null) return -toEnd;
    return a - b;
  };

const HealthCell = ({ score }: { score: RepositoryHealthScore }) => {
  const classes = useStyles();
  const bands = useBandStyles();
  const band = scoreBand(score.value);

  return (
    <Tooltip
      title={
        // The whole working, not just the number: a repository graded 41 with
        // one measured component and one graded 41 with eleven are different
        // claims, and only the components say which this is.
        score.components
          .map((component) => `${component.label}: ${component.detail}`)
          .join("\n")
      }
    >
      <Typography
        variant="body2"
        component="span"
        className={`${classes.score} ${bands[BAND_COLORS[band]]}`}
        data-band={band}
        tabIndex={0}
        aria-label={`Health ${formatScoreValue(score.value)} out of 100, ${SCORE_BAND_LABELS[band]}`}
      >
        {formatScoreValue(score.value)}
      </Typography>
    </Tooltip>
  );
};

const QualityGateCell = ({ repository }: { repository: RepositorySummary }) => {
  const status = repository.sonarMetrics?.qualityGateStatus;
  if (!status || status === "NONE") return <EmptyCell />;
  return status === "OK" ? (
    <StateChip tone="success" label="Passed" />
  ) : (
    <StateChip tone="error" label="Failed" />
  );
};

const MetricCell = ({ value }: { value: string | number | null }) =>
  value === null ? <EmptyCell /> : <Typography variant="body2">{value}</Typography>;

const RepositoryNameCell = ({ repository }: { repository: RepositorySummary }) => {
  const repositoryPath = useRouteRef(repositoryDetailRouteRef);

  return (
    <Link
      component={RouterLink}
      to={repositoryPath({ id: repository.id })}
      title="Open the repository's page"
    >
      {repository.name}
    </Link>
  );
};

/**
 * The columns, sorted the way the reader last asked.
 *
 * Every column sorts, filters where a filter means something, and the
 * nullable ones keep their unmeasured rows at the end in both directions —
 * which is why the sort direction of each is an input here rather than
 * something the table applies afterwards.
 */
const columnsFor = (descending: (column: string) => boolean): ColumnDef<GradedRepository>[] => [
  {
    id: "name",
    accessorFn: (row) => row.repository.name,
    header: "Repository",
    cell: ({ row }) => <RepositoryNameCell repository={row.original.repository} />,
    filterFn: "includesString",
  },
  {
    id: HEALTH_COLUMN,
    accessorFn: (row) => row.score.value,
    header: "Health",
    cell: ({ row }) => <HealthCell score={row.original.score} />,
    sortingFn: measuredFirst((row) => row.score.value, descending(HEALTH_COLUMN)),
    // The card opens worst first, so the first click on the heading has to
    // turn that around to best first rather than switch the sorting off — which
    // is what the numeric default, descending first, would do from here.
    sortDescFirst: false,
    enableColumnFilter: false,
  },
  {
    id: "qualityGate",
    accessorFn: (row) => row.repository.sonarMetrics?.qualityGateStatus ?? "NONE",
    header: "Quality gate",
    cell: ({ row }) => <QualityGateCell repository={row.original.repository} />,
    meta: { filterType: "select", options: QUALITY_GATE_FILTER_OPTIONS },
    filterFn: (row, _columnId, filterValue) => {
      if (!filterValue) return true;
      return (row.original.repository.sonarMetrics?.qualityGateStatus ?? "NONE") === filterValue;
    },
  },
  {
    id: "bugs",
    accessorFn: (row) => row.repository.sonarMetrics?.bugs ?? null,
    header: "Bugs",
    cell: ({ getValue }) => <MetricCell value={getValue<number | null>()} />,
    sortingFn: measuredFirst(
      (row) => row.repository.sonarMetrics?.bugs ?? null,
      descending("bugs"),
    ),
    enableColumnFilter: false,
  },
  {
    id: "vulnerabilities",
    accessorFn: (row) => row.repository.sonarMetrics?.vulnerabilities ?? null,
    header: "Vulns",
    cell: ({ getValue }) => <MetricCell value={getValue<number | null>()} />,
    sortingFn: measuredFirst(
      (row) => row.repository.sonarMetrics?.vulnerabilities ?? null,
      descending("vulnerabilities"),
    ),
    enableColumnFilter: false,
  },
  {
    id: "coverage",
    accessorFn: (row) => row.repository.sonarMetrics?.coverage ?? null,
    header: "Coverage",
    cell: ({ getValue }) => {
      const value = getValue<number | null>();
      return <MetricCell value={value === null ? null : `${value.toFixed(1)}%`} />;
    },
    sortingFn: measuredFirst(
      (row) => row.repository.sonarMetrics?.coverage ?? null,
      descending("coverage"),
    ),
    enableColumnFilter: false,
  },
  {
    id: "debt",
    // Sorted on the minutes, printed as the duration Sonar phrased it.
    accessorFn: (row) => row.repository.sonarMetrics?.technicalDebtMinutes ?? null,
    header: "Debt",
    cell: ({ row }) => (
      <MetricCell value={row.original.repository.sonarMetrics?.technicalDebt ?? null} />
    ),
    sortingFn: measuredFirst(
      (row) => row.repository.sonarMetrics?.technicalDebtMinutes ?? null,
      descending("debt"),
    ),
    enableColumnFilter: false,
  },
  {
    id: "ci",
    accessorFn: (row) => row.repository.ciStatus?.state ?? "NONE",
    header: "CI",
    cell: ({ row }) => <StatusBadge state={row.original.repository.ciStatus?.state ?? null} />,
    filterFn: (row, _columnId, filterValue) =>
      matchesCiFilter(row.original.repository, String(filterValue)),
    meta: { filterType: "select", options: CI_FILTER_OPTIONS },
  },
  {
    id: "compliance",
    accessorFn: (row) => row.repository.complianceStatus?.color ?? "none",
    header: "Compliance",
    cell: ({ row }) => <ComplianceBadge status={row.original.repository.complianceStatus} />,
    meta: { filterType: "select", options: COMPLIANCE_FILTER_OPTIONS },
    filterFn: (row, _columnId, filterValue) => {
      if (!filterValue) return true;
      return (row.original.repository.complianceStatus?.color ?? "none") === filterValue;
    },
  },
  {
    id: "documentation",
    accessorFn: (row) => row.repository.documentation?.state ?? "unknown",
    header: "Docs",
    cell: ({ row }) => <DocumentationBadge status={row.original.repository.documentation} />,
    meta: { filterType: "select", options: DOCUMENTATION_FILTER_OPTIONS },
    filterFn: (row, _columnId, filterValue) => {
      if (!filterValue) return true;
      return (row.original.repository.documentation?.state ?? "unknown") === filterValue;
    },
  },
];

/**
 * Worst first, with the unmeasured after everything measured.
 *
 * Ascending because the reason to open somebody's page is to find what needs
 * attention, and a list that leads with the healthiest repository buries it.
 * The reader can turn any column around; this is only where it opens.
 */
const INITIAL_SORTING: SortingState = [{ id: HEALTH_COLUMN, desc: false }];

const OwnedTable = ({ graded }: { graded: GradedRepository[] }) => {
  const [sorting, setSorting] = useState<SortingState>(INITIAL_SORTING);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);

  // Rebuilt when the sorting changes, because the nullable columns fold the
  // direction into their comparison; the state itself lives outside them, so
  // a rebuild costs the ten definitions and nothing the reader can see.
  const columns = useMemo(
    () =>
      columnsFor(
        (column) => sorting.find((entry) => entry.id === column)?.desc ?? false,
      ),
    [sorting],
  );

  const table = useReactTable({
    data: graded,
    columns,
    state: { sorting, columnFilters },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    getRowId: (row) => row.repository.id,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: OWNED_PAGE_SIZE } },
  });

  return (
    <>
      <Box
        display="flex"
        alignItems="center"
        justifyContent="space-between"
        flexWrap="wrap"
        mb={1}
        gridGap={8}
      >
        <Typography variant="body2" color="textSecondary">
          {table.getFilteredRowModel().rows.length} of {graded.length} repositories
        </Typography>
        <PaginationControls table={table} />
      </Box>
      <DataTable table={table} isLoading={false} label="Owned repositories" />
    </>
  );
};

export interface OwnedRepositoriesCardProps {
  readonly ownership: OwnershipInfo | null;
  readonly repositories: readonly RepositorySummary[];
  readonly isLoading: boolean;
  readonly error: string | null;
}

/**
 * What this person is responsible for, and how it is holding up.
 *
 * Responsibility here is the catalog's `spec.owner` matched against the
 * person's `User` entity and the groups they belong to — deliberately a
 * different question from where they committed. Somebody can own a repository
 * they have not touched all quarter, and that is precisely the row worth
 * seeing on their page.
 *
 * The three empty states are three different conversations, so none of them is
 * allowed to collapse into "no repositories": an unlinked account cannot own
 * anything at all until somebody links it, a linked person may genuinely own
 * nothing, and either is different from a request that failed.
 */
export const OwnedRepositoriesCard = ({
  ownership,
  repositories,
  isLoading,
  error,
}: OwnedRepositoriesCardProps) => {
  const classes = useStyles();
  const rootPath = useRouteRef(rootRouteRef);
  const graded = useMemo(() => gradeRepositories(repositories), [repositories]);

  // The tab lives directly under the plugin root; the trailing slash a route ref
  // may or may not carry would otherwise double up in the middle of the path.
  const identitiesPath = `${rootPath().replace(/\/$/u, "")}/identities`;

  const body = () => {
    if (error !== null) {
      return (
        <WarningPanel
          severity="error"
          title="Failed to load the owned repositories"
          message={error}
        />
      );
    }

    if (ownership === null) return isLoading ? <Progress /> : null;

    if (ownership.entityRef === null) {
      return (
        <Typography variant="body2" className={classes.explanation}>
          This account is not linked to a catalog user, so there is nobody for a
          repository to name as its owner. Link it on the{" "}
          <Link component={RouterLink} to={identitiesPath}>
            Identities tab
          </Link>{" "}
          and whatever their user or their groups own will appear here.
        </Typography>
      );
    }

    if (graded.length === 0) {
      return (
        <Typography variant="body2" className={classes.explanation}>
          No catalog entity names {ownership.entityRef} — or any group they belong
          to — as its owner, so nothing here is theirs to look after.
          {ownership.owners.length > 0 ? (
            <Typography variant="caption" component="span" className={classes.owners}>
              Matched against: {ownership.owners.join(", ")}.
            </Typography>
          ) : null}
        </Typography>
      );
    }

    return <OwnedTable graded={graded} />;
  };

  return (
    <InfoCard
      title="Owned repositories"
      subheader="Repositories whose catalog entity names this person, or a group they belong to, as its owner. Worst health first — this is the list to work down — and every column sorts and filters like the tables."
    >
      <Box>{body()}</Box>
    </InfoCard>
  );
};
