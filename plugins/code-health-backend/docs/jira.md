# Jira metrics

The plugin can read delivery measures out of Jira Cloud and show them beside the version
control figures — per person on the contributors table, and per repository on the
repositories table and the Insights tab.

Nothing here reaches a browser. The Atlassian credential lives in backend configuration,
every request is made by the daily snapshot task, and the dashboard only ever talks to
`/api/code-health`.

## Configuration

Jira and Confluence share one Atlassian Cloud credential, so configuring the site
configures both:

```yaml
codeHealth:
  atlassian:
    baseUrl: https://acme.atlassian.net    # no trailing slash
    email: ${ATLASSIAN_EMAIL}              # the account the API token belongs to
    apiToken: ${ATLASSIAN_API_TOKEN}
    maxResultsPerRun: 2000
    historyDays: 90
    jira:
      enabled: true
      # Custom field id holding story points. Leave unset to resolve it by name.
      storyPointsField: null
      # Jira's own allowance per snapshot pass.
      requestBudgetPerRun: 500
```

Create the token at <https://id.atlassian.com/manage-profile/security/api-tokens>. It is
authenticated as HTTP Basic `email:apiToken`, so it carries exactly the permissions of the
account it belongs to — a read-only service account sees only the projects it has been
granted, and any project it cannot read is simply absent from the dashboard rather than an
error.

The Jira columns and cards appear only when `GET /api/code-health/v1/capabilities` reports
`jira: true`, which is true when the Atlassian block is configured and `jira.enabled` is
not `false`. A disabled integration renders nothing at all — not a column of blanks.

## Scoping: which tickets belong to which repository

**The catalog is the only source of scope.** A repository is measured against a Jira
project because its catalog entity says so:

```yaml
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: gateway
  annotations:
    jira/project-key: PLAT
    jira/component: gateway      # optional, narrows to one component
spec:
  type: service
```

A repository whose entity carries no `jira/project-key` has **no Jira row at all** — not a
row of zeroes. Several repositories legitimately track no work in Jira, and guessing a
project from a repository name would attribute one team's tickets to another team's
repository, which is the kind of mistake that is invisible on a dashboard showing only
totals.

Several repositories may name one project. The project is then queried **once** and the
same answer is shown on each of their rows, and the Insights aggregates count it once. If
two repositories in one project appear to show identical figures, that is why.

## What is measured, and exactly how

Every figure below is scoped to a trailing window of `historyDays` days (90 by default),
ending at the end of the day the run happened. The window travels with the value, so the
UI can state the period it is showing.

### Per person

People are identified by their Atlassian **`accountId`**, lowercased. That is the only
identifier GDPR-era Jira returns on every endpoint — `emailAddress` appears only when
somebody made their address visible, and the old `name`/`key` fields were removed
outright. The e-mail is recorded when offered, purely so the Identities screen has
something to match a catalog user on.

| Figure | How it is derived |
|---|---|
| **Tickets closed** | Issues whose `resolutiondate` falls in the window, attributed to the **assignee**. Jira records no "closed by"; the assignee is what the site's own reports use, so this agrees with what a team already sees. |
| **Tickets raised** | Issues whose `created` falls in the window, attributed to the **reporter** (falling back to `creator`). |
| **Jira activity** | Comments written + worklog entries booked + status transitions performed, inside the window. Printed as a total with the three components underneath, because they are not interchangeable. |
| **Story points** | The custom field's value summed over the tickets closed in the window, and over the tickets assigned. See the caveat below. |
| **Cycle time** | Hours from the first transition into an *in-progress* status to the resolution, **averaged** over the tickets the person closed. |
| **Lead time** | The same, measured from `created`. |
| **Reopened** | Transitions from a *done* status back to an open one, charged to the **assignee** — it is a statement about work coming back, and the person who spotted the defect is not the person it came back to. |

### Per repository (that is, per Jira project)

| Figure | How it is derived |
|---|---|
| **Tickets** | Closed and opened inside the window. |
| **Throughput** | Tickets closed per week across the window. `null` for a window shorter than a day: a rate extrapolated from an hour of evidence is arithmetic, not measurement. |
| **Cycle time** | The **median** hours from start of work to done, with the 85th percentile beside it. |
| **Lead time** | The same, from `created`. |
| **Bug ratio** | Share of closed work whose issue type is a defect, with the counts beside it. |
| **Reopened** | Done → open transitions inside the window. |
| **Open** | Issues not in a done status **right now**, with the age of the oldest. |
| **Open by priority** | One count per priority the site defines, in the site's own severity order. |

### Why cycle time is a median in one table and an average in the other

Both are deliberate, and they are opposites for the same reason.

A contributor row is a *person*, and identity linking merges every Atlassian account one
person holds onto it. Everything on that row therefore has to survive being added to
another row's. A median cannot: no arithmetic recovers the median of a union from two
medians. The stored value is therefore a **total and a count**, from which the exact mean
of the union falls out — which is why the contributor column shows an average.

A repository row is keyed by repository and is never merged with another, so a median is
safe there, and it is the better statistic: cycle time has a long right tail, and one
ticket that sat in review over a holiday drags a mean by days.

## Story points: the field id differs per site

Story points are a **custom field**, not a standard one. Jira exposes them as
`customfield_XXXXX` and the number differs on every site.

The plugin resolves it once per run by reading `GET /rest/api/3/field` and matching the
field *name*, preferring `Story Points` (what company-managed projects call it) over
`Story point estimate` (team-managed). A site running both project types carries **both
fields, with different ids**, and there is no way to tell from a field list which one a
given project uses — pin it explicitly:

```yaml
codeHealth:
  atlassian:
    jira:
      storyPointsField: customfield_10016
```

If it cannot be resolved, every story-point figure is **`null`** and the UI renders an em
dash. It is never zero. A zero would be indistinguishable from a team that estimates
nothing, and those call for opposite reactions. The run logs the miss once, naming the
setting.

## What Jira cannot answer, and why

These are documented rather than approximated. A metric that cannot be measured correctly
is worse than no metric.

- **Sprint completion rate is not reported.** The credential *can* reach the Agile API,
  so this is not an access problem. The public `/rest/agile/1.0` endpoints return a
  sprint's issues *as they are now*, not the scope it was committed with at the start —
  and committed scope is the denominator a completion rate needs. Only the unsupported
  internal `greenhopper` sprint-report endpoint exposes it. Any figure computed from the
  public API would silently ignore scope added mid-sprint and disagree with the sprint
  report the team is looking at, which is worse than showing nothing.

- **"Commented by" has no JQL.** Core Jira has no way to search for issues a person
  commented on; the operator exists only in the paid ScriptRunner add-on. Comment counts
  are therefore read from the issues the window's query already returned, and are capped
  by what the search will return per issue (see truncation below).

- **A historical backlog size is not reported.** "How many issues are open" is answered
  for *now*. Answering it for a past window would mean replaying every status change on
  the site.

- **Issue types are matched by name.** Jira exposes no "this is a defect" flag and issue
  type ids are per-site. `Bug` and `Defect` are matched as defects; `Story`, `Task`,
  `Sub-task` and `Epic` are matched as themselves; a site that invented `Incident` lands
  in "other". A sub-task counts as a task whatever the type is called, because Jira
  reports that flag separately from the name.

- **Truncation is reported, not hidden.** Jira Cloud's enhanced search caps how many
  comments, worklog entries and changelog rows it returns per issue. When it does, the
  interaction count for everybody on that issue is a **floor**, and the table renders a
  trailing `+`. With the default daily run this is rare: an issue seldom collects twenty
  comments inside one day.

- **Comments or worklog missing from the breakdown** means the site's search did not
  return that field at all, in which case the count is `null` rather than zero — the site
  has not told us there were no comments, it has told us nothing.

- **A ticket that went straight from the backlog to done has no cycle time** and is left
  out of that average rather than counted as instantaneous. Counting it would drag every
  median towards zero and make a team look faster the more work it skipped the board with.

## How the identity linking joins Jira to commits

A person's commits arrive under a GitHub login or a commit e-mail, and their tickets under
an Atlassian `accountId`. The three rarely match.

Every run records each Jira account it saw as an **observed identity** — `accountId`,
display name, e-mail when Jira offered one, avatar and a link to the person's Jira
profile. The Identities admin screen lists them, links an account whose e-mail matches a
catalog `User` automatically, and offers ranked suggestions for the rest for a human to
confirm. Once linked, the person's Jira figures land on the same contributor row as their
commits.

Nothing is merged on a name resemblance alone. Two people who share a surname would
silently become one contributor, and a merge nobody asked for is far harder to notice than
a row that stayed separate.

## Cost and rate limiting

Every request goes through the shared provider gateway: a per-host concurrency cap that
lowers itself when the site reports it is close to throttling, jittered retry, and a
circuit breaker. The request allowance is Jira's own — `requestBudgetPerRun`, 500 by
default, room for about two dozen projects at the default `maxIssuesPerProject` — and
nothing else in the snapshot pass draws on it, so a project with a large ticket volume
costs the pass its Jira figures and never a repository snapshot.

Per run, per **project** (not per repository):

| Requests | What for |
|---|---|
| 1 per run | the field list, unless `storyPointsField` is pinned |
| 1 per run | the status list, which maps status ids to Jira's three categories |
| 1 per run | the priority list |
| 1–10 per project | the window's issues, 100 per page, capped by `maxIssuesPerProject` (1000) |
| 1 per project | the open-issue count |
| 1 per project | the oldest open issue |
| 1 per priority, per project | the priority breakdown |

The priority breakdown is the **first thing dropped** when the run's allowance is running
low, and a site with more than eight priorities is skipped outright — it is the least
valuable thing collected and the only part whose cost multiplies by both the project count
and the priority count. When it is skipped the card says so, rather than drawing an empty
chart that would read as an empty backlog.

`fetchContributors` and `fetchRepositories` share one scan of the window, so a snapshot
queries each project once for both.

If a project's query fails, that project is skipped and the rest of the run continues. If
the allowance is exhausted, the run stops at the project it is on, the next one starts
fresh, and the snapshot pass warns that Jira stopped short and names the setting.

## Timezone

JQL resolves a bare date in the **token owner's** Jira profile timezone — not UTC, and not
the caller's. There is no way to override that in a query. The plugin therefore asks for a
day more than it needs at each end and filters precisely on the ISO instants the issues
themselves carry, so the numbers do not change when the service account is moved to
another office.

## Troubleshooting

| Symptom | Cause |
|---|---|
| No Jira columns at all | `capabilities.jira` is false: the Atlassian block is incomplete, or `jira.enabled` is `false`. |
| Columns present, every cell an em dash | No entity carries `jira/project-key`, or the first snapshot has not run yet. |
| Story points all em dashes | The field could not be resolved by name. Pin `storyPointsField`. The run logs this once. |
| Cycle time all em dashes | `GET /rest/api/3/status` failed, so status ids cannot be mapped to categories. Lead time still works — it comes from fields the issue carries directly. |
| Two repositories showing identical figures | They name the same Jira project. Add `jira/component` to narrow them, if the project uses components. |
| Interaction counts with a trailing `+` | Jira's search capped one of the lists it was asked for; the figure is a floor. |
| A project missing from the dashboard | The token's account cannot read it, or `maxIssuesPerProject` truncated the run. Both are logged. |
