import {
  addDays,
  fromStoredDate,
  daysBetween,
  daysInRange,
  isDay,
  lastDayOf,
  parseChunkDays,
  startOfDay,
  toDay,
} from "../../../src/domain/entities/day";

describe("toDay", () => {
  it("should format an instant as a UTC calendar day", () => {
    // given
    const instant = new Date("2026-08-10T14:32:11.000Z");

    // when
    const result = toDay(instant);

    // then
    expect(result).toBe("2026-08-10");
  });

  it("should use the UTC day when the instant is late enough to differ locally", () => {
    // given
    // 23:30 UTC is already the next day east of Greenwich; the plugin works in
    // UTC throughout so that a backend never disagrees with itself about which
    // day a commit belongs to.
    const instant = new Date("2026-08-10T23:30:00.000Z");

    // when
    const result = toDay(instant);

    // then
    expect(result).toBe("2026-08-10");
  });
});

describe("lastDayOf", () => {
  it("should end on the day before a window that stops at midnight", () => {
    // given
    // A calendar month resolves to the first instant of the next month, which
    // the window never reaches into.
    const to = new Date("2026-10-01T00:00:00.000Z");

    // when
    const result = lastDayOf(to);

    // then
    expect(result).toBe("2026-09-30");
  });

  it("should keep the day of a window that stops inside it", () => {
    // given
    const to = new Date("2026-09-15T14:23:00.000Z");

    // when
    const result = lastDayOf(to);

    // then
    expect(result).toBe("2026-09-15");
  });
});

describe("startOfDay", () => {
  it("should return midnight UTC for the given day", () => {
    // given / when
    const result = startOfDay("2026-08-10");

    // then
    expect(result.toISOString()).toBe("2026-08-10T00:00:00.000Z");
  });
});

describe("addDays", () => {
  it("should move forwards across a month boundary", () => {
    // given / when
    const result = addDays("2026-08-30", 3);

    // then
    expect(result).toBe("2026-09-02");
  });

  it("should move backwards across a year boundary", () => {
    // given / when
    const result = addDays("2026-01-02", -3);

    // then
    expect(result).toBe("2025-12-30");
  });

  it("should land on the leap day when stepping through February 2028", () => {
    // given / when
    const result = addDays("2028-02-28", 1);

    // then
    expect(result).toBe("2028-02-29");
  });
});

describe("daysBetween", () => {
  it("should count whole days forwards", () => {
    // given / when
    const result = daysBetween("2026-08-01", "2026-08-11");

    // then
    expect(result).toBe(10);
  });

  it("should return a negative count when the end precedes the start", () => {
    // given / when
    const result = daysBetween("2026-08-11", "2026-08-01");

    // then
    expect(result).toBe(-10);
  });

  it("should span a full retention window without drifting on daylight saving", () => {
    // given
    // A naive millisecond division drifts by an hour across a DST boundary and
    // rounds to 364 here, which would leave the backfill one day short forever.
    const from = "2025-08-10";
    const to = "2026-08-10";

    // when
    const result = daysBetween(from, to);

    // then
    expect(result).toBe(365);
  });
});

describe("daysInRange", () => {
  it("should include both ends of the range", () => {
    // given / when
    const result = daysInRange("2026-08-09", "2026-08-11");

    // then
    expect(result).toEqual(["2026-08-09", "2026-08-10", "2026-08-11"]);
  });

  it("should return a single day when both ends are the same", () => {
    // given / when
    const result = daysInRange("2026-08-10", "2026-08-10");

    // then
    expect(result).toEqual(["2026-08-10"]);
  });

  it("should return nothing when the end precedes the start", () => {
    // given / when
    const result = daysInRange("2026-08-11", "2026-08-09");

    // then
    expect(result).toEqual([]);
  });
});

describe("isDay", () => {
  it("should accept a well formed calendar day", () => {
    // given / when
    const result = isDay("2026-08-10");

    // then
    expect(result).toBe(true);
  });

  it("should reject a day that does not exist", () => {
    // given / when
    const result = isDay("2026-02-30");

    // then
    expect(result).toBe(false);
  });

  it("should reject an instant", () => {
    // given / when
    const result = isDay("2026-08-10T00:00:00Z");

    // then
    expect(result).toBe(false);
  });
});

describe("parseChunkDays", () => {
  it("should parse a one day chunk", () => {
    // given / when
    const result = parseChunkDays("P1D", 1);

    // then
    expect(result).toBe(1);
  });

  it("should parse a week as seven days", () => {
    // given / when
    const result = parseChunkDays("P1W", 1);

    // then
    expect(result).toBe(7);
  });

  it("should fall back when the duration is absent", () => {
    // given / when
    const result = parseChunkDays(undefined, 3);

    // then
    expect(result).toBe(3);
  });

  it("should fall back when the duration cannot be parsed", () => {
    // given / when
    const result = parseChunkDays("every other tuesday", 3);

    // then
    expect(result).toBe(3);
  });

  it("should fall back when the duration is shorter than a day", () => {
    // given / when
    // The ingested-chunk table is keyed by day, so a sub-day chunk could never
    // be recorded as complete and would make the backfill loop forever.
    const result = parseChunkDays("PT6H", 1);

    // then
    expect(result).toBe(1);
  });
});

describe("fromStoredDate", () => {
  it("should truncate the string a SQLite date column returns", () => {
    // given / when
    const result = fromStoredDate("2026-08-10 00:00:00");

    // then
    expect(result).toBe("2026-08-10");
  });

  it("should read the local components of the Date a PostgreSQL driver builds", () => {
    // given
    // The pg driver builds a `Date` at local midnight for a `date` column.
    // Formatting it as UTC would report the previous day for anyone west of
    // Greenwich, quietly shifting every backfill cursor by one.
    const localMidnight = new Date(2026, 7, 10, 0, 0, 0);

    // when
    const result = fromStoredDate(localMidnight);

    // then
    expect(result).toBe("2026-08-10");
  });

  it("should pad a single digit month and day", () => {
    // given / when
    const result = fromStoredDate(new Date(2026, 0, 5, 0, 0, 0));

    // then
    expect(result).toBe("2026-01-05");
  });
});
