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
  ContributorRates,
  ContributorRateSet,
  ContributorSummary,
  IntegrationCapabilities,
} from "@rios0rios0/backstage-plugin-code-health-common";
import {
  contributorRatesOf,
  formatDuration,
  formatRate,
  RATE_PERIODS,
  windowDaysOf,
} from "@rios0rios0/backstage-plugin-code-health-common";

const useStyles = makeStyles((theme) => ({
  headerCell: {
    whiteSpace: "nowrap",
    textTransform: "uppercase",
    fontSize: theme.typography.pxToRem(11),
    letterSpacing: "0.05em",
  },
  figure: { textAlign: "right", whiteSpace: "nowrap" },
  label: { whiteSpace: "nowrap" },
  note: { display: "block", marginTop: theme.spacing(1) },
}));

/** How one row of the card reads a rate set. */
interface RateRow {
  readonly label: string;
  readonly pick: (rates: ContributorRateSet) => number | null;
  /** Coding time is a duration; everything else is a count. */
  readonly format?: (value: number) => string;
}

const CHURN_LABELS = {
  lines: "Net lines",
  files: "Files changed",
  none: "Churn",
} as const;

/**
 * Which rows the card shows, in the order the score reads them.
 *
 * Confluence is deliberately absent. Its figures describe Confluence's own
 * trailing window rather than the range picked above, so dividing them by this
 * window's days would print a number that is not a rate of anything — the one
 * mislabelling the rest of the dashboard refuses to leave implicit. The caption
 * says so rather than leaving a reader to wonder where it went.
 */
const rowsFor = (
  rates: ContributorRates,
  capabilities: IntegrationCapabilities,
): readonly RateRow[] => [
  { label: "Commits", pick: (set) => set.commits },
  { label: "Pull requests opened", pick: (set) => set.pullRequestsOpened },
  { label: "Pull requests merged", pick: (set) => set.pullRequestsMerged },
  { label: "Reviews given", pick: (set) => set.reviewsGiven },
  { label: CHURN_LABELS[rates.churnUnit], pick: (set) => set.churn },
  { label: "Pipeline runs", pick: (set) => set.pipelineRuns },
  ...(capabilities.wakatime
    ? [
        {
          label: "Coding time",
          pick: (set: ContributorRateSet) => set.codingSeconds,
          format: (value: number) => formatDuration(Math.round(value)),
        },
      ]
    : []),
  ...(capabilities.jira
    ? [{ label: "Tickets resolved", pick: (set: ContributorRateSet) => set.issuesResolved }]
    : []),
];

export interface ContributorRatesCardProps {
  readonly summary: ContributorSummary;
  readonly window: { readonly from: string; readonly to: string };
  readonly capabilities: IntegrationCapabilities;
}

/**
 * What this person does in a day, a week and a month.
 *
 * A window total answers "how much in these three months", which is only
 * comparable against another three months. These are the same totals divided
 * by the days the window spans, which is exactly what the productivity score
 * above reads — so the figures here and the sentences behind that score are the
 * same arithmetic, and a reader who disagrees with the score can see which row
 * they disagree with.
 *
 * The denominator is the window rather than the days this person was active, so
 * every figure is output per *elapsed* day. A fortnight of leave inside the
 * range lowers all of them, and the caption says so: a reader comparing two
 * people has to know which of the two questions these answer.
 *
 * An em dash where a figure was never measured, never a zero: a provider that
 * reports no line counts has not reported a churn of nothing.
 */
export const ContributorRatesCard = ({
  summary,
  window,
  capabilities,
}: ContributorRatesCardProps) => {
  const classes = useStyles();
  const days = windowDaysOf(window);
  const rates = contributorRatesOf(summary, days);
  const rows = rowsFor(rates, capabilities);

  const cell = (row: RateRow, set: ContributorRateSet) => {
    const value = row.pick(set);
    if (value === null) return "—";
    return row.format ? row.format(value) : formatRate(value);
  };

  return (
    <InfoCard title="Averages">
      <Typography variant="body2" color="textSecondary">
        The same totals divided by the {formatRate(days)} days this range spans. The
        productivity score reads these rates, each against the team&apos;s average rate for
        the same period. The divisor is the range, not the days this person was active, so
        leave or a mid-range start lowers every figure here.
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
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.label}>
                <TableCell className={classes.label}>
                  <Typography variant="body2">{row.label}</Typography>
                </TableCell>
                <TableCell className={classes.figure}>{cell(row, rates.daily)}</TableCell>
                <TableCell className={classes.figure}>{cell(row, rates.weekly)}</TableCell>
                <TableCell className={classes.figure}>{cell(row, rates.monthly)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Box>

      <Typography variant="caption" color="textSecondary" className={classes.note}>
        A month is the mean Gregorian month, so twelve of them add back up to a year.
        {capabilities.confluence
          ? " Documentation written is not listed: Confluence is stored per trailing window rather than per day, so it is not a rate of the range picked above."
          : ""}
      </Typography>
    </InfoCard>
  );
};
