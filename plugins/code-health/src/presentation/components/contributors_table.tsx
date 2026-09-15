import { useMemo, useState } from "react";
import { useRouteRef } from "@backstage/core-plugin-api";
import Avatar from "@material-ui/core/Avatar";
import Box from "@material-ui/core/Box";
import Link from "@material-ui/core/Link";
import Tooltip from "@material-ui/core/Tooltip";
import Typography from "@material-ui/core/Typography";
import { makeStyles } from "@material-ui/core/styles";
import HelpOutlineIcon from "@material-ui/icons/HelpOutline";
import OpenInNewIcon from "@material-ui/icons/OpenInNew";
import PersonOutlineIcon from "@material-ui/icons/PersonOutline";
import type {
  ColumnDef,
  ColumnFiltersState,
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
  ContributorSummary,
  FleetReference,
  IntegrationCapabilities,
  ProductivityScore,
  ScoreBand,
  TimeWindow,
} from "@rios0rios0/backstage-plugin-code-health-common";
import {
  catalogEntityPath,
  computeProductivityScore,
  fleetReferenceOf,
  formatScoreValue,
  NO_INTEGRATIONS,
  productivityComponentsFor,
  scoreBand,
  windowDaysOf,
} from "@rios0rios0/backstage-plugin-code-health-common";
import { Link as RouterLink } from "react-router-dom";
import { contributorDetailRouteRef } from "../../routes";
// The page owns the parameter name it reads, and the table is the only thing
// that writes one; importing it is what keeps the two spellings identical.
import { CONTRIBUTOR_KEY_PARAM } from "../pages/contributor_detail_page";
import { confluenceContributorColumns } from "./columns/confluence_columns";
import { jiraContributorColumns } from "./columns/jira_columns";
import {
  hasAiMetrics,
  wakaTimeAiColumns,
  wakaTimeContributorColumns,
} from "./columns/wakatime_columns";
import { DataTable, PaginationControls } from "./data_table";
import { EmptyCell } from "./empty_cell";

interface ContributorsTableProps {
  contributors: ContributorSummary[];
  totalCount: number;
  isLoading: boolean;
  /**
   * The window the rows describe, which every output figure is read as a rate
   * over.
   *
   * Passed in rather than derived from the rows: the rows carry no dates, and
   * the score has to divide by the period that was *asked for* rather than by
   * whatever happens to have activity in it.
   */
  window: TimeWindow;
  /**
   * Which integrations the backend was configured with.
   *
   * The columns for one are built only when it is on. Deciding from the data
   * instead cannot tell a switched-off integration from one that is on and has
   * not collected yet, and it makes a freshly configured install look broken
   * until the first nightly pass.
   */
  capabilities?: IntegrationCapabilities;
}

const formatRate = (rate: number): string => `${rate.toFixed(1)}%`;

const useStyles = makeStyles((theme) => ({
  avatar: { width: 24, height: 24 },
  good: { color: theme.palette.success.main },
  fair: { color: theme.palette.warning.main },
  poor: { color: theme.palette.error.main },
  unknown: { color: theme.palette.text.secondary },
  added: { color: theme.palette.success.main },
  removed: { color: theme.palette.error.main },
  help: { fontSize: "0.85rem", opacity: 0.6 },
  header: { display: "inline-flex", alignItems: "center", gap: 4 },
  secondaryLink: {
    display: "inline-flex",
    alignItems: "center",
    color: theme.palette.text.secondary,
  },
  secondaryIcon: { fontSize: "0.95rem" },
  nameRow: { display: "inline-flex", alignItems: "center", gap: 6 },
  score: { fontWeight: 500, fontVariantNumeric: "tabular-nums" },
}));

const rateTone = (rate: number): "good" | "fair" | "poor" => {
  if (rate >= 80) return "good";
  if (rate >= 50) return "fair";
  return "poor";
};

const RateCell = ({ rate }: { rate: number }) => {
  const classes = useStyles();
  const tone = rateTone(rate);
  return (
    <Typography
      variant="body2"
      component="span"
      className={classes[tone]}
      data-tone={tone}
    >
      {formatRate(rate)}
    </Typography>
  );
};

/**
 * A column heading that explains itself.
 *
 * Every rate on this table divides two numbers that are not obvious from the
 * heading — which pull requests, whose pipeline runs — and a reader who guesses
 * wrong reads the column backwards. The explanation belongs next to the number
 * rather than in documentation nobody has open.
 */
const HeaderWithHelp = ({ label, help }: { label: string; help: string }) => {
  const classes = useStyles();

  return (
    <Box component="span" className={classes.header}>
      {label}
      <Tooltip title={help}>
        {/* Two separate things are needed here, and neither works alone.
            `tabIndex` gives the icon a focus event for MUI to open the tooltip
            on — an SVG has none by default, so without it the explanation is
            mouse-only. `titleAccess` is what carries the text to assistive
            technology: `SvgIcon` stamps `aria-hidden` on every icon that lacks
            one, so an `aria-label` would sit on an element screen readers are
            told to skip. */}
        <HelpOutlineIcon className={classes.help} titleAccess={help} tabIndex={0} />
      </Tooltip>
    </Box>
  );
};

const MetricCell = ({ value }: { value: string | number | null }) =>
  value === null ? (
    <EmptyCell />
  ) : (
    <Typography variant="body2">{value}</Typography>
  );

/** Up to two initials, from a display name or an e-mail local part. */
const initialsOf = (displayName: string): string => {
  const words = displayName
    .replace(/@.*$/, "")
    .split(/[\s._-]+/)
    .filter((word) => word.length > 0);
  return words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
};

/**
 * The person's name, linking to their page here rather than out of the plugin.
 *
 * The name used to lead to the catalog entity, which was the wrong destination
 * once this plugin had something of its own to say about a person: the catalog
 * describes who they are, and the detail page describes how their quarter has
 * gone. Every row now leads somewhere, including a bot's and a commit author's
 * — an account nobody has linked has a key and a history like anybody else, and
 * a row that led nowhere was exactly the row somebody needed to look into.
 *
 * The two outbound links stay, demoted to icons: the catalog entity is where
 * ownership and group membership live, and the provider profile is the only
 * way to reach an account that has no entity at all. The key is encoded because
 * it routinely carries a colon and a slash.
 */
const ContributorName = ({
  contributor,
}: {
  contributor: ContributorSummary;
}) => {
  const classes = useStyles();
  const detailPath = useRouteRef(contributorDetailRouteRef);
  const entityPath =
    contributor.entityRef === null
      ? null
      : catalogEntityPath(contributor.entityRef);

  return (
    <Box component="span" className={classes.nameRow}>
      <Link
        component={RouterLink}
        to={`${detailPath()}?${CONTRIBUTOR_KEY_PARAM}=${encodeURIComponent(contributor.key)}`}
      >
        {contributor.displayName}
      </Link>
      {entityPath === null ? null : (
        <Link
          component={RouterLink}
          to={entityPath}
          title="Open in the catalog"
          className={classes.secondaryLink}
        >
          <PersonOutlineIcon
            className={classes.secondaryIcon}
            titleAccess="Open in the catalog"
          />
        </Link>
      )}
      {contributor.profileUrl === null ? null : (
        <Link
          href={contributor.profileUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="Open the provider profile"
          className={classes.secondaryLink}
        >
          <OpenInNewIcon
            className={classes.secondaryIcon}
            titleAccess="Open the provider profile"
          />
        </Link>
      )}
    </Box>
  );
};

/**
 * The identities merged onto one row, so a total nobody can trace back to its
 * sources stays traceable.
 *
 * Only rendered when there is more than one, because a row that says "vcs" is
 * telling the reader nothing they did not already assume.
 */
const MergedIdentities = ({ contributor }: { contributor: ContributorSummary }) => {
  if (contributor.identities.length < 2) return null;

  const sources = [...new Set(contributor.identities.map((identity) => identity.source))];

  return (
    <Tooltip
      title={contributor.identities
        .map((identity) => `${identity.source}: ${identity.sourceKey}`)
        .join("\n")}
    >
      <Typography variant="caption" color="textSecondary" tabIndex={0}>
        {sources.join(" · ")}
      </Typography>
    </Tooltip>
  );
};

const ContributorCell = ({
  contributor,
}: {
  contributor: ContributorSummary;
}) => {
  const classes = useStyles();
  return (
    <Box display="flex" alignItems="center" gridGap={8}>
      <Avatar
        src={contributor.avatarUrl ?? undefined}
        alt={contributor.displayName}
        className={classes.avatar}
      >
        {/* Most directories populate a photo for only some of their people, so
            the fallback is initials rather than a generic silhouette that would
            make every unphotographed contributor look identical. */}
        {initialsOf(contributor.displayName)}
      </Avatar>
      <Box>
        <ContributorName contributor={contributor} />
        <MergedIdentities contributor={contributor} />
      </Box>
    </Box>
  );
};

/**
 * Churn in whatever unit the provider actually reported.
 *
 * GitHub's commit history carries added and deleted lines. Azure DevOps carries
 * added, edited and deleted *files* and exposes no line count anywhere in its
 * REST API, so a lines column against an Azure DevOps fleet reads `0` on every
 * row — which looks like nobody wrote any code rather than like the provider
 * never said. Each row therefore prints its own unit underneath.
 */
const ChurnCell = ({ contributor }: { contributor: ContributorSummary }) => {
  const classes = useStyles();

  if (contributor.churnUnit === "lines") {
    return (
      <Box>
        <Typography variant="body2">
          {contributor.linesOfCode.toLocaleString()}
        </Typography>
        <Typography variant="caption" color="textSecondary">
          <span className={classes.added}>
            +{contributor.linesAdded.toLocaleString()}
          </span>
          {" / "}
          <span className={classes.removed}>
            -{contributor.linesDeleted.toLocaleString()}
          </span>
        </Typography>
      </Box>
    );
  }

  if (contributor.churnUnit === "files") {
    return (
      <Box>
        <Typography variant="body2">
          {contributor.changedFiles.toLocaleString()}
        </Typography>
        <Typography variant="caption" color="textSecondary">
          files changed
        </Typography>
      </Box>
    );
  }

  return <EmptyCell />;
};

/**
 * What the Sonar columns are, said once and shown on every one of them.
 *
 * A number in a "Bugs" column on a row that carries a person's name reads as
 * that person's bugs. It is not: Sonar measures a project, and the row carries
 * the totals of the repositories the person changed the code of. Without the
 * explanation the column measures whoever works on the oldest repositories.
 */
const SONAR_HELP =
  "Sonar measures a repository, not a person. This is the total over the repositories this person committed to or merged into in the window — what the code they worked on looks like, not what they wrote — so two people on the same repository show the same figure, and reviewing or building there does not count.";

const PRODUCTIVITY_HELP =
  "One score out of 100 over the whole window. Output — commits, merged pull requests, churn and reviews, and the coding time and resolved tickets of whichever integrations are configured — is read as a rate: each total divided by the days the window spans, against the team's average rate over the same period, with twice that average scoring full marks. A quiet month for the whole team is then a quiet month rather than everybody's failure. The denominator is the window rather than the days somebody was active, so a rate is output per elapsed day: a mid-window start or a fortnight of leave lowers it. Documentation written is compared the same way but as a total over Confluence's own trailing window, which the range picker does not move. Reliability and quality — the pipeline success rate, the gate and coverage of the code touched, and how much resolved work stayed resolved — are absolute. Anything that could not be measured is left out rather than scored as zero, so a dash means nothing measurable was recorded. Hover a score for the workings.";

/** A list a person can read, rather than one joined with commas throughout. */
const sentenceList = (items: readonly string[]): string =>
  `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/**
 * The help above, with the components this install actually scores on.
 *
 * The names are taken from the same definitions the score is folded from rather
 * than written out here, because the weights are shared over whatever is
 * configured: with all three integrations on, commits carry about 14% instead
 * of 20%, and a header that had those figures typed into it would be wrong on
 * most installs without ever looking wrong.
 */
const productivityHelp = (capabilities: IntegrationCapabilities): string => {
  const labels = productivityComponentsFor(capabilities).map(
    (definition) => definition.label,
  );

  return `${PRODUCTIVITY_HELP} It is folded from ${sentenceList(labels)}, and those weights are shared out over whatever is configured — switching an integration on moves every one of them.`;
};

/** Which of the theme's status colours each band borrows. */
const BAND_CLASSES: Readonly<Record<ScoreBand, "good" | "fair" | "poor" | "unknown">> = {
  good: "good",
  fair: "fair",
  poor: "poor",
  unknown: "unknown",
};

const ProductivityCell = ({ score }: { score: ProductivityScore }) => {
  const classes = useStyles();
  const band = scoreBand(score.value);

  return (
    <Tooltip
      title={
        // The components, not just the number: a score is an accusation with no
        // evidence until a reader can see which figure pulled it down.
        score.components
          .map((component) => `${component.label}: ${component.detail}`)
          .join("\n")
      }
    >
      <Typography
        variant="body2"
        component="span"
        className={`${classes.score} ${classes[BAND_CLASSES[band]]}`}
        data-band={band}
        tabIndex={0}
      >
        {formatScoreValue(score.value)}
      </Typography>
    </Tooltip>
  );
};

/**
 * The productivity column, bound to the fleet the table is showing.
 *
 * It is a factory rather than a constant because the score is relative: every
 * figure is read against the top one anybody recorded in the same window, so
 * the column cannot be built until the rows are known. Each row's score is
 * computed once and kept, because the accessor runs on every comparison a sort
 * makes and the cell needs the same object's components for its tooltip.
 *
 * The capabilities are the caller's for the same reason the integration column
 * groups are: which components exist is a fact about the backend's
 * configuration, and a row that carries no ticket count cannot say whether Jira
 * is switched off or simply has not been read yet.
 */
const productivityColumn = (
  reference: FleetReference,
  capabilities: IntegrationCapabilities,
): ColumnDef<ContributorSummary> => {
  const scores = new WeakMap<ContributorSummary, ProductivityScore>();
  const scoreOf = (row: ContributorSummary): ProductivityScore => {
    const known = scores.get(row);
    if (known !== undefined) return known;
    const score = computeProductivityScore(row, reference, capabilities);
    scores.set(row, score);
    return score;
  };

  return {
    id: "productivity",
    accessorFn: (row) => scoreOf(row).value,
    header: () => (
      <HeaderWithHelp label="Productivity" help={productivityHelp(capabilities)} />
    ),
    cell: ({ row }) => <ProductivityCell score={scoreOf(row.original)} />,
    enableColumnFilter: false,
  };
};

const columns: ColumnDef<ContributorSummary>[] = [
  {
    accessorKey: "displayName",
    header: "Contributor",
    cell: ({ row }) => <ContributorCell contributor={row.original} />,
    filterFn: "includesString",
  },
  {
    accessorKey: "pullRequestsOpened",
    header: () => (
      <HeaderWithHelp
        label="PRs created"
        help="Pull requests this person opened inside the window. The second figure is how many pull requests of theirs closed as merged in the same window — a pull request opened in one window and merged in the next is counted in each, because neither number is a subset of the other."
      />
    ),
    cell: ({ row }) => (
      <Typography variant="body2" component="span">
        {row.original.pullRequestsOpened.toLocaleString()}{" "}
        <Typography variant="caption" component="span" color="textSecondary">
          / {row.original.pullRequestsMerged.toLocaleString()} merged
        </Typography>
      </Typography>
    ),
    enableColumnFilter: false,
  },
  {
    accessorKey: "reviewsApproved",
    header: () => (
      <HeaderWithHelp
        label="PRs approved"
        help="Other people's pull requests this person reviewed and voted to approve, out of every pull request they reviewed. This is review work done, not their own pull requests: a vote on one's own pull request is not counted, and on Azure DevOps neither is a reviewer who was added and never voted."
      />
    ),
    cell: ({ row }) => (
      <Typography variant="body2" component="span">
        {row.original.reviewsApproved.toLocaleString()}{" "}
        <Typography variant="caption" component="span" color="textSecondary">
          / {row.original.reviewsGiven.toLocaleString()} reviewed
        </Typography>
      </Typography>
    ),
    enableColumnFilter: false,
  },
  {
    id: "churn",
    accessorFn: (row) =>
      row.churnUnit === "lines" ? row.linesOfCode : row.changedFiles,
    header: () => (
      <HeaderWithHelp
        label="Code churn"
        help="Lines added minus lines deleted over the commits this person authored, floored at zero — a window someone spent mostly deleting code is a real contribution, not a negative one. The commit a merge produces is credited to the pull request's author, and a merge commit is not counted at all, so merging somebody else's work adds nothing here. Azure DevOps reports changed files instead and exposes no line count anywhere in its API, so those rows count files. Each row prints its own unit, and the column sorts on whichever it is."
      />
    ),
    cell: ({ row }) => <ChurnCell contributor={row.original} />,
    enableColumnFilter: false,
  },
  {
    accessorKey: "prApprovalRate",
    header: () => (
      <HeaderWithHelp
        label="Approval rate"
        help="Of the pull requests this person reviewed, the share they approved. It describes how someone votes when they review — a low figure means they usually ask for changes — and says nothing about how their own pull requests fare. Nobody reviewing anything reads 0%."
      />
    ),
    cell: ({ getValue }) => <RateCell rate={getValue<number>()} />,
    enableColumnFilter: false,
  },
  {
    accessorKey: "pipelineSuccessRate",
    header: () => (
      <HeaderWithHelp
        label="Pipeline"
        help="Of this person's pipeline runs that reached a verdict, the share that succeeded, with succeeded over decided beside it. Cancelled and skipped runs count on neither side: a run superseded by a newer push is not a failure. A run belongs to the author of the change it built — the pull request whose merge produced the commit, else the commit's own author — never to whoever pressed the merge button."
      />
    ),
    cell: ({ row }) => (
      <Box display="flex" alignItems="baseline" gridGap={4}>
        <RateCell rate={row.original.pipelineSuccessRate} />
        <Typography variant="caption" color="textSecondary">
          ({row.original.pipelineRunsSucceeded}/
          {row.original.pipelineRunsSucceeded + row.original.pipelineRunsFailed})
        </Typography>
      </Box>
    ),
    enableColumnFilter: false,
  },
  {
    id: "bugs",
    accessorFn: (row) => row.sonarMetrics?.bugs ?? null,
    header: () => <HeaderWithHelp label="Bugs" help={SONAR_HELP} />,
    cell: ({ getValue }) => <MetricCell value={getValue<number | null>()} />,
    enableColumnFilter: false,
  },
  {
    id: "codeSmells",
    accessorFn: (row) => row.sonarMetrics?.codeSmells ?? null,
    header: () => <HeaderWithHelp label="Smells" help={SONAR_HELP} />,
    cell: ({ getValue }) => <MetricCell value={getValue<number | null>()} />,
    enableColumnFilter: false,
  },
  {
    id: "securityHotspots",
    accessorFn: (row) => row.sonarMetrics?.securityHotspots ?? null,
    header: () => <HeaderWithHelp label="Hotspots" help={SONAR_HELP} />,
    cell: ({ getValue }) => <MetricCell value={getValue<number | null>()} />,
    enableColumnFilter: false,
  },
  {
    id: "vulnerabilities",
    accessorFn: (row) => row.sonarMetrics?.vulnerabilities ?? null,
    header: () => <HeaderWithHelp label="Vulns" help={SONAR_HELP} />,
    cell: ({ getValue }) => <MetricCell value={getValue<number | null>()} />,
    enableColumnFilter: false,
  },
  {
    id: "coverage",
    accessorFn: (row) => row.sonarMetrics?.coverage ?? null,
    header: () => <HeaderWithHelp label="Coverage" help={SONAR_HELP} />,
    cell: ({ getValue }) => {
      const v = getValue<number | null>();
      return <MetricCell value={v !== null ? formatRate(v) : null} />;
    },
    enableColumnFilter: false,
  },
  {
    id: "duplications",
    accessorFn: (row) => row.sonarMetrics?.duplications ?? null,
    header: () => <HeaderWithHelp label="Dups" help={SONAR_HELP} />,
    cell: ({ getValue }) => {
      const v = getValue<number | null>();
      return <MetricCell value={v !== null ? formatRate(v) : null} />;
    },
    enableColumnFilter: false,
  },
  {
    id: "technicalDebt",
    accessorFn: (row) => row.sonarMetrics?.technicalDebt ?? null,
    header: () => <HeaderWithHelp label="Debt" help={SONAR_HELP} />,
    cell: ({ getValue }) => <MetricCell value={getValue<string | null>()} />,
    enableColumnFilter: false,
  },
];

// Productivity sits immediately after the name, because it is the one column
// that answers the question the table is opened with; everything to its right
// is a figure the score was composed from.
const [nameColumn, ...metricColumns] = columns;

export const ContributorsTable = ({
  contributors,
  totalCount,
  isLoading,
  window,
  capabilities = NO_INTEGRATIONS,
}: ContributorsTableProps) => {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "churn", desc: true },
  ]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);

  // The score is relative, so the column cannot exist before the rows do: every
  // figure is read as a rate against the team's average rate in the same window.
  const days = windowDaysOf(window);
  const reference = useMemo(
    () => fleetReferenceOf(contributors, days),
    [contributors, days],
  );

  // Held on the three flags rather than on the object, because the productivity
  // column now needs the whole of it and caches a score per row inside itself.
  // A caller re-reading its capabilities into a fresh object every render would
  // otherwise rebuild the column, and throw that cache away, on every keystroke
  // in the filter box.
  const gates = useMemo<IntegrationCapabilities>(
    () => ({
      wakatime: capabilities.wakatime,
      jira: capabilities.jira,
      confluence: capabilities.confluence,
    }),
    [capabilities.wakatime, capabilities.jira, capabilities.confluence],
  );

  // The AI columns are gated on the data as well as on the integration, because
  // they are collected separately and opting out of them is a supported way to
  // run WakaTime — a screen of em dashes reads as a fault rather than a choice.
  const showAiColumns = gates.wakatime && hasAiMetrics(contributors);
  const allColumns = useMemo(
    () => [
      nameColumn,
      productivityColumn(reference, gates),
      ...metricColumns,
      ...(gates.wakatime ? wakaTimeContributorColumns() : []),
      ...(showAiColumns ? wakaTimeAiColumns() : []),
      ...(gates.jira ? jiraContributorColumns() : []),
      ...(gates.confluence ? confluenceContributorColumns() : []),
    ],
    [reference, gates, showAiColumns],
  );

  const table = useReactTable({
    data: contributors,
    columns: allColumns,
    state: { sorting, columnFilters },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 25 } },
  });

  if (!isLoading && contributors.length === 0) {
    return (
      <Box py={6} textAlign="center">
        <Typography color="textSecondary">No contributors found.</Typography>
      </Box>
    );
  }

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
        <Box display="flex" alignItems="center" gridGap={12}>
          <Typography variant="body2" color="textSecondary">
            {table.getFilteredRowModel().rows.length} of {totalCount}{" "}
            contributors
          </Typography>
        </Box>
        <PaginationControls
          pageIndex={table.getState().pagination.pageIndex}
          pageCount={table.getPageCount()}
          canPreviousPage={table.getCanPreviousPage()}
          canNextPage={table.getCanNextPage()}
          onPrevious={() => table.previousPage()}
          onNext={() => table.nextPage()}
        />
      </Box>

      <DataTable table={table} isLoading={isLoading} skeletonRows={5} />
    </>
  );
};
