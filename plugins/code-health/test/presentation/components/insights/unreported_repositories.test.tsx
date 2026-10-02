import { render, screen } from "@testing-library/react";
import { UnreportedRepositories } from "../../../../src/presentation/components/insights/unreported_repositories";

describe("UnreportedRepositories", () => {
  it("should name every repository that reports no coverage", () => {
    // given
    const repositories = ["customer-clusters", "mssp"];

    // when
    render(<UnreportedRepositories repositories={repositories} />);

    // then
    expect(screen.getByText("customer-clusters")).toBeInTheDocument();
    expect(screen.getByText("mssp")).toBeInTheDocument();
  });

  it("should keep both repositories when two of them share a name", () => {
    // given
    // The same name in two Azure DevOps projects or two GitHub organisations.
    // Keyed by name alone, React would drop one and the card would under-report
    // the very gap it exists to show.
    const repositories = ["shared-toolbox", "shared-toolbox"];

    // when
    render(<UnreportedRepositories repositories={repositories} />);

    // then
    expect(screen.getAllByText("shared-toolbox")).toHaveLength(2);
  });

  it("should render nothing when every repository reports coverage", () => {
    // given
    // Not an empty heading over an empty row: with no gap there is nothing to
    // say, and a permanent empty section trains a reader to stop looking.
    const repositories: readonly string[] = [];

    // when
    const { container } = render(<UnreportedRepositories repositories={repositories} />);

    // then
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("Reporting no coverage")).not.toBeInTheDocument();
  });
});
