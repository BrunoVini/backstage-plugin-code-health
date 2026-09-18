import {
  catalogEntityPath,
  formatDecimal,
} from "@rios0rios0/backstage-plugin-code-health-common";
import Avatar from "@material-ui/core/Avatar";
import Box from "@material-ui/core/Box";
import Link from "@material-ui/core/Link";
import Tooltip from "@material-ui/core/Tooltip";
import Typography from "@material-ui/core/Typography";
import { makeStyles } from "@material-ui/core/styles";
import { Link as RouterLink } from "react-router-dom";
import type { RankedItem } from "../../../domain/entities/insights";
import { useChartPalette } from "./chart_palette";

const BAR_HEIGHT = 10;
const RADIUS = 4;

const useStyles = makeStyles((theme) => ({
  row: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 11rem) 1fr auto",
    alignItems: "center",
    gap: theme.spacing(1.5),
    padding: theme.spacing(0.75, 0),
  },
  identity: {
    display: "flex",
    alignItems: "center",
    gap: theme.spacing(1),
    minWidth: 0,
  },
  avatar: { width: 24, height: 24, fontSize: "0.7rem" },
  label: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: theme.palette.text.primary,
  },
  // The track is the empty remainder of the bar. Recessive by design: it is a
  // reference, not data.
  //
  // Plain elements rather than SVG: a `<rect rx>` inside a viewBox stretched to
  // the container width scales its corner radius with the x-axis, so the 4px
  // round end renders as a flattened ellipse several times wider than it is
  // tall. A CSS radius is exactly 4px whatever the width.
  track: {
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
  detail: { color: theme.palette.text.secondary },
  empty: { color: theme.palette.text.secondary, padding: theme.spacing(2, 0) },
}));

const initialsOf = (label: string): string =>
  label
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");

export interface RankingChartProps {
  readonly items: readonly RankedItem[];
  /** Noun for the value, e.g. `commits`. Used in the tooltip and the aria label. */
  readonly unit: string;
  readonly showAvatars?: boolean;
  readonly emptyMessage: string;
  /**
   * Fixes the scale instead of deriving it from the largest bar.
   *
   * A percentage has a real ceiling, and scaling it to the top row would draw
   * the worst-covered repository in a set as a full bar — the exact opposite of
   * what the chart is saying.
   */
  readonly scaleMax?: number;
  /** Renders the number. Defaults to a grouped figure with at most one decimal. */
  readonly formatValue?: (value: number) => string;
  /**
   * Where a row's label goes, or null for plain text.
   *
   * Defaults to the row's catalog entity. The Contributors and Repositories
   * tabs point their rankings at the plugin's own detail pages instead, so
   * clicking a name opens the trend rather than leaving the plugin.
   */
  readonly linkTo?: (item: RankedItem) => string | null;
}

/**
 * A horizontal ranking.
 *
 * Horizontal rather than vertical because the categories are names: a vertical
 * bar chart would tilt them 45° or truncate them, and the whole point of the
 * chart is knowing who is on it.
 *
 * One hue, varying only in length. The bars encode magnitude, not identity, so
 * painting each a different colour would imply a category difference that is
 * not there — and would repaint every bar whenever the ranking changed.
 */
export const RankingChart = ({
  items,
  unit,
  showAvatars = false,
  emptyMessage,
  scaleMax,
  formatValue = (value) => formatDecimal(value),
  linkTo = (item) => (item.entityRef === null ? null : catalogEntityPath(item.entityRef)),
}: RankingChartProps) => {
  const classes = useStyles();
  const palette = useChartPalette();

  if (items.length === 0) {
    return (
      <Typography variant="body2" className={classes.empty}>
        {emptyMessage}
      </Typography>
    );
  }

  const max = scaleMax ?? Math.max(...items.map((item) => item.value));

  return (
    <Box role="list">
      {items.map((item) => {
        const path = linkTo(item);
        const width = max === 0 ? 0 : (item.value / max) * 100;

        return (
          <Box
            key={item.id}
            className={classes.row}
            role="listitem"
            aria-label={`${item.label}: ${formatValue(item.value)} ${unit}, ${item.detail}`}
          >
            <Box className={classes.identity}>
              {showAvatars ? (
                <Avatar
                  className={classes.avatar}
                  src={item.avatarUrl ?? undefined}
                  alt=""
                >
                  {initialsOf(item.label)}
                </Avatar>
              ) : null}
              <Tooltip title={item.label}>
                <Typography variant="body2" className={classes.label}>
                  {path === null ? (
                    item.label
                  ) : (
                    <Link component={RouterLink} to={path} color="inherit">
                      {item.label}
                    </Link>
                  )}
                </Typography>
              </Tooltip>
            </Box>

            <Tooltip title={`${formatValue(item.value)} ${unit} · ${item.detail}`}>
              <Box className={classes.track} style={{ background: palette.grid }}>
                <Box
                  className={classes.fill}
                  style={{
                    width: `${Math.max(width, 0.5)}%`,
                    background: palette.series[0],
                  }}
                />
              </Box>
            </Tooltip>

            <Box textAlign="right">
              <Typography variant="body2" className={classes.value}>
                {formatValue(item.value)}
              </Typography>
              <Typography variant="caption" className={classes.detail}>
                {item.detail}
              </Typography>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
};
