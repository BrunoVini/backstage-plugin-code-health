import type { TimeRangeId } from "./time_range";
import { DEFAULT_RANGE_ID } from "./time_range";

/**
 * The branch name a repository is expected to have defaulted to.
 *
 * `main` because that is what both providers create now and what the fleet
 * this plugin was written for standardised on. It is a *convention*, not a
 * measurement, which is why it is configurable: a fleet on `master` or `trunk`
 * had every single row flagged by the Default Branch column, and an audit that
 * matches everything is an audit nobody reads.
 */
export const DEFAULT_EXPECTED_BRANCH = "main";

/**
 * The handful of values an administrator can pin in `app-config.yaml`.
 *
 * Everything that used to live here — the platform, the organisation, provider
 * base URLs and proxy paths — moved to the backend. The catalog decides which
 * repositories exist and the host application's `integrations` block supplies
 * the credentials, so there is nothing left for a browser to be told.
 */
export interface CodeHealthConfig {
  /** Auto-refresh interval in milliseconds, or null for the built-in default. */
  readonly refreshIntervalMs: number | null;
  readonly defaultRange: TimeRangeId;
  /** The branch name the Default Branch column and its audit measure against. */
  readonly expectedDefaultBranch: string;
}

export const DEFAULT_CODE_HEALTH_CONFIG: CodeHealthConfig = {
  refreshIntervalMs: null,
  defaultRange: DEFAULT_RANGE_ID,
  expectedDefaultBranch: DEFAULT_EXPECTED_BRANCH,
};
