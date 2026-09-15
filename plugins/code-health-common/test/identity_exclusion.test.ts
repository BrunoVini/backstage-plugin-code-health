import {
  EXCLUSION_REASON_DESCRIPTIONS,
  EXCLUSION_REASON_LABELS,
  EXCLUSION_REASONS,
  isExclusionReason,
} from "../src/identity_exclusion";

describe("EXCLUSION_REASONS", () => {
  it("should name the four kinds of row that is not a person being measured", () => {
    // given / when
    const reasons = EXCLUSION_REASONS;

    // then
    // Each answers a different question about the row: whether the human left,
    // whether they were ever in the organisation, whether there is a human at
    // all, and whether the platform itself is acting.
    expect(reasons).toEqual([
      "former-contributor",
      "open-source-contributor",
      "automated-bot",
      "service-account",
    ]);
  });

  it("should carry a label and a description for every reason", () => {
    // given / when
    const missing = EXCLUSION_REASONS.filter(
      (reason) =>
        EXCLUSION_REASON_LABELS[reason] === undefined ||
        EXCLUSION_REASON_DESCRIPTIONS[reason] === undefined,
    );

    // then
    // The menu is built from the list, so a reason without wording would render
    // as an empty row somebody could still click.
    expect(missing).toEqual([]);
  });
});

describe("isExclusionReason", () => {
  it("should accept every reason the contract names", () => {
    // given / when
    const accepted = EXCLUSION_REASONS.every(isExclusionReason);

    // then
    expect(accepted).toBe(true);
  });

  it("should refuse anything else", () => {
    // given
    // The route validates with this, and a free-text reason would defeat the
    // point of recording one at all.
    const candidates = ["", "left", "bot", 4, null, undefined, {}];

    // when
    const accepted = candidates.filter(isExclusionReason);

    // then
    expect(accepted).toEqual([]);
  });
});
