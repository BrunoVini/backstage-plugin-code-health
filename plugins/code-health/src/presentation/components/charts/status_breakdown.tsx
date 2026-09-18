import {
  formatCount,
  formatPercent,
} from "@rios0rios0/backstage-plugin-code-health-common";
import Box from "@material-ui/core/Box";
import Typography from "@material-ui/core/Typography";
import { makeStyles } from "@material-ui/core/styles";
import CheckCircleIcon from "@material-ui/icons/CheckCircle";
import ErrorIcon from "@material-ui/icons/Error";
import HelpIcon from "@material-ui/icons/HelpOutline";
import WarningIcon from "@material-ui/icons/Warning";
import type { StatusSlice, StatusTone } from "../../../domain/entities/insights";
import { useChartPalette } from "./chart_palette";

const BAR_HEIGHT = 10;
const RADIUS = 4;

const useStyles = makeStyles((theme) => ({
  row: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 10rem) 1fr auto",
    alignItems: "center",
    gap: theme.spacing(1.25),
    padding: theme.spacing(0.75, 0),
  },
  icon: { fontSize: "1.1rem" },
  label: { color: theme.palette.text.primary },
  // Plain elements rather than SVG, for the same reason as the ranking chart:
  // a stretched viewBox scales a `rect`'s corner radius with the x-axis.
  bar: {
    width: "100%",
    height: BAR_HEIGHT,
    borderRadius: RADIUS,
    overflow: "hidden",
  },
  fill: { height: "100%", borderRadius: RADIUS },
  value: {
    fontVariantNumeric: "tabular-nums",
    color: theme.palette.text.primary,
    fontWeight: 500,
  },
  share: { color: theme.palette.text.secondary, marginLeft: theme.spacing(0.75) },
}));

const ICONS: Record<StatusTone, typeof CheckCircleIcon> = {
  good: CheckCircleIcon,
  warning: WarningIcon,
  critical: ErrorIcon,
  unknown: HelpIcon,
};

export interface StatusBreakdownProps {
  readonly slices: readonly StatusSlice[];
}

/**
 * How a fixed set of states divides the fleet.
 *
 * Rows rather than a pie: comparing lengths on a shared baseline is something
 * the eye does well, and comparing angles is not — and this is the one place
 * the reserved status colours are allowed, so every row carries its own icon
 * and label and the colour never has to be decoded on its own.
 */
export const StatusBreakdown = ({ slices }: StatusBreakdownProps) => {
  const classes = useStyles();
  const palette = useChartPalette();

  const total = slices.reduce((sum, slice) => sum + slice.count, 0);

  return (
    <Box role="list">
      {slices.map((slice) => {
        const Icon = ICONS[slice.tone];
        const color = palette.status[slice.tone];
        const share = total === 0 ? 0 : (slice.count / total) * 100;

        return (
          <Box
            key={slice.label}
            className={classes.row}
            role="listitem"
            aria-label={`${slice.label}: ${formatCount(slice.count)} of ${formatCount(total)}`}
          >
            <Icon className={classes.icon} style={{ color }} aria-hidden="true" />
            <Typography variant="body2" className={classes.label}>
              {slice.label}
            </Typography>
            <Box className={classes.bar} style={{ background: palette.grid }}>
              <Box
                className={classes.fill}
                style={{
                  width: `${Math.max(share, slice.count > 0 ? 0.5 : 0)}%`,
                  background: color,
                }}
              />
            </Box>
            <Box textAlign="right" whiteSpace="nowrap">
              <Typography variant="body2" component="span" className={classes.value}>
                {formatCount(slice.count)}
              </Typography>
              <Typography variant="caption" component="span" className={classes.share}>
                {formatPercent(share, 0)}
              </Typography>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
};
