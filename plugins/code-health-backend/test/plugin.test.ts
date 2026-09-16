import { mockServices, startTestBackend, TestDatabases } from "@backstage/backend-test-utils";
import type { Entity } from "@backstage/catalog-model";
import { catalogServiceMock } from "@backstage/plugin-catalog-node/testUtils";
import { AuthorizeResult } from "@backstage/plugin-permission-common";
import request from "supertest";
import { codeHealthPlugin } from "../src/plugin";

// The database is supplied explicitly rather than letting the backend create
// its own, so `TestDatabases` owns the connection lifecycle and Jest workers
// exit cleanly instead of being force-killed with a leak warning.
const databases = TestDatabases.create({ ids: ["SQLITE_3"], disableDocker: true });

/**
 * End-to-end tests for the plugin as a host application wires it: real
 * migrations against a real in-memory database, a real scheduler, and a
 * catalog it can actually read.
 */
const componentWithSlug = (name: string, slug: string): Entity => ({
  apiVersion: "backstage.io/v1alpha1",
  kind: "Component",
  metadata: {
    name,
    namespace: "default",
    annotations: { "github.com/project-slug": slug },
  },
  spec: { type: "service", owner: "team-a" },
});

/** A catalog user with the profile the directory search reads. */
const aUser = (name: string, displayName: string, email: string): Entity => ({
  apiVersion: "backstage.io/v1alpha1",
  kind: "User",
  metadata: { name, namespace: "default" },
  spec: { profile: { displayName, email }, memberOf: [] },
});

const started: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  // Without this the scheduler keeps its timers alive and Jest force-exits the
  // worker, which hides real leaks behind a warning.
  await Promise.all(started.splice(0).map((backend) => backend.stop()));
});

const startBackend = async (
  entities: Entity[],
  integrations: Record<string, unknown> = {},
  extraFeatures: Parameters<typeof startTestBackend>[0]["features"] = [],
) => {
  const knex = await databases.init("SQLITE_3");
  const backend = await startTestBackend({
    features: [
      codeHealthPlugin,
      mockServices.database.factory({ knex }),
      catalogServiceMock.factory({ entities }),
      mockServices.rootConfig.factory({
        data: {
          integrations: {
            github: [{ host: "github.com", token: "fixture-token-placeholder" }],
          },
          codeHealth: {
            ingestion: {
              // `startTestBackend` runs scheduled tasks immediately, so a short
              // frequency here keeps the test from waiting on the default.
              discoverySchedule: { frequency: { seconds: 1 }, timeout: { seconds: 30 } },
              // Ingestion is held back to a manual trigger. Left on a schedule
              // it would start immediately and issue real requests to
              // api.github.com, which would make this suite slow, flaky and
              // dependent on the network. What it does with a window is covered
              // against a real server elsewhere.
              schedule: { frequency: { trigger: "manual" }, timeout: { minutes: 1 } },
              snapshotSchedule: { frequency: { trigger: "manual" }, timeout: { minutes: 1 } },
            },
            ...integrations,
          },
        },
      }),
      ...(extraFeatures ?? []),
    ],
  });

  started.push(backend);
  return backend;
};

/**
 * The reference `mockServices.userInfo` derives from the default mock user, and
 * the only thing it puts in `ownershipEntityRefs`. Configuring this as an
 * administrator is what a real install does by naming a person in
 * `codeHealth.administrators`.
 */
const MOCK_USER = "user:default/mock";

/** Polls until `check` passes, so the test does not race the scheduled task. */
const waitFor = async (check: () => Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition was not met before the deadline");
};

describe("codeHealthPlugin", () => {
  it("should answer the health probe without authentication", async () => {
    // given
    const { server } = await startBackend([]);

    // when
    const response = await request(server).get("/api/code-health/health");

    // then
    // The frontend probes this before rendering; requiring a token would make
    // "not installed" and "not signed in" indistinguishable.
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("should reject an unauthenticated call to a data route", async () => {
    // given
    const { server } = await startBackend([]);

    // when
    const response = await request(server)
      .get("/api/code-health/v1/coverage")
      .set("Authorization", "Bearer mock-none-token");

    // then
    expect(response.status).toBe(401);
  });

  it("should report empty coverage before anything is discovered", async () => {
    // given
    const { server } = await startBackend([]);

    // when
    const response = await request(server).get("/api/code-health/v1/coverage");

    // then
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      earliestDay: null,
      latestDay: null,
      backfill: { repositories: 0, complete: 0, percent: 0 },
    });
  });

  it("should discover repositories from the catalog when the task runs", async () => {
    // given
    const { server } = await startBackend([
      componentWithSlug("pipelines", "rios0rios0/pipelines"),
      componentWithSlug("autobump", "rios0rios0/autobump"),
    ]);

    // when
    // `startTestBackend` installs a scheduler that runs registered tasks
    // immediately, so discovery is already in flight; this waits for it.
    await waitFor(async () => {
      const response = await request(server).get("/api/code-health/v1/coverage");
      return response.body.backfill.repositories === 2;
    });

    // then
    const response = await request(server).get("/api/code-health/v1/coverage");
    expect(response.body.backfill.repositories).toBe(2);
  });

  it("should ignore catalog entities that name no supported repository", async () => {
    // given
    const { server } = await startBackend([
      componentWithSlug("pipelines", "rios0rios0/pipelines"),
      {
        apiVersion: "backstage.io/v1alpha1",
        kind: "Component",
        metadata: { name: "no-annotations", namespace: "default", annotations: {} },
        spec: { type: "service", owner: "team-a" },
      },
    ]);

    // when
    // `startTestBackend` installs a scheduler that runs registered tasks
    // immediately, so discovery is already in flight; this waits for it.
    await waitFor(async () => {
      const response = await request(server).get("/api/code-health/v1/coverage");
      return response.body.backfill.repositories === 1;
    });

    // then
    const response = await request(server).get("/api/code-health/v1/coverage");
    expect(response.body.backfill.repositories).toBe(1);
  });

  it("should expose how fresh the data is once ingestion has run", async () => {
    // given
    // The dashboard needs a ceiling it can trust. `freshUntil` is the minimum
    // across repositories, so it states the point *every* one has data through
    // rather than the point the luckiest one reached.
    const { server } = await startBackend([componentWithSlug("pipelines", "rios0rios0/pipelines")]);

    // when
    await waitFor(async () => {
      const response = await request(server).get("/api/code-health/v1/coverage");
      return response.body.backfill.repositories === 1;
    });

    // then
    const response = await request(server).get("/api/code-health/v1/coverage");
    expect(response.body).toHaveProperty("freshUntil");
  });


  describe("the read API", () => {
    it("should default to the last day when no window is given", async () => {
      // given
      const { server } = await startBackend([]);

      // when
      const response = await request(server).get("/api/code-health/v1/repositories");

      // then
      // A freshly installed plugin can only answer for the last day, so that is
      // what it answers with unless asked otherwise.
      expect(response.status).toBe(200);
      const span =
        Date.parse(response.body.window.to) - Date.parse(response.body.window.from);
      expect(span).toBe(24 * 60 * 60 * 1000);
    });

    it("should honour an explicit window", async () => {
      // given
      const { server } = await startBackend([]);

      // when
      const response = await request(server)
        .get("/api/code-health/v1/repositories")
        .query({ from: "2026-08-01T00:00:00.000Z", to: "2026-08-08T00:00:00.000Z" });

      // then
      expect(response.body.window).toEqual({
        from: "2026-08-01T00:00:00.000Z",
        to: "2026-08-08T00:00:00.000Z",
      });
    });

    it("should reject a window longer than the retention period", async () => {
      // given
      // An unbounded window would make one request scan the whole event table,
      // which any signed-in user could trigger by editing a URL.
      const { server } = await startBackend([]);

      // when
      const response = await request(server)
        .get("/api/code-health/v1/repositories")
        .query({ from: "2000-01-01T00:00:00.000Z", to: "2026-08-10T00:00:00.000Z" });

      // then
      expect(response.status).toBe(400);
    });

    it("should reject an inverted window", async () => {
      // given
      const { server } = await startBackend([]);

      // when
      const response = await request(server)
        .get("/api/code-health/v1/repositories")
        .query({ from: "2026-08-10T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z" });

      // then
      expect(response.status).toBe(400);
    });

    it("should reject an unparseable instant", async () => {
      // given
      const { server } = await startBackend([]);

      // when
      const response = await request(server)
        .get("/api/code-health/v1/repositories")
        .query({ from: "last tuesday" });

      // then
      expect(response.status).toBe(400);
    });

    it("should list the discovered repositories", async () => {
      // given
      const { server } = await startBackend([
        componentWithSlug("pipelines", "rios0rios0/pipelines"),
      ]);
      await waitFor(async () => {
        const response = await request(server).get("/api/code-health/v1/coverage");
        return response.body.backfill.repositories === 1;
      });

      // when
      const response = await request(server).get("/api/code-health/v1/repositories");

      // then
      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0]).toMatchObject({
        name: "pipelines",
        entityRef: "component:default/pipelines",
        platform: "github",
      });
    });

    it("should answer the contributors route with an empty list before ingestion", async () => {
      // given
      const { server } = await startBackend([]);

      // when
      const response = await request(server).get("/api/code-health/v1/contributors");

      // then
      expect(response.status).toBe(200);
      expect(response.body.items).toEqual([]);
    });

    it("should reject a repeated repositoryId filter", async () => {
      // given
      const { server } = await startBackend([]);

      // when
      const response = await request(server).get(
        "/api/code-health/v1/contributors?repositoryId=a&repositoryId=b",
      );

      // then
      expect(response.status).toBe(400);
    });

    it("should answer 404 for a repository it does not track", async () => {
      // given
      const { server } = await startBackend([]);

      // when
      const response = await request(server).get(
        "/api/code-health/v1/repositories/does-not-exist/timeseries",
      );

      // then
      expect(response.status).toBe(404);
    });

    it("should return a time series for a tracked repository", async () => {
      // given
      const { server } = await startBackend([
        componentWithSlug("pipelines", "rios0rios0/pipelines"),
      ]);
      await waitFor(async () => {
        const response = await request(server).get("/api/code-health/v1/repositories");
        return response.body.items.length === 1;
      });
      const [repository] = (await request(server).get("/api/code-health/v1/repositories")).body
        .items;

      // when
      const response = await request(server)
        .get(`/api/code-health/v1/repositories/${repository.id}/timeseries`)
        .query({ from: "2026-08-01T00:00:00.000Z", to: "2026-08-04T00:00:00.000Z" });

      // then
      expect(response.status).toBe(200);
      expect(response.body.bucket).toBe("day");
      expect(response.body.points.map((point: { day: string }) => point.day)).toEqual([
        "2026-08-01",
        "2026-08-02",
        "2026-08-03",
      ]);
    });

    it("should return a fleet-wide time series", async () => {
      // given
      // Registered before the per-repository route so the literal path is not
      // swallowed by `:id`.
      const { server } = await startBackend([]);

      // when
      const response = await request(server)
        .get("/api/code-health/v1/timeseries")
        .query({ from: "2026-08-01T00:00:00.000Z", to: "2026-08-03T00:00:00.000Z" });

      // then
      expect(response.status).toBe(200);
      expect(response.body.points.map((point: { day: string }) => point.day)).toEqual([
        "2026-08-01",
        "2026-08-02",
      ]);
    });

    it("should honour an explicit bucket", async () => {
      // given
      const { server } = await startBackend([]);

      // when
      const response = await request(server)
        .get("/api/code-health/v1/timeseries")
        .query({
          from: "2026-08-03T00:00:00.000Z",
          to: "2026-08-10T00:00:00.000Z",
          bucket: "week",
        });

      // then
      expect(response.body.bucket).toBe("week");
      expect(response.body.points.map((point: { day: string }) => point.day)).toEqual([
        "2026-08-03",
      ]);
    });

    it("should narrow the identities to one source", async () => {
      // given
      const { server } = await startBackend([]);

      // when
      const response = await request(server)
        .get("/api/code-health/v1/identities")
        .query({ source: "vcs" });

      // then
      expect(response.status).toBe(200);
      expect(response.body.items).toEqual([]);
    });

    it("should reject an unsupported bucket", async () => {
      // given
      const { server } = await startBackend([
        componentWithSlug("pipelines", "rios0rios0/pipelines"),
      ]);
      await waitFor(async () => {
        const response = await request(server).get("/api/code-health/v1/repositories");
        return response.body.items.length === 1;
      });
      const [repository] = (await request(server).get("/api/code-health/v1/repositories")).body
        .items;

      // when
      const response = await request(server)
        .get(`/api/code-health/v1/repositories/${repository.id}/timeseries`)
        .query({ bucket: "hour" });

      // then
      expect(response.status).toBe(400);
    });

    it("should trigger the background tasks on refresh", async () => {
      // given
      const { server } = await startBackend([]);

      // when
      const response = await request(server).post("/api/code-health/v1/refresh");

      // then
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.triggered)).toBe(true);
    });

    it("should report every integration disabled when none is configured", async () => {
      // given
      // Told apart from "on but not collected yet", which wants completely
      // different words on the screen.
      const { server } = await startBackend([]);

      // when
      const response = await request(server).get("/api/code-health/v1/capabilities");

      // then
      expect(response.status).toBe(200);
      expect(response.body.integrations).toEqual({
        wakatime: false,
        jira: false,
        confluence: false,
      });
    });

    it("should light up both Atlassian products from one credential", async () => {
      // given
      const { server } = await startBackend([], {
        wakaTime: { apiKey: "fixture-token-placeholder" },
        atlassian: {
          baseUrl: "https://acme.atlassian.net",
          email: "bot@acme.com",
          apiToken: "fixture-token-placeholder",
        },
      });

      // when
      const response = await request(server).get("/api/code-health/v1/capabilities");

      // then
      expect(response.body.integrations).toEqual({
        wakatime: true,
        jira: true,
        confluence: true,
      });
    });

    it("should find catalog users by part of their name", async () => {
      // given
      // The other half of a link, found by typing part of a name rather than
      // the whole entity reference.
      const { server } = await startBackend([
        aUser("jane", "Jane Roe", "jane@acme.com"),
        aUser("john", "John Roe", "john@acme.com"),
        aUser("ana", "Ana Costa", "ana@acme.com"),
      ]);

      // when
      const response = await request(server)
        .get("/api/code-health/v1/identities/users")
        .query({ q: "roe" });

      // then
      expect(response.status).toBe(200);
      expect(response.body.items).toEqual([
        {
          entityRef: "user:default/jane",
          displayName: "Jane Roe",
          email: "jane@acme.com",
          picture: null,
        },
        {
          entityRef: "user:default/john",
          displayName: "John Roe",
          email: "john@acme.com",
          picture: null,
        },
      ]);
    });

    it("should answer an empty search with nobody", async () => {
      // given
      const { server } = await startBackend([aUser("jane", "Jane Roe", "jane@acme.com")]);

      // when
      const response = await request(server).get("/api/code-health/v1/identities/users");

      // then
      expect(response.status).toBe(200);
      expect(response.body.items).toEqual([]);
    });

    it("should honour a search limit and reject one it cannot", async () => {
      // given
      const { server } = await startBackend([
        aUser("jane", "Jane Roe", "jane@acme.com"),
        aUser("john", "John Roe", "john@acme.com"),
      ]);

      // when
      const limited = await request(server)
        .get("/api/code-health/v1/identities/users")
        .query({ q: "roe", limit: 1 });
      const refused = await request(server)
        .get("/api/code-health/v1/identities/users")
        .query({ q: "roe", limit: 0 });

      // then
      expect(limited.body.items).toHaveLength(1);
      expect(refused.status).toBe(400);
    });

    it("should list no identities before anything has been observed", async () => {
      // given
      const { server } = await startBackend([]);

      // when
      const response = await request(server).get("/api/code-health/v1/identities");

      // then
      expect(response.status).toBe(200);
      expect(response.body.items).toEqual([]);
    });

    it("should reject a source the plugin does not know", async () => {
      // given
      // Silently returning every source would look like a filter that does not
      // work.
      const { server } = await startBackend([]);

      // when
      const response = await request(server)
        .get("/api/code-health/v1/identities")
        .query({ source: "sonar" });

      // then
      expect(response.status).toBe(400);
    });

    it("should reject a `linked` filter that is not a boolean", async () => {
      // given
      const { server } = await startBackend([]);

      // when
      const response = await request(server)
        .get("/api/code-health/v1/identities")
        .query({ linked: "maybe" });

      // then
      expect(response.status).toBe(400);
    });

    it("should refuse to link an account nobody has observed", async () => {
      // given
      // A link that matches nothing looks exactly like one that worked.
      const { server } = await startBackend([]);

      // when
      const response = await request(server)
        .put("/api/code-health/v1/identities/links")
        .send({ source: "wakatime", sourceKey: "ghost", entityRef: "user:default/felipe" });

      // then
      expect(response.status).toBe(404);
    });

    it("should reject a link naming a source it does not know", async () => {
      // given
      const { server } = await startBackend([]);

      // when
      const response = await request(server)
        .put("/api/code-health/v1/identities/links")
        .send({ source: "sonar", sourceKey: "x", entityRef: "user:default/felipe" });

      // then
      expect(response.status).toBe(400);
    });

    it("should reject a reference that is not one at all", async () => {
      // given
      // A bare name reaches the catalog's own parser, which throws rather than
      // answering — the screen would show a 500 where it promises to say
      // plainly that the user does not exist.
      const { server } = await startBackend([]);

      // when
      const response = await request(server)
        .put("/api/code-health/v1/identities/links")
        .send({ source: "wakatime", sourceKey: "jrios", entityRef: "felipe" });

      // then
      expect(response.status).toBe(400);
    });

    it("should reject a link with nothing to link", async () => {
      // given
      const { server } = await startBackend([]);

      // when
      const response = await request(server)
        .put("/api/code-health/v1/identities/links")
        .send({ source: "wakatime", sourceKey: "", entityRef: "" });

      // then
      expect(response.status).toBe(400);
    });

    it("should refuse a link from a service rather than a person", async () => {
      // given
      // A manual link is a human's statement that two accounts are the same
      // person; who made it is recorded, and a service account cannot.
      const { server } = await startBackend([]);

      // when
      const response = await request(server)
        .put("/api/code-health/v1/identities/links")
        .set("Authorization", "Bearer mock-service-token")
        .send({ source: "wakatime", sourceKey: "x", entityRef: "user:default/felipe" });

      // then
      expect(response.status).toBe(403);
    });

    it("should accept removing a link that is not there", async () => {
      // given
      // `DELETE` is idempotent, and a screen that failed on a second click
      // would be worse than one that shrugged.
      const { server } = await startBackend([]);

      // when
      const response = await request(server).delete(
        "/api/code-health/v1/identities/links/wakatime/ghost",
      );

      // then
      expect(response.status).toBe(204);
    });

    it("should reject removing a link for a source it does not know", async () => {
      // given
      const { server } = await startBackend([]);

      // when
      const response = await request(server).delete(
        "/api/code-health/v1/identities/links/sonar/ghost",
      );

      // then
      expect(response.status).toBe(400);
    });

    it("should reject an `excluded` filter that is not a boolean", async () => {
      // given
      const { server } = await startBackend([]);

      // when
      const response = await request(server)
        .get("/api/code-health/v1/identities")
        .query({ excluded: "maybe" });

      // then
      expect(response.status).toBe(400);
    });

    it("should refuse to exclude an account nobody has observed", async () => {
      // given
      // An exclusion that matches nothing leaves the tables exactly as they
      // were, and looks exactly like one that worked.
      const { server } = await startBackend([]);

      // when
      const response = await request(server)
        .put("/api/code-health/v1/identities/exclusions")
        .send({ source: "vcs", sourceKey: "ghost", reason: "automated-bot" });

      // then
      expect(response.status).toBe(404);
    });

    it("should reject an exclusion naming a source it does not know", async () => {
      // given
      const { server } = await startBackend([]);

      // when
      const response = await request(server)
        .put("/api/code-health/v1/identities/exclusions")
        .send({ source: "sonar", sourceKey: "x", reason: "automated-bot" });

      // then
      expect(response.status).toBe(400);
    });

    it("should reject an exclusion with a reason nobody can review", async () => {
      // given
      // The reason is the whole justification for a row disappearing from every
      // table, so there is no shape of this request that omits or invents one.
      const { server } = await startBackend([]);

      // when
      const response = await request(server)
        .put("/api/code-health/v1/identities/exclusions")
        .send({ source: "vcs", sourceKey: "x", reason: "because I said so" });

      // then
      expect(response.status).toBe(400);
    });

    it("should refuse an exclusion from a service rather than a person", async () => {
      // given
      // This is the write that makes rows disappear from every table, and the
      // only thing that makes it reviewable later is a name beside the reason.
      const { server } = await startBackend([]);

      // when
      const response = await request(server)
        .put("/api/code-health/v1/identities/exclusions")
        .set("Authorization", "Bearer mock-service-token")
        .send({ source: "vcs", sourceKey: "x", reason: "automated-bot" });

      // then
      expect(response.status).toBe(403);
    });

    it("should accept measuring an account that was never excluded", async () => {
      // given
      // `DELETE` is idempotent, and a screen that failed on a second click
      // would be worse than one that shrugged.
      const { server } = await startBackend([]);

      // when
      const response = await request(server).delete(
        "/api/code-health/v1/identities/exclusions/vcs/ghost",
      );

      // then
      expect(response.status).toBe(204);
    });

    it("should reject measuring an account again for a source it does not know", async () => {
      // given
      const { server } = await startBackend([]);

      // when
      const response = await request(server).delete(
        "/api/code-health/v1/identities/exclusions/sonar/ghost",
      );

      // then
      expect(response.status).toBe(400);
    });

    it("should refuse a refresh from a service rather than a person", async () => {
      // given
      // The route exists so someone looking at stale numbers can ask for a run,
      // and attributing that to a person is the point.
      const { server } = await startBackend([]);

      // when
      const response = await request(server)
        .post("/api/code-health/v1/refresh")
        .set("Authorization", "Bearer mock-service-token");

      // then
      expect(response.status).toBe(403);
    });
  });

  describe("trends", () => {
    it("should answer 404 for a repository it does not track", async () => {
      // given
      const { server } = await startBackend([]);

      // when
      const response = await request(server).get(
        "/api/code-health/v1/repositories/does-not-exist/trend",
      );

      // then
      expect(response.status).toBe(404);
    });

    it("should return a trend for a tracked repository", async () => {
      // given
      const { server } = await startBackend([
        componentWithSlug("pipelines", "rios0rios0/pipelines"),
      ]);
      await waitFor(async () => {
        const response = await request(server).get("/api/code-health/v1/repositories");
        return response.body.items.length === 1;
      });
      const [repository] = (await request(server).get("/api/code-health/v1/repositories")).body
        .items;

      // when
      const response = await request(server)
        .get(`/api/code-health/v1/repositories/${repository.id}/trend`)
        .query({ from: "2026-08-01T00:00:00.000Z", to: "2026-08-04T00:00:00.000Z" });

      // then
      expect(response.status).toBe(200);
      expect(response.body.id).toBe(repository.id);
      expect(response.body.bucket).toBe("day");
      expect(response.body.points.map((point: { day: string }) => point.day)).toEqual([
        "2026-08-01",
        "2026-08-02",
        "2026-08-03",
      ]);
      expect(response.body.summary.name).toBe("pipelines");
      expect(response.body.score).toHaveProperty("components");
    });

    it("should reject an unsupported bucket on a repository trend", async () => {
      // given
      const { server } = await startBackend([
        componentWithSlug("pipelines", "rios0rios0/pipelines"),
      ]);
      await waitFor(async () => {
        const response = await request(server).get("/api/code-health/v1/repositories");
        return response.body.items.length === 1;
      });
      const [repository] = (await request(server).get("/api/code-health/v1/repositories")).body
        .items;

      // when
      const response = await request(server)
        .get(`/api/code-health/v1/repositories/${repository.id}/trend`)
        .query({ bucket: "hour" });

      // then
      expect(response.status).toBe(400);
    });

    it("should answer a contributor trend for a key nothing was recorded under", async () => {
      // given
      // A stale link and a quiet month want different words on the screen, so
      // the points are still returned and the summary says which it is.
      const { server } = await startBackend([]);

      // when
      const response = await request(server)
        .get("/api/code-health/v1/contributors/vcs%3Aghost%40example.com/trend")
        .query({ from: "2026-08-01T00:00:00.000Z", to: "2026-08-04T00:00:00.000Z" });

      // then
      expect(response.status).toBe(200);
      expect(response.body.key).toBe("vcs:ghost@example.com");
      expect(response.body.summary).toBeNull();
      expect(response.body.points).toHaveLength(3);
    });

    it("should round-trip a linked key carrying a slash", async () => {
      // given
      // A linked person's key is an entity reference, so it carries both a
      // colon and a slash and arrives percent-encoded.
      const { server } = await startBackend([]);

      // when
      const response = await request(server).get(
        "/api/code-health/v1/contributors/user%3Adefault%2Fjane/trend",
      );

      // then
      expect(response.status).toBe(200);
      expect(response.body.key).toBe("user:default/jane");
    });

    it("should reject an unsupported bucket on a contributor trend", async () => {
      // given
      const { server } = await startBackend([]);

      // when
      const response = await request(server)
        .get("/api/code-health/v1/contributors/user%3Adefault%2Fjane/trend")
        .query({ bucket: "hour" });

      // then
      expect(response.status).toBe(400);
    });
  });

  describe("ownership", () => {
    it("should list the repositories a person's group owns", async () => {
      // given
      const { server } = await startBackend([
        componentWithSlug("pipelines", "rios0rios0/pipelines"),
      ]);
      await waitFor(async () => {
        const response = await request(server).get("/api/code-health/v1/repositories");
        return response.body.items.length === 1;
      });

      // when
      const response = await request(server).get(
        "/api/code-health/v1/contributors/user%3Adefault%2Fmock/repositories",
      );

      // then
      // The catalog mock holds no `User`, so the person owns nothing — which is
      // the shape the screen has to render, not an error.
      expect(response.status).toBe(200);
      expect(response.body.ownership).toEqual({
        entityRef: "user:default/mock",
        owners: [],
      });
      expect(response.body.items).toEqual([]);
    });

    it("should own nothing for a row nobody has linked", async () => {
      // given
      const { server } = await startBackend([]);

      // when
      const response = await request(server).get(
        "/api/code-health/v1/contributors/vcs%3Ajane%40acme.com/repositories",
      );

      // then
      expect(response.body.ownership).toEqual({ entityRef: null, owners: [] });
    });
  });

  describe("administration", () => {
    it("should report no access and refuse a reset when nobody is configured", async () => {
      // given
      // A reset drops every collected commit and re-walks the providers, so an
      // install that acquires the route by upgrading must not acquire an
      // administrator with it.
      const { server } = await startBackend([]);

      // when
      const access = await request(server).get("/api/code-health/v1/access");
      const reset = await request(server)
        .post("/api/code-health/v1/ingestion/reset")
        .send({ days: 30 });

      // then
      expect(access.status).toBe(200);
      expect(access.body).toEqual({ canResetIngestion: false, retentionDays: 365 });
      expect(reset.status).toBe(403);
    });

    it("should let a configured administrator reset the ingestion", async () => {
      // given
      const { server } = await startBackend(
        [componentWithSlug("pipelines", "rios0rios0/pipelines")],
        { administrators: [MOCK_USER] },
      );
      await waitFor(async () => {
        const response = await request(server).get("/api/code-health/v1/coverage");
        return response.body.backfill.repositories === 1;
      });

      // when
      const access = await request(server).get("/api/code-health/v1/access");
      const reset = await request(server)
        .post("/api/code-health/v1/ingestion/reset")
        .send({ days: 30 });

      // then
      expect(access.body.canResetIngestion).toBe(true);
      expect(reset.status).toBe(200);
      expect(reset.body).toMatchObject({ repositories: 1, days: 30 });
      // Ingestion is on a manual trigger here, so the observable effect is the
      // cursor: the backfill now reaches thirty days rather than a year, which
      // is what the administrator asked for.
      const coverage = await request(server).get("/api/code-health/v1/coverage");
      expect(coverage.body.backfill.pendingDays).toBeLessThanOrEqual(31);
    });

    it("should refuse a listed administrator the permission framework denies", async () => {
      // given
      // The permission only ever narrows: an installed policy, or the RBAC
      // plugin, refuses the reset by name even for somebody on the list.
      const { server } = await startBackend(
        [],
        { administrators: [MOCK_USER] },
        [mockServices.permissions.factory({ result: AuthorizeResult.DENY })],
      );

      // when
      const access = await request(server).get("/api/code-health/v1/access");
      const reset = await request(server)
        .post("/api/code-health/v1/ingestion/reset")
        .send({ days: 30 });

      // then
      expect(access.body.canResetIngestion).toBe(false);
      expect(reset.status).toBe(403);
    });

    it("should refuse a service token", async () => {
      // given
      // The point of the route is that a person chose to pay for the re-walk,
      // and a token cannot choose.
      const { server } = await startBackend([], { administrators: [MOCK_USER] });

      // when
      const access = await request(server)
        .get("/api/code-health/v1/access")
        .set("Authorization", "Bearer mock-service-token");
      const reset = await request(server)
        .post("/api/code-health/v1/ingestion/reset")
        .set("Authorization", "Bearer mock-service-token")
        .send({ days: 30 });

      // then
      expect(access.body.canResetIngestion).toBe(false);
      expect(reset.status).toBe(403);
    });

    it("should reject a reach beyond the configured retention", async () => {
      // given
      // Reaching further back than the read API will ever answer for spends a
      // day of provider requests on history no window can ask about.
      const { server } = await startBackend([], {
        administrators: [MOCK_USER],
        ingestion: { retentionDays: 90 },
      });

      // when
      const response = await request(server)
        .post("/api/code-health/v1/ingestion/reset")
        .send({ days: 400 });

      // then
      expect(response.status).toBe(400);
    });

    it("should reject a reach that is not a whole number of days", async () => {
      // given
      // The walk is keyed by day, so half a day is not a thing it can be asked
      // for.
      const { server } = await startBackend([], { administrators: [MOCK_USER] });

      // when
      const response = await request(server)
        .post("/api/code-health/v1/ingestion/reset")
        .send({ days: 0.5 });

      // then
      expect(response.status).toBe(400);
    });

    it("should reject a reach of nothing at all", async () => {
      // given
      const { server } = await startBackend([], { administrators: [MOCK_USER] });

      // when
      const response = await request(server)
        .post("/api/code-health/v1/ingestion/reset")
        .send({ days: 0 });

      // then
      expect(response.status).toBe(400);
    });
  });
});
