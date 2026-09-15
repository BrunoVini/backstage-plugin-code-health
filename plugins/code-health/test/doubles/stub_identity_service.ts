import type {
  ExclusionReason,
  IdentityRow,
  IdentitySource,
} from "@rios0rios0/backstage-plugin-code-health-common";
import type { IdentityService } from "../../src/domain/services/dashboard_service";

/**
 * An in-memory identity directory.
 *
 * It keeps links rather than recording calls, because the screen's behaviour is
 * what the listing says after a write — a double that only counted calls would
 * pass whether or not the link took effect.
 */
export class StubIdentityService implements IdentityService {
  private rows: IdentityRow[] = [];
  private linkFailure: Error | null = null;
  private listFailure: Error | null = null;
  private writeFailure: Error | null = null;

  readonly filters: Array<{
    sources?: readonly IdentitySource[];
    linked?: boolean;
    excluded?: boolean;
  }> = [];

  withRows(rows: readonly IdentityRow[]): this {
    this.rows = [...rows];
    return this;
  }

  withListFailure(failure: Error): this {
    this.listFailure = failure;
    return this;
  }

  withLinkFailure(failure: Error): this {
    this.linkFailure = failure;
    return this;
  }

  withWriteFailure(failure: Error): this {
    this.writeFailure = failure;
    return this;
  }

  async listIdentities(filter: {
    sources?: readonly IdentitySource[];
    linked?: boolean;
    excluded?: boolean;
  }): Promise<IdentityRow[]> {
    this.filters.push(filter);
    if (this.listFailure) throw this.listFailure;

    return this.rows.filter((row) => {
      if (filter.sources && !filter.sources.includes(row.identity.source)) return false;
      if (filter.linked !== undefined && (row.link !== null) !== filter.linked) return false;
      if (filter.excluded !== undefined && (row.exclusion !== null) !== filter.excluded) {
        return false;
      }
      return true;
    });
  }

  async linkIdentity(link: {
    source: IdentitySource;
    sourceKey: string;
    entityRef: string;
  }): Promise<void> {
    if (this.linkFailure) throw this.linkFailure;

    this.rows = this.rows.map((row) =>
      row.identity.source === link.source && row.identity.sourceKey === link.sourceKey
        ? {
            ...row,
            link: {
              entityRef: link.entityRef,
              origin: "manual",
              linkedBy: "user:default/tester",
              linkedAt: "2026-08-10T12:00:00.000Z",
            },
            suggestions: [],
          }
        : row,
    );
  }

  async unlinkIdentity(identity: {
    source: IdentitySource;
    sourceKey: string;
  }): Promise<void> {
    this.rows = this.rows.map((row) =>
      row.identity.source === identity.source &&
      row.identity.sourceKey === identity.sourceKey
        ? { ...row, link: null }
        : row,
    );
  }

  async excludeIdentity(exclusion: {
    source: IdentitySource;
    sourceKey: string;
    reason: ExclusionReason;
  }): Promise<void> {
    if (this.writeFailure) throw this.writeFailure;

    this.rows = this.rows.map((row) =>
      row.identity.source === exclusion.source &&
      row.identity.sourceKey === exclusion.sourceKey
        ? {
            ...row,
            exclusion: {
              source: exclusion.source,
              sourceKey: exclusion.sourceKey,
              reason: exclusion.reason,
              excludedBy: "user:default/tester",
              excludedAt: "2026-09-15T12:00:00.000Z",
            },
          }
        : row,
    );
  }

  async includeIdentity(identity: {
    source: IdentitySource;
    sourceKey: string;
  }): Promise<void> {
    if (this.writeFailure) throw this.writeFailure;

    this.rows = this.rows.map((row) =>
      row.identity.source === identity.source &&
      row.identity.sourceKey === identity.sourceKey
        ? { ...row, exclusion: null }
        : row,
    );
  }
}
