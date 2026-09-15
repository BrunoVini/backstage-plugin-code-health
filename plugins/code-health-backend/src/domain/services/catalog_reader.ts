import type { Entity } from "@backstage/catalog-model";
import type { EntityProfile } from "@rios0rios0/backstage-plugin-code-health-common";
import type { EntityFilter } from "../entities/ingestion_settings";

/**
 * Reads the entities the plugin should track.
 *
 * Narrowed to exactly what discovery needs, so the discovery command can be
 * unit-tested against a hand-rolled in-memory implementation instead of a
 * catalog client and a credentials service.
 */
/** The parts of a catalog `User` a contributor row needs. */
export interface CatalogUser {
  readonly entityRef: string;
  readonly displayName: string | null;
  readonly picture: string | null;
}

export interface CatalogReader {
  listEntities(filters: readonly EntityFilter[]): Promise<Entity[]>;

  /**
   * Catalog users whose profile e-mail matches one of `emails`, keyed by the
   * lowercased e-mail.
   *
   * Deliberately a lookup by address rather than "list every user": an
   * organisation's directory is routinely thousands of entities, of which only
   * the handful who committed in the window can ever match, and this runs on
   * every dashboard load.
   */
  findUsersByEmail(emails: readonly string[]): Promise<Map<string, CatalogUser>>;

  /**
   * Every entity reference a catalog user owns repositories *as*: their own
   * `User`, the groups they are a member of, and the parents of those groups.
   *
   * This is the same expansion Backstage's own identity performs to decide what
   * somebody owns, and matching it is the point — a repository whose
   * `spec.owner` names a parent group belongs to everyone underneath it, and a
   * plugin that compared only the user's direct memberships would tell a team
   * lead they own nothing while the catalog page says they own forty things.
   *
   * A reference the catalog does not hold yields an empty list rather than an
   * error: a link outlives the person it names, and a stale one is a row that
   * owns nothing, not a broken request.
   */
  listOwnershipRefs(userEntityRef: string): Promise<string[]>;

  /**
   * The name and photograph of each entity reference, keyed by the reference.
   *
   * Any kind, not only `User`: a repository's `spec.owner` is usually a
   * `Group`, and a lookup that quietly returned nothing for those would leave
   * most of a fleet's rows printing slugs.
   *
   * Bounded by the *distinct* owners of the tracked repositories, which is a
   * team list rather than a directory — two hundred repositories in an
   * organisation share a handful of owners, so this is one small query per
   * dashboard load rather than one per row.
   *
   * A reference the catalog does not hold is simply absent from the result: an
   * owner who has left is a row with no photograph, not a broken request.
   */
  getEntityProfiles(entityRefs: readonly string[]): Promise<Map<string, EntityProfile>>;
}
