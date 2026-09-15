import { CodeHealthBackendClient } from "../../../src/infrastructure/http/code_health_backend_client";
import { StubDiscoveryApi, StubFetchApi } from "../../doubles/stub_backstage_apis";
import { aCoverageInfo } from "../../doubles/stub_coverage_service";

const WINDOW = { from: "2026-08-09T12:00:00.000Z", to: "2026-08-10T12:00:00.000Z" };

const createClient = (fetchApi: StubFetchApi) => {
  const discoveryApi = new StubDiscoveryApi();
  const client = new CodeHealthBackendClient({ discoveryApi, fetchApi: fetchApi.fetchApi });
  return { client, discoveryApi };
};

describe("CodeHealthBackendClient", () => {
  it("should ask the backend for the repositories in a window", async () => {
    // given
    const fetchApi = new StubFetchApi().withResponses({
      body: { window: WINDOW, items: [{ id: "a" }] },
    });
    const { client } = createClient(fetchApi);

    // when
    const repositories = await client.listRepositories(WINDOW);

    // then
    expect(repositories).toEqual([{ id: "a" }]);
    expect(fetchApi.queryOf(0).get("from")).toBe(WINDOW.from);
    expect(fetchApi.queryOf(0).get("to")).toBe(WINDOW.to);
  });

  it("should resolve the backend through the plugin id", async () => {
    // given
    // Both plugins claim `code-health`, which is what makes this resolve to the
    // backend rather than to nothing.
    const fetchApi = new StubFetchApi().withResponses({ body: { items: [] } });
    const { client, discoveryApi } = createClient(fetchApi);

    // when
    await client.listRepositories(WINDOW);

    // then
    expect(discoveryApi.calls).toEqual(["code-health"]);
  });

  it("should resolve the base URL again on every request", async () => {
    // given
    // A base URL captured once goes stale when the backend moves, and the
    // failure then looks like the plugin being uninstalled.
    const fetchApi = new StubFetchApi().withResponses(
      { body: { items: [] } },
      { body: { items: [] } },
    );
    const { client, discoveryApi } = createClient(fetchApi);

    // when
    await client.listRepositories(WINDOW);
    await client.listContributors(WINDOW);

    // then
    expect(discoveryApi.calls).toHaveLength(2);
  });

  it("should narrow contributors to one repository when asked", async () => {
    // given
    const fetchApi = new StubFetchApi().withResponses({ body: { items: [] } });
    const { client } = createClient(fetchApi);

    // when
    await client.listContributors(WINDOW, "repo-1");

    // then
    expect(fetchApi.queryOf(0).get("repositoryId")).toBe("repo-1");
  });

  it("should omit the repository filter when none was given", async () => {
    // given
    const fetchApi = new StubFetchApi().withResponses({ body: { items: [] } });
    const { client } = createClient(fetchApi);

    // when
    await client.listContributors(WINDOW);

    // then
    expect(fetchApi.queryOf(0).has("repositoryId")).toBe(false);
  });

  it("should read the ingestion coverage", async () => {
    // given
    const coverage = aCoverageInfo();
    const fetchApi = new StubFetchApi().withResponses({ body: coverage });
    const { client } = createClient(fetchApi);

    // when
    const result = await client.getCoverage();

    // then
    expect(result).toEqual(coverage);
    expect(fetchApi.calls[0].url).toContain("/v1/coverage");
  });

  it("should ask the backend to run its tasks now", async () => {
    // given
    const fetchApi = new StubFetchApi().withResponses({ body: { triggered: [] } });
    const { client } = createClient(fetchApi);

    // when
    await client.refresh();

    // then
    expect(fetchApi.calls[0]).toMatchObject({ method: "POST" });
    expect(fetchApi.calls[0].url).toContain("/v1/refresh");
  });

  it("should encode a person key into the trend path and pass the bucket", async () => {
    // given
    // A linked person's key is `user:default/jane`; spliced in raw, the slash
    // would make the path name a different route.
    const fetchApi = new StubFetchApi().withResponses({ body: { points: [] } });
    const { client } = createClient(fetchApi);

    // when
    const trend = await client.getContributorTrend("user:default/jane", WINDOW, "week");

    // then
    expect(trend).toEqual({ points: [] });
    expect(fetchApi.calls[0].url).toContain("/v1/contributors/user%3Adefault%2Fjane/trend?");
    expect(fetchApi.queryOf(0).get("bucket")).toBe("week");
    expect(fetchApi.queryOf(0).get("from")).toBe(WINDOW.from);
  });

  it("should ask for a repository's trend under its id", async () => {
    // given
    const fetchApi = new StubFetchApi().withResponses({ body: { id: "repo-1", points: [] } });
    const { client } = createClient(fetchApi);

    // when
    const trend = await client.getRepositoryTrend("repo-1", WINDOW, "day");

    // then
    expect(trend).toEqual({ id: "repo-1", points: [] });
    expect(fetchApi.calls[0].url).toContain("/v1/repositories/repo-1/trend?");
    expect(fetchApi.queryOf(0).get("bucket")).toBe("day");
  });

  it("should ask for the repositories a person owns in a window", async () => {
    // given
    const fetchApi = new StubFetchApi().withResponses({
      body: { window: WINDOW, ownership: { entityRef: null, owners: [] }, items: [] },
    });
    const { client } = createClient(fetchApi);

    // when
    const owned = await client.listOwnedRepositories("vcs:jane", WINDOW);

    // then
    expect(owned.items).toEqual([]);
    expect(fetchApi.calls[0].url).toContain("/v1/contributors/vcs%3Ajane/repositories?");
    expect(fetchApi.queryOf(0).get("to")).toBe(WINDOW.to);
  });

  it("should read what the caller is allowed to do", async () => {
    // given
    const fetchApi = new StubFetchApi().withResponses({
      body: { canResetIngestion: true, retentionDays: 365 },
    });
    const { client } = createClient(fetchApi);

    // when
    const access = await client.getAccess();

    // then
    expect(access).toEqual({ canResetIngestion: true, retentionDays: 365 });
    expect(fetchApi.calls[0].url).toContain("/v1/access");
  });

  it("should POST the reach of a reset and return what the backend did", async () => {
    // given
    const fetchApi = new StubFetchApi().withResponses({
      body: { repositories: 12, days: 90, triggered: ["code-health.ingest"] },
    });
    const { client } = createClient(fetchApi);

    // when
    const outcome = await client.resetIngestion({ days: 90 });

    // then
    expect(outcome).toEqual({ repositories: 12, days: 90, triggered: ["code-health.ingest"] });
    expect(fetchApi.calls[0]).toMatchObject({
      method: "POST",
      url: "http://localhost:7007/api/code-health/v1/ingestion/reset",
      body: JSON.stringify({ days: 90 }),
    });
  });

  it("should surface the refusal when a reset is not allowed", async () => {
    // given
    const fetchApi = new StubFetchApi().withResponses({
      status: 403,
      body: { error: { message: "only an administrator may start the collection over" } },
    });
    const { client } = createClient(fetchApi);

    // when / then
    await expect(client.resetIngestion({ days: 30 })).rejects.toThrow(
      "only an administrator may start the collection over",
    );
  });

  it("should surface the message the backend explained the failure with", async () => {
    // given
    // "the requested window is longer than the retention period" tells a user
    // what to do; "request failed with 400" does not.
    const fetchApi = new StubFetchApi().withResponses({
      status: 400,
      body: { error: { message: "the requested window is longer than the retention period" } },
    });
    const { client } = createClient(fetchApi);

    // when / then
    await expect(client.listRepositories(WINDOW)).rejects.toThrow(
      "the requested window is longer than the retention period",
    );
  });

  it("should fall back to the status when the error body is not readable", async () => {
    // given
    const fetchApi = new StubFetchApi().withResponses({ status: 502 });
    const { client } = createClient(fetchApi);

    // when / then
    await expect(client.listRepositories(WINDOW)).rejects.toThrow(
      "code-health request to repositories failed with 502",
    );
  });

  it("should report a failed refresh", async () => {
    // given
    const fetchApi = new StubFetchApi().withResponses({ status: 403, body: {} });
    const { client } = createClient(fetchApi);

    // when / then
    await expect(client.refresh()).rejects.toThrow(
      "code-health request to v1/refresh failed with 403",
    );
  });

  it("should let a transport failure through", async () => {
    // given
    // A backend that is not installed answers nothing at all, and that has to
    // reach the dashboard rather than being flattened into an empty list.
    const fetchApi = new StubFetchApi().withNetworkFailure();
    const { client } = createClient(fetchApi);

    // when / then
    await expect(client.getCoverage()).rejects.toThrow("Failed to fetch");
  });

  describe("integrations and identities", () => {
    it("should parse the capabilities the backend reported", async () => {
      // given
      const fetchApi = new StubFetchApi().withResponses({
        body: { integrations: { wakatime: true, jira: false, confluence: true } },
      });
      const { client } = createClient(fetchApi);

      // when
      const capabilities = await client.getCapabilities();

      // then
      expect(capabilities).toEqual({ wakatime: true, jira: false, confluence: true });
    });

    it("should report an integration the backend never mentioned as disabled", async () => {
      // given
      // A frontend one release ahead of its backend asks about integrations that
      // backend has never heard of; the honest answer is "no", not a dashboard
      // that fails to render.
      const fetchApi = new StubFetchApi().withResponses({
        body: { integrations: { wakatime: true } },
      });
      const { client } = createClient(fetchApi);

      // when / then
      expect(await client.getCapabilities()).toEqual({
        wakatime: true,
        jira: false,
        confluence: false,
      });
    });

    it("should send several sources as repeated parameters, not a joined one", async () => {
      // given
      // `source=vcs,jira` is a single value that matches no known source, and
      // the backend rejects it with a 400.
      const fetchApi = new StubFetchApi().withResponses({ body: { items: [] } });
      const { client } = createClient(fetchApi);

      // when
      await client.listIdentities({ sources: ["vcs", "jira"], linked: false });

      // then
      expect(fetchApi.queryOf(0).getAll("source")).toEqual(["vcs", "jira"]);
      expect(fetchApi.queryOf(0).get("linked")).toBe("false");
    });

    it("should ask for everything when no filter is given", async () => {
      // given
      const fetchApi = new StubFetchApi().withResponses({ body: { items: [] } });
      const { client } = createClient(fetchApi);

      // when
      await client.listIdentities({});

      // then
      expect(fetchApi.calls[0]?.url).not.toContain("?");
    });

    it("should treat an empty source list as no filter at all", async () => {
      // given
      const fetchApi = new StubFetchApi().withResponses({ body: { items: [] } });
      const { client } = createClient(fetchApi);

      // when
      await client.listIdentities({ sources: [] });

      // then
      expect(fetchApi.calls[0]?.url).not.toContain("source");
    });

    it("should PUT a link, because linking the same pair twice means the same thing", async () => {
      // given
      const fetchApi = new StubFetchApi().withResponses({ status: 204 });
      const { client } = createClient(fetchApi);

      // when
      await client.linkIdentity({
        source: "wakatime",
        sourceKey: "jrios",
        entityRef: "user:default/felipe",
      });

      // then
      expect(fetchApi.calls[0]?.method).toBe("PUT");
      expect(fetchApi.calls[0]?.url).toContain("/v1/identities/links");
      expect(JSON.parse(fetchApi.calls[0]?.body ?? "{}")).toEqual({
        source: "wakatime",
        sourceKey: "jrios",
        entityRef: "user:default/felipe",
      });
    });

    it("should encode an account key that is an address into the delete path", async () => {
      // given
      // A commit author's key is an e-mail; unencoded it would break the route.
      const fetchApi = new StubFetchApi().withResponses({ status: 204 });
      const { client } = createClient(fetchApi);

      // when
      await client.unlinkIdentity({ source: "vcs", sourceKey: "dev@example.com" });

      // then
      expect(fetchApi.calls[0]?.method).toBe("DELETE");
      expect(fetchApi.calls[0]?.url).toContain("/identities/links/vcs/dev%40example.com");
    });

    it("should ask for only the excluded accounts when the filter says so", async () => {
      // given
      const fetchApi = new StubFetchApi().withResponses({ body: { items: [] } });
      const { client } = createClient(fetchApi);

      // when
      await client.listIdentities({ excluded: true });

      // then
      expect(fetchApi.queryOf(0).get("excluded")).toBe("true");
    });

    it("should PUT an exclusion, because excluding the same account twice means the same thing", async () => {
      // given
      const fetchApi = new StubFetchApi().withResponses({ status: 204 });
      const { client } = createClient(fetchApi);

      // when
      await client.excludeIdentity({
        source: "vcs",
        sourceKey: "build-service",
        reason: "service-account",
      });

      // then
      expect(fetchApi.calls[0]?.method).toBe("PUT");
      expect(fetchApi.calls[0]?.url).toContain("/v1/identities/exclusions");
      expect(JSON.parse(fetchApi.calls[0]?.body ?? "{}")).toEqual({
        source: "vcs",
        sourceKey: "build-service",
        reason: "service-account",
      });
    });

    it("should encode an account key that is an address into the include path", async () => {
      // given
      const fetchApi = new StubFetchApi().withResponses({ status: 204 });
      const { client } = createClient(fetchApi);

      // when
      await client.includeIdentity({ source: "vcs", sourceKey: "dev@example.com" });

      // then
      expect(fetchApi.calls[0]?.method).toBe("DELETE");
      expect(fetchApi.calls[0]?.url).toContain("/identities/exclusions/vcs/dev%40example.com");
    });

    it("should surface the backend's own message when a link is refused", async () => {
      // given
      const fetchApi = new StubFetchApi().withResponses({
        status: 404,
        body: { error: { message: "user:default/ghost is not a user in the catalog" } },
      });
      const { client } = createClient(fetchApi);

      // when / then
      await expect(
        client.linkIdentity({
          source: "wakatime",
          sourceKey: "jrios",
          entityRef: "user:default/ghost",
        }),
      ).rejects.toThrow("user:default/ghost is not a user in the catalog");
    });
  });
});
