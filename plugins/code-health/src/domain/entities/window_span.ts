import type { TimeWindow } from "@rios0rios0/backstage-plugin-code-health-common";
import { lastCoveredDayOf } from "@rios0rios0/backstage-plugin-code-health-common";

const formatDay = (day: string): string => {
  const parsed = new Date(day);
  return Number.isNaN(parsed.getTime())
    ? day
    : parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
};

/**
 * A window as two dates a reader can check: `Aug 11 to Aug 30`.
 *
 * The end is the last day the window *covers*, not the instant it stops at.
 * The windows the plugin stores are half-open and routinely end at midnight,
 * so printing `to` as a date would name a day the window never reached —
 * "Aug 11 to Aug 31" for twenty days of tickets that ended on the 30th. An
 * end that cannot be read is printed as it arrived.
 */
export const formatWindowSpan = (window: TimeWindow): string => {
  const last = lastCoveredDayOf(window);
  return `${formatDay(window.from)} to ${last === null ? window.to : formatDay(last)}`;
};
