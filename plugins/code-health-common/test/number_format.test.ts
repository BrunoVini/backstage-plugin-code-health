import {
  formatCount,
  formatDecimal,
  formatFixed,
  formatPercent,
} from "../src/number_format";

describe("formatCount", () => {
  it("should group a figure past a thousand", () => {
    // given
    // The complaint this module exists for: five digits in the monthly column
    // of the Averages card are counted rather than read.

    // when / then
    expect(formatCount(9308)).toBe("9,308");
    expect(formatCount(76605)).toBe("76,605");
    expect(formatCount(1234567)).toBe("1,234,567");
  });

  it("should leave a figure below a thousand alone", () => {
    // given / when / then
    expect(formatCount(0)).toBe("0");
    expect(formatCount(7)).toBe("7");
    expect(formatCount(999)).toBe("999");
  });

  it("should round a fractional count rather than refuse it", () => {
    // given
    // A mean of a count is still read as a count, so the caller that wants the
    // fraction kept asks for it with `formatDecimal`.

    // when / then
    expect(formatCount(9307.9)).toBe("9,308");
    expect(formatCount(0.4)).toBe("0");
  });

  it("should keep a negative figure's sign", () => {
    // given / when / then
    expect(formatCount(-4210)).toBe("-4,210");
  });

  it("should print an em dash for anything that is not a number", () => {
    // given
    // These functions are the last stop before a cell: a ratio whose
    // denominator was zero reaching a row somebody is evaluated by as `NaN`
    // reads as a fault in the plugin rather than as an absent measurement.

    // when / then
    expect(formatCount(Number.NaN)).toBe("—");
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatCount(Number.NEGATIVE_INFINITY)).toBe("—");
  });
});

describe("formatDecimal", () => {
  it("should group the whole part and keep one decimal by default", () => {
    // given / when / then
    expect(formatDecimal(9307.94)).toBe("9,307.9");
    expect(formatDecimal(76604.85)).toBe("76,604.9");
  });

  it("should drop trailing zeros", () => {
    // given
    // They claim a precision the count underneath never had: "5.00 commits a
    // day" reads as a measurement to the hundredth when it is five commits in
    // one day.

    // when / then
    expect(formatDecimal(5)).toBe("5");
    expect(formatDecimal(1000)).toBe("1,000");
    expect(formatDecimal(0.1, 2)).toBe("0.1");
  });

  it("should keep as many decimals as it is asked for", () => {
    // given / when / then
    expect(formatDecimal(0.0712, 2)).toBe("0.07");
    expect(formatDecimal(1204.567, 2)).toBe("1,204.57");
    expect(formatDecimal(1204.567, 0)).toBe("1,205");
  });

  it("should treat a negative digit count as none", () => {
    // given / when / then
    expect(formatDecimal(1204.5, -3)).toBe("1,205");
  });

  it("should print an em dash for anything that is not a number", () => {
    // given / when / then
    expect(formatDecimal(Number.NaN)).toBe("—");
  });
});

describe("formatFixed", () => {
  it("should keep exactly the decimals asked for, so a column aligns", () => {
    // given
    // Coverage running `62.0 / 8.5 / 100.0` down a table is scanned as one
    // shape; the same column with its zeros trimmed is read a row at a time.

    // when / then
    expect(formatFixed(62)).toBe("62.0");
    expect(formatFixed(8.47)).toBe("8.5");
    expect(formatFixed(100)).toBe("100.0");
    expect(formatFixed(1204.5, 2)).toBe("1,204.50");
  });

  it("should treat a negative digit count as none, rather than throwing", () => {
    // given
    // `Intl` raises a `RangeError` on one, and a formatter that throws out of
    // a table cell takes the whole row's render with it.

    // when / then
    expect(formatFixed(1204.5, -2)).toBe("1,205");
  });

  it("should print an em dash for anything that is not a number", () => {
    // given / when / then
    expect(formatFixed(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("formatPercent", () => {
  it("should say a percentage with at most one decimal", () => {
    // given / when / then
    expect(formatPercent(62)).toBe("62%");
    expect(formatPercent(62.34)).toBe("62.3%");
    expect(formatPercent(62.34, 0)).toBe("62%");
  });

  it("should group a percentage past a thousand", () => {
    // given
    // A rate read against the team's average is a share of it, and it has no
    // ceiling: `1110% above the team` is four digits nobody reads as eleven
    // times.

    // when / then
    expect(formatPercent(1110, 0)).toBe("1,110%");
  });

  it("should print an em dash alone, with no percent sign after it", () => {
    // given / when / then
    expect(formatPercent(Number.NaN)).toBe("—");
  });
});

describe("the pinned locale", () => {
  it("should group and point the same way whatever the runtime's locale is", () => {
    // given
    // A score component's sentence is built by the backend for a trend and by
    // the browser for the same person's table row. Left to the runtime, a
    // server under `de-DE` and a browser under `en-GB` would spell one figure
    // two ways on one screen.
    const runtime = new Intl.NumberFormat("de-DE").format(9307.9);

    // when
    const said = formatDecimal(9307.9);

    // then
    expect(runtime).toBe("9.307,9");
    expect(said).toBe("9,307.9");
  });
});
