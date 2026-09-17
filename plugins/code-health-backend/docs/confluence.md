# Confluence metrics

The Code Health backend can measure what a team writes down, alongside what it ships. This page is
the operator's reference: what each number means, exactly how it is derived, what Confluence cannot
answer, and why.

Nothing here reaches a browser. The Atlassian credential lives in backend configuration, the sweep
runs on the daily snapshot schedule, and the dashboard reads the result out of the plugin's own
database like every other figure.

## Configuration

Jira and Confluence share one Atlassian Cloud site, one account and one API token, so they are
configured together. Configuring the site is the whole of the work — both products light up unless
one is switched off explicitly.

```yaml
codeHealth:
  atlassian:
    baseUrl: https://acme.atlassian.net   # no trailing slash, no /wiki
    email: ${ATLASSIAN_EMAIL}
    apiToken: ${ATLASSIAN_API_TOKEN}
    maxResultsPerRun: 2000
    historyDays: 90
    confluence:
      enabled: true
      spaceKeys: []      # empty means every space the token can read
      staleAfterDays: 180
      maxPagesPerRun: 500
      maxPagesForVolume: 150
      maxAnalyticsLookups: 200
      # Confluence's own allowance per snapshot pass; the default is what the
      # three caps above can need.
      requestBudgetPerRun: 2700
```

`baseUrl` is the *site*, not the wiki. Confluence Cloud hangs off a `/wiki` context path on the same
host as Jira, and the plugin adds it. A base URL that already ends in `/wiki` produces `/wiki/wiki/...`
and 404s on every request.

The token is a standard Atlassian API token, used as HTTP Basic `email:token`. It needs read access
to the spaces you want measured and nothing more.

### Scoping

`spaceKeys` is worth setting, and not only for tidiness. A CQL query carrying `space in (...)` is
answered from the search index, so restricting the sweep reduces the cost of the expensive per-page
walks rather than merely filtering their results afterwards.

An allow-list is also a statement about which spaces this plugin reads *at all*. A repository whose
entity annotates a space outside the list is reported as untracked rather than quietly overriding the
setting. Whether an annotation names a listed space is decided by asking Confluence, not by comparing
spellings, so a space renamed by an administrator is one space whichever of its keys each side uses.

### The catalog annotation

A repository is joined to a space by its catalog entity:

```yaml
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: gateway
  annotations:
    confluence.io/space-key: ENG
```

Nothing is guessed from a repository's name. An entity with no annotation has no space, and inventing
one would attribute another team's documentation to this repository — a mistake that is invisible on a
dashboard showing only totals.

Two components may annotate the same space. The space is measured once and both rows carry the same
figures.

**A renamed space is queried by the key it was created with.** Confluence Cloud lets an administrator
change a space's key, and the new one becomes the space's *alias*: it is what the space's URL shows,
so it is what somebody copying a key into an annotation — or into `spaceKeys` — writes down. The
spaces API resolves either key, but CQL matches only the original one, so every query is built from
what the spaces API reports rather than from the annotation. Before this, a lookup indexed by the
original key missed every alias, and each count then ran against a key CQL does not know and came
back as a quiet quarter, with nothing said. An annotation naming a key Confluence lists no space for
is now logged at `warn`, with the entities that carry it.

## What is measured, and how

### Per contributor

Keyed by Atlassian `accountId`, lowercased. Everything covers the trailing `historyDays` window
ending at the moment the run started; the payload carries that window so the dashboard can label it.

| Figure | How it is derived |
|---|---|
| `pagesCreated` | CQL sweep of `type in (page, blogpost)` changed in the window, keeping the hits whose `history.createdDate` also falls inside it, credited to `history.createdBy`. |
| `blogPostsCreated` | The same sweep, for hits of type `blogpost`. |
| `pagesEdited` | Distinct pages the account authored at least one version of. |
| `pageVersionsAuthored` | Versions authored, from `GET /wiki/api/v2/pages/{id}/versions` — one request per page in the sweep. |
| `commentsWritten` | CQL count-and-sweep of `type = comment` created in the window, credited to its creator. |
| `attachmentsAdded` | The same, for `type = attachment`. |
| `spaceKeys` | Every space the account touched, de-duplicated and lowercased. |
| `wordsAdded` / `wordsRemoved` | See [Written volume](#written-volume-why-not-lines). |
| `pageViews` | See [Page views](#page-views-are-premium-only). |

**Why the version walk exists.** A CQL search reports only two people for any page: the one who
created it and the one who touched it last. A page edited five times by three people would otherwise
be attributed entirely to one of them. The version list is what makes per-person attribution correct,
and it is also the single most expensive thing this integration does — one request per page, bounded
by `maxPagesPerRun`.

**Why `pagesEdited` can double-count.** When identity linking maps two Atlassian accounts to one
person, their payloads are summed. A page edited from both accounts inside one window therefore counts
twice. Shipping every page id to make the union exact would put an unbounded array on every row to fix
a case that needs somebody to hold two Atlassian logins and use both on one page in ninety days.

### Per space

Attached to every repository whose entity names the space.

| Figure | How it is derived |
|---|---|
| `totalPages` | CQL `type = page and space in (KEY)`, read from `totalSize`. One request. |
| `pagesCreated` / `pagesEdited` | The same query with a `created` / `lastmodified` range. One request each. |
| `blogPostsCreated`, `commentsWritten`, `attachmentsAdded` | The same, per type. One request each. |
| `stalePages` | `type = page and space in (KEY) and lastmodified < <now − staleAfterDays>`. One request. |
| `stalestPage` | The same query ordered `by lastmodified asc`, limit 1. |
| `lastActivityAt` | `type in (page, blogpost)` ordered `by lastmodified desc`, limit 1. |
| `contributors` | Distinct creators and last editors across the space's changed content. Needs a walk, so it is **null** whenever the walk hit `maxResultsPerRun`. |
| `parentlessPages` | `GET /wiki/api/v2/spaces/{id}/pages`, counting pages with no `parentId`, excluding the space homepage. **Null** when the space has more pages than the walk is allowed. |

**Why counts are cheap and walks are not.** A CQL search reports `totalSize` for the whole answer even
when asked for a single row, so "how many pages went stale" costs one request whatever the answer.
Anything needing the rows themselves — distinct contributors, page parents — costs a walk, and a
truncated walk under-reports in a way that looks exactly like a healthy space. Those figures go null
instead.

**Why the homepage is excluded.** A space homepage has no parent by definition. Counting it would put
every space in the fleet one page into the red on a metric that is supposed to be actionable.

## Written volume: why not "lines"

Confluence has no notion of a line, and this is not a matter of finding the right endpoint. A page is
a body document — XHTML "storage" format, or ADF — and the REST API serves **no diff between two
versions** and no per-edit change size anywhere in either API generation. "Lines changed" cannot be
derived from anything Confluence returns.

What can be measured exactly is the *size of a body*. So the enricher measures **words**:

1. It takes the page's version list, ascending.
2. For each version authored inside the window, it needs the body of that version and of the one
   before it. The v2 versions endpoint is asked for `body-format=storage` and its bodies are used when
   it serves them; otherwise each body is fetched from
   `GET /wiki/rest/api/content/{id}?status=historical&version=N&expand=body.storage`.
3. Markup is stripped, CDATA sentinels are removed first so code inside a snippet macro still counts,
   and a word is a run of non-whitespace.
4. `wordsAdded` is the positive part of the difference against the previous version; `wordsRemoved` is
   the negative part. Version 1 has no predecessor, so a page created in the window counts whole.

The unit is carried on the payload as `volumeUnit`, exactly as `ContributorSummary.churnUnit` is —
because a run that could not afford to fetch bodies has measured *nothing*, and a `0` there would read
as "this person wrote nothing" rather than "nobody counted". The unit is decided by whether the volume
was measured, never by whether it came back above zero: a week spent reviewing other people's pages is
a real measurement of zero words.

### The three things this figure gets wrong, stated plainly

- **A same-length rewrite measures as zero.** It is a length delta, not a diff. Rewriting a paragraph
  into a better paragraph of the same size is real work that this cannot see. A real figure would mean
  shipping a text-diff implementation and running it over every version of every page in the window.
- **CJK text measures far smaller than it reads.** A word is a run of non-whitespace, and Chinese,
  Japanese and Thai are not space-separated. Counting characters instead was considered and rejected:
  it distorts the same comparison in the other direction, making an English page look five times the
  size of a CJK page saying the same thing, and it is far more sensitive to whatever markup survives
  stripping.
- **Macro parameter values count as prose.** A small over-count nobody has been able to notice.

### Cost, and why a page is skipped whole

Measuring an edit needs the body either side of it, so a page with many versions inside the window is
the expensive case. A page needing more than twelve body fetches is skipped **entirely** rather than
measured partially: half a page's edits attributed and half dropped produces a figure that is wrong in
a direction nobody can see, where an unmeasured page at least says so. `pagesMeasuredForVolume` says
how many pages the figure actually came from.

`maxPagesForVolume` bounds how many pages a run measures at all. Raise it to cover more of a large
wiki, at a cost of roughly two to four requests per page.

## Page views are Premium-only

`GET /wiki/rest/api/analytics/content/{id}/views` and `.../viewers` are **Confluence Cloud Premium**
features. On a Standard site they answer 403 or 404 whatever the credential, and there is no setting to
change that: it is the plan.

The plugin treats the first refusal as a verdict about the whole site and stops asking, because a plan
does not change between two requests in one pass and re-probing would turn one honest "not available"
into a few hundred refused requests a run. The verdict is remembered for the life of the process.

`pageViews` is then **null**, never `0`, and the payload carries `analytics` so the dashboard can say
which of three things happened:

| `analytics` | What the UI says |
|---|---|
| `measured` | The figure is real. |
| `unavailable` | The API refused. Premium-only; nothing the team writes will make the number appear. |
| `not-measured` | The run did not ask — its analytics allowance went elsewhere. Tomorrow's run may report it. |

Views are attributed to whoever *wrote* the page. That is the only attribution the data supports:
nobody reads a page "for" its last editor, and Confluence reports readers as a count rather than as
people. `pagesMeasuredForViews` carries the denominator, so a views-per-page rate survives two accounts
being merged into one person.

## What Confluence cannot answer

- **Backlinks.** Confluence Cloud REST has no endpoint answering "what links here", in either API
  generation. The classic "orphan page" report meant *no parent and no inbound links*; only half of
  that is measurable, so the field is named `parentlessPages` for the half that is, rather than
  claiming an orphan count it cannot compute.
- **Inline versus footer comments, by date.** CQL has one `comment` type covering both. The v2
  endpoints that separate them (`/footer-comments`, `/inline-comments`) take no date filter, so
  splitting the figure would mean walking every comment on the site to find the ninety days that
  matter. The figure covers both kinds together.
- **Label coverage.** CQL has no "has any label" predicate — only `label = "x"` — and the v2 page
  listing does not carry labels. Measuring what share of a space is labelled would cost one request per
  page, which buys less than the same requests spent on written volume.
- **Per-day history.** Every other figure in this plugin moves with the range picker. Confluence's do
  not: the sweep measures one trailing window fixed by `historyDays`, and the payload carries that
  window so the dashboard can say so rather than let a 90-day figure sit unlabelled beside a
  seven-day one. Confluence *can* answer historically — CQL takes arbitrary date ranges — so a future
  version could collect per day; it would multiply the per-page walks by the number of days, which is
  why this one does not.
- **A team's reading, on Standard.** See above.

## Identity linking

People are identified by their Atlassian `accountId`, normalised the same way every other source's key
is. The sweep reports every account it saw to the Identities screen — including accounts that only ever
appear as a middle version of a page, which the version list reports as a bare id with no name. Those
are resolved through `GET /wiki/rest/api/user/bulk` where the site allows it; when it does not, the
account is still listed, by id.

This matters more here than anywhere else in the plugin. A Confluence account rarely carries the
address a person's commits do, and on a site with managed accounts it carries no address at all. But
the *same* `accountId` identifies that person in Jira — so linking it once makes a Confluence page, a
Jira ticket and a commit land on one contributor row.

When several accounts resolve to one person, their payloads are summed. Every field is a count or a
total for exactly that reason; where the dashboard wants a rate it is derived from a numerator and a
denominator that are both carried, because a mean of two means is not a mean.

## Cost model

Per run, roughly:

| Work | Requests |
|---|---|
| The contributor sweep | one per 100 changed pages and blog posts, plus the same for comments and attachments |
| Version histories | one per page, up to `maxPagesPerRun` |
| Written volume | up to twelve per page, up to `maxPagesForVolume` pages |
| Page views | up to `maxAnalyticsLookups`, or exactly one on a Standard site |
| Each space | ten, plus one per 100 changed items and one per 250 pages for the parent walk |

Everything goes through the shared provider gateway, so it shares the concurrency cap, retry policy
and circuit breaker with version control. The request allowance is Confluence's own —
`requestBudgetPerRun` — and nothing else in the snapshot pass draws on it. The sweep used to spend
the repository loop's budget, before a single repository was captured, and one moderately large space
could leave the loop with nothing; now a large space costs the pass its Confluence figures and nothing
else. The default is derived from the caps above so the two cannot disagree: one version history for
each of 500 pages, up to twelve bodies for each of 150 pages measured for volume, 200 analytics
lookups, and 200 for the sweeps that find the pages and the counts behind a few spaces' reports —
2,700. A run that exhausts its allowance keeps what it collected and logs that it stopped early — a
partial window is a real measurement of its own days — and the snapshot pass warns, naming the
setting.

## Verified against the API contract, not against a live site

The endpoints, query parameters and response shapes above were implemented from Atlassian's published
API contracts and are exercised against a real HTTP server in the test suite, but they have not been
run against a live Confluence Cloud instance. The parsers are written to survive a response that does
not match — a missing field produces a null, not a crash — and three behaviours in particular are worth
watching on a first deployment:

- whether `GET /wiki/api/v2/pages/{id}/versions` serves bodies when asked for `body-format=storage`
  (if it does, written volume costs one request per page instead of one per version);
- whether `GET /wiki/rest/api/search` honours `expand=content.history,content.version,content.space`
  (without it there is no creator, and pages would be attributed to their last editor);
- whether `GET /wiki/rest/api/user/bulk` is available on your site (a cosmetic lookup; failing it only
  leaves an account listed by id).

Each has a visible symptom in the logs at `debug`, and none of them fails a run.
