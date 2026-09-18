/**
 * How much of Confluence one snapshot pass is allowed to read.
 *
 * The site, the credential, the spaces and the window all live on
 * `AtlassianSettings`, because Jira and Confluence share them. What is left
 * here is the part only Confluence needs, and it is all about cost.
 *
 * Confluence is unusual among the providers in this plugin in that its *counts*
 * are cheap and its *attribution* is not. A CQL search reports `totalSize` for
 * any query, so "how many pages were created in this space last quarter" is one
 * request whatever the answer. But CQL only ever names a page's creator and its
 * most recent editor, so working out who authored the four versions in between
 * costs one request per page, and measuring how much was written costs one more
 * per version on top of that.
 *
 * The three caps below are therefore not one budget split three ways. They
 * bound three walks whose costs scale with completely different things, and
 * each degrades on its own: passing a cap makes the figure it governs null
 * rather than truncating it into an under-count that would look exactly like a
 * quiet quarter.
 *
 * Two request allowances sit underneath. The contributor sweep — the walks the
 * three caps bound — spends `requestBudgetPerRun`, whose default is what the
 * default caps can need, so the caps are reachable rather than nominal. The
 * per-space reports spend `requestBudgetPerSpace` for each space the catalog
 * names, because their cost scales with the annotation count and nothing in a
 * flat number does: on one shared allowance twenty annotated spaces would eat
 * what the caps were sized for before the contributor sweep began, and every
 * person's figures would then under-report as a measured low rather than as
 * unmeasured. Neither draws on the other, and nothing else in the snapshot
 * pass draws on either.
 */
export interface ConfluenceSettings {
  /** Days without an edit after which a page counts as stale. */
  readonly staleAfterDays: number;
  /** Pages a run will fetch a version history for, across every space. */
  readonly maxPagesPerRun: number;
  /** Of those, how many it will fetch bodies for to measure written volume. */
  readonly maxPagesForVolume: number;
  /** Pages a run will ask the analytics API about. Premium sites only. */
  readonly maxAnalyticsLookups: number;
  /** Requests one snapshot pass may spend on the contributor sweep. */
  readonly requestBudgetPerRun: number;
  /** Requests one snapshot pass may spend on each annotated space's report. */
  readonly requestBudgetPerSpace: number;
}

/**
 * Six months without an edit.
 *
 * Long enough that a stable reference page is not accused of rotting, short
 * enough that a runbook nobody has opened since the last reorganisation shows
 * up while it still matters.
 */
export const DEFAULT_CONFLUENCE_STALE_AFTER_DAYS = 180;

export const DEFAULT_CONFLUENCE_MAX_PAGES_PER_RUN = 500;
export const DEFAULT_CONFLUENCE_MAX_PAGES_FOR_VOLUME = 150;
export const DEFAULT_CONFLUENCE_MAX_ANALYTICS_LOOKUPS = 200;

/**
 * Body fetches one page's written volume may cost.
 *
 * Measuring an edit needs the body either side of it, so a page with many
 * versions inside the window is the expensive case. Past this it is skipped
 * *entirely* rather than measured partially: half a page's edits attributed and
 * half dropped produces a figure that is wrong in a direction nobody can see,
 * where an unmeasured page at least says so.
 */
export const CONFLUENCE_MAX_VOLUME_FETCHES_PER_PAGE = 12;

/**
 * What the contributor sweep spends finding the pages before it walks any of
 * them: the three sweeps of the window, a page of the search index at a time,
 * the lookup that resolves the configured space keys, and the account-name
 * lookups. The per-space reports are not in here; they have an allowance of
 * their own, per space.
 */
export const CONFLUENCE_SWEEP_ALLOWANCE = 200;

/**
 * Every walk the default caps allow, added up, plus the sweeps that find the
 * pages: one version history per page, up to twelve bodies for each page
 * measured for volume, one analytics lookup per page, and the searches.
 *
 * Derived rather than typed in so the two cannot disagree. An allowance
 * smaller than the caps makes them nominal — a run stops short of every one of
 * them and reports the shortfall as a quiet quarter — which is exactly the
 * inconsistency the shared budget used to have.
 */
export const DEFAULT_CONFLUENCE_REQUEST_BUDGET_PER_RUN =
  DEFAULT_CONFLUENCE_MAX_PAGES_PER_RUN +
  DEFAULT_CONFLUENCE_MAX_PAGES_FOR_VOLUME * CONFLUENCE_MAX_VOLUME_FETCHES_PER_PAGE +
  DEFAULT_CONFLUENCE_MAX_ANALYTICS_LOOKUPS +
  CONFLUENCE_SWEEP_ALLOWANCE;

/**
 * What one space's report can cost at the default `maxResultsPerRun`: seven
 * counts and two ordered lookups, up to twenty pages of the window's changed
 * items, up to eight pages of the parent walk, and a share of the space and
 * account-name lookups the reports make once between them. A quiet space
 * costs about a dozen; the allowance is pooled over every annotated space, so
 * a busy one borrows from a quiet one.
 */
export const DEFAULT_CONFLUENCE_REQUEST_BUDGET_PER_SPACE = 40;

export const DEFAULT_CONFLUENCE_SETTINGS: ConfluenceSettings = {
  staleAfterDays: DEFAULT_CONFLUENCE_STALE_AFTER_DAYS,
  maxPagesPerRun: DEFAULT_CONFLUENCE_MAX_PAGES_PER_RUN,
  maxPagesForVolume: DEFAULT_CONFLUENCE_MAX_PAGES_FOR_VOLUME,
  maxAnalyticsLookups: DEFAULT_CONFLUENCE_MAX_ANALYTICS_LOOKUPS,
  requestBudgetPerRun: DEFAULT_CONFLUENCE_REQUEST_BUDGET_PER_RUN,
  requestBudgetPerSpace: DEFAULT_CONFLUENCE_REQUEST_BUDGET_PER_SPACE,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The window a run measures, ending at the instant it started.
 *
 * Anchored on `now` rather than on midnight because a Confluence figure is
 * always a trailing window rather than a calendar period: there is no cursor
 * and no backfill here — every run re-measures the same span — so snapping to a
 * day boundary would move the label by up to a day without making the
 * measurement any more stable.
 */
export const confluenceWindowFor = (
  historyDays: number,
  now: Date,
): { readonly from: Date; readonly to: Date } => ({
  from: new Date(now.getTime() - historyDays * DAY_MS),
  to: now,
});

/** The instant before which a page counts as stale. */
export const confluenceStaleCutoff = (
  settings: ConfluenceSettings,
  now: Date,
): Date => new Date(now.getTime() - settings.staleAfterDays * DAY_MS);
