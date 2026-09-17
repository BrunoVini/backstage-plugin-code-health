# Code Health — AI assistant instructions

## What this repository is

A Yarn workspaces monorepo holding the three packages of the Code Health Backstage plugin:

| Package | Directory | Backstage role |
|---|---|---|
| `@rios0rios0/backstage-plugin-code-health` | `plugins/code-health` | `frontend-plugin` |
| `@rios0rios0/backstage-plugin-code-health-backend` | `plugins/code-health-backend` | `backend-plugin` |
| `@rios0rios0/backstage-plugin-code-health-common` | `plugins/code-health-common` | `common-library` |

The backend discovers repositories from the Backstage catalog, authenticates through the host
application's `integrations` configuration, ingests a year of history in a rate-limited background
job, and stores it in the Backstage database. The browser talks only to `/api/code-health` and holds
no credential.

Four optional integrations enrich that history and are absent unless configured: **Sonar** (through
the community backend plugin), **WakaTime** (coding time and AI token counts), and **Jira** and
**Confluence** (one Atlassian credential lights up both). Each identifies people under its own
account system, which is why a contributor row is a *person* rather than an account and why the
**Identities** tab exists. `PersonDirectory` resolves accounts to people through a link table on
*read*, so correcting a link is retroactive across every window ever collected. It answers the
second question that tab decides too — whether a person is measured at all — from an exclusion
table read the same way.

All three packages share one version and are bumped together.

## Bootstrap

```bash
corepack enable
yarn install
```

## Commands and expected timings

| Command | What it does | Roughly |
|---|---|---|
| `yarn typecheck` | One `tsc` pass over the whole workspace | 25 s |
| `make lint` | ESLint plus knip across all packages | 45 s |
| `make test` | Jest across all packages (~600 tests) | 45 s |
| `yarn build` | `tsc` then `backstage-cli repo build --all` | 45 s |
| `make sast` | CodeQL, Semgrep, Trivy, Hadolint, Gitleaks | 2-4 min |

**NEVER run `jest`, `eslint`, `gitleaks`, `semgrep`, `trivy`, `hadolint` or `codeql` directly.** Use
the `make` targets, which load the correct configuration from the
[rios0rios0/pipelines](https://github.com/rios0rios0/pipelines) scripts first.

The root scripts use `backstage-cli repo lint | test | build` rather than the per-package commands,
because `repo test --coverage` writes the merged `coverage/` and `junit-report.xml` at the repository
root where the shared pipeline reads them.

## Architecture

The backend is hexagonal: `domain/` holds entities, commands and ports, `infrastructure/` holds the
implementations, and the dependency arrow points inward. The frontend follows the same rule across
its five layers.

```
plugins/code-health-backend/src/
  domain/entities|commands|repositories|services/
  infrastructure/repositories|services|http|controllers/
  infrastructure/services/collectors/                 Azure DevOps and GitHub
  infrastructure/services/atlassian/                  one client, the Jira and Confluence enrichers
  infrastructure/services/wakatime_enricher.ts
  plugin.ts

plugins/code-health/src/
  domain/ service/ infrastructure/ presentation/ main/
```

The whole read API lives under `/api/code-health/v1`:

```
GET  /repositories  /contributors  /timeseries  /coverage  /capabilities  /identities
GET  /identities/users?q=         (the link picker's directory search)
PUT  /identities/links            DELETE /identities/links/:source/:key
PUT  /identities/exclusions       DELETE /identities/exclusions/:source/:key
GET  /contributors/:key/trend     GET /contributors/:key/repositories
GET  /repositories/:id/trend
GET  /access                      POST /ingestion/reset        POST /refresh
```

New files behind the trends, ownership and administration work:

| Package | Files |
|---|---|
| `-common` | `score.ts`, `productivity_score.ts`, `repository_health_score.ts`, `trend.ts`, `ownership.ts`, `identity_exclusion.ts`, `fleet_rates.ts`, `repository_rates.ts`; `searchDirectoryUsers` in `identity.ts` |
| `-backend` | `domain/commands/get_contributor_trend.ts`, `get_repository_trend.ts`, `list_owned_repositories.ts`, `list_directory_users.ts`, `reset_ingestion.ts`, `authorize_administrator.ts`, `exclude_identity.ts`; `domain/entities/permissions.ts`, `bucket.ts`, `contributor_aggregation.ts`, `repository_summary_builder.ts`; `migrations/20260910000000_owner.js`, `migrations/20260915000000_identity_exclusions.js` |
| frontend | `presentation/pages/contributor_detail_page.tsx`, `repository_detail_page.tsx`; `components/charts/trend_chart.tsx`, `components/score_card.tsx`, `components/trend_range_picker.tsx`, `components/owned_repositories_card.tsx`, `components/ingestion_reset_button.tsx`, `components/contributor_rates_card.tsx`, `components/repository_rates_card.tsx`, `components/rate_comparison.tsx`, `components/data_table.tsx`; `components/identity_exclusion_cell.tsx`, `components/identity_link_cell.tsx`; `hooks/use_trend_window.ts`, `hooks/use_contributor_trend.ts`, `hooks/use_owned_repositories.ts`, `hooks/use_repository_trend.ts`, `hooks/use_access.ts`, `hooks/use_directory_search.ts`; `domain/entities/contributor_trend.ts`, `domain/entities/repository_trend.ts`, `domain/entities/reset_reach.ts` |

## Things not to change without understanding why

- **Repositories come from the catalog only.** Nothing is enumerated from a provider API. Listing an
  organisation on every dashboard load is what caused the Azure DevOps throttling this design fixes.
- **Every provider request goes through `ProviderGateway`.** It bounds concurrency and total
  requests, retries with jittered backoff, and breaks the circuit on a failing host. A collector
  that calls `fetch` directly bypasses all of it.
- **Rate-limit headers are read on every response, not only errors.** Azure DevOps throttles by
  adding latency to a successful `200` and sends `Retry-After` before it starts rejecting anything.
- **Two Azure DevOps defaults are set explicitly.** Its pull request API returns only *active*
  requests filtered on *creation* time; its build query applies the window to whichever timestamp
  `queryOrder` names.
- **Branch policies are fetched once per project**, cached for the whole snapshot pass.
- **The latest Azure DevOps tag is chosen by version comparison**, because its refs API returns tags
  alphabetically with no dates.
- **Line churn is null on Azure DevOps**, which reports changed files rather than lines and exposes
  no line count anywhere in its REST API. `ContributorSummary.churnUnit` carries which unit a row
  was measured in, so a view renders the figure it has instead of a zero. Do not infer the unit from
  which number is non-zero: that misreads a real quiet week as a missing measurement.
- **Insights is the landing tab**, at `/`. Contributors is `/contributors`, repositories is
  `/repositories`, and Identities is last at `/identities`. Insights leads because it is the only
  tab that answers a question about the fleet rather than about one row of it; Identities sits last
  because it is maintenance, not a measurement. Insights keeps at a glance, delivery cadence and
  fleet test coverage plus a section per integration; the rankings live above the table they rank —
  top contributors, review load and most active repositories on Contributors, documentation,
  catalog APIs and fleet health on Repositories — and their rows link to the detail pages.
- **A detail page is `/contributors/person?key=<person key>` and `/repositories/:id`.** The person
  key is in the **query string** on purpose: it carries a colon and often a slash, and React Router
  decodes a path segment before matching it, so an encoded slash splits the key in two and the
  route never matches. Both pages offer 1-6 months (`TREND_MONTHS`), bucketed by `trendBucketFor` —
  day up to 45 days, week beyond — and bounded by what the backfill has collected.
- **A score is never rendered without its components.** `combineScore` drops anything unmeasured and
  shares its weight among the rest, and `evidence` says how much survived. Never default a missing
  figure to zero: "we do not know" and "they did badly" are different claims, on rows people are
  evaluated by. Productivity reads output (commits 20%, merged PRs 20%, churn 10%, reviews 15%) as a
  **rate against the fleet's mean rate** — each total over the window's days, against the mean
  across the rows the component could be measured on, with `FLEET_RATE_CEILING` (2) times that mean
  scoring full marks — and reliability/quality absolutely (pipeline 15%, gate 10%, coverage 10%);
  churn is only compared inside its own `churnUnit`. The mean, not the maximum: one outlier used to
  flatten a whole team. `fleetReferenceOf(rows, days)` carries the window's days, and the per-bucket
  scores pass that bucket's own length. Where an
  integration is **configured**, it adds components on the same terms — coding time 10%, tickets
  resolved 15% and documentation written 10% relative (the last over Confluence's trailing window,
  never the picked one, and left out of per-bucket scores), tickets that stayed done 5% absolute — and
  `productivityComponentsFor(capabilities)` renormalises every weight over the enabled set, so those
  percentages are nominal (1.40 with all three on, making commits ~14%). Pass
  `IntegrationCapabilities` to `computeProductivityScore`; never infer it from whether a row carries
  a value, and never write a share out by hand — build the sentence from that function. Repository health
  is absolute throughout (gate 15%, coverage 15%, defects 10%, duplication 5%, debt 5%, branch build
  10%, build success 10%, policy 10%, docs 5%, review coverage 10%, PRs landed 5%). The two Sonar
  components on a person describe the repositories they changed, not the code they wrote.
- **Every table pages through `PaginationControls`, and it is always drawn** — repositories,
  contributors, identities and the owned-repositories card — with one shared list of page sizes.
  Hiding it below one page is what made the contributors table look unpaginated.
- **The link picker searches; it does not enumerate.** `useDirectorySearch` asks
  `GET /identities/users?q=` once the typing pauses and for two characters or more; the backend's
  `ListDirectoryUsers` enumerates the directory per query and filters it with `searchDirectoryUsers`
  (every word, any order, name or address or entity name), answering an empty query with nobody.
  The Link button enables only for a picked user or text that parses as a `user` reference;
  `LinkIdentity` refuses any other kind and `getUsersByRef` skips any entity that is not a `User`.
  The empty-search wording never claims the whole directory was searched — the read is capped.
- **Both Averages cards compare against the `fleet` the trend response carries**, never against a
  mean the browser computed: `contributorFleetRatesOf` is built on `fleetReferenceOf`, so the card
  and the score say one team average, and `repositoryFleetRatesOf` runs over the repositories
  table's own rows with archived ones left out, wired without the catalog because the mean never
  reads an owner's name. A mean over nobody is `null` on the card, an absent `fleet` from an older
  backend reads as `null`, and `rateDeltaOf` is `null` against zero.
- **A window is named by the last day it covers.** `lastCoveredDayOf` in `-common` and
  `formatWindowSpan` in the frontend end a half-open window that stops at midnight on the day
  before, the same rule the backend's `lastDayOf` reads snapshots by.
- **The owner column shows a name and a photograph, not a slug.** `getEntityProfiles` resolves the
  owning entity's `spec.profile` on read — any kind, since `spec.owner` is usually a `Group` — in one
  query bounded by the *distinct* owners, never one per row. `ownerProfile` is null for an owner the
  catalog no longer holds, and the column falls back to the slug and sorts/filters on whichever name
  is rendered.
- **`useTrendWindow` holds a `TrendSelection`**, a rolling count or a calendar month, and memoises
  everything on `trendSelectionKey` — a fresh window object per render puts the fetching hook in a
  request loop. A month resolves through the tables' `toWindow`, so one month is one window on both
  screens.
- **Ownership is the catalog's `spec.owner`**, stored on the repository row as `owner_ref` by
  discovery and normalised as the catalog normalises it (a bare name is a group in the default
  namespace). A person owns a repository when its owner is their `User` entity or a group they
  belong to, parents included (`memberOf` then `childOf`). An unlinked account owns nothing — the
  Identities tab is where the link is made.
- **An excluded account is measured by nothing.** `code_health_identity_exclusions` holds
  `(source, source_key)` with one of four `ExclusionReason` values, and `PersonDirectory` applies it
  on *read*, keyed by **person** — so excluding one account of a linked human excludes all of them,
  and including it again restores every window already collected. Every read that turns events into
  rows goes through `loadPersonDirectory(store)` and `measuredEvents(events, people)`:
  contributors, both trends, the repositories table and the fleet cadence. Adding a sixth read that
  aggregates events without them is the bug to watch for — it would leave one view measuring a build
  service every other view has dropped. `accumulateContributors` drops an excluded account itself,
  so nothing accumulates for it and it never reaches `fleetReferenceOf`; a zeroed row would still be
  a name on the table and would still set the bar everybody is scored against. A reset keeps the
  exclusions, like the links.
- **`measuredEvents` treats the kinds differently on purpose.** `commit`, `pull_request` and
  `pr_review` measure a *person* and are dropped; `build`, `release` and `tag` measure the
  repository and are **kept with the actor nulled**, so the runs stay in its counters and nobody is
  credited. Dropping them would leave `buildSuccessRate` unmeasured wherever a platform excludes its
  build service, silently redistributing a tenth of the repository health weight fleet-wide.
  `measuredContributorMetrics` applies the same rule to the WakaTime rows in
  `list_repository_summaries.ts` and `get_repository_trend.ts`, which aggregate by project and so
  cannot apply it anywhere else.
- **Only a configured administrator the permission framework also allows may reset the ingestion.**
  `codeHealth.administrators` is empty by default and `code-health.ingestion.reset` can be denied on
  top of it; both must allow, and the route authorises on every request rather than trusting that
  the browser hid the button. A reset discards the stored commits, pull requests, reviews and
  pipeline runs inside the chosen reach and re-walks them; it keeps releases, tags, the daily
  snapshots and every identity link.
- **The documentation and API grades need both halves of the evidence.** The catalog half comes from
  discovery, the repository half from the daily snapshot, so both read `null` — "not measured" —
  until a snapshot exists. Grading on half of it reports gaps that are not there.
- **The repository file scan stays shallow**: the root, `docs/` and `api/`. A recursive walk is
  unbounded on a large repository and costs a different amount on each platform, which would make
  the metric incomparable between them.
- **A day is recorded as fetched only when a window covers it end to end.**
- **Cursors move only after the window is committed.**
- **A contributor row is a person, not an account.** `PersonDirectory` resolves accounts through the
  link table on *read*, never at collection time, so correcting a link is retroactive. An unlinked
  account keeps its own row under `<source>:<sourceKey>` rather than being hidden.
- **Only an e-mail match links an account automatically** — the same rule the catalog uses for a
  `User`. Anything weaker is *offered* as a ranked suggestion and applied only on confirmation, and
  a manual link is never overwritten by the automatic rule (the store enforces this, not the caller).
- **Integration columns are gated on configuration, not on data.** `/v1/capabilities` reports which
  integrations the backend was configured with, and each column group is a factory called only when
  its flag is set. Inferring presence from whether a row carries a value cannot tell a switched-off
  integration from one that is on and has not collected yet. The one exception is the WakaTime AI
  column group, gated on data too, because opting out of the AI figures is a supported way to run it.
- **Jira is stored per day, Confluence per window, WakaTime a day at a time.** Their history is
  re-read each run, and a repository's coding time is derived on read from its people's project time
  rather than stored on the snapshot.
- **Sonar, compliance and badge history cannot be backfilled**; those series start at installation.
- **Merged work is credited to whoever did it, never to whoever merged it.** Both providers stamp
  the merger on the squash commit, the merge commit and the post-merge pipeline run.
  `attributeMergedWork` in `domain/entities/merge_attribution.ts` is the one place the correction
  lives and both collectors feed it: a squash commit goes to the pull request's author, a merge
  commit is dropped (its diff is the sum of the commits it joins) and the pull request's own commits
  are fetched and stored under the dates they were written, a rebase is left alone, and a build
  follows the commit it built. A collector that stores the provider's stamp is a bug.
- **A review is a vote on somebody else's pull request**: the author's own vote and an Azure DevOps
  reviewer who never voted are not reviews. **The pipeline success rate divides by the runs that
  reached a verdict**, never by every run. **Sonar on a contributor row** sums over the repositories
  the person committed to or merged into, not reviewed or built in.
- **The re-attribution migration re-walks tracked history once.** It resets cursors and removes
  what the walk re-collects; releases, tags and repositories that left the catalog stay.
- **The bump desynchronises `yarn.lock`.** `.autobump.yaml` moves the caret range the frontend and
  backend declare on `-common`, and that string is a resolution descriptor in the lockfile, so every
  CI job's `yarn install --immutable` answers `YN0028` until the lockfile is regenerated. The fix is
  `refresh: true` under `languages.typescript` in **this repository's** `.autobump.yaml`, beside the
  pattern that causes the staleness, honoured on its own by AutoBump 3.0.3 or newer (the release
  carrying `rios0rios0/autobump#348`); nothing has to be set in the releaser's own
  `~/.autobump.yaml`. On anything older the project file's `refresh: true` is warned about and
  dropped and the release ships the stale lockfile, repaired by hand afterwards. See
  `CLAUDE.md` > Release.
- **`.github/workflows/default.yaml` passes `install_run_scripts: true`.** The shared workflow
  installs with `--mode=skip-build`, and `better-sqlite3` is a native addon the store tests need.
  Removing the flag fails every `KnexCodeHealthStore` test with "Could not locate the bindings file".

## Conventions

- `snake_case` file names throughout
- No `any` — use `unknown` with narrowing
- BDD tests: `// given`, `// when`, `// then`
- No mock libraries; hand-rolled doubles in `test/doubles/`, builders in `test/builders/`
- Material UI v4 and React 18 in the frontend, matching the Backstage peer ranges

## Testing

Coverage is enforced repo-wide at 95% lines/statements, 92% functions, 88% branches. Write the test
rather than adding an exclusion.

- The store is tested against a real database (`TestDatabases`) with the real migrations applied.
- Collectors and the HTTP gateway are tested against a real `http.createServer`.
- The plugin is tested through `startTestBackend` with `supertest`.
- Ingestion is held to a manual trigger in the plugin tests, so they never reach the network.

## Validation checklist before proposing a change

1. `yarn typecheck`
2. `make lint`
3. `make test`
4. `make sast` when dependencies or configuration changed
5. Add a changelog fragment with `chlog new --kind <Kind> --body '...'` — never edit
   `CHANGELOG.md`, which is generated from them
6. Update `README.md` when behaviour, configuration or setup changed

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
