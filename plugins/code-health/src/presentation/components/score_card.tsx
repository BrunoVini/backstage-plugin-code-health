import { InfoCard } from "@backstage/core-components";
import Box from "@material-ui/core/Box";
import Tooltip from "@material-ui/core/Tooltip";
import Typography from "@material-ui/core/Typography";
import { makeStyles } from "@material-ui/core/styles";
import type { Score, ScoreBand } from "@rios0rios0/backstage-plugin-code-health-common";
import {
  formatCount,
  formatPercent,
  formatScoreValue,
  scoreBand,
} from "@rios0rios0/backstage-plugin-code-health-common";
import type { StatusTone } from "../../domain/entities/insights";
import { useChartPalette } from "./charts/chart_palette";

const BAR_HEIGHT = 8;
const RADIUS = 4;

const useStyles = makeStyles((theme) => ({
  headline: {
    display: "flex",
    alignItems: "baseline",
    gap: theme.spacing(1.5),
    marginBottom: theme.spacing(0.5),
  },
  value: { fontSize: "2.75rem", lineHeight: 1, fontWeight: 500 },
  outOf: { color: theme.palette.text.secondary },
  band: { fontWeight: 500 },
  evidence: { color: theme.palette.text.secondary, display: "block", marginBottom: theme.spacing(2) },
  row: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 12rem) 1fr auto",
    alignItems: "center",
    gap: theme.spacing(1.5),
    padding: theme.spacing(0.5, 0),
  },
  label: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: theme.palette.text.primary,
  },
  unmeasuredLabel: { color: theme.palette.text.secondary },
  track: { width: "100%", height: BAR_HEIGHT, borderRadius: RADIUS, overflow: "hidden" },
  fill: { height: "100%", borderRadius: RADIUS },
  weight: {
    fontVariantNumeric: "tabular-nums",
    color: theme.palette.text.secondary,
    whiteSpace: "nowrap",
  },
  detail: { color: theme.palette.text.secondary, display: "block" },
  empty: { color: theme.palette.text.secondary, padding: theme.spacing(2, 0) },
}));

/** What each band is called on the screen. */
export const SCORE_BAND_LABELS: Readonly<Record<ScoreBand, string>> = {
  good: "Healthy",
  fair: "Fair",
  poor: "Needs attention",
  unknown: "Not measured",
};

/** Which of the reserved status colours each band borrows. */
const BAND_TONES: Readonly<Record<ScoreBand, StatusTone>> = {
  good: "good",
  fair: "warning",
  poor: "critical",
  unknown: "unknown",
};

export interface ScoreCardProps {
  readonly title: string;
  readonly subheader?: string;
  readonly score: Score | null;
  /** Shown in place of the number when nothing could be measured. */
  readonly emptyMessage: string;
}

/**
 * One composite score, taken apart.
 *
 * The number is never shown alone. Every component sits under it with the
 * share of the score it carried, where the figure landed, and the sentence
 * explaining how it was read — because a bare score on a person's page is an
 * accusation with no evidence, and one on a repository's page is a number
 * nobody can act on. Components that could not be measured stay in the list,
 * greyed, so a score built on thin evidence looks like one.
 */
export const ScoreCard = ({ title, subheader, score, emptyMessage }: ScoreCardProps) => {
  const classes = useStyles();
  const palette = useChartPalette();

  const band = scoreBand(score?.value ?? null);
  const color = palette.status[BAND_TONES[band]];
  const measured = score?.components.filter((component) => component.normalized !== null) ?? [];

  return (
    <InfoCard title={title} subheader={subheader}>
      {score === null || score.value === null ? (
        <Typography variant="body2" className={classes.empty}>
          {emptyMessage}
        </Typography>
      ) : (
        <>
          <Box className={classes.headline}>
            <Typography
              component="span"
              className={classes.value}
              style={{ color }}
              data-band={band}
              aria-label={`Score ${formatScoreValue(score.value)} out of 100, ${SCORE_BAND_LABELS[band]}`}
            >
              {formatScoreValue(score.value)}
            </Typography>
            <Typography component="span" variant="body2" className={classes.outOf}>
              / 100
            </Typography>
            <Typography component="span" variant="body2" className={classes.band} style={{ color }}>
              {SCORE_BAND_LABELS[band]}
            </Typography>
          </Box>
          <Typography variant="caption" className={classes.evidence}>
            {`Based on ${formatCount(measured.length)} of ${formatCount(
              score.components.length,
            )} components, carrying ${formatPercent(score.evidence * 100, 0)} of the weight.`}
          </Typography>
        </>
      )}

      {score === null ? null : (
        <Box role="list" aria-label={`${title} components`}>
          {score.components.map((component) => {
            const unmeasured = component.normalized === null;
            const width = unmeasured ? 0 : (component.normalized ?? 0) * 100;

            return (
              <Box key={component.id} role="listitem" aria-label={`${component.label}: ${component.detail}`}>
                <Box className={classes.row}>
                  <Tooltip title={component.detail}>
                    <Typography
                      variant="body2"
                      className={`${classes.label} ${unmeasured ? classes.unmeasuredLabel : ""}`}
                    >
                      {component.label}
                    </Typography>
                  </Tooltip>
                  <Box className={classes.track} style={{ background: palette.grid }}>
                    <Box
                      className={classes.fill}
                      style={{
                        width: `${Math.max(width, unmeasured ? 0 : 0.5)}%`,
                        background: unmeasured ? "transparent" : palette.series[0],
                      }}
                    />
                  </Box>
                  <Typography variant="caption" className={classes.weight}>
                    {formatPercent(component.weight * 100, 0)}
                  </Typography>
                </Box>
                <Typography variant="caption" className={classes.detail}>
                  {component.detail}
                </Typography>
              </Box>
            );
          })}
        </Box>
      )}
    </InfoCard>
  );
};
