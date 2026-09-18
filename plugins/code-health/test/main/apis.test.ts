import {
  codeHealthAdministrationApiFactory,
  codeHealthApis,
  codeHealthConfigApiFactory,
  codeHealthContributorsApiFactory,
  codeHealthCoverageApiFactory,
  codeHealthOwnershipApiFactory,
  codeHealthRepositoriesApiFactory,
  codeHealthTimeSeriesApiFactory,
  codeHealthTrendsApiFactory,
} from "../../src/main/apis";
import {
  codeHealthAdministrationApiRef,
  codeHealthConfigApiRef,
  codeHealthContributorsApiRef,
  codeHealthCoverageApiRef,
  codeHealthRepositoriesApiRef,
  codeHealthIdentitiesApiRef,
  codeHealthIntegrationsApiRef,
  codeHealthOwnershipApiRef,
  codeHealthTimeSeriesApiRef,
  codeHealthTrendsApiRef,
} from "../../src/main/api_refs";
import { CodeHealthBackendClient } from "../../src/infrastructure/http/code_health_backend_client";
import {
  asConfigApi,
  StubConfigApi,
  StubDiscoveryApi,
  StubFetchApi,
} from "../doubles/stub_backstage_apis";

const clientDeps = () => ({
  discoveryApi: new StubDiscoveryApi(),
  fetchApi: new StubFetchApi().fetchApi,
});

describe("codeHealthApis", () => {
  it("should register one factory per API ref", () => {
    // given / when
    const ids = codeHealthApis.map((factory) => factory.api.id).sort();

    // then
    expect(ids).toEqual([
      codeHealthConfigApiRef.id,
      codeHealthContributorsApiRef.id,
      codeHealthCoverageApiRef.id,
      codeHealthIdentitiesApiRef.id,
      codeHealthIntegrationsApiRef.id,
      codeHealthRepositoriesApiRef.id,
      codeHealthTimeSeriesApiRef.id,
      codeHealthTrendsApiRef.id,
      codeHealthOwnershipApiRef.id,
      codeHealthAdministrationApiRef.id,
    ].sort());
  });

  it("should build the same backend client for every data API", () => {
    // given / when
    const built = [
      codeHealthRepositoriesApiFactory.factory(clientDeps()),
      codeHealthContributorsApiFactory.factory(clientDeps()),
      codeHealthCoverageApiFactory.factory(clientDeps()),
      codeHealthTimeSeriesApiFactory.factory(clientDeps()),
      codeHealthTrendsApiFactory.factory(clientDeps()),
      codeHealthOwnershipApiFactory.factory(clientDeps()),
      codeHealthAdministrationApiFactory.factory(clientDeps()),
    ];

    // then
    // One stateless client backs them all; separate refs only keep each view's
    // dependencies honest.
    expect(built.every((api) => api instanceof CodeHealthBackendClient)).toBe(true);
  });

  it("should read the configured defaults into the config API", () => {
    // given
    const configApi = asConfigApi(
      new StubConfigApi({
        "codeHealth.refreshIntervalMs": 60000,
        "codeHealth.defaultRange": "week",
        "codeHealth.expectedDefaultBranch": "trunk",
      }),
    );

    // when
    const config = codeHealthConfigApiFactory.factory({ configApi });

    // then
    expect(config).toEqual({
      refreshIntervalMs: 60000,
      defaultRange: "week",
      expectedDefaultBranch: "trunk",
    });
  });

  it("should fall back to the defaults when nothing is configured", () => {
    // given
    const configApi = asConfigApi(new StubConfigApi({}));

    // when
    const config = codeHealthConfigApiFactory.factory({ configApi });

    // then
    expect(config).toEqual({
      refreshIntervalMs: null,
      defaultRange: "day",
      expectedDefaultBranch: "main",
    });
  });

  it("should trim the expected default branch", () => {
    // given
    const configApi = asConfigApi(
      new StubConfigApi({ "codeHealth.expectedDefaultBranch": "  master  " }),
    );

    // when
    const config = codeHealthConfigApiFactory.factory({ configApi });

    // then
    expect(config.expectedDefaultBranch).toBe("master");
  });

  it("should ignore a blank expected default branch", () => {
    // given
    // An empty expectation would flag every repository in the fleet, which is
    // an audit nobody reads — so it is a typo, not an instruction.
    const configApi = asConfigApi(
      new StubConfigApi({ "codeHealth.expectedDefaultBranch": "   " }),
    );

    // when
    const config = codeHealthConfigApiFactory.factory({ configApi });

    // then
    expect(config.expectedDefaultBranch).toBe("main");
  });

  it("should ignore a range nobody can select", () => {
    // given
    // A typo in `app-config.yaml` should leave the dashboard working rather
    // than replacing it with an error page.
    const configApi = asConfigApi(new StubConfigApi({ "codeHealth.defaultRange": "fortnight" }));

    // when
    const config = codeHealthConfigApiFactory.factory({ configApi });

    // then
    expect(config.defaultRange).toBe("day");
  });

  it("should ignore a negative refresh interval", () => {
    // given
    const configApi = asConfigApi(new StubConfigApi({ "codeHealth.refreshIntervalMs": -1 }));

    // when
    const config = codeHealthConfigApiFactory.factory({ configApi });

    // then
    expect(config.refreshIntervalMs).toBeNull();
  });
});
