import { renderInTestApp } from "@backstage/test-utils";
import { screen, fireEvent, within } from "@testing-library/react";
import { RepositoryTable } from "../../../src/presentation/components/repository_table";
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

/**
 * The table's own cells, without the filter row or the audit chips.
 *
 * Both of those now carry the same words and numbers the cells do — the
 * Compliance filter says "Compliant" because the badge beside it does, the
 * branch filter lists `master` because a row defaults to it, and every audit
 * chip carries a count — so a document-wide text query matches more than one
 * node. An assertion about a cell has to say it means a cell.
 */
const inBody = () => within(screen.getByTestId("tableBody"));

describe("RepositoryTable", () => {
  it("should link the repository name to its page in the plugin", async () => {
    // given
    // The drill-down a reader clicking a row is asking for is the repository's
    // history, its health and the people on it — all of which live here rather
    // than in the catalog or at the provider.
    const repos = [
      RepositoryBuilder.create()
        .withId("abc123")
        .withFullName("user/my-repo")
        .withEntityRef("component:default/my-repo")
        .withUrl("https://dev.azure.com/org/project/_git/my-repo")
        .build(),
    ];

    // when
    await render(<RepositoryTable repositories={repos} totalCount={1} isLoading={false} />);

    // then
    const link = screen.getByText("user/my-repo").closest("a");
    expect(link).toHaveAttribute("href", "/repositories/abc123");
  });

  it("should escape the separators a repository id could carry, twice over", async () => {
    // given
    // Two encoders run in series: Backstage escapes the characters that would
    // re-split the path, and React Router's `generatePath` then escapes the
    // percent signs that produced. The result round-trips — `useParams` decodes
    // once and the route matches — but it is not the single encoding it looks
    // like, and pinning it here is what makes a change to either one visible.
    // Nothing exercises it today: an id is a SHA-256 prefix, all hexadecimal.
    const repos = [
      RepositoryBuilder.create().withId("group/one?x").withFullName("user/odd").build(),
    ];

    // when
    await render(<RepositoryTable repositories={repos} totalCount={1} isLoading={false} />);

    // then
    expect(screen.getByText("user/odd").closest("a")).toHaveAttribute(
      "href",
      "/repositories/group%252Fone%253Fx",
    );
  });

  it("should keep the catalog entity one click away, as a secondary link", async () => {
    // given
    // The catalog page is where the owner, docs and other entity tabs are, so
    // it stays reachable — as an icon, because following it leaves the plugin.
    const repos = [
      RepositoryBuilder.create()
        .withFullName("user/my-repo")
        .withEntityRef("component:default/my-repo")
        .build(),
    ];

    // when
    await render(<RepositoryTable repositories={repos} totalCount={1} isLoading={false} />);

    // then
    expect(
      screen.getByLabelText("Open user/my-repo in the catalog"),
    ).toHaveAttribute("href", "/catalog/default/component/my-repo");
  });

  it("should drop only the catalog link when the entity reference is unusable", async () => {
    // given
    // A malformed reference should cost this one row its catalog link, not throw
    // and take the whole table down with it — and the name still goes somewhere.
    const repos = [
      RepositoryBuilder.create()
        .withId("broken-id")
        .withFullName("user/broken")
        .withEntityRef("not-a-ref")
        .build(),
    ];

    // when
    await render(<RepositoryTable repositories={repos} totalCount={1} isLoading={false} />);

    // then
    expect(screen.getByText("user/broken").closest("a")).toHaveAttribute(
      "href",
      "/repositories/broken-id",
    );
    expect(screen.queryByLabelText(/in the catalog/)).not.toBeInTheDocument();
  });

  it("should name the owner and link it to the catalog entity that owns the row", async () => {
    // given
    // Who is responsible for a repository is a different question from who
    // committed to it, and it is the catalog's `spec.owner` that answers it.
    const repos = [
      RepositoryBuilder.create()
        .withName("gateway")
        .withOwner("group:default/platform")
        .build(),
    ];

    // when
    await render(<RepositoryTable repositories={repos} totalCount={1} isLoading={false} />);

    // then
    expect(screen.getByText("platform").closest("a")).toHaveAttribute(
      "href",
      "/catalog/default/group/platform",
    );
  });

  it("should show the owner's name and photograph rather than the slug", async () => {
    // given
    // A directory that names its users after their address turns this column
    // into a page of `j.doe_example.com`, which leaves a reader
    // translating every row back into a person by hand.
    const repos = [
      RepositoryBuilder.create()
        .withName("gateway")
        .withOwnerProfile(
          "user:default/e.silva_example.com",
          "Jane Doe",
          "https://example.com/jane.png",
        )
        .build(),
    ];

    // when
    await render(<RepositoryTable repositories={repos} totalCount={1} isLoading={false} />);

    // then
    expect(screen.getByText("Jane Doe").closest("a")).toHaveAttribute(
      "href",
      "/catalog/default/user/e.silva_example.com",
    );
    const ownerCell = screen.getAllByRole("row")[2].querySelectorAll("td")[1];
    expect(ownerCell?.querySelector("img")).toHaveAttribute(
      "src",
      "https://example.com/jane.png",
    );
  });

  it("should fall back to the slug for an owner the catalog no longer holds", async () => {
    // given
    // A person who has left is a row with no photograph, not a broken one: the
    // reference still says who the YAML names.
    const repos = [
      RepositoryBuilder.create().withName("legacy").withOwner("group:default/platform").build(),
    ];

    // when
    await render(<RepositoryTable repositories={repos} totalCount={1} isLoading={false} />);

    // then
    expect(screen.getByText("platform")).toBeInTheDocument();
  });

  it("should filter and sort on the name a reader can actually see", async () => {
    // given
    // A column that filters on a hidden slug is a column whose results nobody
    // can predict.
    const repos = [
      RepositoryBuilder.create()
        .withName("one")
        .withOwnerProfile("group:default/plat-1", "Platform")
        .build(),
      RepositoryBuilder.create()
        .withName("two")
        .withOwnerProfile("group:default/pay-2", "Payments")
        .build(),
    ];
    await render(<RepositoryTable repositories={repos} totalCount={2} isLoading={false} />);

    // when
    fireEvent.change(screen.getByLabelText("Filter owner"), { target: { value: "Platf" } });

    // then
    expect(screen.getByText("Platform")).toBeInTheDocument();
    expect(screen.queryByText("Payments")).not.toBeInTheDocument();
  });

  it("should leave the owner empty when the entity declares none", async () => {
    // given
    // An unowned repository is a real finding; a fabricated owner would hide it.
    const repos = [RepositoryBuilder.create().withName("orphan").withOwner(null).build()];
    await render(<RepositoryTable repositories={repos} totalCount={1} isLoading={false} />);

    // when
    const ownerCell = screen.getAllByRole("row")[2].querySelectorAll("td")[1];

    // then
    expect(ownerCell?.textContent).toBe("-");
  });

  it("should filter the rows by owner", async () => {
    // given
    const repos = [
      RepositoryBuilder.create().withName("one").withOwner("group:default/platform").build(),
      RepositoryBuilder.create().withName("two").withOwner("group:default/payments").build(),
    ];
    await render(<RepositoryTable repositories={repos} totalCount={2} isLoading={false} />);

    // when
    fireEvent.change(screen.getByLabelText("Filter owner"), { target: { value: "pay" } });

    // then
    expect(screen.getByText("user/two")).toBeInTheDocument();
    expect(screen.queryByText("user/one")).not.toBeInTheDocument();
  });

  it("should score a repository's health and colour it by band", async () => {
    // given
    // Everything measurable passes, so the score is a healthy one rather than a
    // number diluted by components nobody could read.
    const repos = [
      RepositoryBuilder.create()
        .withName("healthy")
        .withCoverage(90, "OK")
        .withCiStatus("SUCCESS")
        .withComplianceColor("green")
        .withDocumentationState("documented")
        .withActivity({ pullRequestsMerged: 4, reviews: 8, buildsSucceeded: 10 })
        .build(),
    ];

    // when
    await render(<RepositoryTable repositories={repos} totalCount={1} isLoading={false} />);

    // then
    // Scoped to the cell's own paragraph: the page-size selector offers a
    // hundred rows too.
    expect(screen.getByText("100", { selector: "p" })).toHaveAttribute("data-band", "good");
  });

  it("should leave the health empty when nothing about the row could be measured", async () => {
    // given
    // A repository nothing has been collected for has an unknown health, not a
    // failing one, and a zero here would read as the latter.
    const repos = [RepositoryBuilder.create().withName("fresh").build()];
    await render(<RepositoryTable repositories={repos} totalCount={1} isLoading={false} />);

    // when
    const healthCell = screen.getAllByRole("row")[2].querySelectorAll("td")[2];

    // then
    expect(healthCell?.textContent).toBe("-");
  });

  it("should sort unmeasured repositories below every measured one", async () => {
    // given
    // Sorting has to put them somewhere, and below is the only place that does
    // not claim something: above the worst-scoring repository would read as a
    // top ranking, and interleaving them at zero as a failing grade.
    const repos = [
      RepositoryBuilder.create().withName("unknown").build(),
      RepositoryBuilder.create().withName("known").withQualityGate("ERROR").build(),
    ];
    await render(<RepositoryTable repositories={repos} totalCount={2} isLoading={false} />);
    const namesInOrder = () =>
      screen
        .getAllByRole("row")
        .slice(2)
        .map((row) => row.querySelectorAll("td")[0].textContent);

    // when
    // A numeric column sorts descending on its first click, so this is the
    // "best first" reading and the unmeasured row belongs at the bottom of it.
    fireEvent.click(screen.getByText("Health"));

    // then
    expect(namesInOrder()).toEqual(["user/known", "user/unknown"]);

    // when
    fireEvent.click(screen.getByText("Health"));

    // then
    expect(namesInOrder()).toEqual(["user/unknown", "user/known"]);
  });

  it("should render 'No repositories found.' when repositories is empty and not loading", async () => {
    // given / when
    await render(<RepositoryTable repositories={[]} totalCount={0} isLoading={false} />);

    // then
    expect(screen.getByText("No repositories found.")).toBeInTheDocument();
  });

  it("should render loading skeleton when isLoading is true", async () => {
    // given / when
    const { container } = await render(
      <RepositoryTable repositories={[]} totalCount={0} isLoading />,
    );

    // then
    const skeletonRows = container.querySelectorAll("[data-testid=\"loadingRow\"]");
    expect(skeletonRows.length).toBeGreaterThan(0);
  });

  it("should render repository rows with name, CI status, and language", async () => {
    // given
    const repos = [
      RepositoryBuilder.create()
        .withName("my-repo")
        .withLanguage("TypeScript")
        .withCiStatus("SUCCESS")
        .build(),
    ];

    // when
    await render(<RepositoryTable repositories={repos} totalCount={1} isLoading={false} />);

    // then
    expect(screen.getByText("user/my-repo")).toBeInTheDocument();
    expect(screen.getByText("TypeScript")).toBeInTheDocument();
  });

  it("should render archived badge for archived repos", async () => {
    // given
    const repos = [RepositoryBuilder.create().withName("old-repo").asArchived().build()];

    // when
    await render(<RepositoryTable repositories={repos} totalCount={1} isLoading={false} />);

    // then - archived repos are hidden by default, need to check the checkbox
    fireEvent.click(screen.getByLabelText("Archived"));
    expect(screen.getByText("archived")).toBeInTheDocument();
  });

  it("should render fork badge for forked repos", async () => {
    // given
    const repos = [RepositoryBuilder.create().withName("fork-repo").asFork().build()];

    // when
    await render(<RepositoryTable repositories={repos} totalCount={1} isLoading={false} />);

    // then - forks are hidden by default
    fireEvent.click(screen.getByLabelText("Forks"));
    expect(screen.getByText("fork")).toBeInTheDocument();
  });

  it("should show repository count", async () => {
    // given
    const repos = [
      RepositoryBuilder.create().withName("repo-1").build(),
      RepositoryBuilder.create().withName("repo-2").build(),
    ];

    // when
    await render(<RepositoryTable repositories={repos} totalCount={5} isLoading={false} />);

    // then
    expect(screen.getByText(/2 of 5 repositories/)).toBeInTheDocument();
  });

  it("should filter archived repos by default (showArchived off)", async () => {
    // given
    const repos = [
      RepositoryBuilder.create().withName("active").build(),
      RepositoryBuilder.create().withName("old").asArchived().build(),
    ];

    // when
    await render(<RepositoryTable repositories={repos} totalCount={2} isLoading={false} />);

    // then
    expect(screen.getByText("user/active")).toBeInTheDocument();
    expect(screen.queryByText("user/old")).not.toBeInTheDocument();
  });

  it("should show archived repos when checkbox is checked", async () => {
    // given
    const repos = [
      RepositoryBuilder.create().withName("active").build(),
      RepositoryBuilder.create().withName("old").asArchived().build(),
    ];
    await render(<RepositoryTable repositories={repos} totalCount={2} isLoading={false} />);

    // when
    fireEvent.click(screen.getByLabelText("Archived"));

    // then
    expect(screen.getByText("user/old")).toBeInTheDocument();
  });

  it("should show fork repos when checkbox is checked", async () => {
    // given
    const repos = [
      RepositoryBuilder.create().withName("mine").build(),
      RepositoryBuilder.create().withName("forked").asFork().build(),
    ];
    await render(<RepositoryTable repositories={repos} totalCount={2} isLoading={false} />);

    // when
    fireEvent.click(screen.getByLabelText("Forks"));

    // then
    expect(screen.getByText("user/forked")).toBeInTheDocument();
  });

  it("should render release tag and relative date", async () => {
    // given
    const repos = [
      RepositoryBuilder.create()
        .withName("released")
        .withLatestRelease({
          tagName: "v2.0.0",
          publishedAt: new Date().toISOString(),
        })
        .build(),
    ];

    // when
    await render(<RepositoryTable repositories={repos} totalCount={1} isLoading={false} />);

    // then
    expect(screen.getByText("v2.0.0")).toBeInTheDocument();
    expect(screen.getByText("today")).toBeInTheDocument();
  });

  it("should render 'private' badge for private repos", async () => {
    // given
    const repos = [RepositoryBuilder.create().withName("secret").asPrivate().build()];

    // when
    await render(<RepositoryTable repositories={repos} totalCount={1} isLoading={false} />);

    // then
    expect(screen.getByText("private")).toBeInTheDocument();
  });

  it("should render Sonar quality gate Passed status", async () => {
    // given
    const repos = [
      {
        ...RepositoryBuilder.create().withName("sonar-ok").build(),
        sonarMetrics: {
          bugs: 0,
          codeSmells: 0,
          securityHotspots: 0,
          vulnerabilities: 0,
          coverage: 90,
          duplications: 1,
          technicalDebt: "0min",
          technicalDebtMinutes: 0,
          qualityGateStatus: "OK" as const,
        },
      },
    ];

    // when
    await render(<RepositoryTable repositories={repos} totalCount={1} isLoading={false} />);

    // then
    expect(inBody().getByText("Passed")).toBeInTheDocument();
  });

  it("should highlight a default branch that is not 'main'", async () => {
    // given
    const repos = [
      { ...RepositoryBuilder.create().withName("legacy").build(), defaultBranch: "master" },
    ];

    // when
    await render(<RepositoryTable repositories={repos} totalCount={1} isLoading={false} />);

    // then
    const branch = inBody().getByText("master");
    expect(branch.closest("[title]")?.getAttribute("title")).toBe("Default branch is not 'main'");
  });

  it("should count the branches other than the default one", async () => {
    // given
    const repos = [
      {
        ...RepositoryBuilder.create().withName("many-branches").build(),
        branches: ["main", "feat/a", "fix/b"],
      },
    ];

    // when
    await render(<RepositoryTable repositories={repos} totalCount={1} isLoading={false} />);

    // then
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("should list the non-default branches when the count is clicked", async () => {
    // given
    const repos = [
      {
        ...RepositoryBuilder.create().withName("many-branches").build(),
        branches: ["main", "feat/a", "fix/b"],
      },
    ];
    await render(<RepositoryTable repositories={repos} totalCount={1} isLoading={false} />);

    // when
    fireEvent.click(screen.getByText("2"));

    // then
    const menu = within(screen.getByRole("menu", { name: "Branches" }));
    expect(menu.getByText("feat/a")).toBeInTheDocument();
    expect(menu.getByText("fix/b")).toBeInTheDocument();
    expect(menu.queryByText("main")).not.toBeInTheDocument();
  });

  it("should close the branches popup when the overlay is clicked", async () => {
    // given
    const repos = [
      {
        ...RepositoryBuilder.create().withName("many-branches").build(),
        branches: ["main", "feat/a"],
      },
    ];
    await render(<RepositoryTable repositories={repos} totalCount={1} isLoading={false} />);
    fireEvent.click(inBody().getByText("1"));

    // when
    fireEvent.click(screen.getByTestId("branches-overlay"));

    // then
    expect(screen.queryByText("feat/a")).not.toBeInTheDocument();
  });

  it("should tell the user when a repository has no extra branches", async () => {
    // given
    const repos = [
      { ...RepositoryBuilder.create().withName("solo").build(), branches: ["main"] },
    ];
    await render(<RepositoryTable repositories={repos} totalCount={1} isLoading={false} />);

    // when
    fireEvent.click(inBody().getByText("0"));

    // then
    expect(screen.getByText("No extra branches")).toBeInTheDocument();
  });

  it("should render the compliance badge when compliance data is available", async () => {
    // given
    const repos = [
      {
        ...RepositoryBuilder.create().withName("compliant").build(),
        complianceStatus: {
          pipelineExists: true,
          buildPolicyOnPRs: true,
          buildPolicyExpiration: true,
          branchProtection: true,
          color: "green" as const,
        },
      },
    ];

    // when
    await render(<RepositoryTable repositories={repos} totalCount={1} isLoading={false} />);

    // then
    expect(inBody().getByText("Compliant")).toBeInTheDocument();
  });

  it("should render the badge status cell when badge data is available", async () => {
    // given
    const repos = [
      {
        ...RepositoryBuilder.create().withName("badged").build(),
        badgeStatus: {
          checks: [{ label: "License", present: true }],
          color: "green" as const,
        },
      },
    ];

    // when
    await render(<RepositoryTable repositories={repos} totalCount={1} isLoading={false} />);

    // then
    expect(inBody().getByText("Complete")).toBeInTheDocument();
  });

  it("should filter rows through a column filter", async () => {
    // given
    const repos = [
      RepositoryBuilder.create().withName("alpha").build(),
      RepositoryBuilder.create().withName("beta").build(),
    ];
    await render(<RepositoryTable repositories={repos} totalCount={2} isLoading={false} />);

    // when
    fireEvent.change(screen.getByLabelText("Filter fullName"), { target: { value: "alpha" } });

    // then
    expect(screen.getByText("user/alpha")).toBeInTheDocument();
    expect(screen.queryByText("user/beta")).not.toBeInTheDocument();
  });

  it("should filter rows through a select column filter", async () => {
    // given
    const repos = [
      RepositoryBuilder.create().withName("public-repo").build(),
      RepositoryBuilder.create().withName("secret").asPrivate().build(),
    ];
    await render(<RepositoryTable repositories={repos} totalCount={2} isLoading={false} />);

    // when
    fireEvent.change(screen.getByLabelText("Filter visibility"), { target: { value: "PRIVATE" } });

    // then
    expect(screen.getByText("user/secret")).toBeInTheDocument();
    expect(screen.queryByText("user/public-repo")).not.toBeInTheDocument();
  });

  it("should sort rows when a column header is clicked", async () => {
    // given
    const repos = [
      RepositoryBuilder.create().withName("alpha").build(),
      RepositoryBuilder.create().withName("beta").build(),
    ];
    await render(<RepositoryTable repositories={repos} totalCount={2} isLoading={false} />);

    // when
    fireEvent.click(screen.getByText("Repository"));

    // then
    // Only the name links carry text: the catalog link beside each one is an
    // icon, so it contributes nothing here.
    const links = screen
      .getAllByRole("link")
      .map((link) => link.textContent)
      .filter(Boolean);
    expect(links).toEqual(["user/beta", "user/alpha"]);
  });

  it("should render Sonar quality gate Failed status", async () => {
    // given
    const repos = [
      {
        ...RepositoryBuilder.create().withName("sonar-fail").build(),
        sonarMetrics: {
          bugs: 5,
          codeSmells: 10,
          securityHotspots: 1,
          vulnerabilities: 2,
          coverage: 20,
          duplications: 15,
          technicalDebt: "5d",
          technicalDebtMinutes: 2400,
          qualityGateStatus: "ERROR" as const,
        },
      },
    ];

    // when
    await render(<RepositoryTable repositories={repos} totalCount={1} isLoading={false} />);

    // then
    expect(inBody().getByText("Failed")).toBeInTheDocument();
  });
});
