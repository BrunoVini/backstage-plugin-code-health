import type { ConfigApi } from "@backstage/core-plugin-api";
import type { CodeHealthConfig } from "../../domain/entities/code_health_config";
import { DEFAULT_CODE_HEALTH_CONFIG } from "../../domain/entities/code_health_config";
import type { TimeRangeId } from "../../domain/entities/time_range";
import { TIME_RANGES } from "../../domain/entities/time_range";

const isRangeId = (value: string | undefined): value is TimeRangeId =>
  TIME_RANGES.some((range) => range.id === value);

/**
 * Reads the `codeHealth` block.
 *
 * An unrecognised value falls back to the default rather than throwing: a typo
 * in `app-config.yaml` should leave the dashboard working, not replace it with
 * an error page. A branch name that is blank or only spaces is such a typo —
 * an empty expectation would flag every repository in the fleet — so it falls
 * back too rather than being taken literally.
 */
export const readCodeHealthConfig = (configApi: ConfigApi): CodeHealthConfig => {
  const config = configApi.getOptionalConfig("codeHealth");
  if (!config) return DEFAULT_CODE_HEALTH_CONFIG;

  const refreshIntervalMs = config.getOptionalNumber("refreshIntervalMs");
  const defaultRange = config.getOptionalString("defaultRange");
  const expectedDefaultBranch = config.getOptionalString("expectedDefaultBranch")?.trim();

  return {
    refreshIntervalMs:
      refreshIntervalMs !== undefined && refreshIntervalMs >= 0 ? refreshIntervalMs : null,
    defaultRange: isRangeId(defaultRange)
      ? defaultRange
      : DEFAULT_CODE_HEALTH_CONFIG.defaultRange,
    expectedDefaultBranch:
      expectedDefaultBranch !== undefined && expectedDefaultBranch !== ""
        ? expectedDefaultBranch
        : DEFAULT_CODE_HEALTH_CONFIG.expectedDefaultBranch,
  };
};
