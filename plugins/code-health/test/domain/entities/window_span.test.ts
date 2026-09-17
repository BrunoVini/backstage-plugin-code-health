import { formatWindowSpan } from "../../../src/domain/entities/window_span";

describe("formatWindowSpan", () => {
  it("should print the last day the window covers rather than the instant it stops at", () => {
    // given
    // Twenty days of tickets ending at the start of the 31st cover the 30th.
    const window = { from: "2026-08-11T00:00:00.000Z", to: "2026-08-31T00:00:00.000Z" };

    // when
    const span = formatWindowSpan(window);

    // then
    expect(span).toBe("Aug 11 to Aug 30");
  });

  it("should print a window that ends mid-day on that day", () => {
    // given / when / then
    expect(
      formatWindowSpan({ from: "2026-08-11T00:00:00.000Z", to: "2026-08-31T12:00:00.000Z" }),
    ).toBe("Aug 11 to Aug 31");
  });

  it("should print an end it cannot read as it arrived", () => {
    // given / when / then
    expect(formatWindowSpan({ from: "2026-08-11T00:00:00.000Z", to: "later" })).toBe(
      "Aug 11 to later",
    );
  });
});
