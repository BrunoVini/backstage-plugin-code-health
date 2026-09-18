import { DEFAULT_CONFLUENCE_SETTINGS } from "../../../../src/domain/entities/confluence_settings";
import type { AtlassianSettings } from "../../../../src/domain/entities/ingestion_settings";
import { EMPTY_CATALOG_FACTS } from "../../../../src/domain/entities/tracked_repository";
import { RequestBudget } from "../../../../src/domain/entities/request_budget";
import type {
  IdentityObserver,
  ObservedIdentity,
} from "../../../../src/domain/services/identity_resolver";
import { ProviderGateway } from "../../../../src/infrastructure/http/provider_gateway";
import { AtlassianClient } from "../../../../src/infrastructure/services/atlassian/atlassian_client";
import { ConfluenceApiEnricher } from "../../../../src/infrastructure/services/atlassian/confluence_enricher";
import {
  aConfluenceUser,
  aPageListingResponse,
  aSearchResponse,
  aSpacesResponse,
  aVersion,
  aVersionsResponse,
  CONFLUENCE_BASE,
  ConfluencePageBuilder,
} from "../../../builders/confluence_page_builder";
import { aTrackedRepository } from "../../../builders/tracked_repository_builder";
import { ControlledClock } from "../../../doubles/controlled_clock";
import { RecordingLogger } from "../../../doubles/recording_logger";
import { TestProviderServer } from "../../../doubles/test_provider_server";

const server = new TestProviderServer();

/** The run's clock. A 90-day window therefore starts on 2026-05-30. */
const NOW = new Date("2026-08-28T00:00:00.000Z");

/**
 * Records what the sweep said it saw.
 *
 * Reporting identities is a fire-and-forget side effect with nothing else to
 * observe it by, which is the one case the testing standard allows a recording
 * double for.
 */
class RecordingIdentityObserver implements IdentityObserver {
  readonly observed: ObservedIdentity[] = [];

  async observe(identities: readonly ObservedIdentity[]): Promise<void> {
    this.observed.push(...identities);
  }
}

/** An observer that refuses, to prove the measures survive it. */
class FailingIdentityObserver implements IdentityObserver {
  async observe(): Promise<void> {
    throw new Error("identities table is locked");
  }
}

beforeAll(async () => server.start());
afterAll(async () => server.stop());
beforeEach(() => server.reset());

const atlassianSettings = (
  overrides: Partial<AtlassianSettings> = {},
): AtlassianSettings => ({
  baseUrl: server.baseUrl,
  email: "code-health@example.com",
  apiToken: "fixture-token-placeholder",
  maxResultsPerRun: 2000,
  historyDays: 90,
  jira: { enabled: false, storyPointsField: null },
  confluence: { enabled: true, spaceKeys: [] },
  ...overrides,
});

const createEnricher = (
  atlassian: AtlassianSettings = atlassianSettings(),
  identities: IdentityObserver = new RecordingIdentityObserver(),
) => {
  const logger = new RecordingLogger();
  const gateway = new ProviderGateway({
    logger,
    concurrencyPerHost: 4,
    clock: new ControlledClock(1_000_000),
  });
  const client = new AtlassianClient({ gateway, settings: atlassian, logger });
  const enricher = new ConfluenceApiEnricher({
    client,
    atlassian,
    settings: DEFAULT_CONFLUENCE_SETTINGS,
    identities,
    logger,
    now: () => NOW,
  });
  return { enricher, logger, identities };
};

const context = () => ({ budget: new RequestBudget(400) });

/** The CQL a recorded search request carried. */
const cqlOf = (request: { query: URLSearchParams }): string => request.query.get("cql") ?? "";

type SearchAnswer = { readonly when: (cql: string) => boolean; readonly body: unknown };

/**
 * Answers `/rest/api/search` by inspecting the CQL, the way the real API does.
 *
 * Routing on the query rather than on the path is the point: every count, every
 * ordered lookup and the sweep itself share one endpoint, so a double that
 * ignored the query would agree with a collector that built the wrong one.
 */
const searchAnswers = (answers: readonly SearchAnswer[]): void => {
  server.onPath("/rest/api/search", (request) => {
    const cql = cqlOf(request);
    const answer = answers.find((candidate) => candidate.when(cql));
    return { body: answer?.body ?? aSearchResponse({ results: [], totalSize: 0 }) };
  });
};

const contains =
  (...fragments: readonly string[]) =>
  (cql: string): boolean =>
    fragments.every((fragment) => cql.includes(fragment));

/**
 * The routes every scenario needs, registered last so a scenario's own routes
 * win. Analytics answers 403, which is what a Confluence Standard site does.
 */
const withDefaults = (): void => {
  server
    .onPath("/views", () => ({ status: 403, body: { message: "not permitted" } }))
    .onPath("/versions", () => ({ body: aVersionsResponse([]) }))
    .onPath("/bulk", () => ({ body: { results: [] } }))
    .onPath("/spaces", () => ({ body: aSpacesResponse([]) }))
    .onPath("/pages", () => ({ body: aPageListingResponse([]) }))
    .onPath("/rest/api/search", () => ({
      body: aSearchResponse({ results: [], totalSize: 0 }),
    }));
};

const ADA = "acct-ada";
const BO = "acct-bo";

describe("ConfluenceApiEnricher.fetchContributors", () => {
  it("should credit a page to whoever created it and each edit to whoever made it", async () => {
    // given
    // The whole reason a version walk exists: CQL names only the creator and
    // the last editor, so attribution taken from the search alone would give
    // every page to one of the two.
    searchAnswers([
      {
        when: contains("type in (page, blogpost)", "lastmodified >="),
        body: aSearchResponse({
          totalSize: 2,
          results: [
            ConfluencePageBuilder.create()
              .withId("1001")
              .inSpace("ENG")
              .createdOn("2026-07-01T09:00:00.000Z", aConfluenceUser(ADA))
              .modifiedOn("2026-08-01T09:00:00.000Z", aConfluenceUser(BO))
              .atVersion(2)
              .build(),
            ConfluencePageBuilder.create()
              .withId("2002")
              .asBlogPost()
              .inSpace("ENG")
              .createdOn("2026-06-15T09:00:00.000Z", aConfluenceUser(BO))
              .modifiedOn("2026-06-15T09:00:00.000Z", aConfluenceUser(BO))
              .build(),
          ],
        }),
      },
    ]);
    server.onPath("/versions", () => ({
      body: aVersionsResponse([
        aVersion({
          number: 1,
          authorId: ADA,
          createdAt: "2026-07-01T09:00:00.000Z",
          body: "<p>one two three</p>",
        }),
        aVersion({
          number: 2,
          authorId: BO,
          createdAt: "2026-08-01T09:00:00.000Z",
          body: "<p>one two three four five</p>",
        }),
      ]),
    }));
    withDefaults();
    const { enricher } = createEnricher();

    // when
    const metrics = await enricher.fetchContributors(context());

    // then
    expect(metrics.get(ADA)).toMatchObject({
      pagesCreated: 1,
      blogPostsCreated: 0,
      pagesEdited: 1,
      pageVersionsAuthored: 1,
      spaceKeys: ["eng"],
    });
    expect(metrics.get(BO)).toMatchObject({
      pagesCreated: 0,
      blogPostsCreated: 1,
      pagesEdited: 1,
      pageVersionsAuthored: 1,
    });
  });

  it("should label the window it measured, which is not the one the dashboard asked for", async () => {
    // given
    // Confluence measures a trailing `historyDays`, so a payload without this
    // would silently mean a different period from the commit count beside it.
    searchAnswers([
      {
        when: contains("type in (page, blogpost)"),
        body: aSearchResponse({
          totalSize: 1,
          results: [
            ConfluencePageBuilder.create()
              .createdOn("2026-07-01T09:00:00.000Z", aConfluenceUser(ADA))
              .build(),
          ],
        }),
      },
    ]);
    withDefaults();
    const { enricher } = createEnricher();

    // when
    const metrics = await enricher.fetchContributors(context());

    // then
    expect(metrics.get(ADA)?.window).toEqual({
      from: "2026-05-30T00:00:00.000Z",
      to: "2026-08-28T00:00:00.000Z",
    });
  });

  it("should not credit a creation to a page written before the window", async () => {
    // given
    // A page written last year and edited last week is in this sweep, and
    // crediting its author with a creation would be wrong.
    searchAnswers([
      {
        when: contains("type in (page, blogpost)"),
        body: aSearchResponse({
          totalSize: 1,
          results: [
            ConfluencePageBuilder.create()
              .withId("1001")
              .createdOn("2024-01-01T09:00:00.000Z", aConfluenceUser(ADA))
              .modifiedOn("2026-08-01T09:00:00.000Z", aConfluenceUser(BO))
              .build(),
          ],
        }),
      },
    ]);
    server.onPath("/versions", () => ({
      body: aVersionsResponse([
        aVersion({ number: 9, authorId: BO, createdAt: "2026-08-01T09:00:00.000Z" }),
      ]),
    }));
    withDefaults();
    const { enricher } = createEnricher();

    // when
    const metrics = await enricher.fetchContributors(context());

    // then
    expect(metrics.get(ADA)).toBeUndefined();
    expect(metrics.get(BO)).toMatchObject({ pagesCreated: 0, pageVersionsAuthored: 1 });
  });

  it("should measure written volume in words from the body either side of an edit", async () => {
    // given
    // Confluence has no line, and no diff between two versions. Words are what
    // can actually be measured, so the unit is carried and the figure is real.
    searchAnswers([
      {
        when: contains("type in (page, blogpost)"),
        body: aSearchResponse({
          totalSize: 1,
          results: [
            ConfluencePageBuilder.create()
              .withId("1001")
              .createdOn("2026-07-01T09:00:00.000Z", aConfluenceUser(ADA))
              .modifiedOn("2026-08-01T09:00:00.000Z", aConfluenceUser(BO))
              .build(),
          ],
        }),
      },
    ]);
    server.onPath("/versions", () => ({
      body: aVersionsResponse([
        aVersion({
          number: 1,
          authorId: ADA,
          createdAt: "2026-07-01T09:00:00.000Z",
          body: "<p>one two three</p>",
        }),
        aVersion({
          number: 2,
          authorId: BO,
          createdAt: "2026-08-01T09:00:00.000Z",
          body: "<p>one two three four five</p>",
        }),
      ]),
    }));
    withDefaults();
    const { enricher } = createEnricher();

    // when
    const metrics = await enricher.fetchContributors(context());

    // then
    // Version 1 has no predecessor, so the page it created counts whole.
    expect(metrics.get(ADA)).toMatchObject({
      wordsAdded: 3,
      wordsRemoved: 0,
      volumeUnit: "words",
      pagesMeasuredForVolume: 1,
    });
    expect(metrics.get(BO)).toMatchObject({ wordsAdded: 2, wordsRemoved: 0 });
  });

  it("should count a pruned page as words removed rather than as negative work", async () => {
    // given
    searchAnswers([
      {
        when: contains("type in (page, blogpost)"),
        body: aSearchResponse({
          totalSize: 1,
          results: [
            ConfluencePageBuilder.create()
              .withId("1001")
              .createdOn("2024-01-01T09:00:00.000Z", aConfluenceUser(ADA))
              .modifiedOn("2026-08-01T09:00:00.000Z", aConfluenceUser(BO))
              .build(),
          ],
        }),
      },
    ]);
    server.onPath("/versions", () => ({
      body: aVersionsResponse([
        aVersion({
          number: 1,
          authorId: ADA,
          createdAt: "2024-01-01T09:00:00.000Z",
          body: "<p>one two three four five</p>",
        }),
        aVersion({
          number: 2,
          authorId: BO,
          createdAt: "2026-08-01T09:00:00.000Z",
          body: "<p>one two</p>",
        }),
      ]),
    }));
    withDefaults();
    const { enricher } = createEnricher();

    // when
    const metrics = await enricher.fetchContributors(context());

    // then
    expect(metrics.get(BO)).toMatchObject({ wordsAdded: 0, wordsRemoved: 3 });
  });

  it("should fetch a historical body when the version list carried none", async () => {
    // given
    // The v2 versions endpoint accepts `body-format` but does not always fill
    // the body in, and Atlassian ignores parameters it does not recognise — so
    // asking and getting nothing looks exactly like asking for something that
    // does not exist.
    searchAnswers([
      {
        when: contains("type in (page, blogpost)"),
        body: aSearchResponse({
          totalSize: 1,
          results: [
            ConfluencePageBuilder.create()
              .withId("1001")
              .createdOn("2026-07-01T09:00:00.000Z", aConfluenceUser(ADA))
              .modifiedOn("2026-08-01T09:00:00.000Z", aConfluenceUser(BO))
              .build(),
          ],
        }),
      },
    ]);
    server
      .onPath("/versions", () => ({
        body: aVersionsResponse([
          aVersion({ number: 1, authorId: ADA, createdAt: "2026-07-01T09:00:00.000Z" }),
          aVersion({ number: 2, authorId: BO, createdAt: "2026-08-01T09:00:00.000Z" }),
        ]),
      }))
      .on("/rest/api/content/", (request) => ({
        body: {
          id: "1001",
          body: {
            storage: {
              value:
                request.query.get("version") === "1"
                  ? "<p>one two</p>"
                  : "<p>one two three four five six</p>",
            },
          },
        },
      }));
    withDefaults();
    const { enricher } = createEnricher();

    // when
    const metrics = await enricher.fetchContributors(context());

    // then
    expect(metrics.get(BO)).toMatchObject({ wordsAdded: 4, volumeUnit: "words" });
    // `status=historical` is what makes the version parameter mean anything;
    // without it the current body comes back for every version.
    expect(server.requestsFor("/rest/api/content/")[0].query.get("status")).toBe(
      "historical",
    );
  });

  it("should report no volume rather than zero when no body could be read", async () => {
    // given
    // A zero here would read as "this person wrote nothing" rather than
    // "nobody counted", which is the modelling mistake this plugin exists not
    // to make.
    searchAnswers([
      {
        when: contains("type in (page, blogpost)"),
        body: aSearchResponse({
          totalSize: 1,
          results: [
            ConfluencePageBuilder.create()
              .withId("1001")
              .createdOn("2026-07-01T09:00:00.000Z", aConfluenceUser(ADA))
              .build(),
          ],
        }),
      },
    ]);
    server
      .onPath("/versions", () => ({
        body: aVersionsResponse([
          aVersion({ number: 1, authorId: ADA, createdAt: "2026-07-01T09:00:00.000Z" }),
        ]),
      }))
      .on("/rest/api/content/", () => ({ status: 404, body: { message: "gone" } }));
    withDefaults();
    const { enricher } = createEnricher();

    // when
    const metrics = await enricher.fetchContributors(context());

    // then
    expect(metrics.get(ADA)).toMatchObject({
      wordsAdded: null,
      wordsRemoved: null,
      volumeUnit: "none",
      pagesMeasuredForVolume: 0,
    });
  });

  it("should report no volume when the version history was truncated before the window", async () => {
    // given
    // A page edited hundreds of times returns only as much history as the walk
    // allows. Differencing the earliest version it got back against nothing
    // would credit one editor with the entire page.
    searchAnswers([
      {
        when: contains("type in (page, blogpost)"),
        body: aSearchResponse({
          totalSize: 1,
          results: [
            ConfluencePageBuilder.create()
              .withId("1001")
              .createdOn("2019-01-01T09:00:00.000Z", aConfluenceUser(ADA))
              .modifiedOn("2026-08-01T09:00:00.000Z", aConfluenceUser(BO))
              .build(),
          ],
        }),
      },
    ]);
    server.onPath("/versions", () => ({
      body: aVersionsResponse([
        aVersion({
          number: 500,
          authorId: BO,
          createdAt: "2026-08-01T09:00:00.000Z",
          body: "<p>one two three four five</p>",
        }),
      ]),
    }));
    withDefaults();
    const { enricher } = createEnricher();

    // when
    const metrics = await enricher.fetchContributors(context());

    // then
    expect(metrics.get(BO)).toMatchObject({
      pageVersionsAuthored: 1,
      wordsAdded: null,
      volumeUnit: "none",
    });
  });

  it("should stop asking for page views after the site refuses once", async () => {
    // given
    // Premium is a property of the site, not of a page, so one refusal settles
    // it — and asking again for every page would turn one honest "not
    // available" into hundreds of refused requests a run.
    searchAnswers([
      {
        when: contains("type in (page, blogpost)"),
        body: aSearchResponse({
          totalSize: 2,
          results: [
            ConfluencePageBuilder.create()
              .withId("1001")
              .createdOn("2026-07-01T09:00:00.000Z", aConfluenceUser(ADA))
              .build(),
            ConfluencePageBuilder.create()
              .withId("1002")
              .createdOn("2026-07-02T09:00:00.000Z", aConfluenceUser(ADA))
              .build(),
          ],
        }),
      },
    ]);
    withDefaults();
    const { enricher, logger } = createEnricher();

    // when
    const metrics = await enricher.fetchContributors(context());

    // then
    expect(server.requestsFor("/views")).toHaveLength(1);
    expect(metrics.get(ADA)).toMatchObject({
      pageViews: null,
      pagesMeasuredForViews: 0,
      analytics: "unavailable",
    });
    expect(logger.at("info").join(" ")).toContain("Premium");
  });

  it("should report page views when the site actually serves analytics", async () => {
    // given
    searchAnswers([
      {
        when: contains("type in (page, blogpost)"),
        body: aSearchResponse({
          totalSize: 1,
          results: [
            ConfluencePageBuilder.create()
              .withId("1001")
              .createdOn("2026-07-01T09:00:00.000Z", aConfluenceUser(ADA))
              .build(),
          ],
        }),
      },
    ]);
    server.onPath("/views", () => ({ body: { count: 40 } }));
    withDefaults();
    const { enricher } = createEnricher();

    // when
    const metrics = await enricher.fetchContributors(context());

    // then
    expect(metrics.get(ADA)).toMatchObject({
      pageViews: 40,
      pagesMeasuredForViews: 1,
      analytics: "measured",
    });
  });

  it("should leave views unreported without blaming the plan when a lookup just fails", async () => {
    // given
    // A 500 is a bad afternoon, not a Standard site. Latching "unavailable" on
    // it would tell a Premium customer their plan is the problem.
    searchAnswers([
      {
        when: contains("type in (page, blogpost)"),
        body: aSearchResponse({
          totalSize: 1,
          results: [
            ConfluencePageBuilder.create()
              .withId("1001")
              .createdOn("2026-07-01T09:00:00.000Z", aConfluenceUser(ADA))
              .build(),
          ],
        }),
      },
    ]);
    server.onPath("/views", () => ({ status: 500, body: { message: "boom" } }));
    withDefaults();
    const { enricher } = createEnricher();

    // when
    const metrics = await enricher.fetchContributors(context());

    // then
    expect(metrics.get(ADA)).toMatchObject({
      pageViews: null,
      analytics: "not-measured",
    });
  });

  it("should still list an account by id when its name cannot be resolved", async () => {
    // given
    // The bulk lookup is cosmetic. Losing it costs the Identities screen a
    // name, not the account — and an account nobody can see is one nobody links.
    searchAnswers([
      {
        when: contains("type in (page, blogpost)"),
        body: aSearchResponse({
          totalSize: 1,
          results: [
            ConfluencePageBuilder.create()
              .withId("1001")
              .createdOn("2026-07-01T09:00:00.000Z", aConfluenceUser(ADA))
              .modifiedOn("2026-08-01T09:00:00.000Z", aConfluenceUser(ADA))
              .build(),
          ],
        }),
      },
    ]);
    server
      .onPath("/versions", () => ({
        body: aVersionsResponse([
          aVersion({ number: 1, authorId: ADA, createdAt: "2026-07-01T09:00:00.000Z" }),
          aVersion({ number: 2, authorId: "acct-zed", createdAt: "2026-07-15T09:00:00.000Z" }),
        ]),
      }))
      .onPath("/bulk", () => ({ status: 404, body: { message: "not here" } }));
    withDefaults();
    const observer = new RecordingIdentityObserver();
    const { enricher } = createEnricher(atlassianSettings(), observer);

    // when
    await enricher.fetchContributors(context());

    // then
    const zed = observer.observed.find((identity) => identity.sourceKey === "acct-zed");
    expect(zed).toMatchObject({ sourceKey: "acct-zed", displayName: null });
  });

  it("should count comments and attachments against whoever created them", async () => {
    // given
    // CQL has one `comment` type covering inline and footer, and the v2
    // endpoints that separate them take no date filter at all.
    searchAnswers([
      {
        when: contains("type = comment"),
        body: aSearchResponse({
          totalSize: 2,
          results: [
            ConfluencePageBuilder.create()
              .withId("3001")
              .asComment()
              .inSpace("OPS")
              .createdOn("2026-07-10T09:00:00.000Z", aConfluenceUser(ADA))
              .build(),
            ConfluencePageBuilder.create()
              .withId("3002")
              .asComment()
              .createdOn("2026-07-11T09:00:00.000Z", aConfluenceUser(ADA))
              .build(),
          ],
        }),
      },
      {
        when: contains("type = attachment"),
        body: aSearchResponse({
          totalSize: 1,
          results: [
            ConfluencePageBuilder.create()
              .withId("4001")
              .asAttachment()
              .createdOn("2026-07-12T09:00:00.000Z", aConfluenceUser(BO))
              .build(),
          ],
        }),
      },
    ]);
    withDefaults();
    const { enricher } = createEnricher();

    // when
    const metrics = await enricher.fetchContributors(context());

    // then
    expect(metrics.get(ADA)).toMatchObject({ commentsWritten: 2, attachmentsAdded: 0 });
    expect(metrics.get(BO)).toMatchObject({ commentsWritten: 0, attachmentsAdded: 1 });
    expect(metrics.get(ADA)?.spaceKeys).toEqual(["eng", "ops"]);
  });

  it("should survive a hit the search reported without a space or a creator", async () => {
    // given
    // Personal spaces, anonymised authors and content the token can see but not
    // resolve all arrive half-populated. None of that is a reason to lose the
    // rest of the sweep.
    searchAnswers([
      {
        when: contains("type in (page, blogpost)"),
        body: aSearchResponse({
          totalSize: 1,
          results: [
            ConfluencePageBuilder.create()
              .withId("1001")
              .inSpace(null)
              .withoutCreator()
              .modifiedOn("2026-08-01T09:00:00.000Z", aConfluenceUser(BO))
              .build(),
          ],
        }),
      },
      {
        when: contains("type = comment"),
        body: aSearchResponse({
          totalSize: 1,
          results: [
            ConfluencePageBuilder.create()
              .withId("3001")
              .asComment()
              .inSpace(null)
              .withoutCreator()
              .modifiedOn("2026-07-10T09:00:00.000Z", aConfluenceUser(BO))
              .build(),
          ],
        }),
      },
    ]);
    server.onPath("/versions", () => ({
      body: aVersionsResponse([
        aVersion({ number: 1, authorId: BO, createdAt: "2026-08-01T09:00:00.000Z" }),
      ]),
    }));
    withDefaults();
    const { enricher } = createEnricher();

    // when
    const metrics = await enricher.fetchContributors(context());

    // then
    // Nothing was created by anybody nameable, so no creation is credited — but
    // the edit and the comment still land on whoever the search could name.
    expect(metrics.get(BO)).toMatchObject({
      pagesCreated: 0,
      pageVersionsAuthored: 1,
      commentsWritten: 1,
      spaceKeys: [],
    });
  });

  it("should report an account that only ever appears as a middle version", async () => {
    // given
    // The v2 version list gives an author id and nothing else, so somebody who
    // edited a page without creating it or touching it last would otherwise be
    // missing from exactly the screen somebody goes to to link them.
    searchAnswers([
      {
        when: contains("type in (page, blogpost)"),
        body: aSearchResponse({
          totalSize: 1,
          results: [
            ConfluencePageBuilder.create()
              .withId("1001")
              .createdOn("2026-07-01T09:00:00.000Z", aConfluenceUser(ADA))
              .modifiedOn("2026-08-01T09:00:00.000Z", aConfluenceUser(ADA))
              .build(),
          ],
        }),
      },
    ]);
    server
      .onPath("/versions", () => ({
        body: aVersionsResponse([
          aVersion({ number: 1, authorId: ADA, createdAt: "2026-07-01T09:00:00.000Z" }),
          aVersion({ number: 2, authorId: "acct-zed", createdAt: "2026-07-15T09:00:00.000Z" }),
          aVersion({ number: 3, authorId: ADA, createdAt: "2026-08-01T09:00:00.000Z" }),
        ]),
      }))
      .onPath("/bulk", () => ({
        body: { results: [aConfluenceUser("acct-zed", { displayName: "Zed Editor" })] },
      }));
    withDefaults();
    const observer = new RecordingIdentityObserver();
    const { enricher } = createEnricher(atlassianSettings(), observer);

    // when
    const metrics = await enricher.fetchContributors(context());

    // then
    expect(metrics.get("acct-zed")).toMatchObject({ pageVersionsAuthored: 1, pagesEdited: 1 });
    const zed = observer.observed.find((identity) => identity.sourceKey === "acct-zed");
    expect(zed).toMatchObject({ source: "confluence", displayName: "Zed Editor" });
  });

  it("should keep its measures when the identities cannot be recorded", async () => {
    // given
    // The measures are the point of the pass; the Identities screen catching up
    // on the next run is the smaller loss.
    searchAnswers([
      {
        when: contains("type in (page, blogpost)"),
        body: aSearchResponse({
          totalSize: 1,
          results: [
            ConfluencePageBuilder.create()
              .createdOn("2026-07-01T09:00:00.000Z", aConfluenceUser(ADA))
              .build(),
          ],
        }),
      },
    ]);
    withDefaults();
    const { enricher, logger } = createEnricher(
      atlassianSettings(),
      new FailingIdentityObserver(),
    );

    // when
    const metrics = await enricher.fetchContributors(context());

    // then
    expect(metrics.get(ADA)?.pagesCreated).toBe(1);
    expect(logger.at("warn").join(" ")).toContain("Confluence identities");
  });

  it("should scope every query to the configured spaces", async () => {
    // given
    // A space-restricted CQL query is answered from an index, so scoping cuts
    // the cost of the expensive walks rather than merely filtering them.
    withDefaults();
    const { enricher } = createEnricher(
      atlassianSettings({ confluence: { enabled: true, spaceKeys: ["ENG", "OPS"] } }),
    );

    // when
    await enricher.fetchContributors(context());

    // then
    const queries = server.requestsFor("/rest/api/search").map(cqlOf);
    expect(queries.length).toBeGreaterThan(0);
    for (const cql of queries) expect(cql).toContain('space in ("ENG", "OPS")');
  });

  it("should scope the sweep to a configured space's original key when the configuration names its alias", async () => {
    // given
    // CQL matches only the key a space was created with. The spaces API
    // resolves the new key an administrator gave it, so the sweep asks there
    // first and queries with what came back.
    server.onPath("/spaces", () => ({
      body: aSpacesResponse([{ id: 77, key: "DS", alias: "DATA", homepageId: 900 }]),
    }));
    withDefaults();
    const { enricher } = createEnricher(
      atlassianSettings({ confluence: { enabled: true, spaceKeys: ["DATA"] } }),
    );

    // when
    await enricher.fetchContributors(context());

    // then
    const queries = server.requestsFor("/rest/api/search").map(cqlOf);
    expect(queries.length).toBeGreaterThan(0);
    for (const cql of queries) expect(cql).toContain('space in ("DS")');
    expect(server.requestsFor("/spaces")).toHaveLength(1);
  });

  it("should ask Confluence nothing at all when the integration is switched off", async () => {
    // given
    withDefaults();
    const { enricher } = createEnricher(
      atlassianSettings({ confluence: { enabled: false, spaceKeys: [] } }),
    );

    // when
    const metrics = await enricher.fetchContributors(context());

    // then
    expect(metrics.size).toBe(0);
    expect(server.requests).toHaveLength(0);
  });

  it("should ask Confluence nothing when the site was never configured", async () => {
    // given
    withDefaults();
    const { enricher } = createEnricher(atlassianSettings({ apiToken: null }));

    // when
    const metrics = await enricher.fetchContributors(context());

    // then
    expect(metrics.size).toBe(0);
    expect(server.requests).toHaveLength(0);
  });

  it("should keep what it collected when the run's allowance runs out", async () => {
    // given
    // A partial window is a real measurement of its own days, and losing it
    // would mean the next run started from nothing.
    searchAnswers([
      {
        when: contains("type in (page, blogpost)"),
        body: aSearchResponse({
          totalSize: 1,
          results: [
            ConfluencePageBuilder.create()
              .withId("1001")
              .createdOn("2026-07-01T09:00:00.000Z", aConfluenceUser(ADA))
              .build(),
          ],
        }),
      },
    ]);
    withDefaults();
    const { enricher, logger } = createEnricher();

    // when
    // Enough for the sweep, not enough for everything after it.
    const metrics = await enricher.fetchContributors({ budget: new RequestBudget(2) });

    // then
    expect(metrics.get(ADA)?.pagesCreated).toBe(1);
    expect(logger.at("info").join(" ")).toContain("stopped early");
  });
});

const aConfluenceRepository = (id: string, spaceKey: string | null) =>
  aTrackedRepository({
    id,
    entityRef: `component:default/${id}`,
    catalogFacts: { ...EMPTY_CATALOG_FACTS, confluenceSpaceKey: spaceKey },
  });

/** The counts and lookups a space report is assembled from. */
const spaceAnswers = (): void => {
  searchAnswers([
    {
      when: (cql) => cql === 'type = page and space in ("ENG")',
      body: aSearchResponse({ totalSize: 120 }),
    },
    {
      when: contains("type = page", "created >="),
      body: aSearchResponse({ totalSize: 5 }),
    },
    {
      when: (cql) =>
        cql.includes("type = page") &&
        cql.includes("lastmodified >=") &&
        !cql.includes("order by"),
      body: aSearchResponse({ totalSize: 9 }),
    },
    { when: contains("type = blogpost"), body: aSearchResponse({ totalSize: 2 }) },
    { when: contains("type = comment"), body: aSearchResponse({ totalSize: 30 }) },
    { when: contains("type = attachment"), body: aSearchResponse({ totalSize: 4 }) },
    {
      when: (cql) =>
        cql.includes("type = page") &&
        cql.includes("lastmodified <") &&
        !cql.includes("lastmodified >="),
      body: aSearchResponse({ totalSize: 31 }),
    },
    {
      when: contains("order by lastmodified asc"),
      body: aSearchResponse({
        totalSize: 120,
        results: [
          ConfluencePageBuilder.create()
            .withId("5005")
            .withTitle("Onboarding, 2021 edition")
            .modifiedOn("2021-03-04T09:00:00.000Z")
            .build(),
        ],
      }),
    },
    {
      when: contains("type in (page, blogpost)", "order by lastmodified desc", "lastmodified >="),
      body: aSearchResponse({
        totalSize: 1,
        results: [
          ConfluencePageBuilder.create()
            .withId("1001")
            .createdOn("2026-07-01T09:00:00.000Z", aConfluenceUser(ADA))
            .modifiedOn("2026-08-20T09:00:00.000Z", aConfluenceUser(BO))
            .build(),
        ],
      }),
    },
    {
      when: contains("type in (page, blogpost)", "order by lastmodified desc"),
      body: aSearchResponse({
        totalSize: 120,
        results: [
          ConfluencePageBuilder.create()
            .withId("1001")
            .modifiedOn("2026-08-20T09:00:00.000Z")
            .build(),
        ],
      }),
    },
  ]);
};

describe("ConfluenceApiEnricher.fetchRepositories", () => {
  it("should report a space against the repository whose entity names it", async () => {
    // given
    spaceAnswers();
    server
      .onPath("/spaces", () => ({
        body: aSpacesResponse([
          { id: 77, key: "ENG", name: "Engineering", homepageId: 900 },
        ]),
      }))
      .onPath("/pages", () => ({
        body: aPageListingResponse([
          { id: 900, title: "Home" },
          { id: 901, title: "Child", parentId: 900 },
          { id: 902, title: "Stranded" },
        ]),
      }));
    withDefaults();
    const { enricher } = createEnricher();

    // when
    const metrics = await enricher.fetchRepositories(
      [aConfluenceRepository("repo-eng", "ENG"), aConfluenceRepository("repo-none", null)],
      context(),
    );

    // then
    expect([...metrics.keys()]).toEqual(["repo-eng"]);
    expect(metrics.get("repo-eng")).toMatchObject({
      space: { key: "ENG", name: "Engineering" },
      totalPages: 120,
      pagesCreated: 5,
      pagesEdited: 9,
      blogPostsCreated: 2,
      commentsWritten: 30,
      attachmentsAdded: 4,
      stalePages: 31,
      staleAfterDays: 180,
      lastActivityAt: "2026-08-20T09:00:00.000Z",
    });
    // The homepage has no parent by definition, so counting it would put every
    // space in the fleet one page into the red.
    expect(metrics.get("repo-eng")?.parentlessPages).toBe(1);
    expect(metrics.get("repo-eng")?.stalestPage).toMatchObject({
      id: "5005",
      title: "Onboarding, 2021 edition",
      lastModifiedAt: "2021-03-04T09:00:00.000Z",
    });
  });

  it("should count the people who touched the space in the window", async () => {
    // given
    spaceAnswers();
    server.onPath("/spaces", () => ({
      body: aSpacesResponse([{ id: 77, key: "ENG", homepageId: 900 }]),
    }));
    withDefaults();
    const { enricher } = createEnricher();

    // when
    const metrics = await enricher.fetchRepositories(
      [aConfluenceRepository("repo-eng", "ENG")],
      context(),
    );

    // then
    // The sweep's one page names a creator and a different last editor.
    expect(metrics.get("repo-eng")?.contributors).toBe(2);
  });

  it("should measure a space once when two repositories share it", async () => {
    // given
    // Two components documented in one space share every figure, and asking
    // twice would double the cost to produce two identical answers.
    spaceAnswers();
    server.onPath("/spaces", () => ({
      body: aSpacesResponse([{ id: 77, key: "ENG", homepageId: 900 }]),
    }));
    withDefaults();
    const { enricher } = createEnricher();

    // when
    const metrics = await enricher.fetchRepositories(
      [aConfluenceRepository("repo-a", "ENG"), aConfluenceRepository("repo-b", "ENG")],
      context(),
    );

    // then
    expect(metrics.get("repo-a")).toBe(metrics.get("repo-b"));
    expect(server.requestsFor("/rest/api/search").map(cqlOf)).toHaveLength(10);
  });

  it("should keep measuring the other spaces when one cannot be read", async () => {
    // given
    // A renamed or archived space, or one outside the token's permissions, is
    // not a reason to lose every other space in the fleet.
    server.route((request) =>
      request.path.endsWith("/rest/api/search") && cqlOf(request).includes('"BAD"')
        ? { status: 404, body: { message: "no such space" } }
        : undefined,
    );
    spaceAnswers();
    server.onPath("/spaces", () => ({
      body: aSpacesResponse([{ id: 77, key: "ENG", homepageId: 900 }]),
    }));
    withDefaults();
    const { enricher, logger } = createEnricher();

    // when
    const metrics = await enricher.fetchRepositories(
      [aConfluenceRepository("repo-bad", "BAD"), aConfluenceRepository("repo-eng", "ENG")],
      context(),
    );

    // then
    expect([...metrics.keys()]).toEqual(["repo-eng"]);
    expect(logger.at("warn").join(" ")).toContain("BAD");
  });

  it("should stop the space sweep when the run's allowance runs out", async () => {
    // given
    // A run that spent its budget on version control leaves the space report
    // for tomorrow rather than failing the whole snapshot pass.
    spaceAnswers();
    server.onPath("/spaces", () => ({
      body: aSpacesResponse([{ id: 77, key: "ENG", homepageId: 900 }]),
    }));
    withDefaults();
    const { enricher, logger } = createEnricher();

    // when
    const metrics = await enricher.fetchRepositories(
      [aConfluenceRepository("repo-eng", "ENG")],
      { budget: new RequestBudget(3) },
    );

    // then
    expect(metrics.size).toBe(0);
    expect(logger.at("info").join(" ")).toContain("stopped at ENG");
  });

  it("should skip a space the configuration does not track", async () => {
    // given
    // A configured allow-list states which spaces this plugin reads at all, so
    // an annotation naming one outside it is not a way around the setting.
    withDefaults();
    const { enricher } = createEnricher(
      atlassianSettings({ confluence: { enabled: true, spaceKeys: ["OPS"] } }),
    );

    // when
    const metrics = await enricher.fetchRepositories(
      [aConfluenceRepository("repo-eng", "ENG")],
      context(),
    );

    // then
    // One request, to learn whether the annotation is an alias of a tracked
    // space; nothing measured.
    expect(metrics.size).toBe(0);
    expect(server.requestsFor("/spaces")).toHaveLength(1);
    expect(server.requestsFor("/rest/api/search")).toHaveLength(0);
  });

  it("should query a space by its original key when the annotation names its alias", async () => {
    // given
    // The spaces API resolves the alias but reports the space under its
    // original key, which is the only one CQL matches. Indexed by what came
    // back, the lookup missed every annotation copied from a renamed space's
    // URL, and every count then ran against a key CQL does not know.
    searchAnswers([{ when: () => true, body: aSearchResponse({ totalSize: 3 }) }]);
    server.onPath("/spaces", () => ({
      body: aSpacesResponse([
        { id: 77, key: "DS", alias: "DATA", name: "Data platform", homepageId: 900 },
      ]),
    }));
    withDefaults();
    const { enricher, logger } = createEnricher();

    // when
    const metrics = await enricher.fetchRepositories(
      [aConfluenceRepository("repo-data", "DATA")],
      context(),
    );

    // then
    const queries = server.requestsFor("/rest/api/search").map(cqlOf);
    expect(queries.length).toBeGreaterThan(0);
    for (const cql of queries) expect(cql).toContain('space in ("DS")');
    // Reported under the key the annotation carries, with the name resolved.
    expect(metrics.get("repo-data")?.space).toEqual({
      key: "DATA",
      name: "Data platform",
      url: `${CONFLUENCE_BASE}/spaces/DATA`,
    });
    expect(logger.at("warn")).toEqual([]);
  });

  it("should recognise a tracked space whichever of its keys the annotation and the configuration use", async () => {
    // given
    // The allow-list names the original key and the annotation the alias, or
    // the other way round: both name one space, and Confluence is the one
    // that can say so.
    searchAnswers([{ when: () => true, body: aSearchResponse({ totalSize: 3 }) }]);
    server.onPath("/spaces", () => ({
      body: aSpacesResponse([{ id: 77, key: "DS", alias: "DATA", homepageId: 900 }]),
    }));
    withDefaults();
    const byOriginal = createEnricher(
      atlassianSettings({ confluence: { enabled: true, spaceKeys: ["DS"] } }),
    ).enricher;
    const byAlias = createEnricher(
      atlassianSettings({ confluence: { enabled: true, spaceKeys: ["data"] } }),
    ).enricher;

    // when
    const aliasAnnotated = await byOriginal.fetchRepositories(
      [aConfluenceRepository("repo-data", "DATA")],
      context(),
    );
    const originalAnnotated = await byAlias.fetchRepositories(
      [aConfluenceRepository("repo-ds", "DS")],
      context(),
    );

    // then
    expect([...aliasAnnotated.keys()]).toEqual(["repo-data"]);
    expect([...originalAnnotated.keys()]).toEqual(["repo-ds"]);
  });

  it("should say so when Confluence lists no space for an annotation", async () => {
    // given
    // The counts are taken anyway, in case CQL knows a key the spaces API did
    // not — but a space nobody can find is the one case where every figure
    // comes back as a quiet quarter, and nothing on screen could tell.
    spaceAnswers();
    withDefaults();
    const { enricher, logger } = createEnricher();

    // when
    const metrics = await enricher.fetchRepositories(
      [aConfluenceRepository("repo-eng", "ENG")],
      context(),
    );

    // then
    expect(metrics.get("repo-eng")?.totalPages).toBe(120);
    const warning = logger.at("warn").join(" ");
    expect(warning).toContain("lists no space with the key ENG");
    expect(warning).toContain("component:default/repo-eng");
  });

  it("should still report the counts when the space itself could not be read", async () => {
    // given
    // Losing the space lookup costs a name, a link and the homepage id — not
    // the measurements.
    spaceAnswers();
    server.onPath("/spaces", () => ({ status: 404, body: { message: "no such space" } }));
    withDefaults();
    const { enricher, logger } = createEnricher();

    // when
    const metrics = await enricher.fetchRepositories(
      [aConfluenceRepository("repo-eng", "ENG")],
      context(),
    );

    // then
    expect(metrics.get("repo-eng")).toMatchObject({
      space: { key: "ENG", name: null, url: null },
      totalPages: 120,
      parentlessPages: null,
    });
    expect(logger.at("warn").join(" ")).toContain("Confluence spaces");
  });

  it("should report null for a count the site answered without a size", async () => {
    // given
    // A count query asks for one row, so falling back to what came back would
    // report a fleet of spaces each holding exactly one page.
    searchAnswers([{ when: () => true, body: aSearchResponse({ results: [] }) }]);
    server.onPath("/spaces", () => ({
      body: aSpacesResponse([{ id: 77, key: "ENG", homepageId: 900 }]),
    }));
    withDefaults();
    const { enricher } = createEnricher();

    // when
    const metrics = await enricher.fetchRepositories(
      [aConfluenceRepository("repo-eng", "ENG")],
      context(),
    );

    // then
    expect(metrics.get("repo-eng")).toMatchObject({
      totalPages: null,
      stalePages: null,
      stalestPage: null,
      lastActivityAt: null,
      pageViews: null,
      analytics: "not-measured",
    });
  });

  it("should report nothing when nothing in the catalog names a space", async () => {
    // given
    withDefaults();
    const { enricher } = createEnricher();

    // when
    const metrics = await enricher.fetchRepositories(
      [aConfluenceRepository("repo-none", null)],
      context(),
    );

    // then
    expect(metrics.size).toBe(0);
    expect(server.requests).toHaveLength(0);
  });
});
