import type { AuthService } from "@backstage/backend-plugin-api";
import type { Entity } from "@backstage/catalog-model";
import type { CatalogService } from "@backstage/plugin-catalog-node";
import {
  BackstageCatalogReader,
  MAX_OWNERSHIP_DEPTH,
} from "../../../src/infrastructure/services/backstage_catalog_reader";

interface RecordedQuery {
  readonly filter: unknown;
  readonly fields: readonly string[] | undefined;
  readonly limit?: number | undefined;
}

/**
 * Hand-rolled stand-in for the catalog client.
 *
 * It answers with whatever entities the test seeded and records the query it
 * was handed, which is the part worth asserting: the filter decides whether a
 * contributor resolves at all.
 */
class StubCatalogService {
  readonly queries: RecordedQuery[] = [];
  readonly refQueries: Array<readonly string[]> = [];
  readonly refFields: Array<readonly string[] | undefined> = [];
  readonly singleRefQueries: string[] = [];

  constructor(private readonly entities: Entity[] = []) {}

  async getEntityByRef(entityRef: string): Promise<Entity | undefined> {
    this.singleRefQueries.push(entityRef);
    return this.byRef(entityRef);
  }

  private byRef(entityRef: string): Entity | undefined {
    return this.entities.find(
      (entity) =>
        `${entity.kind.toLowerCase()}:${entity.metadata.namespace ?? "default"}/${
          entity.metadata.name
        }` === entityRef,
    );
  }

  async getEntities(request: {
    filter?: unknown;
    fields?: readonly string[];
    limit?: number;
  }): Promise<{ items: Entity[] }> {
    this.queries.push({ filter: request.filter, fields: request.fields, limit: request.limit });
    return { items: this.entities };
  }

  async getEntitiesByRefs(request: {
    entityRefs: readonly string[];
    fields?: readonly string[];
  }): Promise<{ items: Array<Entity | undefined> }> {
    this.refQueries.push(request.entityRefs);
    this.refFields.push(request.fields);
    // Positional, and undefined for a reference the catalog does not hold —
    // which is what the real client does, and the normal case for somebody who
    // has left the organisation since the link was made.
    return { items: request.entityRefs.map((ref) => this.byRef(ref)) };
  }

  asCatalogService(): CatalogService {
    return this as unknown as CatalogService;
  }
}

const stubAuth = (): AuthService =>
  ({
    getOwnServiceCredentials: async () => ({}) as never,
  }) as unknown as AuthService;

const aUser = (overrides: {
  name: string;
  namespace?: string;
  email?: unknown;
  displayName?: unknown;
  picture?: unknown;
}): Entity =>
  ({
    apiVersion: "backstage.io/v1alpha1",
    kind: "User",
    metadata: {
      name: overrides.name,
      ...(overrides.namespace === undefined ? {} : { namespace: overrides.namespace }),
    },
    spec: {
      profile: {
        ...(overrides.email === undefined ? {} : { email: overrides.email }),
        ...(overrides.displayName === undefined ? {} : { displayName: overrides.displayName }),
        ...(overrides.picture === undefined ? {} : { picture: overrides.picture }),
      },
    },
  }) as Entity;

const readerFor = (catalog: StubCatalogService) =>
  new BackstageCatalogReader(catalog.asCatalogService(), stubAuth());

describe("BackstageCatalogReader.findUsersByEmail", () => {
  it("should key the result by the lowercased address", async () => {
    // given
    const catalog = new StubCatalogService([
      aUser({
        name: "jane.doe",
        email: "Jane.Doe@example.com",
        displayName: "Jane Doe",
        picture: "https://example.test/jane.png",
      }),
    ]);

    // when
    const found = await readerFor(catalog).findUsersByEmail(["JANE.DOE@EXAMPLE.COM"]);

    // then
    expect(found.get("jane.doe@example.com")).toEqual({
      entityRef: "user:default/jane.doe",
      displayName: "Jane Doe",
      picture: "https://example.test/jane.png",
    });
  });

  it("should query the lowercased addresses, which is what the search index holds", async () => {
    // given
    const catalog = new StubCatalogService([]);

    // when
    await readerFor(catalog).findUsersByEmail(["Jane.Doe@example.com"]);

    // then
    expect(catalog.queries[0].filter).toEqual({
      kind: "User",
      "spec.profile.email": ["jane.doe@example.com"],
    });
  });

  it("should ask only for the fields it reads", async () => {
    // given
    // Requesting whole entities is the usual performance mistake in a plugin
    // that queries the catalog on every dashboard load.
    const catalog = new StubCatalogService([]);

    // when
    await readerFor(catalog).findUsersByEmail(["jane@example.com"]);

    // then
    expect(catalog.queries[0].fields).toEqual([
      "kind",
      "metadata.name",
      "metadata.namespace",
      "spec.profile",
    ]);
  });

  it("should ask for each address once", async () => {
    // given
    // The same person committing under two spellings is one row to look up.
    const catalog = new StubCatalogService([]);

    // when
    await readerFor(catalog).findUsersByEmail([
      "jane@example.com",
      "JANE@example.com",
      "jane@example.com",
    ]);

    // then
    expect(catalog.queries[0].filter).toEqual({
      kind: "User",
      "spec.profile.email": ["jane@example.com"],
    });
  });

  it("should not query at all when no key is an address", async () => {
    // given
    // GitHub reports a login rather than an e-mail, and a login matches nothing
    // here — asking anyway would be a request per dashboard load for no result.
    const catalog = new StubCatalogService([]);

    // when
    const found = await readerFor(catalog).findUsersByEmail(["octocat", "dependabot[bot]"]);

    // then
    expect(found.size).toBe(0);
    expect(catalog.queries).toHaveLength(0);
  });

  it("should keep the entity's own namespace", async () => {
    // given
    const catalog = new StubCatalogService([
      aUser({ name: "jane.doe", namespace: "staff", email: "jane@example.com" }),
    ]);

    // when
    const found = await readerFor(catalog).findUsersByEmail(["jane@example.com"]);

    // then
    expect(found.get("jane@example.com")?.entityRef).toBe("user:staff/jane.doe");
  });

  it("should report a user with no display name or picture as null rather than dropping it", async () => {
    // given
    // The link is still worth having; only the name and avatar are missing.
    const catalog = new StubCatalogService([
      aUser({ name: "jane.doe", email: "jane@example.com" }),
    ]);

    // when
    const found = await readerFor(catalog).findUsersByEmail(["jane@example.com"]);

    // then
    expect(found.get("jane@example.com")).toEqual({
      entityRef: "user:default/jane.doe",
      displayName: null,
      picture: null,
    });
  });

  it("should ignore a profile whose fields are not strings", async () => {
    // given
    // Catalog entities are user-authored YAML, so a profile can hold anything.
    const catalog = new StubCatalogService([
      aUser({
        name: "odd",
        email: "odd@example.com",
        displayName: 42,
        picture: { url: "nope" },
      }),
    ]);

    // when
    const found = await readerFor(catalog).findUsersByEmail(["odd@example.com"]);

    // then
    expect(found.get("odd@example.com")).toEqual({
      entityRef: "user:default/odd",
      displayName: null,
      picture: null,
    });
  });

  it("should skip an entity carrying no address to key on", async () => {
    // given
    const catalog = new StubCatalogService([
      aUser({ name: "no-profile" }),
      aUser({ name: "jane.doe", email: "jane@example.com" }),
    ]);

    // when
    const found = await readerFor(catalog).findUsersByEmail(["jane@example.com"]);

    // then
    expect([...found.keys()]).toEqual(["jane@example.com"]);
  });
});

describe("BackstageCatalogReader.listUsers", () => {
  it("should return the directory as suggestion candidates", async () => {
    // given
    const catalog = new StubCatalogService([
      aUser({ name: "felipe", email: "Felipe@Example.com", displayName: "Felipe Rios" }),
    ]);

    // when
    const users = await new BackstageCatalogReader(
      catalog.asCatalogService(),
      stubAuth(),
    ).listUsers();

    // then
    expect(users).toEqual([
      {
        entityRef: "user:default/felipe",
        displayName: "Felipe Rios",
        // Lowercased, so the matching rules compare like with like.
        email: "felipe@example.com",
        picture: null,
      },
    ]);
  });

  it("should fall back to the entity name when the profile carries none", async () => {
    // given
    // A candidate with no label at all cannot be picked from a list.
    const catalog = new StubCatalogService([aUser({ name: "felipe" })]);

    // when
    const [user] = await new BackstageCatalogReader(
      catalog.asCatalogService(),
      stubAuth(),
    ).listUsers();

    // then
    expect(user?.displayName).toBe("felipe");
    expect(user?.email).toBeNull();
  });

  it("should cap the listing", async () => {
    // given
    // Enumerating a directory is the one thing this plugin otherwise refuses to
    // do; the cap keeps a very large tenant from turning the screen into an
    // outage.
    const catalog = new StubCatalogService([]);

    // when
    await new BackstageCatalogReader(catalog.asCatalogService(), stubAuth()).listUsers();

    // then
    expect(catalog.queries[0]).toMatchObject({ filter: { kind: "User" }, limit: 5000 });
  });
});

describe("BackstageCatalogReader.getUsersByRef", () => {
  it("should fetch by reference and key the result by it", async () => {
    // given
    const catalog = new StubCatalogService([
      aUser({ name: "felipe", displayName: "Felipe Rios" }),
    ]);

    // when
    const users = await new BackstageCatalogReader(
      catalog.asCatalogService(),
      stubAuth(),
    ).getUsersByRef(["user:default/felipe"]);

    // then
    expect(users.get("user:default/felipe")?.displayName).toBe("Felipe Rios");
  });

  it("should ask for each reference once", async () => {
    // given
    const catalog = new StubCatalogService([]);

    // when
    await new BackstageCatalogReader(catalog.asCatalogService(), stubAuth()).getUsersByRef([
      "user:default/felipe",
      "user:default/felipe",
    ]);

    // then
    expect(catalog.refQueries).toEqual([["user:default/felipe"]]);
  });

  it("should not query at all when nothing was asked for", async () => {
    // given
    const catalog = new StubCatalogService([]);

    // when
    const users = await new BackstageCatalogReader(
      catalog.asCatalogService(),
      stubAuth(),
    ).getUsersByRef([]);

    // then
    expect(users.size).toBe(0);
    expect(catalog.refQueries).toEqual([]);
  });

  it("should skip a reference the catalog no longer holds", async () => {
    // given
    // Somebody who left the organisation after their account was linked.
    const catalog = new StubCatalogService([]);

    // when
    const users = await new BackstageCatalogReader(
      catalog.asCatalogService(),
      stubAuth(),
    ).getUsersByRef(["user:default/departed"]);

    // then
    expect(users.size).toBe(0);
  });

  it("should skip an entity that is not a user", async () => {
    // given
    // The lookup answers for any kind the reference names, and a group dressed
    // up as `user:default/platform` would be a record for an entity that does
    // not exist, keyed under a person's reference.
    const catalog = new StubCatalogService([
      {
        apiVersion: "backstage.io/v1alpha1",
        kind: "Group",
        metadata: { name: "platform", namespace: "default" },
        spec: { type: "team", profile: { displayName: "Platform" } },
      },
      aUser({ name: "felipe", displayName: "Felipe Rios" }),
    ]);

    // when
    const users = await new BackstageCatalogReader(
      catalog.asCatalogService(),
      stubAuth(),
    ).getUsersByRef(["group:default/platform", "user:default/felipe"]);

    // then
    expect([...users.keys()]).toEqual(["user:default/felipe"]);
  });
});

/** A `User` or `Group` with the relations the ownership walk follows. */
const withRelations = (
  kind: string,
  name: string,
  relations: Array<{ type: string; targetRef: string }>,
): Entity =>
  ({
    apiVersion: "backstage.io/v1alpha1",
    kind,
    metadata: { name, namespace: "default" },
    spec: {},
    relations,
  }) as Entity;

describe("BackstageCatalogReader.listOwnershipRefs", () => {
  it("should always include the user's own reference", async () => {
    // given
    // A repository owned by a person directly, rather than by their team, is
    // theirs — and `spec.owner: user:default/jane` is a shape the catalog
    // accepts.
    const catalog = new StubCatalogService([withRelations("User", "jane", [])]);

    // when
    const owned = await readerFor(catalog).listOwnershipRefs("user:default/jane");

    // then
    expect(owned).toEqual(["user:default/jane"]);
  });

  it("should include every group the user is a member of", async () => {
    // given
    const catalog = new StubCatalogService([
      withRelations("User", "jane", [
        { type: "memberOf", targetRef: "group:default/platform" },
        { type: "memberOf", targetRef: "group:default/payments" },
      ]),
      withRelations("Group", "platform", []),
      withRelations("Group", "payments", []),
    ]);

    // when
    const owned = await readerFor(catalog).listOwnershipRefs("user:default/jane");

    // then
    expect(owned).toEqual([
      "user:default/jane",
      "group:default/platform",
      "group:default/payments",
    ]);
  });

  it("should walk up through the parents of those groups", async () => {
    // given
    // A repository whose `spec.owner` names a department belongs to everybody
    // underneath it, which is how the catalog's own ownership page reads it.
    const catalog = new StubCatalogService([
      withRelations("User", "jane", [
        { type: "memberOf", targetRef: "group:default/platform" },
      ]),
      withRelations("Group", "platform", [
        { type: "childOf", targetRef: "group:default/engineering" },
      ]),
      withRelations("Group", "engineering", [
        { type: "childOf", targetRef: "group:default/acme" },
      ]),
      withRelations("Group", "acme", []),
    ]);

    // when
    const owned = await readerFor(catalog).listOwnershipRefs("user:default/jane");

    // then
    expect(owned).toEqual([
      "user:default/jane",
      "group:default/platform",
      "group:default/engineering",
      "group:default/acme",
    ]);
  });

  it("should ask for the whole level at once rather than group by group", async () => {
    // given
    // A person in eight teams under three departments is two round trips, not
    // eleven.
    const catalog = new StubCatalogService([
      withRelations("User", "jane", [
        { type: "memberOf", targetRef: "group:default/platform" },
        { type: "memberOf", targetRef: "group:default/payments" },
      ]),
      withRelations("Group", "platform", []),
      withRelations("Group", "payments", []),
    ]);

    // when
    await readerFor(catalog).listOwnershipRefs("user:default/jane");

    // then
    expect(catalog.refQueries).toEqual([
      ["group:default/platform", "group:default/payments"],
    ]);
  });

  it("should ask only for the fields the walk reads", async () => {
    // given
    const catalog = new StubCatalogService([
      withRelations("User", "jane", [
        { type: "memberOf", targetRef: "group:default/platform" },
      ]),
      withRelations("Group", "platform", []),
    ]);

    // when
    await readerFor(catalog).listOwnershipRefs("user:default/jane");

    // then
    expect(catalog.refFields[0]).toEqual([
      "kind",
      "metadata.name",
      "metadata.namespace",
      "relations",
    ]);
  });

  it("should survive a group tree somebody drew as a cycle", async () => {
    // given
    // Nothing in the catalog forbids one, and a walk without the guard would
    // never return.
    const catalog = new StubCatalogService([
      withRelations("User", "jane", [
        { type: "memberOf", targetRef: "group:default/platform" },
      ]),
      withRelations("Group", "platform", [
        { type: "childOf", targetRef: "group:default/engineering" },
      ]),
      withRelations("Group", "engineering", [
        { type: "childOf", targetRef: "group:default/platform" },
      ]),
    ]);

    // when
    const owned = await readerFor(catalog).listOwnershipRefs("user:default/jane");

    // then
    expect(owned).toEqual([
      "user:default/jane",
      "group:default/platform",
      "group:default/engineering",
    ]);
  });

  it("should stop at the depth bound on a tree deeper than it", async () => {
    // given
    // A ceiling rather than a promise: the cycle guard already handles a loop,
    // so this only bounds a chart that is genuinely this deep.
    const depth = MAX_OWNERSHIP_DEPTH + 3;
    const catalog = new StubCatalogService([
      withRelations("User", "jane", [{ type: "memberOf", targetRef: "group:default/g0" }]),
      ...Array.from({ length: depth }, (_unused, index) =>
        withRelations("Group", `g${index}`, [
          { type: "childOf", targetRef: `group:default/g${index + 1}` },
        ]),
      ),
    ]);

    // when
    const owned = await readerFor(catalog).listOwnershipRefs("user:default/jane");

    // then
    expect(owned).toHaveLength(1 + MAX_OWNERSHIP_DEPTH);
  });

  it("should own nothing for a user the catalog no longer holds", async () => {
    // given
    // A link outlives the person it names; a stale one is a row that owns
    // nothing, not a failed request.
    const catalog = new StubCatalogService([]);

    // when
    const owned = await readerFor(catalog).listOwnershipRefs("user:default/departed");

    // then
    expect(owned).toEqual([]);
    expect(catalog.refQueries).toEqual([]);
  });

  it("should own only itself for a user the catalog reports no relations for", async () => {
    // given
    // `relations` is absent rather than empty on an entity the catalog has not
    // finished stitching, and on one registered by hand.
    const catalog = new StubCatalogService([
      {
        apiVersion: "backstage.io/v1alpha1",
        kind: "User",
        metadata: { name: "jane", namespace: "default" },
        spec: {},
      } as Entity,
    ]);

    // when
    const owned = await readerFor(catalog).listOwnershipRefs("user:default/jane");

    // then
    expect(owned).toEqual(["user:default/jane"]);
  });

  it("should skip a parent the catalog no longer holds", async () => {
    // given
    // A `childOf` relation outlives the group it points at, and a walk that
    // dereferenced it would fail the whole ownership lookup over one stale edge.
    const catalog = new StubCatalogService([
      withRelations("User", "jane", [
        { type: "memberOf", targetRef: "group:default/platform" },
      ]),
      withRelations("Group", "platform", [
        { type: "childOf", targetRef: "group:default/disbanded" },
      ]),
    ]);

    // when
    const owned = await readerFor(catalog).listOwnershipRefs("user:default/jane");

    // then
    expect(owned).toEqual([
      "user:default/jane",
      "group:default/platform",
      "group:default/disbanded",
    ]);
  });

  it("should ignore relations that are not memberships or parents", async () => {
    // given
    const catalog = new StubCatalogService([
      withRelations("User", "jane", [
        { type: "memberOf", targetRef: "group:default/platform" },
        { type: "ownerOf", targetRef: "component:default/gateway" },
      ]),
      withRelations("Group", "platform", [
        { type: "hasMember", targetRef: "user:default/jane" },
      ]),
    ]);

    // when
    const owned = await readerFor(catalog).listOwnershipRefs("user:default/jane");

    // then
    expect(owned).toEqual(["user:default/jane", "group:default/platform"]);
  });
});
