import { ConfigReader } from "@backstage/config";
import type { JsonObject } from "@backstage/types";
import { integrationCapabilitiesOf } from "../../../src/domain/entities/ingestion_settings";
import { readCodeHealthSettings } from "../../../src/infrastructure/services/backstage_settings_reader";
import { RecordingLogger } from "../../doubles/recording_logger";

const read = (data: JsonObject) => readCodeHealthSettings(new ConfigReader(data));

describe("readCodeHealthSettings", () => {
  it("should fall back to every default when nothing is configured", () => {
    // given / when
    const settings = read({});

    // then
    expect(settings.ingestion).toMatchObject({
      entityFilters: [{ kind: "Component" }],
      retentionDays: 365,
      backfillChunkDays: 1,
      requestBudgetPerRun: 500,
      concurrencyPerHost: 4,
    });
    expect(settings.sonar.enabled).toBe(false);
    expect(settings.wakaTime).toEqual({
      organization: null,
      dashboard: null,
      apiKey: null,
      baseUrl: "https://wakatime.com/api/v1",
      historyDays: 30,
      // Off by default: coding time for a whole window costs one request per
      // member, while the AI figures cost one per member per day.
      includeAiMetrics: false,
      aiDaysPerRun: 3,
      requestBudgetPerRun: 500,
    });
    expect(settings.atlassian).toEqual({
      baseUrl: null,
      email: null,
      apiToken: null,
      maxResultsPerRun: 2000,
      historyDays: 90,
      // Both products default to on: configuring the site is the whole of the
      // work, and an operator who pastes a token wants both.
      jira: { enabled: true, storyPointsField: null },
      confluence: { enabled: true, spaceKeys: [] },
    });
  });

  it("should report nothing enabled when no integration is configured", () => {
    // given / when
    const capabilities = integrationCapabilitiesOf(read({}));

    // then
    expect(capabilities).toEqual({ wakatime: false, jira: false, confluence: false });
  });

  it("should light up WakaTime on the key alone", () => {
    // given
    // The organisation is optional: with none, the key's own account is
    // measured, which is the useful behaviour on a personal plan.
    const settings = read({ codeHealth: { wakaTime: { apiKey: "fixture-token-placeholder" } } });

    // when / then
    expect(integrationCapabilitiesOf(settings).wakatime).toBe(true);
  });

  it("should light up both Atlassian products from one credential", () => {
    // given
    // The behaviour the whole `atlassian` block exists for: they are the same
    // account and the same token, and asking for it twice only creates a way
    // for the two to drift apart.
    const settings = read({
      codeHealth: {
        atlassian: {
          baseUrl: "https://acme.atlassian.net/",
          email: "bot@acme.com",
          apiToken: "fixture-token-placeholder",
        },
      },
    });

    // when
    const capabilities = integrationCapabilitiesOf(settings);

    // then
    expect(capabilities).toMatchObject({ jira: true, confluence: true });
    // And the trailing slash is stripped, so a path can always be appended.
    expect(settings.atlassian.baseUrl).toBe("https://acme.atlassian.net");
  });

  it("should let one Atlassian product be switched off without the other", () => {
    // given
    const settings = read({
      codeHealth: {
        atlassian: {
          baseUrl: "https://acme.atlassian.net",
          email: "bot@acme.com",
          apiToken: "fixture-token-placeholder",
          confluence: { enabled: false },
        },
      },
    });

    // when / then
    expect(integrationCapabilitiesOf(settings)).toEqual({
      wakatime: false,
      jira: true,
      confluence: false,
    });
  });

  it("should treat an Atlassian site with no token as not configured", () => {
    // given
    // Half a credential collects nothing and would light up columns that stay
    // permanently empty.
    const settings = read({
      codeHealth: { atlassian: { baseUrl: "https://acme.atlassian.net" } },
    });

    // when / then
    expect(integrationCapabilitiesOf(settings)).toMatchObject({ jira: false, confluence: false });
  });

  it("should read the WakaTime collection settings", () => {
    // given / when
    const settings = read({
      codeHealth: {
        wakaTime: {
          organization: "acme",
          dashboard: "Platform",
          apiKey: "fixture-token-placeholder",
          baseUrl: "https://wakapi.internal/api/v1/",
          historyDays: 90,
          includeAiMetrics: true,
          aiDaysPerRun: 7,
        },
      },
    });

    // then
    expect(settings.wakaTime).toEqual({
      organization: "acme",
      dashboard: "Platform",
      apiKey: "fixture-token-placeholder",
      baseUrl: "https://wakapi.internal/api/v1",
      historyDays: 90,
      includeAiMetrics: true,
      aiDaysPerRun: 7,
      requestBudgetPerRun: 500,
    });
  });

  it("should give each integration a request allowance of its own by default", () => {
    // given / when
    const settings = read({});

    // then
    // Confluence's is what its own default caps can need — one version
    // history for 500 pages, twelve bodies for each of 150, 200 analytics
    // lookups and 200 for the sweeps — so the caps are reachable rather than
    // nominal. The other two are room for a large organisation and a couple
    // of dozen projects.
    expect(settings.wakaTime.requestBudgetPerRun).toBe(500);
    expect(settings.jira.requestBudgetPerRun).toBe(500);
    expect(settings.confluence.requestBudgetPerRun).toBe(2700);
  });

  it("should read each integration's request allowance from its own block", () => {
    // given / when
    const settings = read({
      codeHealth: {
        wakaTime: { requestBudgetPerRun: 120 },
        atlassian: {
          jira: { requestBudgetPerRun: 80 },
          confluence: { requestBudgetPerRun: 4000 },
        },
      },
    });

    // then
    expect(settings.wakaTime.requestBudgetPerRun).toBe(120);
    expect(settings.jira.requestBudgetPerRun).toBe(80);
    expect(settings.confluence.requestBudgetPerRun).toBe(4000);
  });

  it("should reject a non-positive integration allowance", () => {
    // given / when
    // An allowance of zero would switch the integration off without saying
    // so, one refused request at a time.
    const settings = read({
      codeHealth: {
        wakaTime: { requestBudgetPerRun: 0 },
        atlassian: { jira: { requestBudgetPerRun: -5 }, confluence: { requestBudgetPerRun: 0 } },
      },
    });

    // then
    expect(settings.wakaTime.requestBudgetPerRun).toBe(500);
    expect(settings.jira.requestBudgetPerRun).toBe(500);
    expect(settings.confluence.requestBudgetPerRun).toBe(2700);
  });

  it("should read the Atlassian collection settings", () => {
    // given / when
    const settings = read({
      codeHealth: {
        atlassian: {
          baseUrl: "https://acme.atlassian.net",
          email: "bot@acme.com",
          apiToken: "fixture-token-placeholder",
          maxResultsPerRun: 500,
          historyDays: 30,
          jira: { enabled: true, storyPointsField: "customfield_10016" },
          confluence: { enabled: true, spaceKeys: ["ENG", "  ", "OPS"] },
        },
      },
    });

    // then
    expect(settings.atlassian.maxResultsPerRun).toBe(500);
    expect(settings.atlassian.historyDays).toBe(30);
    expect(settings.atlassian.jira.storyPointsField).toBe("customfield_10016");
    // A blank entry is dropped rather than becoming a space key nothing matches.
    expect(settings.atlassian.confluence.spaceKeys).toEqual(["ENG", "OPS"]);
  });

  it("should schedule the three tasks globally by default", () => {
    // given / when
    const settings = read({});

    // then
    // `scope: 'global'` is what makes the actor run once across replicas rather
    // than once per replica, which is the difference between one provider load
    // and N of them.
    expect(settings.ingestion.schedule.scope).toBe("global");
    expect(settings.ingestion.discoverySchedule.scope).toBe("global");
    expect(settings.ingestion.snapshotSchedule.scope).toBe("global");
  });

  it("should read the configured entity filters", () => {
    // given / when
    const settings = read({
      codeHealth: {
        catalog: { entityFilter: [{ kind: "Component" }, { kind: "Resource" }] },
      },
    });

    // then
    expect(settings.ingestion.entityFilters).toEqual([{ kind: "Component" }, { kind: "Resource" }]);
  });

  it("should ignore an empty filter list rather than tracking nothing", () => {
    // given / when
    const settings = read({ codeHealth: { catalog: { entityFilter: [] } } });

    // then
    expect(settings.ingestion.entityFilters).toEqual([{ kind: "Component" }]);
  });

  it("should discard filter entries that are not objects", () => {
    // given / when
    const settings = read({
      codeHealth: { catalog: { entityFilter: [{ kind: "Component" }, "kind=Resource"] } },
    });

    // then
    expect(settings.ingestion.entityFilters).toEqual([{ kind: "Component" }]);
  });

  it("should fall back when every filter entry is unusable", () => {
    // given / when
    const settings = read({
      codeHealth: { catalog: { entityFilter: ["kind=Component", ["kind"]] } },
    });

    // then
    // Tracking nothing would look identical to an empty catalog, so an
    // unusable filter falls back rather than silently disabling the plugin.
    expect(settings.ingestion.entityFilters).toEqual([{ kind: "Component" }]);
  });

  it("should parse a weekly backfill chunk into days", () => {
    // given / when
    const settings = read({ codeHealth: { ingestion: { backfillChunk: "P7D" } } });

    // then
    expect(settings.ingestion.backfillChunkDays).toBe(7);
  });

  it("should reject a non-positive request budget", () => {
    // given / when
    // A budget of zero would stall the actor forever with no error to explain it.
    const settings = read({ codeHealth: { ingestion: { requestBudgetPerRun: 0 } } });

    // then
    expect(settings.ingestion.requestBudgetPerRun).toBe(500);
  });

  it("should reject a negative retention window", () => {
    // given / when
    const settings = read({ codeHealth: { ingestion: { retentionDays: -30 } } });

    // then
    expect(settings.ingestion.retentionDays).toBe(365);
  });

  it("should truncate a fractional concurrency limit", () => {
    // given / when
    const settings = read({ codeHealth: { ingestion: { concurrencyPerHost: 2.7 } } });

    // then
    expect(settings.ingestion.concurrencyPerHost).toBe(2);
  });

  it("should read a configured schedule", () => {
    // given / when
    const settings = read({
      codeHealth: {
        ingestion: {
          schedule: {
            frequency: { minutes: 1 },
            timeout: { minutes: 2 },
            scope: "local",
          },
        },
      },
    });

    // then
    expect(settings.ingestion.schedule.scope).toBe("local");
    expect(settings.ingestion.schedule.frequency).toEqual({ minutes: 1 });
  });

  it("should read the WakaTime credentials from backend configuration", () => {
    // given / when
    // The old browser-side key is gone; this is the only place the value lives,
    // and it is declared `@visibility secret` so it never reaches a browser.
    const settings = read({
      codeHealth: {
        wakaTime: { organization: "example-org", apiKey: "fixture-token-placeholder" },
      },
    });

    // then
    expect(settings.wakaTime.organization).toBe("example-org");
    expect(settings.wakaTime.apiKey).toBe("fixture-token-placeholder");
  });

  it("should enable Sonar enrichment when asked to", () => {
    // given / when
    const settings = read({ codeHealth: { sonar: { enabled: true } } });

    // then
    expect(settings.sonar.enabled).toBe(true);
  });

  describe("administrators", () => {
    it("should name nobody by default", () => {
      // given / when
      // Resetting drops every collected commit and re-walks the providers, so
      // an install must not acquire an administrator by upgrading.
      const settings = read({});

      // then
      expect(settings.administrators).toEqual([]);
    });

    it("should default a bare name to a user", () => {
      // given / when
      // The list names people far more often than teams, and an operator writes
      // `jane` rather than `user:default/jane`.
      const settings = read({ codeHealth: { administrators: ["jane"] } });

      // then
      expect(settings.administrators).toEqual(["user:default/jane"]);
    });

    it("should keep a kind-qualified reference and fill in the namespace", () => {
      // given / when
      const settings = read({
        codeHealth: { administrators: ["group:platform", "user:default/jane"] },
      });

      // then
      expect(settings.administrators).toEqual([
        "group:default/platform",
        "user:default/jane",
      ]);
    });

    it("should skip a malformed entry and say which", () => {
      // given
      // One typo in a list of five must not take the dashboard down for
      // everybody, and the warning is what makes the entry that stopped
      // working findable.
      const logger = new RecordingLogger();

      // when
      const settings = readCodeHealthSettings(
        new ConfigReader({ codeHealth: { administrators: ["user:", "jane"] } }),
        logger,
      );

      // then
      expect(settings.administrators).toEqual(["user:default/jane"]);
      expect(logger.at("warn")).toEqual([
        "ignoring `codeHealth.administrators` entry user:: it is not an entity reference",
      ]);
    });

    it("should ignore a whitespace entry", () => {
      // given / when
      // The config reader refuses an outright empty string itself, but an entry
      // that is only spaces reaches here.
      const settings = read({ codeHealth: { administrators: ["  ", "jane"] } });

      // then
      expect(settings.administrators).toEqual(["user:default/jane"]);
    });
  });
});
