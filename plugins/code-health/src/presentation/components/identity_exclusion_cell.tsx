import Box from "@material-ui/core/Box";
import Button from "@material-ui/core/Button";
import Chip from "@material-ui/core/Chip";
import ListItemText from "@material-ui/core/ListItemText";
import Menu from "@material-ui/core/Menu";
import MenuItem from "@material-ui/core/MenuItem";
import Tooltip from "@material-ui/core/Tooltip";
import Typography from "@material-ui/core/Typography";
import { makeStyles } from "@material-ui/core/styles";
import BlockIcon from "@material-ui/icons/Block";
import type {
  ExclusionReason,
  IdentityRow,
} from "@rios0rios0/backstage-plugin-code-health-common";
import {
  EXCLUSION_REASON_DESCRIPTIONS,
  EXCLUSION_REASON_LABELS,
  EXCLUSION_REASONS,
} from "@rios0rios0/backstage-plugin-code-health-common";
import { useState } from "react";

const useStyles = makeStyles((theme) => ({
  reason: { maxWidth: 420, whiteSpace: "normal" },
  note: { display: "block", marginTop: theme.spacing(0.5) },
  chip: { maxWidth: "100%" },
}));

export interface IdentityExclusionCellProps {
  readonly row: IdentityRow;
  readonly onExclude: (reason: ExclusionReason) => void;
  readonly onInclude: () => void;
  readonly isBusy: boolean;
}

/**
 * The half of a row that decides whether the account is measured at all.
 *
 * A menu of four reasons rather than a bare "exclude" button, because the
 * reason is the only part of this decision anybody can review later — and
 * because picking from a list of four is the same number of clicks as
 * confirming a dialog would have been, so there is nothing to trade away.
 *
 * There is no confirmation step. Excluding an account deletes nothing: the
 * events and the per-source measures stay exactly as they were collected, and
 * the row comes back in full the moment somebody includes it again. A dialog
 * guarding a reversible action trains people to click through dialogs.
 */
export const IdentityExclusionCell = ({
  row,
  onExclude,
  onInclude,
  isBusy,
}: IdentityExclusionCellProps) => {
  const classes = useStyles();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  const { exclusion, identity } = row;

  if (exclusion !== null) {
    // An exclusion recorded on a *different* account of the same person. Only
    // the row carrying it has anything to undo, so this one says where the
    // decision lives instead of offering a button that would undo nothing.
    const inherited =
      exclusion.source !== identity.source || exclusion.sourceKey !== identity.sourceKey;

    return (
      <Box>
        <Tooltip
          title={`${EXCLUSION_REASON_DESCRIPTIONS[exclusion.reason]} — excluded by ${
            exclusion.excludedBy ?? "an administrator"
          }`}
        >
          <Chip
            size="small"
            className={classes.chip}
            icon={<BlockIcon fontSize="small" />}
            label={EXCLUSION_REASON_LABELS[exclusion.reason]}
          />
        </Tooltip>

        {inherited ? (
          <Typography variant="caption" color="textSecondary" className={classes.note}>
            Excluded with this person, on {exclusion.source}:{exclusion.sourceKey}.
          </Typography>
        ) : (
          <Box>
            <Button
              size="small"
              onClick={onInclude}
              disabled={isBusy}
              aria-label={`Measure ${identity.sourceKey} again`}
            >
              Measure again
            </Button>
          </Box>
        )}
      </Box>
    );
  }

  return (
    <Box>
      <Button
        size="small"
        variant="outlined"
        disabled={isBusy}
        onClick={(event) => setAnchor(event.currentTarget)}
        aria-label={`Exclude ${identity.sourceKey} from measurement`}
        aria-haspopup="menu"
      >
        Exclude
      </Button>

      <Menu
        anchorEl={anchor}
        open={anchor !== null}
        onClose={() => setAnchor(null)}
        // Anchored below the button rather than over it, so the reason the
        // whole menu exists is not covering the row it applies to.
        getContentAnchorEl={null}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
      >
        {EXCLUSION_REASONS.map((reason) => (
          <MenuItem
            key={reason}
            onClick={() => {
              setAnchor(null);
              onExclude(reason);
            }}
          >
            <ListItemText
              className={classes.reason}
              primary={EXCLUSION_REASON_LABELS[reason]}
              secondary={EXCLUSION_REASON_DESCRIPTIONS[reason]}
            />
          </MenuItem>
        ))}
      </Menu>
    </Box>
  );
};
