import Box from "@material-ui/core/Box";
import Tooltip from "@material-ui/core/Tooltip";
import Typography from "@material-ui/core/Typography";
import { makeStyles } from "@material-ui/core/styles";
import HelpOutlineIcon from "@material-ui/icons/HelpOutline";
import type {
  ContributorSummary,
  JiraInteractions,
  RepositorySummary,
} from "@rios0rios0/backstage-plugin-code-health-common";
import {
  formatCount,
  formatDecimal,
  formatHours,
  formatPercent,
  interactionTotal,
  interactionsAreComplete,
  meanHours,
} from "@rios0rios0/backstage-plugin-code-health-common";
import type { ColumnDef } from "@tanstack/react-table";
import { EmptyCell } from "../empty_cell";

/**
 * The Jira columns, built only when the backend says Jira is configured.
 *
 * Exported as factories rather than as constants so that nothing is
 * constructed for an installation without an Atlassian credential — the point
 * of the capability flag is that a switched-off integration costs nothing, and
 * a module-level array is built whether anybody asked for it or not.
 */

const useStyles = makeStyles((theme) => ({
  help: { fontSize: "0.85rem", opacity: 0.6 },
  header: { display: "inline-flex", alignItems: "center", gap: 4 },
  caption: { color: theme.palette.text.secondary },
  rework: { color: theme.palette.error.main },
}));

/**
 * A column heading that explains itself.
 *
 * The same shape as the one on the contributors table, and deliberately its own
 * copy: that one is private to its module, and reaching into it would couple
 * two tables that have no other reason to know about each other. Every figure
 * in these columns divides or attributes something a reader would otherwise
 * have to guess at — whose ticket, measured from when — and a heading nobody
 * can decode is a column read backwards.
 */
const HeaderWithHelp = ({ label, help }: { label: string; help: string }) => {
  const classes = useStyles();

  return (
    <Box component="span" className={classes.header}>
      {label}
      <Tooltip title={help}>
        {/* `tabIndex` gives the SVG a focus event for MUI to open the tooltip
            on, and `titleAccess` is what carries the text to assistive
            technology — `SvgIcon` stamps `aria-hidden` on any icon without one,
            so an `aria-label` would sit on an element screen readers skip. */}
        <HelpOutlineIcon className={classes.help} titleAccess={help} tabIndex={0} />
      </Tooltip>
    </Box>
  );
};

/**
 * A figure with a smaller one underneath.
 *
 * Absence renders as an em dash rather than as a zero, because "Jira never
 * reported this" and "this was zero" are different statements and the second
 * one is an accusation.
 */
const StackedCell = ({
  value,
  caption,
}: {
  value: string | null;
  caption?: string | null;
}) => {
  const classes = useStyles();
  if (value === null) return <EmptyCell />;

  return (
    <Box>
      <Typography variant="body2">{value}</Typography>
      {caption ? (
        <Typography variant="caption" className={classes.caption}>
          {caption}
        </Typography>
      ) : null}
    </Box>
  );
};

/**
 * Interactions, with what they were made of underneath.
 *
 * The breakdown is printed rather than hidden in a tooltip because the three
 * components are not interchangeable: a hundred transitions and no comments is
 * somebody dragging cards, and a hundred comments and no transitions is
 * somebody carrying a conversation. A trailing `+` marks a count the site's
 * search truncated, so a floor never passes as a total.
 */
const InteractionsCell = ({ interactions }: { interactions: JiraInteractions }) => {
  const classes = useStyles();
  const total = interactionTotal(interactions);
  const complete = interactionsAreComplete(interactions);

  const parts = [
    interactions.comments === null ? null : `${formatCount(interactions.comments)} comments`,
    interactions.worklogEntries === null
      ? null
      : `${formatCount(interactions.worklogEntries)} logged`,
    `${formatCount(interactions.transitions)} moves`,
  ].filter((part): part is string => part !== null);

  return (
    <Box>
      <Typography variant="body2">
        {formatCount(total)}
        {complete ? "" : "+"}
      </Typography>
      <Typography variant="caption" className={classes.caption}>
        {parts.join(" · ")}
      </Typography>
    </Box>
  );
};

const RESOLVED_HELP =
  "Tickets that reached a done status inside the window, attributed to whoever was assigned when they closed. Jira records no 'closed by', so the assignee is the closest thing it will tell us — and it is what the site's own reports use, so this number agrees with the one the team already sees. The second figure is tickets they raised.";

const INTERACTIONS_HELP =
  "Comments written, worklog entries booked and status transitions performed inside the window. A trailing + means Jira's search capped one of the lists it was asked for, so the figure is a floor. Comments or worklog missing from the breakdown means this site's search does not return them at all — which is not the same as nobody having written any.";

const STORY_POINTS_HELP =
  "Points on the tickets that closed in the window, and on the tickets they were assigned. Story points live on a custom field whose id differs per Jira site; a dash means no such field was found, never that the team estimated nothing. An operator can pin it with codeHealth.atlassian.jira.storyPointsField.";

const CYCLE_HELP =
  "Average hours from the first move into an in-progress status to done, over the tickets this person closed in the window. An average rather than a median because one person's several Atlassian accounts are added together onto this row, and medians cannot be added. Tickets that went straight from the backlog to done have no start and are left out rather than counted as instant.";

const REOPENED_HELP =
  "Tickets assigned to this person that went from a done status back to an open one inside the window. Charged to the assignee rather than to whoever reopened it: it is a statement about work coming back, and the person who spotted the defect is not the person it came back to.";

const ReopenedCell = ({ count }: { count: number }) => {
  const classes = useStyles();
  return (
    <Typography
      variant="body2"
      component="span"
      className={count > 0 ? classes.rework : undefined}
      data-tone={count > 0 ? "rework" : "clean"}
    >
      {formatCount(count)}
    </Typography>
  );
};

export const jiraContributorColumns = (): ColumnDef<ContributorSummary>[] => [
  {
    id: "jiraResolved",
    accessorFn: (row) => row.jiraMetrics?.issuesResolved ?? null,
    header: () => <HeaderWithHelp label="Tickets closed" help={RESOLVED_HELP} />,
    cell: ({ row }) => {
      const metrics = row.original.jiraMetrics;
      return (
        <StackedCell
          value={metrics === null ? null : formatCount(metrics.issuesResolved)}
          caption={metrics === null ? null : `${formatCount(metrics.issuesCreated)} raised`}
        />
      );
    },
    enableColumnFilter: false,
  },
  {
    id: "jiraInteractions",
    accessorFn: (row) =>
      row.jiraMetrics === null ? null : interactionTotal(row.jiraMetrics.interactions),
    header: () => <HeaderWithHelp label="Jira activity" help={INTERACTIONS_HELP} />,
    cell: ({ row }) => {
      const metrics = row.original.jiraMetrics;
      return metrics === null ? (
        <EmptyCell />
      ) : (
        <InteractionsCell interactions={metrics.interactions} />
      );
    },
    enableColumnFilter: false,
  },
  {
    id: "jiraStoryPoints",
    accessorFn: (row) => row.jiraMetrics?.storyPointsCompleted ?? null,
    header: () => <HeaderWithHelp label="Story points" help={STORY_POINTS_HELP} />,
    cell: ({ row }) => {
      const metrics = row.original.jiraMetrics;
      const completed = metrics?.storyPointsCompleted ?? null;
      const estimated = metrics?.storyPointsEstimated ?? null;
      return (
        <StackedCell
          value={completed === null ? null : formatDecimal(completed)}
          caption={estimated === null ? null : `${formatDecimal(estimated)} assigned`}
        />
      );
    },
    enableColumnFilter: false,
  },
  {
    id: "jiraCycleTime",
    accessorFn: (row) => meanHours(row.jiraMetrics?.cycleTime ?? null),
    header: () => <HeaderWithHelp label="Cycle time" help={CYCLE_HELP} />,
    cell: ({ row }) => {
      const cycle = row.original.jiraMetrics?.cycleTime ?? null;
      const average = meanHours(cycle);
      return (
        <StackedCell
          value={average === null ? null : formatHours(average)}
          caption={cycle === null ? null : `over ${formatCount(cycle.issues)}`}
        />
      );
    },
    enableColumnFilter: false,
  },
  {
    id: "jiraReopened",
    accessorFn: (row) => row.jiraMetrics?.reopened ?? null,
    header: () => <HeaderWithHelp label="Reopened" help={REOPENED_HELP} />,
    cell: ({ row }) => {
      const metrics = row.original.jiraMetrics;
      if (metrics === null) return <EmptyCell />;
      return <ReopenedCell count={metrics.reopened} />;
    },
    enableColumnFilter: false,
  },
];

/** Zero is the good outcome here, so only a non-zero count is coloured. */

const THROUGHPUT_HELP =
  "Tickets closed per week across the window, so a fortnight and a quarter can be compared. Null for a window shorter than a day, because a rate extrapolated from an hour of evidence is arithmetic rather than measurement.";

const REPO_CYCLE_HELP =
  "Median hours from the first move into an in-progress status to done, over the tickets this project closed in the window, with the 85th percentile underneath. A repository row is never merged with another, so a median is safe here — the contributors table shows an average for the opposite reason.";

const BUG_RATIO_HELP =
  "The share of closed work that was a defect. Matched on Jira's default type names (Bug, Defect); a site that invented its own defect type is counted as other work, and the dash means nothing closed at all.";

const OPEN_HELP =
  "Tickets not in a done status right now, with the age of the oldest underneath. Deliberately not scoped to the window: a backlog is a present-tense fact, and what it looked like last March is not something Jira will answer without replaying every status change on the site.";

const TICKETS_HELP =
  "Tickets this project closed inside the window, and how many it took on. Several repositories can name one Jira project, and they then show the same figures — the project is measured once and the answer is shared, rather than each repository asking again.";

export const jiraRepositoryColumns = (): ColumnDef<RepositorySummary>[] => [
  {
    id: "jiraTickets",
    accessorFn: (row) => row.jiraMetrics?.issuesResolved ?? null,
    header: () => <HeaderWithHelp label="Tickets" help={TICKETS_HELP} />,
    cell: ({ row }) => {
      const metrics = row.original.jiraMetrics;
      return (
        <StackedCell
          value={metrics === null ? null : formatCount(metrics.issuesResolved)}
          caption={metrics === null ? null : `${formatCount(metrics.issuesCreated)} opened`}
        />
      );
    },
    enableColumnFilter: false,
  },
  {
    id: "jiraThroughput",
    accessorFn: (row) => row.jiraMetrics?.throughputPerWeek ?? null,
    header: () => <HeaderWithHelp label="Throughput" help={THROUGHPUT_HELP} />,
    cell: ({ getValue }) => {
      const rate = getValue<number | null>();
      // Issues per week is a rate, so it keeps the decimal it arrives with.
      return <StackedCell value={rate === null ? null : formatDecimal(rate)} caption="per week" />;
    },
    enableColumnFilter: false,
  },
  {
    id: "jiraRepoCycleTime",
    accessorFn: (row) => row.jiraMetrics?.cycleTime?.medianHours ?? null,
    header: () => <HeaderWithHelp label="Cycle time" help={REPO_CYCLE_HELP} />,
    cell: ({ row }) => {
      const cycle = row.original.jiraMetrics?.cycleTime ?? null;
      return (
        <StackedCell
          value={cycle === null ? null : formatHours(cycle.medianHours)}
          caption={cycle === null ? null : `85th: ${formatHours(cycle.p85Hours)}`}
        />
      );
    },
    enableColumnFilter: false,
  },
  {
    id: "jiraBugRatio",
    accessorFn: (row) => row.jiraMetrics?.bugRatio ?? null,
    header: () => <HeaderWithHelp label="Bug ratio" help={BUG_RATIO_HELP} />,
    cell: ({ row }) => {
      const metrics = row.original.jiraMetrics;
      const ratio = metrics?.bugRatio ?? null;
      return (
        <StackedCell
          value={ratio === null ? null : formatPercent(ratio)}
          caption={
            metrics === null
              ? null
              : `${formatCount(metrics.resolvedByType.bug)} of ${formatCount(
                  metrics.issuesResolved,
                )}`
          }
        />
      );
    },
    enableColumnFilter: false,
  },
  {
    id: "jiraOpen",
    accessorFn: (row) => row.jiraMetrics?.openIssues ?? null,
    header: () => <HeaderWithHelp label="Open" help={OPEN_HELP} />,
    cell: ({ row }) => {
      const metrics = row.original.jiraMetrics;
      const open = metrics?.openIssues ?? null;
      const oldest = metrics?.oldestOpenIssue ?? null;
      return (
        <StackedCell
          value={open === null ? null : formatCount(open)}
          caption={oldest === null ? null : `oldest ${formatCount(oldest.ageDays)}d`}
        />
      );
    },
    enableColumnFilter: false,
  },
];
