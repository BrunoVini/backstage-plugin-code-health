import type {
  ExclusionReason,
  IdentityLinkOrigin,
  IdentitySource,
} from "@rios0rios0/backstage-plugin-code-health-common";

/**
 * An account the plugin has seen, as it is stored.
 *
 * Recorded on sight rather than derived from the event table on demand. The
 * Identities screen has to list accounts nobody has linked *yet*, and an
 * account with no link and no activity in whatever window happens to be
 * selected would otherwise be invisible in exactly the case where somebody is
 * looking for it. A `SELECT DISTINCT` over every event ever ingested would
 * answer the same question at a cost that grows with the history.
 */
export interface IdentityRecord {
  readonly source: IdentitySource;
  readonly sourceKey: string;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly avatarUrl: string | null;
  readonly profileUrl: string | null;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
}

/**
 * A statement that an account belongs to a particular person.
 *
 * `manual` outranks `catalog-email` and is never overwritten by it. An
 * automatic rule that could undo a human's correction on the next scheduled run
 * would make the screen pointless — somebody fixes a wrong match, and half an
 * hour later it is wrong again with nothing to show why.
 */
export interface IdentityLinkRecord {
  readonly source: IdentitySource;
  readonly sourceKey: string;
  readonly entityRef: string;
  readonly origin: IdentityLinkOrigin;
  /** The catalog user who made a manual link. Null for an automatic one. */
  readonly linkedBy: string | null;
  readonly linkedAt: Date;
}

/**
 * A statement that an account is measured by nothing.
 *
 * Stored rather than acted on: the events, the snapshots and the per-source
 * measures all stay exactly as they were collected, and the exclusion is
 * applied when a row is built. Including an account again therefore restores
 * every window the plugin has ever collected, instead of only the windows
 * collected after somebody changed their mind — the same rule the link table
 * follows, and for the same reason.
 *
 * Deleting the rows instead would be irreversible, would cost a full re-walk of
 * the provider history to undo, and would take the repository counters down
 * with it: a build service's pipeline runs are that repository's pipeline runs
 * whoever triggered them.
 */
export interface IdentityExclusionRecord {
  readonly source: IdentitySource;
  readonly sourceKey: string;
  readonly reason: ExclusionReason;
  /** The catalog user who excluded the account. */
  readonly excludedBy: string | null;
  readonly excludedAt: Date;
}

export interface IdentityRef {
  readonly source: IdentitySource;
  readonly sourceKey: string;
}

/** Composite key of an account, for use in a map. */
export const identityKey = (identity: IdentityRef): string =>
  `${identity.source}:${identity.sourceKey}`;

/**
 * Normalises whatever a provider called somebody into a stable key.
 *
 * Lowercased because every one of the four sources treats its own identifier
 * case-insensitively somewhere — GitHub logins, e-mail addresses and Atlassian
 * account ids all round-trip through APIs with the case they were typed in, and
 * two rows differing only in capitalisation are two people as far as a primary
 * key is concerned.
 */
export const normalizeSourceKey = (value: string): string => value.trim().toLowerCase();

/**
 * The key a contributor row is grouped under.
 *
 * A linked account groups under its catalog user, so every system's view of one
 * person lands on one row. An unlinked account groups under itself, which keeps
 * it visible: dropping unlinked accounts would hide every bot, every service
 * account and everybody nobody has got round to linking yet, and those are
 * exactly the rows that reveal the linking still needs doing.
 */
export const personKeyOf = (
  identity: IdentityRef,
  link: IdentityLinkRecord | undefined,
): string => link?.entityRef ?? identityKey(identity);
