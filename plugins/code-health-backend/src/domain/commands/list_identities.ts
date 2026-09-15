import type {
  IdentityExclusion,
  IdentityRow,
  IdentitySource,
  IdentitySuggestion,
} from "@rios0rios0/backstage-plugin-code-health-common";
import { suggestIdentityMatches } from "@rios0rios0/backstage-plugin-code-health-common";
import { identityKey, type IdentityRecord } from "../entities/identity";
import { PersonDirectory } from "../entities/person_directory";
import type { CodeHealthStore } from "../repositories/code_health_store";
import type { DirectoryReader } from "../services/identity_resolver";

const toWire = (record: IdentityRecord) => ({
  source: record.source,
  sourceKey: record.sourceKey,
  displayName: record.displayName,
  email: record.email,
  avatarUrl: record.avatarUrl,
  profileUrl: record.profileUrl,
  firstSeenAt: record.firstSeenAt.toISOString(),
  lastSeenAt: record.lastSeenAt.toISOString(),
});

/**
 * Everything the Identities screen renders: the accounts the plugin has seen,
 * who each one is linked to, who it might be, and whether it is measured.
 *
 * The directory is enumerated once for the whole listing rather than per row.
 * That is the only expensive part, and doing it per account would turn a screen
 * with two hundred unlinked rows into two hundred catalog queries.
 *
 * Suggestions are computed only for accounts nobody has linked. An account with
 * a link already has its answer, and offering alternatives beside it invites
 * somebody to change a correct row for a plausible-looking wrong one.
 *
 * Excluded accounts are listed like any other. They are the one kind of row
 * that appears nowhere else in the plugin — that is what excluding does — so
 * hiding them here would leave a build service taken out of the figures with
 * nothing anywhere able to say it had been, and no way to put it back.
 */
export class ListIdentities {
  constructor(
    private readonly store: CodeHealthStore,
    private readonly directory: DirectoryReader,
  ) {}

  async run(input: {
    sources?: readonly IdentitySource[];
    linked?: boolean;
    excluded?: boolean;
  }): Promise<IdentityRow[]> {
    const [identities, links, exclusions] = await Promise.all([
      this.store.listIdentities(
        input.sources === undefined ? {} : { sources: input.sources },
      ),
      this.store.listIdentityLinks(),
      this.store.listIdentityExclusions(),
    ]);

    const linksByIdentity = new Map(links.map((link) => [identityKey(link), link]));
    // The same object every other read builds, so a row that says it is
    // excluded is excluded by exactly the rule the contributors table applies —
    // including the one that carries an exclusion through a link to every other
    // account of the same person.
    const people = new PersonDirectory({ links, identities, exclusions });

    const visible = identities.filter((identity) => {
      if (input.linked !== undefined) {
        if (linksByIdentity.has(identityKey(identity)) !== input.linked) return false;
      }
      if (input.excluded !== undefined) {
        if (people.isMeasured(identity) === input.excluded) return false;
      }
      return true;
    });

    const needsSuggestions = visible.some(
      (identity) => !linksByIdentity.has(identityKey(identity)),
    );
    const users = needsSuggestions ? await this.directory.listUsers() : [];

    return visible.map((identity) => {
      const link = linksByIdentity.get(identityKey(identity));
      const exclusion = people.exclusionOf(identity);
      const suggestions: readonly IdentitySuggestion[] =
        link === undefined ? suggestIdentityMatches(identity, users) : [];

      const wireExclusion: IdentityExclusion | null =
        exclusion === undefined
          ? null
          : {
              // The account the decision was recorded on, which is this one for
              // a direct exclusion and a sibling's when the row inherited it
              // through a link. The screen needs the difference: only the row
              // that carries it has anything to undo.
              source: exclusion.source,
              sourceKey: exclusion.sourceKey,
              reason: exclusion.reason,
              excludedBy: exclusion.excludedBy,
              excludedAt: exclusion.excludedAt.toISOString(),
            };

      return {
        identity: toWire(identity),
        link:
          link === undefined
            ? null
            : {
                entityRef: link.entityRef,
                origin: link.origin,
                linkedBy: link.linkedBy,
                linkedAt: link.linkedAt.toISOString(),
              },
        suggestions,
        exclusion: wireExclusion,
      };
    });
  }
}
