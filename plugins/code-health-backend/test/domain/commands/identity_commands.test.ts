import {
  LinkIdentity,
  MalformedEntityRefError,
  NotAUserReferenceError,
  UnknownIdentityError,
  UnknownUserError,
} from "../../../src/domain/commands/link_identity";
import { ListContributorSummaries } from "../../../src/domain/commands/list_contributor_summaries";
import { ListIdentities } from "../../../src/domain/commands/list_identities";
import { ReconcileIdentities } from "../../../src/domain/commands/reconcile_identities";
import { DiscoveredRepositoryBuilder } from "../../builders/discovered_repository_builder";
import { EventBuilder } from "../../builders/event_builder";
import { WakaTimeMetricsBuilder } from "../../builders/wakatime_metrics_builder";
import { InMemoryCodeHealthStore } from "../../doubles/in_memory_code_health_store";
import { RecordingLogger } from "../../doubles/recording_logger";
import { StubCatalogReader } from "../../doubles/stub_catalog_reader";
import { StubDirectoryReader } from "../../doubles/stub_directory_reader";

const NOW = new Date("2026-08-10T12:00:00.000Z");
const WINDOW = {
  from: new Date("2026-08-09T00:00:00.000Z"),
  to: new Date("2026-08-11T00:00:00.000Z"),
};

const seed = async (
  identities: Array<{
    source: "vcs" | "wakatime" | "jira" | "confluence";
    sourceKey: string;
    displayName?: string | null;
    email?: string | null;
  }>,
) => {
  const store = new InMemoryCodeHealthStore();
  await store.recordObservedIdentities({
    identities: identities.map((identity) => ({
      source: identity.source,
      sourceKey: identity.sourceKey,
      displayName: identity.displayName ?? null,
      email: identity.email ?? null,
      avatarUrl: null,
      profileUrl: null,
    })),
    now: NOW,
  });
  return store;
};

describe("ListIdentities", () => {
  it("should list every observed account with its link", async () => {
    // given
    const store = await seed([
      { source: "vcs", sourceKey: "dev@example.com" },
      { source: "wakatime", sourceKey: "jrios" },
    ]);
    await store.saveIdentityLink({
      source: "vcs",
      sourceKey: "dev@example.com",
      entityRef: "user:default/felipe",
      origin: "catalog-email",
      linkedBy: null,
      linkedAt: NOW,
    });

    // when
    const rows = await new ListIdentities(store, new StubDirectoryReader()).run({});

    // then
    expect(rows).toHaveLength(2);
    expect(rows[0]?.link?.entityRef).toBe("user:default/felipe");
    expect(rows[0]?.identity.firstSeenAt).toBe(NOW.toISOString());
    expect(rows[1]?.link).toBeNull();
  });

  it("should narrow the listing to one source", async () => {
    // given
    const store = await seed([
      { source: "vcs", sourceKey: "dev@example.com" },
      { source: "wakatime", sourceKey: "jrios" },
    ]);

    // when
    const rows = await new ListIdentities(store, new StubDirectoryReader()).run({
      sources: ["wakatime"],
    });

    // then
    expect(rows.map((row) => row.identity.source)).toEqual(["wakatime"]);
  });

  it("should show only the accounts nobody has linked when asked", async () => {
    // given
    const store = await seed([
      { source: "vcs", sourceKey: "dev@example.com" },
      { source: "wakatime", sourceKey: "jrios" },
    ]);
    await store.saveIdentityLink({
      source: "vcs",
      sourceKey: "dev@example.com",
      entityRef: "user:default/felipe",
      origin: "manual",
      linkedBy: "user:default/admin",
      linkedAt: NOW,
    });

    // when
    const rows = await new ListIdentities(store, new StubDirectoryReader()).run({
      linked: false,
    });

    // then
    expect(rows.map((row) => row.identity.sourceKey)).toEqual(["jrios"]);
  });

  it("should offer ranked suggestions for an unlinked account", async () => {
    // given
    const store = await seed([
      { source: "wakatime", sourceKey: "jrios", displayName: "Felipe Rios" },
    ]);
    const directory = new StubDirectoryReader([
      {
        entityRef: "user:default/felipe",
        displayName: "Felipe Rios",
        email: "felipe@example.com",
        picture: null,
      },
      {
        entityRef: "user:default/ana",
        displayName: "Ana Costa",
        email: "ana@example.com",
        picture: null,
      },
    ]);

    // when
    const [row] = await new ListIdentities(store, directory).run({});

    // then
    expect(row?.suggestions.map((suggestion) => suggestion.entityRef)).toEqual([
      "user:default/felipe",
    ]);
    expect(row?.suggestions[0]?.reason).toBe("same display name");
  });

  it("should offer nothing for an account that already has a link", async () => {
    // given
    // Offering alternatives beside a correct row invites somebody to change it
    // for a plausible-looking wrong one.
    const store = await seed([
      { source: "wakatime", sourceKey: "jrios", displayName: "Felipe Rios" },
    ]);
    await store.saveIdentityLink({
      source: "wakatime",
      sourceKey: "jrios",
      entityRef: "user:default/felipe",
      origin: "manual",
      linkedBy: "user:default/admin",
      linkedAt: NOW,
    });
    const directory = new StubDirectoryReader([
      {
        entityRef: "user:default/felipe",
        displayName: "Felipe Rios",
        email: null,
        picture: null,
      },
    ]);

    // when
    const [row] = await new ListIdentities(store, directory).run({});

    // then
    expect(row?.suggestions).toEqual([]);
    // And the directory is not enumerated at all when nothing needs suggesting.
    expect(directory.listUserCalls).toBe(0);
  });

  it("should enumerate the directory once for the whole listing", async () => {
    // given
    // Per row it would turn a screen with two hundred unlinked accounts into
    // two hundred catalog queries.
    const store = await seed([
      { source: "wakatime", sourceKey: "one" },
      { source: "wakatime", sourceKey: "two" },
    ]);
    const directory = new StubDirectoryReader();

    // when
    await new ListIdentities(store, directory).run({});

    // then
    expect(directory.listUserCalls).toBe(1);
  });
});

describe("LinkIdentity", () => {
  it("should link an observed account to a catalog user", async () => {
    // given
    const store = await seed([{ source: "wakatime", sourceKey: "jrios" }]);
    const directory = new StubDirectoryReader([
      { entityRef: "user:default/felipe", displayName: "Felipe", email: null, picture: null },
    ]);

    // when
    await new LinkIdentity(store, directory).link({
      source: "wakatime",
      sourceKey: "JRios",
      entityRef: "user:default/felipe",
      linkedBy: "user:default/admin",
      now: NOW,
    });

    // then
    const [link] = await store.listIdentityLinks();
    expect(link).toEqual({
      source: "wakatime",
      // Normalised on the way in, so a link made from a differently-cased
      // spelling still matches the account the collector recorded.
      sourceKey: "jrios",
      entityRef: "user:default/felipe",
      origin: "manual",
      linkedBy: "user:default/admin",
      linkedAt: NOW,
    });
  });

  it("should store the catalog's own reference, not the one that was typed", async () => {
    // given
    // The catalog resolves `user:jdoe` with the namespace omitted just as
    // happily as the canonical form, and the stored string *is* the person key
    // — so keeping the typed one would produce a key that never joins the
    // canonical one reconciliation writes, and the same human would hold two
    // rows.
    const store = await seed([{ source: "wakatime", sourceKey: "jrios" }]);
    const directory = new StubDirectoryReader([
      { entityRef: "user:default/felipe", displayName: "Felipe", email: null, picture: null },
    ]);

    // when
    await new LinkIdentity(store, directory).link({
      source: "wakatime",
      sourceKey: "jrios",
      entityRef: "user:felipe",
      linkedBy: null,
      now: NOW,
    });

    // then
    const [link] = await store.listIdentityLinks();
    expect(link?.entityRef).toBe("user:default/felipe");
  });

  it("should reject a reference that is not one at all", async () => {
    // given
    // A bare name reaches the catalog's own parser, which throws rather than
    // answering — so the screen would show a 500 where it promises to say
    // plainly that the user does not exist.
    const store = await seed([{ source: "wakatime", sourceKey: "jrios" }]);

    // when
    const linking = new LinkIdentity(store, new StubDirectoryReader()).link({
      source: "wakatime",
      sourceKey: "jrios",
      entityRef: "felipe",
      linkedBy: null,
      now: NOW,
    });

    // then
    await expect(linking).rejects.toThrow(MalformedEntityRefError);
  });

  it("should refuse a reference that names something other than a user", async () => {
    // given
    // Any kind parses, and the directory lookup would answer for a group with
    // a user-shaped record built from its name — a link stored as
    // `user:default/platform`, which is either nobody or the wrong person.
    const store = await seed([{ source: "wakatime", sourceKey: "jrios" }]);
    const directory = new StubDirectoryReader([
      { entityRef: "user:default/platform", displayName: "Platform", email: null, picture: null },
    ]);

    // when
    const linking = new LinkIdentity(store, directory).link({
      source: "wakatime",
      sourceKey: "jrios",
      entityRef: "group:default/platform",
      linkedBy: null,
      now: NOW,
    });

    // then
    await expect(linking).rejects.toThrow(NotAUserReferenceError);
    expect(await store.listIdentityLinks()).toEqual([]);
    expect(directory.refLookups).toEqual([]);
  });

  it("should refuse an account nobody has observed", async () => {
    // given
    // A link to an account that matches nothing looks exactly like a link that
    // worked, and the person who made it has no way to tell.
    const store = await seed([]);
    const directory = new StubDirectoryReader([
      { entityRef: "user:default/felipe", displayName: null, email: null, picture: null },
    ]);

    // when
    const linking = new LinkIdentity(store, directory).link({
      source: "wakatime",
      sourceKey: "ghost",
      entityRef: "user:default/felipe",
      linkedBy: null,
      now: NOW,
    });

    // then
    await expect(linking).rejects.toThrow(UnknownIdentityError);
    expect(await store.listIdentityLinks()).toEqual([]);
  });

  it("should refuse a user the catalog does not hold", async () => {
    // given
    const store = await seed([{ source: "wakatime", sourceKey: "jrios" }]);

    // when
    const linking = new LinkIdentity(store, new StubDirectoryReader()).link({
      source: "wakatime",
      sourceKey: "jrios",
      entityRef: "user:default/nobody",
      linkedBy: null,
      now: NOW,
    });

    // then
    await expect(linking).rejects.toThrow(UnknownUserError);
  });

  it("should remove a link", async () => {
    // given
    const store = await seed([{ source: "wakatime", sourceKey: "jrios" }]);
    await store.saveIdentityLink({
      source: "wakatime",
      sourceKey: "jrios",
      entityRef: "user:default/felipe",
      origin: "manual",
      linkedBy: null,
      linkedAt: NOW,
    });

    // when
    await new LinkIdentity(store, new StubDirectoryReader()).unlink({
      source: "wakatime",
      sourceKey: "JRios",
    });

    // then
    expect(await store.listIdentityLinks()).toEqual([]);
  });
});

describe("ReconcileIdentities", () => {
  const reconcile = (store: InMemoryCodeHealthStore, catalog: StubCatalogReader) =>
    new ReconcileIdentities({ store, catalog, logger: new RecordingLogger() });

  it("should link an account whose e-mail matches a catalog user", async () => {
    // given
    // The same rule the catalog itself uses to decide who a `User` is, which is
    // why it is the one rule allowed to link without a human.
    const store = await seed([
      { source: "vcs", sourceKey: "dev@example.com", email: "dev@example.com" },
    ]);
    const catalog = new StubCatalogReader().withUsers({
      "dev@example.com": {
        entityRef: "user:default/felipe",
        displayName: "Felipe",
        picture: null,
      },
    });

    // when
    const result = await reconcile(store, catalog).run({ now: NOW });

    // then
    expect(result.linked).toBe(1);
    const [link] = await store.listIdentityLinks();
    expect(link?.entityRef).toBe("user:default/felipe");
    expect(link?.origin).toBe("catalog-email");
    expect(link?.linkedBy).toBeNull();
  });

  it("should leave an account with no e-mail for a human to link", async () => {
    // given
    // A GitHub login and a WakaTime username carry no address, and a name
    // resemblance is not evidence enough to merge two people on.
    const store = await seed([{ source: "wakatime", sourceKey: "jrios", displayName: "Felipe" }]);
    const catalog = new StubCatalogReader().withUsers({
      "felipe@example.com": {
        entityRef: "user:default/felipe",
        displayName: "Felipe",
        picture: null,
      },
    });

    // when
    const result = await reconcile(store, catalog).run({ now: NOW });

    // then
    expect(result.linked).toBe(0);
    expect(await store.listIdentityLinks()).toEqual([]);
  });

  it("should not touch the catalog when everything is already linked", async () => {
    // given
    const store = await seed([
      { source: "vcs", sourceKey: "dev@example.com", email: "dev@example.com" },
    ]);
    await store.saveIdentityLink({
      source: "vcs",
      sourceKey: "dev@example.com",
      entityRef: "user:default/felipe",
      origin: "catalog-email",
      linkedBy: null,
      linkedAt: NOW,
    });
    const catalog = new StubCatalogReader();

    // when
    const result = await reconcile(store, catalog).run({ now: NOW });

    // then
    expect(result).toEqual({ observed: 1, linked: 0 });
    expect(catalog.emailLookups).toEqual([]);
  });

  it("should never overwrite a manual link", async () => {
    // given
    // This task runs every few minutes; quietly undoing somebody's correction
    // is the single failure that would make the Identities screen pointless.
    const store = await seed([
      { source: "vcs", sourceKey: "dev@example.com", email: "dev@example.com" },
    ]);
    await store.saveIdentityLink({
      source: "vcs",
      sourceKey: "dev@example.com",
      entityRef: "user:default/right",
      origin: "manual",
      linkedBy: "user:default/admin",
      linkedAt: NOW,
    });
    const catalog = new StubCatalogReader().withUsers({
      "dev@example.com": {
        entityRef: "user:default/wrong",
        displayName: null,
        picture: null,
      },
    });

    // when
    await reconcile(store, catalog).run({ now: NOW });

    // then
    const [link] = await store.listIdentityLinks();
    expect(link?.entityRef).toBe("user:default/right");
  });

  it("should leave an account whose address matches nobody alone", async () => {
    // given
    const store = await seed([
      { source: "vcs", sourceKey: "bot@ci.local", email: "bot@ci.local" },
    ]);
    const catalog = new StubCatalogReader().withUsers({});

    // when
    const result = await reconcile(store, catalog).run({ now: NOW });

    // then
    expect(result.linked).toBe(0);
    expect(await store.listIdentityLinks()).toEqual([]);
  });
});

describe("the linking chain, end to end", () => {
  it("should put a commit author and a WakaTime account on one row once both are linked", async () => {
    // given
    // The whole point of the machinery: ingestion observes the commit author,
    // reconciliation links it on the address, a person links the WakaTime
    // username the automatic rule could not, and the contributor row adds up.
    const store = new InMemoryCodeHealthStore();
    const [repository] = (
      await (async () => {
        const discovered = [DiscoveredRepositoryBuilder.create().build()];
        await store.syncRepositories({ discovered, retentionDays: 365, now: NOW });
        return discovered;
      })()
    );

    await store.commitIngestion({
      repositoryId: repository!.id,
      events: [
        EventBuilder.commit()
          .withRepository(repository!.id)
          .withActor("felipe@acme.com")
          .at("2026-08-09T10:00:00.000Z")
          .build(),
      ],
      chunk: { repositoryId: repository!.id, kinds: ["commit"], days: [], ingestedAt: NOW },
      status: "active",
      now: NOW,
    });

    // Ingestion records the accounts it met; the snapshot pass records WakaTime's.
    await store.recordObservedIdentities({
      identities: [
        {
          source: "vcs",
          sourceKey: "felipe@acme.com",
          displayName: "Felipe Rios",
          email: "felipe@acme.com",
          avatarUrl: null,
          profileUrl: null,
        },
        {
          source: "wakatime",
          sourceKey: "frios",
          displayName: "Felipe Rios",
          // No address: WakaTime reports a username, which is exactly why the
          // automatic rule cannot close this half.
          email: null,
          avatarUrl: null,
          profileUrl: null,
        },
      ],
      now: NOW,
    });
    await store.saveContributorMetrics({
      source: "wakatime",
      day: "2026-08-09",
      capturedAt: NOW,
      metrics: new Map([
        ["frios", WakaTimeMetricsBuilder.aDay("2026-08-09").withSeconds(7200).build()],
      ]),
    });

    const catalog = new StubCatalogReader().withUsers({
      "felipe@acme.com": {
        entityRef: "user:default/felipe",
        displayName: "Felipe Rios",
        picture: null,
      },
    });
    const directory = new StubDirectoryReader([
      {
        entityRef: "user:default/felipe",
        displayName: "Felipe Rios",
        email: "felipe@acme.com",
        picture: null,
      },
    ]);

    // when
    await new ReconcileIdentities({
      store,
      catalog,
      logger: new RecordingLogger(),
    }).run({ now: NOW });

    // then
    // The address matched, so the commit author is already a person; the
    // WakaTime account is still on a row of its own.
    const beforeLinking = await new ListContributorSummaries({ store, directory }).run(WINDOW);
    expect(beforeLinking.map((row) => row.key).sort()).toEqual([
      "user:default/felipe",
      "wakatime:frios",
    ]);

    // when
    // The Identities screen offers the match and somebody confirms it.
    const [row] = await new ListIdentities(store, directory).run({ linked: false });
    expect(row?.suggestions[0]?.entityRef).toBe("user:default/felipe");

    await new LinkIdentity(store, directory).link({
      source: "wakatime",
      sourceKey: "frios",
      entityRef: "user:default/felipe",
      linkedBy: "user:default/admin",
      now: NOW,
    });

    // then
    const afterLinking = await new ListContributorSummaries({ store, directory }).run(WINDOW);
    expect(afterLinking).toHaveLength(1);
    expect(afterLinking[0]).toMatchObject({
      key: "user:default/felipe",
      entityRef: "user:default/felipe",
      displayName: "Felipe Rios",
      commits: 1,
    });
    expect(afterLinking[0]?.wakaTimeMetrics?.totalSeconds).toBe(7200);
    expect(afterLinking[0]?.identities.map((identity) => identity.source).sort()).toEqual([
      "vcs",
      "wakatime",
    ]);
  });

  it("should apply a link made today to a window collected before it", async () => {
    // given
    // Links are applied when a row is built, not when a measurement is taken,
    // which is the whole reason a correction is worth making at all.
    const store = new InMemoryCodeHealthStore();
    await store.recordObservedIdentities({
      identities: [
        {
          source: "wakatime",
          sourceKey: "frios",
          displayName: "Felipe",
          email: null,
          avatarUrl: null,
          profileUrl: null,
        },
      ],
      now: NOW,
    });
    await store.saveContributorMetrics({
      source: "wakatime",
      day: "2026-08-09",
      capturedAt: NOW,
      metrics: new Map([
        ["frios", WakaTimeMetricsBuilder.aDay("2026-08-09").withSeconds(600).build()],
      ]),
    });
    const directory = new StubDirectoryReader([
      { entityRef: "user:default/felipe", displayName: "Felipe", email: null, picture: null },
    ]);

    // when
    // The link is made long after the measurement was stored.
    await new LinkIdentity(store, directory).link({
      source: "wakatime",
      sourceKey: "frios",
      entityRef: "user:default/felipe",
      linkedBy: "user:default/admin",
      now: new Date("2026-09-01T00:00:00.000Z"),
    });

    // then
    const [contributor] = await new ListContributorSummaries({ store, directory }).run(WINDOW);
    expect(contributor?.key).toBe("user:default/felipe");
    expect(contributor?.wakaTimeMetrics?.totalSeconds).toBe(600);
  });
});
