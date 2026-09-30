import {
  apiCandidates,
  apiExposureBreakdown,
  complianceBreakdown,
  computeKpis,
  COVERAGE_TARGET,
  coverageBreakdown,
  coverageStats,
  documentationBreakdown,
  GAP_LIST_SIZE,
  lowestCoverageRepositories,
  qualityGateBreakdown,
  toCadence,
  topContributorsByCommits,
  topRepositoriesByCommits,
  topReviewers,
  undocumented,
  unpublishedDocumentation,
} from "../../../src/domain/entities/insights";
import { ContributorBuilder } from "../../builders/contributor_builder";
import { RepositoryBuilder } from "../../builders/repository_builder";

describe("topContributorsByCommits", () => {
  it("should rank contributors by commits, highest first", () => {
    // given
    const contributors = [
      ContributorBuilder.create().withKey("low").withCommits(3).build(),
      ContributorBuilder.create().withKey("high").withCommits(30).build(),
      ContributorBuilder.create().withKey("mid").withCommits(12).build(),
    ];

    // when
    const ranked = topContributorsByCommits(contributors);

    // then
    expect(ranked.map((item) => item.id)).toEqual(["high", "mid", "low"]);
  });

  it("should keep at most five contributors", () => {
    // given
    const contributors = Array.from({ length: 9 }, (_, index) =>
      ContributorBuilder.create().withKey(`c${index}`).withCommits(index + 1).build(),
    );

    // when
    const ranked = topContributorsByCommits(contributors);

    // then
    expect(ranked).toHaveLength(5);
    expect(ranked[0].id).toBe("c8");
  });

  it("should drop contributors with no commits", () => {
    // given
    // A "top 5" padded with zeroes reads as five active people when only one is.
    const contributors = [
      ContributorBuilder.create().withKey("active").withCommits(4).build(),
      ContributorBuilder.create().withKey("idle").withCommits(0).build(),
    ];

    // when
    const ranked = topContributorsByCommits(contributors);

    // then
    expect(ranked.map((item) => item.id)).toEqual(["active"]);
  });

  it("should carry the catalog entity and avatar through to the chart", () => {
    // given
    const contributors = [
      ContributorBuilder.create()
        .withKey("jane@example.com")
        .withCommits(7)
        .withEntityRef("user:default/jane.doe")
        .withAvatarUrl("https://example.test/jane.png")
        .build(),
    ];

    // when
    const [ranked] = topContributorsByCommits(contributors);

    // then
    expect(ranked.entityRef).toBe("user:default/jane.doe");
    expect(ranked.avatarUrl).toBe("https://example.test/jane.png");
  });

  it("should break a tie on the label so the order is stable", () => {
    // given
    const contributors = [
      ContributorBuilder.create().withKey("b").withDisplayName("Bob").withCommits(5).build(),
      ContributorBuilder.create().withKey("a").withDisplayName("Alice").withCommits(5).build(),
    ];

    // when
    const ranked = topContributorsByCommits(contributors);

    // then
    expect(ranked.map((item) => item.label)).toEqual(["Alice", "Bob"]);
  });
});

describe("topReviewers", () => {
  it("should rank by reviews given rather than commits", () => {
    // given
    // The two questions have different answers, which is the reason the chart exists.
    const contributors = [
      ContributorBuilder.create()
        .withKey("committer")
        .withCommits(50)
        .withReviewsGiven(1)
        .build(),
      ContributorBuilder.create()
        .withKey("reviewer")
        .withCommits(2)
        .withReviewsGiven(40)
        .build(),
    ];

    // when
    const ranked = topReviewers(contributors);

    // then
    expect(ranked.map((item) => item.id)).toEqual(["reviewer", "committer"]);
  });
});

describe("topRepositoriesByCommits", () => {
  it("should rank repositories by commits and link them to the catalog", () => {
    // given
    const repositories = [
      RepositoryBuilder.create()
        .withId("quiet")
        .withActivity({ commits: 1 })
        .build(),
      RepositoryBuilder.create()
        .withId("busy")
        .withEntityRef("component:default/busy")
        .withActivity({ commits: 40 })
        .build(),
    ];

    // when
    const ranked = topRepositoriesByCommits(repositories);

    // then
    expect(ranked.map((item) => item.id)).toEqual(["busy", "quiet"]);
    expect(ranked[0].entityRef).toBe("component:default/busy");
  });
});

describe("qualityGateBreakdown", () => {
  it("should count passing, failing and unmeasured repositories separately", () => {
    // given
    // "Not measured" is not a failure — folding the two together overstates the
    // problem and points the reader at the wrong fix.
    const repositories = [
      RepositoryBuilder.create().withId("a").withQualityGate("OK").build(),
      RepositoryBuilder.create().withId("b").withQualityGate("ERROR").build(),
      RepositoryBuilder.create().withId("c").build(),
    ];

    // when
    const slices = qualityGateBreakdown(repositories);

    // then
    expect(slices).toEqual([
      { label: "Passing", count: 1, tone: "good" },
      { label: "Failing", count: 1, tone: "critical" },
      { label: "Not measured", count: 1, tone: "unknown" },
    ]);
  });
});

describe("complianceBreakdown", () => {
  it("should map each compliance colour to its own tone", () => {
    // given
    const repositories = [
      RepositoryBuilder.create().withId("a").withComplianceColor("green").build(),
      RepositoryBuilder.create().withId("b").withComplianceColor("yellow").build(),
      RepositoryBuilder.create().withId("c").withComplianceColor("red").build(),
      RepositoryBuilder.create().withId("d").build(),
    ];

    // when
    const slices = complianceBreakdown(repositories);

    // then
    expect(slices.map((slice) => [slice.label, slice.count])).toEqual([
      ["Compliant", 1],
      ["One check missing", 1],
      ["Two or more missing", 1],
      ["Not measured", 1],
    ]);
  });
});

describe("computeKpis", () => {
  it("should count active repositories by commits rather than by tracking", () => {
    // given
    const repositories = [
      RepositoryBuilder.create().withId("a").withActivity({ commits: 5 }).build(),
      RepositoryBuilder.create().withId("b").withActivity({ commits: 0 }).build(),
    ];

    // when
    const kpis = computeKpis(repositories, []);

    // then
    expect(kpis.activeRepositories).toBe(1);
    expect(kpis.trackedRepositories).toBe(2);
  });

  it("should count each contributor once across repositories", () => {
    // given
    // Adding up `activity.contributors` per repository would count anyone who
    // worked in two of them twice.
    const repositories = [
      RepositoryBuilder.create()
        .withId("a")
        .withActivity({ commits: 3, contributors: 1 })
        .build(),
      RepositoryBuilder.create()
        .withId("b")
        .withActivity({ commits: 4, contributors: 1 })
        .build(),
    ];
    const contributors = [ContributorBuilder.create().withKey("one").withCommits(7).build()];

    // when
    const kpis = computeKpis(repositories, contributors);

    // then
    expect(kpis.activeContributors).toBe(1);
    expect(kpis.commits).toBe(7);
  });

  it("should report the build success rate across the fleet", () => {
    // given
    const repositories = [
      RepositoryBuilder.create()
        .withId("a")
        .withActivity({ builds: 8, buildsSucceeded: 6, buildsFailed: 2 })
        .build(),
      RepositoryBuilder.create()
        .withId("b")
        .withActivity({ builds: 2, buildsSucceeded: 2 })
        .build(),
    ];

    // when
    const kpis = computeKpis(repositories, []);

    // then
    expect(kpis.buildSuccessRate).toBe(80);
  });

  it("should leave cancelled and unfinished runs out of the build success rate", () => {
    // given
    // A run cancelled because a newer push superseded it is neither a success
    // nor a failure, and on a workflow that cancels in-progress runs it would
    // otherwise be most of the denominator.
    const repositories = [
      RepositoryBuilder.create()
        .withId("a")
        .withActivity({ builds: 10, buildsSucceeded: 3, buildsFailed: 1 })
        .build(),
    ];

    // when
    const kpis = computeKpis(repositories, []);

    // then
    expect(kpis.buildSuccessRate).toBe(75);
  });

  it("should report no build rate when no run reached a verdict", () => {
    // given
    const repositories = [
      RepositoryBuilder.create().withId("a").withActivity({ builds: 3 }).build(),
    ];

    // when
    const kpis = computeKpis(repositories, []);

    // then
    expect(kpis.buildSuccessRate).toBeNull();
  });

  it("should report no build rate when nothing ran", () => {
    // given
    const repositories = [RepositoryBuilder.create().withId("a").build()];

    // when
    const kpis = computeKpis(repositories, []);

    // then
    // Null rather than 0%: "nothing ran" and "everything failed" are different
    // situations and must not render the same.
    expect(kpis.buildSuccessRate).toBeNull();
  });

  it("should cap review coverage at one hundred percent", () => {
    // given
    // A pull request can collect several reviews, so the raw ratio runs past 100.
    const repositories = [
      RepositoryBuilder.create()
        .withId("a")
        .withActivity({ pullRequestsMerged: 2 })
        .build(),
    ];
    const contributors = [
      ContributorBuilder.create().withKey("a").withReviewsGiven(9).build(),
    ];

    // when
    const kpis = computeKpis(repositories, contributors);

    // then
    expect(kpis.reviewCoverage).toBe(100);
  });
});

describe("toCadence", () => {
  it("should flatten the backend buckets to the two plotted series", () => {
    // given
    const points = [
      {
        day: "2026-08-01",
        activity: {
          commits: 12,
          additions: 0,
          deletions: 0,
          changedFiles: 0,
          contributors: 3,
          pullRequestsOpened: 5,
          pullRequestsMerged: 4,
          pullRequestsAbandoned: 0,
          builds: 0,
          buildsSucceeded: 0,
          buildsFailed: 0,
          reviews: 0,
          releases: 0,
          tags: 0,
        },
      },
    ];

    // when
    const cadence = toCadence(points);

    // then
    expect(cadence).toEqual([{ day: "2026-08-01", commits: 12, pullRequestsMerged: 4 }]);
  });
});

describe("coverageStats", () => {
  it("should average only the repositories Sonar measured", () => {
    // given
    const repositories = [
      RepositoryBuilder.create().withCoverage(80).build(),
      RepositoryBuilder.create().withCoverage(40).build(),
      RepositoryBuilder.create().build(),
    ];

    // when
    const stats = coverageStats(repositories);

    // then
    // Folding the unmeasured one in as a zero would report 40% for a fleet
    // whose measured half averages 60%.
    expect(stats).toMatchObject({ measured: 2, tracked: 3, average: 60 });
  });

  it("should report a median the long tail cannot drag", () => {
    // given
    const repositories = [
      RepositoryBuilder.create().withCoverage(0).build(),
      RepositoryBuilder.create().withCoverage(0).build(),
      RepositoryBuilder.create().withCoverage(90).build(),
    ];

    // when
    const stats = coverageStats(repositories);

    // then
    expect(stats.median).toBe(0);
    expect(stats.average).toBe(30);
  });

  it("should average the middle pair of an even set", () => {
    // given
    const repositories = [
      RepositoryBuilder.create().withCoverage(20).build(),
      RepositoryBuilder.create().withCoverage(40).build(),
      RepositoryBuilder.create().withCoverage(60).build(),
      RepositoryBuilder.create().withCoverage(90).build(),
    ];

    // when
    const stats = coverageStats(repositories);

    // then
    expect(stats.median).toBe(50);
  });

  it("should count the repositories under the target", () => {
    // given
    const repositories = [
      RepositoryBuilder.create().withCoverage(COVERAGE_TARGET).build(),
      RepositoryBuilder.create().withCoverage(COVERAGE_TARGET - 0.1).build(),
    ];

    // when
    const stats = coverageStats(repositories);

    // then
    expect(stats.belowTarget).toBe(1);
  });

  it("should report nothing rather than zero with no measures at all", () => {
    // given
    const repositories = [RepositoryBuilder.create().build()];

    // when
    const stats = coverageStats(repositories);

    // then
    // A fleet with no Sonar projects is not a fleet with 0% coverage.
    expect(stats.average).toBeNull();
    expect(stats.median).toBeNull();
  });

  it("should average over the projects that report coverage, not the rest", () => {
    // given
    const repositories = [
      RepositoryBuilder.create().withCoverage(90).build(),
      RepositoryBuilder.create().withCoverage(60).build(),
      // measured by Sonar, but with nothing to cover
      RepositoryBuilder.create().withCoverage(null).build(),
    ];

    // when
    const stats = coverageStats(repositories);

    // then
    // 75, not (90 + 60 + 0) / 3
    expect(stats.average).toBe(75);
    expect(stats.median).toBe(75);
    // only the 60 sits under the target; a zero would have made it two
    expect(stats.belowTarget).toBe(1);
  });
});

describe("coverageBreakdown", () => {
  it("should split the fleet into bands rather than one average", () => {
    // given
    // An average of 62% is the same number whether every repository sits at 62%
    // or half sit at 95% and half at 30%.
    const repositories = [
      RepositoryBuilder.create().withCoverage(95).build(),
      RepositoryBuilder.create().withCoverage(65).build(),
      RepositoryBuilder.create().withCoverage(10).build(),
      RepositoryBuilder.create().build(),
    ];

    // when
    const slices = coverageBreakdown(repositories);

    // then
    expect(slices.map((slice) => slice.count)).toEqual([1, 1, 1, 1]);
    expect(slices.map((slice) => slice.tone)).toEqual([
      "good",
      "warning",
      "critical",
      "unknown",
    ]);
  });
});

describe("lowestCoverageRepositories", () => {
  it("should rank the measured repositories from the least covered up", () => {
    // given
    const repositories = [
      RepositoryBuilder.create().withName("high").withCoverage(90).build(),
      RepositoryBuilder.create().withName("low").withCoverage(10).build(),
      RepositoryBuilder.create().withName("mid").withCoverage(50).build(),
    ];

    // when
    const ranked = lowestCoverageRepositories(repositories);

    // then
    expect(ranked.map((item) => item.label)).toEqual(["low", "mid", "high"]);
  });

  it("should leave out repositories Sonar never measured", () => {
    // given
    const repositories = [
      RepositoryBuilder.create().withName("measured").withCoverage(30).build(),
      RepositoryBuilder.create().withName("unmeasured").build(),
    ];

    // when
    const ranked = lowestCoverageRepositories(repositories);

    // then
    // Sorting them in as zeroes would fill the chart with repositories that
    // have no Sonar project, which is a different problem with a different fix.
    expect(ranked.map((item) => item.label)).toEqual(["measured"]);
  });

  it("should leave out a project that reports no coverage", () => {
    // given
    // A Sonar project with no executable lines publishes no coverage measure,
    // which is unmeasured for the same reason no Sonar project at all is.
    const repositories = [
      RepositoryBuilder.create().withName("measured").withCoverage(30).build(),
      RepositoryBuilder.create().withName("terraform").withCoverage(null).build(),
    ];

    // when
    const ranked = lowestCoverageRepositories(repositories);

    // then
    expect(ranked.map((item) => item.label)).toEqual(["measured"]);
  });

  it("should say when a repository's gate is failing rather than repeat the bugs", () => {
    // given
    const repositories = [
      RepositoryBuilder.create().withName("failing").withCoverage(20, "ERROR").build(),
    ];

    // when
    const [ranked] = lowestCoverageRepositories(repositories);

    // then
    expect(ranked.detail).toBe("gate failing");
  });
});

describe("documentationBreakdown", () => {
  it("should keep unpublished docs apart from no docs at all", () => {
    // given
    // The two cost completely different amounts to fix: one annotation against
    // somebody sitting down to write.
    const repositories = [
      RepositoryBuilder.create().withDocumentationState("documented").build(),
      RepositoryBuilder.create().withDocumentationState("unpublished").build(),
      RepositoryBuilder.create().withDocumentationState("missing").build(),
      RepositoryBuilder.create().withDocumentationState("not-expected").build(),
      RepositoryBuilder.create().build(),
    ];

    // when
    const slices = documentationBreakdown(repositories);

    // then
    expect(slices.map((slice) => slice.count)).toEqual([1, 1, 1, 2]);
  });
});

describe("unpublishedDocumentation", () => {
  it("should list the repositories whose docs were never wired up", () => {
    // given
    const repositories = [
      RepositoryBuilder.create()
        .withName("gateway")
        .withDocumentationState("unpublished", { hasDocsSource: true })
        .build(),
      RepositoryBuilder.create().withName("other").withDocumentationState("documented").build(),
    ];

    // when
    const gaps = unpublishedDocumentation(repositories);

    // then
    expect(gaps.items.map((item) => item.label)).toEqual(["gateway"]);
    expect(gaps.items[0].reason).toBe("has a docs/ tree");
  });

  it("should say when the only evidence is an external link", () => {
    // given
    const repositories = [
      RepositoryBuilder.create()
        .withName("gateway")
        .withDocumentationState("unpublished", { hasDocsSource: false, hasExternalDocs: true })
        .build(),
    ];

    // when
    const gaps = unpublishedDocumentation(repositories);

    // then
    expect(gaps.items[0].reason).toBe("links out to documentation");
  });

  it("should count the rows it did not list", () => {
    // given
    const repositories = Array.from({ length: GAP_LIST_SIZE + 3 }, (_unused, index) =>
      RepositoryBuilder.create()
        .withName(`repo-${index}`)
        .withDocumentationState("unpublished", { hasDocsSource: true })
        .build(),
    );

    // when
    const gaps = unpublishedDocumentation(repositories);

    // then
    // A truncated list that says nothing reads as a complete one.
    expect(gaps.items).toHaveLength(GAP_LIST_SIZE);
    expect(gaps.remaining).toBe(3);
  });
});

describe("undocumented", () => {
  it("should distinguish a README-only repository from an empty one", () => {
    // given
    const repositories = [
      RepositoryBuilder.create()
        .withName("readme-only")
        .withDocumentationState("missing", { hasReadme: true })
        .build(),
      RepositoryBuilder.create().withName("empty").withDocumentationState("missing").build(),
    ];

    // when
    const gaps = undocumented(repositories);

    // then
    expect(gaps.items.map((item) => item.reason)).toEqual(["nothing found", "README only"]);
  });
});

describe("apiExposureBreakdown", () => {
  it("should separate a real finding from an inference", () => {
    // given
    const repositories = [
      RepositoryBuilder.create().withApiExposureState("declared").build(),
      RepositoryBuilder.create().withApiExposureState("candidate", "openapi.yaml").build(),
      RepositoryBuilder.create().withApiExposureState("expected").build(),
      RepositoryBuilder.create().withApiExposureState("none").build(),
    ];

    // when
    const slices = apiExposureBreakdown(repositories);

    // then
    expect(slices.map((slice) => slice.count)).toEqual([1, 1, 1, 1]);
    expect(slices[1].tone).toBe("critical");
    expect(slices[2].tone).toBe("warning");
  });
});

describe("apiCandidates", () => {
  it("should put repositories shipping a definition ahead of the inferred ones", () => {
    // given
    const repositories = [
      RepositoryBuilder.create().withName("inferred").withApiExposureState("expected").build(),
      RepositoryBuilder.create()
        .withName("evidenced")
        .withApiExposureState("candidate", "api/openapi.yaml")
        .build(),
    ];

    // when
    const gaps = apiCandidates(repositories);

    // then
    // The evidence is in the repository, so the finding is a fact rather than
    // an inference from `spec.type`.
    expect(gaps.items.map((item) => item.label)).toEqual(["evidenced", "inferred"]);
    expect(gaps.items.map((item) => item.reason)).toEqual([
      "api/openapi.yaml",
      "typed as a service",
    ]);
  });

  it("should still list a candidate whose definition path went missing", () => {
    // given
    const repositories = [
      RepositoryBuilder.create().withName("gateway").withApiExposureState("candidate").build(),
    ];

    // when
    const gaps = apiCandidates(repositories);

    // then
    expect(gaps.items[0].reason).toBe("ships a definition");
  });
});
