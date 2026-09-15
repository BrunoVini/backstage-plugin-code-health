import type {
  ExclusionReason,
  IdentityRow,
  IdentitySource,
  IdentitySuggestion,
} from "@rios0rios0/backstage-plugin-code-health-common";

export class IdentityRowBuilder {
  private row: IdentityRow = {
    identity: {
      source: "wakatime",
      sourceKey: "jrios",
      displayName: "Felipe Rios",
      email: null,
      avatarUrl: null,
      profileUrl: null,
      firstSeenAt: "2026-08-01T00:00:00.000Z",
      lastSeenAt: "2026-08-10T00:00:00.000Z",
    },
    link: null,
    suggestions: [],
    exclusion: null,
  };

  static create(): IdentityRowBuilder {
    return new IdentityRowBuilder();
  }

  from(source: IdentitySource, sourceKey: string): this {
    this.row = { ...this.row, identity: { ...this.row.identity, source, sourceKey } };
    return this;
  }

  named(displayName: string | null): this {
    this.row = { ...this.row, identity: { ...this.row.identity, displayName } };
    return this;
  }

  withEmail(email: string | null): this {
    this.row = { ...this.row, identity: { ...this.row.identity, email } };
    return this;
  }

  linkedTo(entityRef: string, origin: "manual" | "catalog-email" = "manual"): this {
    this.row = {
      ...this.row,
      link: {
        entityRef,
        origin,
        linkedBy: origin === "manual" ? "user:default/admin" : null,
        linkedAt: "2026-08-10T12:00:00.000Z",
      },
      suggestions: [],
    };
    return this;
  }

  withSuggestions(...suggestions: readonly Partial<IdentitySuggestion>[]): this {
    this.row = {
      ...this.row,
      suggestions: suggestions.map((suggestion, index) => ({
        entityRef: `user:default/candidate-${index}`,
        displayName: `Candidate ${index}`,
        email: null,
        picture: null,
        score: 0.9,
        reason: "same display name",
        ...suggestion,
      })),
    };
    return this;
  }

  /**
   * Excluded, by default on its own account.
   *
   * `on` names a different account for the inherited case — an exclusion made
   * on one account of a linked person, which every other account of that person
   * then carries without being the row that can undo it.
   */
  excludedAs(
    reason: ExclusionReason,
    on?: { source: IdentitySource; sourceKey: string },
  ): this {
    this.row = {
      ...this.row,
      exclusion: {
        source: on?.source ?? this.row.identity.source,
        sourceKey: on?.sourceKey ?? this.row.identity.sourceKey,
        reason,
        excludedBy: "user:default/admin",
        excludedAt: "2026-09-15T12:00:00.000Z",
      },
    };
    return this;
  }

  build(): IdentityRow {
    return this.row;
  }
}
