import Typography from "@material-ui/core/Typography";
import { makeStyles } from "@material-ui/core/styles";
import {
  describeRateDelta,
  formatRate,
  rateDeltaDirection,
  rateDeltaOf,
} from "@rios0rios0/backstage-plugin-code-health-common";

const useStyles = makeStyles((theme) => ({
  figure: { fontVariantNumeric: "tabular-nums" },
  reference: { display: "block", color: theme.palette.text.secondary, whiteSpace: "nowrap" },
  above: { color: theme.palette.success.main, whiteSpace: "nowrap" },
  below: { color: theme.palette.error.main, whiteSpace: "nowrap" },
  level: { color: theme.palette.text.secondary, whiteSpace: "nowrap" },
}));

/** The em dash every unmeasured figure on the dashboard prints. */
export const UNMEASURED = "—";

export interface RateFigureProps {
  /** One period's worth of the row's own figure, or null when never measured. */
  readonly value: number | null;
  /** The same period's worth of the average it is read against, or null. */
  readonly reference: number | null;
  /** What the average is called underneath: "team" or "fleet". */
  readonly referenceLabel: string;
  /** Coding time is a duration; everything else is a count. */
  readonly format?: (value: number) => string;
}

/**
 * One figure with the average it is read against printed underneath it.
 *
 * The average travels with the figure rather than sitting in a column of its
 * own, so a reader comparing "1.2 a day" with the team does not have to carry
 * the number across the row: the two are one above the other, in the same
 * period and the same unit. An em dash on either line is a figure nobody
 * measured, never a zero.
 */
export const RateFigure = ({ value, reference, referenceLabel, format }: RateFigureProps) => {
  const classes = useStyles();
  const say = (figure: number): string => (format ? format(figure) : formatRate(figure));

  return (
    <>
      <Typography variant="body2" component="span" className={classes.figure} data-figure>
        {value === null ? UNMEASURED : say(value)}
      </Typography>
      <Typography variant="caption" component="span" className={classes.reference}>
        {`${referenceLabel} ${reference === null ? UNMEASURED : say(reference)}`}
      </Typography>
    </>
  );
};

export interface RateDeltaProps {
  readonly value: number | null;
  readonly reference: number | null;
  /** What the delta is against, in the sentence: "the team" or "the fleet". */
  readonly against: string;
}

/**
 * How far the row sits from the average, as a percentage of the average.
 *
 * Said in words rather than as a signed number — "25% above the team" — so
 * the direction is never a matter of remembering which way a minus sign
 * points. Coloured the way the productivity score reads output, with above
 * the average in the success colour and below it in the error colour; the
 * card's caption says what that does and does not mean on the page it is on.
 * An em dash where either side is unmeasured or the average is zero, because
 * against an average of nothing every rate is infinitely above it.
 */
export const RateDelta = ({ value, reference, against }: RateDeltaProps) => {
  const classes = useStyles();
  const delta = rateDeltaOf(value, reference);

  if (delta === null) {
    return (
      <Typography variant="body2" component="span" className={classes.level}>
        {UNMEASURED}
      </Typography>
    );
  }

  const direction = rateDeltaDirection(delta);

  return (
    <Typography
      variant="body2"
      component="span"
      className={classes[direction]}
      data-direction={direction}
    >
      {describeRateDelta(delta, against)}
    </Typography>
  );
};
