import type { SonarMetrics } from "@rios0rios0/backstage-plugin-code-health-common";
import {
  CHURN_LABELS,
  CONTRIBUTOR_SERIES,
  churnSeries,
  codingTimeSeries,
  commitSeries,
  hasMeasurement,
  hoursOf,
  identityLabels,
  pipelineSeries,
  pullRequestSeries,
  reviewSeries,
  scoreSeries,
  sonarCoverageSeries,
  sonarDefectSeries,
  ticketsResolvedSeries,
} from "../../../src/domain/entities/contributor_trend";
import {
  ContributorBuilder,
  WakaTimeBuilder,
} from "../../builders/contributor_builder";
import {
  anUnscoredTrendPoint,
  aTrendPoint,
} from "../../builders/contributor_trend_builder";

const sonar = (overrides: Partial<SonarMetrics> = {}): SonarMetrics => ({
  bugs: 4,
  codeSmells: 12,
  securityHotspots: 1,
  vulnerabilities: 2,
  coverage: 61.5,
  duplications: 3.2,
  technicalDebt: "1d 2h",
  technicalDebtMinutes: 600,
  qualityGateStatus: "OK",
  ...overrides,
});

const jiraMetrics = (issuesResolved: number) => ({
  window: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-08T00:00:00.000Z" },
  issuesCreated: 3,
  issuesResolved,
  interactions: { comments: 2, worklogEntries: 1, transitions: 4, truncatedIssues: 0 },
  storyPointsEstimated: null,
  storyPointsCompleted: null,
  cycleTime: null,
  leadTime: null,
  resolvedByType: { bug: 1, story: 1, task: 0, epic: 0, other: 0 },
  reopened: 0,
});

describe("contributor trend series", () => {
  it("should chart commits and merged pull requests as measured counts", () => {
    // given
    // A bucket somebody spent on holiday is a measured zero: the walk fetched
    // those days and found nothing in them.
    const points = [
      aTrendPoint(
        "2026-08-01",
        ContributorBuilder.create().withCommits(9).withPullRequests(4, 3).build(),
      ),
      aTrendPoint(
        "2026-08-08",
        ContributorBuilder.create().withCommits(0).withPullRequests(0, 0).build(),
      ),
    ];

    // when
    const series = commitSeries(points);

    // then
    expect(series.map((point) => point.day)).toEqual(["2026-08-01", "2026-08-08"]);
    expect(series[0].values[CONTRIBUTOR_SERIES.commits]).toBe(9);
    expect(series[0].values[CONTRIBUTOR_SERIES.pullRequestsMerged]).toBe(3);
    expect(series[1].values[CONTRIBUTOR_SERIES.commits]).toBe(0);
    expect(series[1].values[CONTRIBUTOR_SERIES.pullRequestsMerged]).toBe(0);
  });

  it("should chart pull requests opened against pull requests merged", () => {
    // given
    // Neither is a subset of the other: one opened in one bucket and merged in
    // the next counts in each.
    const points = [
      aTrendPoint(
        "2026-08-01",
        ContributorBuilder.create().withPullRequests(7, 2).build(),
      ),
    ];

    // when
    const series = pullRequestSeries(points);

    // then
    expect(series[0].values[CONTRIBUTOR_SERIES.pullRequestsOpened]).toBe(7);
    expect(series[0].values[CONTRIBUTOR_SERIES.pullRequestsMerged]).toBe(2);
  });

  it("should chart reviews given against reviews approved", () => {
    // given
    const points = [
      aTrendPoint(
        "2026-08-01",
        ContributorBuilder.create().withReviewsGiven(11).withReviewsApproved(6).build(),
      ),
    ];

    // when
    const series = reviewSeries(points);

    // then
    expect(series[0].values[CONTRIBUTOR_SERIES.reviewsGiven]).toBe(11);
    expect(series[0].values[CONTRIBUTOR_SERIES.reviewsApproved]).toBe(6);
  });

  it("should chart churn as net lines when the provider reported lines", () => {
    // given
    const points = [
      aTrendPoint("2026-08-01", ContributorBuilder.create().withLinesOfCode(320).build()),
    ];

    // when
    const series = churnSeries(points, "lines");

    // then
    expect(series[0].values[CONTRIBUTOR_SERIES.churn]).toBe(320);
  });

  it("should chart churn as changed files when that is all the provider reported", () => {
    // given
    // Azure DevOps exposes no line count anywhere in its REST API, so a fleet
    // measured there counts files or nothing at all.
    const points = [
      aTrendPoint("2026-08-01", ContributorBuilder.create().withFileChurn(58).build()),
    ];

    // when
    const series = churnSeries(points, "files");

    // then
    expect(series[0].values[CONTRIBUTOR_SERIES.churn]).toBe(58);
  });

  it("should chart no churn at all when the provider reported neither unit", () => {
    // given
    // An empty chart would read as somebody who deleted as much as they wrote;
    // the page says why there is nothing instead.
    const points = [
      aTrendPoint("2026-08-01", ContributorBuilder.create().withoutChurn().build()),
    ];

    // when
    const series = churnSeries(points, "none");

    // then
    expect(series).toEqual([]);
    expect(CHURN_LABELS.none).toBeNull();
    expect(CHURN_LABELS.lines).toBe("Net lines of code");
    expect(CHURN_LABELS.files).toBe("Files changed");
  });

  it("should chart the churn of a quiet bucket as a real zero", () => {
    // given
    // The unit comes from the whole window, so a fortnight spent reviewing is a
    // measured zero rather than a gap that would read as a collection failure.
    const points = [
      aTrendPoint("2026-08-01", ContributorBuilder.create().withLinesOfCode(0).build()),
    ];

    // when
    const series = churnSeries(points, "lines");

    // then
    expect(series[0].values[CONTRIBUTOR_SERIES.churn]).toBe(0);
  });

  it("should leave the pipeline rate unmeasured when no run reached a verdict", () => {
    // given
    // A run superseded by a newer push is neither a success nor a failure, and
    // a bucket of those has no rate — zero would read as a fortnight of red.
    const points = [
      aTrendPoint(
        "2026-08-01",
        ContributorBuilder.create()
          .withPipelineRuns({ runs: 3, succeeded: 0, failed: 0 })
          .build(),
      ),
      aTrendPoint(
        "2026-08-08",
        ContributorBuilder.create()
          .withPipelineRuns({ runs: 5, succeeded: 4, failed: 1 })
          .build(),
      ),
    ];

    // when
    const series = pipelineSeries(points);

    // then
    expect(series[0].values[CONTRIBUTOR_SERIES.pipelineSuccessRate]).toBeNull();
    expect(series[1].values[CONTRIBUTOR_SERIES.pipelineSuccessRate]).toBe(80);
  });

  it("should take each bucket's score from the wire rather than recomputing it", () => {
    // given
    // A bucket's score is read against the fleet's mean rate in that bucket,
    // which the browser never receives.
    const summary = ContributorBuilder.create().build();
    const points = [
      aTrendPoint("2026-08-01", summary),
      anUnscoredTrendPoint("2026-08-08", summary),
    ];

    // when
    const series = scoreSeries(points);

    // then
    expect(series[0].values[CONTRIBUTOR_SERIES.score]).toBe(points[0].score.value);
    expect(series[1].values[CONTRIBUTOR_SERIES.score]).toBeNull();
  });

  it("should leave Sonar unmeasured for a bucket no project measured", () => {
    // given
    // Zero bugs would claim a clean bill of health nobody issued.
    const points = [
      aTrendPoint(
        "2026-08-01",
        ContributorBuilder.create().withSonarMetrics(sonar()).build(),
      ),
      aTrendPoint("2026-08-08", ContributorBuilder.create().build()),
    ];

    // when
    const defects = sonarDefectSeries(points);
    const coverage = sonarCoverageSeries(points);

    // then
    expect(defects[0].values[CONTRIBUTOR_SERIES.bugs]).toBe(4);
    expect(defects[0].values[CONTRIBUTOR_SERIES.vulnerabilities]).toBe(2);
    expect(defects[1].values[CONTRIBUTOR_SERIES.bugs]).toBeNull();
    expect(defects[1].values[CONTRIBUTOR_SERIES.vulnerabilities]).toBeNull();
    expect(coverage[0].values[CONTRIBUTOR_SERIES.coverage]).toBe(61.5);
    expect(coverage[1].values[CONTRIBUTOR_SERIES.coverage]).toBeNull();
  });

  it("should report a measured zero when Sonar found no defect at all", () => {
    // given
    const points = [
      aTrendPoint(
        "2026-08-01",
        ContributorBuilder.create()
          .withSonarMetrics(sonar({ bugs: 0, vulnerabilities: 0 }))
          .build(),
      ),
    ];

    // when
    const defects = sonarDefectSeries(points);

    // then
    expect(defects[0].values[CONTRIBUTOR_SERIES.bugs]).toBe(0);
    expect(defects[0].values[CONTRIBUTOR_SERIES.vulnerabilities]).toBe(0);
  });

  it("should chart coding time in hours, and leave an unmeasured bucket empty", () => {
    // given
    // An editor that was offline reports no measurement rather than a zero.
    const points = [
      aTrendPoint(
        "2026-08-01",
        ContributorBuilder.create()
          .withWakaTimeMetrics(WakaTimeBuilder.create().withTotalSeconds(19_800).build())
          .build(),
      ),
      aTrendPoint("2026-08-08", ContributorBuilder.create().build()),
    ];

    // when
    const series = codingTimeSeries(points);

    // then
    expect(series[0].values[CONTRIBUTOR_SERIES.codingHours]).toBe(5.5);
    expect(series[1].values[CONTRIBUTOR_SERIES.codingHours]).toBeNull();
  });

  it("should round hours to the resolution a chart can show", () => {
    // given / when / then
    expect(hoursOf(0)).toBe(0);
    expect(hoursOf(3600)).toBe(1);
    expect(hoursOf(3660)).toBe(1);
    expect(hoursOf(5400)).toBe(1.5);
  });

  it("should leave tickets unmeasured for somebody with no Atlassian account", () => {
    // given
    // Nobody has linked their Jira identity yet, which is not the same as
    // somebody who closed nothing.
    const points = [
      aTrendPoint(
        "2026-08-01",
        ContributorBuilder.create().withJiraMetrics(jiraMetrics(6)).build(),
      ),
      aTrendPoint("2026-08-08", ContributorBuilder.create().build()),
    ];

    // when
    const series = ticketsResolvedSeries(points);

    // then
    expect(series[0].values[CONTRIBUTOR_SERIES.ticketsResolved]).toBe(6);
    expect(series[1].values[CONTRIBUTOR_SERIES.ticketsResolved]).toBeNull();
  });

  it("should report whether any bucket measured a series at all", () => {
    // given
    // A series nothing ever measured draws an empty grid under a legend, which
    // reads as a collapse to zero rather than as a source nobody asked.
    const measured = sonarDefectSeries([
      aTrendPoint(
        "2026-08-01",
        ContributorBuilder.create().withSonarMetrics(sonar()).build(),
      ),
    ]);
    const unmeasured = sonarDefectSeries([
      aTrendPoint("2026-08-01", ContributorBuilder.create().build()),
    ]);

    // when / then
    expect(hasMeasurement(measured, CONTRIBUTOR_SERIES.bugs)).toBe(true);
    expect(hasMeasurement(unmeasured, CONTRIBUTOR_SERIES.bugs)).toBe(false);
    // A key no series carries is unmeasured rather than a crash.
    expect(hasMeasurement(measured, "nothing-writes-this")).toBe(false);
    expect(hasMeasurement([], CONTRIBUTOR_SERIES.bugs)).toBe(false);
  });

  it("should name every account merged onto the row", () => {
    // given
    // A total nobody can trace back to its sources is a total nobody trusts.
    const summary = ContributorBuilder.create()
      .withIdentities([
        { source: "vcs", sourceKey: "jane@acme.com", displayName: "Jane" },
        { source: "wakatime", sourceKey: "jane", displayName: "jane" },
      ])
      .build();

    // when
    const labels = identityLabels(summary);

    // then
    expect(labels).toEqual(["vcs: jane@acme.com", "wakatime: jane"]);
  });
});
