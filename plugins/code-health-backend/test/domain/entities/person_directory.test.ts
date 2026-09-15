import {
  identityKey,
  normalizeSourceKey,
  personKeyOf,
  type IdentityExclusionRecord,
  type IdentityLinkRecord,
  type IdentityRecord,
} from "../../../src/domain/entities/identity";
import {
  actorIdentityOf,
  measuredEvents,
  PersonDirectory,
} from "../../../src/domain/entities/person_directory";
import { EventBuilder } from "../../builders/event_builder";

const NOW = new Date("2026-08-10T12:00:00.000Z");

const anIdentity = (overrides: Partial<IdentityRecord> = {}): IdentityRecord => ({
  source: "wakatime",
  sourceKey: "jrios",
  displayName: "J Rios",
  email: null,
  avatarUrl: null,
  profileUrl: null,
  firstSeenAt: NOW,
  lastSeenAt: NOW,
  ...overrides,
});

const aLink = (overrides: Partial<IdentityLinkRecord> = {}): IdentityLinkRecord => ({
  source: "wakatime",
  sourceKey: "jrios",
  entityRef: "user:default/felipe",
  origin: "manual",
  linkedBy: "user:default/admin",
  linkedAt: NOW,
  ...overrides,
});

const noFallback = { displayName: null, avatarUrl: null, profileUrl: null };

describe("normalizeSourceKey", () => {
  it("should trim and lowercase, so two spellings are one account", () => {
    // given / when / then
    expect(normalizeSourceKey("  Dev@Example.COM ")).toBe("dev@example.com");
  });
});

describe("identityKey and personKeyOf", () => {
  it("should key an unlinked account under itself", () => {
    // given
    // Hiding an unlinked account would hide every bot, every service account,
    // and everybody nobody has got round to linking.
    const identity = { source: "vcs" as const, sourceKey: "bot@ci.local" };

    // when / then
    expect(identityKey(identity)).toBe("vcs:bot@ci.local");
    expect(personKeyOf(identity, undefined)).toBe("vcs:bot@ci.local");
  });

  it("should key a linked account under its catalog user", () => {
    // given
    const identity = { source: "wakatime" as const, sourceKey: "jrios" };

    // when / then
    expect(personKeyOf(identity, aLink())).toBe("user:default/felipe");
  });
});

describe("PersonDirectory", () => {
  it("should put two linked accounts under one key", () => {
    // given
    const directory = new PersonDirectory({
      links: [aLink(), aLink({ source: "vcs", sourceKey: "dev@example.com" })],
      identities: [],
    });

    // when
    const wakatime = directory.keyOf({ source: "wakatime", sourceKey: "jrios" });
    const vcs = directory.keyOf({ source: "vcs", sourceKey: "dev@example.com" });

    // then
    expect(wakatime).toBe(vcs);
  });

  it("should report the catalog user only for a linked person", () => {
    // given
    const directory = new PersonDirectory({ links: [aLink()], identities: [] });

    // when / then
    expect(directory.entityRefOf("user:default/felipe")).toBe("user:default/felipe");
    expect(directory.entityRefOf("vcs:bot@ci.local")).toBeNull();
  });

  it("should merge the profile fields of every account on the row", () => {
    // given
    const directory = new PersonDirectory({
      links: [aLink(), aLink({ source: "vcs", sourceKey: "dev@example.com" })],
      identities: [
        anIdentity({ displayName: null, avatarUrl: "https://example.com/wt.png" }),
        anIdentity({
          source: "vcs",
          sourceKey: "dev@example.com",
          displayName: "Felipe Rios",
          profileUrl: "https://github.com/felipe",
        }),
      ],
    });

    // when
    const profile = directory.profileOf("user:default/felipe", noFallback);

    // then
    expect(profile.displayName).toBe("Felipe Rios");
    expect(profile.avatarUrl).toBe("https://example.com/wt.png");
    expect(profile.profileUrl).toBe("https://github.com/felipe");
    expect(profile.identities).toHaveLength(2);
  });

  it("should prefer the name the most recently seen account reported", () => {
    // given
    // A name changes, and the newest one is the one the person would recognise.
    const older = anIdentity({
      sourceKey: "old",
      displayName: "Old Name",
      lastSeenAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const newer = anIdentity({ sourceKey: "new", displayName: "New Name", lastSeenAt: NOW });
    const directory = new PersonDirectory({
      links: [aLink({ sourceKey: "old" }), aLink({ sourceKey: "new" })],
      identities: [older, newer],
    });

    // when
    const profile = directory.profileOf("user:default/felipe", noFallback);

    // then
    expect(profile.displayName).toBe("New Name");
  });

  it("should fall back to what the caller knows for an account it has never seen", () => {
    // given
    // An event carries the name the provider stamped on the commit, and it is
    // better than the key.
    const directory = new PersonDirectory({ links: [], identities: [] });

    // when
    const profile = directory.profileOf("vcs:dev@example.com", {
      displayName: "Dev Example",
      avatarUrl: "https://example.com/a.png",
      profileUrl: null,
    });

    // then
    expect(profile.displayName).toBe("Dev Example");
    expect(profile.avatarUrl).toBe("https://example.com/a.png");
    expect(profile.identities).toEqual([]);
  });

  it("should ignore an empty string as though the field were absent", () => {
    // given
    const directory = new PersonDirectory({
      links: [aLink()],
      identities: [anIdentity({ displayName: "" })],
    });

    // when
    const profile = directory.profileOf("user:default/felipe", {
      ...noFallback,
      displayName: "From the commit",
    });

    // then
    expect(profile.displayName).toBe("From the commit");
  });
});

describe("PersonDirectory exclusions", () => {
  const anExclusion = (
    overrides: Partial<IdentityExclusionRecord> = {},
  ): IdentityExclusionRecord => ({
    source: "vcs",
    sourceKey: "build-service",
    reason: "service-account",
    excludedBy: "user:default/admin",
    excludedAt: NOW,
    ...overrides,
  });

  it("should measure every account by default", () => {
    // given
    const directory = new PersonDirectory({ links: [], identities: [] });

    // when / then
    expect(directory.isMeasured({ source: "vcs", sourceKey: "build-service" })).toBe(true);
    expect(directory.exclusionOf({ source: "vcs", sourceKey: "build-service" })).toBeUndefined();
  });

  it("should stop measuring an excluded account", () => {
    // given
    const directory = new PersonDirectory({
      links: [],
      identities: [],
      exclusions: [anExclusion()],
    });

    // when / then
    expect(directory.isMeasured({ source: "vcs", sourceKey: "build-service" })).toBe(false);
    expect(directory.exclusionOf({ source: "vcs", sourceKey: "build-service" })?.reason).toBe(
      "service-account",
    );
  });

  it("should leave an account nobody joined to it measured", () => {
    // given
    // Two unlinked accounts are two people as far as anything here knows.
    const directory = new PersonDirectory({
      links: [],
      identities: [],
      exclusions: [anExclusion()],
    });

    // when / then
    expect(directory.isMeasured({ source: "vcs", sourceKey: "dev@example.com" })).toBe(true);
  });

  it("should carry an exclusion to every account of the same person", () => {
    // given
    // A leaver's commits and their coding time are one person's work; taking
    // half of it out would leave a row holding a third of a story.
    const links = [
      aLink({ source: "vcs", sourceKey: "dev@example.com" }),
      aLink({ source: "wakatime", sourceKey: "jrios" }),
    ];

    // when
    const directory = new PersonDirectory({
      links,
      identities: [],
      exclusions: [
        anExclusion({ sourceKey: "dev@example.com", reason: "former-contributor" }),
      ],
    });

    // then
    expect(directory.isMeasured({ source: "wakatime", sourceKey: "jrios" })).toBe(false);
    // Reported against the account the decision was recorded on, so the screen
    // knows which row can undo it.
    expect(directory.exclusionOf({ source: "wakatime", sourceKey: "jrios" })).toMatchObject({
      source: "vcs",
      sourceKey: "dev@example.com",
    });
  });

  it("should name the earliest decision when a person has two", () => {
    // given
    // A person's row names what first took them out of the figures rather than
    // whichever of their accounts happens to be read last.
    const later = new Date("2026-09-01T00:00:00.000Z");

    // when
    const directory = new PersonDirectory({
      links: [
        aLink({ source: "vcs", sourceKey: "dev@example.com" }),
        aLink({ source: "wakatime", sourceKey: "jrios" }),
      ],
      identities: [],
      exclusions: [
        anExclusion({
          source: "wakatime",
          sourceKey: "jrios",
          reason: "automated-bot",
          excludedAt: later,
        }),
        anExclusion({ sourceKey: "dev@example.com", reason: "former-contributor" }),
      ],
    });

    // then
    expect(directory.exclusionOf({ source: "vcs", sourceKey: "dev@example.com" })?.reason).toBe(
      "former-contributor",
    );
  });
});

describe("measuredEvents", () => {
  it("should drop the events an excluded account produced", () => {
    // given
    const directory = new PersonDirectory({
      links: [],
      identities: [],
      exclusions: [
        {
          source: "vcs",
          sourceKey: "build-service",
          reason: "service-account",
          excludedBy: null,
          excludedAt: NOW,
        },
      ],
    });
    const events = [
      EventBuilder.commit().withActor("build-service").build(),
      EventBuilder.commit().withActor("dev@example.com").build(),
    ];

    // when
    const measured = measuredEvents(events, directory);

    // then
    expect(measured.map((event) => event.actorKey)).toEqual(["dev@example.com"]);
  });

  it("should match an exclusion however the provider cased the actor", () => {
    // given
    // A case-sensitive comparison would quietly measure the row somebody
    // excluded.
    const directory = new PersonDirectory({
      links: [],
      identities: [],
      exclusions: [
        {
          source: "vcs",
          sourceKey: "build-service",
          reason: "service-account",
          excludedBy: null,
          excludedAt: NOW,
        },
      ],
    });

    // when
    const measured = measuredEvents(
      [EventBuilder.commit().withActor("Build-Service").build()],
      directory,
    );

    // then
    expect(measured).toEqual([]);
  });

  it("should keep an event no provider stamped a name on", () => {
    // given
    // Nobody has been excluded, and dropping it would shrink the repository
    // counters to punish a provider that reported no author.
    const directory = new PersonDirectory({ links: [], identities: [] });
    const anonymous = EventBuilder.commit().withActor(null).build();

    // when / then
    expect(measuredEvents([anonymous], directory)).toEqual([anonymous]);
    expect(actorIdentityOf(anonymous)).toBeNull();
  });
});
