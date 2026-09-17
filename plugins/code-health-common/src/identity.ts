import { parseEntityRef } from "./entity_ref";
import type { ExclusionReason } from "./identity_exclusion";

/**
 * Where an identity was observed.
 *
 * `vcs` is a commit author or reviewer as the version control platform reported
 * them — an e-mail on Azure DevOps, a login on GitHub. The rest are the
 * accounts the optional integrations report, which are separate account systems
 * with separate keys.
 */
export type IdentitySource = "vcs" | "wakatime" | "jira" | "confluence";

export const IDENTITY_SOURCES: readonly IdentitySource[] = [
  "vcs",
  "wakatime",
  "jira",
  "confluence",
];

export const isIdentitySource = (value: unknown): value is IdentitySource =>
  typeof value === "string" && (IDENTITY_SOURCES as readonly string[]).includes(value);

/** Human-readable name of a source, for the admin screen and its filters. */
export const IDENTITY_SOURCE_LABELS: Readonly<Record<IdentitySource, string>> = {
  vcs: "Version control",
  wakatime: "WakaTime",
  jira: "Jira",
  confluence: "Confluence",
};

/**
 * How an identity came to be attached to a catalog user.
 *
 * `manual` outranks everything. It is a person stating that these two accounts
 * are the same human, which is the only claim in the system that is not a
 * guess, and it is what the whole linking screen exists to record.
 */
export type IdentityLinkOrigin = "manual" | "catalog-email";

export interface IdentityLink {
  readonly entityRef: string;
  readonly origin: IdentityLinkOrigin;
  /** The catalog user who made the link, for a manual one. */
  readonly linkedBy: string | null;
  readonly linkedAt: string;
}

/**
 * An account some source told the plugin about.
 *
 * Recorded on sight rather than derived on demand, because the admin screen has
 * to be able to list the accounts nobody has linked *yet* — and an account with
 * no link and no activity in the current window would otherwise be invisible in
 * exactly the case where someone needs to find it.
 */
export interface ObservedIdentity {
  readonly source: IdentitySource;
  /** Normalised: trimmed and lowercased. Stable for the life of the account. */
  readonly sourceKey: string;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly avatarUrl: string | null;
  readonly profileUrl: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

/**
 * An account excluded from every measurement, and why.
 *
 * `source` and `sourceKey` name the account the exclusion was *recorded* on,
 * which is not always the account carrying it: an exclusion is a statement
 * about a person, so it reaches every account linked to the same catalog user.
 * A row that inherited one therefore says whose decision it was, rather than
 * offering an "include" button that would undo nothing.
 */
export interface IdentityExclusion {
  readonly source: IdentitySource;
  readonly sourceKey: string;
  readonly reason: ExclusionReason;
  /** The catalog user who excluded the account. */
  readonly excludedBy: string | null;
  readonly excludedAt: string;
}

/** A catalog user the plugin can offer as the other half of a link. */
export interface DirectoryUser {
  readonly entityRef: string;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly picture: string | null;
}

export interface IdentitySuggestion extends DirectoryUser {
  /** 0 to 1. Only suggestions at or above {@link SUGGESTION_FLOOR} are offered. */
  readonly score: number;
  /** Why this user was suggested, shown verbatim next to the name. */
  readonly reason: string;
}

/** One row of the Identities screen. */
export interface IdentityRow {
  readonly identity: ObservedIdentity;
  readonly link: IdentityLink | null;
  readonly suggestions: readonly IdentitySuggestion[];
  /**
   * Why this account is measured by nothing, or null while it still is.
   *
   * Carried on the row rather than left to be inferred from an absent
   * contributor row: an excluded account is missing from every table in the
   * plugin, and this screen is the only place that can say it was excluded
   * rather than never seen.
   */
  readonly exclusion: IdentityExclusion | null;
}

/** The identities that were merged into one contributor row. */
export interface ContributorIdentity {
  readonly source: IdentitySource;
  readonly sourceKey: string;
  readonly displayName: string | null;
}

/**
 * Strips a string to comparable letters and digits.
 *
 * Diacritics are folded because a directory and a git config routinely disagree
 * about them for the same person — `José Ríos` in Entra ID against `Jose Rios`
 * in `user.name` — and a comparison that treats those as different people is
 * useless in precisely the organisations that need it most.
 */
export const normalizeIdentityText = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();

const tokensOf = (value: string): string[] =>
  normalizeIdentityText(value).split(" ").filter(Boolean);

export const emailLocalPart = (value: string): string | null => {
  const at = value.indexOf("@");
  return at <= 0 ? null : value.slice(0, at).toLowerCase();
};

/** Suggestions below this are noise and are not offered at all. */
export const SUGGESTION_FLOOR = 0.5;

/** How many suggestions a row carries. Beyond a handful nobody reads them. */
export const MAX_SUGGESTIONS = 5;

interface ScoredMatch {
  readonly score: number;
  readonly reason: string;
}

const jaccard = (left: readonly string[], right: readonly string[]): number => {
  if (left.length === 0 || right.length === 0) return 0;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let shared = 0;
  for (const token of leftSet) if (rightSet.has(token)) shared += 1;
  return shared / (leftSet.size + rightSet.size - shared);
};

/**
 * How likely it is that an observed account and a catalog user are one person.
 *
 * The rungs are ordered by how much evidence each carries, and the first one
 * that matches wins rather than the scores being blended: a shared e-mail
 * address is proof, a shared surname is a hint, and averaging the two produces
 * a number that means neither.
 *
 * Nothing here links anything on its own. Above {@link SUGGESTION_FLOOR} a
 * suggestion is *offered*, and a person confirms it — which is the point of the
 * screen. The one exception is an exact e-mail match, which the backend links
 * automatically because it is the same rule the catalog itself uses to decide
 * who a `User` entity is.
 */
export const identityMatchScore = (
  identity: Pick<ObservedIdentity, "sourceKey" | "displayName" | "email">,
  user: DirectoryUser,
): ScoredMatch | null => {
  const identityEmail = identity.email?.toLowerCase() ?? null;
  const userEmail = user.email?.toLowerCase() ?? null;

  if (identityEmail !== null && userEmail !== null && identityEmail === userEmail) {
    return { score: 1, reason: "same e-mail address" };
  }

  // A person's WakaTime account and their work account routinely differ in
  // domain and nothing else: `f.rios@personal.dev` against `f.rios@acme.com`.
  const identityLocal = identityEmail === null ? null : emailLocalPart(identityEmail);
  const userLocal = userEmail === null ? null : emailLocalPart(userEmail);
  if (identityLocal !== null && userLocal !== null && identityLocal === userLocal) {
    return { score: 0.92, reason: "same address before the @, different domain" };
  }

  const userName = user.displayName;
  if (userName !== null && identity.displayName !== null) {
    const left = normalizeIdentityText(identity.displayName);
    const right = normalizeIdentityText(userName);
    if (left !== "" && left === right) {
      return { score: 0.88, reason: "same display name" };
    }
  }

  // The source key is a username on GitHub, WakaTime and most SaaS: comparing
  // it to the address the directory holds is what catches `friosrios` against
  // `friosrios@acme.com` — the single most common shape in practice.
  if (userLocal !== null) {
    const key = identity.sourceKey.toLowerCase();
    const keyLocal = emailLocalPart(key) ?? key;
    if (keyLocal === userLocal) {
      return { score: 0.85, reason: "username matches the directory address" };
    }
  }

  if (userName !== null && identity.displayName !== null) {
    const overlap = jaccard(tokensOf(identity.displayName), tokensOf(userName));
    // Two of three name parts shared — a middle name present on one side and
    // not the other, which is the usual disagreement between a directory and a
    // git config.
    if (overlap >= 0.5) {
      return { score: 0.5 + overlap * 0.3, reason: "most of the name matches" };
    }
  }

  if (userName !== null) {
    const overlap = jaccard(tokensOf(identity.sourceKey), tokensOf(userName));
    if (overlap >= 0.5) {
      return { score: 0.5 + overlap * 0.2, reason: "username resembles the name" };
    }
  }

  return null;
};

/**
 * The best few catalog users for an observed account, strongest first.
 *
 * Ties break on the display name so the list is stable between requests; an
 * order that reshuffles under the cursor is how somebody links the wrong person.
 */
export const suggestIdentityMatches = (
  identity: Pick<ObservedIdentity, "sourceKey" | "displayName" | "email">,
  users: readonly DirectoryUser[],
  limit: number = MAX_SUGGESTIONS,
): IdentitySuggestion[] =>
  users
    .flatMap((user) => {
      const match = identityMatchScore(identity, user);
      return match === null || match.score < SUGGESTION_FLOOR
        ? []
        : [{ ...user, score: Math.round(match.score * 100) / 100, reason: match.reason }];
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        (left.displayName ?? left.entityRef).localeCompare(
          right.displayName ?? right.entityRef,
        ),
    )
    .slice(0, limit);

/** How many directory users a search answers with. Beyond a screenful nobody reads them. */
export const MAX_DIRECTORY_SEARCH_RESULTS = 20;

/** Everything about a user a search can match on, folded to comparable text. */
const searchableTextOf = (user: DirectoryUser): string =>
  normalizeIdentityText(
    [
      user.displayName ?? "",
      user.email ?? "",
      parseEntityRef(user.entityRef)?.name ?? user.entityRef,
    ].join(" "),
  );

/**
 * The catalog users whose name, address or entity name contains every word of
 * `query`, best match first.
 *
 * A "like" search rather than a ranked resemblance. {@link suggestIdentityMatches}
 * is for an account the plugin has an opinion about; this is for the person at
 * the keyboard who already knows who the account belongs to and should not
 * have to type `user:default/j.doe_example.com` to say so. Every word has to
 * appear somewhere, in any order, so `rios fel` finds Felipe Rios and
 * `j.doe` finds the address; a query with nothing comparable in it finds
 * nobody rather than everybody.
 *
 * Users whose name starts with what was typed come first, because that is
 * what somebody typing a name expects to see under the cursor; ties break on
 * the name so the list is stable between keystrokes.
 */
export const searchDirectoryUsers = (
  users: readonly DirectoryUser[],
  query: string,
  limit: number = MAX_DIRECTORY_SEARCH_RESULTS,
): DirectoryUser[] => {
  const terms = tokensOf(query);
  if (terms.length === 0) return [];
  const [first] = terms;
  const nameOf = (user: DirectoryUser): string => user.displayName ?? user.entityRef;

  return users
    .flatMap((user) => {
      const text = searchableTextOf(user);
      if (!terms.every((term) => text.includes(term))) return [];
      const leading = first !== undefined && normalizeIdentityText(nameOf(user)).startsWith(first);
      return [{ user, rank: leading ? 0 : 1 }];
    })
    .sort(
      (left, right) =>
        left.rank - right.rank || nameOf(left.user).localeCompare(nameOf(right.user)),
    )
    .slice(0, Math.max(0, limit))
    .map(({ user }) => user);
};
