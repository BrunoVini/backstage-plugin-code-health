import {
  analyticsViewsPath,
  buildCql,
  countWords,
  cqlEscape,
  cqlInstant,
  historicalBodyPath,
  isWithin,
  nextPath,
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
  toInstant,
  toObservedIdentity,
  usersBulkPath,
  versionsPath,
  volumeBetween,
} from "../../../../src/infrastructure/services/atlassian/confluence_queries";
import {
  aConfluenceUser,
  aPageListingResponse,
  aSearchResponse,
  aSpacesResponse,
  aVersion,
  aVersionsResponse,
  ConfluencePageBuilder,
  CONFLUENCE_BASE,
} from "../../../builders/confluence_page_builder";

const FROM = new Date("2026-05-30T00:00:00.000Z");
const TO = new Date("2026-08-28T00:00:00.000Z");

/** The query string of a path, so a test asserts on parsed parameters. */
const parametersOf = (path: string): URLSearchParams =>
  new URL(path, "https://acme.atlassian.net").searchParams;

describe("buildCql", () => {
  it("should use an equality clause for a single type", () => {
    // given
    const query = { types: ["page"] } as const;

    // when
    const cql = buildCql(query);

    // then
    expect(cql).toBe("type = page");
  });

  it("should use an in clause for several types", () => {
    // given
    const query = { types: ["page", "blogpost"] } as const;

    // when
    const cql = buildCql(query);

    // then
    expect(cql).toBe("type in (page, blogpost)");
  });

  it("should scope to the configured spaces", () => {
    // given
    // Scoping is what makes the expensive per-page walks affordable: the search
    // index answers a space-restricted query without touching the rest.
    const query = { types: ["page"], spaceKeys: ["ENG", "OPS"] } as const;

    // when
    const cql = buildCql(query);

    // then
    expect(cql).toBe('type = page and space in ("ENG", "OPS")');
  });

  it("should bound the range with an inclusive start and an exclusive end", () => {
    // given
    // An exclusive upper bound is what stops two consecutive windows both
    // claiming the same minute.
    const query = {
      types: ["page"],
      range: { field: "lastmodified", from: FROM, to: TO },
    } as const;

    // when
    const cql = buildCql(query);

    // then
    expect(cql).toBe(
      'type = page and lastmodified >= "2026-05-30 00:00" and lastmodified < "2026-08-28 00:00"',
    );
  });

  it("should take an upper bound on its own, for a staleness query", () => {
    // given
    const query = { types: ["page"], range: { field: "lastmodified", to: FROM } } as const;

    // when
    const cql = buildCql(query);

    // then
    expect(cql).toBe('type = page and lastmodified < "2026-05-30 00:00"');
  });

  it("should append the ordering after the whole predicate", () => {
    // given
    const query = {
      types: ["page"],
      spaceKeys: ["ENG"],
      orderBy: { field: "lastmodified", direction: "asc" },
    } as const;

    // when
    const cql = buildCql(query);

    // then
    expect(cql).toBe(
      'type = page and space in ("ENG") order by lastmodified asc',
    );
  });
});

describe("cqlEscape", () => {
  it("should escape quotes and backslashes in a space key", () => {
    // given
    // A space key is whatever an administrator typed, and CQL reaches a search
    // index — so an unescaped quote is the same class of problem as an
    // unescaped SQL literal, not merely a broken query.
    const key = 'we"ird\\key';

    // when
    const escaped = cqlEscape(key);

    // then
    expect(escaped).toBe('we\\"ird\\\\key');
  });
});

describe("cqlInstant", () => {
  it("should format to the minute, which is the finest CQL parses", () => {
    // given
    const instant = new Date("2026-08-28T13:45:59.999Z");

    // when
    const formatted = cqlInstant(instant);

    // then
    expect(formatted).toBe("2026-08-28 13:45");
  });
});

describe("paths", () => {
  it("should put every Confluence path under the wiki context", () => {
    // given / when
    const paths = [
      searchPath({ cql: "type = page", start: 0, limit: 100 }),
      versionsPath("1001", 100),
      spacesPath(["ENG"], 250),
      spacePagesPath("77", 250),
      analyticsViewsPath("1001", FROM),
      historicalBodyPath("1001", 3),
      usersBulkPath(["acct-a"]),
    ];

    // then
    // Jira lives on the same host without the prefix, so a path built without
    // it reaches Jira's router and answers 404 with nothing naming the cause.
    for (const path of paths) expect(path.startsWith("/wiki/")).toBe(true);
  });

  it("should ask the search API to expand the creator, the version and the space", () => {
    // given / when
    const parameters = parametersOf(searchPath({ cql: "type = page", start: 20, limit: 50 }));

    // then
    // Without the history expansion every page would be attributed to whoever
    // touched it last rather than to whoever wrote it.
    expect(parameters.get("expand")).toBe(
      "content.history,content.version,content.space",
    );
    expect(parameters.get("start")).toBe("20");
    expect(parameters.get("limit")).toBe("50");
    expect(parameters.get("cql")).toBe("type = page");
  });

  it("should ask for version bodies, newest version first", () => {
    // given / when
    const parameters = parametersOf(versionsPath("1001", 100));

    // then
    // A page with more versions than the walk allows gets truncated somewhere,
    // and the end that matters is the recent one: ascending would return a
    // decade of history and none of the window being measured.
    expect(parameters.get("body-format")).toBe("storage");
    expect(parameters.get("sort")).toBe("-modified-date");
  });

  it("should mark a historical body request as historical", () => {
    // given / when
    const parameters = parametersOf(historicalBodyPath("1001", 4));

    // then
    // Without `status=historical` the version parameter is ignored and the
    // current body comes back for every version — a run of perfect zeroes
    // rather than an error.
    expect(parameters.get("status")).toBe("historical");
    expect(parameters.get("version")).toBe("4");
    expect(parameters.get("expand")).toBe("body.storage");
  });

  it("should repeat the keys parameter for every space asked about", () => {
    // given / when
    const parameters = parametersOf(spacesPath(["ENG", "OPS"], 250));

    // then
    expect(parameters.getAll("keys")).toEqual(["ENG", "OPS"]);
  });

  it("should repeat the accountId parameter for every account asked about", () => {
    // given / when
    const parameters = parametersOf(usersBulkPath(["acct-a", "acct-b"]));

    // then
    expect(parameters.getAll("accountId")).toEqual(["acct-a", "acct-b"]);
  });

  it("should date-bound an analytics lookup to the measured window", () => {
    // given / when
    const parameters = parametersOf(analyticsViewsPath("1001", FROM));

    // then
    expect(parameters.get("fromDate")).toBe("2026-05-30T00:00:00.000Z");
  });
});

describe("parseSearchPage", () => {
  it("should flatten a hit into its creator, its last editor and its space", () => {
    // given
    const body = aSearchResponse({
      totalSize: 1,
      results: [
        ConfluencePageBuilder.create()
          .withId("1001")
          .withTitle("Deploy runbook")
          .inSpace("ENG")
          .createdOn("2026-07-01T09:00:00.000Z", aConfluenceUser("ACCT-Author"))
          .modifiedOn("2026-08-01T09:00:00.000Z", aConfluenceUser("acct-editor"))
          .atVersion(4)
          .build(),
      ],
    });

    // when
    const page = parseSearchPage(body);

    // then
    expect(page.results).toHaveLength(1);
    expect(page.results[0]).toMatchObject({
      id: "1001",
      type: "page",
      title: "Deploy runbook",
      spaceKey: "ENG",
      createdAt: "2026-07-01T09:00:00.000Z",
      versionNumber: 4,
    });
    // Account ids are normalised at the edge so a Confluence account lands on
    // exactly the key its Jira twin does.
    expect(page.results[0].createdBy?.accountId).toBe("acct-author");
    expect(page.results[0].lastModifiedBy?.accountId).toBe("acct-editor");
  });

  it("should make every link absolute from the base the site reported", () => {
    // given
    const body = aSearchResponse({
      results: [ConfluencePageBuilder.create().withId("1001").inSpace("ENG").build()],
    });

    // when
    const page = parseSearchPage(body);

    // then
    expect(page.base).toBe(CONFLUENCE_BASE);
    expect(page.results[0].url).toBe(`${CONFLUENCE_BASE}/spaces/ENG/pages/1001`);
    expect(page.results[0].createdBy?.avatarUrl).toBe(
      `${CONFLUENCE_BASE}/aa-avatar/acct-author`,
    );
  });

  it("should leave links null when the site reported no base", () => {
    // given
    // A relative path rendered inside Backstage would point at Backstage, so
    // nothing is better than a link that goes somewhere wrong.
    const body = aSearchResponse({
      base: null,
      results: [ConfluencePageBuilder.create().build()],
    });

    // when
    const page = parseSearchPage(body);

    // then
    expect(page.base).toBeNull();
    expect(page.results[0].url).toBeNull();
  });

  it("should fall back to the content's own link when the hit carried none", () => {
    // given
    const body = {
      results: [
        {
          content: {
            id: 1001,
            type: "page",
            title: "Runbook",
            _links: { webui: "/spaces/ENG/pages/1001" },
          },
        },
      ],
      _links: { base: CONFLUENCE_BASE },
    };

    // when
    const page = parseSearchPage(body);

    // then
    // v2 reports the same id as a number where v1 reports it as a string, and
    // "123" !== 123 would quietly split one page into two.
    expect(page.results[0].id).toBe("1001");
    expect(page.results[0].url).toBe(`${CONFLUENCE_BASE}/spaces/ENG/pages/1001`);
    expect(page.results[0].spaceKey).toBeNull();
    expect(page.results[0].createdBy).toBeNull();
  });

  it("should keep totalSize null when the response did not carry one", () => {
    // given
    // A count query asks for a single row, so falling back to the length of the
    // page would report every space in the fleet as having exactly one page.
    const body = aSearchResponse({
      results: [ConfluencePageBuilder.create().build()],
    });

    // when
    const page = parseSearchPage(body);

    // then
    expect(page.totalSize).toBeNull();
  });

  it("should drop a hit with no content id rather than inventing one", () => {
    // given
    const body = { results: [{ title: "orphaned hit" }], totalSize: 1 };

    // when
    const page = parseSearchPage(body);

    // then
    expect(page.results).toEqual([]);
    expect(page.totalSize).toBe(1);
  });

  it("should survive a response that is not an object at all", () => {
    // given
    const body = "gateway timeout";

    // when
    const page = parseSearchPage(body);

    // then
    expect(page.results).toEqual([]);
    expect(page.totalSize).toBeNull();
  });
});

describe("parseVersionPage", () => {
  it("should read the author, the instant and the body of each version", () => {
    // given
    const body = aVersionsResponse([
      aVersion({
        number: 1,
        authorId: "ACCT-Author",
        createdAt: "2026-07-01T09:00:00.000Z",
        body: "<p>one two three</p>",
      }),
      aVersion({ number: 2, authorId: "acct-editor", createdAt: "2026-07-02T09:00:00.000Z" }),
    ]);

    // when
    const page = parseVersionPage(body);

    // then
    expect(page.results).toEqual([
      {
        number: 1,
        authorId: "acct-author",
        createdAt: "2026-07-01T09:00:00.000Z",
        body: "<p>one two three</p>",
      },
      {
        number: 2,
        authorId: "acct-editor",
        createdAt: "2026-07-02T09:00:00.000Z",
        body: null,
      },
    ]);
  });

  it("should report the next page as a path to follow verbatim", () => {
    // given
    // Confluence hands back a path already carrying every parameter of the
    // original request, so it is used as-is rather than taken apart.
    const body = aVersionsResponse([], "/wiki/api/v2/pages/1001/versions?cursor=abc");

    // when
    const page = parseVersionPage(body);

    // then
    expect(page.next).toBe("/wiki/api/v2/pages/1001/versions?cursor=abc");
  });

  it("should prefix a next link that arrived without the wiki context", () => {
    // given
    const body = { results: [], _links: { next: "api/v2/pages/1001/versions?cursor=abc" } };

    // when
    const page = parseVersionPage(body);

    // then
    expect(page.next).toBe("/wiki/api/v2/pages/1001/versions?cursor=abc");
  });

  it("should drop a version with no number, which nothing could be ordered by", () => {
    // given
    const body = { results: [{ authorId: "acct-a", createdAt: "2026-07-01T09:00:00.000Z" }] };

    // when
    const page = parseVersionPage(body);

    // then
    expect(page.results).toEqual([]);
  });
});

describe("parseSpacePage", () => {
  it("should read the id, key, name, link and homepage of a space", () => {
    // given
    // v2 reports the id as a number where v1 reports the same id as a string.
    const body = aSpacesResponse([
      { id: 77, key: "ENG", name: "Engineering", homepageId: 900 },
    ]);

    // when
    const page = parseSpacePage(body);

    // then
    expect(page.results[0]).toEqual({
      id: "77",
      key: "ENG",
      alias: null,
      name: "Engineering",
      url: `${CONFLUENCE_BASE}/spaces/ENG`,
      homepageId: "900",
    });
  });

  it("should carry the alias a renamed space answers to beside its original key", () => {
    // given
    // An administrator changed the key: the site's links, and so the
    // annotation somebody copies from them, say DATA, while CQL still knows
    // the space as DS.
    const body = aSpacesResponse([{ id: 77, key: "DS", alias: "DATA", name: "Data" }]);

    // when
    const page = parseSpacePage(body);

    // then
    expect(page.results[0]).toMatchObject({
      key: "DS",
      alias: "DATA",
      url: `${CONFLUENCE_BASE}/spaces/DATA`,
    });
  });

  it("should drop a space with no key, which nothing could be scoped to", () => {
    // given
    const body = { results: [{ id: 77, name: "Nameless" }] };

    // when
    const page = parseSpacePage(body);

    // then
    expect(page.results).toEqual([]);
  });
});

describe("parsePageListing", () => {
  it("should read the parent of each page, normalising both id shapes", () => {
    // given
    const body = aPageListingResponse([
      { id: 900, title: "Home" },
      { id: 901, title: "Child", parentId: 900 },
    ]);

    // when
    const listing = parsePageListing(body);

    // then
    expect(listing.results).toEqual([
      { id: "900", title: "Home", parentId: null },
      { id: "901", title: "Child", parentId: "900" },
    ]);
  });
});

describe("parseViewCount and parseContentBody", () => {
  it("should read a view count", () => {
    // given / when / then
    expect(parseViewCount({ count: 42 })).toBe(42);
  });

  it("should report null for a response carrying no count", () => {
    // given
    // A site that answered without a count has not said the page went unread.
    const body = {};

    // when / then
    expect(parseViewCount(body)).toBeNull();
  });

  it("should read a storage body out of a content response", () => {
    // given
    const body = { body: { storage: { value: "<p>hello</p>", representation: "storage" } } };

    // when / then
    expect(parseContentBody(body)).toBe("<p>hello</p>");
    expect(parseContentBody({})).toBeNull();
  });
});

describe("parseBulkUsers", () => {
  it("should read the accounts out of a results envelope", () => {
    // given
    const body = {
      results: [aConfluenceUser("ACCT-A", { displayName: "Ada" })],
      _links: { base: CONFLUENCE_BASE },
    };

    // when
    const users = parseBulkUsers(body);

    // then
    expect(users).toEqual([
      {
        accountId: "acct-a",
        displayName: "Ada",
        email: null,
        avatarUrl: `${CONFLUENCE_BASE}/aa-avatar/ACCT-A`,
      },
    ]);
  });

  it("should read a bare array, which some sites answer with instead", () => {
    // given
    const body = [aConfluenceUser("acct-b", { displayName: "Bo" })];

    // when
    const users = parseBulkUsers(body);

    // then
    expect(users.map((user) => user.displayName)).toEqual(["Bo"]);
  });
});

describe("toObservedIdentity", () => {
  it("should point an unlinked account at the Atlassian people directory", () => {
    // given
    // That page exists for every account whether or not it has ever touched
    // Confluence, which is what makes it the right destination for an identity
    // nobody has linked yet.
    const user = {
      accountId: "acct-a",
      displayName: "Ada",
      email: "ada@example.com",
      avatarUrl: `${CONFLUENCE_BASE}/aa-avatar/acct-a`,
    };

    // when
    const identity = toObservedIdentity(user, CONFLUENCE_BASE);

    // then
    expect(identity).toEqual({
      source: "confluence",
      sourceKey: "acct-a",
      displayName: "Ada",
      email: "ada@example.com",
      avatarUrl: `${CONFLUENCE_BASE}/aa-avatar/acct-a`,
      profileUrl: `${CONFLUENCE_BASE}/people/acct-a`,
    });
  });

  it("should leave the profile link null when the site reported no base", () => {
    // given
    const user = { accountId: "acct-a", displayName: null, email: null, avatarUrl: null };

    // when
    const identity = toObservedIdentity(user, null);

    // then
    expect(identity.profileUrl).toBeNull();
  });
});

describe("toInstant and isWithin", () => {
  it("should normalise an offset timestamp to UTC", () => {
    // given
    // v1 answers with an offset and v2 with a Z, and the two parse to the same
    // instant but do not compare as strings.
    const value = "2026-08-01T10:12:00.000+01:00";

    // when / then
    expect(toInstant(value)).toBe("2026-08-01T09:12:00.000Z");
  });

  it("should report null for something that is not a date", () => {
    // given / when / then
    expect(toInstant("never")).toBeNull();
    expect(toInstant(undefined)).toBeNull();
  });

  it("should include the start of the window and exclude its end", () => {
    // given / when / then
    expect(isWithin("2026-05-30T00:00:00.000Z", FROM, TO)).toBe(true);
    expect(isWithin("2026-08-28T00:00:00.000Z", FROM, TO)).toBe(false);
    expect(isWithin("2026-05-29T23:59:59.000Z", FROM, TO)).toBe(false);
    expect(isWithin(null, FROM, TO)).toBe(false);
  });
});

describe("nextPath", () => {
  it("should report null when the walk is finished", () => {
    // given / when / then
    expect(nextPath({ _links: {} })).toBeNull();
    expect(nextPath(null)).toBeNull();
  });
});

describe("countWords", () => {
  it("should count the prose and not the markup", () => {
    // given
    // A page wrapped in a layout macro would otherwise measure as though
    // somebody had written the tags.
    const storage =
      '<ac:layout><ac:layout-section><p>Deploy the <strong>gateway</strong> first.</p></ac:layout-section></ac:layout>';

    // when
    const words = countWords(storage);

    // then
    expect(words).toBe(4);
  });

  it("should count the code inside a snippet macro", () => {
    // given
    // The tag pattern would swallow everything from the CDATA opener to the
    // first closer and take the sample with it. Somebody wrote that code.
    const storage =
      '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[npm run build]]></ac:plain-text-body></ac:structured-macro>';

    // when
    const words = countWords(storage);

    // then
    expect(words).toBe(3);
  });

  it("should treat an entity as whitespace rather than as a word", () => {
    // given
    const storage = "<p>one&nbsp;two&amp;three</p>";

    // when
    const words = countWords(storage);

    // then
    expect(words).toBe(3);
  });

  it("should report zero for an empty body", () => {
    // given / when / then
    expect(countWords("")).toBe(0);
    expect(countWords("<p></p>")).toBe(0);
  });
});

describe("volumeBetween", () => {
  it("should report growth as words added", () => {
    // given / when
    const volume = volumeBetween(120, 200);

    // then
    expect(volume).toEqual({ added: 80, removed: 0 });
  });

  it("should report shrinkage as words removed rather than as negative addition", () => {
    // given
    // A window somebody spent pruning a runbook is real work, not a negative
    // contribution.
    const volume = volumeBetween(200, 120);

    // then
    expect(volume).toEqual({ added: 0, removed: 80 });
  });

  it("should report nothing for a rewrite that kept the same length", () => {
    // given
    // The known limitation of a length delta, stated as a test so nobody
    // rediscovers it as a bug: Confluence serves no diff, so a paragraph
    // rewritten to the same size measures as zero.
    const volume = volumeBetween(200, 200);

    // then
    expect(volume).toEqual({ added: 0, removed: 0 });
  });
});
