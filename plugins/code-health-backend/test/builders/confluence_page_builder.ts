/**
 * Payloads shaped the way Confluence Cloud actually answers.
 *
 * Deliberately raw JSON rather than the parsed types: the collector's job is to
 * survive what the two API generations really send, so a builder that produced
 * already-clean objects would test the tests. The shapes here mirror the
 * awkward parts on purpose — v1 nesting a page inside `content`, v2 reporting
 * the same id as a number, both hanging their links off `_links`.
 */

export const CONFLUENCE_BASE = "https://acme.atlassian.net/wiki";

export interface ConfluenceUserFixture {
  readonly accountId: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly avatarPath?: string;
}

export const aConfluenceUser = (
  accountId: string,
  overrides: Omit<ConfluenceUserFixture, "accountId"> = {},
): Record<string, unknown> => ({
  type: "known",
  accountId,
  displayName: overrides.displayName ?? `User ${accountId}`,
  ...(overrides.email === undefined ? {} : { email: overrides.email }),
  profilePicture: { path: overrides.avatarPath ?? `/aa-avatar/${accountId}` },
});

/** One hit of a CQL search, in the `{ content, url, lastModified }` shape v1 uses. */
export class ConfluencePageBuilder {
  private id = "1001";
  private type = "page";
  private title = "Runbook";
  private spaceKey: string | null = "ENG";
  private createdAt = "2026-07-01T09:00:00.000Z";
  private createdBy: Record<string, unknown> | null = aConfluenceUser("acct-author");
  private modifiedAt = "2026-08-01T09:00:00.000Z";
  private modifiedBy: Record<string, unknown> | null = aConfluenceUser("acct-author");
  private versionNumber = 1;

  static create(): ConfluencePageBuilder {
    return new ConfluencePageBuilder();
  }

  withId(id: string): this {
    this.id = id;
    return this;
  }

  withTitle(title: string): this {
    this.title = title;
    return this;
  }

  inSpace(key: string | null): this {
    this.spaceKey = key;
    return this;
  }

  asBlogPost(): this {
    this.type = "blogpost";
    return this;
  }

  asComment(): this {
    this.type = "comment";
    return this;
  }

  asAttachment(): this {
    this.type = "attachment";
    return this;
  }

  createdOn(instant: string, author = this.createdBy): this {
    this.createdAt = instant;
    this.createdBy = author;
    return this;
  }

  modifiedOn(instant: string, author = this.modifiedBy): this {
    this.modifiedAt = instant;
    this.modifiedBy = author;
    return this;
  }

  /** A page whose creator the search did not report, as an anonymised one is. */
  withoutCreator(): this {
    this.createdBy = null;
    return this;
  }

  atVersion(versionNumber: number): this {
    this.versionNumber = versionNumber;
    return this;
  }

  build(): Record<string, unknown> {
    return {
      content: {
        // v1 reports ids as strings; the v2 endpoints report the same id as a
        // number, which is exactly the mismatch the parser folds away.
        id: this.id,
        type: this.type,
        status: "current",
        title: this.title,
        ...(this.spaceKey === null
          ? {}
          : { space: { key: this.spaceKey, name: `${this.spaceKey} space` } }),
        history: {
          createdDate: this.createdAt,
          ...(this.createdBy === null ? {} : { createdBy: this.createdBy }),
        },
        version: {
          when: this.modifiedAt,
          number: this.versionNumber,
          ...(this.modifiedBy === null ? {} : { by: this.modifiedBy }),
        },
        _links: { webui: `/spaces/${this.spaceKey ?? "X"}/pages/${this.id}` },
      },
      title: this.title,
      url: `/spaces/${this.spaceKey ?? "X"}/pages/${this.id}`,
      lastModified: this.modifiedAt,
      entityType: "content",
    };
  }
}

export const aSearchResponse = (options: {
  readonly results?: readonly Record<string, unknown>[];
  readonly totalSize?: number;
  readonly start?: number;
  readonly limit?: number;
  readonly base?: string | null;
}): Record<string, unknown> => {
  const results = options.results ?? [];
  return {
    results,
    start: options.start ?? 0,
    limit: options.limit ?? 100,
    size: results.length,
    ...(options.totalSize === undefined ? {} : { totalSize: options.totalSize }),
    _links:
      options.base === null ? {} : { base: options.base ?? CONFLUENCE_BASE, context: "/wiki" },
  };
};

export const aVersion = (options: {
  readonly number: number;
  readonly authorId: string;
  readonly createdAt: string;
  readonly body?: string;
}): Record<string, unknown> => ({
  number: options.number,
  authorId: options.authorId,
  createdAt: options.createdAt,
  minorEdit: false,
  message: "",
  ...(options.body === undefined ? {} : { body: { storage: { value: options.body } } }),
});

export const aVersionsResponse = (
  versions: readonly Record<string, unknown>[],
  next: string | null = null,
): Record<string, unknown> => ({
  results: versions,
  _links: {
    base: CONFLUENCE_BASE,
    ...(next === null ? {} : { next }),
  },
});

export const aSpacesResponse = (
  spaces: readonly {
    readonly id: string | number;
    readonly key: string;
    /** The key the space answers to now, after an administrator changed it. */
    readonly alias?: string;
    readonly name?: string;
    readonly homepageId?: string | number;
  }[],
  next: string | null = null,
): Record<string, unknown> => ({
  results: spaces.map((space) => ({
    id: space.id,
    key: space.key,
    ...(space.alias === undefined ? {} : { alias: space.alias }),
    name: space.name ?? `${space.key} space`,
    type: "global",
    ...(space.homepageId === undefined ? {} : { homepageId: space.homepageId }),
    // The link carries the alias once there is one, exactly as the site does:
    // that is how the alias ends up in the annotation in the first place.
    _links: { webui: `/spaces/${space.alias ?? space.key}` },
  })),
  _links: {
    base: CONFLUENCE_BASE,
    ...(next === null ? {} : { next }),
  },
});

export const aPageListingResponse = (
  pages: readonly {
    readonly id: string | number;
    readonly title?: string;
    readonly parentId?: string | number | null;
  }[],
  next: string | null = null,
): Record<string, unknown> => ({
  results: pages.map((page) => ({
    id: page.id,
    status: "current",
    title: page.title ?? `Page ${page.id}`,
    parentId: page.parentId ?? null,
  })),
  _links: {
    base: CONFLUENCE_BASE,
    ...(next === null ? {} : { next }),
  },
});
