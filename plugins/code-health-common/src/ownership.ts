import { parseEntityRef } from "./entity_ref";

/**
 * Who, in the catalog, a contributor row stands for when it comes to owning
 * repositories.
 *
 * `owners` is the set of entity references a repository's `spec.owner` is
 * matched against: the person's own `User` entity and every `Group` they are a
 * member of, including the parents of those groups, which is how Backstage
 * itself decides what somebody owns. It is empty for a row nobody has linked to
 * a catalog user, because ownership is a fact about the catalog and an
 * unlinked account has no entity there to own anything with.
 */
export interface OwnershipInfo {
  readonly entityRef: string | null;
  readonly owners: readonly string[];
}

/**
 * What an owning entity is called and what it looks like.
 *
 * A `spec.owner` reference is a slug — `group:default/platform`,
 * `user:default/j.doe_example.com` — and a table that prints the slug
 * makes a reader translate every row back into a person or a team by hand.
 * The catalog already holds the name and the photograph on the entity's
 * `spec.profile`, for `Group` entities as well as `User` ones, so both are
 * resolved on read and carried beside the reference.
 *
 * `displayName` always has a value: an entity with no profile name falls back
 * to its own `metadata.name`, which is what the reference's slug already
 * showed, so a row never renders nameless.
 */
export interface EntityProfile {
  readonly entityRef: string;
  readonly displayName: string;
  readonly picture: string | null;
}

/** What `spec.owner` means when it names no kind, as the catalog reads it. */
export const DEFAULT_OWNER_KIND = "group";

/**
 * Normalises a `spec.owner` value to a full entity reference.
 *
 * The catalog accepts `team-a`, `group:team-a`, `default/team-a` and
 * `user:default/jane` and treats them as references with the kind and
 * namespace filled in, so this applies the same defaults — otherwise two
 * spellings of one group would fail to match each other. Kind and namespace
 * are folded to lower case as the catalog does; the name keeps its case.
 */
export const ownerEntityRef = (owner: string): string | null => {
  const trimmed = owner.trim();
  if (trimmed === "") return null;
  const qualified = trimmed.includes(":") ? trimmed : `${DEFAULT_OWNER_KIND}:${trimmed}`;
  const parsed = parseEntityRef(qualified);
  return parsed === null ? null : `${parsed.kind}:${parsed.namespace}/${parsed.name}`;
};
