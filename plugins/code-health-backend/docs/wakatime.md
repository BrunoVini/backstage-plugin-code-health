# WakaTime

WakaTime is the only source in this plugin that measures *effort* rather than
*output*. Every other integration counts something a system produced — a commit,
a merged pull request, a green pipeline, a closed ticket — and none of them can
see the afternoon somebody spent reading code that produced no commit at all.

It is also the only place any system here reports a **token count**. WakaTime's
editor plugins observe whether a line was typed or accepted from a completion;
no version control provider knows the difference, and none ever will.

## What is measured

### Per person

| Column | Where it comes from | Notes |
|---|---|---|
| **Coding time** | `grand_total.total_seconds`, summed over the window's days | The average beneath it divides by the days the window covers, not by the days somebody was active |
| **Active days** | Days with any recorded activity, out of the days covered | The same total over two days and over ten are different weeks |
| **Language** | The largest slice of the merged `languages` breakdown | |
| **Branches** | Distinct branches an editor was open on | Includes branches that never produced a commit, which is the difference between this and anything the repository can tell you |
| **Files** | `entities.length` | `null` on plans that do not return `entities` — never `0` |
| **AI tokens** | `ai_input_tokens` + `ai_output_tokens` from `durations` | Opt-in; see below |
| **AI lines** | `ai_additions / (ai_additions + human_additions)` | `null` when nothing was written at all, because nobody-wrote-anything is not the same as a-human-wrote-everything |

Also collected and available on the Insights tab, though not given a column:
`categories` (coding, debugging, code reviewing, writing tests, browsing),
`editors`, `operating_systems`, `machines`, `projects`, the best day, prompt and
session counts, and the per-model cost estimate WakaTime attaches to each
duration.

### Per repository

Coding time is attributed to a repository by matching a **WakaTime project** to
it. WakaTime's editor plugins derive a project name from the working directory,
which is the repository name in the overwhelming majority of setups; where it is
not, the catalog entity can say so:

```yaml
metadata:
  annotations:
    wakatime.com/project: internal-name-of-the-project
```

Matching folds case and separators, so `code-health` matches `Code_Health`. A
repository nothing matched reports **null, not zero** — "nobody here has
WakaTime installed" and "the project is called something else" are different
problems with different fixes, and a zero would hide both behind the same cell.

## Configuration

```yaml
codeHealth:
  wakaTime:
    # Optional. Without it the key's own account is measured, which is the
    # useful behaviour on a personal plan.
    organization: acme
    # Optional. Members hang off a dashboard, and most organisations have one.
    dashboard: Everyone
    apiKey: ${WAKATIME_API_KEY}
    baseUrl: https://wakatime.com/api/v1
    historyDays: 30
    # The expensive half. Off by default.
    includeAiMetrics: false
    aiDaysPerRun: 3
    # WakaTime's own allowance per snapshot pass.
    requestBudgetPerRun: 500
```

The key is read only by the backend and never reaches a browser. That is the
whole reason this moved out of the frontend plugin.

## Two things about the API shape that drive the code

**An organisation's members hang off a dashboard, not off the organisation.**
The path is `/users/current/orgs/{org}/dashboards`, then that dashboard's
`/members`, then each member's `/summaries`. There is no `/orgs/{org}/members`,
and asking for one returns a 404 that reads exactly like a missing organisation.
Members are addressed by their **member id**, not by their username; getting
that wrong returns empty summaries for everybody rather than failing, which is
the expensive kind of mistake.

**Coding time and the AI figures come from different resources with different
granularity.** `summaries` takes a start and an end and answers for the whole
span in one request per member — so the full `historyDays` window is re-read on
every run, because asking for thirty days costs exactly what asking for one day
costs, and re-reading repairs a day collected while somebody's editor was
offline. `durations` takes a single `date`, so the AI figures cost one request
per member *per day*. Only the most recent `aiDaysPerRun` days are collected each
run, which means **AI history accumulates forwards from the day the option was
switched on rather than being backfilled**. A chart of it starting in the middle
is the design, not a bug.

## Rate limits and cost

Every request goes through the shared provider gateway: a per-host concurrency
cap, retry with jittered backoff, a circuit breaker, and pacing driven by the
provider's own rate-limit headers. The request allowance is WakaTime's own —
`requestBudgetPerRun`, 500 by default, room for about 120 members with the AI
figures on or 500 without — and nothing else in the snapshot pass draws on it,
so a large organisation costs the pass its coding time and never a repository
snapshot. A WakaTime pass costs, per snapshot run:

- 2 requests to resolve the dashboard and its members — **once per process**,
  since the membership is memoised for the life of the enricher.
- 1 request per member for the whole coding-time window.
- `aiDaysPerRun` requests per member when AI collection is on.

## Identity: the reason a row adds up

A person's coding time arrives under a **WakaTime username**. Their commits
arrive under a commit-author e-mail or a GitHub login, their tickets under an
Atlassian `accountId`, and none of the three matches the others. Keyed by
account, the same human occupied three contributor rows that each held a third
of the story.

So a contributor row is a **person**, not an account, and the **Identities** tab
is where a person is defined:

- An account whose e-mail matches a catalog `User` profile is linked
  automatically, because that is the same rule the catalog itself uses to decide
  who somebody is.
- Everything else is *offered* as a ranked suggestion — a shared address before
  the `@`, an identical display name, a username that matches the directory
  address, a partial name match — and linked only when a person confirms it.
- **Nothing is ever merged on a name resemblance alone.** Two people who share a
  surname would silently become one contributor, and a merge nobody asked for is
  far harder to notice than a row that stayed separate.
- A manual link is never overwritten by the automatic rule. The reconciliation
  task runs on every ingestion pass, and quietly undoing somebody's correction is
  the single failure that would make the screen pointless.

Links are applied **when a row is built**, not when a measurement is taken, so
correcting a link today fixes last March's numbers too.

An account nobody has linked still gets a row of its own, keyed
`<source>:<sourceKey>`. Hiding it would hide every bot, every service account
and everybody nobody has got round to linking — which are exactly the rows that
show the linking still needs doing.

## What WakaTime cannot answer

- **Nothing before the plan's retention.** A request for last March comes back
  covering a shorter period on a free plan, which is why every measurement
  carries the window it actually covers rather than the window that was asked
  for.
- **Nothing for somebody without the editor plugin installed.** They are absent
  from the WakaTime side entirely, and their contributor row shows an em dash
  rather than zero hours.
- **No per-project language or editor breakdown.** The summaries resource reports
  those per person per day, not per project, so `WakaTimeProjectMetrics` is
  deliberately a smaller shape than `WakaTimeMetrics`. Inventing a per-project
  breakdown would be inventing a number.
- **No AI figures without the durations resource.** When it refuses — a plan that
  does not serve it, an editor plugin too old to report it — the AI fields stay
  `null`, which says "not collected". Zeros would say nobody used AI, which is a
  different and false claim.
