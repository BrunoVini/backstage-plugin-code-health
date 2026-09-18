import Box from "@material-ui/core/Box";
import Tooltip from "@material-ui/core/Tooltip";
import Typography from "@material-ui/core/Typography";
import { makeStyles } from "@material-ui/core/styles";
import HelpOutlineIcon from "@material-ui/icons/HelpOutline";
import type {
  ContributorSummary,
  RepositorySummary,
  WakaTimeBreakdownItem,
} from "@rios0rios0/backstage-plugin-code-health-common";
import {
  aiAuthorshipShare,
  formatCount,
  formatDuration,
  formatPercent,
  formatTokens,
} from "@rios0rios0/backstage-plugin-code-health-common";
import type { ColumnDef } from "@tanstack/react-table";
import { EmptyCell } from "../empty_cell";

const useStyles = makeStyles(() => ({
  help: { fontSize: "0.85rem", opacity: 0.6 },
  header: { display: "inline-flex", alignItems: "center", gap: 4 },
}));

/**
 * A heading that explains itself.
 *
 * Deliberately a copy of the contributors table's own helper rather than an
 * import of it. Every integration contributes its columns as a self-contained
 * module, and reaching into the table for a private component would make the
 * table the thing that has to change whenever an integration is added — which
 * is exactly what the split exists to prevent.
 */
const HeaderWithHelp = ({ label, help }: { label: string; help: string }) => {
  const classes = useStyles();

  return (
    <Box component="span" className={classes.header}>
      {label}
      <Tooltip title={help}>
        <HelpOutlineIcon className={classes.help} titleAccess={help} tabIndex={0} />
      </Tooltip>
    </Box>
  );
};

/**
 * A figure with a quieter one beneath it.
 *
 * An unmeasurable headline still keeps its caption when there is one. The AI
 * share is the case that forces this: a window in which nobody wrote a line has
 * no share to report, but the three prompts that were made are a real
 * measurement, and collapsing the whole cell to an em dash would throw it away.
 */
const StackedCell = ({
  value,
  caption,
}: {
  value: string | null;
  caption?: string | null;
}) => {
  const hasCaption = caption !== null && caption !== undefined;
  if (value === null && !hasCaption) return <EmptyCell />;

  return (
    <Box>
      {value === null ? <EmptyCell /> : <Typography variant="body2">{value}</Typography>}
      {hasCaption ? (
        <Typography variant="caption" color="textSecondary" display="block">
          {caption}
        </Typography>
      ) : null}
    </Box>
  );
};

const topSlice = (
  items: readonly WakaTimeBreakdownItem[],
): WakaTimeBreakdownItem | null => items[0] ?? null;

/**
 * Coding time, and the shape of it.
 *
 * A factory rather than a constant, so nothing is built for an integration the
 * backend was never configured with.
 */
export const wakaTimeContributorColumns = (): ColumnDef<ContributorSummary>[] => [
  {
    id: "codingTime",
    accessorFn: (row) => row.wakaTimeMetrics?.totalSeconds ?? -1,
    header: () => (
      <HeaderWithHelp
        label="Coding time"
        help="Time WakaTime recorded in an editor inside the window, with the average across the days it covers beneath. It measures where somebody's attention went, which no version control provider can see — four hours of debugging leave no commit behind."
      />
    ),
    cell: ({ row }) => {
      const metrics = row.original.wakaTimeMetrics;
      return (
        <StackedCell
          value={metrics === null ? null : formatDuration(metrics.totalSeconds)}
          caption={
            metrics === null ? null : `${formatDuration(metrics.dailyAverageSeconds)}/day`
          }
        />
      );
    },
    enableColumnFilter: false,
  },
  {
    id: "activeDays",
    accessorFn: (row) => row.wakaTimeMetrics?.activeDays ?? -1,
    header: () => (
      <HeaderWithHelp
        label="Active days"
        help="Days inside the window with any recorded activity, out of the days the window covers. A high total spread over two days and the same total spread over ten are different weeks."
      />
    ),
    cell: ({ row }) => {
      const metrics = row.original.wakaTimeMetrics;
      return (
        <StackedCell
          value={metrics === null ? null : formatCount(metrics.activeDays)}
          caption={metrics === null ? null : `of ${formatCount(metrics.measuredDays)}`}
        />
      );
    },
    enableColumnFilter: false,
  },
  {
    id: "topLanguage",
    accessorFn: (row) => topSlice(row.wakaTimeMetrics?.languages ?? [])?.name ?? "",
    header: "Language",
    cell: ({ row }) => {
      const top = topSlice(row.original.wakaTimeMetrics?.languages ?? []);
      return (
        <StackedCell
          value={top?.name ?? null}
          caption={top === null ? null : formatPercent(top.percent)}
        />
      );
    },
    enableColumnFilter: false,
  },
  {
    id: "branchesTouched",
    accessorFn: (row) => row.wakaTimeMetrics?.branches.length ?? -1,
    header: () => (
      <HeaderWithHelp
        label="Branches"
        help="Distinct branches WakaTime saw an editor open inside the window. It counts branches somebody worked on, including ones that never produced a commit — which is the difference between this and anything the repository can tell you."
      />
    ),
    cell: ({ row }) => {
      const metrics = row.original.wakaTimeMetrics;
      const top = topSlice(metrics?.branches ?? []);
      return (
        <StackedCell
          value={metrics === null ? null : formatCount(metrics.branches.length)}
          caption={top?.name ?? null}
        />
      );
    },
    enableColumnFilter: false,
  },
  {
    id: "filesTouched",
    accessorFn: (row) => row.wakaTimeMetrics?.filesTouched ?? -1,
    header: () => (
      <HeaderWithHelp
        label="Files"
        help="Distinct files an editor was open in. WakaTime only reports this on some plans, and a plan that does not report it leaves the cell empty rather than claiming nobody opened a file."
      />
    ),
    cell: ({ row }) => {
      const files = row.original.wakaTimeMetrics?.filesTouched ?? null;
      return <StackedCell value={files === null ? null : formatCount(files)} />;
    },
    enableColumnFilter: false,
  },
];

/**
 * Token counts and AI authorship.
 *
 * Split out because they are collected differently — one request per person per
 * day against one for the whole window — so a fleet can perfectly reasonably
 * have coding time and no AI figures at all. Rendering the columns anyway would
 * fill a screen with em dashes that look like a fault.
 */
export const wakaTimeAiColumns = (): ColumnDef<ContributorSummary>[] => [
  {
    id: "aiTokens",
    accessorFn: (row) => {
      const ai = row.wakaTimeMetrics?.ai;
      return ai === null || ai === undefined ? -1 : ai.inputTokens + ai.outputTokens;
    },
    header: () => (
      <HeaderWithHelp
        label="AI tokens"
        help="Prompt and completion tokens WakaTime's editor plugins recorded, input and output beneath. This is the only place any system here can see a token count — no version control provider knows whether a line was typed or accepted from a completion."
      />
    ),
    cell: ({ row }) => {
      const ai = row.original.wakaTimeMetrics?.ai ?? null;
      return (
        <StackedCell
          value={ai === null ? null : formatTokens(ai.inputTokens + ai.outputTokens)}
          caption={
            ai === null
              ? null
              : `${formatTokens(ai.inputTokens)} in / ${formatTokens(ai.outputTokens)} out`
          }
        />
      );
    },
    enableColumnFilter: false,
  },
  {
    id: "aiAuthorship",
    accessorFn: (row) => {
      const ai = row.wakaTimeMetrics?.ai;
      return ai === null || ai === undefined ? -1 : (aiAuthorshipShare(ai) ?? -1);
    },
    header: () => (
      <HeaderWithHelp
        label="AI lines"
        help="Share of the lines added in an editor that WakaTime attributed to AI rather than to typing, with the prompt count beneath. A window in which nothing was written at all reads empty, not 0% — nobody wrote anything is not the same as a human wrote everything."
      />
    ),
    cell: ({ row }) => {
      const ai = row.original.wakaTimeMetrics?.ai ?? null;
      const share = ai === null ? null : aiAuthorshipShare(ai);
      return (
        <StackedCell
          value={share === null ? null : formatPercent(share)}
          caption={ai === null ? null : `${formatCount(ai.prompts)} prompts`}
        />
      );
    },
    enableColumnFilter: false,
  },
];

/** Whether any row on the page actually carries AI figures. */
export const hasAiMetrics = (contributors: readonly ContributorSummary[]): boolean =>
  contributors.some(
    (contributor) =>
      contributor.wakaTimeMetrics !== null && contributor.wakaTimeMetrics.ai !== null,
  );

export const wakaTimeRepositoryColumns = (): ColumnDef<RepositorySummary>[] => [
  {
    id: "repositoryCodingTime",
    accessorFn: (row) => row.wakaTimeMetrics?.totalSeconds ?? -1,
    header: () => (
      <HeaderWithHelp
        label="Coding time"
        help="Time logged against the matching WakaTime project inside the window, and how many people logged it. The project is matched to the repository by name, or by the `wakatime.com/project` annotation when the catalog entity names one; a repository nothing matched is empty rather than zero."
      />
    ),
    cell: ({ row }) => {
      const metrics = row.original.wakaTimeMetrics;
      return (
        <StackedCell
          value={metrics === null ? null : formatDuration(metrics.totalSeconds)}
          caption={
            metrics === null
              ? null
              : `${formatCount(metrics.contributors)} ${
                  metrics.contributors === 1 ? "person" : "people"
                }`
          }
        />
      );
    },
    enableColumnFilter: false,
  },
];
