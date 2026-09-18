import Button from "@material-ui/core/Button";
import Dialog from "@material-ui/core/Dialog";
import DialogActions from "@material-ui/core/DialogActions";
import DialogContent from "@material-ui/core/DialogContent";
import DialogTitle from "@material-ui/core/DialogTitle";
import IconButton from "@material-ui/core/IconButton";
import Snackbar from "@material-ui/core/Snackbar";
import TextField from "@material-ui/core/TextField";
import Tooltip from "@material-ui/core/Tooltip";
import Typography from "@material-ui/core/Typography";
import { makeStyles } from "@material-ui/core/styles";
import HistoryIcon from "@material-ui/icons/History";
import type { ResetIngestionResponse } from "@rios0rios0/backstage-plugin-code-health-common";
import { formatCount } from "@rios0rios0/backstage-plugin-code-health-common";
import { useState } from "react";
import type { ResetReach } from "../../domain/entities/reset_reach";
import { resetReachOptions } from "../../domain/entities/reset_reach";
import type { AdministrationService } from "../../domain/services/dashboard_service";
import { useAccess } from "../hooks/use_access";

const CONFIRMATION_MS = 10000;

const useStyles = makeStyles((theme) => ({
  paragraph: { marginBottom: theme.spacing(2) },
  reach: { marginTop: theme.spacing(1) },
  error: { marginTop: theme.spacing(2) },
}));

export interface IngestionResetButtonProps {
  readonly administrationService: AdministrationService;
  /** Called after a reset was accepted, so the caller can re-read coverage. */
  readonly onReset: () => void;
}

const counted = (count: number, singular: string, plural: string): string =>
  `${formatCount(count)} ${count === 1 ? singular : plural}`;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface IngestionResetDialogProps {
  readonly retentionDays: number;
  readonly administrationService: AdministrationService;
  readonly onClose: () => void;
  readonly onDone: (outcome: ResetIngestionResponse) => void;
}

/**
 * What starting the collection over costs, and how far back to go.
 *
 * Mounted only while it is open, which is what makes `now` stable for as long
 * as the reader is looking at it: the day counts beside each month are read
 * against a single instant, so the list cannot shift underneath a selection
 * that has already been made.
 */
const IngestionResetDialog = ({
  retentionDays,
  administrationService,
  onClose,
  onDone,
}: IngestionResetDialogProps) => {
  const classes = useStyles();
  const [now] = useState(() => new Date());
  const [options] = useState<readonly ResetReach[]>(() => resetReachOptions(retentionDays, now));
  // Selected by position rather than by day count, so the control opens on the
  // whole retention — which `resetReachOptions` always puts last — without
  // needing a fallback for a value that could not be in the list anyway.
  const [selected, setSelected] = useState(() => options.length - 1);
  const [isResetting, setIsResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reach = options[selected];

  const confirm = async () => {
    setIsResetting(true);
    setError(null);
    try {
      const outcome = await administrationService.resetIngestion({ days: reach.days });
      onDone(outcome);
    } catch (caught) {
      // Kept inside the dialog rather than raised as a page-level panel: the
      // reader is mid-decision, and the two answers to a refusal — pick a
      // shorter reach, or give up — are both here.
      setError(messageOf(caught));
    } finally {
      setIsResetting(false);
    }
  };

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="resetIngestionTitle">
      <DialogTitle id="resetIngestionTitle">Re-collect history</DialogTitle>
      <DialogContent>
        <Typography variant="body2" className={classes.paragraph}>
          Every commit, pull request, review and pipeline run inside the chosen reach is discarded
          and read again from GitHub and Azure DevOps, as fast as their rate limits allow. History
          older than the reach is left exactly as it is.
        </Typography>
        <Typography variant="body2" className={classes.paragraph}>
          Until the backfill catches up the dashboards answer for the last day only, exactly as they
          do after installation, and wider ranges unlock as it advances — the same
          &ldquo;Collecting history&rdquo; bar reappears while it runs.
        </Typography>
        <Typography variant="body2" className={classes.paragraph}>
          Releases, tags, the daily snapshots (Sonar, compliance and README badges) and every
          identity link are kept. Nothing you have linked on the Identities tab is undone.
        </Typography>

        <TextField
          select
          fullWidth
          size="small"
          variant="outlined"
          // Material UI v4 associates the label with the control through this
          // id and nothing else, so leaving it out leaves the select unlabelled
          // to a screen reader however visible the caption looks.
          id="resetReach"
          label="How far back"
          className={classes.reach}
          value={selected}
          disabled={isResetting}
          onChange={(event) => setSelected(Number(event.target.value))}
          SelectProps={{ native: true }}
          // A native select never renders empty, so the outlined label has to be
          // told to sit above it rather than waiting for a value it already has.
          InputLabelProps={{ shrink: true }}
        >
          {options.map((option, index) => (
            <option key={option.days} value={index}>
              {option.label}
            </option>
          ))}
        </TextField>

        {error === null ? null : (
          <Typography variant="body2" color="error" className={classes.error}>
            {error}
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={isResetting}>
          Cancel
        </Button>
        <Button color="primary" variant="contained" disabled={isResetting} onClick={confirm}>
          {`Re-collect ${reach.confirmLabel}`}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

/**
 * The administrator's control for starting the history collection over.
 *
 * Drawn only for a caller the backend says may press it. That answer comes
 * from the backend rather than from anything the browser can work out for
 * itself, so the control and the route it calls can never disagree about who
 * is allowed — and the route authorises again regardless, because a button
 * that is merely absent is not an access control.
 *
 * It asks how far back before it does anything. A reset is not undoable and a
 * year across a large fleet is a day of rate-limited requests, which is
 * exactly the kind of cost that deserves a sentence and a choice rather than a
 * single click in a page header.
 */
export const IngestionResetButton = ({
  administrationService,
  onReset,
}: IngestionResetButtonProps) => {
  const { access } = useAccess(administrationService);
  const [isOpen, setIsOpen] = useState(false);
  const [outcome, setOutcome] = useState<ResetIngestionResponse | null>(null);

  const done = (result: ResetIngestionResponse) => {
    setIsOpen(false);
    setOutcome(result);
    // The caller re-reads coverage, which is what brings the backfill bar back
    // and narrows the range picker to what is left — the visible half of the
    // confirmation below.
    onReset();
  };

  // After the hooks, never before: the probe answers a render or two in, and a
  // guard above them would change how many hooks this component runs when it
  // does.
  if (!access.canResetIngestion) return null;

  return (
    <>
      <Tooltip title="Re-collect history">
        <IconButton
          size="small"
          color="inherit"
          aria-label="Re-collect history"
          onClick={() => setIsOpen(true)}
        >
          <HistoryIcon />
        </IconButton>
      </Tooltip>

      {isOpen ? (
        <IngestionResetDialog
          retentionDays={access.retentionDays}
          administrationService={administrationService}
          onClose={() => setIsOpen(false)}
          onDone={done}
        />
      ) : null}

      <Snackbar
        open={outcome !== null}
        autoHideDuration={CONFIRMATION_MS}
        onClose={() => setOutcome(null)}
        message={
          outcome === null
            ? ""
            : `Re-collecting ${counted(outcome.days, "day", "days")} of history for ` +
              `${counted(outcome.repositories, "repository", "repositories")}.`
        }
      />
    </>
  );
};
