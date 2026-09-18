import { renderInTestApp } from "@backstage/test-utils";
import type { OwnershipInfo } from "@rios0rios0/backstage-plugin-code-health-common";
import { fireEvent, screen, within } from "@testing-library/react";
import { OwnedRepositoriesCard } from "../../../src/presentation/components/owned_repositories_card";
import { rootRouteRef } from "../../../src/routes";
import { RepositoryBuilder } from "../../builders/repository_builder";

const LINKED: OwnershipInfo = {
  entityRef: "user:default/jane",
  owners: ["user:default/jane", "group:default/platform"],
};

const UNLINKED: OwnershipInfo = { entityRef: null, owners: [] };

/** A repository failing everything a snapshot can measure. */
const unhealthy = RepositoryBuilder.create()
  .withName("legacy-gateway")
  .withCoverage(4, "ERROR")
  .withCiStatus("FAILURE")
  .withComplianceColor("red")
  .withDocumentationState("missing")
  .build();

/** One passing everything, so the sort has two ends to put in order. */
const healthy = RepositoryBuilder.create()
  .withName("billing")
  .withCoverage(94, "OK")
  .withCiStatus("SUCCESS")
  .withComplianceColor("green")
  .withDocumentationState("documented")
  .build();

/** Two nothing has measured yet: unknown health, not bad health. */
const unmeasured = RepositoryBuilder.create().withName("brand-new").build();
const alsoUnmeasured = RepositoryBuilder.create().withName("just-added").build();

const renderCard = (
  props: Partial<React.ComponentProps<typeof OwnedRepositoriesCard>> = {},
) =>
  renderInTestApp(
    <OwnedRepositoriesCard
      ownership={LINKED}
      repositories={[]}
      isLoading={false}
      error={null}
      {...props}
    />,
    { mountedRoutes: { "/": rootRouteRef } },
  );

/** The repository names in the order the body shows them. */
const namesInOrder = (): string[] =>
  within(screen.getByRole("table", { name: "Owned repositories" }))
    .getAllByTitle("Open the repository's page")
    .map((link) => link.textContent ?? "");

describe("OwnedRepositoriesCard", () => {
  it("should list the worst repository first, with the unmeasured after it", async () => {
    // given
    // The reason to open somebody's page is to find what needs attention, and a
    // list that leads with the healthiest buries it. A repository nothing has
    // measured is a different problem, not the worst one.
    await renderCard({
      repositories: [healthy, unmeasured, unhealthy, alsoUnmeasured],
    });

    // when
    const names = namesInOrder();

    // then
    expect(names.slice(0, 2)).toEqual(["legacy-gateway", "billing"]);
    expect(names.slice(2).sort()).toEqual(["brand-new", "just-added"]);
  });

  it("should keep the unmeasured last when the health column is turned around", async () => {
    // given
    // Best first is a reading too, and a repository nothing has measured is
    // not the best one either.
    await renderCard({
      repositories: [healthy, unmeasured, unhealthy],
    });

    // when
    fireEvent.click(screen.getByText("Health"));

    // then
    expect(namesInOrder()).toEqual(["billing", "legacy-gateway", "brand-new"]);
  });

  it("should sort on any column, like the tables", async () => {
    // given
    await renderCard({ repositories: [unhealthy, healthy] });

    // when
    fireEvent.click(screen.getByText("Repository"));

    // then
    expect(namesInOrder()).toEqual(["billing", "legacy-gateway"]);

    // when
    fireEvent.click(screen.getByText("Repository"));

    // then
    expect(namesInOrder()).toEqual(["legacy-gateway", "billing"]);
  });

  it("should sort a numeric column with the unmeasured after the measured", async () => {
    // given
    // A numeric column opens on its highest figure, like the tables' do, and
    // the repository nothing has measured sits after the measured either way.
    const covered = RepositoryBuilder.create().withName("covered").withCoverage(60).build();

    // when
    await renderCard({ repositories: [unmeasured, covered, healthy] });
    fireEvent.click(screen.getByText("Coverage"));

    // then
    expect(namesInOrder()).toEqual(["billing", "covered", "brand-new"]);

    // when
    fireEvent.click(screen.getByText("Coverage"));

    // then
    expect(namesInOrder()).toEqual(["covered", "billing", "brand-new"]);
  });

  it("should filter by name and by the status columns", async () => {
    // given
    await renderCard({ repositories: [healthy, unhealthy, unmeasured] });

    // when
    fireEvent.change(screen.getByLabelText("Filter name"), { target: { value: "gate" } });

    // then
    expect(namesInOrder()).toEqual(["legacy-gateway"]);
    expect(screen.getByText("1 of 3 repositories")).toBeInTheDocument();

    // when
    fireEvent.change(screen.getByLabelText("Filter name"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Filter ci"), { target: { value: "passing" } });

    // then
    expect(namesInOrder()).toEqual(["billing"]);
  });

  it.each([
    ["ci", ["All", "Passing", "Failing", "No run yet", "No pipeline defined"]],
    ["compliance", ["All", "Non-compliant", "Partial", "Compliant", "Not measured"]],
    [
      "documentation",
      ["All", "TechDocs", "Unpublished", "None", "Archived", "Not measured"],
    ],
    ["qualityGate", ["All", "Passed", "Failed", "No Sonar project"]],
  ])("should word the %s filter exactly as the repositories table does", async (columnId, expected) => {
    // given
    // The card and the repositories table render the same facts through the
    // same `DataTable`, so a reader who filters Compliance by "Non-compliant"
    // on the tab and clicks into a person has to find that same word here.
    // Both read one list in `columns/filter_options.ts`; this is what catches a
    // future edit to one of them.
    await renderCard({ repositories: [healthy] });

    // when
    const options = within(screen.getByLabelText(`Filter ${columnId}`)).getAllByRole("option");

    // then
    expect(options.map((option) => option.textContent)).toEqual(expected);
  });

  it("should keep only the repositories with no pipeline at all", async () => {
    // given
    // The card gained this filter with the table, rather than staying on the
    // four values it had while the table moved to five.
    const noPipeline = RepositoryBuilder.create()
      .withName("undefined-ci")
      .withComplianceStatus({
        pipelineExists: false,
        buildPolicyOnPRs: false,
        buildPolicyExpiration: false,
        branchProtection: true,
        color: "red",
      })
      .build();
    await renderCard({ repositories: [noPipeline, healthy, unmeasured] });

    // when
    fireEvent.change(screen.getByLabelText("Filter ci"), { target: { value: "no-pipeline" } });

    // then
    expect(namesInOrder()).toEqual(["undefined-ci"]);
  });

  it("should page ten at a time, so the charts below stay on the screen", async () => {
    // given
    const many = Array.from({ length: 12 }, (_, index) =>
      RepositoryBuilder.create()
        .withName(`repo-${String(index).padStart(2, "0")}`)
        .withCoverage(index)
        .build(),
    );

    // when
    await renderCard({ repositories: many });

    // then
    expect(namesInOrder()).toHaveLength(10);
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    expect(screen.getByLabelText("Rows per page")).toHaveValue("10");

    // when
    fireEvent.click(screen.getByText("Next"));

    // then
    expect(namesInOrder()).toHaveLength(2);
  });

  it("should link each repository to its own page", async () => {
    // given / when
    await renderCard({ repositories: [healthy] });

    // then
    expect(screen.getByRole("link", { name: "billing" })).toHaveAttribute(
      "href",
      `/repositories/${healthy.id}`,
    );
  });

  it("should band the health score and show the workings behind it", async () => {
    // given
    // A bare score is a number nobody can act on; the components say which
    // figure pulled it down.
    await renderCard({ repositories: [unhealthy] });

    // when
    const score = screen.getByLabelText(/^Health \d+ out of 100/u);

    // then
    expect(score).toHaveAttribute("data-band", "poor");
    expect(score.closest("[title]")?.getAttribute("title")).toContain("Quality gate");
  });

  it("should show a dash rather than a zero for a repository nothing has measured", async () => {
    // given
    // Grading an unmeasured repository zero would report a failure nobody found.
    await renderCard({ repositories: [unmeasured] });

    // then
    expect(screen.getByLabelText("Health — out of 100, Not measured")).toBeInTheDocument();
  });

  it("should carry the badges the repositories table uses", async () => {
    // given / when
    await renderCard({ repositories: [healthy] });

    // then
    // Scoped to the body: the filter selects now carry the same words their
    // cells do, deliberately, so a document-wide query matches both.
    const body = within(screen.getByTestId("tableBody"));
    expect(body.getByText("Passed")).toBeInTheDocument();
    expect(body.getByText("Passing")).toBeInTheDocument();
    expect(body.getByText("Compliant")).toBeInTheDocument();
    expect(body.getByText("TechDocs")).toBeInTheDocument();
    expect(body.getByText("94.0%")).toBeInTheDocument();
  });

  it("should point an unlinked account at the Identities tab", async () => {
    // given
    // An account nobody has linked has no catalog entity, so there is nobody
    // for a repository to name as its owner — a different problem from owning
    // nothing.
    await renderCard({ ownership: UNLINKED });

    // then
    expect(screen.getByText(/not linked to a catalog user/u)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Identities tab" })).toHaveAttribute(
      "href",
      "/identities",
    );
  });

  it("should say what a linked person was matched against when they own nothing", async () => {
    // given
    // Ownership is matched against their user and every group they belong to,
    // and naming those is what turns "owns nothing" into something checkable.
    await renderCard({ ownership: LINKED, repositories: [] });

    // then
    expect(screen.getByText(/No catalog entity names/u)).toBeInTheDocument();
    expect(
      screen.getByText("Matched against: user:default/jane, group:default/platform."),
    ).toBeInTheDocument();
  });

  it("should not invent a match list for a person whose groups nobody resolved", async () => {
    // given
    // The catalog answered with the person and no groups at all, which is a
    // sentence with nothing to append to it.
    await renderCard({ ownership: { entityRef: "user:default/jane", owners: [] } });

    // then
    expect(screen.getByText(/No catalog entity names/u)).toBeInTheDocument();
    expect(screen.queryByText(/Matched against/u)).not.toBeInTheDocument();
  });

  it("should show progress until the first answer lands", async () => {
    // given / when
    await renderCard({ ownership: null, isLoading: true });

    // then
    expect(screen.getByTestId("progress")).toBeInTheDocument();
  });

  it("should report a failure rather than an empty list", async () => {
    // given
    // "Nobody owns anything" and "the request failed" are different sentences.
    await renderCard({ ownership: null, error: "catalog is down" });

    // then
    expect(
      screen.getByText(/Failed to load the owned repositories/u),
    ).toBeInTheDocument();
  });

  it("should render nothing while it has neither an answer nor a request in flight", async () => {
    // given
    // The page mounts the card before the key is known to the hook.
    await renderCard({ ownership: null, isLoading: false });

    // then
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByTestId("progress")).not.toBeInTheDocument();
  });
});
