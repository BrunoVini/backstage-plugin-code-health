import {
  BudgetExhaustedError,
  RequestBudget,
} from "../../../src/domain/entities/request_budget";

describe("RequestBudget", () => {
  it("should allow exactly as many requests as it was given", () => {
    // given
    const budget = new RequestBudget(3);

    // when
    const results = [budget.tryConsume(), budget.tryConsume(), budget.tryConsume(), budget.tryConsume()];

    // then
    expect(results).toEqual([true, true, true, false]);
    expect(budget.spent).toBe(3);
  });

  it("should report what is left", () => {
    // given
    const budget = new RequestBudget(5);

    // when
    budget.consume();
    budget.consume();

    // then
    expect(budget.remaining).toBe(3);
    expect(budget.isExhausted).toBe(false);
  });

  it("should never report a negative remainder", () => {
    // given
    const budget = new RequestBudget(1);
    budget.consume();

    // when
    const remaining = budget.remaining;

    // then
    expect(remaining).toBe(0);
    expect(budget.isExhausted).toBe(true);
  });

  it("should throw once the allowance is gone", () => {
    // given
    const budget = new RequestBudget(1);
    budget.consume();

    // when / then
    // Throwing rather than returning false is what lets the ingestion actor
    // unwind out of a half-finished window without every call site having to
    // check a boolean.
    expect(() => budget.consume()).toThrow(BudgetExhaustedError);
  });

  it("should report how much was spent when it ran out", () => {
    // given
    const budget = new RequestBudget(2);
    budget.consume();
    budget.consume();

    // when
    const error = (() => {
      try {
        budget.consume();
        return null;
      } catch (thrown) {
        return thrown as BudgetExhaustedError;
      }
    })();

    // then
    expect(error?.spent).toBe(2);
  });

  it("should count what it turned away, and nothing while the allowance lasts", () => {
    // given
    // Spending the last request is not wanting one more: only a refusal says
    // the pass stopped short, so a budget used to the unit reports none.
    const budget = new RequestBudget(2);
    budget.consume();
    budget.consume();
    const exact = budget.refused;

    // when
    budget.tryConsume();
    budget.tryConsume();

    // then
    expect(exact).toBe(0);
    expect(budget.refused).toBe(2);
    expect(budget.limit).toBe(2);
  });

  it("should refuse everything when created with no allowance", () => {
    // given
    const budget = new RequestBudget(0);

    // when / then
    expect(budget.tryConsume()).toBe(false);
    expect(budget.isExhausted).toBe(true);
  });
});
