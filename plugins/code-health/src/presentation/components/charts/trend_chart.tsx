import { formatDecimal } from "@rios0rios0/backstage-plugin-code-health-common";
import Box from "@material-ui/core/Box";
import Typography from "@material-ui/core/Typography";
import { makeStyles, useTheme } from "@material-ui/core/styles";
import { useCallback, useMemo, useRef, useState } from "react";
import { useChartPalette } from "./chart_palette";

const useStyles = makeStyles((theme) => ({
  wrapper: { position: "relative", width: "100%" },
  svg: { display: "block", width: "100%", overflow: "visible" },
  legend: {
    display: "flex",
    gap: theme.spacing(2),
    alignItems: "center",
    marginBottom: theme.spacing(1),
  },
  legendEntry: { display: "flex", alignItems: "center", gap: theme.spacing(0.75) },
  swatch: { width: 10, height: 10, borderRadius: 2, display: "inline-block" },
  legendLabel: { color: theme.palette.text.secondary },
  tick: { fill: theme.palette.text.secondary, fontSize: 10 },
  tooltip: {
    position: "absolute",
    pointerEvents: "none",
    zIndex: 2,
    background: theme.palette.background.paper,
    border: `1px solid ${theme.palette.divider}`,
    borderRadius: theme.shape.borderRadius,
    boxShadow: theme.shadows[3],
    padding: theme.spacing(1, 1.25),
    whiteSpace: "nowrap",
  },
  tooltipRow: { display: "flex", alignItems: "center", gap: theme.spacing(0.75) },
  empty: { color: theme.palette.text.secondary, padding: theme.spacing(3, 0) },
}));

const WIDTH = 720;
const DEFAULT_HEIGHT = 200;
const PADDING = { top: 8, right: 8, bottom: 22, left: 36 };
const PLOT_WIDTH = WIDTH - PADDING.left - PADDING.right;

/** A y-axis top that lands on a round number, so the gridline labels read cleanly. */
const niceCeiling = (value: number): number => {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
};

export const formatTrendDay = (day: string): string => {
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return day;
  return parsed.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
};

export interface TrendSeries {
  readonly key: string;
  readonly label: string;
  /** Fills the area under the line, for the series that reads as a volume. */
  readonly area?: boolean;
}

export interface TrendPoint {
  readonly day: string;
  /** One value per series key; null where the bucket has no measurement. */
  readonly values: Readonly<Record<string, number | null>>;
}

export interface TrendChartProps {
  readonly points: readonly TrendPoint[];
  /** At most two are drawn: the palette carries two series colours, on purpose. */
  readonly series: readonly TrendSeries[];
  readonly emptyMessage?: string;
  /** Read out for assistive technology. Defaults to the series names and the range. */
  readonly ariaLabel?: string;
  /** Renders a value. Defaults to a grouped figure with at most one decimal. */
  readonly formatValue?: (value: number) => string;
  /** Fixes the scale instead of deriving it from the tallest point, e.g. 100 for a percentage. */
  readonly scaleMax?: number;
  readonly height?: number;
}

/** Contiguous runs of measured points, so a gap breaks the line rather than bridging it. */
const runsOf = (points: readonly TrendPoint[], key: string): number[][] => {
  const runs: number[][] = [];
  let current: number[] = [];
  points.forEach((point, index) => {
    if (point.values[key] === null || point.values[key] === undefined) {
      if (current.length > 0) runs.push(current);
      current = [];
    } else {
      current.push(index);
    }
  });
  if (current.length > 0) runs.push(current);
  return runs;
};

/**
 * One or two series over time, on one y-axis.
 *
 * Both series share a scale on purpose. A second axis would let the two lines
 * cross wherever the scales were chosen to make them cross, which is the most
 * common way a chart like this lies; two series that cannot share a scale
 * belong on two charts. A bucket with no measurement breaks the line rather
 * than being drawn as zero, because "not measured" and "nothing happened" are
 * different facts and a chart that merges them reads a gap in collection as a
 * collapse in the figure.
 */
export const TrendChart = ({
  points,
  series,
  emptyMessage = "No activity was recorded in this window.",
  ariaLabel,
  formatValue = (value) => formatDecimal(value),
  scaleMax,
  height = DEFAULT_HEIGHT,
}: TrendChartProps) => {
  const classes = useStyles();
  const palette = useChartPalette();
  const theme = useTheme();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);

  const plotHeight = height - PADDING.top - PADDING.bottom;

  const drawn = useMemo(
    () =>
      series.slice(0, palette.series.length).map((entry, index) => ({
        ...entry,
        color: palette.series[index],
      })),
    [series, palette],
  );

  const max = useMemo(() => {
    if (scaleMax !== undefined) return scaleMax;
    const values = points.flatMap((point) =>
      drawn.map((entry) => point.values[entry.key] ?? 0),
    );
    return niceCeiling(Math.max(1, ...values));
  }, [points, drawn, scaleMax]);

  const xOf = useCallback(
    (index: number): number =>
      points.length <= 1
        ? PADDING.left + PLOT_WIDTH / 2
        : PADDING.left + (index / (points.length - 1)) * PLOT_WIDTH,
    [points.length],
  );

  const yOf = useCallback(
    (value: number): number =>
      PADDING.top + plotHeight - (Math.min(value, max) / max) * plotHeight,
    [max, plotHeight],
  );

  const onMove = useCallback(
    (event: React.MouseEvent<SVGSVGElement>) => {
      const svg = svgRef.current;
      if (!svg || points.length === 0) return;

      const bounds = svg.getBoundingClientRect();
      // The viewBox scales to the container, so the pointer has to be mapped
      // back into viewBox units before it means anything.
      const x = ((event.clientX - bounds.left) / bounds.width) * WIDTH;
      const ratio = (x - PADDING.left) / PLOT_WIDTH;
      const index = Math.round(ratio * (points.length - 1));
      setHovered(Math.min(points.length - 1, Math.max(0, index)));
    },
    [points.length],
  );

  if (points.length === 0) {
    return (
      <Typography variant="body2" className={classes.empty}>
        {emptyMessage}
      </Typography>
    );
  }

  const first = points[0];
  const last = points[points.length - 1];
  const label =
    ariaLabel ??
    `${drawn.map((entry) => entry.label).join(" and ")} from ${formatTrendDay(
      first.day,
    )} to ${formatTrendDay(last.day)}`;

  const lineFor = (key: string, run: readonly number[]): string =>
    run.map((index) => `${xOf(index)},${yOf(points[index].values[key] ?? 0)}`).join(" ");

  const areaFor = (key: string, run: readonly number[]): string =>
    `${xOf(run[0])},${PADDING.top + plotHeight} ${lineFor(key, run)} ${xOf(
      run[run.length - 1],
    )},${PADDING.top + plotHeight}`;

  const gridValues = [0, max / 2, max];
  const active = hovered === null ? null : points[hovered];
  // Flip the tooltip to the left of the crosshair once it would overflow the
  // right edge, so the last bucket is still readable.
  const tooltipLeft = hovered === null ? 0 : (xOf(hovered) / WIDTH) * 100;
  const flip = tooltipLeft > 65;

  return (
    <Box>
      <Box className={classes.legend}>
        {drawn.map((entry) => (
          <Box key={entry.key} className={classes.legendEntry}>
            <span className={classes.swatch} style={{ background: entry.color }} />
            <Typography variant="caption" className={classes.legendLabel}>
              {entry.label}
            </Typography>
          </Box>
        ))}
      </Box>

      <Box className={classes.wrapper}>
        <svg
          ref={svgRef}
          className={classes.svg}
          viewBox={`0 0 ${WIDTH} ${height}`}
          role="img"
          aria-label={label}
          onMouseMove={onMove}
          onMouseLeave={() => setHovered(null)}
        >
          {gridValues.map((value) => (
            <g key={value}>
              <line
                x1={PADDING.left}
                x2={PADDING.left + PLOT_WIDTH}
                y1={yOf(value)}
                y2={yOf(value)}
                stroke={palette.grid}
                strokeWidth={1}
              />
              <text
                x={PADDING.left - 6}
                y={yOf(value) + 3}
                textAnchor="end"
                className={classes.tick}
              >
                {formatValue(value)}
              </text>
            </g>
          ))}

          {drawn.map((entry) =>
            runsOf(points, entry.key).map((run) => (
              <g key={`${entry.key}:${run[0]}`}>
                {entry.area ? (
                  <polygon points={areaFor(entry.key, run)} fill={entry.color} opacity={0.16} />
                ) : null}
                <polyline
                  points={lineFor(entry.key, run)}
                  fill="none"
                  stroke={entry.color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </g>
            )),
          )}

          {hovered !== null ? (
            <g>
              <line
                x1={xOf(hovered)}
                x2={xOf(hovered)}
                y1={PADDING.top}
                y2={PADDING.top + plotHeight}
                stroke={palette.axis}
                strokeWidth={1}
              />
              {drawn.map((entry) => {
                const value = points[hovered].values[entry.key];
                if (value === null || value === undefined) return null;
                return (
                  <circle
                    key={entry.key}
                    cx={xOf(hovered)}
                    cy={yOf(value)}
                    r={4}
                    fill={entry.color}
                    // A 2px ring in the surface colour keeps the two markers
                    // legible where the series touch.
                    stroke={theme.palette.background.paper}
                    strokeWidth={2}
                  />
                );
              })}
            </g>
          ) : null}

          <text x={PADDING.left} y={height - 4} className={classes.tick}>
            {formatTrendDay(first.day)}
          </text>
          <text
            x={PADDING.left + PLOT_WIDTH}
            y={height - 4}
            textAnchor="end"
            className={classes.tick}
          >
            {formatTrendDay(last.day)}
          </text>
        </svg>

        {active ? (
          <div
            className={classes.tooltip}
            style={{
              left: `${tooltipLeft}%`,
              top: 0,
              transform: flip ? "translateX(calc(-100% - 12px))" : "translateX(12px)",
            }}
          >
            <Typography variant="caption" color="textSecondary">
              {formatTrendDay(active.day)}
            </Typography>
            {drawn.map((entry) => {
              const value = active.values[entry.key];
              return (
                <Box key={entry.key} className={classes.tooltipRow}>
                  <span className={classes.swatch} style={{ background: entry.color }} />
                  <Typography variant="body2">
                    {entry.label}:{" "}
                    <strong>
                      {value === null || value === undefined ? "not measured" : formatValue(value)}
                    </strong>
                  </Typography>
                </Box>
              );
            })}
          </div>
        ) : null}
      </Box>
    </Box>
  );
};
