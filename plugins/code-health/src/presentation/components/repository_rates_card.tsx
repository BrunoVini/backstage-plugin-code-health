import { InfoCard } from "@backstage/core-components";
import Box from "@material-ui/core/Box";
import Table from "@material-ui/core/Table";
import TableBody from "@material-ui/core/TableBody";
import TableCell from "@material-ui/core/TableCell";
import TableHead from "@material-ui/core/TableHead";
import TableRow from "@material-ui/core/TableRow";
import Typography from "@material-ui/core/Typography";
import { makeStyles } from "@material-ui/core/styles";
import type {
  IntegrationCapabilities,
  RepositoryFleetRates,
  RepositoryRateSet,
  RepositorySummary,
  TimeWindow,
} from "@rios0rios0/backstage-plugin-code-health-common";
import {
  fleetRepositoryRatesOf,
  formatDuration,
  formatRate,
  RATE_PERIODS,
  repositoryRatesOf,
  windowDaysOf,
} from "@rios0rios0/backstage-plugin-code-health-common";
import { formatWindowSpan } from "../../domain/entities/window_span";
import { RateDelta, RateFigure } from "./rate_comparison";

const useStyles = makeStyles((theme) => ({
  headerCell: {
    whiteSpace: "nowrap",
    textTransform: "uppercase",
    fontSize: theme.typography.pxToRem(11),
    letterSpacing: "0.05em",
  },
  figure: { textAlign: "right", whiteSpace: "nowrap", verticalAlign: "top" },
  label: { whiteSpace: "nowrap", verticalAlign: "top" },
  note: { display: "block", marginTop: theme.spacing(1) },
}));

/** How one row of the card reads a rate set. */
interface RateRow {
  readonly label: string;
  readonly pick: (rates: RepositoryRateSet) => number | null;
  /** Coding time is a duration; everything else is a count. */
  readonly format?: (value: number) => string;
}

/**
 * Which rows the card shows.
 *
 * Churn is deliberately absent: a repository's churn is in whichever unit its
 * platform reports, lines on GitHub and files on Azure DevOps, and a fleet
 * average across the two would be a mean of unlike things. Confluence is
 * absent for the reason it is absent from the person's card — its figures
 * describe a trailing window rather than the range picked.
 */
const rowsFor = (capabilities: IntegrationCapabilities): readonly RateRow[] => [
  { label: "Commits", pick: (set) => set.commits },
  { label: "Pull requests opened", pick: (set) => set.pullRequestsOpened },
  { label: "Pull requests merged", pick: (set) => set.pullRequestsMerged },
  { label: "Reviews", pick: (set) => set.reviews },
  { label: "Pipeline runs", pick: (set) => set.builds },
  { label: "Releases", pick: (set) => set.releases },
  ...(capabilities.wakatime
    ? [
        {
          label: "Coding time",
          pick: (set: RepositoryRateSet) => set.codingSeconds,
          format: (value: number) => formatDuration(Math.round(value)),
        },
      ]
    : []),
  ...(capabilities.jira
    ? [{ label: "Tickets resolved", pick: (set: RepositoryRateSet) => set.issuesResolved }]
    : []),
];

const FLEET = "the fleet";

/**
 * Why the tickets row is not read over the range picked, said only where the
 * row exists at all. The window is named by the last day it covers: Jira's
 * ends at the start of tomorrow, which is not a day it holds.
 */
const ticketsNote = (
  capabilities: IntegrationCapabilities,
  jiraWindow: TimeWindow | null,
): string => {
  if (!capabilities.jira) return "";
  if (jiraWindow === null) {
    return " Tickets resolved is a rate over Jira's own trailing window, which the range picker does not move; no Jira project is named by this repository's catalog entity.";
  }
  return ` Tickets resolved is a rate over Jira's own trailing window, ${formatWindowSpan(
    jiraWindow,
  )}, which the range picker does not move.`;
};

export interface RepositoryRatesCardProps {
  readonly summary: RepositorySummary;
  readonly window: TimeWindow;
  readonly capabilities: IntegrationCapabilities;
  /**
   * The fleet's mean rates over the same window, or null from a backend that
   * does not send them. With them the card says how far each row sits from
   * the fleet; without them it prints the repository's figures alone.
   */
  readonly fleet: RepositoryFleetRates | null;
}

/**
 * What happens in this repository in a day, a week and a month — and how that
 * compares with the rest of the fleet.
 *
 * The same arithmetic as the person's card, for the same reason: a window
 * total is only comparable against another window of the same length, and a
 * rate means the same thing whichever range was picked. Under each figure
 * sits the fleet's, in the same period, and the last column says how far
 * apart the two are as a share of the fleet's. The fleet is every active
 * repository the plugin tracks — archived ones cannot receive a commit and are
 * left out of the average — and each average is the mean over the
 * repositories that row could be measured on.
 *
 * Above the fleet means busier, not better. A library that sees a commit a
 * month is not failing, and a service that sees forty a day is not thriving;
 * the health score above is the judgement, and this card is the activity.
 *
 * Tickets are the one row not read over the range picked. The repository's
 * Jira figures ride on the daily snapshot and describe Jira's own trailing
 * window, so the rate is taken over that window's days and the row says so.
 */
export const RepositoryRatesCard = ({
  summary,
  window,
  capabilities,
  fleet,
}: RepositoryRatesCardProps) => {
  const classes = useStyles();
  const days = windowDaysOf(window);
  const rates = repositoryRatesOf(summary, days);
  const reference = fleet === null ? null : fleetRepositoryRatesOf(fleet);
  const rows = rowsFor(capabilities);
  const jiraWindow = summary.jiraMetrics?.window ?? null;

  const cell = (row: RateRow, mine: RepositoryRateSet, theirs: RepositoryRateSet | null) => (
    <RateFigure
      value={row.pick(mine)}
      reference={theirs === null ? null : row.pick(theirs)}
      referenceLabel="fleet"
      format={row.format}
    />
  );

  return (
    <InfoCard title="Averages">
      <Typography variant="body2" color="textSecondary">
        The window&apos;s totals divided by the {formatRate(days)} days this range spans, with
        the fleet&apos;s average under each figure. Above the fleet means busier, not better:
        the health score is the judgement, and this is the activity.
      </Typography>

      <Box mt={2}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell className={classes.headerCell}>Measure</TableCell>
              {Object.values(RATE_PERIODS).map((period) => (
                <TableCell key={period.id} className={classes.headerCell} align="right">
                  {period.label}
                </TableCell>
              ))}
              <TableCell className={classes.headerCell} align="right">
                Against the fleet
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.label}>
                <TableCell className={classes.label}>
                  <Typography variant="body2">{row.label}</Typography>
                </TableCell>
                <TableCell className={classes.figure}>
                  {cell(row, rates.daily, reference?.daily ?? null)}
                </TableCell>
                <TableCell className={classes.figure}>
                  {cell(row, rates.weekly, reference?.weekly ?? null)}
                </TableCell>
                <TableCell className={classes.figure}>
                  {cell(row, rates.monthly, reference?.monthly ?? null)}
                </TableCell>
                <TableCell className={classes.figure}>
                  <RateDelta
                    value={row.pick(rates.daily)}
                    reference={reference === null ? null : row.pick(reference.daily)}
                    against={FLEET}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Box>

      <Typography variant="caption" color="textSecondary" className={classes.note}>
        {fleet === null
          ? "No fleet average was sent for this range, so nothing here is compared. "
          : `The fleet is the ${fleet.repositories} active ${
              fleet.repositories === 1 ? "repository" : "repositories"
            } tracked in this range, archived ones left out, and each average is the mean over the repositories that row could be measured on. `}
        A month is the mean Gregorian month, so twelve of them add back up to a year.
        {ticketsNote(capabilities, jiraWindow)}
      </Typography>
    </InfoCard>
  );
};
