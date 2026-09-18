import {
  aiAuthorshipShare,
  breakdownTotal,
  formatDuration,
  formatTokens,
  mergeBreakdowns,
  mergeDailyTotals,
  mergeWakaTimeMetrics,
  topBreakdownName,
  totalModelCost,
} from "../src/wakatime_metrics";
import { WakaTimeMetricsBuilder } from "./builders/wakatime_metrics_builder";

describe("formatDuration", () => {
  it("should group the hours past a thousand", () => {
    // given
    // The fleet's coding time over a year is five figures of hours, and the
    // KPI tile it lands on is read at a glance or not at all.
    const seconds = 4_500_000;

    // when
    const result = formatDuration(seconds);

    // then
    expect(result).toBe("1,250h");
  });

  it("should return 0m when totalSeconds is 0", () => {
    // given
    const seconds = 0;

    // when
    const result = formatDuration(seconds);

    // then
    expect(result).toBe("0m");
  });

  it("should return 0m when totalSeconds is less than 60", () => {
    // given
    const seconds = 59;

    // when
    const result = formatDuration(seconds);

    // then
    expect(result).toBe("0m");
  });

  it("should return 1m when totalSeconds is exactly 60", () => {
    // given
    const seconds = 60;

    // when
    const result = formatDuration(seconds);

    // then
    expect(result).toBe("1m");
  });

  it("should return 59m when totalSeconds is 3599", () => {
    // given
    const seconds = 3599;

    // when
    const result = formatDuration(seconds);

    // then
    expect(result).toBe("59m");
  });

  it("should return hours only when totalSeconds is exactly on the hour", () => {
    // given
    const seconds = 3600;

    // when
    const result = formatDuration(seconds);

    // then
    expect(result).toBe("1h");
  });

  it("should return hours and minutes when totalSeconds has both", () => {
    // given
    const seconds = 3660;

    // when
    const result = formatDuration(seconds);

    // then
    expect(result).toBe("1h 1m");
  });

  it("should return hours only when minutes are zero", () => {
    // given
    const seconds = 7200;

    // when
    const result = formatDuration(seconds);

    // then
    expect(result).toBe("2h");
  });

  it("should handle large values correctly", () => {
    // given
    const seconds = 90060;

    // when
    const result = formatDuration(seconds);

    // then
    expect(result).toBe("25h 1m");
  });
});

describe("formatTokens", () => {
  it("should print small counts as they are", () => {
    // given / when / then
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  it("should abbreviate thousands", () => {
    // given / when / then
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(84_300)).toBe("84.3k");
  });

  it("should abbreviate millions", () => {
    // given
    // Eight digits in a table cell read as a barcode rather than a number.
    const tokens = 12_400_000;

    // when / then
    expect(formatTokens(tokens)).toBe("12.4M");
  });
});

describe("aiAuthorshipShare", () => {
  it("should report the share of added lines attributed to AI", () => {
    // given
    const metrics = WakaTimeMetricsBuilder.aDay()
      .withAi({ linesAddedByAi: 30, linesAddedByHuman: 70 })
      .build().ai;

    // when
    const share = aiAuthorshipShare(metrics!);

    // then
    expect(share).toBe(30);
  });

  it("should return null when nothing was written at all", () => {
    // given
    // A window in which nobody wrote a line is not a window a human wrote
    // everything in, and 0% would say exactly that.
    const metrics = WakaTimeMetricsBuilder.aDay().withAi().build().ai;

    // when
    const share = aiAuthorshipShare(metrics!);

    // then
    expect(share).toBeNull();
  });
});

describe("totalModelCost", () => {
  it("should sum every model's estimated cost", () => {
    // given
    const metrics = WakaTimeMetricsBuilder.aDay()
      .withAi({ modelCosts: { "claude-opus": 1.5, "gpt-5": 0.25 } })
      .build().ai;

    // when
    const total = totalModelCost(metrics!);

    // then
    expect(total).toBe(1.75);
  });

  it("should be zero when no model was priced", () => {
    // given / when
    const total = totalModelCost(WakaTimeMetricsBuilder.aDay().withAi().build().ai!);

    // then
    expect(total).toBe(0);
  });
});

describe("breakdownTotal and topBreakdownName", () => {
  it("should total the slices and name the largest", () => {
    // given
    const metrics = WakaTimeMetricsBuilder.aDay()
      .withLanguage("Go", 100)
      .withLanguage("TypeScript", 300)
      .build();

    // when / then
    expect(breakdownTotal(metrics.languages)).toBe(400);
    expect(topBreakdownName(metrics.languages)).toBe("TypeScript");
  });

  it("should name nothing when the breakdown is empty", () => {
    // given / when / then
    expect(topBreakdownName([])).toBeNull();
    expect(breakdownTotal([])).toBe(0);
  });
});

describe("mergeBreakdowns", () => {
  it("should recompute percentages from the merged totals", () => {
    // given
    // Each part reports 100%; averaging those would weight a twenty-minute day
    // the same as an eight-hour one and invert the ranking.
    const left = WakaTimeMetricsBuilder.aDay().withLanguage("Go", 3600).build();
    const right = WakaTimeMetricsBuilder.aDay().withLanguage("Rust", 1200).build();

    // when
    const merged = mergeBreakdowns([left.languages, right.languages]);

    // then
    expect(merged).toEqual([
      { name: "Go", totalSeconds: 3600, percent: 75 },
      { name: "Rust", totalSeconds: 1200, percent: 25 },
    ]);
  });

  it("should add the same name across parts", () => {
    // given
    const left = WakaTimeMetricsBuilder.aDay().withLanguage("Go", 60).build();
    const right = WakaTimeMetricsBuilder.aDay().withLanguage("Go", 40).build();

    // when
    const merged = mergeBreakdowns([left.languages, right.languages]);

    // then
    expect(merged).toEqual([{ name: "Go", totalSeconds: 100, percent: 100 }]);
  });

  it("should report zero percent rather than dividing by nothing", () => {
    // given
    const empty = WakaTimeMetricsBuilder.aDay().withLanguage("Go", 0).build();

    // when
    const merged = mergeBreakdowns([empty.languages]);

    // then
    expect(merged).toEqual([{ name: "Go", totalSeconds: 0, percent: 0 }]);
  });

  it("should sort equal totals by name so the order is stable", () => {
    // given
    const parts = WakaTimeMetricsBuilder.aDay()
      .withLanguage("Zig", 60)
      .withLanguage("Ada", 60)
      .build();

    // when
    const merged = mergeBreakdowns([parts.languages]);

    // then
    expect(merged.map((item) => item.name)).toEqual(["Ada", "Zig"]);
  });
});

describe("mergeDailyTotals", () => {
  it("should collapse the same day reported by two accounts onto one day", () => {
    // given
    const first = WakaTimeMetricsBuilder.aDay().onDay("2026-08-10").withSeconds(600).build();
    const second = WakaTimeMetricsBuilder.aDay().onDay("2026-08-10").withSeconds(300).build();

    // when
    const merged = mergeDailyTotals([first.daily, second.daily]);

    // then
    expect(merged).toEqual([{ day: "2026-08-10", totalSeconds: 900 }]);
  });

  it("should return the days in order", () => {
    // given
    const later = WakaTimeMetricsBuilder.aDay().onDay("2026-08-11").withSeconds(1).build();
    const earlier = WakaTimeMetricsBuilder.aDay().onDay("2026-08-09").withSeconds(2).build();

    // when
    const merged = mergeDailyTotals([later.daily, earlier.daily]);

    // then
    expect(merged.map((point) => point.day)).toEqual(["2026-08-09", "2026-08-11"]);
  });
});

describe("mergeWakaTimeMetrics", () => {
  it("should return null for a person with no WakaTime account", () => {
    // given
    // Null rather than a zeroed value: somebody who does not use WakaTime must
    // not appear as somebody who logged no time.
    const parts: never[] = [];

    // when
    const merged = mergeWakaTimeMetrics(parts);

    // then
    expect(merged).toBeNull();
  });

  it("should return the single part untouched", () => {
    // given
    const only = WakaTimeMetricsBuilder.aDay().withSeconds(120).build();

    // when
    const merged = mergeWakaTimeMetrics([only]);

    // then
    expect(merged).toBe(only);
  });

  it("should span the merged window and average over the days it covers", () => {
    // given
    const monday = WakaTimeMetricsBuilder.aDay().onDay("2026-08-10").withSeconds(7200).build();
    const tuesday = WakaTimeMetricsBuilder.aDay().onDay("2026-08-11").withSeconds(3600).build();
    const wednesday = WakaTimeMetricsBuilder.aDay().onDay("2026-08-12").withSeconds(0).build();

    // when
    const merged = mergeWakaTimeMetrics([monday, tuesday, wednesday]);

    // then
    expect(merged?.window).toEqual({ from: "2026-08-10", to: "2026-08-12" });
    expect(merged?.totalSeconds).toBe(10_800);
    expect(merged?.measuredDays).toBe(3);
    expect(merged?.activeDays).toBe(2);
    expect(merged?.dailyAverageSeconds).toBe(3600);
    expect(merged?.bestDay).toEqual({ day: "2026-08-10", totalSeconds: 7200 });
  });

  it("should not double-count a day two accounts both reported", () => {
    // given
    // The reason the day series is carried at all: summing `measuredDays` would
    // claim two days of evidence for one Tuesday.
    const work = WakaTimeMetricsBuilder.aDay().onDay("2026-08-11").withSeconds(3600).build();
    const personal = WakaTimeMetricsBuilder.aDay().onDay("2026-08-11").withSeconds(1800).build();

    // when
    const merged = mergeWakaTimeMetrics([work, personal]);

    // then
    expect(merged?.measuredDays).toBe(1);
    expect(merged?.totalSeconds).toBe(5400);
    expect(merged?.dailyAverageSeconds).toBe(5400);
  });

  it("should report an unknown file count rather than a partial one", () => {
    // given
    const known = WakaTimeMetricsBuilder.aDay().onDay("2026-08-10").withFilesTouched(3).build();
    const unknown = WakaTimeMetricsBuilder.aDay().onDay("2026-08-11").withFilesTouched(null).build();

    // when
    const merged = mergeWakaTimeMetrics([known, unknown]);

    // then
    expect(merged?.filesTouched).toBeNull();
  });

  it("should add file counts when every part reported one", () => {
    // given
    const first = WakaTimeMetricsBuilder.aDay().onDay("2026-08-10").withFilesTouched(3).build();
    const second = WakaTimeMetricsBuilder.aDay().onDay("2026-08-11").withFilesTouched(4).build();

    // when
    const merged = mergeWakaTimeMetrics([first, second]);

    // then
    expect(merged?.filesTouched).toBe(7);
  });

  it("should leave AI figures null when no part collected any", () => {
    // given
    const first = WakaTimeMetricsBuilder.aDay().onDay("2026-08-10").withSeconds(60).build();
    const second = WakaTimeMetricsBuilder.aDay().onDay("2026-08-11").withSeconds(60).build();

    // when
    const merged = mergeWakaTimeMetrics([first, second]);

    // then
    expect(merged?.ai).toBeNull();
  });

  it("should sum tokens and costs across the parts that collected them", () => {
    // given
    const first = WakaTimeMetricsBuilder.aDay()
      .onDay("2026-08-10")
      .withAi({ inputTokens: 1000, outputTokens: 200, modelCosts: { "claude-opus": 1 }, prompts: 4 })
      .build();
    const second = WakaTimeMetricsBuilder.aDay()
      .onDay("2026-08-11")
      .withAi({ inputTokens: 500, outputTokens: 100, modelCosts: { "claude-opus": 2, "gpt-5": 3 }, prompts: 1 })
      .build();

    // when
    const merged = mergeWakaTimeMetrics([first, second]);

    // then
    expect(merged?.ai?.inputTokens).toBe(1500);
    expect(merged?.ai?.outputTokens).toBe(300);
    expect(merged?.ai?.prompts).toBe(5);
    expect(merged?.ai?.modelCosts).toEqual({ "claude-opus": 3, "gpt-5": 3 });
    expect(merged?.ai?.daysMeasured).toBe(2);
  });

  it("should report no best day when nothing was logged", () => {
    // given
    const first = WakaTimeMetricsBuilder.aDay().onDay("2026-08-10").withSeconds(0).build();
    const second = WakaTimeMetricsBuilder.aDay().onDay("2026-08-11").withSeconds(0).build();

    // when
    const merged = mergeWakaTimeMetrics([first, second]);

    // then
    expect(merged?.bestDay).toBeNull();
  });
});
