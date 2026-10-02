import type { SonarMetrics } from "@rios0rios0/backstage-plugin-code-health-common";
import { render, screen } from "@testing-library/react";
import { CoverageCell } from "../../../src/presentation/components/coverage_cell";

const sonar = (overrides: Partial<SonarMetrics> = {}): SonarMetrics => ({
  bugs: 0,
  codeSmells: 0,
  securityHotspots: 0,
  vulnerabilities: 0,
  coverage: 80,
  duplications: 0,
  technicalDebt: "0min",
  technicalDebtMinutes: 0,
  qualityGateStatus: "OK",
  ...overrides,
});

const percent = (coverage: number) => `${coverage}%`;

describe("CoverageCell", () => {
  it("should render a measured coverage with the caller's format", () => {
    // given / when
    render(<CoverageCell sonar={sonar({ coverage: 31.4 })} format={(v) => `${v}%`} />);

    // then
    expect(screen.getByText("31.4%")).toBeInTheDocument();
  });

  it("should still render a genuine zero as a number", () => {
    // given
    // A project that measures nothing covered is not the same as one that
    // measures nothing at all, and only this one is a real zero.
    render(<CoverageCell sonar={sonar({ coverage: 0 })} format={percent} />);

    // then
    expect(screen.getByText("0%")).toBeInTheDocument();
    expect(screen.queryByText("not reported")).not.toBeInTheDocument();
  });

  it("should mark an analysed repository that reports no coverage", () => {
    // given / when
    render(<CoverageCell sonar={sonar({ coverage: null })} format={percent} />);

    // then
    expect(screen.getByText("not reported")).toBeInTheDocument();
    expect(
      screen.getByLabelText("No coverage is reported for this repository"),
    ).toBeInTheDocument();
  });

  it("should mark an average that covers only some of the repositories touched", () => {
    // given
    // The case a contributor row is usually in: one repository reports
    // coverage, another is analysed and reports none. `coverage` is null only
    // when *every* repository is unmeasurable, so without the scope this row
    // prints 80% and says nothing about the half it did not measure.
    const scope = { measured: 1, unreported: 1 };

    // when
    render(<CoverageCell sonar={sonar({ coverage: 80 })} format={percent} scope={scope} />);

    // then
    expect(screen.getByText("80%")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Averaged over 1 of 2 repositories; the rest report no coverage"),
    ).toBeInTheDocument();
  });

  it("should leave a fully measured average unmarked", () => {
    // given
    const scope = { measured: 3, unreported: 0 };

    // when
    render(<CoverageCell sonar={sonar({ coverage: 80 })} format={percent} scope={scope} />);

    // then
    expect(screen.getByText("80%")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Averaged over/)).not.toBeInTheDocument();
  });

  it("should leave a repository with no Sonar project as an empty cell", () => {
    // given / when
    render(<CoverageCell sonar={null} format={percent} />);

    // then
    // A dash, not the warning: there is no project to produce a report for.
    expect(screen.queryByText("not reported")).not.toBeInTheDocument();
    expect(screen.getByText("-")).toBeInTheDocument();
  });
});
