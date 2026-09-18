import { renderInTestApp } from "@backstage/test-utils";
import { fireEvent, screen, within } from "@testing-library/react";
import type { ComplianceStatus, RepositorySummary } from "@rios0rios0/backstage-plugin-code-health-common";
import { RepositoryTable } from "../../../src/presentation/components/repository_table";
import { rootRouteRef } from "../../../src/routes";
import { RepositoryBuilder } from "../../builders/repository_builder";

const render = (ui: React.ReactElement) =>
  renderInTestApp(ui, { mountedRoutes: { "/": rootRouteRef } });

const renderTable = (repositories: RepositorySummary[], expectedDefaultBranch?: string) =>
  render(
    <RepositoryTable
      repositories={repositories}
      totalCount={repositories.length}
      isLoading={false}
      expectedDefaultBranch={expectedDefaultBranch}
    />,
  );

/** The name is the first cell; the owner and health columns follow it. */
const NAME_COLUMN = 0;

const visibleRepositoryNames = (): string[] =>
  screen
    .getAllByRole("row")
    .slice(2)
    .map((row) => within(row).getAllByRole("cell")[NAME_COLUMN].textContent ?? "");

const auditChip = (label: string): HTMLElement =>
  screen.getByRole("button", { name: new RegExp(`^${label}`, "u") });

const clickAudit = (label: string) => fireEvent.click(auditChip(label));

const selectFilter = (columnId: string, value: string) =>
  fireEvent.change(screen.getByLabelText(`Filter ${columnId}`), { target: { value } });

const compliance = (overrides: Partial<ComplianceStatus>): ComplianceStatus => ({
  pipelineExists: true,
  buildPolicyOnPRs: true,
  buildPolicyExpiration: true,
  branchProtection: true,
  color: "green",
  ...overrides,
});

describe("RepositoryTable audit chips", () => {
  it("should narrow to the repositories nobody owns", async () => {
    // given
    // The gap the table could not express at all: the Owner column filters on a
    // substring of a name, and an unowned row's name is the empty string.
    await renderTable([
      RepositoryBuilder.create().withName("orphan").withOwner(null).build(),
      RepositoryBuilder.create().withName("owned").withOwner("group:default/platform").build(),
    ]);

    // when
    clickAudit("No owner");

    // then
    expect(visibleRepositoryNames()).toEqual(["user/orphan"]);
  });

  it("should count what each audit matches before anything is clicked", async () => {
    // given
    // The count is the point of the control: it says whether there is anything
    // to do without the reader having to click to find out.
    await renderTable([
      RepositoryBuilder.create().withName("orphan-one").withOwner(null).build(),
      RepositoryBuilder.create().withName("orphan-two").withOwner(null).build(),
      RepositoryBuilder.create().withName("owned").withOwner("group:default/platform").build(),
    ]);

    // when / then
    expect(auditChip("No owner")).toHaveTextContent("No owner 2");
  });

  it("should draw a chip nothing matches, and refuse to select it", async () => {
    // given
    // A zero is a statement about the fleet worth having on screen, and
    // selecting it could only ever empty the table.
    await renderTable([
      RepositoryBuilder.create().withName("owned").withOwner("group:default/platform").build(),
    ]);

    // when / then
    expect(auditChip("No owner")).toHaveTextContent("No owner 0");
    expect(auditChip("No owner")).toHaveAttribute("aria-pressed", "false");
    expect(auditChip("No owner")).toHaveClass("Mui-disabled");
  });

  it("should narrow to the repositories with no pipeline at all", async () => {
    // given
    // Not the same question as "nothing has run": the second row has a pipeline
    // whose runs the snapshot never saw, and it is not a gap anybody can close.
    await renderTable([
      RepositoryBuilder.create()
        .withName("no-pipeline")
        .withComplianceStatus(compliance({ pipelineExists: false, color: "red" }))
        .build(),
      RepositoryBuilder.create()
        .withName("never-ran")
        .withComplianceStatus(compliance({}))
        .build(),
    ]);

    // when
    clickAudit("No pipeline");

    // then
    expect(visibleRepositoryNames()).toEqual(["user/no-pipeline"]);
  });

  it("should narrow to the repositories whose default branch is not the expected one", async () => {
    // given
    await renderTable([
      { ...RepositoryBuilder.create().withName("legacy").build(), defaultBranch: "master" },
      RepositoryBuilder.create().withName("modern").build(),
    ]);

    // when
    clickAudit("Non-standard branch");

    // then
    expect(visibleRepositoryNames()).toEqual(["user/legacy"]);
  });

  it("should measure the branch against the configured expectation", async () => {
    // given
    // A fleet on `trunk` had every row flagged, which is an audit nobody reads.
    await renderTable(
      [
        { ...RepositoryBuilder.create().withName("on-trunk").build(), defaultBranch: "trunk" },
        RepositoryBuilder.create().withName("on-main").build(),
      ],
      "trunk",
    );

    // when
    clickAudit("Non-standard branch");

    // then
    expect(visibleRepositoryNames()).toEqual(["user/on-main"]);
  });

  it("should take amber and red together under one chip", async () => {
    // given
    await renderTable([
      RepositoryBuilder.create().withName("partial").withComplianceColor("yellow").build(),
      RepositoryBuilder.create().withName("failing").withComplianceColor("red").build(),
      RepositoryBuilder.create().withName("compliant").withComplianceColor("green").build(),
    ]);

    // when
    clickAudit("Non-compliant");

    // then
    expect(visibleRepositoryNames().sort()).toEqual(["user/failing", "user/partial"]);
  });

  it("should narrow to the repositories matching every selected audit", async () => {
    // given
    await renderTable([
      RepositoryBuilder.create()
        .withName("both")
        .withOwner(null)
        .withComplianceColor("red")
        .build(),
      RepositoryBuilder.create().withName("owner-only").withOwner(null).build(),
      RepositoryBuilder.create()
        .withName("compliance-only")
        .withOwner("group:default/platform")
        .withComplianceColor("red")
        .build(),
    ]);

    // when
    clickAudit("No owner");
    clickAudit("Non-compliant");

    // then
    expect(visibleRepositoryNames()).toEqual(["user/both"]);
  });

  it("should undo an audit when its chip is clicked again", async () => {
    // given
    await renderTable([
      RepositoryBuilder.create().withName("orphan").withOwner(null).build(),
      RepositoryBuilder.create().withName("owned").withOwner("group:default/platform").build(),
    ]);
    clickAudit("No owner");
    expect(auditChip("No owner")).toHaveAttribute("aria-pressed", "true");

    // when
    clickAudit("No owner");

    // then
    expect(auditChip("No owner")).toHaveAttribute("aria-pressed", "false");
    expect(visibleRepositoryNames()).toHaveLength(2);
  });

  it("should drop every audit at once when they are cleared", async () => {
    // given
    await renderTable([
      RepositoryBuilder.create().withName("orphan").withOwner(null).build(),
      RepositoryBuilder.create().withName("owned").withOwner("group:default/platform").build(),
    ]);
    clickAudit("No owner");

    // when
    fireEvent.click(screen.getByText("Clear audits"));

    // then
    expect(visibleRepositoryNames()).toHaveLength(2);
    expect(screen.queryByText("Clear audits")).not.toBeInTheDocument();
  });

  it("should offer nothing to clear until an audit is selected", async () => {
    // given / when
    await renderTable([RepositoryBuilder.create().withName("owned").withOwner("g:d/p").build()]);

    // then
    expect(screen.queryByText("Clear audits")).not.toBeInTheDocument();
  });

  it("should report the narrowed count against the fleet total", async () => {
    // given
    await renderTable([
      RepositoryBuilder.create().withName("orphan").withOwner(null).build(),
      RepositoryBuilder.create().withName("owned").withOwner("group:default/platform").build(),
    ]);

    // when
    clickAudit("No owner");

    // then
    expect(screen.getByText("1 of 2 repositories")).toBeInTheDocument();
  });

  it("should send the reader back to the first page when an audit narrows the table", async () => {
    // given
    // The audits change the table's data rather than TanStack's own filter
    // state, so nothing resets the page index for them — a reader on page two
    // would otherwise be left looking at an empty table.
    const many = Array.from({ length: 30 }, (_, index) =>
      RepositoryBuilder.create()
        .withName(`repo-${String(index).padStart(2, "0")}`)
        .withOwner(index === 0 ? null : "group:default/platform")
        .build(),
    );
    await renderTable(many);
    fireEvent.click(screen.getByText("Next"));
    expect(screen.getByText("2 / 2")).toBeInTheDocument();

    // when
    clickAudit("No owner");

    // then
    expect(screen.getByText("1 / 1")).toBeInTheDocument();
    expect(visibleRepositoryNames()).toEqual(["user/repo-00"]);
  });

  it("should not count a hidden archived repository as a gap", async () => {
    // given
    // The archived toggle runs first, so a repository the screen is not showing
    // is not reported as work outstanding on it.
    await renderTable([
      RepositoryBuilder.create().withName("retired").withOwner(null).asArchived().build(),
      RepositoryBuilder.create().withName("live").withOwner("group:default/platform").build(),
    ]);

    // when / then
    expect(auditChip("No owner")).toHaveTextContent("No owner 0");
  });

  it("should count an archived repository once it is shown", async () => {
    // given
    await renderTable([
      RepositoryBuilder.create().withName("retired").withOwner(null).asArchived().build(),
      RepositoryBuilder.create().withName("live").withOwner("group:default/platform").build(),
    ]);

    // when
    fireEvent.click(screen.getByLabelText("Archived"));

    // then
    expect(auditChip("No owner")).toHaveTextContent("No owner 1");
  });

  it("should narrow with an audit and a column filter together", async () => {
    // given
    // Both narrow, which is why the audits intersect rather than union: two
    // controls on one table that disagreed about what picking more of them did
    // would be unpredictable.
    await renderTable([
      RepositoryBuilder.create().withName("orphan-go").withOwner(null).withLanguage("Go").build(),
      RepositoryBuilder.create().withName("orphan-ts").withOwner(null).withLanguage("TypeScript").build(),
    ]);

    // when
    clickAudit("No owner");
    selectFilter("primaryLanguage", "Go");

    // then
    expect(visibleRepositoryNames()).toEqual(["user/orphan-go"]);
  });
});

describe("RepositoryTable column filters the audits do not replace", () => {
  it("should offer the branches the fleet actually uses", async () => {
    // given
    // A text field could only find a branch the reader had already guessed at.
    await renderTable([
      { ...RepositoryBuilder.create().withName("legacy").build(), defaultBranch: "master" },
      { ...RepositoryBuilder.create().withName("odd").build(), defaultBranch: "develop" },
      RepositoryBuilder.create().withName("modern").build(),
    ]);

    // when
    const options = within(screen.getByLabelText("Filter defaultBranch")).getAllByRole("option");

    // then
    expect(options.map((option) => option.textContent)).toEqual([
      "All",
      "develop",
      "main",
      "master",
    ]);
  });

  it("should keep only the repositories defaulting to the branch that was picked", async () => {
    // given
    await renderTable([
      { ...RepositoryBuilder.create().withName("legacy").build(), defaultBranch: "master" },
      RepositoryBuilder.create().withName("modern").build(),
    ]);

    // when
    selectFilter("defaultBranch", "master");

    // then
    expect(visibleRepositoryNames()).toEqual(["user/legacy"]);
  });

  it("should keep every repository when the branch filter is cleared", async () => {
    // given
    await renderTable([
      { ...RepositoryBuilder.create().withName("legacy").build(), defaultBranch: "master" },
      RepositoryBuilder.create().withName("modern").build(),
    ]);
    selectFilter("defaultBranch", "master");

    // when
    selectFilter("defaultBranch", "");

    // then
    expect(visibleRepositoryNames()).toHaveLength(2);
  });

  it("should name the compliance options the way the badge beside them does", async () => {
    // given
    // The select used to offer `red` while the chip one cell away read
    // "Non-compliant", leaving the reader to pair them up.
    await renderTable([RepositoryBuilder.create().withName("any").build()]);

    // when
    const options = within(screen.getByLabelText("Filter compliance")).getAllByRole("option");

    // then
    expect(options.map((option) => option.textContent)).toEqual([
      "All",
      "Non-compliant",
      "Partial",
      "Compliant",
      "Not measured",
    ]);
  });

  it.each([
    ["documentation", ["All", "TechDocs", "Unpublished", "None", "Archived", "Not measured"]],
    ["apiExposure", ["All", "Declared", "Undeclared", "Likely", "None", "Not measured"]],
    ["badges", ["All", "Complete", "Incomplete", "Not measured"]],
    ["qualityGate", ["All", "Passed", "Failed", "No Sonar project"]],
  ])("should word the %s options as its own cells do", async (columnId, expected) => {
    // given
    // Every one of these is checked against the badge component's own label
    // map. A filter inventing a third vocabulary would be the same defect as
    // one showing the stored state name.
    await renderTable([RepositoryBuilder.create().withName("any").build()]);

    // when
    const options = within(screen.getByLabelText(`Filter ${columnId}`)).getAllByRole("option");

    // then
    expect(options.map((option) => option.textContent)).toEqual(expected);
  });

  it("should keep only the repositories nothing has measured for compliance", async () => {
    // given
    // These rows were unreachable: the accessor folded null to `none` all
    // along and no option offered it.
    await renderTable([
      RepositoryBuilder.create().withName("unchecked").build(),
      RepositoryBuilder.create().withName("checked").withComplianceColor("green").build(),
    ]);

    // when
    selectFilter("compliance", "none");

    // then
    expect(visibleRepositoryNames()).toEqual(["user/unchecked"]);
  });

  it("should keep only the repositories with no pipeline when the CI filter asks for it", async () => {
    // given
    // The precise fact, rather than "nothing has run" standing in for it.
    await renderTable([
      RepositoryBuilder.create()
        .withName("no-pipeline")
        .withComplianceStatus(compliance({ pipelineExists: false, color: "red" }))
        .build(),
      RepositoryBuilder.create().withName("never-ran").withComplianceStatus(compliance({})).build(),
      RepositoryBuilder.create().withName("unmeasured").build(),
    ]);

    // when
    selectFilter("ciStatus", "no-pipeline");

    // then
    expect(visibleRepositoryNames()).toEqual(["user/no-pipeline"]);
  });

  it("should keep only the repositories with no Sonar project", async () => {
    // given
    await renderTable([
      RepositoryBuilder.create().withName("unscanned").build(),
      RepositoryBuilder.create().withName("scanned").withQualityGate("OK").build(),
    ]);

    // when
    selectFilter("qualityGate", "NONE");

    // then
    expect(visibleRepositoryNames()).toEqual(["user/unscanned"]);
  });

  it("should keep only the repositories no snapshot has documented", async () => {
    // given
    await renderTable([
      RepositoryBuilder.create().withName("unmeasured").build(),
      RepositoryBuilder.create().withName("documented").withDocumentationState("documented").build(),
    ]);

    // when
    selectFilter("documentation", "unknown");

    // then
    expect(visibleRepositoryNames()).toEqual(["user/unmeasured"]);
  });

  it("should keep only the repositories no snapshot has graded for APIs", async () => {
    // given
    await renderTable([
      RepositoryBuilder.create().withName("unmeasured").build(),
      RepositoryBuilder.create().withName("declared").withApiExposureState("declared").build(),
    ]);

    // when
    selectFilter("apiExposure", "unknown");

    // then
    expect(visibleRepositoryNames()).toEqual(["user/unmeasured"]);
  });
});
