/**
 * What the operator told the plugin about Jira.
 *
 * The credential itself is not here: Jira and Confluence share one Atlassian
 * Cloud token, which lives in `AtlassianSettings`, so an organisation that has
 * configured one has configured both. Everything in this block is about *what*
 * to measure rather than *how* to authenticate.
 */
export interface JiraSettings {
  readonly enabled: boolean;
  /**
   * JQL appended to every query with `AND`, e.g. to exclude a noisy project or
   * a service-desk queue whose tickets are not engineering work.
   *
   * Interpolated verbatim, because there is no safe way to escape a fragment of
   * a query language the operator is deliberately writing. It comes from the
   * app's own configuration file rather than from a catalog entity or an HTTP
   * request, which is the only reason that is acceptable — the project keys
   * this plugin reads out of annotations are quoted and escaped instead.
   */
  readonly filter: string | null;
  /**
   * Custom field id holding story points, e.g. `customfield_10016`.
   *
   * Null asks the enricher to find it by name at runtime. Pinning it is the
   * escape hatch for a site that renamed the field, or one carrying both the
   * company-managed `Story Points` and the team-managed `Story point estimate`
   * where the automatic choice picks the wrong one.
   */
  readonly storyPointsField: string | null;
  /**
   * Days of history each run measures, ending at the moment the run started.
   *
   * The whole window is measured in one pass rather than a day at a time: Jira
   * answers a date range in one query, and asking ninety times would spend the
   * entire request budget on a single integration.
   */
  readonly historyDays: number;
  /**
   * Ceiling on issues pulled per project scope, per run.
   *
   * Bounds the cost of a project with a very large ticket volume, at the price
   * of measuring only the most recently updated issues in it. The enricher logs
   * when it hits this, because a silently truncated measurement is one somebody
   * would otherwise compare against a complete one.
   */
  readonly maxIssuesPerProject: number;
  /**
   * Requests one snapshot pass may spend on Jira, on an allowance of its own.
   *
   * Its own rather than a share of the ingestion budget, so a project with a
   * large ticket volume costs the pass its Jira figures and nothing else — it
   * used to be able to spend what the repository snapshots needed. A run that
   * reaches this stops at the project it is on and says so.
   */
  readonly requestBudgetPerRun: number;
}

export const DEFAULT_JIRA_HISTORY_DAYS = 90;
export const DEFAULT_JIRA_MAX_ISSUES_PER_PROJECT = 1000;
/**
 * Room for about two dozen projects at the default `maxIssuesPerProject`.
 *
 * A project costs at most ten pages of issues, two backlog lookups and one
 * count per priority, and three site-wide lookups are paid once per run.
 */
export const DEFAULT_JIRA_REQUEST_BUDGET_PER_RUN = 500;

export const DEFAULT_JIRA_SETTINGS: JiraSettings = {
  enabled: false,
  filter: null,
  storyPointsField: null,
  historyDays: DEFAULT_JIRA_HISTORY_DAYS,
  maxIssuesPerProject: DEFAULT_JIRA_MAX_ISSUES_PER_PROJECT,
  requestBudgetPerRun: DEFAULT_JIRA_REQUEST_BUDGET_PER_RUN,
};

/**
 * Builds the Jira block from the Atlassian settings the operator configured.
 *
 * Structurally typed rather than importing `AtlassianSettings`, so that adding
 * a field to the credential block never drags a change through here — the two
 * halves are configured together but are not the same concern.
 */
export const jiraSettingsFrom = (
  atlassian: {
    readonly historyDays: number;
    readonly jira: {
      readonly enabled: boolean;
      readonly storyPointsField: string | null;
    };
  },
  overrides: Partial<JiraSettings> = {},
): JiraSettings => ({
  ...DEFAULT_JIRA_SETTINGS,
  enabled: atlassian.jira.enabled,
  storyPointsField: atlassian.jira.storyPointsField,
  historyDays: atlassian.historyDays,
  ...overrides,
});
