import type { DirectoryUser, ObservedIdentity } from "../src/identity";
import {
  emailLocalPart,
  IDENTITY_SOURCE_LABELS,
  IDENTITY_SOURCES,
  identityMatchScore,
  isIdentitySource,
  MAX_DIRECTORY_SEARCH_RESULTS,
  normalizeIdentityText,
  searchDirectoryUsers,
  suggestIdentityMatches,
  SUGGESTION_FLOOR,
} from "../src/identity";

const identity = (
  overrides: Partial<Pick<ObservedIdentity, "sourceKey" | "displayName" | "email">>,
): Pick<ObservedIdentity, "sourceKey" | "displayName" | "email"> => ({
  sourceKey: "someone",
  displayName: null,
  email: null,
  ...overrides,
});

const user = (overrides: Partial<DirectoryUser>): DirectoryUser => ({
  entityRef: "user:default/someone",
  displayName: null,
  email: null,
  picture: null,
  ...overrides,
});

describe("isIdentitySource", () => {
  it("should accept every declared source and label it", () => {
    // given
    const sources = IDENTITY_SOURCES;

    // when
    const allValid = sources.every(isIdentitySource);

    // then
    expect(allValid).toBe(true);
    expect(Object.keys(IDENTITY_SOURCE_LABELS).sort()).toEqual([...sources].sort());
  });

  it("should reject anything else", () => {
    // given / when / then
    expect(isIdentitySource("sonar")).toBe(false);
    expect(isIdentitySource(undefined)).toBe(false);
  });
});

describe("normalizeIdentityText", () => {
  it("should fold diacritics so a directory and a git config agree", () => {
    // given
    // Entra ID holds the accented form; `user.name` in a git config routinely
    // does not, and treating those as two people defeats the whole screen.
    const directory = "José Ríos";
    const git = "Jose Rios";

    // when / then
    expect(normalizeIdentityText(directory)).toBe(normalizeIdentityText(git));
    expect(normalizeIdentityText(directory)).toBe("jose rios");
  });

  it("should collapse punctuation and separators to single spaces", () => {
    // given / when
    const result = normalizeIdentityText("  felipe.rios_da-Silva  ");

    // then
    expect(result).toBe("felipe rios da silva");
  });

  it("should return an empty string for text with nothing comparable in it", () => {
    // given / when / then
    expect(normalizeIdentityText("---")).toBe("");
  });
});

describe("emailLocalPart", () => {
  it("should return the part before the at sign", () => {
    // given / when / then
    expect(emailLocalPart("Felipe.Rios@acme.com")).toBe("felipe.rios");
  });

  it("should return null when there is no local part to take", () => {
    // given / when / then
    expect(emailLocalPart("acme.com")).toBeNull();
    expect(emailLocalPart("@acme.com")).toBeNull();
  });
});

describe("identityMatchScore", () => {
  it("should score an identical e-mail as proof", () => {
    // given
    const observed = identity({ email: "Felipe.Rios@acme.com" });
    const candidate = user({ email: "felipe.rios@acme.com" });

    // when
    const match = identityMatchScore(observed, candidate);

    // then
    expect(match).toEqual({ score: 1, reason: "same e-mail address" });
  });

  it("should score a shared local part below an identical address", () => {
    // given
    // A WakaTime account signed up with a personal domain is the common shape.
    const observed = identity({ email: "f.rios@personal.dev" });
    const candidate = user({ email: "f.rios@acme.com" });

    // when
    const match = identityMatchScore(observed, candidate);

    // then
    expect(match?.score).toBeGreaterThan(SUGGESTION_FLOOR);
    expect(match?.score).toBeLessThan(1);
    expect(match?.reason).toContain("different domain");
  });

  it("should match a display name across differing diacritics", () => {
    // given
    const observed = identity({ displayName: "Jose Rios" });
    const candidate = user({ displayName: "José Ríos" });

    // when
    const match = identityMatchScore(observed, candidate);

    // then
    expect(match?.reason).toBe("same display name");
  });

  it("should match a bare username against the directory address", () => {
    // given
    // GitHub reports a login, not an address; this is what closes that gap.
    const observed = identity({ sourceKey: "friosrios" });
    const candidate = user({ email: "friosrios@acme.com" });

    // when
    const match = identityMatchScore(observed, candidate);

    // then
    expect(match?.reason).toBe("username matches the directory address");
  });

  it("should offer a partial name match, weakly", () => {
    // given
    // A middle name present on one side and not the other.
    const observed = identity({ displayName: "Felipe Rios" });
    const candidate = user({ displayName: "Felipe Augusto Rios" });

    // when
    const match = identityMatchScore(observed, candidate);

    // then
    expect(match?.reason).toBe("most of the name matches");
    expect(match?.score).toBeLessThan(0.85);
  });

  it("should offer a username that resembles the name", () => {
    // given
    const observed = identity({ sourceKey: "felipe-rios" });
    const candidate = user({ displayName: "Felipe Rios" });

    // when
    const match = identityMatchScore(observed, candidate);

    // then
    expect(match?.reason).toBe("username resembles the name");
  });

  it("should refuse to match two different people who share nothing", () => {
    // given
    const observed = identity({ displayName: "Ana Costa", email: "ana@acme.com" });
    const candidate = user({ displayName: "Bruno Lima", email: "bruno@acme.com" });

    // when
    const match = identityMatchScore(observed, candidate);

    // then
    expect(match).toBeNull();
  });

  it("should not match on a shared surname alone", () => {
    // given
    // Two siblings in the same company is the case that makes an automatic
    // merge unacceptable: it is far harder to notice than a row left separate.
    const observed = identity({ displayName: "Ana Rios" });
    const candidate = user({ displayName: "Bruno Rios" });

    // when
    const match = identityMatchScore(observed, candidate);

    // then
    expect(match).toBeNull();
  });
});

describe("suggestIdentityMatches", () => {
  it("should rank the strongest evidence first", () => {
    // given
    const observed = identity({
      sourceKey: "friosrios",
      displayName: "Felipe Rios",
      email: "f.rios@personal.dev",
    });
    const users = [
      user({ entityRef: "user:default/other", displayName: "Felipe Augusto Rios" }),
      user({ entityRef: "user:default/exact", email: "f.rios@acme.com" }),
    ];

    // when
    const suggestions = suggestIdentityMatches(observed, users);

    // then
    expect(suggestions.map((suggestion) => suggestion.entityRef)).toEqual([
      "user:default/exact",
      "user:default/other",
    ]);
  });

  it("should drop everything below the floor", () => {
    // given
    const observed = identity({ displayName: "Ana Costa" });
    const users = [user({ entityRef: "user:default/bruno", displayName: "Bruno Lima" })];

    // when
    const suggestions = suggestIdentityMatches(observed, users);

    // then
    expect(suggestions).toEqual([]);
  });

  it("should break ties on the name so the order does not move under the cursor", () => {
    // given
    const observed = identity({ email: "shared@acme.com" });
    const users = [
      user({ entityRef: "user:default/zoe", displayName: "Zoe", email: "shared@acme.com" }),
      user({ entityRef: "user:default/adam", displayName: "Adam", email: "shared@acme.com" }),
    ];

    // when
    const suggestions = suggestIdentityMatches(observed, users);

    // then
    expect(suggestions.map((suggestion) => suggestion.displayName)).toEqual(["Adam", "Zoe"]);
  });

  it("should honour the limit", () => {
    // given
    const observed = identity({ email: "shared@acme.com" });
    const users = Array.from({ length: 9 }, (_, index) =>
      user({ entityRef: `user:default/u${index}`, email: "shared@acme.com" }),
    );

    // when
    const suggestions = suggestIdentityMatches(observed, users, 3);

    // then
    expect(suggestions).toHaveLength(3);
  });

  it("should fall back to the entity reference when a candidate has no name", () => {
    // given
    const observed = identity({ email: "shared@acme.com" });
    const users = [
      user({ entityRef: "user:default/b", email: "shared@acme.com" }),
      user({ entityRef: "user:default/a", email: "shared@acme.com" }),
    ];

    // when
    const suggestions = suggestIdentityMatches(observed, users);

    // then
    expect(suggestions.map((suggestion) => suggestion.entityRef)).toEqual([
      "user:default/a",
      "user:default/b",
    ]);
  });
});

describe("searchDirectoryUsers", () => {
  const directory: DirectoryUser[] = [
    {
      entityRef: "user:default/felipe",
      displayName: "Felipe Rios",
      email: "felipe.rios@example.com",
      picture: null,
    },
    {
      entityRef: "user:default/ana",
      displayName: "Ana Costa",
      email: "ana@example.com",
      picture: null,
    },
    {
      entityRef: "user:default/j.doe_example.com",
      displayName: null,
      email: "j.doe@example.com",
      picture: null,
    },
    {
      entityRef: "user:default/rios",
      displayName: "Rios Felipe",
      email: null,
      picture: null,
    },
  ];

  it("should find every user whose text contains all of the words, in any order", () => {
    // given / when
    const found = searchDirectoryUsers(directory, "rios fel");

    // then
    // Both match; the one whose name starts with the first word leads.
    expect(found.map((candidate) => candidate.entityRef)).toEqual([
      "user:default/rios",
      "user:default/felipe",
    ]);
  });

  it("should put the users whose name starts with the typing first", () => {
    // given
    // Somebody typing "rios" expects Rios Felipe under the cursor before
    // Felipe Rios, whose surname merely contains it.

    // when
    const found = searchDirectoryUsers(directory, "rios");

    // then
    expect(found.map((candidate) => candidate.entityRef)).toEqual([
      "user:default/rios",
      "user:default/felipe",
    ]);
  });

  it("should match on the address and on the entity name for a user with no display name", () => {
    // given / when
    const byAddress = searchDirectoryUsers(directory, "j.doe");
    const byEntityName = searchDirectoryUsers(directory, "doe_example");

    // then
    expect(byAddress.map((candidate) => candidate.entityRef)).toEqual(["user:default/j.doe_example.com"]);
    expect(byEntityName.map((candidate) => candidate.entityRef)).toEqual([
      "user:default/j.doe_example.com",
    ]);
  });

  it("should fold case and diacritics the way the suggestions do", () => {
    // given / when
    const found = searchDirectoryUsers(directory, "FELÍPE");

    // then
    expect(found.map((candidate) => candidate.entityRef)).toEqual([
      "user:default/felipe",
      "user:default/rios",
    ]);
  });

  it("should find nobody for a query with nothing comparable in it", () => {
    // given / when / then
    expect(searchDirectoryUsers(directory, "")).toEqual([]);
    expect(searchDirectoryUsers(directory, " - ")).toEqual([]);
  });

  it("should honour the limit", () => {
    // given / when
    const found = searchDirectoryUsers(directory, "example", 1);

    // then
    expect(found).toHaveLength(1);
    expect(MAX_DIRECTORY_SEARCH_RESULTS).toBeGreaterThan(1);
  });
});
