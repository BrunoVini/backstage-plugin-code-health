<h1 align="center">backstage-plugin-code-health</h1>
<p align="center">
    <a href="https://github.com/rios0rios0/backstage-plugin-code-health/releases/latest">
        <img src="https://img.shields.io/github/release/rios0rios0/backstage-plugin-code-health.svg?style=for-the-badge&logo=github" alt="Latest Release"/></a>
    <a href="https://github.com/rios0rios0/backstage-plugin-code-health/blob/main/LICENSE">
        <img src="https://img.shields.io/github/license/rios0rios0/backstage-plugin-code-health.svg?style=for-the-badge&logo=github" alt="License"/></a>
    <a href="https://github.com/rios0rios0/backstage-plugin-code-health/actions/workflows/default.yaml">
        <img src="https://img.shields.io/github/actions/workflow/status/rios0rios0/backstage-plugin-code-health/default.yaml?branch=main&style=for-the-badge&logo=github" alt="Build Status"/></a>
    <a href="https://www.npmjs.com/package/@rios0rios0/backstage-plugin-code-health">
        <img src="https://img.shields.io/npm/v/@rios0rios0/backstage-plugin-code-health?style=for-the-badge&logo=npm" alt="npm"/></a>
</p>

A [Backstage](https://backstage.io) plugin that shows CI status, releases, tags, compliance checks
and contributor metrics for the repositories in your Backstage catalog, with a year of history you
can scrub through.

Repositories come from the catalog. Credentials come from your existing `integrations`
configuration. A background actor collects the history once for the whole organisation and stores it
in the Backstage database, so opening the dashboard costs one request no matter how many
repositories exist or how many people are looking.

## Packages

| Package | Role |
|---|---|
| [`@rios0rios0/backstage-plugin-code-health`](https://www.npmjs.com/package/@rios0rios0/backstage-plugin-code-health) | Frontend plugin — the dashboard |
| [`@rios0rios0/backstage-plugin-code-health-backend`](https://www.npmjs.com/package/@rios0rios0/backstage-plugin-code-health-backend) | Backend plugin — discovery, ingestion and the read API |
| [`@rios0rios0/backstage-plugin-code-health-common`](https://www.npmjs.com/package/@rios0rios0/backstage-plugin-code-health-common) | The wire contract shared by both |

Both plugins are required. The frontend renders nothing useful without the backend, and says so
rather than showing an empty dashboard.

## Features

- **CI status**: the latest pipeline or workflow outcome on each repository's default branch
- **Releases & tags**: latest release with relative date, or the latest tag when no release exists
- **Compliance checks**: pipeline present, build policy on pull requests, build policy expiration and branch protection
- **README badge audit**: which of the six standard shields are present in each repository's README
- **Contributor metrics**: commits, code churn, pull requests created and pull requests approved as separate columns, review approval rate and pipeline success rate — every rate explains what it divides in a tooltip on its heading
- **Merged work is credited to whoever did it, not to whoever merged it**: a squash commit goes to the pull request's author whatever the provider stamped on it, a merge commit is not counted at all and the pull request's own commits are, and a pipeline run belongs to the author of the change it built. See [Attribution](plugins/code-health-backend/docs/attribution.md)
- **Honest churn units**: GitHub reports added and deleted lines; Azure DevOps reports changed files and exposes no line count anywhere in its API, so each row prints the unit its provider actually gave rather than showing zero
- **Insights**: the landing tab, holding the questions that are about the fleet rather than about one row of it — at a glance, delivery cadence and test coverage across the fleet, plus a section for each configured integration
- **Cards that live with their table**: top contributors, review load and most active repositories sit above the contributors table; documentation, catalog APIs and fleet health sit above the repositories table. A ranking is a way *into* a row, so it belongs beside the rows it ranks — and every entry links straight to that person's or that repository's page
- **Detail pages**: one person's or one repository's last one to six months, bucketed by day up to forty-five days and by week beyond it, plotting the same figures the tables print and bounded by what the backfill has actually collected
- **Two scores, never shown without their workings**: a productivity score per person and a health score per repository, each `0`–`100` and each rendered beside the components it was built from. A component nothing could measure is left out and its weight shared among the rest, never counted as a zero
- **Output is scored as a rate against the team's average**: each total divided by the days the range spans, read against the *mean* rate across the people it could be measured on, with twice that mean scoring full marks. One person's extraordinary month no longer pushes every colleague down. The denominator is the range rather than the days somebody was active, so a rate is output per elapsed day and a mid-range start or a spell of leave lowers it
- **Daily, weekly and monthly averages per person**, on their detail page — the score's own arithmetic written out, so a reader who disagrees with the number can see which row they disagree with — with the team's average under every figure and how far above or below it the person sits
- **Daily, weekly and monthly averages per repository**, on its detail page: commits, pull requests, reviews, pipeline runs, releases, and the coding time and tickets of whichever integrations are configured, each beside the fleet's average
- **Ownership**: the repositories a person is responsible for, read from the catalog's `spec.owner` and matched against their `User` entity and the groups they belong to, parent groups included — the same rule Backstage applies everywhere else
- **Re-collecting the history**: an administrator named in configuration, and allowed by the permission framework, can send the ingestion back to the start for a chosen number of days
- **Catalog links**: repository rows and contributors link through to their catalog entity, and a contributor matched to a `User` shows that entity's name and picture
- **Sonar integration** through the community `sonarqube` backend plugin, so its token stays where that plugin already keeps it
- **One row per person, not per account**: commits arrive under a commit e-mail or a login, coding time under a WakaTime username, tickets under an Atlassian account id. The **Identities** tab links them, so a contributor row adds up — and because links are applied when a row is built, correcting one fixes last March's numbers too. Linking is a pick from a searchable list of catalog users, never a reference typed out by hand
- **Not every account is a person being measured**: a build service, a bot, an outside contributor to a public repository, somebody who has left. Exclude one from the Identities tab, under one of four reasons, and it leaves every figure the plugin reports — the contributors table, both detail pages, the repository counters, the fleet cadence, and the fleet totals everybody's output is scored against. Nothing is deleted, so measuring it again restores every window already collected
- **WakaTime integration**: coding time, active days, language and editor breakdowns, branches touched, files opened, and — where WakaTime's editor plugins report them — **AI token counts and the share of lines written by AI rather than typed**. It is the only source here that measures effort rather than output, and the only one that can see the difference between a line typed and a line accepted from a completion
- **Jira integration**: tickets created and closed, interactions, story points estimated and finished, cycle and lead time, throughput, bug ratio, rework, and the open backlog by priority and age
- **Confluence integration**: pages created and edited, words written, comments, attachments, spaces contributed to, stale-page counts, and page views on Premium sites. One Atlassian credential lights up both products
- **Documentation audit**: which repositories publish TechDocs, which already write documentation nobody wired up, and which have none
- **Catalog API audit**: repositories shipping an OpenAPI, AsyncAPI, GraphQL or protobuf definition that declare no `spec.providesApis`
- **A year of history**: pick any rolling window from the last hour to the last 365 days, today so far, or any single calendar month
- **Two platforms**: GitHub (GraphQL) and Azure DevOps (REST), per repository rather than per instance
- **Filtering, sorting, pagination** on every column of every table — repositories, contributors, identities and the repositories a person owns — with the page size picked once and offered everywhere, plus archived/fork toggles

## Installation

```bash
yarn --cwd packages/backend add @rios0rios0/backstage-plugin-code-health-backend
yarn --cwd packages/app add @rios0rios0/backstage-plugin-code-health
```

### Backend

```ts
// packages/backend/src/index.ts
backend.add(import('@rios0rios0/backstage-plugin-code-health-backend'));
```

That is the whole backend setup. The plugin creates its own tables on first start and registers
three scheduled tasks.

### Frontend — new system (`@backstage/frontend-defaults`)

```ts
// packages/app/src/App.tsx
import codeHealthPlugin from '@rios0rios0/backstage-plugin-code-health/alpha';

export const app = createApp({
  features: [codeHealthPlugin],
});
```

The page mounts at `/code-health`. It emits a title and an icon, from which the app derives a
sidebar entry; an app that places nav items explicitly needs these extension IDs:

| Extension ID | What it is |
|---|---|
| `page:code-health` | The dashboard page |
| `api:code-health/config` | Presentation preferences from `app-config.yaml` |
| `api:code-health/repositories` | The repositories view's data source |
| `api:code-health/contributors` | The contributors view's data source |
| `api:code-health/coverage` | How much history the backend holds |
| `api:code-health/time-series` | Fleet activity over time, for the Insights charts |
| `api:code-health/integrations` | Which optional integrations the backend was configured with |
| `api:code-health/identities` | Every account seen, which person it belongs to, and which are measured |
| `api:code-health/trends` | One person's or one repository's history, for the detail pages |
| `api:code-health/ownership` | The repositories a person owns through the catalog |
| `api:code-health/administration` | What the caller may do beyond reading, and the reset itself |

There is no `nav-item:code-health` to reference.

### Frontend — legacy system (`createApp` from `@backstage/app-defaults`)

```tsx
// packages/app/src/App.tsx
import { CodeHealthPage } from '@rios0rios0/backstage-plugin-code-health';

<Route path="/code-health" element={<CodeHealthPage />} />
```

```tsx
// packages/app/src/components/Root/Root.tsx
import AssessmentIcon from '@material-ui/icons/Assessment';

<SidebarItem icon={AssessmentIcon} to="code-health" text="Code Health" />
```

## Configuration

### Credentials

**There is nothing to configure.** The backend authenticates to each provider through the host
application's existing `integrations` block, per repository URL, so a GitHub App's installation
tokens and an Azure DevOps organisation-scoped credential both work without a second copy.

```yaml
# app-config.yaml — you almost certainly have this already
integrations:
  github:
    - host: 'github.com'
      token: ${GITHUB_TOKEN}
  azure:
    - host: 'dev.azure.com'
      credentials:
        - personalAccessToken: ${AZURE_TOKEN}
```

Required scopes: GitHub `repo` (or `public_repo`) and `read:org`; Azure DevOps **Code (Read)**,
**Build (Read)** and **Project and Team (Read)**.

### Which repositories are tracked

Repositories come from the Backstage catalog. An entity is tracked when it resolves to a supported
repository, in this order:

1. `github.com/project-slug`, as `owner/repo`
2. `dev.azure.com/project-repo` together with `dev.azure.com/host-org`
3. `backstage.io/source-location`, matched against your configured integrations

Backstage's own GitHub and Azure DevOps discovery providers set a source location on everything they
register, so most catalogs need no annotations at all.

```yaml
# app-config.yaml
codeHealth:
  catalog:
    # Defaults to [{ kind: Component }]. Passed straight to the catalog.
    entityFilter:
      - kind: 'Component'
```

### Ingestion

```yaml
codeHealth:
  ingestion:
    retentionDays: 365
    # Day by day. `P7D` finishes the backfill roughly seven times sooner, at the
    # cost of coarser resume granularity when a run is interrupted.
    backfillChunk: 'P1D'
    # Hard ceiling on provider requests per run, per host. When it is spent the
    # run stops and the next one resumes from the same cursors.
    requestBudgetPerRun: 500
    concurrencyPerHost: 4
    schedule:
      frequency: { minutes: 5 }
      timeout: { minutes: 15 }
    discoverySchedule:
      frequency: { minutes: 30 }
      timeout: { minutes: 10 }
    snapshotSchedule:
      frequency: { cron: '0 3 * * *' }
      timeout: { hours: 1 }
```

**How long the first backfill takes.** Roughly three requests per repository per day, plus one or
two for each pull request merged with a merge commit, whose commits the branch history never returns
on its own. With the defaults — a 500-request budget every five minutes — 500 repositories take about
four days to reach a full year. Raising `backfillChunk` to `P7D` brings that under a day. The dashboard is useful
throughout: the actor collects the recent window before it starts walking backwards, so the last day
is answerable from the first run and wider ranges unlock as the backfill advances.

### Sonar, WakaTime and Atlassian

```yaml
codeHealth:
  sonar:
    # Requires @backstage-community/plugin-sonarqube-backend and a
    # `sonarqube.org/project-key` annotation on the entity.
    enabled: true

  wakaTime:
    # Optional. Without it the key's own account is measured, which is what a
    # small team on personal plans wants.
    organization: 'my-org'
    apiKey: ${WAKATIME_API_KEY}
    historyDays: 30
    # Token counts and AI-versus-human authorship. Off by default: coding time
    # for a whole window costs one request per member, while these cost one per
    # member per day.
    includeAiMetrics: false

  # One credential, both products.
  atlassian:
    baseUrl: 'https://acme.atlassian.net'
    email: ${ATLASSIAN_EMAIL}
    apiToken: ${ATLASSIAN_API_TOKEN}
    historyDays: 90
    jira:
      enabled: true
    confluence:
      enabled: true
```

Every integration is absent by default, and the frontend asks the backend which ones are configured
before it draws anything. That is why a column for a switched-off integration is never built rather
than being built and left empty: an integration configured this morning has collected nothing until
the nightly pass, and a dashboard that hides its columns until then looks broken rather than new.

Sonar measures are read from the `sonarqube` backend plugin over Backstage's internal
service-to-service channel, so its token is not duplicated here. That plugin exposes a current
summary per entity and no measures-history passthrough, so **Sonar history cannot be backfilled**:
the trend starts at the first snapshot after installation. The same is true of compliance checks and
README badges — no provider reports what they looked like last March. WakaTime and Jira *can* be
backfilled and are stored a day at a time, so a range picked over a past month gets a real answer
rather than a trailing window relabelled with that month's dates.

Jira and Confluence scope themselves to a repository through annotations on its catalog entity:

```yaml
metadata:
  annotations:
    jira/project-key: PLAT
    confluence.io/space-key: ENG
    # Only needed when the WakaTime project is not named after the repository.
    wakatime.com/project: platform-gateway
```

Each integration has its own reference, covering exactly what is measured, how each number is
derived, what the provider cannot answer and why:

- [WakaTime](plugins/code-health-backend/docs/wakatime.md)
- [Jira](plugins/code-health-backend/docs/jira.md)
- [Confluence](plugins/code-health-backend/docs/confluence.md)

The version control figures have a reference of their own, because whose row a fact lands on is the
whole of a per-person metric:

- [Attribution](plugins/code-health-backend/docs/attribution.md) — who a commit, a build and a
  review belong to, and how each provider's stamp is corrected

### Identities — making a contributor row a person

Every system identifies people differently, and only a shared e-mail address joins any two of them
on its own. The **Identities** tab lists every account the plugin has seen, which catalog `User` it
resolved to, and a ranked list of who else it might be.

An account whose address matches a `User` profile is linked automatically — that is the same rule
the catalog itself uses. Everything weaker (a shared address before the `@`, an identical display
name, a username that matches the directory address, a partial name match) is *offered* and linked
only when somebody confirms it. **Nothing is merged on a name resemblance alone**: two people who
share a surname would silently become one contributor, and a merge nobody asked for is far harder to
notice than a row that stayed separate. A manual link is never overwritten by the automatic rule.

Links are applied when a row is built rather than when a measurement is taken, so correcting one is
retroactive across every window the plugin has ever collected. An account nobody has linked keeps a
row of its own — hiding it would hide every bot, every service account, and everybody nobody has got
round to linking, which are exactly the rows that show the work is not finished.

The screen opens on those unlinked accounts, because they are the only ones that need anything done
to them. A switch widens it to every account, a second filter narrows it to the excluded ones, and a
source filter narrows it to one system. The listing is the same table the other tabs use: it sorts on
every column, filters by account and by person, and pages.

Each unlinked row offers its likely matches as one-click chips, and behind them a picker. The picker
opens on the same likely matches, and as somebody types it searches the directory for the name, the
address or the entity name — `rios` finds *Felipe Rios*, `j.doe` finds the address — so a link is a
pick rather than a reference spelled out. The field still accepts a `user:<namespace>/<name>`
reference typed or pasted whole, because that is what the backend validates against; a bare name is
not one, and the **Link** button stays disabled until there is something linkable to send. The search
is answered by the backend (`GET /v1/identities/users?q=`), which enumerates the directory once per
query the way the listing already does for its suggestions, and the screen asks only once the typing
pauses and only for two characters or more.

#### Excluding an account from the measuring system

Some of those rows are never going to be a person. Each one carries an **Exclude** button offering
four reasons, one of which has to be picked:

| Reason | What it means |
|---|---|
| Former contributor | Somebody who has left. Their work stays in the database, and stops counting towards anybody's figures |
| Open source contributor | An outside contributor to a public repository, who is not a member of the organisation being measured |
| Automated bot | A bot that commits, opens pull requests or votes on them under its own account |
| Service or system account | An identity the platform itself acts as — an Azure DevOps build service, a deployment principal |

An excluded account leaves **every figure that measures a person**: its contributor row disappears
rather than reading zero, its commits, pull requests and reviews stop counting towards the
repository counters and the fleet delivery cadence, its coding time comes off the repositories it
was logged against, and — the reason this matters most — it stops setting the fleet reference that
commits, merged pull requests, churn and reviews are scored against. An automation merging two
hundred pull requests a month is otherwise the bar every human on the team is measured by.

What it does **not** do is take the repository's machinery down with it. A build, a release and a
tag are facts about the repository that happen to carry whoever triggered them, so they stay in its
counters with nobody credited for them. Otherwise a platform excluding its own build service would
report "no build reached a verdict" for every repository whose pipelines are scheduled, release or
deployment runs, and a tenth of the repository health weight would quietly redistribute itself
fleet-wide. Excluding an account changes who is credited; it never makes a repository look like it
has no CI.

The exclusion is a statement about a **person**, recorded on the account it was made from. Excluding
one account of somebody the link table says is one human excludes all of their accounts, so a
leaver's coding time goes with their commits instead of leaving a row holding a third of a story.
An account that inherited an exclusion says which account carries it, because only that row can undo
it.

Nothing is deleted. The events, the snapshots and the per-source measures stay exactly as they were
collected, and the exclusion is applied when a row is built — so **Measure again** restores every
window the plugin has ever collected, not just the ones collected afterwards. The reason, and who
recorded it, are stored so the decision is reviewable months later.

### Who a commit, a build and a review belong to

Both providers stamp whoever **merges** a pull request on everything the merge produces: the squash
commit, the merge commit, the pipeline run it triggers. Read at face value, the person who completes
most pull requests looks like the author of everything, which is the opposite of what a contributors
table is for. So:

- A **squash commit** is credited to the pull request's author, whatever the provider stamped on it.
- A **merge commit** is not counted at all — its diff is the sum of the commits it joins — and the
  pull request's own commits are fetched and stored under the dates they were written, because the
  branch history for the day of the merge never returns them.
- A **rebase** keeps every commit's own author and needs no correction.
- A **pipeline run** belongs to the author of the change it built: the pull request whose merge
  produced the commit, else the commit's author, else whoever requested the run. Its success rate
  divides by the runs that reached a verdict, so a run cancelled by a newer push is not a failure.
- A **review** is a vote cast on somebody else's pull request. The author's own vote is not one,
  and on Azure DevOps neither is a reviewer who was added and never voted.
- The **Sonar** figures on a contributor row sum over the repositories the person committed to or
  merged into, and say so on every heading — Sonar measures a project, not a person.

[Attribution](plugins/code-health-backend/docs/attribution.md) states every rule with the provider
field it is decided from, and what each provider cannot answer.

**Upgrading from `3.0.0` or earlier re-walks the history.** The rows those releases stored credit the
merger, and nothing can repair them in place. On its first start the backend sends every tracked
repository's ingestion cursors back to where a fresh install starts and re-collects; the last day is
answerable from the first run, and wider ranges unlock as the backfill advances.

### Presentation

```yaml
codeHealth:
  # 60000, 300000, 900000 or 0. Defaults to 300000.
  refreshIntervalMs: 300000
  # today | hour | day | week | month | quarter | year. Defaults to `day`. A
  # range wider than the backend has ingested falls back to the widest one
  # available. `today` is the local calendar day so far; `day` is the last 24
  # hours. A specific calendar month cannot be pinned here — it would be a fixed
  # month that goes stale the moment it passes.
  defaultRange: 'day'
```

One range control, and one selection behind it. The dropdown lists the rolling ranges above under
**Rolling**, and every calendar month the backfill has reached under **Calendar months**, by name and
newest first — **September 2026**, **August 2026**, and so on — so picking a month is one click and
the list itself shows how far back the history goes. The arrows beside it step a month at a time,
which is the fast path for "and the month before that", and both stop at the ends of what has been
ingested so the control can never ask for a period that would come back empty.

The pick follows you across the tabs. Insights, Contributors and Repositories all read the same
selection, so a month chosen on one is still the month on the next; each still resolves it against
its own clock, which is what keeps `today` meaning today on a tab opened after midnight.

The Insights tab has no settings of its own. Its cadence chart buckets by day, week or month
according to the range already selected — a year of daily points is noise and a week of monthly
ones is a single dot, so the only correct setting is implied by the range and is not offered as a
second control.

Four tabs, in the order somebody reads them. **Insights** leads and keeps only what is about the
fleet rather than about one row of it: at a glance, delivery cadence, test coverage across the
fleet, and a section for each configured integration. The rankings that used to sit there —
top contributors, review load, most active repositories — now sit above the **Contributors** table,
and documentation, catalog APIs and fleet health sit above the **Repositories** table. A ranking is
a way into a row, so putting it a tab away from the rows it ranks made a reader carry a name across
the screen by hand; every entry now links to that person's or that repository's page. **Identities**
stays last, because it is maintenance rather than a measurement.

Each optional integration is split the same way. Insights keeps what WakaTime, Jira and Confluence
say about the fleet — where the fleet's hours went and what they went into, the Jira delivery
figures, the Confluence headline. What they say about a *person* sits above the Contributors table:
who spent the coding time, who closes tickets, who keeps the board moving, who is documenting. What
they say about a *repository* sits above the Repositories table: coding time by repository, backlog
flow, open work by priority, the oldest open ticket, and documentation rot. Every row links to that
person's or that repository's page, exactly as the version control rankings beside them do. Each
section appears only when the backend reports that integration as configured — never because a row
happens to carry a value, which cannot tell a switched-off integration from one that is on and has
not collected yet — and each says for itself when it is configured and has nothing to show, so a
reader never has to visit another tab to learn why a card is empty.

### Trends and scores

Clicking a contributor's name — in the table, or in a ranking above it — opens that person's page;
clicking a repository opens the repository's. Both offer the last one to six months and plot the
same figures the tables print, bucketed by day up to forty-five days and by week beyond that. The
threshold is derived from the window rather than offered as a second control: a hundred and eighty
daily points across a card read as noise, and four weekly points across a month read as nothing, so
the only correct setting is the one the months already imply. The list of months is bounded by what
the backfill has reached, and the page says so when the list is short.

A person travels in the **query string** — `/contributors/person?key=user:default/jane` — rather
than in a path segment. A person key carries a colon and, for somebody linked to a catalog `User`, a
slash; React Router decodes a segment before it matches it, so an encoded slash splits the key into
two segments and the route stops matching at all. A repository id has no such characters and sits in
the path: `/repositories/<id>`.

Both pages head themselves with a score, and neither ever prints the number on its own. A bare `62`
on a person is an accusation with no evidence; a bare `71` on a repository is a figure nobody can
act on. So a score always carries its components — what was measured, how much of the total it
carried, and the sentence explaining how it was read — and the page renders them beside the number
rather than behind it.

A component that could not be measured is **left out and its weight shared among the ones that
could**, never scored as zero: a repository with no Sonar project has an unknown quality gate, not a
failing one, and somebody whose pipeline never ran has no success rate rather than a bad one. Each
score reports how much of the weight survived, so one resting on a single component cannot pass for
one resting on all of them.

#### Productivity — one person, over one window

A reading aid, not a verdict. The output components are read **as a daily rate against the team's
mean daily rate in the same window** rather than against a constant: each total is divided by the
days the range spans and compared with the mean across the people it could be measured on, and
twice that mean scores full marks. A quiet month for the whole team is then a quiet month rather
than everybody's failure, there is no invented "forty commits is a good month" for anyone to argue
with, and one person's extraordinary month moves the reference by their share of the headcount
rather than setting it outright. Reliability and quality are absolute, because a pipeline success
rate means the same thing whoever else happens to be on the team. Churn is only ever compared within
its own unit — GitHub's lines against lines, Azure DevOps's files against files — because the two
are not the same measurement wearing different labels.

| Component | Weight | Read as |
|---|---|---|
| Commits | 20% | rate against twice the team's mean rate |
| Pull requests merged | 20% | rate against twice the team's mean rate |
| Code churn | 10% | rate against twice the team's mean rate **in the same unit** |
| Reviews given | 15% | rate against twice the team's mean rate |
| Pipeline success | 15% | absolute, over the runs that reached a verdict |
| Quality gate of code touched | 10% | absolute |
| Test coverage of code touched | 10% | absolute, against the 80% Sonar gate |
| Coding time | 10% | **WakaTime only** — rate against twice the team's mean rate |
| Tickets resolved | 15% | **Jira only** — rate against twice the team's mean rate |
| Tickets that stayed done | 5% | **Jira only** — absolute, over this person's own resolved tickets |
| Documentation written | 10% | **Confluence only** — total against twice the team's mean over Confluence's trailing window, which the range picker does not move |

The two Sonar components describe **the repositories the person changed, not the code they wrote** —
Sonar measures a project — which is why they carry the least weight and why every Sonar heading says
so.

Documentation written is the one component that does not follow the range picker. Confluence is
stored per window rather than per day — its figures describe the backend's trailing
`atlassian.historyDays`, ninety by default — so the component's own sentence says which window it
was read over, and the per-bucket score on a person's page leaves it out entirely: a bucket cannot
measure it, and a line folded from one component fewer than the headline would sit below that
headline for the whole window.

The last four exist only where their integration is **configured**, and their absence is read from
the configuration rather than from the rows: a row carrying no ticket count cannot say whether Jira
is switched off or simply has not been read yet, and grading on the second reading would make a
freshly configured install look as though half its people had stopped working.

**The weights above are nominal, and are shared out over whatever is enabled.** With every
integration on they add up to 140%, so each is scaled to bring the total back to one — commits then
carry about 14% rather than 20%. That way a weight states what its component is worth *against the
others* instead of against a total that differs per install, and an install with nothing configured
scores exactly the seven components at exactly the seven weights it always did. `productivityComponentsFor`
is the one place that arithmetic happens, and the column heading, the score card and this table all
read from it.

#### Averages — a person, or a repository, beside the average

Both detail pages carry an **Averages** card: the window's totals divided by the days it spans, per
day, per week and per mean Gregorian month. On a person's page the rows are the ones the score
reads — commits, pull requests opened and merged, reviews, churn in the provider's own unit,
pipeline runs, and the coding time and resolved tickets of whichever integrations are configured.
Under every figure sits the **team's average** in the same period, and the last column says how far
above or below it the person sits, as a share of the team's figure: `25% above the team`,
`40% below the team`, or `level with the team`. The team is everybody the window measured — the same
people the score's reference is taken over, sent by the backend beside the score so the two cannot
disagree — and each average is the mean over the people that row could be measured on, so somebody
with no WakaTime account is not a zero in the team's coding time. An em dash on either side is a
figure nobody measured, and a comparison against an average of nothing is an em dash too.

A repository's page carries the same card for its own activity — commits, pull requests opened and
merged, reviews, pipeline runs, releases, coding time and tickets — against the **fleet's average**,
taken over every active repository the plugin tracks, archived ones left out because one that cannot
receive a commit is not a peer of the ones that can. Above the fleet means busier, not better: the
health score is the judgement, and this card is the activity. Tickets are the one row not read over
the range picked, because a repository's Jira figures ride on the daily snapshot and describe Jira's
own trailing window; the rate is taken over that window's days, and the row says which days those
are. Churn is left off the repository card altogether, because a fleet mixes GitHub's lines with
Azure DevOps's files and a mean of the two would be a mean of unlike things.

#### Repository health — one repository, absolutely

Every component is absolute here: a failing gate is a failing gate whatever the rest of the fleet
looks like. Three of them decay rather than cut off, because "five bugs" and "five hundred bugs"
should not read the same.

| Component | Weight | Read as |
|---|---|---|
| Quality gate | 15% | passing or failing |
| Test coverage | 15% | against the 80% Sonar gate |
| Bugs and vulnerabilities | 10% | a vulnerability counts double; five bug-equivalents halve it |
| Duplication | 5% | 20% duplicated scores nothing |
| Technical debt | 5% | five working days halve it |
| Default branch build | 10% | the last run on the default branch |
| Build success | 10% | over the builds that reached a verdict |
| Branch and build policy | 10% | how many of the four checks pass |
| Documentation | 5% | published 1, written but unpublished 0.5, missing 0, archived not asked |
| Review coverage | 10% | reviews per merged pull request, capped at one each |
| Pull requests landed | 5% | merged rather than abandoned |

Sonar, compliance and badge figures cannot be backfilled, so a repository's score is thinner on the
day it is installed than it will be the day after — which the evidence figure states rather than
quietly hiding.

### Ownership — the repositories a person is responsible for

Where somebody commits and what somebody is responsible for are different questions, and a team lead
asking "are they looking after their projects" means the second one. Discovery stores each catalog
entity's `spec.owner` on the repository row, normalised the way the catalog normalises it: a bare
`team-a` becomes `group:default/team-a`, because an unqualified owner defaults to a group in the
default namespace and two spellings of one group otherwise fail to match each other.

A person owns a repository when its owner is their own `User` entity or a group they belong to,
**including that group's parents** — `memberOf` followed by `childOf`. That is how Backstage decides
ownership everywhere else, so the plugin does not invent a second answer to a question the catalog
has already answered.

An account nobody has linked to a catalog `User` owns nothing, and its page says exactly that rather
than showing an empty list, which would read as neglect. The **Identities** tab is where the link is
made, and because links are applied when a row is built, making one there fills the ownership in at
once.

**Upgrading.** `RepositorySummary.ownerRef` and `RepositoryActivity.reviews` are new **required**
fields of the wire contract. All three packages carry one version and are released together, so
upgrade them as a set: a frontend on this version against an older backend gets rows missing both.
The `fleet` both trend responses now carry is read as absent when an older backend leaves it out, so
the Averages cards print the figures alone and say no average was sent rather than failing.

### What the documentation and API audits read

Both grades combine what the catalog entity says with what the repository contains, so the daily
snapshot has to have run at least once before either reports anything — until then they read
"not measured" rather than "nothing found".

| Signal | Where it comes from |
|---|---|
| Published documentation | `backstage.io/techdocs-ref` on the entity |
| Documentation sources | a `docs/` tree or an `mkdocs.yml` in the repository |
| External documentation | a `metadata.links` entry whose type or title names docs or a wiki |
| Declared APIs | `spec.providesApis` on the entity |
| API definition | `openapi`, `swagger`, `asyncapi`, `api`, a GraphQL schema or a `.proto`, at the root or under `docs/` or `api/` |

The file scan is deliberately shallow — the root, `docs/` and `api/`. It costs no extra request on
GitHub, where the trees ride along in the snapshot's existing GraphQL document, and one listing per
repository per day on Azure DevOps, plus one more for each of those two directories that exists. A
README on its own does not count as documentation: nearly every repository has one, so counting it
would grade the whole fleet documented and the metric would measure nothing.

## Operating it

The backend registers three tasks, all `scope: 'global'` so a multi-replica backend runs each of
them once rather than once per replica:

| Task | Default cadence | What it does |
|---|---|---|
| `code-health.discover` | every 30 minutes | Reconciles the tracked repositories with the catalog |
| `code-health.ingest` | every 5 minutes | Moves each forward cursor to now, then backfills with what is left of the budget |
| `code-health.snapshot` | daily at 03:00 | Captures compliance, badges, Sonar, branches, latest release and tag |

Backstage's scheduler exposes a control plane for them:

```bash
curl localhost:7007/api/code-health/.backstage/scheduler/v1/tasks
curl -X POST localhost:7007/api/code-health/.backstage/scheduler/v1/tasks/code-health.ingest/trigger
```

`GET /api/code-health/v1/coverage` reports how far the backfill has got, which repositories are
failing, and the instant every repository has data through.

### Re-collecting the history

Nobody can start the collection over by default. Two things have to allow it, and the backend checks
both on every request rather than trusting the browser to have hidden a button:

```yaml
codeHealth:
  # Catalog entity references. A group grants it to everybody in the group,
  # parents included. Empty by default, which is what makes a fresh install
  # read-only for everyone.
  administrators:
    - 'group:default/platform'
    - 'user:default/jane'
```

and the `code-health.ingestion.reset` permission, registered with
`@backstage/plugin-permission-common` and exported from the backend package, which a permission
policy or the RBAC plugin can deny. Being named in `administrators` is not enough if the policy
refuses, and passing the policy is not enough if nobody named you. The configuration is where the
plugin says who its administrators are; the permission framework stays where an organisation
expresses a rule about them, and neither is asked to stand in for the other.

An administrator gets a **Re-collect history** control in the page header. It asks how far back
before it does anything, up to `codeHealth.ingestion.retentionDays`, because a year across two
hundred repositories is most of a day of rate-limited requests and somebody who only needs last
quarter re-read after a fix should not pay for the other three.

What a reset does is what a fresh install does. Every commit, pull request, review and pipeline run
inside the chosen reach is discarded, every tracked repository's cursors go back to the start, and
the actor walks the history again at whatever rate the providers allow. Until it catches up, the
dashboards answer for the last day only and wider ranges unlock as it advances — the same
**Collecting history** bar that shows after installation comes back while it runs.

What a reset keeps: releases, tags, the daily snapshots (Sonar, compliance and README badges), every
identity link and every exclusion. The snapshots because no provider can say what they looked like
last March, so discarding them would lose them for good; the links and the exclusions because they
are statements a person made rather than anything a provider reported — and because a reset that
quietly put every build service back into the figures would undo the work it looks least like
undoing.

| Route | Answers |
|---|---|
| `GET /api/code-health/v1/access` | whether this caller may reset, and the retention in days |
| `POST /api/code-health/v1/ingestion/reset` | `{ "days": 365 }` — `403` when either check refuses, `400` outside `1..retentionDays` |

## Architecture

```
browser                    backstage backend                providers
────────                   ─────────────────                ─────────
code-health           ──▶  /api/code-health/v1/*      ┌──▶  catalog (which repositories)
  no tokens, no crypto       ├─ router (read-only)    │
  one request per load       ├─ store (knex)          ├──▶  Azure DevOps REST 7.1
                             └─ ingestion actor ──────┤
                                  discover  (30 min)  ├──▶  GitHub GraphQL + REST
                                  ingest    ( 5 min)  │
                                  snapshot  (daily)   └──▶  /api/sonarqube, WakaTime
                             credentials: ScmIntegrations
```

Every provider request passes through one gateway that caps concurrency per host, spends a bounded
budget per run, retries `429` and `5xx` with jittered backoff, and opens a circuit breaker on a host
that keeps failing. It reads `Retry-After` and the `X-RateLimit-*` headers on **every** response,
not only on errors — Azure DevOps applies throttling as latency on a successful `200` and sends
those headers before it starts delaying.

The whole API, under `/api/code-health/v1`:

| Route | What it answers |
|---|---|
| `GET /repositories` | one row per tracked repository, over a window |
| `GET /contributors` | one row per person, over a window |
| `GET /timeseries` | fleet activity, bucketed by day, week or month |
| `GET /coverage` | how far the backfill has got, and what is failing |
| `GET /capabilities` | which optional integrations the backend was configured with |
| `GET /identities` | every account seen, which person it resolved to, and why it is not measured |
| `PUT /identities/links` · `DELETE /identities/links/:source/:key` | attach an account to a catalog `User`, or detach it |
| `PUT /identities/exclusions` · `DELETE /identities/exclusions/:source/:key` | take an account out of every measurement under a named reason, or put it back |
| `GET /contributors/:key/trend` | one person's history, bucketed, with the score for each bucket |
| `GET /contributors/:key/repositories` | the repositories that person owns through the catalog |
| `GET /repositories/:id/trend` | one repository's history, bucketed, with the score for each bucket |
| `GET /access` | what this caller may do beyond reading |
| `POST /ingestion/reset` | send the ingestion cursors back and re-read |
| `POST /refresh` | run the scheduled tasks now |

Of these, `POST /ingestion/reset` is the only one gated on more than being signed in, and the gate
is the backend's own — a control the browser did not draw is not an access control.

## Development

```bash
corepack enable
yarn install
make lint        # ESLint and knip across the workspace
make test        # the whole suite
make sast        # CodeQL, Semgrep, Trivy, Hadolint, Gitleaks
yarn build       # type-check and build all three packages
```

To run the backend on its own, against a mocked catalog:

```bash
yarn workspace @rios0rios0/backstage-plugin-code-health-backend start
curl http://localhost:7007/api/code-health/health
```

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

See [LICENSE](LICENSE) file for details.
