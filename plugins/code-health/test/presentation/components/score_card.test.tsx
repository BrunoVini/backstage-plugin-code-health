import { render, screen } from "@testing-library/react";
import type { Score } from "@rios0rios0/backstage-plugin-code-health-common";
import { ScoreCard } from "../../../src/presentation/components/score_card";

const aScore = (overrides: Partial<Score> = {}): Score => ({
  value: 82,
  evidence: 0.85,
  components: [
    {
      id: "commits",
      label: "Commits",
      weight: 0.2,
      value: 12,
      normalized: 0.6,
      detail: "12 commits a day against the team's average of 20 commits a day",
    },
    {
      id: "pipelineSuccessRate",
      label: "Pipeline success",
      weight: 0.15,
      value: null,
      normalized: null,
      detail: "no pipeline run reached a verdict",
    },
  ],
  ...overrides,
});

describe("ScoreCard", () => {
  it("should show the score, its band and how much evidence it rests on", () => {
    // given / when
    render(<ScoreCard title="Productivity" score={aScore()} emptyMessage="Nothing measured." />);

    // then
    expect(screen.getByText("82")).toHaveAttribute("data-band", "good");
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(
      screen.getByText("Based on 1 of 2 components, carrying 85% of the weight."),
    ).toBeInTheDocument();
  });

  it("should take the score apart into its components, keeping the unmeasured ones", () => {
    // given / when
    render(<ScoreCard title="Productivity" score={aScore()} emptyMessage="Nothing measured." />);

    // then
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "Commits: 12 commits a day against the team's average of 20 commits a day",
      "Pipeline success: no pipeline run reached a verdict",
    ]);
    expect(screen.getByText("20%")).toBeInTheDocument();
    expect(screen.getByText("15%")).toBeInTheDocument();
  });

  it("should band a poor score as needing attention", () => {
    // given / when
    render(
      <ScoreCard title="Health" score={aScore({ value: 31 })} emptyMessage="Nothing measured." />,
    );

    // then
    expect(screen.getByText("31")).toHaveAttribute("data-band", "poor");
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
  });

  it("should explain an absent score rather than printing a zero", () => {
    // given
    const score = aScore({
      value: null,
      evidence: 0,
      components: aScore().components.map((component) => ({
        ...component,
        value: null,
        normalized: null,
      })),
    });

    // when
    render(<ScoreCard title="Health" score={score} emptyMessage="Nothing measured yet." />);

    // then
    expect(screen.getByText("Nothing measured yet.")).toBeInTheDocument();
    expect(screen.queryByText("/ 100")).not.toBeInTheDocument();
    // The components still list what would have been measured.
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("should show only the message when there is no score at all", () => {
    // given / when
    render(<ScoreCard title="Health" score={null} emptyMessage="Nobody by that key." />);

    // then
    expect(screen.getByText("Nobody by that key.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });
});
