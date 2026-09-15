# @rios0rios0/backstage-plugin-code-health-backend

The Backstage **backend** plugin of the Code Health suite.

It discovers repositories from the Backstage catalog, authenticates through the host application's
existing `integrations` configuration, ingests a year of their history in a rate-limited background
job, stores it in the Backstage database, and serves it to the frontend plugin under
`/api/code-health`.

Install it alongside `@rios0rios0/backstage-plugin-code-health`:

```ts
// packages/backend/src/index.ts
backend.add(import('@rios0rios0/backstage-plugin-code-health-backend'));
```

See the [repository README](https://github.com/rios0rios0/backstage-plugin-code-health#readme)
for configuration, the scheduled tasks and the operational notes.

## Trends and ownership

Three routes answer a question about one row of the dashboard rather than about the fleet:

| Route | Answers |
|---|---|
| `GET /v1/contributors/:key/trend?from&to&bucket` | One person's history, bucketed by `day`, `week` or `month` — the same row the contributors table shows, aggregated over each bucket, with the productivity score it earned |
| `GET /v1/repositories/:id/trend?from&to&bucket` | One repository's history on the same terms, with its health score |
| `GET /v1/contributors/:key/repositories?from&to` | The repositories the person is **responsible for** |

`:key` is a contributor row's key, so it is percent-encoded: a linked person's key is a catalog
reference such as `user%3Adefault%2Fjane`, and an unlinked account's is `vcs%3Ajane%40acme.com`.

Every bucket of a person's trend is scored against **the fleet in that same bucket**, not against
the whole window. A score is a share of the top figure anybody recorded in the same period, so a
quiet week beside one exceptional week reads as a quiet week rather than as a collapse. A bucket the
person did nothing in still gets a point — an all-zero row carrying their name — because closing
over a fortnight off would draw it as a shorter, busier month.

Sonar, compliance and badge figures on a trend come from the most recent daily snapshot at or before
each bucket's last day, filled forward when a snapshot task missed a run. None of them can be
backfilled, so those series begin at the first snapshot after installation.

Responsibility is the catalog's `spec.owner`, read by discovery and stored on the repository row
beside the other catalog facts. It is matched against the person's own `User` entity, every `Group`
they are a member of and the parents of those groups — the same expansion Backstage's own identity
performs. A row nobody has linked to a catalog user owns nothing and says so with an empty `owners`,
because "owns no repositories" and "not attached to anybody yet" are different conversations.

## Administrators

One thing on the dashboard is not a read: an administrator can start the history collection over and
choose how far back it reaches.

```yaml
codeHealth:
  administrators:
    - user:default/jane
    - group:default/platform
```

Entity references of catalog users or groups. A bare name defaults to a user, so `jane` means
`user:default/jane`. **The list is empty by default, which means nobody** — a reset drops every
collected commit, pull request, review and build and re-walks the providers, which is hours of
rate-limited requests, so it is not something an install should acquire by upgrading.

There are two levers and both have to open:

- **The list** is what makes the restriction real on a stock install. Backstage's default permission
  policy allows everything, so the framework alone cannot say "administrators only".
- **The permission** `code-health.ingestion.reset` is what lets an installed policy, or the RBAC
  plugin, veto the reset — including for somebody the list names. It is exported as
  `codeHealthIngestionResetPermission` so a policy can name what it is deciding about.

| Route | Answers |
|---|---|
| `GET /v1/access` | `{ canResetIngestion, retentionDays }` for the caller. Never a 403: a page asks this before deciding whether to draw a button, and a service principal or an anonymous decision simply reads `false` |
| `POST /v1/ingestion/reset` | Body `{ days }`, a whole number from 1 to the configured `codeHealth.ingestion.retentionDays`. `403` when the caller is not an administrator, `400` when `days` is out of range |

A reset, in one transaction per run, sends every **tracked** repository back over the reach that was
asked for: it deletes the commits, pull requests, reviews and builds inside the reach, forgets the
days inside it those repositories claimed as fetched, and sets the backfill floor to the reach. It
then triggers the ingestion task. The deletes stop at the reach on purpose — the walk never goes
below its floor, so anything older that was deleted would never come back, and a thirty-day reach
would silently cost the other eleven months.

What it **keeps**: every row older than the reach; snapshots, releases and tags, which come from the
daily snapshot rather than from the walk and which nothing would ever put back; and the history of a
repository that has left the catalog, which is never ingested again.

Afterwards the dashboard behaves as it does after installation — the last day is answerable from the
first run, and wider ranges unlock as the backfill advances.

## Optional integrations

Each one is absent unless it is configured, and the frontend asks which are on before it draws a
column. Every reference below covers exactly what is measured, how each number is derived, and what
the provider cannot answer:

- [WakaTime](docs/wakatime.md) — coding time, language and editor breakdowns, branches, and AI
  token counts
- [Jira](docs/jira.md) — tickets, interactions, story points, cycle and lead time
- [Confluence](docs/confluence.md) — pages, written volume, comments and page views

All three report people under account systems that agree with neither each other nor the catalog, so
a contributor row is a **person** rather than an account. The `Identities` screen is where an account
is attached to a catalog `User`; the WakaTime reference explains the rules that screen applies, and
they are the same for every source.

That screen is also where an account that is not a person being measured — a build service, a bot,
an outside contributor, a leaver — is **excluded** under one of four reasons. An excluded account
leaves every figure the backend reports: no contributor row, no contribution to a repository's
counters or the fleet cadence, and no part in the fleet reference the relative components of the
productivity score are read against. Nothing is deleted; the exclusion is applied when a row is
built, so including the account again restores every window already collected.
