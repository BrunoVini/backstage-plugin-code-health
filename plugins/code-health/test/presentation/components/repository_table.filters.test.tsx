import { renderInTestApp } from "@backstage/test-utils";
import { fireEvent, screen, within } from "@testing-library/react";
import { RepositoryTable } from "../../../src/presentation/components/repository_table";
import type { BadgeStatus, ComplianceStatus } from "@rios0rios0/backstage-plugin-code-health-common";
import type { RepositorySummary } from "@rios0rios0/backstage-plugin-code-health-common";
import { rootRouteRef } from "../../../src/routes";
import { RepositoryBuilder } from "../../builders/repository_builder";

/**
 * The repository name resolves the plugin's own detail route with `useRouteRef`,
 * which throws outside an app that has that route mounted — so these render
 * through a test app rather than a bare router, which is also how the app itself
 * renders the table.
 */
const render = (ui: React.ReactElement) =>
  renderInTestApp(ui, { mountedRoutes: { "/": rootRouteRef } });

const daysAgo = (days: number): string =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

const compliance = (color: ComplianceStatus["color"]): ComplianceStatus => ({
  color,
  pipelineExists: true,
  buildPolicyOnPRs: true,
  buildPolicyExpiration: true,
  branchProtection: true,
});

const badges = (color: BadgeStatus["color"]): BadgeStatus => ({
  color,
  checks: [],
});

const renderTable = (repositories: RepositorySummary[]) =>
  render(
    <RepositoryTable
      repositories={repositories}
      totalCount={repositories.length}
      isLoading={false}
    />,
  );

const selectFilter = (columnId: string, value: string) =>
  fireEvent.change(screen.getByLabelText(`Filter ${columnId}`), { target: { value } });

/** The name is the first cell; the owner and health columns follow it. */
const NAME_COLUMN = 0;

/**
 * The table's own cells, without the filter row or the audit chips.
 *
 * Several filters carry the same words their column's cells do — "Passed"
 * because the gate badge says it — so a document-wide query matches both.
 */
const inBody = () => within(screen.getByTestId("tableBody"));

const visibleRepositoryNames = (): string[] =>
  screen
    .getAllByRole("row")
    .slice(2)
    .map((row) => within(row).getAllByRole("cell")[NAME_COLUMN].textContent ?? "");

describe("RepositoryTable column filters", () => {
  it("should keep only passing repositories when the CI filter is 'passing'", async () => {
    // given
    await renderTable([
      RepositoryBuilder.create().withName("green").withCiStatus("SUCCESS").build(),
      RepositoryBuilder.create().withName("red").withCiStatus("FAILURE").build(),
      RepositoryBuilder.create().withName("none").build(),
    ]);

    // when
    selectFilter("ciStatus", "passing");

    // then
    expect(visibleRepositoryNames().join()).toContain("green");
    expect(visibleRepositoryNames().join()).not.toContain("red");
  });

  it("should keep only broken repositories when the CI filter is 'failing'", async () => {
    // given
    await renderTable([
      RepositoryBuilder.create().withName("green").withCiStatus("SUCCESS").build(),
      RepositoryBuilder.create().withName("red").withCiStatus("FAILURE").build(),
      RepositoryBuilder.create().withName("none").build(),
    ]);

    // when
    selectFilter("ciStatus", "failing");

    // then
    const names = visibleRepositoryNames().join();
    expect(names).toContain("red");
    expect(names).not.toContain("green");
    expect(names).not.toContain("none");
  });

  it("should keep only repositories without CI when the CI filter is 'no-ci'", async () => {
    // given
    await renderTable([
      RepositoryBuilder.create().withName("green").withCiStatus("SUCCESS").build(),
      RepositoryBuilder.create().withName("none").build(),
    ]);

    // when
    selectFilter("ciStatus", "no-ci");

    // then
    const names = visibleRepositoryNames().join();
    expect(names).toContain("none");
    expect(names).not.toContain("green");
  });

  it("should keep every repository when the CI filter is cleared", async () => {
    // given
    // The select used to carry a literal `all` option beside the blank one the
    // filter row draws for every column, so it offered "All" and "all". The
    // blank is the only one now.
    await renderTable([
      RepositoryBuilder.create().withName("green").withCiStatus("SUCCESS").build(),
      RepositoryBuilder.create().withName("none").build(),
    ]);
    selectFilter("ciStatus", "passing");

    // when
    selectFilter("ciStatus", "");

    // then
    expect(visibleRepositoryNames()).toHaveLength(2);
  });

  it("should filter by compliance colour", async () => {
    // given
    await renderTable([
      RepositoryBuilder.create().withName("compliant").withComplianceStatus(compliance("green")).build(),
      RepositoryBuilder.create().withName("failing").withComplianceStatus(compliance("red")).build(),
      RepositoryBuilder.create().withName("unchecked").build(),
    ]);

    // when
    selectFilter("compliance", "green");

    // then
    expect(visibleRepositoryNames()).toHaveLength(1);
    expect(visibleRepositoryNames()[0]).toContain("compliant");
  });

  it("should filter by badge colour", async () => {
    // given
    await renderTable([
      RepositoryBuilder.create().withName("badged").withBadgeStatus(badges("green")).build(),
      RepositoryBuilder.create().withName("partial").withBadgeStatus(badges("yellow")).build(),
    ]);

    // when
    selectFilter("badges", "yellow");

    // then
    expect(visibleRepositoryNames()).toHaveLength(1);
    expect(visibleRepositoryNames()[0]).toContain("partial");
  });

  it("should filter by visibility", async () => {
    // given
    await renderTable([
      RepositoryBuilder.create().withName("open").build(),
      RepositoryBuilder.create().withName("closed").asPrivate().build(),
    ]);

    // when
    selectFilter("visibility", "PRIVATE");

    // then
    expect(visibleRepositoryNames()).toHaveLength(1);
    expect(visibleRepositoryNames()[0]).toContain("closed");
  });

  it("should filter by quality gate status", async () => {
    // given
    const withGate = (name: string, status: "OK" | "ERROR") => {
      const repo = RepositoryBuilder.create().withName(name).build();
      return {
        ...repo,
        sonarMetrics: {
          bugs: 0,
          codeSmells: 0,
          securityHotspots: 0,
          vulnerabilities: 0,
          coverage: 50,
          duplications: 1,
          technicalDebt: "1h",
          technicalDebtMinutes: 60,
          qualityGateStatus: status,
        },
      };
    };
    await renderTable([withGate("passing", "OK"), withGate("failing", "ERROR")]);

    // when
    selectFilter("qualityGate", "ERROR");

    // then
    expect(visibleRepositoryNames()).toHaveLength(1);
    expect(visibleRepositoryNames()[0]).toContain("failing");
  });

  it("should show every repository again when a select filter is cleared", async () => {
    // given
    await renderTable([
      RepositoryBuilder.create().withName("open").build(),
      RepositoryBuilder.create().withName("closed").asPrivate().build(),
    ]);
    selectFilter("visibility", "PRIVATE");

    // when
    selectFilter("visibility", "");

    // then
    expect(visibleRepositoryNames()).toHaveLength(2);
  });
});

describe("RepositoryTable relative dates", () => {
  it.each([
    [0, "today"],
    [1, "yesterday"],
    [5, "5d ago"],
    [70, "2mo ago"],
    [800, "2y ago"],
  ])("should render an update %s days old as %s", async (days, expected) => {
    // given / when
    await renderTable([
      RepositoryBuilder.create().withName("dated").withUpdatedAt(daysAgo(days)).build(),
    ]);

    // then
    expect(screen.getByText(expected)).toBeInTheDocument();
  });
});

describe("RepositoryTable quality gate cell", () => {
  it("should show nothing when Sonar reports no quality gate", async () => {
    // given / when
    await renderTable([RepositoryBuilder.create().withName("unmeasured").build()]);

    // then
    expect(inBody().queryByText("Passed")).not.toBeInTheDocument();
    expect(inBody().queryByText("Failed")).not.toBeInTheDocument();
  });
});

describe("RepositoryTable pagination", () => {
  const manyRepos = () =>
    Array.from({ length: 30 }, (_, index) =>
      RepositoryBuilder.create().withName(`repo-${String(index).padStart(2, "0")}`).build(),
    );

  it("should show only the first page when there are more rows than the page size", async () => {
    // given / when
    await renderTable(manyRepos());

    // then
    expect(visibleRepositoryNames()).toHaveLength(25);
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
  });

  it("should move to the next page and back again", async () => {
    // given
    await renderTable(manyRepos());

    // when
    fireEvent.click(screen.getByText("Next"));

    // then
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
    expect(visibleRepositoryNames()).toHaveLength(5);

    // when
    fireEvent.click(screen.getByText("Previous"));

    // then
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
  });

  it("should still offer the page size when everything fits on one page", async () => {
    // given
    // The controls used to appear only past the first page, which made
    // pagination look like something one table had and another did not, and
    // left nobody a way to ask for a shorter page.
    await renderTable([RepositoryBuilder.create().withName("only").build()]);

    // when / then
    expect(screen.getByLabelText("Rows per page")).toHaveValue("25");
    expect(screen.getByText("1 / 1")).toBeInTheDocument();
    expect(screen.getByText("Next").closest("button")).toBeDisabled();
    expect(screen.getByText("Previous").closest("button")).toBeDisabled();
  });

  it("should page by the size that was picked", async () => {
    // given
    await renderTable(manyRepos());

    // when
    fireEvent.change(screen.getByLabelText("Rows per page"), { target: { value: "10" } });

    // then
    expect(visibleRepositoryNames()).toHaveLength(10);
    expect(screen.getByText("1 / 3")).toBeInTheDocument();

    // when
    fireEvent.change(screen.getByLabelText("Rows per page"), { target: { value: "50" } });

    // then
    expect(visibleRepositoryNames()).toHaveLength(30);
    expect(screen.getByText("1 / 1")).toBeInTheDocument();
  });
});

describe("RepositoryTable documentation and API columns", () => {
  it("should keep only the repositories whose docs were never published", async () => {
    // given
    await renderTable([
      RepositoryBuilder.create()
        .withName("unpublished")
        .withDocumentationState("unpublished")
        .build(),
      RepositoryBuilder.create()
        .withName("published")
        .withDocumentationState("documented")
        .build(),
    ]);

    // when
    selectFilter("documentation", "unpublished");

    // then
    expect(visibleRepositoryNames()).toEqual(["user/unpublished"]);
  });

  it("should keep only the repositories that ship an undeclared API", async () => {
    // given
    // This is the flag: the definition is in the repository, so only the
    // catalog wiring is missing.
    await renderTable([
      RepositoryBuilder.create()
        .withName("undeclared")
        .withApiExposureState("candidate", "openapi.yaml")
        .build(),
      RepositoryBuilder.create().withName("declared").withApiExposureState("declared").build(),
    ]);

    // when
    selectFilter("apiExposure", "candidate");

    // then
    expect(visibleRepositoryNames()).toEqual(["user/undeclared"]);
  });

  it("should show everything when neither filter is set", async () => {
    // given
    await renderTable([
      RepositoryBuilder.create().withName("one").withDocumentationState("missing").build(),
      RepositoryBuilder.create().withName("two").build(),
    ]);

    // when
    selectFilter("documentation", "");
    selectFilter("apiExposure", "");

    // then
    expect(visibleRepositoryNames()).toHaveLength(2);
  });
});
