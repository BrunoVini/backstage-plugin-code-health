import type { SonarMetrics } from "@rios0rios0/backstage-plugin-code-health-common";
import Tooltip from "@material-ui/core/Tooltip";
import Typography from "@material-ui/core/Typography";
import { makeStyles } from "@material-ui/core/styles";
import ReportProblemOutlinedIcon from "@material-ui/icons/ReportProblemOutlined";
import { EmptyCell } from "./empty_cell";

const useStyles = makeStyles((theme) => ({
  unmeasured: {
    display: "inline-flex",
    alignItems: "center",
    gap: theme.spacing(0.5),
    color: theme.palette.warning.main,
  },
  icon: {
    fontSize: "1rem",
  },
}));

const UNMEASURED_HELP =
  "SonarQube analyses this repository but publishes no coverage measure for it — usually because no coverage report is produced or imported. That is the only possibility for Terraform, Helm or shell, which have no coverage engine of their own, but it also happens to a language that has one when CI never imports the report. This is not zero coverage: it is no measurement, and it is left out of the score rather than counted as a zero that would drag down everyone who touched the repository. A dash means SonarQube does not analyse the repository at all.";

/**
 * Coverage, told apart from the two different silences behind it.
 *
 * `sonarMetrics?.coverage ?? null` collapses two unrelated states into one
 * dash: a repository SonarQube never analysed, and one it analyses but reports
 * no coverage for. Only the second is a problem somebody can fix, and hiding it
 * behind the same dash is what let seven projects sit unmeasured without anyone
 * noticing. The score already leaves both out; this is the part that says so.
 */
export const CoverageCell = ({
  sonar,
  format,
}: {
  readonly sonar: SonarMetrics | null;
  readonly format: (coverage: number) => string;
}) => {
  const classes = useStyles();

  if (sonar === null) return <EmptyCell />;

  if (sonar.coverage === null) {
    return (
      <Tooltip title={UNMEASURED_HELP}>
        <span className={classes.unmeasured}>
          <ReportProblemOutlinedIcon
            className={classes.icon}
            aria-label="No coverage is reported for this repository"
          />
          <Typography variant="caption">not reported</Typography>
        </span>
      </Tooltip>
    );
  }

  return <Typography variant="body2">{format(sonar.coverage)}</Typography>;
};
