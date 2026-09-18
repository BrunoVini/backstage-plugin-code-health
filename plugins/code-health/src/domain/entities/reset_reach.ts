import { formatCount } from "@rios0rios0/backstage-plugin-code-health-common";
import { monthsBefore } from "./trend_range";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far back a re-collection may be asked to reach.
 *
 * Twelve is where the list stops rather than being the whole of it, because a
 * reset is usually asked for after a fix whose blast radius is known: someone
 * who only needs last quarter re-read should not pay for the other three, and
 * on a fleet of two hundred repositories that difference is most of a day of
 * rate-limited requests. The reaches are month counts because that is how the
 * question is asked out loud; the request itself carries days, which is the
 * only unit the backend's cursors understand.
 */
export const RESET_MONTHS: readonly number[] = [1, 2, 3, 6, 9, 12];

export interface ResetReach {
  /** How far back the walk goes, in days — what the request carries. */
  readonly days: number;
  /** What the option reads as in the list. */
  readonly label: string;
  /** What the confirm button names, so the button repeats the choice back. */
  readonly confirmLabel: string;
}

const monthLabel = (months: number): string =>
  `${months} ${months === 1 ? "month" : "months"}`;

// Grouped: a three-year retention reads `1,095 days` in the option list.
const dayLabel = (days: number): string =>
  `${formatCount(days)} ${days === 1 ? "day" : "days"}`;

/**
 * Whole days between `months` calendar months before `now` and `now`.
 *
 * Rounded up rather than down: `monthsBefore` keeps the time of day, so the
 * span is an exact number of days except across a daylight-saving change,
 * where it comes out an hour short. Truncating there would ask for a day less
 * than the label promises, and the missing day is the oldest one — exactly the
 * one somebody re-collecting a quarter is trying to reach.
 */
export const daysInMonths = (months: number, now: Date): number =>
  Math.ceil((now.getTime() - monthsBefore(now, months).getTime()) / DAY_MS);

/**
 * The whole of what the backend keeps, which is the reach a dialog opens on.
 *
 * A reset is nearly always asked for because something was collected wrongly,
 * and a partial re-read leaves the older half still wrong while looking
 * finished. The shorter reaches are the exception, not the default.
 */
export const fullRetentionReach = (retentionDays: number): ResetReach => ({
  days: retentionDays,
  label: `Everything retained (${dayLabel(retentionDays)})`,
  confirmLabel: dayLabel(retentionDays),
});

/**
 * The reaches offered for a given retention, shortest first.
 *
 * A count reaching past the retention is left off, because the backend refuses
 * it and there is nothing behind it to collect. A count landing *exactly* on
 * the retention is left off too: it is the full-retention option under a
 * second name, and two entries carrying one value make the select ambiguous
 * about which one is chosen.
 */
export const resetReachOptions = (
  retentionDays: number,
  now: Date,
): readonly ResetReach[] => [
  ...RESET_MONTHS.map((months) => ({ months, days: daysInMonths(months, now) }))
    .filter(({ days }) => days < retentionDays)
    .map(({ months, days }) => ({
      days,
      label: `${monthLabel(months)} (${dayLabel(days)})`,
      confirmLabel: monthLabel(months),
    })),
  fullRetentionReach(retentionDays),
];
