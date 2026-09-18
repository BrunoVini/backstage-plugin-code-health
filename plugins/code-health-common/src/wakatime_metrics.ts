import { formatCount, formatFixed } from "./number_format";

/**
 * One slice of a WakaTime breakdown — a language, an editor, a project.
 *
 * `percent` is carried rather than recomputed because WakaTime calculates it
 * against the same total it filtered the slice from, and a client dividing by
 * the total it happens to hold gets a different number whenever the list was
 * truncated.
 */
export interface WakaTimeBreakdownItem {
  readonly name: string;
  readonly totalSeconds: number;
  /** Share of the measured time, 0 to 100. */
  readonly percent: number;
}

export interface WakaTimeDayTotal {
  /** `YYYY-MM-DD`. */
  readonly day: string;
  readonly totalSeconds: number;
}

/**
 * AI-assisted authorship, as WakaTime's `durations` resource reports it.
 *
 * This is the only place in the plugin where a *token* count exists, and it
 * exists because WakaTime measures it at the editor — no version control
 * provider has any idea whether a line was typed or accepted from a completion.
 *
 * It is separate from {@link WakaTimeMetrics} rather than flattened into it
 * because it is collected differently and is routinely absent: the durations
 * resource is queried a day at a time, so a run under a tight request budget
 * collects coding time for everybody and AI figures for nobody. `null` means
 * "not collected", never "no AI was used" — and the two have to stay
 * distinguishable, or a team with the collection switched off looks like a team
 * writing everything by hand.
 */
export interface WakaTimeAiMetrics {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly linesAddedByAi: number;
  readonly linesDeletedByAi: number;
  readonly linesAddedByHuman: number;
  readonly linesDeletedByHuman: number;
  readonly prompts: number;
  readonly sessions: number;
  /** Model name to the cost WakaTime estimated for it, summed over the window. */
  readonly modelCosts: Readonly<Record<string, number>>;
  /** Days inside the window AI figures were actually collected for. */
  readonly daysMeasured: number;
}

/**
 * What WakaTime observed for one person over one window.
 *
 * Every figure is scoped to the window, and the window is carried on the value
 * so a view can say what it is showing. That matters more here than elsewhere:
 * WakaTime's retention depends on the plan, so a request for last March can
 * legitimately come back covering a shorter period than was asked for, and a
 * chart that silently relabels it is lying about its own axis.
 */
export interface WakaTimeMetrics {
  readonly window: { readonly from: string; readonly to: string };
  readonly totalSeconds: number;
  readonly dailyAverageSeconds: number;
  /** Days in the window with any recorded activity. */
  readonly activeDays: number;
  /** Days the window covers, so `activeDays` reads as a share of something. */
  readonly measuredDays: number;
  readonly bestDay: WakaTimeDayTotal | null;
  /**
   * Seconds per day across the window, including days with none.
   *
   * Carried rather than derived because it is the only thing that makes merging
   * correct: a person with two WakaTime accounts has two rows for the same
   * Tuesday, and summing `measuredDays` across them would report a fortnight of
   * evidence for a week of work. Merging on the day itself cannot double-count.
   *
   * It also removes a whole endpoint — the fleet coding-time trend is the sum of
   * these across the contributors already on the page, so nothing has to be
   * asked for twice.
   *
   * The backend buckets it to weeks past a few months of window, because a
   * sparkline cannot draw 365 points and a browser should not be sent them.
   */
  readonly daily: readonly WakaTimeDayTotal[];
  readonly languages: readonly WakaTimeBreakdownItem[];
  readonly editors: readonly WakaTimeBreakdownItem[];
  readonly projects: readonly WakaTimeBreakdownItem[];
  readonly categories: readonly WakaTimeBreakdownItem[];
  readonly operatingSystems: readonly WakaTimeBreakdownItem[];
  readonly machines: readonly WakaTimeBreakdownItem[];
  readonly branches: readonly WakaTimeBreakdownItem[];
  /**
   * Distinct files touched, or null when the plan does not return entities.
   *
   * WakaTime only fills `entities` in on some plans, and an absent list is
   * indistinguishable from a genuinely empty one at the wire level — so it is
   * reported as unknown rather than as zero files edited by somebody who
   * demonstrably spent eleven hours in an editor.
   */
  readonly filesTouched: number | null;
  readonly ai: WakaTimeAiMetrics | null;
}

/**
 * Coding time a repository received, summed across everybody who logged any.
 *
 * A repository is not a WakaTime concept — WakaTime measures a *project*, which
 * its editor plugins derive from the working directory name. The two are
 * matched by name, or by the `wakatime.com/project` annotation when a catalog
 * entity names one explicitly, and a repository nothing matched reports null
 * rather than zero: "nobody has WakaTime installed here" and "the project is
 * called something else" are different problems with different fixes.
 *
 * Deliberately a smaller shape than {@link WakaTimeMetrics}. The summaries
 * resource reports languages and editors per *person per day*, not per project,
 * so a per-repository language breakdown would have to be invented — and this
 * plugin does not invent numbers.
 */
export interface WakaTimeProjectMetrics {
  /** The WakaTime project name that matched, as WakaTime spells it. */
  readonly projectName: string;
  readonly window: { readonly from: string; readonly to: string };
  readonly totalSeconds: number;
  /** People who logged any time against the project inside the window. */
  readonly contributors: number;
  readonly daily: readonly WakaTimeDayTotal[];
}

/** One point of the fleet-wide coding-time trend. */
export interface WakaTimeSeriesPoint {
  readonly day: string;
  readonly totalSeconds: number;
  /** People with any recorded activity in the bucket. */
  readonly contributors: number;
}

/**
 * A duration in hours and minutes, with the hours grouped.
 *
 * The fleet's coding time over a year is five figures of hours, and the KPI
 * tile it lands on is read at a glance or not at all.
 */
export const formatDuration = (totalSeconds: number): string => {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  return minutes > 0 ? `${formatCount(hours)}h ${minutes}m` : `${formatCount(hours)}h`;
};

/**
 * Token counts run to the millions, and eight digits in a table cell are read
 * as a barcode rather than as a number.
 */
export const formatTokens = (tokens: number): string => {
  if (tokens >= 1_000_000) return `${formatFixed(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${formatFixed(tokens / 1_000)}k`;
  return formatCount(tokens);
};

export const totalModelCost = (metrics: WakaTimeAiMetrics): number =>
  Object.values(metrics.modelCosts).reduce((total, cost) => total + cost, 0);

/**
 * Share of added lines WakaTime attributed to AI, or null when neither side
 * recorded a single line.
 *
 * Null rather than zero, for the same reason as everywhere else here: a window
 * in which nothing was written at all is not a window in which a human wrote
 * everything.
 */
export const aiAuthorshipShare = (metrics: WakaTimeAiMetrics): number | null => {
  const written = metrics.linesAddedByAi + metrics.linesAddedByHuman;
  if (written <= 0) return null;
  return Math.round((metrics.linesAddedByAi / written) * 1000) / 10;
};

/** Total seconds across a breakdown, used to turn one back into a percentage. */
export const breakdownTotal = (items: readonly WakaTimeBreakdownItem[]): number =>
  items.reduce((total, item) => total + item.totalSeconds, 0);

/** The largest slice's name, e.g. the language somebody spends most time in. */
export const topBreakdownName = (
  items: readonly WakaTimeBreakdownItem[],
): string | null =>
  items.reduce<WakaTimeBreakdownItem | null>(
    (best, item) => (best === null || item.totalSeconds > best.totalSeconds ? item : best),
    null,
  )?.name ?? null;

/**
 * Merges breakdowns from several days, or from several accounts belonging to
 * one person, into a single ranked list.
 *
 * Percentages are recomputed from the merged totals rather than averaged: the
 * mean of two days' percentages weights a twenty-minute day the same as an
 * eight-hour one, which inverts the ranking whenever somebody spends one short
 * day in an unusual language.
 */
export const mergeBreakdowns = (
  breakdowns: readonly (readonly WakaTimeBreakdownItem[])[],
): WakaTimeBreakdownItem[] => {
  const totals = new Map<string, number>();
  for (const breakdown of breakdowns) {
    for (const item of breakdown) {
      totals.set(item.name, (totals.get(item.name) ?? 0) + item.totalSeconds);
    }
  }

  const grandTotal = [...totals.values()].reduce((sum, value) => sum + value, 0);

  return [...totals.entries()]
    .map(([name, totalSeconds]) => ({
      name,
      totalSeconds,
      percent:
        grandTotal === 0 ? 0 : Math.round((totalSeconds / grandTotal) * 1000) / 10,
    }))
    .sort((left, right) => right.totalSeconds - left.totalSeconds || left.name.localeCompare(right.name));
};

const mergeAi = (
  parts: readonly WakaTimeAiMetrics[],
): WakaTimeAiMetrics | null => {
  if (parts.length === 0) return null;

  const modelCosts: Record<string, number> = {};
  for (const part of parts) {
    for (const [model, cost] of Object.entries(part.modelCosts)) {
      modelCosts[model] = (modelCosts[model] ?? 0) + cost;
    }
  }

  const sum = (pick: (metrics: WakaTimeAiMetrics) => number): number =>
    parts.reduce((total, part) => total + pick(part), 0);

  return {
    inputTokens: sum((part) => part.inputTokens),
    outputTokens: sum((part) => part.outputTokens),
    linesAddedByAi: sum((part) => part.linesAddedByAi),
    linesDeletedByAi: sum((part) => part.linesDeletedByAi),
    linesAddedByHuman: sum((part) => part.linesAddedByHuman),
    linesDeletedByHuman: sum((part) => part.linesDeletedByHuman),
    prompts: sum((part) => part.prompts),
    sessions: sum((part) => part.sessions),
    modelCosts,
    daysMeasured: sum((part) => part.daysMeasured),
  };
};

/**
 * Sums seconds per day across several measurements.
 *
 * Day-keyed rather than positional, so two accounts reporting the same Tuesday
 * collapse onto one Tuesday instead of producing two.
 */
export const mergeDailyTotals = (
  parts: readonly (readonly WakaTimeDayTotal[])[],
): WakaTimeDayTotal[] => {
  const byDay = new Map<string, number>();
  for (const part of parts) {
    for (const point of part) {
      byDay.set(point.day, (byDay.get(point.day) ?? 0) + point.totalSeconds);
    }
  }

  return [...byDay.entries()]
    .map(([day, totalSeconds]) => ({ day, totalSeconds }))
    .sort((left, right) => left.day.localeCompare(right.day));
};

/**
 * Folds several measurements into one.
 *
 * Two things produce a list here, and they have to behave identically: a window
 * spanning several stored days, and one person holding more than one WakaTime
 * account. Everything derives from the merged day series rather than from the
 * summary figures on each part — the average is recomputed over the merged span
 * instead of being an average of averages, and the day count is the number of
 * distinct days rather than the number of rows.
 *
 * Returns null for an empty list rather than a zeroed value: a person with no
 * WakaTime account at all must not appear on the dashboard as somebody who
 * logged no time.
 */
export const mergeWakaTimeMetrics = (
  parts: readonly WakaTimeMetrics[],
): WakaTimeMetrics | null => {
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0] ?? null;

  const daily = mergeDailyTotals(parts.map((part) => part.daily));
  const totalSeconds = daily.reduce((total, point) => total + point.totalSeconds, 0);
  const measuredDays = daily.length;

  const bestDay = daily.reduce<WakaTimeDayTotal | null>(
    (best, point) =>
      best === null || point.totalSeconds > best.totalSeconds ? point : best,
    null,
  );

  // Unknown wins over a count: one account reporting three files and another
  // reporting nothing is not a person who touched three files.
  const filesTouched = parts.some((part) => part.filesTouched === null)
    ? null
    : parts.reduce((total, part) => total + (part.filesTouched ?? 0), 0);

  const pick = (
    select: (part: WakaTimeMetrics) => readonly WakaTimeBreakdownItem[],
  ): WakaTimeBreakdownItem[] => mergeBreakdowns(parts.map(select));

  const from = parts.map((part) => part.window.from).sort()[0] ?? "";
  const to = parts.map((part) => part.window.to).sort().at(-1) ?? "";

  return {
    window: { from, to },
    totalSeconds,
    dailyAverageSeconds: measuredDays === 0 ? 0 : Math.round(totalSeconds / measuredDays),
    activeDays: daily.filter((point) => point.totalSeconds > 0).length,
    measuredDays,
    bestDay: bestDay !== null && bestDay.totalSeconds > 0 ? bestDay : null,
    daily,
    languages: pick((part) => part.languages),
    editors: pick((part) => part.editors),
    projects: pick((part) => part.projects),
    categories: pick((part) => part.categories),
    operatingSystems: pick((part) => part.operatingSystems),
    machines: pick((part) => part.machines),
    branches: pick((part) => part.branches),
    filesTouched,
    ai: mergeAi(parts.flatMap((part) => (part.ai === null ? [] : [part.ai]))),
  };
};
