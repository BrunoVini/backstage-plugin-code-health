import type {
  CoverageScope,
  SonarMetrics,
} from "@rios0rios0/backstage-plugin-code-health-common";
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
  partial: {
    display: "inline-flex",
    alignItems: "center",
    gap: theme.spacing(0.5),
  },
  icon: {
    fontSize: "1rem",
    color: theme.palette.warning.main,
  },
}));

const UNMEASURED_HELP =
  "SonarQube analyses this repository but publishes no coverage measure for it — usually because no coverage report is produced or imported. That is the only possibility for Terraform, Helm or shell, which have no coverage engine of their own, but it also happens to a language that has one when CI never imports the report. This is not zero coverage: it is no measurement, and it is left out of the score rather than counted as a zero that would drag down everyone who touched the repository. A dash means SonarQube does not analyse the repository at all.";

const partialHelp = (scope: CoverageScope): string => {
  const total = scope.measured + scope.unreported;
  return `Averaged over the ${scope.measured} of ${total} repositories that report coverage. The other ${scope.unreported} ${
    scope.unreported === 1 ? "is analysed" : "are analysed"
  } by SonarQube but ${
    scope.unreported === 1 ? "publishes" : "publish"
  } no coverage measure, so ${
    scope.unreported === 1 ? "it is" : "they are"
  } left out of this figure rather than counted as zero. The number is honest about what it measured; this says how much of the work it covered.`;
};

/**
 * Coverage, told apart from the silences behind it.
 *
 * `sonarMetrics?.coverage ?? null` collapses two unrelated states into one
 * dash: a repository SonarQube never analysed, and one it analyses but reports
 * no coverage for. Only the second is a gap somebody can close, and hiding it
 * behind the same dash is what let these projects sit unmeasured unnoticed.
 *
 * On a contributor row there is a third state, and it is the common one. The
 * coverage there is a mean over the repositories that report a measure, so it
 * is null only when *every* repository the person touched is unmeasurable.
 * Somebody who touched one measured repository and one unmeasurable one shows
 * the first one's figure with nothing saying the second exists — which is why
 * `scope` is read even when there is a number to print.
 */
export const CoverageCell = ({
  sonar,
  format,
  scope,
}: {
  readonly sonar: SonarMetrics | null;
  readonly format: (coverage: number) => string;
  /** Only a contributor row has one; a repository is its own scope. */
  readonly scope?: CoverageScope;
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

  const value = <Typography variant="body2">{format(sonar.coverage)}</Typography>;
  if (scope === undefined || scope.unreported === 0) return value;

  return (
    <Tooltip title={partialHelp(scope)}>
      <span className={classes.partial}>
        {value}
        <ReportProblemOutlinedIcon
          className={classes.icon}
          aria-label={`Averaged over ${scope.measured} of ${
            scope.measured + scope.unreported
          } repositories; the rest report no coverage`}
        />
      </span>
    </Tooltip>
  );
};
