import {
  catalogEntityPath,
  formatCount,
} from "@rios0rios0/backstage-plugin-code-health-common";
import Box from "@material-ui/core/Box";
import Link from "@material-ui/core/Link";
import Typography from "@material-ui/core/Typography";
import { makeStyles } from "@material-ui/core/styles";
import { Link as RouterLink } from "react-router-dom";
import type { GapList as GapListData } from "../../../domain/entities/insights";

const useStyles = makeStyles((theme) => ({
  row: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    alignItems: "baseline",
    gap: theme.spacing(1.5),
    padding: theme.spacing(0.5, 0),
  },
  label: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: theme.palette.text.primary,
  },
  reason: {
    color: theme.palette.text.secondary,
    fontFamily: "monospace",
    fontSize: "0.72rem",
  },
  note: { color: theme.palette.text.secondary, paddingTop: theme.spacing(1) },
  empty: { color: theme.palette.text.secondary, padding: theme.spacing(2, 0) },
}));

export interface GapListProps {
  readonly gaps: GapListData;
  readonly emptyMessage: string;
}

/**
 * The repositories behind a slice of a breakdown, by name.
 *
 * A bar says how many; this says which, because "eleven repositories have no
 * documentation" is not something anybody can act on until they know the
 * eleven. Each row carries the evidence that put it on the list, so a reader
 * can tell a real finding from a heuristic without leaving the page, and links
 * to the catalog entity, which is where the annotation that closes the gap gets
 * written.
 */
export const GapList = ({ gaps, emptyMessage }: GapListProps) => {
  const classes = useStyles();

  if (gaps.items.length === 0) {
    return (
      <Typography variant="body2" className={classes.empty}>
        {emptyMessage}
      </Typography>
    );
  }

  return (
    <Box role="list">
      {gaps.items.map((item) => {
        const path = item.entityRef === null ? null : catalogEntityPath(item.entityRef);

        return (
          <Box
            key={item.id}
            className={classes.row}
            role="listitem"
            aria-label={`${item.label}: ${item.reason}`}
          >
            <Typography variant="body2" className={classes.label} title={item.label}>
              {path === null ? (
                item.label
              ) : (
                <Link component={RouterLink} to={path} color="inherit">
                  {item.label}
                </Link>
              )}
            </Typography>
            <Typography variant="caption" className={classes.reason}>
              {item.reason}
            </Typography>
          </Box>
        );
      })}

      {gaps.remaining > 0 ? (
        <Typography variant="caption" className={classes.note} component="p">
          and {formatCount(gaps.remaining)} more
        </Typography>
      ) : null}
    </Box>
  );
};
