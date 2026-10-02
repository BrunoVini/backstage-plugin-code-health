import Box from "@material-ui/core/Box";
import Chip from "@material-ui/core/Chip";
import Typography from "@material-ui/core/Typography";
import { makeStyles } from "@material-ui/core/styles";

const useStyles = makeStyles((theme) => ({
  label: {
    fontWeight: 500,
    marginBottom: theme.spacing(1),
  },
  chip: {
    borderColor: theme.palette.warning.main,
    color: theme.palette.warning.main,
  },
  chips: {
    display: "flex",
    flexWrap: "wrap",
    gap: theme.spacing(1),
  },
}));

/**
 * Names the repositories SonarQube analyses without publishing a coverage
 * measure.
 *
 * The card beside this one already counts them. A count is where the question
 * starts, not where it ends: "four repositories report no coverage" sends a
 * reader to open four projects to find out which, and that friction is exactly
 * why these sat unmeasured without anyone noticing. Naming them turns the
 * number into a list of work.
 *
 * They are deliberately not in the "Least covered" ranking next door. That
 * chart ranks by a coverage value, and these have none — placing them at 0%
 * would state the one thing the whole card exists to deny.
 */
export const UnreportedRepositories = ({
  repositories,
}: {
  readonly repositories: readonly string[];
}) => {
  const classes = useStyles();

  if (repositories.length === 0) return null;

  return (
    <Box mt={3}>
      <Typography variant="body2" className={classes.label}>
        Reporting no coverage
      </Typography>
      <Box className={classes.chips}>
        {/* Keyed by position, not by name: two repositories in different Azure
            DevOps projects or GitHub organisations can carry the same name, and
            a duplicate React key would drop one of them from the list. A list
            that silently loses an entry is the failure this card exists to
            stop. */}
        {repositories.map((name, index) => (
          <Chip
            key={`${index}-${name}`}
            label={name}
            size="small"
            variant="outlined"
            className={classes.chip}
          />
        ))}
      </Box>
    </Box>
  );
};
