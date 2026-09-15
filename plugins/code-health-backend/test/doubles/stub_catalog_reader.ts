import type { Entity } from "@backstage/catalog-model";
import type { EntityProfile } from "@rios0rios0/backstage-plugin-code-health-common";
import type { EntityFilter } from "../../src/domain/entities/ingestion_settings";
import type { CatalogReader, CatalogUser } from "../../src/domain/services/catalog_reader";

export class StubCatalogReader implements CatalogReader {
  private entities: Entity[] = [];
  private failure: Error | null = null;

  private users = new Map<string, CatalogUser>();

  private ownership = new Map<string, readonly string[]>();

  private profiles = new Map<string, EntityProfile>();

  /** Filters each call was made with, so tests can assert what was requested. */
  readonly calls: Array<readonly EntityFilter[]> = [];

  /** E-mails each user lookup was made with, for the same reason. */
  readonly emailLookups: Array<readonly string[]> = [];

  /** References each ownership lookup was made with, for the same reason. */
  readonly ownershipLookups: string[] = [];

  /** References each profile lookup was made with, so a test can assert it is
   * one call bounded by the distinct owners rather than one call per row. */
  readonly profileLookups: Array<readonly string[]> = [];

  withUsers(users: Record<string, CatalogUser>): StubCatalogReader {
    this.users = new Map(Object.entries(users));
    return this;
  }

  /**
   * Declares which groups a user belongs to, already expanded through their
   * parents — which is what the real reader returns, since it does the walk.
   */
  withMemberships(userEntityRef: string, groupRefs: readonly string[]): StubCatalogReader {
    this.ownership.set(userEntityRef, groupRefs);
    return this;
  }

  /**
   * Declares the owning entities the catalog holds, of any kind.
   *
   * `displayName` is required here for the same reason the wire type requires
   * it: the adapter falls back to `metadata.name`, so a resolved profile always
   * carries a name and a double that allowed a null one could not stand in.
   */
  withProfiles(profiles: Record<string, { displayName: string; picture?: string }>): StubCatalogReader {
    this.profiles = new Map(
      Object.entries(profiles).map(([entityRef, profile]) => [
        entityRef,
        { entityRef, displayName: profile.displayName, picture: profile.picture ?? null },
      ]),
    );
    return this;
  }

  withEntities(entities: Entity[]): StubCatalogReader {
    this.entities = entities;
    return this;
  }

  withFailure(failure: Error): StubCatalogReader {
    this.failure = failure;
    return this;
  }

  async listEntities(filters: readonly EntityFilter[]): Promise<Entity[]> {
    this.calls.push(filters);
    if (this.failure) throw this.failure;
    return this.entities;
  }

  async findUsersByEmail(emails: readonly string[]): Promise<Map<string, CatalogUser>> {
    this.emailLookups.push(emails);
    if (this.failure) throw this.failure;

    // Both sides are lowercased, because `CatalogReader` documents the result
    // as keyed by the lowercased address. Normalising only the query would let
    // a user seeded under a mixed-case key never match, and would return keys
    // in whatever casing the test happened to write — a double that disagrees
    // with the adapter it stands in for turns a real bug into a passing test.
    const wanted = new Set(emails.map((email) => email.toLowerCase()));
    return new Map(
      [...this.users.entries()]
        .map(([email, user]) => [email.toLowerCase(), user] as const)
        .filter(([email]) => wanted.has(email)),
    );
  }

  async getEntityProfiles(
    entityRefs: readonly string[],
  ): Promise<Map<string, EntityProfile>> {
    this.profileLookups.push(entityRefs);
    if (this.failure) throw this.failure;

    // Mirrors the adapter: a reference the catalog does not hold is simply
    // absent, so the caller renders the slug rather than being handed a
    // fabricated name.
    return new Map(
      entityRefs.flatMap((ref) => {
        const profile = this.profiles.get(ref);
        return profile === undefined ? [] : [[ref, profile] as const];
      }),
    );
  }

  async listOwnershipRefs(userEntityRef: string): Promise<string[]> {
    this.ownershipLookups.push(userEntityRef);
    if (this.failure) throw this.failure;

    const groups = this.ownership.get(userEntityRef);
    // Mirrors the adapter: a reference the catalog does not hold owns nothing,
    // and one it does owns at least itself. `withMemberships(ref, [])` is
    // therefore how a test says "this user exists and is in no group".
    if (groups === undefined) return [];
    return [userEntityRef, ...groups];
  }
}
