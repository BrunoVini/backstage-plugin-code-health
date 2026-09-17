import { lastCoveredDayOf } from "../src/time_window";

describe("lastCoveredDayOf", () => {
  it("should end a window that stops at midnight on the day before", () => {
    // given
    // The Jira enricher's trailing window ends at the start of tomorrow, and a
    // calendar month at the first instant of the next one; neither covers that
    // day.
    const window = { from: "2026-08-11T00:00:00.000Z", to: "2026-08-31T00:00:00.000Z" };

    // when
    const last = lastCoveredDayOf(window);

    // then
    expect(last).toBe("2026-08-30");
  });

  it("should end a window that stops mid-day on that same day", () => {
    // given
    const window = { from: "2026-08-11T00:00:00.000Z", to: "2026-08-31T15:30:00.000Z" };

    // when / then
    expect(lastCoveredDayOf(window)).toBe("2026-08-31");
  });

  it("should give up on an end it cannot read", () => {
    // given / when / then
    expect(lastCoveredDayOf({ from: "2026-08-11T00:00:00.000Z", to: "not a date" })).toBeNull();
  });
});
