import { fireEvent, render, screen } from "@testing-library/react";
import type { TrendSelection } from "../../../src/domain/entities/trend_range";
import {
  TrendRangePicker,
  trendRangeLabel,
} from "../../../src/presentation/components/trend_range_picker";

const ROLLING: TrendSelection = { kind: "months", months: 3 };
const MONTHS = [
  { year: 2026, month: 9 },
  { year: 2026, month: 8 },
];

describe("TrendRangePicker", () => {
  it("should list every rolling count offered, in months", () => {
    // given / when
    render(
      <TrendRangePicker
        selection={ROLLING}
        offered={[1, 2, 3]}
        months={[]}
        onChange={() => undefined}
      />,
    );

    // then
    const select = screen.getByLabelText("Trend range") as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Last month",
      "Last 2 months",
      "Last 3 months",
    ]);
    expect(select.value).toBe("months:3");
  });

  it("should name every calendar month the backfill has reached", () => {
    // given
    // Somebody who has just read "September" on a table and clicked through to
    // a person has to be able to ask the same question about them — and to see
    // from the list that a month can be asked for at all.

    // when
    render(
      <TrendRangePicker
        selection={ROLLING}
        offered={[1, 2, 3]}
        months={MONTHS}
        onChange={() => undefined}
      />,
    );

    // then
    const select = screen.getByLabelText("Trend range") as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Last month",
      "Last 2 months",
      "Last 3 months",
      "September 2026",
      "August 2026",
    ]);
  });

  it("should group the rolling counts apart from the months", () => {
    // given / when
    render(
      <TrendRangePicker
        selection={ROLLING}
        offered={[1]}
        months={MONTHS}
        onChange={() => undefined}
      />,
    );

    // then
    const groups = screen
      .getByLabelText("Trend range")
      .querySelectorAll("optgroup");
    expect([...groups].map((group) => group.label)).toEqual([
      "Rolling",
      "Calendar months",
    ]);
  });

  it("should omit the month group entirely before any month is covered", () => {
    // given
    // A group heading with nothing under it reads as an integration that broke.

    // when
    render(
      <TrendRangePicker
        selection={ROLLING}
        offered={[1]}
        months={[]}
        onChange={() => undefined}
      />,
    );

    // then
    expect(
      screen.getByLabelText("Trend range").querySelectorAll("optgroup"),
    ).toHaveLength(1);
  });

  it("should report a rolling count as a selection", () => {
    // given
    const picked: TrendSelection[] = [];
    render(
      <TrendRangePicker
        selection={{ kind: "months", months: 1 }}
        offered={[1, 2, 3]}
        months={[]}
        onChange={(next) => picked.push(next)}
      />,
    );

    // when
    fireEvent.change(screen.getByLabelText("Trend range"), {
      target: { value: "months:2" },
    });

    // then
    expect(picked).toEqual([{ kind: "months", months: 2 }]);
  });

  it("should report a calendar month as a selection", () => {
    // given
    const picked: TrendSelection[] = [];
    render(
      <TrendRangePicker
        selection={ROLLING}
        offered={[1, 2, 3]}
        months={MONTHS}
        onChange={(next) => picked.push(next)}
      />,
    );

    // when
    fireEvent.change(screen.getByLabelText("Trend range"), {
      target: { value: "month:2026-8" },
    });

    // then
    expect(picked).toEqual([{ kind: "month", month: { year: 2026, month: 8 } }]);
  });

  it("should stay put on a value none of its options carry", () => {
    // given
    // A browser handed an unknown value reports the empty string back, and
    // querying for nobody's window is worse than not moving.
    const picked: TrendSelection[] = [];
    render(
      <TrendRangePicker
        selection={ROLLING}
        offered={[1, 2, 3]}
        months={MONTHS}
        onChange={(next) => picked.push(next)}
      />,
    );

    // when
    fireEvent.change(screen.getByLabelText("Trend range"), { target: { value: "" } });

    // then
    expect(picked).toEqual([]);
  });

  it("should say why the list is short while the history is still being collected", () => {
    // given / when
    render(
      <TrendRangePicker
        selection={{ kind: "months", months: 1 }}
        offered={[1]}
        months={[]}
        onChange={() => undefined}
      />,
    );

    // then
    expect(screen.getByText(/Wider ranges unlock/u)).toBeInTheDocument();
  });

  it("should say nothing once every count is offered", () => {
    // given / when
    render(
      <TrendRangePicker
        selection={{ kind: "months", months: 6 }}
        offered={[1, 2, 3, 4, 5, 6]}
        months={[]}
        onChange={() => undefined}
      />,
    );

    // then
    expect(screen.queryByText(/Wider ranges unlock/u)).not.toBeInTheDocument();
  });

  it("should label a single month without a count", () => {
    // given / when / then
    expect(trendRangeLabel(1)).toBe("Last month");
    expect(trendRangeLabel(4)).toBe("Last 4 months");
  });
});
