import Box from "@material-ui/core/Box";
import TextField from "@material-ui/core/TextField";
import Typography from "@material-ui/core/Typography";
import { TREND_MONTHS } from "@rios0rios0/backstage-plugin-code-health-common";
import { monthLabel, type MonthSelection } from "../../domain/entities/time_range";
import {
  trendSelectionFromKey,
  trendSelectionKey,
  type TrendSelection,
} from "../../domain/entities/trend_range";

export interface TrendRangePickerProps {
  readonly selection: TrendSelection;
  /** Only the rolling counts the backend has ingested enough history for. */
  readonly offered: readonly number[];
  /** Every calendar month the backfill has reached, newest first. */
  readonly months: readonly MonthSelection[];
  readonly onChange: (selection: TrendSelection) => void;
}

export const trendRangeLabel = (months: number): string =>
  months === 1 ? "Last month" : `Last ${months} months`;

/**
 * How far back a detail page looks: a rolling one to six months, or one named
 * calendar month.
 *
 * The months are named for the same reason the tables' picker names them. This
 * control used to offer rolling counts alone, so somebody who had just read
 * "September" on the Contributors tab and clicked through to a person found no
 * way to ask the same question about them — and no way to tell from the list
 * that a month could be asked for at all. Both screens now resolve a month
 * through the same `toWindow`, so "September" cannot mean two different windows
 * depending on which tab you reached it from.
 *
 * Counts and months the backfill has not reached are left off, and the caption
 * says why the list is short, so a fresh install reads as "still collecting"
 * rather than as a broken control.
 */
export const TrendRangePicker = ({
  selection,
  offered,
  months,
  onChange,
}: TrendRangePickerProps) => (
  <Box display="flex" alignItems="center" gridGap={12} flexWrap="wrap">
    <TextField
      select
      size="small"
      value={trendSelectionKey(selection)}
      onChange={(event) => {
        // A browser handed a value none of its options carry reports the empty
        // string back. Staying put beats querying for nobody's window.
        const next = trendSelectionFromKey(event.target.value);
        if (next !== null) onChange(next);
      }}
      SelectProps={{ native: true }}
      inputProps={{ "aria-label": "Trend range" }}
    >
      <optgroup label="Rolling">
        {offered.map((count) => (
          <option key={count} value={trendSelectionKey({ kind: "months", months: count })}>
            {trendRangeLabel(count)}
          </option>
        ))}
      </optgroup>
      {/* Omitted rather than left empty: a group heading with nothing under it
          reads as an integration that broke, and a brand new install has no
          coverage to offer a month from yet. */}
      {months.length > 0 ? (
        <optgroup label="Calendar months">
          {months.map((month) => {
            const key = trendSelectionKey({ kind: "month", month });
            return (
              <option key={key} value={key}>
                {monthLabel(month)}
              </option>
            );
          })}
        </optgroup>
      ) : null}
    </TextField>
    {offered.length < TREND_MONTHS.length ? (
      <Typography variant="caption" color="textSecondary">
        Wider ranges unlock as the history is collected.
      </Typography>
    ) : null}
  </Box>
);
