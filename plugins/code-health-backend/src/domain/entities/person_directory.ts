import type { ContributorIdentity } from "@rios0rios0/backstage-plugin-code-health-common";
import type { CodeHealthEvent } from "./code_health_event";
import {
  identityKey,
  normalizeSourceKey,
  personKeyOf,
  type IdentityExclusionRecord,
  type IdentityLinkRecord,
  type IdentityRecord,
  type IdentityRef,
} from "./identity";

/** What is known about a person, drawn from every account merged into them. */
export interface PersonProfile {
  readonly entityRef: string | null;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
  readonly profileUrl: string | null;
  readonly identities: readonly ContributorIdentity[];
}

const toContributorIdentity = (record: IdentityRef & { displayName?: string | null }) => ({
  source: record.source,
  sourceKey: record.sourceKey,
  displayName: record.displayName ?? null,
});

/**
 * Answers "whose row does this account belong on?", and "is that person
 * measured at all?".
 *
 * Built once per request from the link and exclusion tables, then consulted for
 * every event and every stored measure. Doing the resolution on read rather
 * than baking it into the stored rows is what makes both decisions
 * retroactive: correct a link or include an account again today, and every
 * window the plugin ever collected reports the corrected total, instead of only
 * the windows collected afterwards.
 */
export class PersonDirectory {
  private readonly linksByIdentity: Map<string, IdentityLinkRecord>;
  private readonly membersByPerson = new Map<string, IdentityRecord[]>();
  private readonly exclusionsByPerson = new Map<string, IdentityExclusionRecord>();

  constructor(options: {
    readonly links: readonly IdentityLinkRecord[];
    readonly identities: readonly IdentityRecord[];
    readonly exclusions?: readonly IdentityExclusionRecord[];
  }) {
    this.linksByIdentity = new Map(options.links.map((link) => [identityKey(link), link]));

    for (const identity of options.identities) {
      const key = this.keyOf(identity);
      const bucket = this.membersByPerson.get(key);
      if (bucket) bucket.push(identity);
      else this.membersByPerson.set(key, [identity]);
    }

    // Keyed by *person*, not by account. Excluding one account of somebody the
    // link table says is one human excludes the human: a leaver's commits and
    // their coding time are the same person's work, and taking half of it out
    // of the figures would leave a row holding a third of a story — which is
    // the exact failure the linking screen exists to remove.
    //
    // For an account nobody has linked — every bot and every build service —
    // the person key *is* the account key, so this is simply itself.
    for (const exclusion of options.exclusions ?? []) {
      const key = this.keyOf(exclusion);
      const existing = this.exclusionsByPerson.get(key);
      // Oldest wins, so a person's row names the decision that first took them
      // out of the figures rather than whichever of their accounts happens to
      // be read last.
      if (existing === undefined || exclusion.excludedAt < existing.excludedAt) {
        this.exclusionsByPerson.set(key, exclusion);
      }
    }
  }

  keyOf(identity: IdentityRef): string {
    return personKeyOf(identity, this.linksByIdentity.get(identityKey(identity)));
  }

  /**
   * The person's catalog user, or null when no account on the row is linked.
   *
   * Read back off the key rather than stored separately: an unlinked person's
   * key is `<source>:<sourceKey>`, which contains a colon but is not an entity
   * reference, so the two are told apart by whether any link produced the key
   * rather than by trying to parse it.
   */
  entityRefOf(personKey: string): string | null {
    return personKey.startsWith("user:") ? personKey : null;
  }

  /** Why this account is measured by nothing, or undefined while it still is. */
  exclusionOf(identity: IdentityRef): IdentityExclusionRecord | undefined {
    return this.exclusionsByPerson.get(this.keyOf(identity));
  }

  /** Whether anything this account reported counts towards anybody's figures. */
  isMeasured(identity: IdentityRef): boolean {
    return !this.exclusionsByPerson.has(this.keyOf(identity));
  }

  /**
   * What is known about a person, merged across their accounts.
   *
   * The fallback is the account that reported it most recently rather than the
   * first one found: a name changes, and the newest one is the one the person
   * would recognise. `fallback` supplies what an account that has not been
   * observed yet would otherwise have no profile for — an event carries the
   * name the provider stamped on the commit, and it is better than the key.
   */
  profileOf(
    personKey: string,
    fallback: { displayName: string | null; avatarUrl: string | null; profileUrl: string | null },
  ): PersonProfile {
    const members = [...(this.membersByPerson.get(personKey) ?? [])].sort(
      (left, right) => right.lastSeenAt.getTime() - left.lastSeenAt.getTime(),
    );

    const firstWith = <T>(pick: (record: IdentityRecord) => T | null): T | null => {
      for (const member of members) {
        const value = pick(member);
        if (value !== null && value !== "") return value;
      }
      return null;
    };

    return {
      entityRef: this.entityRefOf(personKey),
      displayName: firstWith((member) => member.displayName) ?? fallback.displayName,
      avatarUrl: firstWith((member) => member.avatarUrl) ?? fallback.avatarUrl,
      profileUrl: firstWith((member) => member.profileUrl) ?? fallback.profileUrl,
      identities: members.map(toContributorIdentity),
    };
  }
}

/**
 * The version control account an event was stamped with.
 *
 * The same normalisation the contributors accumulation applies, in one place,
 * because an exclusion recorded on `Build Service` and an event carrying
 * `build service` are the same account and a case-sensitive comparison would
 * quietly measure the row somebody excluded.
 */
export const actorIdentityOf = (event: CodeHealthEvent): IdentityRef | null =>
  event.actorKey === null
    ? null
    : { source: "vcs", sourceKey: normalizeSourceKey(event.actorKey) };

/**
 * The events that count, which is every event but the ones an excluded person
 * produced.
 *
 * Applied to the events themselves rather than only to the contributors table,
 * because "excluded from the measuring system" has to mean the whole system:
 * a build service left in would still be a repository's busiest committer, a
 * quarter of the fleet's delivery cadence, and — through the fleet reference
 * every relative score is read against — the reason a whole team's output
 * scores look like a rounding error beside it.
 *
 * An event with no actor at all is kept. Nobody has been excluded, and dropping
 * it would silently shrink the repository counters to punish a provider that
 * did not stamp a name on a commit.
 */
export const measuredEvents = (
  events: readonly CodeHealthEvent[],
  people: PersonDirectory,
): CodeHealthEvent[] =>
  events.filter((event) => {
    const identity = actorIdentityOf(event);
    return identity === null || people.isMeasured(identity);
  });

/**
 * Reads the three small tables a directory is built from, in one round trip.
 *
 * Every command that turns events into rows needs the same object, and the
 * alternative — each of them assembling it from its own reads — is how one of
 * them ends up built without the exclusions and quietly measures a build
 * service that every other view has dropped.
 *
 * The reads run together, and all three tables are bounded by the number of
 * accounts the plugin has ever seen rather than by the history, so this costs
 * the same on a fleet with a year of events as on a fresh install.
 */
export const loadPersonDirectory = async (
  store: PersonDirectorySource,
): Promise<PersonDirectory> => {
  const [links, identities, exclusions] = await Promise.all([
    store.listIdentityLinks(),
    store.listIdentities(),
    store.listIdentityExclusions(),
  ]);

  return new PersonDirectory({ links, identities, exclusions });
};

/** The slice of the persistence port a directory is built from. */
export interface PersonDirectorySource {
  listIdentityLinks(): Promise<IdentityLinkRecord[]>;
  listIdentities(): Promise<IdentityRecord[]>;
  listIdentityExclusions(): Promise<IdentityExclusionRecord[]>;
}
