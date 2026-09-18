import Box from "@material-ui/core/Box";
import Button from "@material-ui/core/Button";
import Chip from "@material-ui/core/Chip";
import Tooltip from "@material-ui/core/Tooltip";
import Typography from "@material-ui/core/Typography";
import { makeStyles } from "@material-ui/core/styles";
import type {
  RepositoryAuditContext,
  RepositoryAuditId,
} from "../../domain/entities/repository_audit";
import { REPOSITORY_AUDITS } from "../../domain/entities/repository_audit";

const useStyles = makeStyles((theme) => ({
  row: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: theme.spacing(1) },
  chip: { height: 24, fontSize: theme.typography.pxToRem(12) },
  count: { fontVariantNumeric: "tabular-nums", fontWeight: 600 },
}));

export interface RepositoryAuditFiltersProps {
  readonly counts: ReadonlyMap<RepositoryAuditId, number>;
  readonly selected: readonly RepositoryAuditId[];
  readonly context: RepositoryAuditContext;
  readonly onToggle: (id: RepositoryAuditId) => void;
  readonly onClear: () => void;
}

/**
 * One chip per audit, each carrying how many repositories it matches.
 *
 * The count is the point of the control, not decoration: it turns "is there
 * anything to do here" into something readable without clicking, and a chip
 * reading zero is a statement about the fleet worth having on screen. A chip
 * nothing matches is therefore drawn rather than hidden, and disabled rather
 * than left clickable, because selecting it could only ever empty the table.
 * One that is already selected stays enabled whatever its count, so a
 * selection can always be undone by the control that made it.
 *
 * Picking several narrows, like every other filter on the table. That is said
 * once above the row rather than in each tooltip, because it is a fact about
 * the control and not about any one audit.
 */
export const RepositoryAuditFilters = ({
  counts,
  selected,
  context,
  onToggle,
  onClear,
}: RepositoryAuditFiltersProps) => {
  const classes = useStyles();

  return (
    <Box className={classes.row}>
      <Tooltip title="Repositories with a gap somebody has to close. Picking more than one narrows to the repositories that have all of them.">
        <Typography variant="caption" color="textSecondary">
          Audits
        </Typography>
      </Tooltip>

      {REPOSITORY_AUDITS.map((audit) => {
        const count = counts.get(audit.id) ?? 0;
        const isSelected = selected.includes(audit.id);

        return (
          <Tooltip key={audit.id} title={audit.describe(context)}>
            <Chip
              size="small"
              className={classes.chip}
              clickable
              disabled={count === 0 && !isSelected}
              color={isSelected ? "primary" : "default"}
              variant={isSelected ? "default" : "outlined"}
              aria-pressed={isSelected}
              onClick={() => onToggle(audit.id)}
              label={
                <>
                  {audit.label}{" "}
                  <span className={classes.count}>{count}</span>
                </>
              }
            />
          </Tooltip>
        );
      })}

      {selected.length > 0 && (
        <Button size="small" onClick={onClear}>
          Clear audits
        </Button>
      )}
    </Box>
  );
};
