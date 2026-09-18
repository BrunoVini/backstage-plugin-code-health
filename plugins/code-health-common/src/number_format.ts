/**
 * How every figure the dashboard prints is spelled.
 *
 * A figure on this dashboard is read, not parsed. `76604.9` is five digits a
 * reader has to count before they know whether it says seventy thousand or
 * seven hundred thousand, and the Averages card puts six of them in a column
 * next to a second row of averages to compare them against — which is a
 * counting exercise, not a comparison. Grouped, `76,604.9` is legible at a
 * glance and so is the `9,734.2` under it.
 *
 * Everything that reaches a screen goes through one of the four functions
 * below rather than through `toFixed`, `toLocaleString` or a bare
 * interpolation, for the same reason the scores share `combineScore`: the
 * alternative is thirty call sites that agree until one of them is corrected.
 */

/**
 * The locale every figure is grouped and pointed in.
 *
 * Pinned rather than left to the runtime, which is what `toLocaleString()`
 * with no argument does. Three reasons, in order of how badly each bites:
 *
 * 1. **The two sides would disagree.** A score component's sentence — "1,204
 *    commits a day against the team's average of 96.2" — is built by the
 *    backend for a trend and by the browser for the same person's table row.
 *    Left to the runtime, a server under `LANG=de_DE` and a browser under
 *    `en-GB` spell one figure two ways on one screen.
 * 2. **The prose is English.** Every noun beside these figures is, so
 *    `9.307,9 commits a day` mixes two conventions in one sentence and reads
 *    as a typo in whichever half the reader does not expect.
 * 3. **Tests would depend on the machine.** A pinned locale is the same
 *    string on a developer's workstation and in CI.
 *
 * It is deliberately not configuration. Localising the plugin means
 * translating its prose, at which point the number format travels with the
 * translation rather than on its own.
 */
const NUMBER_LOCALE = "en-US";

/**
 * What a figure nobody measured prints as, everywhere on the dashboard.
 *
 * Kept here as well as in the views because these functions are the last stop
 * before a `NaN` or an `∞` reaches a cell: both are real possibilities from a
 * ratio whose denominator was zero, and either one on a row somebody is
 * evaluated by reads as a fault in the plugin rather than as an absent
 * measurement.
 */
const UNMEASURED = "—";

/**
 * One formatter per shape, built once.
 *
 * `new Intl.NumberFormat(...)` resolves a locale and builds a pattern on every
 * call, and the repositories table alone formats several hundred figures per
 * render. A shape is one (minimum, maximum) pair, and the call sites ask for a
 * handful of them, so the cache is bounded by the vocabulary below rather than
 * by anything a caller can grow.
 */
const formatters = new Map<string, Intl.NumberFormat>();

const formatterFor = (
  minimumFractionDigits: number,
  maximumFractionDigits: number,
): Intl.NumberFormat => {
  const key = `${minimumFractionDigits}:${maximumFractionDigits}`;
  const cached = formatters.get(key);
  if (cached !== undefined) return cached;

  const formatter = new Intl.NumberFormat(NUMBER_LOCALE, {
    minimumFractionDigits,
    maximumFractionDigits,
    useGrouping: true,
  });
  formatters.set(key, formatter);
  return formatter;
};

const say = (
  value: number,
  minimumFractionDigits: number,
  maximumFractionDigits: number,
): string =>
  Number.isFinite(value)
    ? formatterFor(minimumFractionDigits, maximumFractionDigits).format(value)
    : UNMEASURED;

/**
 * A count, grouped and with no decimal part: `1,204`.
 *
 * What almost every figure on the dashboard is. Anything fractional reaching
 * it is rounded rather than refused — a mean of a count is still read as a
 * count — so a caller that wants the fraction kept asks for it explicitly.
 */
export const formatCount = (value: number): string => say(value, 0, 0);

/**
 * A figure with up to `maximumFractionDigits` decimals, grouped, with trailing
 * zeros dropped: `1,204.5`, and `1,204` for a value that lands on the whole.
 *
 * The zeros go because they claim a precision the count underneath never had:
 * `5.00 commits a day` reads as a measurement to the hundredth when it is five
 * commits in one day.
 */
export const formatDecimal = (value: number, maximumFractionDigits = 1): string =>
  say(value, 0, Math.max(0, maximumFractionDigits));

/**
 * A figure with exactly `fractionDigits` decimals, grouped: `62.0`.
 *
 * For a column rather than a sentence. Coverage running `62.0 / 8.5 / 100.0`
 * down a table aligns on the point and is scanned as one shape; the same
 * column with the zeros trimmed has to be read a row at a time.
 */
export const formatFixed = (value: number, fractionDigits = 1): string => {
  // Floored the way {@link formatDecimal} floors its own argument: `Intl`
  // throws a `RangeError` on a negative digit count, and a formatter that
  // throws out of a table cell takes the whole row's render with it.
  const digits = Math.max(0, fractionDigits);
  return say(value, digits, digits);
};

/**
 * A percentage, grouped, with up to `maximumFractionDigits` decimals: `62.3%`.
 *
 * Grouped because not every percentage on the dashboard is bounded by a
 * hundred: a rate read against the team's average is a share of it, and
 * somebody eleven times the team's rate is `1,110% above the team`.
 */
export const formatPercent = (value: number, maximumFractionDigits = 1): string => {
  const said = formatDecimal(value, maximumFractionDigits);
  return said === UNMEASURED ? said : `${said}%`;
};
