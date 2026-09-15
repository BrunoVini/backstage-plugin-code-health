import type {
  ExclusionReason,
  IdentitySource,
} from "@rios0rios0/backstage-plugin-code-health-common";
import { normalizeSourceKey } from "../entities/identity";
import type { CodeHealthStore } from "../repositories/code_health_store";
import { UnknownIdentityError } from "./link_identity";

/**
 * Takes an account out of every measurement the plugin makes, or puts it back.
 *
 * A fleet contains accounts that are not people being measured: the build
 * service Azure DevOps performs merges as, the bot that opens dependency pull
 * requests, an outside contributor to a public repository, somebody who left
 * last year. Left in, each of them is a contributor row — and worse than a row,
 * because output is scored against the team's mean rate in the window, so an
 * automation that merges two hundred pull requests a month drags up the bar
 * every human on the team is then measured against.
 *
 * The reason is required. It is the whole justification for a row disappearing
 * from every table, and six months later it is the only thing that can tell an
 * account excluded on purpose from one somebody excluded by accident.
 *
 * The account is verified before anything is written, for the same reason a
 * link is: an exclusion on an account nobody has observed matches nothing, the
 * tables look exactly as they did, and the person who made it has no way to
 * tell it did not work.
 */
export class ExcludeIdentity {
  constructor(private readonly store: CodeHealthStore) {}

  async exclude(input: {
    source: IdentitySource;
    sourceKey: string;
    reason: ExclusionReason;
    excludedBy: string | null;
    now: Date;
  }): Promise<void> {
    const sourceKey = normalizeSourceKey(input.sourceKey);

    const observed = await this.store.listIdentities({ sources: [input.source] });
    if (!observed.some((identity) => identity.sourceKey === sourceKey)) {
      throw new UnknownIdentityError(input.source, sourceKey);
    }

    await this.store.saveIdentityExclusion({
      source: input.source,
      sourceKey,
      reason: input.reason,
      excludedBy: input.excludedBy,
      excludedAt: input.now,
    });
  }

  /**
   * Puts the account back into every measurement.
   *
   * Nothing has to be re-collected: the events and the per-source measures were
   * never touched, and the exclusion was applied when a row was built. So every
   * window the plugin has ever collected reports the account again from the
   * next request onwards, including the windows collected while it was out.
   *
   * Unverified, unlike {@link exclude}. Including an account that was never
   * excluded is already true, and refusing it would leave somebody unable to
   * clear a row for an account that has since aged out of the identity table.
   */
  async include(input: { source: IdentitySource; sourceKey: string }): Promise<void> {
    await this.store.deleteIdentityExclusion({
      source: input.source,
      sourceKey: normalizeSourceKey(input.sourceKey),
    });
  }
}
