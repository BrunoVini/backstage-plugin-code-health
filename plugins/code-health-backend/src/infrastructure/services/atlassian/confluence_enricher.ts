import type { LoggerService } from "@backstage/backend-plugin-api";
import type {
  ConfluenceAnalyticsState,
  ConfluenceContributorMetrics,
  ConfluencePageReference,
  ConfluenceSpaceMetrics,
  ConfluenceWindow,
} from "@rios0rios0/backstage-plugin-code-health-common";
import type { ConfluenceSettings } from "../../../domain/entities/confluence_settings";
import {
  CONFLUENCE_MAX_VOLUME_FETCHES_PER_PAGE,
  confluenceStaleCutoff,
  confluenceWindowFor,
} from "../../../domain/entities/confluence_settings";
import type { AtlassianSettings } from "../../../domain/entities/ingestion_settings";
import { isAtlassianConfigured } from "../../../domain/entities/ingestion_settings";
import {
  CircuitOpenError,
  ProviderRequestError,
} from "../../../domain/entities/provider_errors";
import { BudgetExhaustedError } from "../../../domain/entities/request_budget";
import type { TrackedRepository } from "../../../domain/entities/tracked_repository";
import type { ConfluenceEnricher } from "../../../domain/services/confluence_enricher";
import type {
  IdentityObserver,
  ObservedIdentity,
} from "../../../domain/services/identity_resolver";
import type { EnrichmentContext } from "../../../domain/services/snapshot_enricher";
import type { AtlassianClient } from "./atlassian_client";
import { AtlassianNotAvailableError } from "./atlassian_client";
import type {
  ConfluenceContent,
  ConfluenceSpace,
  ConfluenceUser,
  ConfluenceVersion,
  CqlQuery,
  WrittenVolume,
} from "./confluence_queries";
import {
  analyticsViewsPath,
  buildCql,
  countWords,
  historicalBodyPath,
  isWithin,
  parseBulkUsers,
  parseContentBody,
  parsePageListing,
  parseSearchPage,
  parseSpacePage,
  parseVersionPage,
  parseViewCount,
  searchPath,
  spacePagesPath,
  spacesPath,
  toObservedIdentity,
  usersBulkPath,
  versionsPath,
  volumeBetween,
} from "./confluence_queries";

/** CQL search rejects anything above 100 per page. */
const SEARCH_PAGE_SIZE = 100;

/** The v2 listing endpoints cap out at 250. */
const LISTING_PAGE_SIZE = 250;

const VERSION_PAGE_SIZE = 100;

/**
 * The ceiling on one page's version history.
 *
 * A page edited more than this inside one window is almost always a machine —
 * an automation republishing a status table every hour — and walking its whole
 * history would spend a run's allowance on one row nobody reads.
 */
const MAX_VERSIONS_PER_PAGE = 250;

/** Pages walked per space when counting parentless ones. */
const MAX_SPACE_PAGES = 2_000;

/** Accounts resolved per bulk-user request. */
const USER_BATCH = 100;

interface ContributorDraft {
  pagesCreated: number;
  readonly pagesEdited: Set<string>;
  pageVersionsAuthored: number;
  blogPostsCreated: number;
  commentsWritten: number;
  attachmentsAdded: number;
  readonly spaceKeys: Set<string>;
  wordsAdded: number;
  wordsRemoved: number;
  pagesMeasuredForVolume: number;
  measuredVolume: boolean;
  views: number;
  pagesMeasuredForViews: number;
}

const emptyDraft = (): ContributorDraft => ({
  pagesCreated: 0,
  pagesEdited: new Set<string>(),
  pageVersionsAuthored: 0,
  blogPostsCreated: 0,
  commentsWritten: 0,
  attachmentsAdded: 0,
  spaceKeys: new Set<string>(),
  wordsAdded: 0,
  wordsRemoved: 0,
  pagesMeasuredForVolume: 0,
  measuredVolume: false,
  views: 0,
  pagesMeasuredForViews: 0,
});

/**
 * Whether an error means "this site does not serve that" rather than
 * "something went wrong".
 *
 * 403 and 404 are the two answers a Confluence Standard site gives for the
 * analytics endpoints, and which one arrives depends on the site's plan rather
 * than on anything the caller did — so both have to count. The gateway has
 * already decided neither is worth retrying.
 */
const isNotAvailable = (error: unknown): boolean =>
  error instanceof AtlassianNotAvailableError ||
  (error instanceof ProviderRequestError &&
    (error.status === 403 || error.status === 404));

/** Whether an error means the run is over rather than that one call failed. */
const isRunOver = (error: unknown): boolean =>
  error instanceof BudgetExhaustedError || error instanceof CircuitOpenError;

/** What one spaces lookup answered, addressed by whichever key was asked. */
interface ResolvedSpaces {
  /** False when the lookup itself failed, so an unmatched key proves nothing. */
  readonly complete: boolean;
  readonly find: (key: string) => ConfluenceSpace | null;
  /** The key CQL matches: the space's original one, or the key as written. */
  readonly keyFor: (key: string) => string;
  /** What to compare two keys by: the space id, or the key when unresolved. */
  readonly identityOf: (key: string) => string;
}

const toPageReference = (
  content: ConfluenceContent | null,
): ConfluencePageReference | null =>
  content === null
    ? null
    : {
        id: content.id,
        title: content.title,
        url: content.url,
        lastModifiedAt: content.lastModifiedAt,
      };

export interface ConfluenceEnricherOptions {
  readonly client: AtlassianClient;
  readonly atlassian: AtlassianSettings;
  readonly settings: ConfluenceSettings;
  readonly identities: IdentityObserver;
  readonly logger: LoggerService;
  /** Injected so one run measures one window. Defaults to the wall clock. */
  readonly now?: () => Date;
}

/**
 * Reads what a team wrote in Confluence.
 *
 * The shape of this collector is dictated by one asymmetry in the Confluence
 * API: a CQL search reports the *size* of any answer for the price of one
 * request, but it names only a page's creator and its most recent editor.
 * Everything cheap here is therefore a count, and everything that had to
 * attribute work to a person cost a walk — which is why the counts are plain
 * numbers while the attributed figures go null the moment a cap bites.
 *
 * Three things this deliberately does not do, each because the API cannot:
 *
 * - **Lines.** Confluence serves no diff between two versions and no change
 *   size anywhere in either API generation. Written volume is measured in
 *   words, from the length of the body either side of an edit, and the unit is
 *   carried on the payload so the dashboard never prints a figure it did not
 *   measure.
 * - **Page views on a Standard site.** The analytics API is Confluence Cloud
 *   Premium only. The first refusal is treated as a verdict about the whole
 *   site and remembered, because a plan does not change between two requests in
 *   one pass, and views stay null rather than becoming zero.
 * - **Backlinks.** Nothing in Confluence Cloud REST answers "what links here",
 *   so what the space report calls `parentlessPages` is exactly that, and is
 *   not dressed up as an orphan count.
 */
export class ConfluenceApiEnricher implements ConfluenceEnricher {
  /**
   * Whether the analytics API answered, remembered for the life of the process.
   *
   * Premium is a property of the site, not of a page, so one refusal settles it
   * for every later lookup — including the ones a *different* method in the same
   * pass would otherwise make. Re-probing per space would turn one honest "not
   * available" into a few hundred refused requests a run.
   */
  private analyticsAvailable: boolean | null = null;

  constructor(private readonly options: ConfluenceEnricherOptions) {}

  async fetchContributors(
    context: EnrichmentContext,
  ): Promise<ReadonlyMap<string, ConfluenceContributorMetrics>> {
    if (!this.isEnabled()) return new Map();

    const { settings, atlassian } = this.options;
    const window = confluenceWindowFor(atlassian.historyDays, this.now());
    const drafts = new Map<string, ContributorDraft>();
    const users = new Map<string, ConfluenceUser>();
    const wire: ConfluenceWindow = {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
    };

    const remember = (user: ConfluenceUser | null): string | null => {
      if (user === null) return null;
      // The richest record wins. The same account arrives from CQL carrying a
      // display name and from the v2 version list as a bare id, and whichever
      // happened to come last should not decide what the Identities screen
      // shows.
      const known = users.get(user.accountId);
      if (known === undefined || (known.displayName === null && user.displayName !== null)) {
        users.set(user.accountId, user);
      }
      return user.accountId;
    };

    const draftFor = (accountId: string): ContributorDraft => {
      const existing = drafts.get(accountId);
      if (existing !== undefined) return existing;
      const created = emptyDraft();
      drafts.set(accountId, created);
      return created;
    };

    let base: string | null = null;

    try {
      // Whatever was configured, as CQL knows it: a key an administrator has
      // changed is matched by the spaces API and not by CQL, and a sweep
      // scoped to the new one would quietly find nothing.
      const configured = atlassian.confluence.spaceKeys;
      const resolved = await this.resolveSpaces(configured, context);
      const spaceKeys = configured.map((key) => resolved.keyFor(key));

      const changed = await this.searchAll(
        {
          types: ["page", "blogpost"],
          ...(spaceKeys.length === 0 ? {} : { spaceKeys }),
          range: { field: "lastmodified", from: window.from, to: window.to },
          // Newest first, so a run that runs out of allowance keeps the days
          // somebody is most likely to be looking at.
          orderBy: { field: "lastmodified", direction: "desc" },
        },
        context,
      );
      base = changed.base;

      for (const content of changed.results) {
        const creator = remember(content.createdBy);
        remember(content.lastModifiedBy);
        const spaceKey = content.spaceKey?.toLowerCase() ?? null;

        // Created inside the window and touched inside the window are two
        // different facts. A page written last year and edited last week is in
        // this sweep, and crediting its author with a creation would be wrong.
        if (creator === null || !isWithin(content.createdAt, window.from, window.to)) {
          continue;
        }
        const draft = draftFor(creator);
        if (content.type === "blogpost") draft.blogPostsCreated += 1;
        else draft.pagesCreated += 1;
        if (spaceKey !== null) draft.spaceKeys.add(spaceKey);
      }

      const pages = changed.results.filter((content) => content.type === "page");
      let volumeMeasured = 0;

      for (const page of pages.slice(0, settings.maxPagesPerRun)) {
        if (context.signal?.aborted) break;

        const versions = await this.versionsOf(page.id, context);
        const inWindow = versions.filter((version) =>
          isWithin(version.createdAt, window.from, window.to),
        );
        const spaceKey = page.spaceKey?.toLowerCase() ?? null;

        for (const version of inWindow) {
          if (version.authorId === null) continue;
          const draft = draftFor(version.authorId);
          draft.pageVersionsAuthored += 1;
          draft.pagesEdited.add(page.id);
          if (spaceKey !== null) draft.spaceKeys.add(spaceKey);
          // Registered with nothing but an id. An account that only ever
          // appears as a middle version is still somebody to link, and leaving
          // it out would make the Identities screen quietly incomplete.
          remember({
            accountId: version.authorId,
            displayName: null,
            email: null,
            avatarUrl: null,
          });
        }

        if (volumeMeasured >= settings.maxPagesForVolume) continue;

        const volume = await this.measureVolume(page.id, versions, inWindow, context);
        if (volume === null) continue;

        volumeMeasured += 1;
        for (const [accountId, written] of volume) {
          const draft = draftFor(accountId);
          draft.wordsAdded += written.added;
          draft.wordsRemoved += written.removed;
          draft.pagesMeasuredForVolume += 1;
          draft.measuredVolume = true;
        }
      }

      for (const [type, field] of [
        ["comment", "commentsWritten"],
        ["attachment", "attachmentsAdded"],
      ] as const) {
        const created = await this.searchAll(
          {
            types: [type],
            ...(spaceKeys.length === 0 ? {} : { spaceKeys }),
            range: { field: "created", from: window.from, to: window.to },
            orderBy: { field: "created", direction: "desc" },
          },
          context,
        );
        base = base ?? created.base;

        for (const content of created.results) {
          const author = remember(content.createdBy) ?? remember(content.lastModifiedBy);
          if (author === null) continue;
          const draft = draftFor(author);
          draft[field] += 1;
          const spaceKey = content.spaceKey?.toLowerCase();
          if (spaceKey !== undefined) draft.spaceKeys.add(spaceKey);
        }
      }

      // Views last, because it is the only step a site can refuse outright and
      // everything above it is worth keeping when one does.
      await this.collectViews(changed.results, window, draftFor, context);
    } catch (error) {
      if (!isRunOver(error)) throw error;
      this.options.logger.info(
        `the Confluence sweep stopped early and kept what it had: ${String(error)}`,
      );
    }

    await this.report([...users.values()], base, context);

    const analytics = this.analyticsState();
    return new Map(
      [...drafts].map(([accountId, draft]) => [
        accountId,
        this.toMetrics(draft, wire, analytics),
      ]),
    );
  }

  async fetchRepositories(
    repositories: readonly TrackedRepository[],
    context: EnrichmentContext,
  ): Promise<ReadonlyMap<string, ConfluenceSpaceMetrics>> {
    const result = new Map<string, ConfluenceSpaceMetrics>();
    if (!this.isEnabled()) return result;

    const { atlassian, settings } = this.options;

    // One entry per space rather than per repository: two components documented
    // in one space share every figure, and asking twice would double the cost
    // to produce two identical answers. Keyed case-insensitively, because a
    // space key is one however an annotation spells it.
    const named = new Map<string, { key: string; repositoryIds: string[]; entityRefs: string[] }>();
    for (const repository of repositories) {
      const key = repository.catalogFacts.confluenceSpaceKey;
      if (key === null) continue;
      const entry = named.get(key.toLowerCase()) ?? { key, repositoryIds: [], entityRefs: [] };
      entry.repositoryIds.push(repository.id);
      entry.entityRefs.push(repository.entityRef);
      named.set(key.toLowerCase(), entry);
    }
    if (named.size === 0) return result;

    // Every key in play is looked up in one request, the configured ones
    // included. A space is matched to the allow-list by what Confluence says
    // it is rather than by spelling, so an annotation carrying a space's new
    // key is recognised as the space the configuration named under its old
    // one — and the other way round.
    const configured = atlassian.confluence.spaceKeys;
    const spaces = await this.resolveSpaces(
      [...configured, ...[...named.values()].map((entry) => entry.key)],
      context,
    );
    const allowed = new Set(configured.map((key) => spaces.identityOf(key)));

    const wanted = [...named.values()].filter((entry) => {
      // A configured allow-list states which spaces this plugin reads at all,
      // so an annotation naming one outside it is honoured as "not tracked"
      // rather than quietly overriding the configuration.
      if (allowed.size > 0 && !allowed.has(spaces.identityOf(entry.key))) return false;
      if (spaces.complete && spaces.find(entry.key) === null) {
        // Measured anyway, because CQL may still know the key — but said,
        // because a space nobody can find is the one case where every count
        // below comes back as a quiet quarter and nothing on screen can tell.
        this.options.logger.warn(
          `Confluence lists no space with the key ${entry.key}, which ` +
            `${entry.entityRefs.join(", ")} name in confluence.io/space-key; ` +
            "its figures will be empty until the annotation names a key or alias " +
            "the token can read",
        );
      }
      return true;
    });
    if (wanted.length === 0) return result;

    const now = this.now();
    const window = confluenceWindowFor(atlassian.historyDays, now);
    const wire: ConfluenceWindow = {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
    };
    const staleBefore = confluenceStaleCutoff(settings, now);
    const users = new Map<string, ConfluenceUser>();
    let base: string | null = null;

    for (const { key, repositoryIds } of wanted) {
      if (context.signal?.aborted) break;

      try {
        const space = spaces.find(key);
        const measured = await this.measureSpace({
          key: spaces.keyFor(key),
          space,
          window,
          staleBefore,
          context,
          users,
        });
        base = base ?? measured.base;

        const metrics: ConfluenceSpaceMetrics = {
          space: { key, name: space?.name ?? null, url: space?.url ?? null },
          window: wire,
          ...measured.metrics,
          staleAfterDays: settings.staleAfterDays,
          analytics: this.analyticsState(),
        };

        for (const repositoryId of repositoryIds) result.set(repositoryId, metrics);
      } catch (error) {
        if (isRunOver(error)) {
          this.options.logger.info(
            `the Confluence space sweep stopped at ${key}: ${String(error)}`,
          );
          break;
        }
        // One unreadable space — renamed, archived, or outside the token's
        // permissions — is not a reason to lose the others.
        this.options.logger.warn(
          `could not measure the Confluence space ${key}: ${String(error)}`,
        );
      }
    }

    await this.report([...users.values()], base, context);
    return result;
  }

  private isEnabled(): boolean {
    const { atlassian } = this.options;
    return isAtlassianConfigured(atlassian) && atlassian.confluence.enabled;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /**
   * What this process has learned about the analytics API.
   *
   * Never having asked and having been refused are reported separately, because
   * only one of them is worth explaining on screen: a refusal is a fact about
   * the site's plan that no amount of writing will change, while "not measured"
   * is a fact about this run that tomorrow's may well contradict.
   */
  private analyticsState(): ConfluenceAnalyticsState {
    if (this.analyticsAvailable === null) return "not-measured";
    return this.analyticsAvailable ? "measured" : "unavailable";
  }

  private toMetrics(
    draft: ContributorDraft,
    window: ConfluenceWindow,
    analytics: ConfluenceAnalyticsState,
  ): ConfluenceContributorMetrics {
    return {
      window,
      pagesCreated: draft.pagesCreated,
      pagesEdited: draft.pagesEdited.size,
      pageVersionsAuthored: draft.pageVersionsAuthored,
      blogPostsCreated: draft.blogPostsCreated,
      commentsWritten: draft.commentsWritten,
      attachmentsAdded: draft.attachmentsAdded,
      spaceKeys: [...draft.spaceKeys].sort(),
      wordsAdded: draft.measuredVolume ? draft.wordsAdded : null,
      wordsRemoved: draft.measuredVolume ? draft.wordsRemoved : null,
      volumeUnit: draft.measuredVolume ? "words" : "none",
      pagesMeasuredForVolume: draft.pagesMeasuredForVolume,
      pageViews: draft.pagesMeasuredForViews > 0 ? draft.views : null,
      pagesMeasuredForViews: draft.pagesMeasuredForViews,
      analytics,
    };
  }

  private async collectViews(
    contents: readonly ConfluenceContent[],
    window: { readonly from: Date; readonly to: Date },
    draftFor: (accountId: string) => ContributorDraft,
    context: EnrichmentContext,
  ): Promise<void> {
    let lookups = 0;

    for (const content of contents) {
      if (lookups >= this.options.settings.maxAnalyticsLookups) break;
      if (this.analyticsAvailable === false) break;

      const creator = content.createdBy?.accountId;
      if (creator === undefined) continue;
      // Views are attributed to whoever wrote the page, which is the only
      // attribution the data supports: nobody reads a page "for" its last
      // editor, and Confluence reports readers as a count rather than as
      // people.
      if (!isWithin(content.createdAt, window.from, window.to)) continue;

      lookups += 1;
      const views = await this.viewsOf(content.id, window.from, context);
      if (views === null) continue;

      const draft = draftFor(creator);
      draft.views += views;
      draft.pagesMeasuredForViews += 1;
    }
  }

  private async report(
    users: readonly ConfluenceUser[],
    base: string | null,
    context: EnrichmentContext,
  ): Promise<void> {
    if (users.length === 0) return;

    const resolved = await this.resolveNames(users, context);
    const identities: ObservedIdentity[] = resolved.map((user) =>
      toObservedIdentity(user, base),
    );

    try {
      await this.options.identities.observe(identities, this.now());
    } catch (error) {
      // The measures are the point of the pass. The Identities screen catching
      // up on the next run is a smaller loss than dropping them.
      this.options.logger.warn(
        `could not record ${identities.length} Confluence identities: ${String(error)}`,
      );
    }
  }

  /**
   * Fills in the names of accounts that only ever appeared as a version author.
   *
   * The v2 version list reports an `authorId` and nothing else, so somebody who
   * edited a page without being its creator or its last editor arrives as a
   * bare account id. That is enough to *count* their work but not enough for
   * anybody to recognise them on the linking screen — which is precisely where
   * somebody would go looking for it.
   */
  private async resolveNames(
    users: readonly ConfluenceUser[],
    context: EnrichmentContext,
  ): Promise<readonly ConfluenceUser[]> {
    const unnamed = users.filter((user) => user.displayName === null);
    if (unnamed.length === 0) return users;

    const found = new Map<string, ConfluenceUser>();
    for (let index = 0; index < unnamed.length; index += USER_BATCH) {
      const batch = unnamed.slice(index, index + USER_BATCH);
      try {
        const body = await this.options.client.get<unknown>(
          usersBulkPath(batch.map((user) => user.accountId)),
          context,
        );
        for (const user of parseBulkUsers(body)) found.set(user.accountId, user);
      } catch (error) {
        // Cosmetic: the account is already counted and already linkable by id.
        // One failure ends the attempt rather than repeating it per batch.
        this.options.logger.debug(
          `could not resolve ${batch.length} Confluence account names: ${String(error)}`,
        );
        break;
      }
    }

    return users.map((user) => {
      const resolved = found.get(user.accountId);
      if (resolved === undefined) return user;
      return {
        accountId: user.accountId,
        displayName: resolved.displayName,
        email: resolved.email ?? user.email,
        avatarUrl: resolved.avatarUrl ?? user.avatarUrl,
      };
    });
  }

  private async searchAll(
    query: CqlQuery,
    context: EnrichmentContext,
  ): Promise<{
    readonly results: readonly ConfluenceContent[];
    readonly base: string | null;
  }> {
    const cql = buildCql(query);
    let base: string | null = null;

    const results = await this.options.client.paginate<ConfluenceContent>({
      context,
      fetchPage: async (cursor) => {
        const start = cursor === null ? 0 : Number(cursor);
        const page = parseSearchPage(
          await this.options.client.get<unknown>(
            searchPath({ cql, start, limit: SEARCH_PAGE_SIZE }),
            context,
          ),
        );
        base = base ?? page.base;

        const consumed = start + page.results.length;
        // `totalSize` is the reliable signal. A short page is the fallback for a
        // response that did not carry one, and asking for one more page after a
        // full one is cheaper than stopping a window halfway through.
        const more =
          page.totalSize === null
            ? page.results.length >= SEARCH_PAGE_SIZE
            : consumed < page.totalSize;

        return { items: page.results, next: more ? String(consumed) : null };
      },
    });

    return { results, base };
  }

  /** How many hits a query has, without fetching any of them. */
  private async count(
    query: CqlQuery,
    context: EnrichmentContext,
  ): Promise<number | null> {
    const page = parseSearchPage(
      await this.options.client.get<unknown>(
        searchPath({ cql: buildCql(query), start: 0, limit: 1 }),
        context,
      ),
    );
    return page.totalSize;
  }

  /** The single result of an ordered query, for "oldest" and "latest". */
  private async first(
    query: CqlQuery,
    context: EnrichmentContext,
  ): Promise<ConfluenceContent | null> {
    const page = parseSearchPage(
      await this.options.client.get<unknown>(
        searchPath({ cql: buildCql(query), start: 0, limit: 1 }),
        context,
      ),
    );
    return page.results[0] ?? null;
  }

  private async versionsOf(
    pageId: string,
    context: EnrichmentContext,
  ): Promise<readonly ConfluenceVersion[]> {
    return this.options.client.paginate<ConfluenceVersion>({
      context,
      limit: MAX_VERSIONS_PER_PAGE,
      fetchPage: async (cursor) => {
        const page = parseVersionPage(
          await this.options.client.get<unknown>(
            cursor ?? versionsPath(pageId, VERSION_PAGE_SIZE),
            context,
          ),
        );
        return { items: page.results, next: page.next };
      },
    });
  }

  /**
   * How many words each author added or removed on one page.
   *
   * Null when the page was not measured at all, which the caller has to keep
   * separate from "measured, and nothing changed". Every edit needs the body
   * either side of it, so the earliest in-window version also needs the one
   * before it — and version 1 has none, which is why a page created inside the
   * window counts its whole body as written.
   */
  private async measureVolume(
    pageId: string,
    versions: readonly ConfluenceVersion[],
    inWindow: readonly ConfluenceVersion[],
    context: EnrichmentContext,
  ): Promise<ReadonlyMap<string, WrittenVolume> | null> {
    if (inWindow.length === 0) return null;

    const ordered = [...versions].sort((left, right) => left.number - right.number);
    const wanted = new Set(inWindow.map((version) => version.number));
    // Each wanted version, plus whichever version immediately precedes one.
    // The rest of the history is never read.
    const needed = ordered.filter(
      (version) => wanted.has(version.number) || wanted.has(version.number + 1),
    );

    const toFetch = needed.filter((version) => version.body === null).length;
    if (toFetch > CONFLUENCE_MAX_VOLUME_FETCHES_PER_PAGE) return null;

    const words = new Map<number, number>();
    for (const version of needed) {
      const body = await this.bodyOf(pageId, version, context);
      if (body === null) return null;
      words.set(version.number, countWords(body));
    }

    const volume = new Map<string, WrittenVolume>();
    for (const version of ordered) {
      if (!wanted.has(version.number) || version.authorId === null) continue;

      const current = words.get(version.number);
      if (current === undefined) return null;

      // Version 1 has no predecessor, so a page created inside the window
      // counts whole. Any *other* version whose predecessor is missing means
      // the history was truncated before it, and treating that as "written from
      // nothing" would credit one editor with the entire page.
      const previous = words.get(version.number - 1);
      if (previous === undefined && version.number !== 1) return null;

      const written = volumeBetween(previous ?? 0, current);
      const running = volume.get(version.authorId) ?? { added: 0, removed: 0 };
      volume.set(version.authorId, {
        added: running.added + written.added,
        removed: running.removed + written.removed,
      });
    }

    return volume;
  }

  private async bodyOf(
    pageId: string,
    version: ConfluenceVersion,
    context: EnrichmentContext,
  ): Promise<string | null> {
    if (version.body !== null) return version.body;

    try {
      return parseContentBody(
        await this.options.client.get<unknown>(
          historicalBodyPath(pageId, version.number),
          context,
        ),
      );
    } catch (error) {
      if (isRunOver(error)) throw error;
      this.options.logger.debug(
        `no Confluence body for page ${pageId} version ${version.number}: ${String(error)}`,
      );
      return null;
    }
  }

  private async viewsOf(
    contentId: string,
    from: Date,
    context: EnrichmentContext,
  ): Promise<number | null> {
    if (this.analyticsAvailable === false) return null;

    try {
      const count = parseViewCount(
        await this.options.client.get<unknown>(
          analyticsViewsPath(contentId, from),
          context,
        ),
      );
      this.analyticsAvailable = true;
      return count;
    } catch (error) {
      if (isRunOver(error)) throw error;
      if (isNotAvailable(error)) {
        this.analyticsAvailable = false;
        this.options.logger.info(
          "Confluence refused its analytics API, so page views stay unreported. " +
            "That endpoint is a Confluence Cloud Premium feature — on a Standard " +
            "site there is nothing to switch on.",
        );
        return null;
      }
      this.options.logger.debug(
        `no Confluence view count for ${contentId}: ${String(error)}`,
      );
      return null;
    }
  }

  /**
   * The spaces behind a set of keys, whichever key each was asked for by.
   *
   * The spaces API resolves a space's alias as readily as its original key,
   * but it reports the space under the original one — so a lookup indexed by
   * what came back never matched an annotation written from the space's URL,
   * and every query for that space then ran CQL against a key CQL does not
   * know, without a word. The answer is indexed under both keys, and callers
   * take the original from it for every query they build.
   *
   * Losing the lookup costs a name, a link and the homepage id, not the
   * measurements: a key that could not be resolved is queried as written, which
   * is right for every space that has never been renamed.
   */
  private async resolveSpaces(
    keys: readonly string[],
    context: EnrichmentContext,
  ): Promise<ResolvedSpaces> {
    const found = new Map<string, ConfluenceSpace>();
    const distinct = [...new Map(keys.map((key) => [key.toLowerCase(), key])).values()];
    let complete = true;

    if (distinct.length > 0) {
      try {
        const spaces = await this.options.client.paginate<ConfluenceSpace>({
          context,
          fetchPage: async (cursor) => {
            const page = parseSpacePage(
              await this.options.client.get<unknown>(
                cursor ?? spacesPath(distinct, LISTING_PAGE_SIZE),
                context,
              ),
            );
            return { items: page.results, next: page.next };
          },
        });
        for (const space of spaces) {
          found.set(space.key.toLowerCase(), space);
          if (space.alias !== null) found.set(space.alias.toLowerCase(), space);
        }
      } catch (error) {
        if (isRunOver(error)) throw error;
        complete = false;
        this.options.logger.warn(
          `could not read the Confluence spaces ${distinct.join(", ")}: ${String(error)}`,
        );
      }
    }

    return {
      complete,
      find: (key) => found.get(key.toLowerCase()) ?? null,
      keyFor: (key) => found.get(key.toLowerCase())?.key ?? key,
      identityOf: (key) => found.get(key.toLowerCase())?.id ?? key.toLowerCase(),
    };
  }

  private async measureSpace(input: {
    readonly key: string;
    readonly space: ConfluenceSpace | null;
    readonly window: { readonly from: Date; readonly to: Date };
    readonly staleBefore: Date;
    readonly context: EnrichmentContext;
    readonly users: Map<string, ConfluenceUser>;
  }): Promise<{
    readonly metrics: Omit<
      ConfluenceSpaceMetrics,
      "space" | "window" | "staleAfterDays" | "analytics"
    >;
    readonly base: string | null;
  }> {
    const { key, space, window, staleBefore, context, users } = input;
    // The key as CQL knows it, resolved by the caller; never the annotation.
    const spaceKeys = [key];
    const range = { from: window.from, to: window.to };

    const totalPages = await this.count({ types: ["page"], spaceKeys }, context);
    const pagesCreated = await this.count(
      { types: ["page"], spaceKeys, range: { field: "created", ...range } },
      context,
    );
    const pagesEdited = await this.count(
      { types: ["page"], spaceKeys, range: { field: "lastmodified", ...range } },
      context,
    );
    const blogPostsCreated = await this.count(
      { types: ["blogpost"], spaceKeys, range: { field: "created", ...range } },
      context,
    );
    const commentsWritten = await this.count(
      { types: ["comment"], spaceKeys, range: { field: "created", ...range } },
      context,
    );
    const attachmentsAdded = await this.count(
      { types: ["attachment"], spaceKeys, range: { field: "created", ...range } },
      context,
    );
    const stalePages = await this.count(
      { types: ["page"], spaceKeys, range: { field: "lastmodified", to: staleBefore } },
      context,
    );

    const stalest = await this.first(
      { types: ["page"], spaceKeys, orderBy: { field: "lastmodified", direction: "asc" } },
      context,
    );
    const latest = await this.first(
      {
        types: ["page", "blogpost"],
        spaceKeys,
        orderBy: { field: "lastmodified", direction: "desc" },
      },
      context,
    );

    const changed = await this.searchAll(
      {
        types: ["page", "blogpost"],
        spaceKeys,
        range: { field: "lastmodified", ...range },
        orderBy: { field: "lastmodified", direction: "desc" },
      },
      context,
    );

    const contributors = new Set<string>();
    for (const content of changed.results) {
      for (const user of [content.createdBy, content.lastModifiedBy]) {
        if (user === null) continue;
        contributors.add(user.accountId);
        if (!users.has(user.accountId)) users.set(user.accountId, user);
      }
    }

    return {
      base: changed.base,
      metrics: {
        totalPages,
        // A count that came back without a size has not said the space is
        // empty, so the window figures fall back to what the sweep actually saw
        // rather than to zero.
        pagesCreated: pagesCreated ?? 0,
        pagesEdited: pagesEdited ?? changed.results.length,
        blogPostsCreated: blogPostsCreated ?? 0,
        commentsWritten: commentsWritten ?? 0,
        attachmentsAdded: attachmentsAdded ?? 0,
        // Null once the walk was capped: the sweep stopped short, so a distinct
        // count would under-report in a way nothing on screen could tell from a
        // genuinely quiet quarter.
        contributors:
          changed.results.length >= this.options.client.maxResultsPerRun
            ? null
            : contributors.size,
        lastActivityAt: latest?.lastModifiedAt ?? null,
        stalePages,
        stalestPage: toPageReference(stalest),
        parentlessPages:
          space === null ? null : await this.parentlessPages(space, context),
        // A space-level view count would mean one analytics request per page in
        // the space, and the run has already spent its analytics allowance on
        // the pages people actually wrote this quarter. The state beside this
        // is what tells the dashboard which kind of nothing it is looking at.
        pageViews: null,
        pagesMeasuredForViews: 0,
      },
    };
  }

  /**
   * Pages in a space with no parent, excluding its homepage.
   *
   * Null when the space has more pages than the walk is allowed, because a
   * truncated count reads as a tidy space rather than an unmeasured one. The
   * listing is the only place `parentId` appears — CQL has no predicate for it,
   * and no Confluence Cloud endpoint answers "what links here" at all, which is
   * why this is a parentless count and not an orphan one.
   */
  private async parentlessPages(
    space: ConfluenceSpace,
    context: EnrichmentContext,
  ): Promise<number | null> {
    const pages = await this.options.client.paginate<{
      readonly id: string;
      readonly parentId: string | null;
    }>({
      context,
      limit: MAX_SPACE_PAGES,
      fetchPage: async (cursor) => {
        const page = parsePageListing(
          await this.options.client.get<unknown>(
            cursor ?? spacePagesPath(space.id, LISTING_PAGE_SIZE),
            context,
          ),
        );
        return {
          items: page.results.map((entry) => ({
            id: entry.id,
            parentId: entry.parentId,
          })),
          next: page.next,
        };
      },
    });

    if (pages.length >= MAX_SPACE_PAGES) return null;

    return pages.filter((page) => page.parentId === null && page.id !== space.homepageId)
      .length;
  }
}
