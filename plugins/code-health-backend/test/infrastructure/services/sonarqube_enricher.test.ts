import { mockServices } from "@backstage/backend-test-utils";
import {
  BudgetExhaustedError,
  RequestBudget,
} from "../../../src/domain/entities/request_budget";
import { ProviderGateway } from "../../../src/infrastructure/http/provider_gateway";
import { SonarqubeEnricher } from "../../../src/infrastructure/services/sonarqube_enricher";
import { aTrackedRepository } from "../../builders/tracked_repository_builder";
import { ControlledClock } from "../../doubles/controlled_clock";
import { RecordingLogger } from "../../doubles/recording_logger";
import { TestProviderServer } from "../../doubles/test_provider_server";

const server = new TestProviderServer();

beforeAll(async () => server.start());
afterAll(async () => server.stop());
beforeEach(() => server.reset());

const createEnricher = () => {
  const logger = new RecordingLogger();
  const enricher = new SonarqubeEnricher({
    gateway: new ProviderGateway({
      logger,
      concurrencyPerHost: 4,
      clock: new ControlledClock(1_000_000),
    }),
    auth: mockServices.auth(),
    // The discovery service resolves the `sonarqube` plugin's base URL, which is
    // what points this at the test server instead of a real backend.
    discovery: { getBaseUrl: async () => server.baseUrl, getExternalBaseUrl: async () => server.baseUrl },
    logger,
  });
  return { enricher, logger };
};

const context = () => ({ budget: new RequestBudget(10) });

const repository = () => aTrackedRepository({ sonarProjectKey: "rios0rios0_pipelines" });

const measures = (values: Record<string, string>) => ({
  findings: {
    measures: Object.entries(values).map(([metric, value]) => ({ metric, value })),
  },
});

describe("SonarqubeEnricher", () => {
  it("should map the summary onto the dashboard's metrics", async () => {
    // given
    const { enricher } = createEnricher();
    server.on("/summary", () => ({
      body: measures({
        bugs: "3",
        code_smells: "12",
        security_hotspots: "1",
        vulnerabilities: "0",
        coverage: "87.4",
        duplicated_lines_density: "1.2",
        sqale_index: "195",
        alert_status: "OK",
      }),
    }));

    // when
    const result = await enricher.fetch(repository(), context());

    // then
    expect(result).toEqual({
      bugs: 3,
      codeSmells: 12,
      securityHotspots: 1,
      vulnerabilities: 0,
      coverage: 87.4,
      duplications: 1.2,
      technicalDebt: "3h 15min",
      // the same value unformatted, so a summed debt need not be parsed back
      // out of the display string
      technicalDebtMinutes: 195,
      qualityGateStatus: "OK",
    });
  });

  it("should ask the sonarqube plugin for the entity rather than a project key", async () => {
    // given
    // That plugin resolves the project key from the entity's own annotation, so
    // there is no second place for the mapping to drift.
    const { enricher } = createEnricher();
    server.on("/summary", () => ({ body: measures({ bugs: "0" }) }));

    // when
    await enricher.fetch(repository(), context());

    // then
    expect(server.requests[0].path).toBe("/entities/component/default/gateway/summary");
  });

  it("should authenticate as this plugin over the service-to-service channel", async () => {
    // given
    // The Sonar token stays where the sonarqube plugin already keeps it, so
    // nothing here needs a credential of its own.
    const { enricher } = createEnricher();
    server.on("/summary", () => ({ body: measures({ bugs: "0" }) }));

    // when
    await enricher.fetch(repository(), context());

    // then
    expect(server.requests[0].headers.authorization).toMatch(/^Bearer /);
  });

  it.each([
    ["0", "0min"],
    ["30", "30min"],
    ["60", "1h"],
    ["90", "1h 30min"],
    ["480", "1d"],
    ["540", "1d 1h"],
  ])("should render a technical debt of %s minutes as %s", async (minutes, expected) => {
    // given
    const { enricher } = createEnricher();
    server.on("/summary", () => ({ body: measures({ sqale_index: minutes }) }));

    // when
    const result = await enricher.fetch(repository(), context());

    // then
    expect(result?.technicalDebt).toBe(expected);
  });

  it("should report no quality gate when Sonar did not evaluate one", async () => {
    // given
    const { enricher } = createEnricher();
    server.on("/summary", () => ({ body: measures({ bugs: "0" }) }));

    // when
    const result = await enricher.fetch(repository(), context());

    // then
    expect(result?.qualityGateStatus).toBe("NONE");
  });

  it("should skip an entity with no Sonar project key", async () => {
    // given
    // Without the annotation the sonarqube plugin has nothing to look up, so
    // asking would spend a request to be told so.
    const { enricher } = createEnricher();

    // when
    const result = await enricher.fetch(aTrackedRepository({ sonarProjectKey: null }), context());

    // then
    expect(result).toBeNull();
    expect(server.requests).toEqual([]);
  });

  it("should let an exhausted allowance through rather than reading it as no project", async () => {
    // given
    // A spent allowance is a fact about the run. Swallowed into a null it
    // would read as "no Sonar project" on every repository after it, and the
    // snapshot pass could never say how many readings it never took.
    const { enricher } = createEnricher();
    server.on("/summary", () => ({ body: measures({ bugs: "0" }) }));

    // when
    const attempt = enricher.fetch(repository(), { budget: new RequestBudget(0) });

    // then
    await expect(attempt).rejects.toBeInstanceOf(BudgetExhaustedError);
  });

  it("should return nothing when the sonarqube plugin is not installed", async () => {
    // given
    // A 404 here means the plugin is absent or the project is unknown. Neither
    // is a reason to fail the day's whole snapshot.
    const { enricher, logger } = createEnricher();
    server.on("/summary", () => ({ status: 404, body: { message: "not found" } }));

    // when
    const result = await enricher.fetch(repository(), context());

    // then
    expect(result).toBeNull();
    expect(logger.at("debug").join(" ")).toContain("no Sonar summary");
  });

  it("should return nothing when the summary carries no measures", async () => {
    // given
    const { enricher } = createEnricher();
    server.on("/summary", () => ({ body: { findings: null } }));

    // when
    const result = await enricher.fetch(repository(), context());

    // then
    expect(result).toBeNull();
  });

  it("should treat an unparseable measure as zero", async () => {
    // given
    const { enricher } = createEnricher();
    server.on("/summary", () => ({ body: measures({ bugs: "not a number" }) }));

    // when
    const result = await enricher.fetch(repository(), context());

    // then
    expect(result?.bugs).toBe(0);
  });
});
