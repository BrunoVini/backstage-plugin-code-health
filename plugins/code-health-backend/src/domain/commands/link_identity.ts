import type { IdentitySource } from "@rios0rios0/backstage-plugin-code-health-common";
import { parseEntityRef } from "@rios0rios0/backstage-plugin-code-health-common";
import { normalizeSourceKey } from "../entities/identity";
import type { CodeHealthStore } from "../repositories/code_health_store";
import type { DirectoryReader } from "../services/identity_resolver";

export class UnknownIdentityError extends Error {
  constructor(source: IdentitySource, sourceKey: string) {
    super(`no ${source} identity called ${sourceKey} has been observed`);
    this.name = "UnknownIdentityError";
  }
}

export class UnknownUserError extends Error {
  constructor(entityRef: string) {
    super(`${entityRef} is not a user in the catalog`);
    this.name = "UnknownUserError";
  }
}

export class MalformedEntityRefError extends Error {
  constructor(entityRef: string) {
    super(`\`${entityRef}\` is not an entity reference; expected \`user:<namespace>/<name>\``);
    this.name = "MalformedEntityRefError";
  }
}

export class NotAUserReferenceError extends Error {
  constructor(entityRef: string, kind: string) {
    super(
      `\`${entityRef}\` names a ${kind}, and a link needs a \`user:<namespace>/<name>\` reference`,
    );
    this.name = "NotAUserReferenceError";
  }
}

/**
 * Attaches an account to a catalog user, or detaches it again.
 *
 * Both halves are verified before anything is written. An account nobody has
 * observed and a user the catalog does not hold both produce a link that
 * silently matches nothing — the contributor row would look exactly as it did
 * before, and the person who made the link would have no way to tell it had not
 * worked. Failing loudly at the moment of the mistake is the only point at
 * which it is cheap to fix.
 *
 * The reference is checked for shape here rather than left to the catalog,
 * which throws on an unparseable one — a bare name typed into the link field
 * would otherwise surface as a 500 instead of the "told plainly that it does
 * not exist" the screen promises.
 */
export class LinkIdentity {
  constructor(
    private readonly store: CodeHealthStore,
    private readonly directory: DirectoryReader,
  ) {}

  async link(input: {
    source: IdentitySource;
    sourceKey: string;
    entityRef: string;
    linkedBy: string | null;
    now: Date;
  }): Promise<void> {
    const sourceKey = normalizeSourceKey(input.sourceKey);

    // Shape first, before any lookup: a request that could never be valid is
    // rejected without touching the database, and the caller is told which of
    // the two things was wrong rather than being sent looking for a user that
    // was never a reference in the first place.
    const parsed = parseEntityRef(input.entityRef);
    if (parsed === null) {
      throw new MalformedEntityRefError(input.entityRef);
    }
    // Kind as well as shape. Any kind parses, and the directory lookup below
    // would answer for a group or a component with a user-shaped record built
    // from its name — a link to `group:default/platform` would then be stored
    // as `user:default/platform`, which is either nobody or the wrong person.
    if (parsed.kind !== "user") {
      throw new NotAUserReferenceError(input.entityRef, parsed.kind);
    }

    const observed = await this.store.listIdentities({ sources: [input.source] });
    if (!observed.some((identity) => identity.sourceKey === sourceKey)) {
      throw new UnknownIdentityError(input.source, sourceKey);
    }

    const users = await this.directory.getUsersByRef([input.entityRef]);
    const user = users.get(input.entityRef);
    if (user === undefined) {
      throw new UnknownUserError(input.entityRef);
    }

    await this.store.saveIdentityLink({
      source: input.source,
      sourceKey,
      // The reference the catalog entity itself produces, not the one that was
      // typed. `user:jdoe` omits the namespace and `user:default/JDoe` gets the
      // case wrong, and the catalog resolves both — but the stored string *is*
      // the person key, so either would produce a key that never joins the
      // canonical one `ReconcileIdentities` writes, and the same human would
      // hold two rows. Which is the exact failure this feature exists to remove.
      entityRef: user.entityRef,
      origin: "manual",
      linkedBy: input.linkedBy,
      linkedAt: input.now,
    });
  }

  async unlink(input: { source: IdentitySource; sourceKey: string }): Promise<void> {
    await this.store.deleteIdentityLink({
      source: input.source,
      sourceKey: normalizeSourceKey(input.sourceKey),
    });
  }
}
