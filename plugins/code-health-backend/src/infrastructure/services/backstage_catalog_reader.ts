import type { AuthService } from "@backstage/backend-plugin-api";
import {
  RELATION_CHILD_OF,
  RELATION_MEMBER_OF,
  stringifyEntityRef,
  type Entity,
} from "@backstage/catalog-model";
import type { CatalogService } from "@backstage/plugin-catalog-node";
import type {
  DirectoryUser,
  EntityProfile,
} from "@rios0rios0/backstage-plugin-code-health-common";
import type { EntityFilter } from "../../domain/entities/ingestion_settings";
import type { CatalogReader, CatalogUser } from "../../domain/services/catalog_reader";
import type { DirectoryReader } from "../../domain/services/identity_resolver";

/**
 * Only the fields discovery actually reads. Asking the catalog for the whole
 * entity is the usual performance mistake in a plugin that scans everything.
 */
const REQUIRED_FIELDS = [
  "kind",
  "metadata.name",
  "metadata.namespace",
  "metadata.annotations",
  // Read by the documentation metric: an entity linking out to a wiki counts as
  // documented somewhere, even with no TechDocs annotation.
  "metadata.links",
  "spec.owner",
  // Both feed the API-exposure metric: what the component is, and whether it
  // already tells the catalog which APIs it serves.
  "spec.type",
  "spec.providesApis",
];

/** Discovery never reads a profile, so the user lookup asks for its own fields. */
const USER_FIELDS = ["kind", "metadata.name", "metadata.namespace", "spec.profile"];

/**
 * An owner's name and photograph, whatever kind the entity is.
 *
 * `kind` is asked for because the reference has to be rebuilt from the entity
 * itself: the same lookup answers for `User` and `Group` owners, and hardcoding
 * either would key half the fleet's rows under a reference nobody asked for.
 */
const PROFILE_FIELDS = ["kind", "metadata.name", "metadata.namespace", "spec.profile"];

/** Walking the group tree needs the edges and the name, and nothing else. */
const OWNERSHIP_FIELDS = ["kind", "metadata.name", "metadata.namespace", "relations"];

/**
 * How far up a group tree the ownership walk goes.
 *
 * Deep enough for any organisation chart anybody actually maintains, and a
 * ceiling rather than a promise: the walk already refuses to revisit a group,
 * so this only bounds a chart that is genuinely that deep rather than one that
 * loops.
 */
export const MAX_OWNERSHIP_DEPTH = 10;

/** Azure DevOps reports commit authors by e-mail; GitHub reports a login. */
const isEmail = (value: string): boolean => value.includes("@");

/**
 * How many users the directory listing will pull.
 *
 * Enumerating a directory is the one thing this plugin's design otherwise
 * refuses to do, and it is allowed here only because the Identities screen is a
 * person deliberately asking for the list. The cap keeps a hundred-thousand-seat
 * tenant from turning that request into an outage; when it bites, the screen
 * says the suggestions are drawn from a subset rather than pretending it
 * searched everybody.
 */
export const MAX_DIRECTORY_USERS = 5000;

const toDirectoryUser = (entity: Entity): DirectoryUser => {
  const profile = (entity.spec as { profile?: Record<string, unknown> } | undefined)?.profile;
  const namespace = entity.metadata.namespace ?? "default";

  return {
    entityRef: `user:${namespace}/${entity.metadata.name}`,
    displayName:
      typeof profile?.displayName === "string" ? profile.displayName : entity.metadata.name,
    email: typeof profile?.email === "string" ? profile.email.toLowerCase() : null,
    picture: typeof profile?.picture === "string" ? profile.picture : null,
  };
};

/** The targets of one kind of relation on an entity, deduplicated. */
const relatedRefs = (entity: Entity, type: string): string[] => [
  ...new Set(
    (entity.relations ?? [])
      .filter((relation) => relation.type === type)
      .map((relation) => relation.targetRef),
  ),
];

export class BackstageCatalogReader implements CatalogReader, DirectoryReader {
  constructor(
    private readonly catalog: CatalogService,
    private readonly auth: AuthService,
  ) {}

  async listEntities(filters: readonly EntityFilter[]): Promise<Entity[]> {
    // A background task has no incoming request to act on behalf of, so it
    // authenticates as the plugin itself.
    const credentials = await this.auth.getOwnServiceCredentials();

    const { items } = await this.catalog.getEntities(
      { filter: [...filters], fields: REQUIRED_FIELDS },
      { credentials },
    );

    return items;
  }

  async findUsersByEmail(emails: readonly string[]): Promise<Map<string, CatalogUser>> {
    // Lowercased because that is what the catalog's search index holds, and the
    // index is what `filter` queries — an entity whose body spells the address
    // in mixed case is still found this way.
    const wanted = [...new Set(emails.filter(isEmail).map((email) => email.toLowerCase()))];
    if (wanted.length === 0) return new Map();

    const credentials = await this.auth.getOwnServiceCredentials();
    const { items } = await this.catalog.getEntities(
      { filter: { kind: "User", "spec.profile.email": wanted }, fields: USER_FIELDS },
      { credentials },
    );

    const found = new Map<string, CatalogUser>();
    for (const item of items) {
      const profile = (item.spec as { profile?: Record<string, unknown> } | undefined)?.profile;
      const email = typeof profile?.email === "string" ? profile.email.toLowerCase() : undefined;
      if (email === undefined) continue;
      const namespace = item.metadata.namespace ?? "default";
      found.set(email, {
        entityRef: `user:${namespace}/${item.metadata.name}`,
        displayName: typeof profile?.displayName === "string" ? profile.displayName : null,
        picture: typeof profile?.picture === "string" ? profile.picture : null,
      });
    }
    return found;
  }

  async listOwnershipRefs(userEntityRef: string): Promise<string[]> {
    const credentials = await this.auth.getOwnServiceCredentials();

    // By reference rather than by filter: the reference is exactly what the
    // link table stores. It takes no `fields`, which costs one whole entity —
    // the group hops below, which are the unbounded half, do narrow theirs.
    const user = await this.catalog.getEntityByRef(userEntityRef, { credentials });
    // A link outlives the person it names. Somebody who left the organisation
    // owns nothing, which is a row, not a failed request.
    if (user === undefined) return [];

    const owned = [stringifyEntityRef(user)];
    const seen = new Set(owned);
    let frontier = relatedRefs(user, RELATION_MEMBER_OF).filter((ref) => !seen.has(ref));

    for (let depth = 0; depth < MAX_OWNERSHIP_DEPTH && frontier.length > 0; depth += 1) {
      for (const ref of frontier) {
        seen.add(ref);
        owned.push(ref);
      }

      // One request per level rather than one per group: a person in eight
      // teams under three departments is two round trips, not eleven.
      const { items } = await this.catalog.getEntitiesByRefs(
        { entityRefs: frontier, fields: OWNERSHIP_FIELDS },
        { credentials },
      );

      const next = new Set<string>();
      for (const item of items) {
        if (item === undefined) continue;
        for (const parent of relatedRefs(item, RELATION_CHILD_OF)) {
          // The guard is what keeps a group tree somebody drew as a cycle from
          // walking for ever — the catalog does not forbid one.
          if (!seen.has(parent)) next.add(parent);
        }
      }
      frontier = [...next];
    }

    return owned;
  }

  async listUsers(): Promise<DirectoryUser[]> {
    const credentials = await this.auth.getOwnServiceCredentials();
    const { items } = await this.catalog.getEntities(
      { filter: { kind: "User" }, fields: USER_FIELDS, limit: MAX_DIRECTORY_USERS },
      { credentials },
    );

    return items.map(toDirectoryUser);
  }

  async getEntityProfiles(
    entityRefs: readonly string[],
  ): Promise<Map<string, EntityProfile>> {
    const wanted = [...new Set(entityRefs)];
    if (wanted.length === 0) return new Map();

    const credentials = await this.auth.getOwnServiceCredentials();
    const { items } = await this.catalog.getEntitiesByRefs(
      { entityRefs: wanted, fields: PROFILE_FIELDS },
      { credentials },
    );

    const found = new Map<string, EntityProfile>();
    for (const [index, item] of items.entries()) {
      // Positional, with undefined for a reference the catalog does not hold —
      // an owner who has left the organisation since the YAML was written.
      const ref = wanted[index];
      if (item === undefined || ref === undefined) continue;

      const profile = (item.spec as { profile?: Record<string, unknown> } | undefined)
        ?.profile;
      found.set(ref, {
        // Keyed by the reference that was *asked for*, so the caller can look
        // the answer up with the string it already holds; the entity's own
        // spelling of it is not guaranteed to match, and does not need to.
        entityRef: ref,
        // The entity's own name is the fallback, which is what the slug already
        // showed — so a row renders a name either way rather than going blank.
        displayName:
          typeof profile?.displayName === "string" && profile.displayName !== ""
            ? profile.displayName
            : item.metadata.name,
        picture: typeof profile?.picture === "string" ? profile.picture : null,
      });
    }
    return found;
  }

  async getUsersByRef(entityRefs: readonly string[]): Promise<Map<string, DirectoryUser>> {
    const wanted = [...new Set(entityRefs)];
    if (wanted.length === 0) return new Map();

    const credentials = await this.auth.getOwnServiceCredentials();
    // `getEntitiesByRefs` rather than a filter: a reference is exactly what the
    // link table stores, and asking by name would re-parse it into a filter the
    // catalog then has to turn back into the same lookup.
    const { items } = await this.catalog.getEntitiesByRefs(
      { entityRefs: wanted, fields: USER_FIELDS },
      { credentials },
    );

    const found = new Map<string, DirectoryUser>();
    for (const [index, item] of items.entries()) {
      // `getEntitiesByRefs` answers positionally and returns undefined for a
      // reference the catalog does not hold, which is the normal case for
      // somebody who has left the organisation since the link was made.
      const ref = wanted[index];
      if (item === undefined || ref === undefined) continue;
      found.set(ref, toDirectoryUser(item));
    }
    return found;
  }
}
