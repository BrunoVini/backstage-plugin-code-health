import { LinearProgress, Typography, makeStyles } from "@material-ui/core";
import type { CoverageInfo } from "@rios0rios0/backstage-plugin-code-health-common";
import {
  formatCount,
  formatPercent,
} from "@rios0rios0/backstage-plugin-code-health-common";

const useStyles = makeStyles((theme) => ({
  root: { marginBottom: theme.spacing(2) },
  caption: { display: "block", marginBottom: theme.spacing(0.5) },
}));

export interface BackfillProgressProps {
  readonly coverage: CoverageInfo;
}

/**
 * Explains why the dashboard cannot yet answer for a year.
 *
 * Without this, a freshly installed plugin looks broken: the range picker offers
 * only the last day and nobody can tell whether that is a failure or a backfill
 * still running. It disappears once the history is complete.
 */
export const BackfillProgress = ({ coverage }: BackfillProgressProps) => {
  const classes = useStyles();
  const { backfill } = coverage;

  if (backfill.repositories === 0 || backfill.percent >= 100) return null;

  const failing =
    backfill.failing > 0
      ? ` ${formatCount(backfill.failing)} ${
          backfill.failing === 1 ? "repository is" : "repositories are"
        } failing to ingest.`
      : "";

  return (
    <div className={classes.root} data-test-subj="backfillProgress">
      <Typography variant="caption" color="textSecondary" className={classes.caption}>
        {`Collecting history: ${formatPercent(backfill.percent)} of the last year across ${formatCount(
          backfill.repositories,
        )} ` +
          `${backfill.repositories === 1 ? "repository" : "repositories"}. ` +
          `Wider time ranges unlock as it completes.${failing}`}
      </Typography>
      <LinearProgress
        variant="determinate"
        value={Math.min(100, Math.max(0, backfill.percent))}
        aria-label="Backfill progress"
      />
    </div>
  );
};
