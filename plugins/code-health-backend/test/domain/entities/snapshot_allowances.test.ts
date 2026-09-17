import { BudgetExhaustedError } from "../../../src/domain/entities/request_budget";
import {
  SNAPSHOT_ALLOWANCE_SETTINGS,
  SnapshotAllowances,
} from "../../../src/domain/entities/snapshot_allowances";

describe("SnapshotAllowances", () => {
  it("should give every source an allowance of its own", () => {
    // given
    // The whole point: a source spending everything it was given touches
    // nothing another source was given.
    const allowances = new SnapshotAllowances({ repositories: 2, confluence: 1 });

    // when
    allowances.budgetFor("confluence").consume();
    const refused = allowances.budgetFor("confluence").tryConsume();

    // then
    expect(refused).toBe(false);
    expect(allowances.budgetFor("repositories").remaining).toBe(2);
    expect(() => allowances.budgetFor("repositories").consume()).not.toThrow();
  });

  it("should answer a source it was not given with nothing to spend", () => {
    // given
    const allowances = new SnapshotAllowances({ repositories: 5 });

    // when / then
    // A budget of nothing rather than no budget, so a caller builds every
    // context up front; and it is not a source the pass reports on.
    expect(() => allowances.budgetFor("jira").consume()).toThrow(BudgetExhaustedError);
    expect(allowances.sources).toEqual(["repositories"]);
  });

  it("should report what each source spent, by name, in one line", () => {
    // given
    const allowances = new SnapshotAllowances({ repositories: 10, sonar: 10, jira: 10 });
    allowances.budgetFor("repositories").consume();
    allowances.budgetFor("repositories").consume();
    allowances.budgetFor("jira").consume();

    // when
    const line = allowances.describe();

    // then
    expect(line).toBe("repositories=2 sonar=0 jira=1");
    expect(allowances.total).toBe(3);
    expect(allowances.spent).toMatchObject({
      repositories: 2,
      sonar: 0,
      wakatime: 0,
      jira: 1,
      confluence: 0,
    });
  });

  it("should name a source starved only once it was refused a request", () => {
    // given
    // Spent to the unit is finished; refused is stopped short. Telling an
    // operator to raise a setting that was exactly enough sends them after a
    // problem that is not there.
    const allowances = new SnapshotAllowances({ repositories: 1, wakatime: 1 });
    allowances.budgetFor("repositories").consume();
    allowances.budgetFor("wakatime").consume();

    // when
    allowances.budgetFor("wakatime").tryConsume();

    // then
    expect(allowances.starved).toEqual(["wakatime"]);
  });

  it("should know where each allowance is raised", () => {
    // given / when / then
    // Sonar has no setting of its own: the repository allowance bounds both,
    // because Sonar is asked once per repository the loop reaches.
    expect(SNAPSHOT_ALLOWANCE_SETTINGS.sonar).toBe(SNAPSHOT_ALLOWANCE_SETTINGS.repositories);
    expect(SNAPSHOT_ALLOWANCE_SETTINGS.confluence).toBe(
      "codeHealth.atlassian.confluence.requestBudgetPerRun",
    );
  });
});
