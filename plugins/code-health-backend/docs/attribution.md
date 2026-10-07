# Attribution — who a commit, a build and a review belong to

Every figure on the contributors table is read as a statement about a person,
so the question of *whose* row a fact lands on is the whole of the metric. The
providers answer that question badly, in the same way, for the same reason: the
person who merges a pull request is the person their APIs stamp on everything
the merge produces. Taken at face value, that puts every squash commit, every
merge commit and every post-merge pipeline run on the row of whoever presses
the button — and on a team where one or two people complete most pull requests,
the dashboard says they wrote everything.

This document is the rule book. Nothing here guesses: every rule below is
decided from a fact the provider reports, and where a provider reports nothing
the figure is left as the provider stamped it rather than invented.

## Commits

A commit is credited to its **author** — the person git recorded as having
written it, which is what both providers report and what `git log` shows.
Three kinds of commit are treated differently, and all three are commits a
**merge** produced rather than commits a person wrote:

| The merge was a… | What lands on the branch | What is stored |
|---|---|---|
| **Squash** | One new commit carrying the whole pull request, stamped with whoever the provider chose | Credited to the **pull request's author**. On Azure DevOps the stamp is whoever pressed *Complete*; on GitHub it is already the author, and the rule is a no-op |
| **Rebase** | The pull request's commits rewritten onto the branch, each with its own author | Kept as they are: git preserved the authors, and the rewrite gave them new committer dates at the merge, which is what the branch history returns them by, so they land under the right people |
| **Merge commit** | The pull request's commits as they were, plus one commit with two parents joining them | The merge commit is **not counted at all**, and the pull request's own commits are |

A merge commit carries no work of its own. Its diff against the first parent is
the sum of the commits it joins, so counting it credits the merger with a
phantom commit and the author's entire churn a second time. It is dropped
whether or not a pull request produced it: a `git merge` pushed by hand is
recognised the same way.

### How the merge is recognised

| Provider | Merge commit | Squash versus rebase |
|---|---|---|
| **GitHub** | `parents.totalCount` on the commit — two or more is a merge | Not needed: both leave the commit's author correct |
| **Azure DevOps** | The pull request's `completionOptions.mergeStrategy` (`noFastForward`, `rebaseMerge`), or the boolean `squashMerge` it replaced, or — with no options at all — the plain merge Azure DevOps performs by default. A commit no pull request names is recognised by its **message**, because no list endpoint reports a parent count: the forms git writes itself (`Merge branch …`, `Merge remote-tracking branch …`, `Merge pull request …`, `Merge tag …`) | `squash` against `rebase` in the same field |

Azure DevOps' own `Merged PR 123: …` subject is deliberately **not** treated as
evidence of anything. It is written on a squash commit and on a merge commit
alike, so on its own it proves nothing; the pull request that produced the
commit decides. A completion strategy this plugin does not recognise keeps
whatever the provider stamped, because guessing either way could lose work.

### Why the pull request's commits have to be fetched

Ingestion reads the default branch's history a window at a time and records a
day as fetched once a window has covered it. A commit brought in by a **merge
commit** keeps the date it was committed on — typically days before the merge —
so the branch history for the day of the merge never returns it, and the day it
was committed was fetched *before it was on the branch*. Without a second look,
nothing would ever see it: the merge commit would be dropped, and the work
would vanish from everybody's row.

So for every pull request merged with a merge commit, its commits are asked for
directly and stored **under the dates they were committed**, deduplicated by
identifier against anything the history already returned. On GitHub that is one
extra GraphQL document per page of merged pull requests, plus one per further
hundred commits a single pull request carries beyond its first. On Azure DevOps
it is one request per such pull request for the commit list, and one more per
hundred commits to read their change counts, which the list does not carry.
Both walk a pull request's commits to the end: the ones past the first page
were committed on days already fetched, and nothing else will ever return them.

A squash or a rebase needs none of this: both put commits dated at the merge on
the branch, and those the history already returns.

### What this cannot do

- **Multi-author squashes.** A squash collapses everybody's commits into one,
  and git itself no longer knows who wrote what. The pull request's author gets
  the credit, which is what every other tool reading the same history reports.
- **A merge pushed by hand loses its constituent commits.** A merge commit is
  dropped whether a pull request produced it or not, but only a pull request
  can be asked for the commits it brought in. A long-lived branch merged
  locally and pushed, whose commits were committed on days already walked, is
  invisible on an install whose backfill has passed those days: the work is
  counted on nobody's row, where an earlier release counted it on the pusher's.
  That is a deliberate trade, not an oversight. On a default branch the common
  merge commit that no pull request claims is a `git pull` merge, and its diff
  against its first parent is *other people's* commits — already on the branch
  and already counted under their authors — so keeping it would credit whoever
  pulled with everyone else's work, which is the misattribution this rule
  exists to remove, and it would fall on whoever pull-merges most often. The
  same-day `git pull` that merges a person's own local commits is unaffected
  either way, since those commits fall in the same window as the merge.
- **A merge and its pull request on opposite sides of a window boundary.** The
  two happen within seconds of each other, so it is rare, and a commit no pull
  request in the same window claims is still dropped when it is a merge commit
  and still kept under its author when it is not.
- **Azure DevOps commits with no pull request and no parent count** are judged
  by their message. A hand-written subject that starts exactly like git's own
  merge subject would be mistaken for a merge commit; nobody writes one.

## Pipeline runs

A run is credited to the **author of the change it built**, decided in this
order from the commit the run reports having built (`head_sha` on GitHub,
`sourceVersion` on Azure DevOps):

1. The author of the **pull request whose merge produced that commit**.
2. Else the author of **that commit**, as attributed above.
3. Else whoever the provider says **requested** the run — which for a direct
   push, a scheduled run or a pull request build is the person who pushed, and
   so is right anyway.

The post-merge run on the default branch is the case that matters: the
provider reports it as requested by whoever merged, and it built the author's
change.

### The success rate

`pipelineSuccessRate` divides the runs that **succeeded** by the runs that
**reached a verdict** — succeeded or failed. A run cancelled because a newer
push superseded it, skipped by a path filter, or still in progress is neither,
and counting it against somebody turns a busy afternoon under a workflow that
cancels in-progress runs into a bad success rate. `pipelineRuns` still counts
every run; `pipelineRunsSucceeded` and `pipelineRunsFailed` carry the two
verdicts. The fleet figure on the Insights tab divides the same way.

## Reviews

A review is credited to the person who **cast a vote on somebody else's pull
request**. Two things that look like reviews are not:

- **The author's own vote.** Azure DevOps lets an author vote on their own
  pull request unless a policy forbids it, and GitHub lets one comment; neither
  is a review, and counting it would let an author pad their figures by
  replying to their reviewers.
- **A reviewer who never voted.** Azure DevOps lists everyone a policy or a
  person added, most of whom never look. A reviewer with no vote is not counted
  as having reviewed anything. GitHub has no such state: a review exists there
  only once it is submitted, and a submitted comment-only review counts.

## Sonar

Sonar measures a **project**, not a person, and nothing on a contributor row
changes that. The row carries the totals over the repositories the person
**committed to or merged a pull request into** in the window — what the code
they worked on looks like, not what they wrote — so two people on the same
repository show the same figure. Reviewing a repository's pull requests or
triggering its pipeline does not count as working on its code: counting either
put every repository's bugs and debt on the row of whoever reviews the most,
which is usually the person who also merges the most.

## Upgrading from a release that attributed differently

The rows an earlier release stored are wrong in exactly the way the rules above
correct, and nothing can repair them in place: the facts the rules need (parent
counts, merge commits, built commits) were never stored. On its first start,
the backend therefore sends every tracked repository's ingestion cursors back
to where a fresh install starts, forgets the days they claimed as fetched, and
removes the commits, pull requests, reviews and runs the walk re-collects.
Releases and tags come from the daily snapshot and stay; a repository that has
left the catalog is never ingested again, so its history is kept as it was.

The dashboard behaves as it does after installation — the last day is
answerable from the first run, and wider ranges unlock as the backfill advances
at the rate `requestBudgetPerRun` and the schedule allow. That is a visible
cost, paid once.
