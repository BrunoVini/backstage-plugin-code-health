import type { RepositoryAuditContext, RepositoryAuditId } from "../../../src/domain/entities/repository_audit";
import {
  countAuditMatches,
  filterByAudits,
  REPOSITORY_AUDITS,
  repositoryAuditById,
} from "../../../src/domain/entities/repository_audit";
import { RepositoryBuilder } from "../../builders/repository_builder";

const context: RepositoryAuditContext = { expectedDefaultBranch: "main" };

/** The one repository nothing should ever flag. */
const healthy = () =>
  RepositoryBuilder.create()
    .withName("healthy")
    .withOwner("group:default/platform")
    .withComplianceColor("green")
    .build();

const names = (repositories: readonly { name: string }[]): string[] =>
  repositories.map((repository) => repository.name);

describe("REPOSITORY_AUDITS", () => {
  it("should describe every audit without repeating an id", () => {
    // given / when
    const ids = REPOSITORY_AUDITS.map((audit) => audit.id);

    // then
    expect(new Set(ids).size).toBe(ids.length);
    expect(REPOSITORY_AUDITS.every((audit) => audit.label.length > 0)).toBe(true);
    expect(REPOSITORY_AUDITS.every((audit) => audit.describe(context).length > 0)).toBe(true);
  });

  it("should name the configured branch in the branch audit's description", () => {
    // given
    const audit = repositoryAuditById("non-standard-branch");

    // when
    const description = audit?.describe({ expectedDefaultBranch: "trunk" });

    // then
    expect(description).toContain("`trunk`");
  });

  it("should not resolve an id no audit carries", () => {
    // given / when
    const audit = repositoryAuditById("retired" as RepositoryAuditId);

    // then
    expect(audit).toBeUndefined();
  });
});

describe("the unowned audit", () => {
  it("should match a repository whose entity declares no owner", () => {
    // given
    const repositories = [
      RepositoryBuilder.create().withName("orphan").withOwner(null).build(),
      healthy(),
    ];

    // when
    const result = filterByAudits(repositories, ["unowned"], context);

    // then
    expect(names(result)).toEqual(["orphan"]);
  });
});

describe("the pipeline audit", () => {
  it("should match a repository the provider reported no pipeline for", () => {
    // given
    const noPipeline = RepositoryBuilder.create()
      .withName("no-pipeline")
      .withComplianceStatus({
        pipelineExists: false,
        buildPolicyOnPRs: false,
        buildPolicyExpiration: false,
        branchProtection: true,
        color: "red",
      })
      .build();

    // when
    const result = filterByAudits([noPipeline, healthy()], ["no-pipeline"], context);

    // then
    expect(names(result)).toEqual(["no-pipeline"]);
  });

  it("should not match a repository nothing has measured yet", () => {
    // given
    // An unknown pipeline is not a missing one — that distinction is the whole
    // reason `unmeasured` is a separate audit.
    const unmeasured = RepositoryBuilder.create().withName("fresh").build();

    // when
    const result = filterByAudits([unmeasured], ["no-pipeline"], context);

    // then
    expect(result).toEqual([]);
  });
});

describe("the branch protection audit", () => {
  it("should match a repository nothing protects the default branch of", () => {
    // given
    const unprotected = RepositoryBuilder.create()
      .withName("unprotected")
      .withComplianceStatus({
        pipelineExists: true,
        buildPolicyOnPRs: true,
        buildPolicyExpiration: true,
        branchProtection: false,
        color: "yellow",
      })
      .build();

    // when
    const result = filterByAudits([unprotected, healthy()], ["no-branch-protection"], context);

    // then
    expect(names(result)).toEqual(["unprotected"]);
  });
});

describe("the non-standard branch audit", () => {
  it("should match a repository whose default branch is not the expected one", () => {
    // given
    const repositories = [
      { ...healthy(), name: "legacy", defaultBranch: "master" },
      healthy(),
    ];

    // when
    const result = filterByAudits(repositories, ["non-standard-branch"], context);

    // then
    expect(names(result)).toEqual(["legacy"]);
  });

  it("should not match a repository whose default branch was never measured", () => {
    // given
    // `defaultBranch` is typed `string`, but the backend folds an unknown one
    // into `""`: discovery does not learn a default branch, only ingestion
    // does, and `unsnapshotted` fills the gap. Without the guard a fresh
    // install reports its whole fleet as being on the wrong branch, on the very
    // rows "Never measured" is counting.
    const unmeasured = { ...RepositoryBuilder.create().withName("fresh").build(), defaultBranch: "" };

    // when
    const result = filterByAudits([unmeasured], ["non-standard-branch"], context);

    // then
    expect(result).toEqual([]);
  });

  it("should match against the configured branch rather than always against main", () => {
    // given
    // A fleet standardised on `trunk` has to be able to say so, or the column
    // flags every row and its warning stops meaning anything.
    const repositories = [
      { ...healthy(), name: "on-trunk", defaultBranch: "trunk" },
      { ...healthy(), name: "on-main", defaultBranch: "main" },
    ];

    // when
    const result = filterByAudits(repositories, ["non-standard-branch"], {
      expectedDefaultBranch: "trunk",
    });

    // then
    expect(names(result)).toEqual(["on-main"]);
  });
});

describe("the non-compliant audit", () => {
  it("should match both amber and red in one filter", () => {
    // given
    // This is the question the Compliance column's select could never ask.
    const repositories = [
      { ...RepositoryBuilder.create().withName("partial").withComplianceColor("yellow").build() },
      { ...RepositoryBuilder.create().withName("failing").withComplianceColor("red").build() },
      healthy(),
    ];

    // when
    const result = filterByAudits(repositories, ["non-compliant"], context);

    // then
    expect(names(result).sort()).toEqual(["failing", "partial"]);
  });

  it("should not match a repository nothing has measured yet", () => {
    // given
    const unmeasured = RepositoryBuilder.create().withName("fresh").build();

    // when
    const result = filterByAudits([unmeasured], ["non-compliant"], context);

    // then
    expect(result).toEqual([]);
  });
});

describe("the unmeasured audit", () => {
  it("should match a repository no snapshot has been taken of", () => {
    // given
    const repositories = [RepositoryBuilder.create().withName("fresh").build(), healthy()];

    // when
    const result = filterByAudits(repositories, ["unmeasured"], context);

    // then
    expect(names(result)).toEqual(["fresh"]);
  });
});

describe("filterByAudits", () => {
  it("should return every repository when nothing is selected", () => {
    // given
    const repositories = [RepositoryBuilder.create().withName("one").build(), healthy()];

    // when
    const result = filterByAudits(repositories, [], context);

    // then
    expect(names(result)).toEqual(["one", "healthy"]);
  });

  it("should narrow to the repositories matching every selected audit", () => {
    // given
    // Intersection, not union: each chip carries its own count, so the
    // populations are legible one at a time, and narrowing is what every other
    // filter on the table does.
    const bothGaps = RepositoryBuilder.create()
      .withName("both")
      .withOwner(null)
      .withComplianceColor("red")
      .build();
    const ownerOnly = RepositoryBuilder.create()
      .withName("owner-only")
      .withOwner(null)
      .withComplianceColor("green")
      .build();

    // when
    const result = filterByAudits(
      [bothGaps, ownerOnly, healthy()],
      ["unowned", "non-compliant"],
      context,
    );

    // then
    expect(names(result)).toEqual(["both"]);
  });

  it("should ignore an id no audit carries rather than throwing", () => {
    // given
    // A selection can outlive a release that removed an audit.
    const repositories = [RepositoryBuilder.create().withName("orphan").withOwner(null).build()];

    // when
    const result = filterByAudits(
      repositories,
      ["retired" as RepositoryAuditId, "unowned"],
      context,
    );

    // then
    expect(names(result)).toEqual(["orphan"]);
  });

  it("should apply no filter when every selected id is unknown", () => {
    // given
    const repositories = [healthy()];

    // when
    const result = filterByAudits(repositories, ["retired" as RepositoryAuditId], context);

    // then
    expect(names(result)).toEqual(["healthy"]);
  });
});

describe("countAuditMatches", () => {
  it("should count every audit, including the ones nothing matches", () => {
    // given
    // A zero is a statement about the fleet worth putting on screen, so every
    // audit is counted rather than only the ones with something to report.
    const repositories = [
      RepositoryBuilder.create().withName("orphan").withOwner(null).build(),
      RepositoryBuilder.create()
        .withName("also-orphan")
        .withOwner(null)
        .withComplianceColor("green")
        .build(),
      healthy(),
    ];

    // when
    const counts = countAuditMatches(repositories, context);

    // then
    expect(counts.get("unowned")).toBe(2);
    expect(counts.get("non-standard-branch")).toBe(0);
    expect(counts.size).toBe(REPOSITORY_AUDITS.length);
  });

  it("should count nothing for an empty fleet", () => {
    // given / when
    const counts = countAuditMatches([], context);

    // then
    expect([...counts.values()].every((count) => count === 0)).toBe(true);
  });
});
