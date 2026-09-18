# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Yarn workspaces monorepo holding the three packages of the Code Health [Backstage](https://backstage.io)
plugin:

| Package | Directory | Role |
|---|---|---|
| `@rios0rios0/backstage-plugin-code-health` | `plugins/code-health` | `frontend-plugin` — the dashboard |
| `@rios0rios0/backstage-plugin-code-health-backend` | `plugins/code-health-backend` | `backend-plugin` — discovery, ingestion, read API |
| `@rios0rios0/backstage-plugin-code-health-common` | `plugins/code-health-common` | `common-library` — the wire contract |

The backend discovers repositories from the **Backstage catalog**, authenticates through the host
application's existing **`integrations`** configuration, ingests a year of history in a rate-limited
background job, and stores it in the Backstage database. The browser talks only to
`/api/code-health` and holds no credential at all.

Four optional integrations enrich that history and are absent unless configured: **Sonar** (through
the community backend plugin), **WakaTime** (coding time and AI token counts), and **Jira** and
**Confluence** (one Atlassian credential lights up both). They each identify people under their own
account system, which is why a contributor row is a *person* rather than an account and why the
**Identities** tab exists.

All three packages share one version and are bumped together.

## Commands

```bash
corepack enable        # Enable Yarn Berry via corepack (first time only)
yarn install           # Install dependencies
yarn build             # tsc + backstage-cli repo build --all
yarn typecheck         # One type-check pass over the whole workspace
make lint              # ESLint and knip via pipeline scripts
make test              # Jest across all packages via pipeline scripts
make sast              # CodeQL, Semgrep, Trivy, Hadolint, Gitleaks
```

**Never run `eslint`, `jest`, or SAST tools directly.** Always use `make` targets, which invoke the
[rios0rios0/pipelines](https://github.com/rios0rios0/pipelines) scripts.

The root scripts use `backstage-cli repo lint | test | build`, not the per-package commands. That is
load-bearing: `repo test --coverage` writes a merged `coverage/` and `junit-report.xml` at the
repository root, which is exactly where the shared pipeline looks for them.

To exercise the backend alone:

```bash
yarn workspace @rios0rios0/backstage-plugin-code-health-backend start
curl http://localhost:7007/api/code-health/health
```

## Architecture

### Backend (`plugins/code-health-backend`)

Hexagonal: `domain/` holds entities, commands and ports; `infrastructure/` holds the implementations.

| File | Purpose |
|---|---|
| `src/plugin.ts` | `createBackendPlugin`, DI wiring, the three scheduled tasks |
| `migrations/20260810000000_init.js` | The whole schema, portable Knex only |
| `migrations/20260825000000_catalog_facts.js` | The catalog-derived columns on the repository row that the documentation and API grades read, added by discovery |
| `migrations/20260901000000_identities.js` | The person directory and the per-source measures table |
| `migrations/20260915000000_identity_exclusions.js` | The accounts that are measured by nothing, and the reason each one was taken out |
| `migrations/20260909000000_reattribute_merged_work.js` | Sends every tracked repository's cursors back to a fresh install and drops what the walk re-collects, because the rows before it credit the merger |
| `src/domain/entities/merge_attribution.ts` | The one place merged work is credited to whoever did it: squash to the author, merge commit dropped, build to the author of what it built |
| `src/infrastructure/repositories/knex_code_health_store.ts` | Persistence; commits events, fetched days and cursors in one transaction |
| `src/infrastructure/http/provider_gateway.ts` | The single door every provider request passes through |
| `src/domain/commands/discover_repositories.ts` | Catalog → tracked repositories |
| `src/domain/commands/ingest_repository_history.ts` | The two-phase background actor |
| `src/domain/commands/capture_repository_snapshots.ts` | Daily current-state capture — the repositories the last pass never reached first — and every optional enricher's pass, each on its own allowance |
| `src/domain/entities/snapshot_allowances.ts` | One request allowance per source of the snapshot pass — the repository loop, Sonar, WakaTime, Jira, Confluence — with what each spent, which were refused a request, and the setting that sizes each |
| `src/domain/entities/person_directory.ts` | Which person an account belongs to and whether that person is measured, built per request from the link and exclusion tables; `loadPersonDirectory`, `measuredEvents` and `measuredContributorMetrics` are the one way every read applies both |
| `src/domain/commands/reconcile_identities.ts` | The one automatic link: an account whose e-mail matches a catalog `User` |
| `src/domain/commands/link_identity.ts` / `list_identities.ts` | The Identities screen's read and its two linking writes |
| `src/domain/commands/list_directory_users.ts` | The "like" search behind the link picker: the directory enumerated once per query and filtered by name, address and entity name |
| `src/domain/commands/exclude_identity.ts` | The Identities screen's other two writes: taking an account out of every measurement under a named reason, and putting it back |
| `src/domain/commands/get_contributor_trend.ts` / `get_repository_trend.ts` | One person's and one repository's history, bucketed, each bucket carrying the summary and the score it earns; each also carries the `fleet` mean rates the Averages card compares against |
| `src/domain/commands/list_owned_repositories.ts` | The repositories a person owns, through `spec.owner` and their group ancestry |
| `src/domain/commands/reset_ingestion.ts` | Sends every tracked repository's cursors back over the reach asked for and drops what the walk re-collects |
| `src/domain/commands/authorize_administrator.ts` | The two gates a reset passes: named in `codeHealth.administrators`, *and* allowed by the permission framework |
| `src/domain/entities/permissions.ts` | `code-health.ingestion.reset`, registered by the plugin and exported so a policy or the RBAC plugin can name it |
| `src/domain/entities/bucket.ts` | Where a day's bucket starts and ends — shared by the cadence series and both trends, with the end bounded by the window so no snapshot taken after it is read |
| `src/domain/entities/contributor_aggregation.ts` | The per-person accumulation the contributors list and a trend's every bucket run through, split from the naming and Sonar pass that needs the catalog |
| `src/domain/entities/repository_summary_builder.ts` | One repository row from a snapshot and a window's events, built once for the table and once per bucket for a trend |
| `migrations/20260910000000_owner.js` | The `owner_ref` column discovery writes the catalog's `spec.owner` to |
| `src/infrastructure/services/collectors/` | Azure DevOps and GitHub collectors |
| `src/infrastructure/services/wakatime_enricher.ts` | Coding time and AI tokens, per member per day |
| `src/infrastructure/services/atlassian/` | One client, the Jira enricher and the Confluence enricher |
| `src/infrastructure/controllers/code_health_router.ts` | The read API, the capabilities probe and the identity links |
| `docs/wakatime.md`, `docs/jira.md`, `docs/confluence.md` | What each integration measures, and what its provider cannot answer |
| `docs/attribution.md` | Who a commit, a build and a review belong to, per provider field, and what neither provider can answer |

### Frontend (`plugins/code-health`)

5-layer Clean Architecture; dependencies point inward toward Domain.

| File | Purpose |
|---|---|
| `src/plugin.ts` / `src/alpha.tsx` | Legacy and declarative entry points |
| `src/main/apis.ts` / `src/main/api_refs.ts` | `createApiFactory` wiring; one stateless client behind nine data refs (repositories, contributors, coverage, time series, integrations, identities, trends, ownership, administration), plus a separate config ref |
| `src/presentation/hooks/use_identities.ts` | The Identities screen's read and its four writes, each of which reloads the listing rather than patching a row |
| `src/presentation/hooks/use_directory_search.ts` | The link picker's search: asked once the typing pauses, for two characters or more, with a stale reply never landing on a later query |
| `src/presentation/components/identity_link_cell.tsx` | The likely-match chips and the searching picker behind them; the Link button enables only for a picked user or text that parses as a reference |
| `src/presentation/components/data_table.tsx` | The one table every listing renders through: sorting, a filter row whose selects can carry a label distinct from the value they filter on, and `PaginationControls` with the page size every table shares |
| `src/domain/entities/repository_audit.ts` | The gaps a column filter cannot express — absence, negation, either-of-two — as predicates dispatched by id, with their counts |
| `src/presentation/components/repository_audit_filters.tsx` | The chip row above the repositories table, each chip carrying how many repositories it matches |
| `src/infrastructure/http/code_health_backend_client.ts` | The only thing the browser talks to |
| `src/main/router.tsx` | Page composition, the backend-reachability gate and the capabilities probe; Insights is the root tab |
| `src/presentation/pages/identities_page.tsx` | Attaching an account to a catalog `User`, and deciding whether it is measured at all — the plugin's only writes |
| `src/presentation/components/identity_exclusion_cell.tsx` | The four reasons an account stops being measured, and the one row that can undo it |
| `src/presentation/components/columns/` | One column-group factory per integration, called only when its flag is set |
| `src/presentation/components/insights/` | Three card sets per integration — fleet, people, repositories — each gated on its flag; `detail_links.ts` is the one place a ranked row's link to a detail page is built |
| `src/domain/entities/time_range.ts` | Which windows are offered, bounded by coverage — rolling ranges and calendar months |
| `src/domain/entities/trend_range.ts` | The same two shapes for a detail page, resolving a month through the tables' own `toWindow` so one month cannot mean two windows |
| `src/presentation/components/contributor_rates_card.tsx` | What one person does in a day, a week and a month — the score's own arithmetic written out — with the team's average under every figure and how far from it the person sits |
| `src/presentation/components/repository_rates_card.tsx` | The same card for a repository's activity, against the fleet's average over its active repositories |
| `src/presentation/components/rate_comparison.tsx` | A figure with its average underneath, and the delta said in words; shared by both averages cards |
| `src/presentation/components/range_picker.tsx` | One control for both, so the two can never disagree; every offered month is in the list by name |
| `src/presentation/hooks/range_selection_context.tsx` | The one selection the tabs share, so a month picked on one is still the month on the next |
| `src/presentation/components/backfill_progress.tsx` | Why wider ranges are not available yet |
| `src/routes.ts` | The route refs, and why a person key travels in the query string rather than a path segment |
| `src/presentation/pages/contributor_detail_page.tsx` / `repository_detail_page.tsx` | One person's and one repository's trend and score, plus — for a person — the repositories they own |
| `src/presentation/components/charts/trend_chart.tsx` | Any column of a summary drawn over the buckets the backend returned |
| `src/presentation/components/score_card.tsx` | A score beside the components it was folded from; the number is never drawn without them |
| `src/presentation/components/trend_range_picker.tsx` | One to six months, bounded by what the backfill reached |
| `src/presentation/hooks/use_trend_window.ts` | The months picked, turned into a window and the bucket `trendBucketFor` implies |
| `src/domain/entities/contributor_trend.ts` | Turns a person's trend points into chart series, with null where a bucket measured nothing and zero where it measured nothing happening |
| `src/presentation/hooks/use_contributor_trend.ts` / `use_owned_repositories.ts` | The contributor page's two reads |
| `src/presentation/components/owned_repositories_card.tsx` | The repositories a person owns, worst health first, sortable and filterable on every column and paged ten at a time; and what to do when they own none |
| `src/domain/entities/repository_trend.ts` / `src/presentation/hooks/use_repository_trend.ts` | The repository page's series and its one read; a backend 404 reads as "not tracked" rather than as a failure |
| `src/presentation/components/ingestion_reset_button.tsx` | The administrator's reset — the access probe, the reach and the confirmation |
| `src/presentation/hooks/use_access.ts` | `/v1/access`, asked once; unreachable reads as "not an administrator" rather than as an error panel |
| `src/domain/entities/reset_reach.ts` | Which reaches a reset offers, in months, each converted to days and bounded by the retention |

### Common (`plugins/code-health-common`)

The wire contract, and the pure functions both sides have to agree on.

| File | Purpose |
|---|---|
| `src/api.ts` | Every request and response shape, and the plugin id both packages register under |
| `src/score.ts` | What a score is — a value, the evidence behind it, the components it was folded from — and `combineScore`, which redistributes the weight of anything unmeasured |
| `src/productivity_score.ts` | The per-person components and their nominal weights, which integration each needs, the renormalisation over the configured set, and the fleet's **mean daily rate** the relative ones are read against |
| `src/contributor_rates.ts` | A window total turned into a daily, weekly and monthly rate, and the wording every rate is said in |
| `src/fleet_rates.ts` | The team's mean daily rate for every row of the person's Averages card, built on `fleetReferenceOf` so the card and the score say one average; and `rateDeltaOf`, how far a rate sits from it |
| `src/repository_rates.ts` | A repository's activity as rates, and the fleet's mean over its active repositories |
| `src/repository_health_score.ts` | The per-repository components, weights and decay constants |
| `src/trend.ts` | The bucketed point shapes, `TREND_MONTHS`, and `trendBucketFor` — day up to 45 days, week beyond |
| `src/ownership.ts` | `OwnershipInfo`, and `ownerEntityRef`, which normalises `spec.owner` exactly as the catalog does |
| `src/identity_exclusion.ts` | The four reasons an account is not a person being measured, with the wording the menu and the chip are built from |
| `src/identity.ts` | Besides the suggestion ranking, `searchDirectoryUsers` — the "like" search the link picker and the backend share, every word matched in any order |

## Decisions worth not re-litigating

- **The catalog is the only source of repositories.** Nothing is enumerated from a provider API. The
  previous design listed every project and repository in the organisation on every dashboard load,
  which is what produced the Azure DevOps throttling this release exists to fix.
- **Rate-limit headers are read on every response, not only on errors.** Azure DevOps applies
  throttling as *latency on a successful `200`* and sends `Retry-After` and `X-RateLimit-*` before
  it starts delaying. Inspecting them only on failure misses the entire warning.
- **Two Azure DevOps API defaults are overridden explicitly** because both hide most of the data:
  the pull request API returns only *active* requests filtered on *creation* time, and the build
  query's `minTime`/`maxTime` apply to whichever timestamp `queryOrder` names.
- **Azure DevOps branch policies are fetched once per project**, not once per repository. Forty
  repositories in a project used to download one identical payload forty times.
- **The latest Azure DevOps tag is chosen by version comparison.** Its refs API returns tags
  alphabetically with no dates at all, so `$top=1` reliably returned the *oldest* version-like tag.
- **Churn is not comparable across platforms.** GitHub reports added and deleted lines; Azure DevOps
  reports changed files. The line fields stay null there rather than carrying a different unit under
  the same name. Azure DevOps exposes no line count anywhere in its REST API — reconstructing one
  would mean diffing every blob of every commit — so `ContributorSummary.churnUnit` carries the unit
  each row was measured in and the table prints it under the figure. Before that field existed the
  contributors table showed `0 / +0 / -0` for an entire Azure DevOps fleet, which reads as "nobody
  wrote any code" rather than as "the provider never said". The unit is decided by whether the
  provider *reported* the field, never by whether the value came back above zero: a quiet week is a
  real measurement of zero.
- **Insights is the landing tab.** It is the only tab that answers a question about the fleet rather
  than about one row of it, so it is what someone opening the plugin cold wants first; the two
  tables are the drill-down. Moving it to `/` cost the `insights` sub route, which is the breaking
  change the changelog leads with — an app deep-linking to `/insights` has to move to the plugin
  root, and `codeHealthPlugin.routes.insights` became `routes.repositories`.
- **Documentation and catalog-API grades combine the entity with the repository.** The catalog half
  (`backstage.io/techdocs-ref`, `spec.providesApis`, `spec.type`, `metadata.links`) is read by
  discovery and stored on the repository row, because it changes when somebody edits a YAML file
  rather than on the snapshot's schedule. The repository half (a `docs/` tree, an API definition) is
  read by the daily snapshot. Both fields stay `null` until a snapshot exists, because grading on
  half the evidence reports a gap that is not there.
- **The repository file scan is shallow on purpose** — the root, `docs/` and `api/`. On GitHub the
  three trees ride along in the snapshot's existing GraphQL document and cost no request at all; on
  Azure DevOps it is one listing per repository plus one for each of those directories that exists.
  A recursive walk would be unbounded on a large repository and would cost a different amount on
  each platform, which is exactly what makes a cross-platform metric meaningless.
- **A README does not count as documentation.** Nearly every repository has one, so counting it
  would grade the whole fleet documented. It is still reported as a check, because "has a README and
  nothing else" and "has nothing at all" are different conversations to have with a team.
- **Every source of the snapshot pass spends an allowance of its own.** The enrichers used to draw
  on the ingestion budget before a single repository was captured, and Confluence's caps alone — 500
  version histories, twelve bodies for each of 150 pages, 200 analytics lookups — exceed the default
  500 several times over, so one moderately large space left the repository loop, the only part of
  the pass nothing else can record, with nothing: silently, and for the same tail of repositories
  every night. `SnapshotAllowances` hands the loop and Sonar `ingestion.requestBudgetPerRun` and each
  integration its own `requestBudgetPerRun` (`codeHealth.wakaTime`, `codeHealth.atlassian.jira`,
  `codeHealth.atlassian.confluence`); Confluence's default is derived from its caps (2,700) so the
  caps are reachable rather than nominal. Confluence is two allowances, because its two sweeps' costs
  scale with different things: the per-space reports spend `requestBudgetPerSpace` (40) for each
  space the catalog names, pooled, since their cost scales with the annotation count and a flat
  number sized for the contributor sweep's caps would be spent by twenty annotated spaces before that
  sweep began. The completion line says what each source spent by name,
  and the pass warns — naming the setting — when it left repositories unvisited, when Sonar could not
  be asked about some, or when an integration was *refused* a request. Refused rather than
  exhausted, because an allowance spent to the unit finished, and telling an operator to raise a
  setting that was exactly enough sends them after a problem that is not there.
- **The snapshot loop takes the repositories the last pass never reached first**, ordered by the day
  of each one's most recent snapshot (`listLatestSnapshotDays`): never captured, then oldest capture,
  ties in the store's order. It needs no cursor, because the snapshots record where the last pass got
  to, and it is the same staleness-first rule the ingestion actor follows. The loop also runs
  *before* the WakaTime, Jira and Confluence contributor sweeps: the allowances bound requests, not
  minutes, and the task's timeout is shared, so a sweep that overruns should do so with the day's
  snapshots already stored. Only the per-repository Jira and Confluence figures go ahead of the loop,
  because they ride on the snapshot row itself.
- **Sonar surfaces an exhausted allowance instead of swallowing it.** `SonarqubeEnricher` rethrows
  `BudgetExhaustedError` alone; everything else it still reads as "no Sonar project". The loop then
  stores the snapshot with `sonarMetrics: null`, counts the repository as skipped and warns with the
  count, because a null on a repository that has a project reads as "no project" everywhere else.
- **A Confluence space is queried by the key it was created with, whichever key the annotation or
  `spaceKeys` uses.** Confluence Cloud lets an administrator change a space's key; the new one is the
  space's alias (`currentActiveAlias` in the v2 schema; the parser reads a bare `alias` too), it is
  what the URL shows and so what gets copied into an annotation, and the spaces API resolves it —
  but CQL matches only the original. Whether `keys=` really resolves an alias is the one half of this
  not verifiable from the contract; `docs/confluence.md` lists it among the behaviours to watch on a
  first deployment, and the warning below is its symptom. `resolveSpaces` indexes each answer
  under both keys, every query is built from `keyFor`, and the allow-list is matched by space id
  rather than by spelling. Before this the lookup was indexed by the original key alone, so it missed
  every alias and each count then ran against a key CQL did not know and reported a quiet quarter,
  with nothing said. A key Confluence lists no space for is warned about, with the entities that
  carry it, and still measured in case CQL knows it.
- **Version control measures a person only when an account of theirs came from version control.**
  `commits`, `pullRequestsMerged` and `reviewsGiven` are plain numbers with no way to say "never
  asked", so a row known only to Jira carried `commits: 0`, `meanRate` counted it — it skips null,
  not zero — and the commit mean every real committer was read against sank with each such row.
  `measuredByVersionControl` reads the row's identities, which are the union of the accounts seen in
  the window and everything the directory knows about the person: a linked account that was quiet is
  a measured zero, a quiet window, while a person version control never saw is left out of the
  version-control means and scored unmeasured on commits, pull requests, churn, reviews and the
  pipeline, with "no version-control account is linked to this person" as the reason. The trend's
  zero rows copy the window row's identities, so the rule holds per bucket.
- **A day is recorded as fetched only when a window covers it end to end**, so "no activity" and
  "not fetched yet" stay distinguishable and the range picker never offers a period it can only
  answer partially.
- **A cursor moves only after its window is committed.** A failed window is retried rather than
  leaving a hole nothing later would notice.
- **A contributor row is a person, not an account.** Commits arrive under a commit-author address
  or a login, coding time under a WakaTime username, tickets under an Atlassian `accountId`, and
  none of the three matches the others. Keyed by account, one human occupied three rows that each
  held a third of the story. `PersonDirectory` resolves accounts through the link table on *read*,
  never at collection time, which is what makes correcting a link retroactive across every window
  ever collected. An account nobody has linked keys under `<source>:<sourceKey>` and keeps its own
  row — hiding it would hide every bot, every service account and everybody nobody has linked yet,
  which are exactly the rows that show the work is unfinished.
- **An account nobody has linked is not always a person, and the ones that are not are excluded
  rather than hidden.** A fleet carries build services, bots, outside contributors to public
  repositories and people who left last year, and leaving them in is not merely untidy: output is
  scored against the team's *mean* rate in the same window, so an automation that merges two
  hundred pull requests a month drags up the bar every human on the team is then measured against.
  `code_health_identity_exclusions` records `(source, source_key)` with one of four
  reasons — former contributor, open source contributor, automated bot, service or system account —
  and the reason is **required**, because a row disappearing from every table is only reviewable six
  months later if the justification was recorded at the moment somebody decided. The four are a
  closed set for the same reason; free text is not something anybody can audit.
- **An exclusion is a statement about a person, recorded on the account it was made from.**
  `PersonDirectory` keys it by person, so excluding one account of somebody the link table says is
  one human excludes all of them — a leaver's coding time goes with their commits instead of leaving
  a row holding a third of a story, which is the exact failure linking exists to remove. For an
  account nobody has linked the person key *is* the account key, so a bot's exclusion touches
  nothing else. A row that inherited one names the account carrying it and offers no undo, because
  only the row that carries it has anything to undo.
- **An excluded account gets no row rather than a zeroed one.** `accumulateContributors` drops it,
  so it never reaches `fleetReferenceOf`; a row of zeros would still be a name on the contributors
  table and would still take part in the reference everybody is scored against.
- **`measuredEvents` splits the event kinds by what each one measures, and that split is
  load-bearing.** A commit, a pull request and a review are statements about a *person*, so an
  excluded account's are dropped outright — a repository's contributor count is a count of people
  and delivery cadence is a statement about what the team shipped. A build, a release and a tag are
  facts about the repository's machinery that merely carry whoever triggered them, so they **stay**
  and only the credit is stripped (`actorKey`, `actorName`, `actorAvatarUrl` nulled; both
  `aggregateActivity` and `accumulateContributors` already ignore an actorless event). Dropping them
  would do at read time exactly what excluding refuses to do at collection time: a platform
  excluding its build service would zero `builds`, `buildsSucceeded` and `buildsFailed` for every
  repository whose runs are scheduled, release or deployment pipelines — which `attributeMergedWork`
  cannot re-attribute, having no commit to resolve — so `buildSuccessRate` would report "no build
  reached a verdict" and `combineScore` would silently redistribute a tenth of the repository health
  weight, fleet-wide. Excluding an account changes *who is credited*; it must never make a
  repository look like it has no CI.
- **Stored per-person measures need the same rule as the events.** `measuredContributorMetrics`
  filters the WakaTime rows in `list_repository_summaries.ts` and `get_repository_trend.ts`, because
  a repository's coding time is aggregated by *project* rather than by person and so has nowhere
  else to apply it. The contributors path does not need it — `accumulateContributors` resolves every
  row through the directory itself. Without it the two tabs disagree about the same hours: gone from
  the person's row, still on the repository's, and still counted in that project's contributor
  count.
- **Every read that turns events into rows goes through `loadPersonDirectory(store)` and
  `measuredEvents`**; a sixth read that aggregates events without them would leave one view
  measuring a build service that every other view has dropped.
- **Excluding deletes nothing, so including again is retroactive.** The events, the snapshots and
  the per-source measures stay exactly as they were collected and the exclusion is applied when the
  row is built — the same rule the link table follows, and for the same reason. Deleting the rows
  instead would be irreversible, would cost a full re-walk of the provider history to undo, and
  would take the repository counters down with it: a build service's pipeline runs are that
  repository's pipeline runs whoever triggered them. A reset keeps the exclusions, like the links.
- **The Identities screen opens on the accounts nobody has linked.** Those are the only rows that
  need anything done to them, and a fleet's accounts are overwhelmingly already linked — opening on
  the full list means scrolling past ninety rows that need nothing to reach the nine that do.
  Excluded rows are still listed, dimmed: they are the one kind of row that appears nowhere else in
  the plugin, so hiding them here would leave a build service taken out of the figures with nothing
  anywhere able to say it had been, and no way to put it back.
- **An audit exists for a question a column filter cannot ask.** The table's filter vocabulary is a
  substring match or an equality select, and the four columns carrying the facts somebody managing a
  fleet actually asks about are exactly the ones that need something else: "no owner" is the
  *absence* of a value — and `ownerNameOf` returns the empty string there, which no text matches
  and which the filter row converts to `undefined` anyway — "not `main`" is a *negation*,
  "non-compliant" is *either* of two colours, and "no pipeline" was a boolean readable only inside
  the compliance chip's tooltip. Every one of those gaps was already on screen and none of them was
  selectable, so a reader could see sixteen blank owner cells and had no way to list them.
  `REPOSITORY_AUDITS` holds one predicate per gap and `filterByAudits` dispatches through a lookup
  by id, so adding an audit is adding an entry rather than editing the dispatch. The division of
  labour with the columns is the rule to keep: an audit answers "which repositories have this gap",
  a column filter answers "which value does this column have". Absence and negation belong in the
  chips; picking `master` out of the branches the fleet actually uses belongs in the column.
- **The chips intersect, and they reset the page by hand.** Every other filter on the table narrows,
  so a set of chips that widened would make the two kinds of control disagree about what picking
  more of them does — and each chip carries its own count, so the populations are legible one at a
  time without a union. They filter the `data` handed to `useReactTable` rather than going through
  TanStack's own column filter state, which means nothing resets the page index for them: a reader
  on page three who ticks an audit matching four repositories would be left looking at an empty
  table under "3 / 1". `resetPage` is called from the toggle and from the clear.
- **An audit's count is taken before the audits are applied, and after the archived and fork
  toggles.** Before, so the number beside a chip is the size of that population and does not
  flicker as other chips are picked; after, so an archived repository nobody owns is not reported as
  outstanding work on a screen that is not showing it. The "N of M repositories" line is what
  reports the intersection. A chip nothing matches is still drawn — a zero is a statement about the
  fleet worth having on screen — but disabled, because selecting it could only empty the table; one
  already selected stays enabled whatever its count, so a selection is always undoable by the
  control that made it.
- **A missing `complianceStatus` is never a failing one.** `pipelineExists === false` is a
  measurement and `complianceStatus === null` is the absence of one, so a repository no snapshot has
  reached has an *unknown* pipeline rather than a missing one — the same rule `combineScore` follows
  for an unmeasured component. That is why the `no-pipeline` audit and the CI filter's
  `no-pipeline` option both read `=== false`, and why "Never measured" is its own chip rather than
  folded into the others. On a fresh install it is the whole fleet until the first nightly pass.
- **The expected default branch is configuration, not a constant.** It is the one expectation the
  plugin holds that is a convention rather than a measurement, and `"main"` was hardcoded in
  `DefaultBranchCell` — so a fleet standardised on `master` or `trunk` had every row flagged, which
  is an audit nobody reads. `codeHealth.expectedDefaultBranch` is read by `readCodeHealthConfig`,
  threaded through `DashboardPage`, and used by both the column's warning chip and the audit, so the
  two can never disagree. A blank value falls back rather than flagging the whole fleet.
- **A select filter reads in the words its badge uses.** `FilterOption` lets a select carry a label
  distinct from the value it filters on, because the stored values are colours and state names: the
  Compliance filter offered `red` and `yellow` while the chip one cell away said "Non-compliant" and
  "Partial", leaving the reader to pair them up. Every select that can be blank also offers "Not
  measured", which needed no new filter logic — the accessors folded null to a sentinel all along
  and the rows were unreachable only because nothing offered them. The CI filter's literal `all`
  option went with this: the filter row already draws a blank "All" for every column, so the select
  was offering "All" and "all".
- **The Default Branch filter is a select over the branches present, and the Owner filter is not.**
  A branch select is built from the data because free text could only find a branch the reader had
  already guessed at, and the distinct set is four or five names. Owner stays a text field: the
  distinct owners on a large fleet run to dozens, and a select would lose the substring search that
  makes "plat" find "Platform". Absence is the chip's job on both.
- **A cell assertion has to say it means a cell.** Several filters now carry the same words and
  numbers their columns' cells do — a branch name, "Passed", "Compliant" — and every audit chip
  carries a count, so a document-wide `getByText` matches more than one node. `TableBody` carries
  `data-testid="tableBody"` and the table tests query `within` it.
- **Every table pages through one control, and the control is always drawn.** `PaginationControls`
  takes the TanStack table and renders the page size, the page and the two arrows on the
  repositories, contributors and identities tables and on the owned-repositories card. It used to
  appear only past the first page, which on any fleet with more repositories than people read as
  "the repositories table paginates and the contributors table does not", and left nobody a way to
  ask for a shorter page. The sizes are one list, `PAGE_SIZE_OPTIONS`, so a size picked on one table
  is on offer on the next; the card opens on ten rather than twenty-five because it shares its page
  with a dozen charts.
- **The link picker searches the directory; it never enumerates it into the browser.** The field on
  an unlinked Identities row is an Autocomplete over the row's likely matches plus whatever
  `GET /v1/identities/users?q=` returns for the text typed, asked through `useDirectorySearch` only
  once the typing pauses and only for two characters or more. The backend enumerates the directory
  once per query and filters it with `searchDirectoryUsers` — the catalog's filter API matches whole
  values, not substrings, and the listing already enumerates the directory for its suggestions on
  the same screen — and the route answers an empty query with nobody rather than the first page of
  everybody. The Link button enables only for a picked user or text that parses as a **user**
  reference: a bare name sent to the backend comes back as a refusal the reader cannot act on, and
  a pasted `group:default/platform` parses but names nobody a link can attach to — `LinkIdentity`
  refuses any kind but `user`, and `getUsersByRef` skips any entity that is not a `User` rather
  than dressing a group up as one. The empty-search wording says "no match found" and offers the
  pasted reference, never "nobody in the directory matches": the read behind it is capped at
  `MAX_DIRECTORY_USERS`, so on a very large tenant a person can exist and not be returned. A sort or a filter
  on the identities table resets the page asynchronously (TanStack queues it), so a test that sorts
  and then counts rows has to wait.
- **A numeric column opens on its highest figure, and the unmeasured sit after the measured either
  way.** On the owned-repositories card every nullable column carries `measuredFirst`, a sorting
  function that folds the direction in — TanStack multiplies a sorting function's answer by minus one
  for a descending sort, so "after" has to be said as "before" there. The health column alone sets
  `sortDescFirst: false`: the card opens worst first, and the first click on the heading has to turn
  that around rather than switch the sorting off, which is what the numeric default would do from an
  ascending start.
- **The Averages cards compare against the average the backend sent, never one the browser worked
  out.** `GetContributorTrendResponse.fleet` is `contributorFleetRatesOf(windowRows, days)`, built on
  the very `fleetReferenceOf` the headline score reads, so the team column on the card and the
  sentence behind a score component are one figure printed twice; the two rows the score never
  reads, pull requests opened and pipeline runs, are the only means computed there. A mean taken
  over nobody is `null` on the card where the score's reference folds it to zero, because the card
  has to tell "nobody has WakaTime linked" from "the team never opens an editor".
  `GetRepositoryTrendResponse.fleet` is `repositoryFleetRatesOf` over `ListRepositorySummaries.run`
  for the same window — the table's own rows, archived ones left out — and is `null` when the
  command was built without that reader. The plugin wires that reader **without the catalog**:
  the mean never reads an owner's name, and resolving every distinct owner's profile would be
  the one part of the tab's read a detail page does not already pay for. The rest is the same
  database read the repositories tab performs on every load, and a per-window cache was rejected
  because every read here serves from the database so that a link or an exclusion shows on the
  next request. The client reads an absent `fleet` from an older backend as
  `null`, and both cards then print the figures alone and say no average was sent. The delta is
  `rateDeltaOf`: a signed share of the average, `null` against zero or nothing, and said in words —
  "25% above the team" — so no reader has to remember which way a minus sign points.
- **A native `select` with a label needs `InputLabelProps={{ shrink: true }}`.** It always renders
  whichever option is current, so Material UI reading its empty value as an empty field draws the
  label straight across the option text — which is what put "Source" on top of "All sources" on the
  Identities toolbar. Every `TextField select` with `SelectProps={{ native: true }}` and a `label`
  carries the shrink.
- **Only an e-mail match links automatically.** It is the same rule the catalog itself uses to
  decide who a `User` is. Everything weaker — a shared local part, an identical display name, a
  username resembling a name — is *offered* as a ranked suggestion and applied only when a person
  confirms it, because two people who share a surname would silently become one contributor and a
  merge nobody asked for is far harder to notice than a row that stayed separate. A manual link is
  never overwritten by the automatic rule; the store enforces that rather than trusting callers,
  since reconciliation runs on every ingestion pass.
- **Integration columns are gated on configuration, not on data.** `/v1/capabilities` reports which
  integrations the backend was configured with, and each column group is a *factory* the table calls
  only when its flag is set. Inferring it from whether a row carries a value cannot tell a
  switched-off integration from one that is on and has not collected yet, and it makes a freshly
  configured install look broken until the first nightly pass. The one exception is the WakaTime AI
  column group, which is gated on the data as well — opting out of the AI figures is a supported way
  to run WakaTime, and a screen of em dashes reads as a fault rather than a choice.
- **WakaTime members hang off a dashboard, not off the organisation.** There is no
  `/orgs/{org}/members`; the path is `/users/current/orgs/{org}/dashboards` → `/members` →
  `/members/{memberId}/summaries`, and members are addressed by their **member id** rather than
  their username. Getting that wrong returns empty summaries for everybody rather than failing.
- **WakaTime is stored a day at a time; the whole window is re-read every run.** `summaries` answers
  for an arbitrary span in one request per member, so asking for thirty days costs exactly what
  asking for one costs — and re-reading repairs a day collected while somebody's editor was offline.
  The AI figures come from `durations`, which takes a single date, so they cost one request per
  member per day, are opt-in, and catch up a few days per run. AI history therefore accumulates
  forwards rather than being backfilled, and a chart of it starting in the middle is the design.
- **A repository's coding time is derived on read, never stored on the snapshot.** WakaTime measures
  a person and a *project*; the time a repository received is the sum of what its people logged
  against the matching project, which is a question about a window rather than about the day the
  snapshot was taken.
- **Jira is stored per day, Confluence per window.** Jira's enricher fetches the window's issues
  once and slices them arithmetically, so a per-day breakdown costs nothing. Confluence's written
  volume walks a page's version bodies, so slicing it per day would multiply the walks by the length
  of the window — its figures describe a trailing window, and the columns say so rather than leaving
  a reader to assume.
- **Sonar, compliance and badge history cannot be backfilled.** No provider reports what they looked
  like last March, and the `sonarqube` plugin exposes no measures-history passthrough. Those series
  begin at the first snapshot after installation, and the UI has to say so.
- **Merged work is credited to whoever did it, never to whoever merged it.** Both providers stamp
  the merger on everything a merge produces — the squash commit Azure DevOps authors as whoever
  pressed *Complete*, the merge commit GitHub authors as the merger and loads with the whole pull
  request's diff, the post-merge pipeline run both report as requested by the merger. Read at face
  value, the person who completes most pull requests looks like the author of everything.
  `attributeMergedWork` is the single place the correction lives, and both collectors feed it:
  a squash commit goes to the pull request's author; a merge commit is dropped, whether a pull
  request produced it or a `git merge` did, because its diff is the sum of the commits it joins; a
  rebase is left alone; a build follows the commit it built. These figures are read as a measure
  of people, so a collector that stores what the provider stamped is a bug, not a simplification.
- **The commits a merge commit brought in are fetched from the pull request.** They keep the dates
  they were written on, so the branch history for the day of the merge never returns them, and the
  day they were written was fetched before they were on the branch. Dropping the merge commit
  without this would make the work vanish from everybody's row. They are stored under their own
  dates and deduplicated by identifier against the history; a squash or a rebase needs none of it.
- **Azure DevOps reports no parent count on any list endpoint**, so a commit no pull request names
  is recognised as a merge commit by its message — only the forms git writes itself. Its own
  `Merged PR 123:` subject is written on squash commits too and proves nothing; the pull request's
  `completionOptions` decides, with no options meaning the plain merge Azure DevOps performs by
  default, and an unrecognised strategy keeping the stamp rather than guessing.
- **A review is a vote on somebody else's pull request.** The author's own vote is not one, and an
  Azure DevOps reviewer who was added and never voted did not review anything.
- **The pipeline success rate divides by the runs that reached a verdict.** A run cancelled because
  a newer push superseded it, or skipped by a path filter, is neither a success nor a failure, and
  under a workflow that cancels in-progress runs it would otherwise be most of the denominator.
- **Sonar on a contributor row sums over the repositories the person committed to or merged into.**
  Sonar measures a project; reviewing or building in a repository does not put a hand on its code,
  and counting either put every repository's bugs on the row of whoever reviews the most — which is
  usually the person who also merges the most. Every Sonar heading on the table says so.
- **Upgrading re-walks the history, once.** The rows stored before the attribution fix are wrong in
  exactly the way it corrects and cannot be repaired in place, because the facts it needs were never
  stored. The migration resets every *tracked* repository's cursors and removes what the walk
  re-collects; releases and tags stay, and a repository that left the catalog keeps its history
  because nothing would ever put it back.
- **A score is never drawn without its components.** A bare `62` on a person's row is an accusation
  with no evidence, and a bare `71` on a repository's is a figure nobody can act on. Every score
  carries what was measured, the share of the total it held and the sentence explaining how it was
  read, and `ScoreCard` renders them beside the number rather than behind it. A view that shows only
  `score.value` is a bug, not a compact rendering.
- **Output is a rate against the fleet's *mean* rate; reliability and quality are absolute.**
  Commits, merged pull requests, churn and reviews are divided by the days the window spans and read
  against the mean rate across the people the component could be measured on, with twice that mean
  scoring full marks — so a quiet month for the whole team is a quiet month rather than everybody's
  failure, and there is no invented "forty commits is a good month" to argue with.

  **The mean, not the maximum.** Against the top figure one person having an extraordinary month
  pushed every colleague down for reasons that had nothing to do with them, and a single automation
  nobody had excluded yet could flatten a whole team at once. Against the mean, keeping pace scores
  half, doubling it scores full, and an outlier moves the reference by its share of the headcount
  rather than setting it outright.

  **A rate, not a total**, so every figure means the same thing whatever range was picked. The
  division cancels out of the ratio, so the score is the same number either way; what it buys is the
  wording and the Averages card, not a different result. It does **not** correct for tenure or
  absence and must never be described as though it did: everybody is divided by the same window, so
  somebody who joined halfway through it scores half of a colleague who worked at the same pace
  throughout. Only a per-person active-day denominator would remove that, and it was weighed and
  rejected — one day worked and two commits made would read as twice as productive as a steady
  month.
  `FleetReference` therefore carries the window's `days` alongside the rates, because a rate
  separated from its period is a number nobody can check. The mean skips rows the component was
  never measured on rather than counting them as zeros: a maximum ignores a wrong zero, a mean is
  moved by every one of them. A pipeline success rate and a
  quality gate mean the same thing whoever else is on the team, so those are read against
  themselves. Churn is only ever compared inside its own unit — `churnUnit` decides which reference
  a row is measured against, and a lines figure is never held up against a files figure.

  **A bucket's fleet is the window's people.** On a person's trend every bucket is read against the
  mean in that bucket, but the mean is taken over everybody the whole window measured, with a zero
  row for anyone quiet in the bucket — the same zero row the person the page is about is given for
  a bucket they were absent from. Taken over the active only, each bucket's mean sits above the
  headline's and the "Score over time" line sits under the number it claims to be. A zero row keeps
  churn and every integration null, so it is a measured nothing for commits, pull requests and
  reviews and stays out of every mean nothing was recorded for.
- **A window's last day is the day before `to` when `to` is midnight.** The events query is
  half-open on instants, but snapshots and the per-day WakaTime and Jira rows are read by inclusive
  day, and a calendar month resolves to a `to` at the first instant of the next month. Converting
  that with `toDay` read the first of October into September — one snapshot and one day of measures
  the window never covered — in the tables, on both detail pages and in the last bucket alike.
  `lastDayOf` in `day.ts` is the one conversion every read uses, and `bucketsInWindow` uses it too.
- **The productivity score follows the same integration rule its columns do.** Coding time, tickets
  resolved and documentation written join it on the same relative terms as output, and how much of
  somebody's resolved work stayed resolved joins it as an absolute; each exists only where its
  integration is *configured*, which `computeProductivityScore` is told through
  `IntegrationCapabilities` rather than reading off whether a row carries a value. The weights in
  `PRODUCTIVITY_COMPONENTS` are therefore **nominal** — 1.40 with everything on — and
  `productivityComponentsFor` renormalises them over the enabled set, so commits carry 0.2/1.4 on a
  full install and exactly 0.2 on one with nothing configured. Every sentence that names the
  components or their shares is built from that function, because a heading with "commits 20%" typed
  into it would be wrong on most installs and wrong in a way nobody would notice. Unmeasured is
  still distinct from absent: an account nobody has linked says so by name ("no Jira account is
  linked to this person"), which is the one cause of a missing figure somebody can go and fix.
  Documentation written is the exception to "in the same window": Confluence is stored per window,
  not per day, so that component's detail names Confluence's trailing window rather than the range
  picked, and the per-bucket scores on a person's page are folded with Confluence switched off —
  otherwise the "Score over time" line would sit permanently below the headline it claims to be.
- **What was not measured is left out, never scored as zero.** A repository with no Sonar project
  has an unknown quality gate, not a failing one; somebody whose pipeline never ran has no success
  rate, not a bad one. `combineScore` drops an unmeasured component and shares its weight among the
  rest, and `evidence` reports how much of the total survived — which is what stops a score resting
  on one component passing for one resting on all of them. Defaulting a missing figure to zero would
  turn "we do not know" into "they did badly", on rows people are evaluated by.
- **Only a configured administrator whom the permission framework also allows may reset the
  ingestion.** `codeHealth.administrators` is empty by default, so a fresh install is read-only for
  everybody, and `code-health.ingestion.reset` (from `@backstage/plugin-permission-common`,
  registered by the backend and exported from its package) can be denied by a policy or the RBAC
  plugin on top of that. Both must allow: the configuration is where the plugin names its
  administrators, the permission framework is where an organisation states a rule about them, and
  neither stands in for the other. The frontend asks `/v1/access` before drawing the control, but
  the route authorises again on every request — a button the browser did not draw is not an access
  control.
- **An owner is shown as a person or a team, not as a slug.** `spec.owner` is a reference, and a
  directory that names its users after their address turns the repositories table's owner column
  into a page of `e.silva_example.com`. The owning entity's `spec.profile` — which `Group` entities
  carry as well as `User` ones — is resolved on *read* by `getEntityProfiles`, bounded by the
  *distinct* owners of the tracked set rather than by the rows, so two hundred repositories sharing
  a handful of teams cost one small query per dashboard load. Resolved on read rather than stored by
  discovery, because a name and a photograph change in the directory without anything in the
  repository's YAML moving. The slug stays as the fallback and the column sorts and filters on
  whichever name is actually rendered — a column that filters on a hidden string is one whose
  results nobody can predict.
- **A detail page offers calendar months, through the tables' own resolver.** Somebody who has just
  read "September" on the Contributors tab and clicked into a person has to be able to ask the same
  question about them. `trendWindowOf` delegates a month to `toWindow`, so one month cannot resolve
  to two different windows depending on which screen it was picked from.
- **Ownership comes from `spec.owner`, with group ancestry.** Discovery stores the entity's owner on
  the repository row (`owner_ref`, normalised the way the catalog normalises it, so a bare `team-a`
  and `group:default/team-a` match), and a person owns a repository when its owner is their `User`
  entity or a group they belong to, parents included — `memberOf` then `childOf`. That is how
  Backstage decides ownership everywhere else, and inventing a second answer would make the plugin
  disagree with the catalog page next to it. An account nobody has linked owns nothing, because
  ownership is a fact about the catalog and an unlinked account has no entity there.
- **The person key travels in the query string, the repository id in the path.** A person key is
  `user:default/jane` for somebody linked and `vcs:jane@acme.com` for an account nobody has, and
  both carry characters a path segment has to encode. React Router decodes a segment *before* it
  matches, so an encoded slash splits the key into two segments and the route stops matching
  entirely — the page then 404s for exactly the people who have been linked properly. A query value
  survives the round trip intact.
- **Insights keeps only what is about the fleet; the rankings moved to their tables.** At a glance,
  delivery cadence and fleet test coverage stay, with a section per configured integration. Top
  contributors, review load and most active repositories now sit above the contributors table, and
  documentation, catalog APIs and fleet health above the repositories table. A ranking is a way
  *into* a row, so a tab away from the rows it ranks made a reader carry a name across the screen by
  hand; the entries now link to the plugin's own detail pages. **Every optional integration is split
  on the same line**, into a fleet part, a people part and a repository part: WakaTime's hours by
  person and by repository, Jira's two rankings of people and its three views of a backlog, and
  Confluence's authors and its documentation rot all leave Insights for the tab that lists the rows
  they name, while the KPI cards stay. Each part is still gated on `capabilities.<integration>`
  alone, and each carries its own empty and not-measured wording — the Jira notice in particular is
  written three times rather than once, because a reader on the Contributors tab should not have to
  open Insights to learn that no entity carries a `jira/project-key` annotation.

## Conventions

- **snake_case** for all file names
- **No `any`** — use `unknown` with type narrowing
- **BDD tests** with `// given`, `// when`, `// then` blocks
- **No mock libraries.** Hand-rolled doubles in `test/doubles/`, builders in `test/builders/`
- Material UI **v4** (`@material-ui/core`), matching `@backstage/core-components`
- React **18**, matching the Backstage peer ranges

## Testing

Coverage thresholds are enforced repo-wide in the root `package.json` at 95% lines/statements, 92%
functions and 88% branches. `backstage-cli repo test` splits the root `jest` block: keys Jest accepts
per project (`collectCoverageFrom`, `roots`) are forwarded to every package and then overridden by
that package's own block; the rest (`coverageThreshold`, `coverageReporters`) stay global. Per-package
exclusions therefore live in each `package.json`, because their paths resolve against `<package>/src`.

Where the interesting tests live:

- **The store** runs against a real database via `TestDatabases`, with the real migrations applied.
- **Collectors and the gateway** run against a real `http.createServer`, so the query strings they
  build are parsed by an actual HTTP stack.
- **The plugin** runs through `startTestBackend` with `supertest`.

Ingestion is held to a **manual trigger** in the plugin tests. Left on a schedule it would start
immediately under `startTestBackend` and issue real requests to `api.github.com`.

Do not add a `collectCoverageFrom` exclusion to make a threshold pass; write the test instead.

### Jobs that skip on purpose

- `code-check > quality:basic-checks` is gated on `github.event_name == 'pull_request'`, so it never
  runs on a push to `main`. On a pull request it does run, and it fails unless the branch is rebased
  on `main` **and** the branch added a changelog fragment under `.changes/unreleased/`. On a
  `bump/*` branch the same check flips and demands an updated `CHANGELOG.md` instead.
- `management > report:sonarqube` is gated on a non-empty `sonar_host` input, which
  `.github/workflows/default.yaml` does not pass. The repository forwards `SONAR_TOKEN` but has no
  SonarCloud project, so enabling the input would turn a skip into a failure.

`tests > test:all` also emits a warning annotation about a missing `vite.config.ts`. That comes from
`davelosert/vitest-coverage-report-action` in the shared workflow, which hardcodes the path; the
action still reads the Jest `coverage-summary.json` correctly and the job passes. Do not add a
`vite.config.ts` to silence it — this project has no Vite in its toolchain.

### `install_run_scripts: true`

The shared workflow installs with `yarn install --immutable --mode=skip-build`, so no dependency's
lifecycle script runs as the CI user. This repository has to opt back in, because the store tests
open a real SQLite database through `TestDatabases` and `better-sqlite3` is a native addon: its
install script is what produces `build/Release/better_sqlite3.node`. Without the flag every
`KnexCodeHealthStore` test fails with "Could not locate the bindings file", listing the paths it
tried — which is the signature to recognise, since nothing in the message names the install mode.

The flag does not restore lifecycle scripts during resolution. It appends `yarn rebuild` after the
install, so build scripts run only once the lockfile CI already refused to modify is in place.

Reproduce it locally with `rm node_modules/better-sqlite3/build/Release/better_sqlite3.node` followed
by `yarn install --immutable --mode=skip-build`; `yarn rebuild` puts it back.

This arrived without a commit here: the shared workflow is referenced at `@main`, and the change
landed upstream on 2026-08-18 in `rios0rios0/pipelines@fd67e75`. A green `main` can therefore go red
with nothing in this repository having moved.

### `trivy.yaml`

Trivy's misconfiguration walk skips `node_modules`. A devDependency chain
(`@backstage/backend-test-utils` → `testcontainers` → `dockerode` → `ssh2` → `cpu-features`) vendors
a C library whose own CI `Dockerfile`s would otherwise be scanned as though this repository wrote
them. Scoping the walk keeps those checks armed for a `Dockerfile` this repository might genuinely
add later, which suppressing the findings by id would not.

## Release

CI runs `rios0rios0/pipelines/.github/workflows/yarn-library.yaml` on every push and pull request.
There is no deployment target — the artifacts are three npm packages.

Releasing is [AutoBump](https://github.com/rios0rios0/autobump)'s job: `autobump .` reads
`[Unreleased]`, derives the version, moves the entries under a dated heading, writes that version to
all four `package.json` files, regenerates `yarn.lock`, branches `chore/bump-x.x.x`, and opens the PR.

**Requires AutoBump 3.0.3 or newer** — the first release carrying project-layer refresh
(rios0rios0/autobump#348, merged 2026-09-03). `refresh: true` lives in this repository's
`.autobump.yaml`, under `languages.typescript`, beside the pattern that makes it necessary, and
nothing has to be set in your own `~/.autobump.yaml`. On anything older a project file's
`refresh: true` is warned about and dropped, and the release comes out with the stale lockfile
described below.

That is a change from 3.0.0, where `refresh` was read from a project's own file only when it was
`false` and an enable had to come from your `~/.autobump.yaml`. Releases 2.3.0, 3.0.0 and 4.0.0 all
predate the change and each needed the lockfile repaired by hand.

**If you still carry a `refresh_commands` block in `~/.autobump.yaml`, delete it.** The operator's
configuration is decoded strictly and recognises the removed key by name — leaving it there does not
degrade the release, it aborts every one, with a message naming the replacement. A *project* file,
by contrast, is lenient: an unknown key there is ignored.

1. No `-c` is needed any more. AutoBump reads the operator's configuration from `$HOME` only; the
   working directory is not searched, so this file can no longer be mistaken for it. It is the last
   of four configuration layers and is merged on top of the operator's rather than replacing it.
   Note what that does *not* imply: being last, this file would win an ordering contest, so the
   operator's veto is not an ordering rule. AutoBump records an explicit `refresh: false` in the
   operator's own configuration as a refusal that no later layer may overturn — see
   `rios0rios0/autobump#348`. Writing nothing is not a refusal, which is why the `true` set here
   works by default.
2. `.autobump.yaml` exists because AutoBump's TypeScript defaults know one version file. Here that is
   the private workspace root, which is never published, so `plugins/*/package.json` is appended.
   Without it a release ships three packages still claiming the previous version, and
   `delivery-publish`'s tag-versus-`package.json` guard fails all three.
3. That file's **second** pattern moves the caret range the frontend and the backend declare on
   `-common`, and moving it desynchronises `yarn.lock` — see the section below. The version bumps
   themselves are lockfile-neutral, because Yarn records a workspace as `0.0.0-use.local` and never
   writes its version into the lockfile at all.
4. The bump level comes from the changelog itself: a line **beginning** `- **BREAKING CHANGE:**` is
   major, `### Added` is minor, everything else patch. A breaking change explained mid-sentence
   counts for nothing — this is why the `2.0.0` entries lead with the marker.
5. The merge commit must keep `chore/bump-x.x.x` or `chore(bump): ...version to x.x.x` — that string
   is what the pipeline matches on.
6. On merge, `delivery-release` (from the shared workflow) cuts the tag and GitHub Release, and
   `delivery-publish` (in `.github/workflows/default.yaml`) publishes each package to npm.

### The lockfile the bump desynchronises

The frontend and the backend declare a caret range on `-common`, and `.autobump.yaml` moves it on
every release so the three published packages install as a matched set. That exact string is also a
**resolution descriptor** in `yarn.lock` (the selector for the workspace package):

    "@rios0rios0/backstage-plugin-code-health-common@npm:^X.Y.Z, @rios0rios0/backstage-plugin-code-health-common@workspace:plugins/code-health-common":

AutoBump rewrites version files with regular expressions, and without a refresh it does not run a
package manager, so the lockfile is left behind. Every CI job then starts with
`yarn install --immutable`, which refuses:

```
YN0028: The lockfile would have been modified by this install, which is explicitly forbidden.
```

The whole gate goes red, and so would `delivery-publish` after a merge — the release is blocked, not
merely noisy. `2.3.0`, `3.0.0` and `4.0.0` each hit it: `3.0.0` was repaired by a follow-up
commit on the bump branch (`96149eb`); `4.0.0` is **#99, still open**, with the stale `yarn.lock`
not yet regenerated. This change only stops the next occurrence — #99 is outstanding work.

**The fix is `refresh: true` under `languages.typescript` in this repository's `.autobump.yaml`**,
which regenerates `yarn.lock` inside the bump commit:

```yaml
languages:
  typescript:
    refresh: true
```

It is set there rather than in the operator's file because the staleness is a fact about this
workspace's build — caused by the second `version_files` pattern three lines below it — not a
preference of whoever happens to be releasing. Anyone who releases this repository gets it.

AutoBump owns the command: it detects Yarn from `packageManager` in `package.json` and runs
`yarn install --mode=update-lockfile`, which skips the link step entirely, so no package lifecycle
script runs. It also passes `YARN_IGNORE_PATH=1`, because Yarn's launcher would otherwise exec
whatever `yarnPath` in a repository's own `.yarnrc.yml` names.

**It is turned on from this repository's `.autobump.yaml`, and that took two changes to AutoBump.**
The key used to be `refresh_commands` and it carried the argv — an executable run with the release
credentials — so AutoBump could not honour one from a repository it had merely discovered.
`rios0rios0/autobump#338` replaced the argv with a flag and built-in recipes, which closed half of
that: what runs is now a compile-time constant. The other half was *whether* anything runs at all,
and that stayed with the operator — a project file could write `refresh: false` to switch the
refresh **off**, never on.

`rios0rios0/autobump#348` closed the second half by distinguishing *which* restricted layer is
speaking rather than treating all three as one population. The defaults AutoBump fetches over the
network still cannot turn a refresh on; a repository's own committed, reviewed file can, because a
stale lockfile is a fact about that repository's build and the repository is the party that knows
it. The argv stays AutoBump's either way, so the flag says only whether the command runs.

So the setting lives here, beside the `version_files` pattern that makes it necessary, and holds for
everyone who releases this repository rather than only for whoever remembered to configure it. You
keep the veto, though not by ordering — this file is the later layer. AutoBump records an explicit
`refresh: false` in your own configuration as a refusal that no later layer may overturn, so it
holds against the `true` set here. Writing nothing is not a refusal, which is what lets the setting
here work without any action from you.

On an AutoBump that predates `rios0rios0/autobump#348`, or if the refresh is ever turned off, the
lockfile has to be regenerated by hand after AutoBump has opened the PR and checked you back out to
`main`:

```bash
git fetch origin && git checkout chore/bump-X.Y.Z
yarn install --mode=update-lockfile
git add yarn.lock && git commit --amend --no-edit
git push --force-with-lease
```

`--mode=update-lockfile` resolves without linking, and `^X.Y.Z` resolves against the local workspace,
so it does not go looking for a version that is not on npm yet. It is the same command AutoBump runs.

`delivery-publish` is repo-local because publishing to a registry is not part of any of the shared
`*-library.yaml` workflows. It runs as a matrix over the three package directories, only after the
quality gate passes, publishes with `npm publish --provenance` so each tarball is attested to the
workflow run, and no-ops when a version is already on the registry — which is what makes the
tag-push recovery path safe to re-run.

A tag push runs the workflow file **as it exists at that tag**, not the one on `main`. A tag cut
before a change to `.github/workflows/default.yaml` therefore keeps running the old job forever, and
re-pushing it cannot pick the change up. That is why `1.0.0` — cut before OIDC landed, when the job
still read a non-existent `NPM_TOKEN` — was published from a second tag, `v1.0.0`, placed on the
commit that carried the new workflow; the version guard accepts it because it compares `${TAG#v}`
against `package.json`. Both tags are kept: the provenance attestation references `refs/tags/v1.0.0`,
so deleting it would leave the attestation pointing at a ref that no longer exists.

### Authentication — trusted publishing (OIDC)

**There is no `NPM_TOKEN` secret, and there must not be one.** The job authenticates with npm
through OIDC trusted publishing: GitHub mints a short-lived id-token for the run, npm exchanges it
for a credential scoped to this repository and this workflow file, and nothing long-lived is ever
stored. This is not merely preferable, it is the only automated path with a future — npm revoked all
classic tokens in December 2025, capped write-scoped granular tokens at 90 days, and 2FA-bypass
tokens (the only kind usable unattended) lose the ability to publish around January 2027.

**Each package name needs its own trust entry, and the package has to exist before you can create
one.** The endpoint is package-scoped — `POST /-/package/<name>/trust` — so a name npm has never seen
returns `E404`, whatever the credentials. npm has no pending-publisher concept the way PyPI does.
That makes the first publish of a new name a chicken-and-egg problem: CI cannot publish it without a
trust entry, and the trust entry cannot exist without the package. It is broken by publishing once by
hand, then creating the entry, after which every later release comes from CI.

`1.0.1` recorded the opposite ("a package does not need to exist first"). That was wrong, and cost a
release cycle when `-backend` and `-common` both returned `E404` on `2.0.0`.

```bash
npm login                                                  # 2FA, 2-hour session
npm trust github @rios0rios0/backstage-plugin-code-health \
  --file default.yaml \
  --repo rios0rios0/backstage-plugin-code-health \
  --allow-publish
npm trust github @rios0rios0/backstage-plugin-code-health-backend \
  --file default.yaml --repo rios0rios0/backstage-plugin-code-health --allow-publish
npm trust github @rios0rios0/backstage-plugin-code-health-common \
  --file default.yaml --repo rios0rios0/backstage-plugin-code-health --allow-publish
npm trust list @rios0rios0/backstage-plugin-code-health    # verify
```

The workflow is named with `--file`, not `--workflow`, and `--allow-publish` has to be passed or the
entry is created without the permission CI needs. Both `npm trust` and the OIDC exchange require npm
11.5.1 or newer — check `npm --version` before blaming the trust entry, because a version manager's
default npm is easily older than the system one and reports `npm trust` as an unknown command.

The bootstrap publish must drop `--provenance`. Provenance is only generated inside supported CI, so
that flag fails on a workstation; the one hand-published version is therefore unattested, and that is
the price of creating the name. Keep it off the release: publish a throwaway version under a
non-`latest` dist-tag, create the trust entry, let CI publish the real one with provenance, then
deprecate the throwaway. Publishing the release itself by hand would leave the version everybody
installs as the only unattested one there is.

Publishing must be pinned to the `rios0rios0/backstage-plugin-code-health` repository and the
`default.yaml` workflow filename. Both halves of that pin are load-bearing: renaming the workflow
file breaks publishing, and so does renaming the repository, because the OIDC token's `repository`
claim is matched against a stored string that no rename updates. `npm trust` has no update verb —
only `github` to create, `list` and `revoke --id` — so a rename is handled by adding an entry for the
new name and revoking the old one. That is what the `code-health` → `backstage-plugin-code-health`
rename required.

For a stricter posture, a trust relationship can be made **stage-only**: CI then runs
`npm stage publish`, the version is held privately, and a maintainer releases it with
`npm stage approve <stage-id>` under 2FA. That trades the hands-off release for a human checkpoint;
the current setup publishes directly.

<!-- chlog:start -->
## Changelog (chlog) — MANDATORY

If the repository you are working in uses chlog (a `.chlog.yaml` or `.chlog.yml`
config file, or a `.changes/` directory, exists at the project root), the
following is binding and ALWAYS applies: whenever you make ANY change, you MUST
create a changelog fragment as part of the same change — automatically, without
being asked, before committing.

- Do NOT edit CHANGELOG.md directly; it is generated from fragments.
- Create the fragment with:
  `chlog new --kind <Kind> --body '<past-tense description>'`
- Write an apostrophe inside the single-quoted body as `'\''`.
- Valid kinds: Added, Changed, Deprecated, Removed, Fixed, Security
- Choose the kind that best matches the change (e.g., new feature → Added,
  bug fix → Fixed, behavior change → Changed, removal → Removed, security fix → Security).
- If the change is backward-INCOMPATIBLE with the public API (a breaking
  change), you MUST add the `--breaking` flag:
  `chlog new --kind <Kind> --breaking --body '<past-tense description>'`.
  This is the ONLY thing that triggers a major version bump — the kind alone
  never does (per SemVer, major = incompatible change). When unsure whether a
  change breaks compatibility, ask the user instead of guessing.
- Fragments are YAML files in `.changes/unreleased/`; stage them with your commit.
- `chlog check` fails the build when a fragment is missing — never skip it.
<!-- chlog:end -->
