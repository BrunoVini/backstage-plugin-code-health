import { normalizeSourceKey } from "../../../domain/entities/identity";
import type { ObservedIdentity } from "../../../domain/services/identity_resolver";

/**
 * Confluence Cloud hangs off a `/wiki` context path on the same host as Jira.
 *
 * Both products share one site and one credential, which is what makes a single
 * `AtlassianClient` possible — but only Confluence carries the prefix, and a
 * path built without it lands on Jira's router and answers 404 with no hint
 * that the two APIs were ever confused.
 */
export const CONFLUENCE_ROOT = "/wiki";

/** The content types this integration counts, as CQL names them. */
export type ConfluenceContentType = "page" | "blogpost" | "comment" | "attachment";

export interface ConfluenceUser {
  readonly accountId: string;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly avatarUrl: string | null;
}

/** One CQL search hit, flattened to the fields this plugin reads. */
export interface ConfluenceContent {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly spaceKey: string | null;
  readonly createdAt: string | null;
  readonly createdBy: ConfluenceUser | null;
  readonly lastModifiedAt: string | null;
  readonly lastModifiedBy: ConfluenceUser | null;
  readonly versionNumber: number | null;
  readonly url: string | null;
}

export interface ConfluenceSearchPage {
  readonly results: readonly ConfluenceContent[];
  readonly start: number;
  readonly limit: number;
  /**
   * How many hits the query has in total, not how many this page carries.
   *
   * This is the whole reason the space figures cost one request each: a search
   * asked for a single result still reports the size of the whole answer, so
   * "how many pages went stale" never needs the pages themselves.
   *
   * Null when the response did not carry it. Falling back to the length of the
   * page would be worse than useless — a count query asks for one row, so the
   * fallback would report every space in the fleet as having exactly one page.
   */
  readonly totalSize: number | null;
  /** Absolute prefix the site reports for its own relative links. */
  readonly base: string | null;
}

/** One version of a page, as the v2 versions endpoint reports it. */
export interface ConfluenceVersion {
  readonly number: number;
  readonly authorId: string | null;
  readonly createdAt: string | null;
  /**
   * The storage-format body of this version, when the provider served one.
   *
   * Null is the case to design for rather than the exception: the v2 versions
   * endpoint accepts `body-format`, but whether it fills the body in varies by
   * site, and Atlassian ignores query parameters it does not recognise instead
   * of rejecting them — so asking and getting nothing back looks exactly like
   * asking for something that does not exist. The caller falls back to fetching
   * each version's body on its own when this is null.
   */
  readonly body: string | null;
}

export interface ConfluenceVersionPage {
  readonly results: readonly ConfluenceVersion[];
  readonly next: string | null;
}

export interface ConfluenceSpace {
  readonly id: string;
  /**
   * The key the space was created with, which is the only one CQL matches.
   *
   * Confluence Cloud lets an administrator change a space's key, and the new
   * one becomes the space's {@link alias}: it is what the space's URL shows
   * and what the spaces API resolves, so it is what somebody copying a key
   * into an annotation writes down — while `space in ("…")` in CQL goes on
   * matching this original one. Every query is built from this field, and the
   * annotation is only ever used to look it up.
   */
  readonly key: string;
  /** The key the space answers to now, when an administrator changed it. */
  readonly alias: string | null;
  readonly name: string | null;
  readonly url: string | null;
  /**
   * The space's front page.
   *
   * Needed to keep it off the parentless-pages count: a homepage has no parent
   * by definition, and counting it would put every space in the fleet one page
   * into the red.
   */
  readonly homepageId: string | null;
}

export interface ConfluenceSpacePage {
  readonly results: readonly ConfluenceSpace[];
  readonly next: string | null;
}

/** One page of a space, as the v2 pages endpoint reports it. */
export interface ConfluencePage {
  readonly id: string;
  readonly title: string;
  readonly parentId: string | null;
}

export interface ConfluencePageListing {
  readonly results: readonly ConfluencePage[];
  readonly next: string | null;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asArray = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** Reads a nested property without asserting the shape of anything above it. */
const at = (value: unknown, ...path: readonly string[]): unknown =>
  path.reduce<unknown>((current, key) => asRecord(current)?.[key], value);

/**
 * The id a Confluence object carries.
 *
 * v1 reports ids as strings and v2 reports the same ids as numbers, and the two
 * appear side by side in one run — a page found through CQL is fetched through
 * v2. Normalising here is what stops `"123" !== 123` from quietly splitting one
 * page into two.
 */
const asId = (value: unknown): string | null => {
  const text = asString(value);
  if (text !== null) return text;
  const numeric = asNumber(value);
  return numeric === null ? null : String(numeric);
};

/**
 * Normalises an Atlassian timestamp to an ISO 8601 instant.
 *
 * Confluence answers with several shapes across its two API generations —
 * `2026-08-01T09:12:00.000+01:00` from v1, `2026-08-01T09:12:00.000Z` from v2 —
 * and both parse, but comparing them as strings does not. Everything is put in
 * UTC so a window test is a comparison of instants rather than of spellings.
 */
export const toInstant = (value: unknown): string | null => {
  const text = asString(value);
  if (text === null) return null;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
};

/** Whether an instant falls in `[from, to)`. */
export const isWithin = (instant: string | null, from: Date, to: Date): boolean => {
  if (instant === null) return false;
  const moment = Date.parse(instant);
  return moment >= from.getTime() && moment < to.getTime();
};

/**
 * Escapes a value for a quoted CQL literal.
 *
 * Space keys are conventionally alphanumeric, but nothing enforces that and a
 * key is ultimately whatever an administrator typed. A quote or a backslash
 * arriving unescaped would not merely break the query — CQL is a query language
 * reaching a search index, so it is the same class of problem as an unescaped
 * SQL literal and gets the same treatment.
 */
export const cqlEscape = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/**
 * Formats an instant the way CQL parses dates.
 *
 * Minute resolution, because that is the finest CQL accepts — it has no seconds
 * field at all. The window is therefore truncated to the minute at both ends,
 * which is why the enricher re-checks every timestamp it gets back against the
 * real window instead of trusting the query to have been exact.
 */
export const cqlInstant = (instant: Date): string => {
  const iso = new Date(instant.getTime()).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
};

export type CqlDateField = "created" | "lastmodified";

export interface CqlDateRange {
  readonly field: CqlDateField;
  /** Inclusive lower bound. */
  readonly from?: Date;
  /** Exclusive upper bound. */
  readonly to?: Date;
}

export interface CqlOrder {
  readonly field: CqlDateField;
  readonly direction: "asc" | "desc";
}

export interface CqlQuery {
  readonly types: readonly ConfluenceContentType[];
  readonly spaceKeys?: readonly string[];
  readonly range?: CqlDateRange;
  readonly orderBy?: CqlOrder;
}

/**
 * Builds a CQL query.
 *
 * The date range is expressed as two separate comparisons rather than one
 * `between`, which CQL does not have, and the upper bound is strict so two
 * consecutive windows can never both claim the same minute.
 */
export const buildCql = (query: CqlQuery): string => {
  const clauses: string[] = [];

  clauses.push(
    query.types.length === 1
      ? `type = ${query.types[0]}`
      : `type in (${query.types.join(", ")})`,
  );

  const spaces = query.spaceKeys ?? [];
  if (spaces.length > 0) {
    clauses.push(
      `space in (${spaces.map((key) => `"${cqlEscape(key)}"`).join(", ")})`,
    );
  }

  if (query.range?.from) {
    clauses.push(`${query.range.field} >= "${cqlInstant(query.range.from)}"`);
  }
  if (query.range?.to) {
    clauses.push(`${query.range.field} < "${cqlInstant(query.range.to)}"`);
  }

  const predicate = clauses.join(" and ");
  return query.orderBy === undefined
    ? predicate
    : `${predicate} order by ${query.orderBy.field} ${query.orderBy.direction}`;
};

/**
 * What a CQL search is asked to expand.
 *
 * All three are load-bearing. Without `content.history` there is no creator, so
 * every page would be attributed to whoever touched it last; without
 * `content.version` there is no last editor either; without `content.space` a
 * hit cannot be attributed to a space at all, because the search result's own
 * container field carries the space *title* rather than its key.
 */
const SEARCH_EXPAND = ["content.history", "content.version", "content.space"];

export const searchPath = (options: {
  readonly cql: string;
  readonly start: number;
  readonly limit: number;
}): string => {
  const parameters = new URLSearchParams({
    cql: options.cql,
    start: String(options.start),
    limit: String(options.limit),
    expand: SEARCH_EXPAND.join(","),
  });
  return `${CONFLUENCE_ROOT}/rest/api/search?${parameters.toString()}`;
};

export const versionsPath = (pageId: string, limit: number): string => {
  const parameters = new URLSearchParams({
    limit: String(limit),
    // Newest first. A page with more versions than the walk is allowed gets
    // truncated somewhere, and the end that matters is the recent one: sorting
    // ascending would return a decade of history and none of the window being
    // measured. The caller re-sorts what it got before differencing.
    sort: "-modified-date",
    "body-format": "storage",
  });
  return `${CONFLUENCE_ROOT}/api/v2/pages/${encodeURIComponent(pageId)}/versions?${parameters.toString()}`;
};

export const spacesPath = (keys: readonly string[], limit: number): string => {
  const parameters = new URLSearchParams({ limit: String(limit) });
  for (const key of keys) parameters.append("keys", key);
  return `${CONFLUENCE_ROOT}/api/v2/spaces?${parameters.toString()}`;
};

export const spacePagesPath = (spaceId: string, limit: number): string => {
  const parameters = new URLSearchParams({ limit: String(limit) });
  return `${CONFLUENCE_ROOT}/api/v2/spaces/${encodeURIComponent(spaceId)}/pages?${parameters.toString()}`;
};

/**
 * The analytics endpoint, which is **Confluence Cloud Premium only**.
 *
 * v1 has no v2 equivalent, and a Standard site answers 403 or 404 here whatever
 * the credential — so the first refusal is a verdict about the site, not about
 * the page that happened to be asked for.
 */
export const analyticsViewsPath = (contentId: string, from: Date): string => {
  const parameters = new URLSearchParams({ fromDate: from.toISOString() });
  return `${CONFLUENCE_ROOT}/rest/api/analytics/content/${encodeURIComponent(contentId)}/views?${parameters.toString()}`;
};

/**
 * A historical version's body.
 *
 * v1 only: v2 serves the *current* body of a page and has no endpoint for an
 * earlier one, so measuring what changed between two versions has to come back
 * here. `status=historical` is what makes `version` mean anything — without it
 * the parameter is ignored and the current body comes back for every version,
 * which produces a run of perfectly zero deltas rather than an error.
 */
export const historicalBodyPath = (contentId: string, version: number): string => {
  const parameters = new URLSearchParams({
    status: "historical",
    version: String(version),
    expand: "body.storage",
  });
  return `${CONFLUENCE_ROOT}/rest/api/content/${encodeURIComponent(contentId)}?${parameters.toString()}`;
};

export const usersBulkPath = (accountIds: readonly string[]): string => {
  const parameters = new URLSearchParams();
  for (const accountId of accountIds) parameters.append("accountId", accountId);
  return `${CONFLUENCE_ROOT}/rest/api/user/bulk?${parameters.toString()}`;
};

/**
 * The absolute prefix Confluence reports for its own relative links.
 *
 * Every `_links.webui` and every search hit's `url` is relative to it, and the
 * plugin has no other way to build a link a browser can follow — the site's
 * base URL lives in backend configuration that this parser deliberately does
 * not read, so that a response and its links always come from the same place.
 */
const baseFrom = (body: unknown): string | null =>
  asString(at(body, "_links", "base"));

const absolute = (base: string | null, relative: string | null): string | null => {
  if (relative === null) return null;
  if (/^https?:\/\//.test(relative)) return relative;
  return base === null ? null : `${base}${relative}`;
};

/**
 * The next page of a cursor-paginated v2 response.
 *
 * Confluence hands back a path rather than a cursor token, already carrying
 * every parameter of the original request, so it is used verbatim instead of
 * being taken apart and rebuilt.
 */
export const nextPath = (body: unknown): string | null => {
  const next = asString(at(body, "_links", "next"));
  if (next === null) return null;
  return next.startsWith("/") ? next : `${CONFLUENCE_ROOT}/${next}`;
};

const parseUser = (value: unknown, base: string | null): ConfluenceUser | null => {
  const accountId = asString(at(value, "accountId"));
  if (accountId === null) return null;

  return {
    // Normalised at the edge so every later comparison, merge and store key
    // agrees, without any of them having to remember to fold case — and so a
    // Confluence account lands on exactly the key its Jira twin does.
    accountId: normalizeSourceKey(accountId),
    displayName: asString(at(value, "displayName")),
    // Absent on most sites: an Atlassian account only exposes its address when
    // the organisation's profile-visibility settings allow it, so this is null
    // far more often than not and identity linking cannot depend on it.
    email: asString(at(value, "email")),
    avatarUrl: absolute(base, asString(at(value, "profilePicture", "path"))),
  };
};

export const parseSearchPage = (body: unknown): ConfluenceSearchPage => {
  const base = baseFrom(body);
  const record = asRecord(body);

  const results = asArray(record?.results).flatMap<ConfluenceContent>((result) => {
    const content = at(result, "content");
    const id = asId(at(content, "id"));
    if (id === null) return [];

    return [
      {
        id,
        type: asString(at(content, "type")) ?? "",
        title: asString(at(content, "title")) ?? "",
        spaceKey: asString(at(content, "space", "key")),
        createdAt: toInstant(at(content, "history", "createdDate")),
        createdBy: parseUser(at(content, "history", "createdBy"), base),
        // The result's own `lastModified` is the search index's view and is
        // present even when `content.version` was not expanded, so it is the
        // fallback rather than the other way round.
        lastModifiedAt:
          toInstant(at(content, "version", "when")) ?? toInstant(at(result, "lastModified")),
        lastModifiedBy: parseUser(at(content, "version", "by"), base),
        versionNumber: asNumber(at(content, "version", "number")),
        url:
          absolute(base, asString(at(result, "url"))) ??
          absolute(base, asString(at(content, "_links", "webui"))),
      },
    ];
  });

  return {
    results,
    start: asNumber(record?.start) ?? 0,
    limit: asNumber(record?.limit) ?? results.length,
    totalSize: asNumber(record?.totalSize),
    base,
  };
};

export const parseVersionPage = (body: unknown): ConfluenceVersionPage => ({
  results: asArray(asRecord(body)?.results).flatMap<ConfluenceVersion>((entry) => {
    const number = asNumber(at(entry, "number"));
    if (number === null) return [];

    const authorId = asString(at(entry, "authorId"));
    return [
      {
        number,
        authorId: authorId === null ? null : normalizeSourceKey(authorId),
        createdAt: toInstant(at(entry, "createdAt")),
        body: asString(at(entry, "body", "storage", "value")),
      },
    ];
  }),
  next: nextPath(body),
});

export const parseSpacePage = (body: unknown): ConfluenceSpacePage => {
  const base = baseFrom(body);

  return {
    results: asArray(asRecord(body)?.results).flatMap<ConfluenceSpace>((entry) => {
      const id = asId(at(entry, "id"));
      const key = asString(at(entry, "key"));
      if (id === null || key === null) return [];

      return [
        {
          id,
          key,
          alias: asString(at(entry, "alias")),
          name: asString(at(entry, "name")),
          url: absolute(base, asString(at(entry, "_links", "webui"))),
          homepageId: asId(at(entry, "homepageId")),
        },
      ];
    }),
    next: nextPath(body),
  };
};

export const parsePageListing = (body: unknown): ConfluencePageListing => ({
  results: asArray(asRecord(body)?.results).flatMap<ConfluencePage>((entry) => {
    const id = asId(at(entry, "id"));
    if (id === null) return [];

    return [
      {
        id,
        title: asString(at(entry, "title")) ?? "",
        parentId: asId(at(entry, "parentId")),
      },
    ];
  }),
  next: nextPath(body),
});

/** The storage-format body of a single content response. */
export const parseContentBody = (body: unknown): string | null =>
  asString(at(body, "body", "storage", "value"));

/**
 * The view count an analytics response carries.
 *
 * Null rather than zero for a response that does not carry the field: a site
 * that answered without a count has not told us the page went unread.
 */
export const parseViewCount = (body: unknown): number | null =>
  asNumber(at(body, "count"));

export const parseBulkUsers = (body: unknown): readonly ConfluenceUser[] => {
  const base = baseFrom(body);
  const record = asRecord(body);
  const entries = Array.isArray(body) ? body : asArray(record?.results);
  return entries.flatMap((entry) => {
    const user = parseUser(entry, base);
    return user === null ? [] : [user];
  });
};

/** The identity record a sweep hands to the Identities screen. */
export const toObservedIdentity = (
  user: ConfluenceUser,
  base: string | null,
): ObservedIdentity => ({
  source: "confluence",
  sourceKey: user.accountId,
  displayName: user.displayName,
  email: user.email,
  avatarUrl: user.avatarUrl,
  // Atlassian's people directory is the one page that exists for every account
  // whether or not it has ever touched Confluence, which is what makes it the
  // right destination for an identity nobody has linked yet.
  profileUrl: base === null ? null : `${base}/people/${user.accountId}`,
});

const CDATA_OPEN = /<!\[CDATA\[/g;
const CDATA_CLOSE = /\]\]>/g;
const TAG = /<[^>]*>/g;
const ENTITY = /&(?:[a-zA-Z][a-zA-Z0-9]*|#[0-9]+|#[xX][0-9a-fA-F]+);/g;

/**
 * Words in a Confluence storage-format body.
 *
 * Storage format is XHTML, so the markup comes out first — a page wrapped in a
 * layout macro would otherwise measure as though somebody had written the tags.
 * The two CDATA sentinels are removed *before* the tags rather than with them,
 * because the tag pattern would swallow everything from `<![CDATA[` to the
 * first `]]>` and take the code sample inside a snippet macro with it; somebody
 * wrote that code, and it counts.
 *
 * A word is a run of non-whitespace, which is the figure's known limitation and
 * the reason the unit is carried rather than assumed. Chinese, Japanese and
 * Thai are not space-separated, so a CJK page measures far smaller than it
 * reads. Counting characters instead was considered and rejected: it distorts
 * the same comparison in the opposite direction, making an English page look
 * five times the size of a CJK page saying the same thing, and it is far more
 * sensitive to whatever markup survives stripping. Macro parameter values are
 * counted as prose, which is a small over-count nobody has been able to notice.
 *
 * Every pattern here is linear. A lazy quantifier bounded by a literal closer
 * would read more naturally and is exactly the shape that turns a
 * hand-assembled page into a stalled ingestion run.
 */
export const countWords = (storage: string): number => {
  const text = storage
    .replace(CDATA_OPEN, " ")
    .replace(CDATA_CLOSE, " ")
    .replace(TAG, " ")
    .replace(ENTITY, " ")
    .trim();

  return text === "" ? 0 : text.split(/\s+/).length;
};

export interface WrittenVolume {
  readonly added: number;
  readonly removed: number;
}

/**
 * What one edit added or removed, from the size of the body either side of it.
 *
 * This is a length delta, not a diff, and the difference matters enough to say
 * out loud: an edit that rewrites a paragraph and leaves it the same length
 * measures as zero. Confluence serves no diff between two versions and no
 * per-edit change size anywhere in its API, so a real figure would mean
 * shipping a text-diff implementation and running it over every version of
 * every page in the window. The length delta is the honest cheap answer, and it
 * is right whenever an edit actually changed how much there is to read.
 */
export const volumeBetween = (
  previousWords: number,
  currentWords: number,
): WrittenVolume => {
  const delta = currentWords - previousWords;
  return delta >= 0 ? { added: delta, removed: 0 } : { added: 0, removed: -delta };
};
