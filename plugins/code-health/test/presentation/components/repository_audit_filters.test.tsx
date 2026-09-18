import { renderInTestApp } from "@backstage/test-utils";
import { fireEvent, screen } from "@testing-library/react";
import type { RepositoryAuditId } from "../../../src/domain/entities/repository_audit";
import { REPOSITORY_AUDITS } from "../../../src/domain/entities/repository_audit";
import { RepositoryAuditFilters } from "../../../src/presentation/components/repository_audit_filters";

const context = { expectedDefaultBranch: "main" };

const counts = (entries: Partial<Record<RepositoryAuditId, number>>) =>
  new Map(Object.entries(entries) as [RepositoryAuditId, number][]);

interface RenderOptions {
  readonly counts?: ReadonlyMap<RepositoryAuditId, number>;
  readonly selected?: readonly RepositoryAuditId[];
  readonly onToggle?: (id: RepositoryAuditId) => void;
  readonly onClear?: () => void;
}

const render = (options: RenderOptions = {}) =>
  renderInTestApp(
    <RepositoryAuditFilters
      counts={options.counts ?? counts({})}
      selected={options.selected ?? []}
      context={context}
      onToggle={options.onToggle ?? (() => {})}
      onClear={options.onClear ?? (() => {})}
    />,
  );

const chip = (label: string): HTMLElement =>
  screen.getByRole("button", { name: new RegExp(`^${label}`, "u") });

describe("RepositoryAuditFilters", () => {
  it("should draw one chip per audit", async () => {
    // given / when
    await render();

    // then
    REPOSITORY_AUDITS.forEach((audit) => {
      expect(chip(audit.label)).toBeInTheDocument();
    });
  });

  it("should put each audit's count on its chip", async () => {
    // given / when
    await render({ counts: counts({ unowned: 7, "no-pipeline": 2 }) });

    // then
    expect(chip("No owner")).toHaveTextContent("No owner 7");
    expect(chip("No pipeline")).toHaveTextContent("No pipeline 2");
  });

  it("should read a count nobody supplied as zero", async () => {
    // given
    // The map is a prop, so a caller can hand over a partial one; a chip with
    // no number on it would be worse than one reading zero.
    await render({ counts: counts({ unowned: 1 }) });

    // then
    expect(chip("Never measured")).toHaveTextContent("Never measured 0");
  });

  it("should report a selected audit as pressed", async () => {
    // given / when
    await render({ counts: counts({ unowned: 3 }), selected: ["unowned"] });

    // then
    expect(chip("No owner")).toHaveAttribute("aria-pressed", "true");
    expect(chip("No pipeline")).toHaveAttribute("aria-pressed", "false");
  });

  it("should keep a selected audit clickable even when nothing matches it", async () => {
    // given
    // A selection has to be undoable by the control that made it, whatever the
    // count has since become.
    await render({ counts: counts({ unowned: 0 }), selected: ["unowned"] });

    // then
    expect(chip("No owner")).not.toHaveClass("Mui-disabled");
  });

  it("should hand the audit's id back when its chip is clicked", async () => {
    // given
    const toggled: RepositoryAuditId[] = [];
    await render({
      counts: counts({ "no-branch-protection": 4 }),
      onToggle: (id) => toggled.push(id),
    });

    // when
    fireEvent.click(chip("No branch protection"));

    // then
    expect(toggled).toEqual(["no-branch-protection"]);
  });

  it("should clear every audit when asked", async () => {
    // given
    let cleared = 0;
    await render({ selected: ["unowned"], onClear: () => (cleared += 1) });

    // when
    fireEvent.click(screen.getByText("Clear audits"));

    // then
    expect(cleared).toBe(1);
  });

  it("should offer nothing to clear while no audit is selected", async () => {
    // given / when
    await render();

    // then
    expect(screen.queryByText("Clear audits")).not.toBeInTheDocument();
  });

  it("should explain an audit against the configured branch", async () => {
    // given
    await renderInTestApp(
      <RepositoryAuditFilters
        counts={counts({ "non-standard-branch": 5 })}
        selected={[]}
        context={{ expectedDefaultBranch: "trunk" }}
        onToggle={() => {}}
        onClear={() => {}}
      />,
    );

    // when
    fireEvent.mouseOver(chip("Non-standard branch"));

    // then
    expect(await screen.findByText(/is not `trunk`/u)).toBeInTheDocument();
  });
});
