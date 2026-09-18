import { DEFAULT_WAKATIME_BASE_URL } from "../../../src/domain/entities/ingestion_settings";
import type { WakaTimeSettings } from "../../../src/domain/entities/ingestion_settings";
import { RequestBudget } from "../../../src/domain/entities/request_budget";
import { ProviderGateway } from "../../../src/infrastructure/http/provider_gateway";
import { WakaTimeApiEnricher } from "../../../src/infrastructure/services/wakatime_enricher";
import { ControlledClock } from "../../doubles/controlled_clock";
import { RecordingLogger } from "../../doubles/recording_logger";
import { TestProviderServer } from "../../doubles/test_provider_server";

const server = new TestProviderServer();

beforeAll(async () => server.start());
afterAll(async () => server.stop());
beforeEach(() => server.reset());

const createEnricher = (overrides: Partial<WakaTimeSettings> = {}) => {
  const logger = new RecordingLogger();
  const enricher = new WakaTimeApiEnricher({
    gateway: new ProviderGateway({
      logger,
      concurrencyPerHost: 4,
      clock: new ControlledClock(1_000_000),
    }),
    settings: {
      organization: "example-org",
      dashboard: null,
      apiKey: "fixture-token-placeholder",
      baseUrl: server.baseUrl,
      historyDays: 30,
      includeAiMetrics: false,
      aiDaysPerRun: 3,
      requestBudgetPerRun: 500,
      ...overrides,
    },
    logger,
  });
  return { enricher, logger };
};

const window = (overrides: { aiDays?: readonly string[] } = {}) => ({
  from: "2026-08-09",
  to: "2026-08-10",
  aiDays: overrides.aiDays ?? [],
  context: { budget: new RequestBudget(50) },
});

/** The two calls that stand between the organisation and its members. */
const withDashboard = (members: unknown[]) =>
  server
    .onPath("/dashboards", () => ({ body: { data: [{ id: "dash-1", name: "Everyone" }] } }))
    .onPath("/members", () => ({ body: { data: members } }));

const aSummaryDay = (day: string, seconds: number, extras: Record<string, unknown> = {}) => ({
  grand_total: { total_seconds: seconds },
  range: { date: day },
  ...extras,
});

describe("WakaTimeApiEnricher", () => {
  it("should reach members through the organisation's dashboard", async () => {
    // given
    // There is no `/orgs/{org}/members`: members hang off a dashboard, and
    // asking for the shorter path returns a 404 that reads exactly like a
    // missing organisation.
    withDashboard([{ id: "member-1", user: { username: "dev" } }]).on("/summaries", () => ({
      body: { data: [aSummaryDay("2026-08-10", 3600)] },
    }));

    // when
    const harvest = await createEnricher().enricher.fetchWindow(window());

    // then
    const paths = server.requests.map((request) => request.path);
    expect(paths[0]).toBe("/users/current/orgs/example-org/dashboards");
    expect(paths[1]).toBe("/users/current/orgs/example-org/dashboards/dash-1/members");
    expect(paths[2]).toContain("/dashboards/dash-1/members/member-1/summaries");
    expect(harvest.byDay.get("2026-08-10")?.get("dev")?.totalSeconds).toBe(3600);
  });

  it("should address a member by their member id, not their username", async () => {
    // given
    // Getting this wrong returns empty summaries for everybody rather than
    // failing, which is the expensive kind of mistake.
    withDashboard([{ id: "member-42", user: { username: "dev" } }]).on("/summaries", () => ({
      body: { data: [] },
    }));

    // when
    await createEnricher().enricher.fetchWindow(window());

    // then
    expect(server.requestsFor("/summaries")[0]?.path).toContain("/members/member-42/");
  });

  it("should ask for the window it was given", async () => {
    // given
    withDashboard([{ id: "m", user: { username: "dev" } }]).on("/summaries", () => ({
      body: { data: [] },
    }));

    // when
    await createEnricher().enricher.fetchWindow(window());

    // then
    const query = server.requestsFor("/summaries")[0]?.query;
    expect(query?.get("start")).toBe("2026-08-09");
    expect(query?.get("end")).toBe("2026-08-10");
  });

  it("should authenticate with the key as HTTP basic", async () => {
    // given
    withDashboard([]).on("/dashboards", () => ({ body: { data: [] } }));

    // when
    await createEnricher().enricher.fetchWindow(window());

    // then
    const authorization = server.requests[0]?.headers.authorization;
    expect(authorization).toBe(
      `Basic ${Buffer.from("fixture-token-placeholder").toString("base64")}`,
    );
  });

  it("should record one measurement per day, keyed by the account", async () => {
    // given
    // Per-day rather than one rolling total, so the range picker can answer for
    // a past month instead of always reporting the last thirty days.
    withDashboard([{ id: "m", user: { username: "dev" } }]).on("/summaries", () => ({
      body: { data: [aSummaryDay("2026-08-09", 1800), aSummaryDay("2026-08-10", 3600)] },
    }));

    // when
    const harvest = await createEnricher().enricher.fetchWindow(window());

    // then
    expect([...harvest.byDay.keys()].sort()).toEqual(["2026-08-09", "2026-08-10"]);
    expect(harvest.byDay.get("2026-08-09")?.get("dev")?.activeDays).toBe(1);
  });

  it("should carry every breakdown the plan returned", async () => {
    // given
    withDashboard([{ id: "m", user: { username: "dev" } }]).on("/summaries", () => ({
      body: {
        data: [
          aSummaryDay("2026-08-10", 3600, {
            languages: [{ name: "Go", total_seconds: 3000, percent: 83.4 }],
            editors: [{ name: "VS Code", total_seconds: 3600, percent: 100 }],
            projects: [{ name: "code-health", total_seconds: 3600, percent: 100 }],
            branches: [{ name: "main", total_seconds: 3600, percent: 100 }],
            entities: [{ name: "a.go" }, { name: "b.go" }],
          }),
        ],
      },
    }));

    // when
    const harvest = await createEnricher().enricher.fetchWindow(window());

    // then
    const metrics = harvest.byDay.get("2026-08-10")?.get("dev");
    expect(metrics?.languages).toEqual([
      { name: "Go", totalSeconds: 3000, percent: 83.4 },
    ]);
    expect(metrics?.branches[0]?.name).toBe("main");
    expect(metrics?.filesTouched).toBe(2);
  });

  it("should report an unknown file count when the plan omits entities", async () => {
    // given
    // An absent list is indistinguishable at the wire level from an empty one,
    // and zero files edited by somebody who spent the day in an editor is the
    // wrong answer to report.
    withDashboard([{ id: "m", user: { username: "dev" } }]).on("/summaries", () => ({
      body: { data: [aSummaryDay("2026-08-10", 3600)] },
    }));

    // when
    const harvest = await createEnricher().enricher.fetchWindow(window());

    // then
    expect(harvest.byDay.get("2026-08-10")?.get("dev")?.filesTouched).toBeNull();
  });

  it("should drop a nameless slice rather than charting it as undefined", async () => {
    // given
    withDashboard([{ id: "m", user: { username: "dev" } }]).on("/summaries", () => ({
      body: {
        data: [
          aSummaryDay("2026-08-10", 60, {
            languages: [{ total_seconds: 60, percent: 100 }, { name: "", total_seconds: 1 }],
          }),
        ],
      },
    }));

    // when
    const harvest = await createEnricher().enricher.fetchWindow(window());

    // then
    expect(harvest.byDay.get("2026-08-10")?.get("dev")?.languages).toEqual([]);
  });

  it("should report every account it saw, including one that logged nothing", async () => {
    // given
    // An account with a quiet month is still an account somebody may need to
    // link, and the Identities screen is where they would look for it.
    withDashboard([
      { id: "m", user: { username: "dev", display_name: "Dev", email: "dev@example.com", photo: "p.png" } },
    ]).on("/summaries", () => ({ body: { data: [] } }));

    // when
    const harvest = await createEnricher().enricher.fetchWindow(window());

    // then
    expect(harvest.identities).toEqual([
      {
        source: "wakatime",
        sourceKey: "dev",
        displayName: "Dev",
        email: "dev@example.com",
        avatarUrl: "p.png",
        profileUrl: "https://wakatime.com/@dev",
      },
    ]);
  });

  it("should lowercase the account key so two spellings are one account", async () => {
    // given
    withDashboard([{ id: "m", user: { username: "DevOps" } }]).on("/summaries", () => ({
      body: { data: [] },
    }));

    // when
    const harvest = await createEnricher().enricher.fetchWindow(window());

    // then
    expect(harvest.identities[0]?.sourceKey).toBe("devops");
  });

  it("should skip a member with neither a username nor an id", async () => {
    // given
    withDashboard([{ user: {} }, { id: "m", user: { username: "dev" } }]).on(
      "/summaries",
      () => ({ body: { data: [] } }),
    );

    // when
    const harvest = await createEnricher().enricher.fetchWindow(window());

    // then
    expect(harvest.identities.map((identity) => identity.sourceKey)).toEqual(["dev"]);
  });

  it("should pick the dashboard the configuration names", async () => {
    // given
    server
      .onPath("/dashboards", () => ({
        body: { data: [{ id: "dash-1", name: "Everyone" }, { id: "dash-2", name: "Platform" }] },
      }))
      .onPath("/members", () => ({ body: { data: [] } }));

    // when
    await createEnricher({ dashboard: "Platform" }).enricher.fetchWindow(window());

    // then
    expect(server.requestsFor("/members")[0]?.path).toContain("/dashboards/dash-2/");
  });

  it("should warn and collect nothing when the named dashboard does not exist", async () => {
    // given
    server.onPath("/dashboards", () => ({ body: { data: [{ id: "dash-1", name: "Everyone" }] } }));

    // when
    const { enricher, logger } = createEnricher({ dashboard: "Missing" });
    const harvest = await enricher.fetchWindow(window());

    // then
    expect(harvest.identities).toEqual([]);
    expect(logger.at("warn").join(" ")).toContain("no dashboard called Missing");
  });

  it("should warn and collect nothing when the organisation has no dashboard", async () => {
    // given
    server.onPath("/dashboards", () => ({ body: { data: [] } }));

    // when
    const { enricher, logger } = createEnricher();
    const harvest = await enricher.fetchWindow(window());

    // then
    expect(harvest.identities).toEqual([]);
    expect(logger.at("warn").join(" ")).toContain("no dashboard to read");
  });

  it("should warn and collect nothing when the members call fails", async () => {
    // given
    server
      .onPath("/dashboards", () => ({ body: { data: [{ id: "dash-1" }] } }))
      .onPath("/members", () => ({ status: 403, body: { error: "no seat" } }));

    // when
    const { enricher, logger } = createEnricher();
    const harvest = await enricher.fetchWindow(window());

    // then
    expect(harvest.byDay.size).toBe(0);
    expect(logger.at("warn").join(" ")).toContain("could not list WakaTime members");
  });

  it("should keep the rest of the organisation when one member's history is unreadable", async () => {
    // given
    // A revoked seat, or a plan that does not cover the span, must not cost
    // everybody else's numbers.
    withDashboard([
      { id: "broken", user: { username: "broken" } },
      { id: "fine", user: { username: "fine" } },
    ]).on("/summaries", (request) =>
      request.path.includes("/broken/")
        ? { status: 402, body: { error: "upgrade required" } }
        : { body: { data: [aSummaryDay("2026-08-10", 600)] } },
    );

    // when
    const harvest = await createEnricher().enricher.fetchWindow(window());

    // then
    expect(harvest.byDay.get("2026-08-10")?.get("fine")?.totalSeconds).toBe(600);
    expect(harvest.byDay.get("2026-08-10")?.has("broken")).toBe(false);
  });

  it("should measure the key's own account when no organisation is configured", async () => {
    // given
    // The useful behaviour on a personal plan: the alternative is an
    // integration that silently collects nothing.
    server
      .onPath("/users/current", () => ({ body: { data: { username: "solo" } } }))
      .on("/summaries", () => ({ body: { data: [aSummaryDay("2026-08-10", 900)] } }));

    // when
    const harvest = await createEnricher({ organization: null }).enricher.fetchWindow(window());

    // then
    expect(harvest.byDay.get("2026-08-10")?.get("solo")?.totalSeconds).toBe(900);
    expect(server.requestsFor("/summaries")[0]?.path).toBe("/users/current/summaries");
  });

  it("should warn and collect nothing when the personal account is unreadable", async () => {
    // given
    server.onPath("/users/current", () => ({ status: 401, body: { error: "bad key" } }));

    // when
    const { enricher, logger } = createEnricher({ organization: null });
    const harvest = await enricher.fetchWindow(window());

    // then
    expect(harvest.identities).toEqual([]);
    expect(logger.at("warn").join(" ")).toContain("could not read the WakaTime account");
  });

  it("should resolve the members once and reuse them on the next run", async () => {
    // given
    // The dashboard and its membership change on a human timescale; re-walking
    // two endpoints every night to learn the same answer is budget spent on
    // nothing.
    withDashboard([{ id: "m", user: { username: "dev" } }]).on("/summaries", () => ({
      body: { data: [] },
    }));
    const { enricher } = createEnricher();

    // when
    await enricher.fetchWindow(window());
    await enricher.fetchWindow(window());

    // then
    expect(server.requestsFor("/dashboards").filter((r) => r.path.endsWith("/dashboards"))).toHaveLength(1);
    expect(server.requestsFor("/summaries")).toHaveLength(2);
  });

  it("should retry the lookup after a failed one rather than latching it", async () => {
    // given
    // A failed resolve reports an empty list, and memoising that would leave one
    // transient 500 on the dashboards call collecting nothing at all until the
    // backend process is restarted — with a single warning, days earlier, as
    // the only trace.
    // 403 rather than 500, so the gateway does not retry it: the point is one
    // failed resolve, not one failed request.
    let resolves = 0;
    server
      .onPath("/dashboards", () => {
        resolves += 1;
        return resolves === 1
          ? { status: 403, body: { error: "try again" } }
          : { body: { data: [{ id: "dash-1", name: "Everyone" }] } };
      })
      .onPath("/members", () => ({ body: { data: [{ id: "m", user: { username: "dev" } }] } }))
      .on("/summaries", () => ({ body: { data: [aSummaryDay("2026-08-10", 60)] } }));
    const { enricher } = createEnricher();

    // when
    const first = await enricher.fetchWindow(window());
    const second = await enricher.fetchWindow(window());

    // then
    expect(first.identities).toEqual([]);
    expect(second.identities.map((identity) => identity.sourceKey)).toEqual(["dev"]);
  });

  it("should retry when the organisation had no dashboard yet", async () => {
    // given
    // A dashboard created after the first pass would otherwise never be seen.
    let resolves = 0;
    server
      .onPath("/dashboards", () => {
        resolves += 1;
        return resolves === 1
          ? { body: { data: [] } }
          : { body: { data: [{ id: "dash-1", name: "Everyone" }] } };
      })
      .onPath("/members", () => ({ body: { data: [{ id: "m", user: { username: "dev" } }] } }))
      .on("/summaries", () => ({ body: { data: [] } }));
    const { enricher } = createEnricher();

    // when
    await enricher.fetchWindow(window());
    const second = await enricher.fetchWindow(window());

    // then
    expect(second.identities.map((identity) => identity.sourceKey)).toEqual(["dev"]);
  });

  describe("AI metrics", () => {
    it("should read tokens and authorship from the durations resource", async () => {
      // given
      // The only place in the plugin a token count exists: WakaTime measures it
      // at the editor, and no version control provider knows whether a line was
      // typed or accepted from a completion.
      withDashboard([{ id: "m", user: { username: "dev" } }])
        .on("/summaries", () => ({ body: { data: [aSummaryDay("2026-08-10", 3600)] } }))
        .on("/durations", () => ({
          body: {
            data: [
              {
                ai_input_tokens: 1000,
                ai_output_tokens: 200,
                ai_additions: 30,
                human_additions: 70,
                ai_prompt_events_total: 4,
                ai_sessions: 1,
                ai_model_costs: { "claude-opus": 0.5 },
              },
              { ai_input_tokens: 500, ai_model_costs: { "claude-opus": 0.25 } },
            ],
          },
        }));

      // when
      const harvest = await createEnricher().enricher.fetchWindow(
        window({ aiDays: ["2026-08-10"] }),
      );

      // then
      const ai = harvest.byDay.get("2026-08-10")?.get("dev")?.ai;
      expect(ai).toEqual({
        inputTokens: 1500,
        outputTokens: 200,
        linesAddedByAi: 30,
        linesDeletedByAi: 0,
        linesAddedByHuman: 70,
        linesDeletedByHuman: 0,
        prompts: 4,
        sessions: 1,
        modelCosts: { "claude-opus": 0.75 },
        daysMeasured: 1,
      });
      expect(server.requestsFor("/durations")[0]?.query.get("date")).toBe("2026-08-10");
    });

    it("should record a day of AI figures even when no summary covered it", async () => {
      // given
      // The two resources answer independently, and losing the AI numbers
      // because the summary happened to be empty would be silent data loss.
      withDashboard([{ id: "m", user: { username: "dev" } }])
        .on("/summaries", () => ({ body: { data: [] } }))
        .on("/durations", () => ({ body: { data: [{ ai_input_tokens: 10 }] } }));

      // when
      const harvest = await createEnricher().enricher.fetchWindow(
        window({ aiDays: ["2026-08-10"] }),
      );

      // then
      const metrics = harvest.byDay.get("2026-08-10")?.get("dev");
      expect(metrics?.totalSeconds).toBe(0);
      expect(metrics?.ai?.inputTokens).toBe(10);
    });

    it("should leave the AI figures null when the durations resource refuses", async () => {
      // given
      // Null says "not collected", which is the truth. Zeros would say nobody
      // used AI that day, which is a different and false claim.
      withDashboard([{ id: "m", user: { username: "dev" } }])
        .on("/summaries", () => ({ body: { data: [aSummaryDay("2026-08-10", 60)] } }))
        .on("/durations", () => ({ status: 402, body: { error: "upgrade required" } }));

      // when
      const harvest = await createEnricher().enricher.fetchWindow(
        window({ aiDays: ["2026-08-10"] }),
      );

      // then
      expect(harvest.byDay.get("2026-08-10")?.get("dev")?.ai).toBeNull();
    });

    it("should not touch the durations resource when no AI day was asked for", async () => {
      // given
      // It costs one request per member per day, against one request per member
      // for the whole window, which is why it is opt-in.
      withDashboard([{ id: "m", user: { username: "dev" } }]).on("/summaries", () => ({
        body: { data: [aSummaryDay("2026-08-10", 60)] },
      }));

      // when
      await createEnricher().enricher.fetchWindow(window());

      // then
      expect(server.requestsFor("/durations")).toHaveLength(0);
    });

    it("should ignore a cost the provider did not report as a number", async () => {
      // given
      withDashboard([{ id: "m", user: { username: "dev" } }])
        .on("/summaries", () => ({ body: { data: [] } }))
        .on("/durations", () => ({
          body: { data: [{ ai_model_costs: { broken: "free", "gpt-5": 1 } }] },
        }));

      // when
      const harvest = await createEnricher().enricher.fetchWindow(
        window({ aiDays: ["2026-08-10"] }),
      );

      // then
      expect(harvest.byDay.get("2026-08-10")?.get("dev")?.ai?.modelCosts).toEqual({ "gpt-5": 1 });
    });
  });
});

describe("DEFAULT_WAKATIME_BASE_URL", () => {
  it("should point at the hosted API", () => {
    // given / when / then
    expect(DEFAULT_WAKATIME_BASE_URL).toBe("https://wakatime.com/api/v1");
  });
});
