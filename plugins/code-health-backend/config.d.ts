/**
 * Configuration schema for the Code Health backend plugin.
 *
 * Repository credentials are deliberately absent: the plugin authenticates to
 * GitHub and Azure DevOps through the host application's existing
 * `integrations` configuration, so there is no second copy of a token to
 * rotate. The only secrets declared here are the WakaTime key and the Atlassian
 * token, neither of which has an `integrations` equivalent.
 */
export interface Config {
  codeHealth?: {
    /**
     * Who may start the history collection over, as catalog entity references
     * of users or groups — `user:default/jane`, `group:default/platform`. A
     * bare name defaults to a user, so `jane` means `user:default/jane`.
     *
     * Empty by default, which means nobody: resetting drops every collected
     * commit, pull request, review and build and re-walks the providers, which
     * is hours of rate-limited requests, so it is not something an install
     * should acquire by upgrading.
     *
     * This list is one of two levers and the framework is the other. On a stock
     * Backstage the default permission policy allows everything, so the
     * permission alone cannot say "administrators only" — this list is what
     * makes the restriction real out of the box. An installed policy, or the
     * RBAC plugin, denies `code-health.ingestion.reset` and overrides this list
     * in the other direction: a name here that the policy refuses is refused.
     *
     * @visibility backend
     */
    administrators?: string[];

    catalog?: {
      /**
       * Entity filters passed straight through to the catalog when discovering
       * repositories. Each list entry is one filter, and an entity matching any
       * of them is tracked. Defaults to `[{ kind: 'Component' }]`.
       *
       * Only entities that also resolve to a supported repository — through
       * `github.com/project-slug`, `dev.azure.com/project-repo`, or a
       * `backstage.io/source-location` pointing at a configured integration —
       * are ingested; the rest are skipped.
       *
       * @visibility backend
       */
      entityFilter?: Array<{ [key: string]: string | string[] }>;
    };

    ingestion?: {
      /**
       * How far back the background actor walks, in days. Defaults to 365.
       *
       * @visibility backend
       */
      retentionDays?: number;

      /**
       * Size of one backfill step, as an ISO 8601 duration. Defaults to `P1D`,
       * which walks the history a day at a time.
       *
       * Larger steps finish the backfill proportionally faster, because both
       * providers accept an arbitrary date range in a single request; the cost
       * is coarser resume granularity when a run is interrupted.
       *
       * @visibility backend
       */
      backfillChunk?: string;

      /**
       * Hard ceiling on provider requests issued per scheduled run of the
       * ingestion actor, and per snapshot pass on the repository loop — the
       * provider snapshots and the Sonar readings taken beside them. Defaults
       * to 500. When it is spent the run stops and leaves its cursors
       * untouched, so the next run resumes where it left off; a snapshot pass
       * that stops short says how many repositories it left, and takes those
       * first the next time.
       *
       * The optional integrations do not draw on it. WakaTime, Jira and
       * Confluence each spend their own `requestBudgetPerRun` during the
       * snapshot pass, so a large space or project costs the pass that
       * integration's figures and nothing else.
       *
       * @visibility backend
       */
      requestBudgetPerRun?: number;

      /**
       * Maximum number of requests in flight against one provider host.
       * Defaults to 4. The gateway lowers this on its own when the provider
       * reports that it is close to throttling.
       *
       * @visibility backend
       */
      concurrencyPerHost?: number;

      /**
       * How often the ingestion actor runs. Defaults to every 5 minutes with a
       * 15 minute timeout and a 30 second initial delay.
       *
       * @visibility backend
       */
      schedule?: {
        frequency?: { [key: string]: number | string } | string;
        timeout?: { [key: string]: number | string } | string;
        initialDelay?: { [key: string]: number | string } | string;
        scope?: 'global' | 'local';
      };

      /**
       * How often the catalog is re-read for repositories to track. Defaults to
       * every 30 minutes with a 10 minute timeout.
       *
       * @visibility backend
       */
      discoverySchedule?: {
        frequency?: { [key: string]: number | string } | string;
        timeout?: { [key: string]: number | string } | string;
        initialDelay?: { [key: string]: number | string } | string;
        scope?: 'global' | 'local';
      };

      /**
       * How often the current-state snapshot is captured. Defaults to daily at
       * 03:00 with a one hour timeout.
       *
       * Compliance checks, README badges and Sonar measures cannot be
       * backfilled — no provider exposes their past state — so their history
       * starts at the first snapshot after installation.
       *
       * @visibility backend
       */
      snapshotSchedule?: {
        frequency?: { [key: string]: number | string } | string;
        timeout?: { [key: string]: number | string } | string;
        initialDelay?: { [key: string]: number | string } | string;
        scope?: 'global' | 'local';
      };
    };

    sonar?: {
      /**
       * Whether to enrich snapshots with Sonar measures. Defaults to false.
       *
       * When enabled the snapshot task calls the `sonarqube` backend plugin
       * over the internal service-to-service channel, so the Sonar token stays
       * where that plugin already keeps it. Requires
       * `@backstage-community/plugin-sonarqube-backend` to be installed and the
       * entity to carry a `sonarqube.org/project-key` annotation.
       *
       * @visibility backend
       */
      enabled?: boolean;
    };

    wakaTime?: {
      /**
       * WakaTime organisation whose dashboard members are summarised.
       *
       * Leave it out to measure the key's own account instead, which is the
       * useful behaviour on a personal plan — the alternative is an integration
       * that silently collects nothing.
       *
       * @visibility backend
       */
      organization?: string;

      /**
       * Which dashboard inside the organisation, by id or by name.
       *
       * Members hang off a dashboard rather than off the organisation, and most
       * organisations have exactly one. Leave it out and the first one is used.
       *
       * @visibility backend
       */
      dashboard?: string;

      /**
       * WakaTime API key. Read only by the backend and never sent to a browser.
       *
       * @visibility secret
       */
      apiKey?: string;

      /**
       * WakaTime API base URL. Defaults to `https://wakatime.com/api/v1`.
       *
       * @visibility backend
       */
      baseUrl?: string;

      /**
       * Days of coding history collected on each snapshot pass. Defaults to 30.
       *
       * The whole window is re-read every run because it costs the same as one
       * day: the summaries resource answers for an arbitrary span in a single
       * request per member. How far back it can reach is a property of the
       * WakaTime plan, not of this setting.
       *
       * @visibility backend
       */
      historyDays?: number;

      /**
       * Whether to collect AI authorship and token counts. Defaults to false.
       *
       * This is the expensive half. Coding time for a whole window costs one
       * request per member; the AI figures come from the durations resource,
       * which answers for a single day at a time.
       *
       * @visibility backend
       */
      includeAiMetrics?: boolean;

      /**
       * Days of AI figures collected per member per run, newest first.
       * Defaults to 3.
       *
       * AI history therefore accumulates forwards from the day the option was
       * switched on rather than being backfilled, which is why a chart of it
       * starts in the middle.
       *
       * @visibility backend
       */
      aiDaysPerRun?: number;

      /**
       * Requests one snapshot pass may spend on WakaTime. Defaults to 500,
       * which is room for about 120 members with the AI figures on, or 500
       * without.
       *
       * An allowance of its own rather than a share of
       * `ingestion.requestBudgetPerRun`, so a large organisation never costs
       * the pass a repository snapshot. A pass costs two requests to find the
       * members, then one per member for the coding-time window and one more
       * per member per day of AI figures.
       *
       * @visibility backend
       */
      requestBudgetPerRun?: number;
    };

    /**
     * One Atlassian Cloud site, shared by Jira and Confluence.
     *
     * Deliberately a single credential rather than one per product: they are
     * the same account and the same API token, and asking for it twice only
     * creates a way for the two to drift apart. Configuring the site switches
     * both integrations on; switching one off afterwards is the exception, so
     * it is the flag.
     */
    atlassian?: {
      /**
       * Site root, e.g. `https://acme.atlassian.net`. A trailing slash is
       * stripped.
       *
       * @visibility backend
       */
      baseUrl?: string;

      /**
       * The Atlassian account the API token belongs to.
       *
       * @visibility backend
       */
      email?: string;

      /**
       * Atlassian API token. Read only by the backend, never sent to a browser.
       *
       * @visibility secret
       */
      apiToken?: string;

      /**
       * Ceiling on results pulled per run, per resource. Defaults to 2000.
       *
       * Both products page indefinitely, and a site with a decade of history
       * would otherwise spend an entire request budget on one resource.
       *
       * @visibility backend
       */
      maxResultsPerRun?: number;

      /**
       * Days of history each run measures. Defaults to 90.
       *
       * @visibility backend
       */
      historyDays?: number;

      jira?: {
        /**
         * Whether to collect Jira measures. Defaults to true once the site is
         * configured.
         *
         * @visibility backend
         */
        enabled?: boolean;

        /**
         * JQL appended to every query with `AND`, e.g. to exclude a service-desk
         * queue whose tickets are not engineering work.
         *
         * Interpolated verbatim, because there is no safe way to escape a
         * fragment of a query language an operator is deliberately writing. It
         * is acceptable only because it comes from this file rather than from a
         * catalog entity or an HTTP request; project keys read from annotations
         * are quoted and escaped instead.
         *
         * @visibility backend
         */
        filter?: string;

        /**
         * Custom field id holding story points, e.g. `customfield_10016`.
         *
         * Leave it out and the field is found by name at runtime. Pinning it is
         * the escape hatch for a site that renamed the field, or one carrying
         * both `Story Points` and `Story point estimate`.
         *
         * @visibility backend
         */
        storyPointsField?: string;

        /**
         * Issues fetched per project per run. Defaults to 1000.
         *
         * @visibility backend
         */
        maxIssuesPerProject?: number;

        /**
         * Requests one snapshot pass may spend on Jira. Defaults to 500,
         * which is room for about two dozen projects at the default
         * `maxIssuesPerProject`: a project costs up to ten pages of issues,
         * two backlog lookups and one count per priority, and three
         * site-wide lookups are paid once per run.
         *
         * An allowance of its own rather than a share of
         * `ingestion.requestBudgetPerRun`, so a project with a large ticket
         * volume costs the pass its Jira figures and nothing else. A run that
         * reaches it stops at the project it is on and logs the shortfall.
         *
         * @visibility backend
         */
        requestBudgetPerRun?: number;
      };

      confluence?: {
        /**
         * Whether to collect Confluence measures. Defaults to true once the
         * site is configured.
         *
         * @visibility backend
         */
        enabled?: boolean;

        /**
         * Spaces to restrict the sweep to. Empty means every space the token
         * can read.
         *
         * @visibility backend
         */
        spaceKeys?: string[];

        /**
         * Days without an edit after which a page counts as stale.
         * Defaults to 180.
         *
         * @visibility backend
         */
        staleAfterDays?: number;

        /**
         * Pages a run fetches a version history for, across every space.
         * Defaults to 500.
         *
         * @visibility backend
         */
        maxPagesPerRun?: number;

        /**
         * Of those, how many get body fetches so written volume can be
         * measured. Defaults to 150.
         *
         * @visibility backend
         */
        maxPagesForVolume?: number;

        /**
         * Pages a run asks the analytics API about. Premium sites only, since
         * page-view analytics is not served on Standard. Defaults to 200.
         *
         * @visibility backend
         */
        maxAnalyticsLookups?: number;

        /**
         * Requests one snapshot pass may spend on Confluence. Defaults to
         * what the three caps above can need — 2,700: one version history for
         * each of 500 pages, up to twelve bodies for each of 150 pages
         * measured for volume, 200 analytics lookups, and 200 for the sweeps
         * that find the pages and the counts behind a few spaces' reports —
         * so a walk the caps allow is never cut short. Lower it and the caps
         * become nominal: a run stops at the allowance and keeps what it had.
         *
         * An allowance of its own rather than a share of
         * `ingestion.requestBudgetPerRun`. The sweep used to draw on that one
         * before a single repository was captured, and one moderately large
         * space could leave the repository loop with nothing.
         *
         * @visibility backend
         */
        requestBudgetPerRun?: number;
      };
    };
  };
}
