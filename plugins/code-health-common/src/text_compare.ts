/**
 * The locale every displayed list is ordered by.
 *
 * Pinned for the same reason `number_format.ts` pins the one it formats
 * figures with, and deliberately the same value: a bare `localeCompare` takes
 * its order from whatever `LANG` the runtime happens to carry, and the lists
 * on this dashboard are not all sorted in the same runtime. A contributor row
 * is ordered on the server; the Insights card orders the same kind of list in
 * the browser. Two orders for one list reads as a bug in the data rather than
 * as a difference in locale, which is exactly what it would be.
 */
const SORT_LOCALE = "en-US";

/** Orders two display names the same way wherever the sort happens to run. */
export const compareNames = (left: string, right: string): number =>
  left.localeCompare(right, SORT_LOCALE);
