import type {
  ExclusionReason,
  IdentityRow,
  IdentitySource,
} from "@rios0rios0/backstage-plugin-code-health-common";
import { useCallback, useEffect, useRef, useState } from "react";
import type { IdentityService } from "../../domain/services/dashboard_service";

export interface UseIdentitiesResult {
  readonly identities: IdentityRow[];
  readonly isLoading: boolean;
  readonly error: string | null;
  /** The last write's failure, cleared when the next one is attempted. */
  readonly writeError: string | null;
  readonly link: (link: {
    source: IdentitySource;
    sourceKey: string;
    entityRef: string;
  }) => Promise<boolean>;
  readonly unlink: (identity: {
    source: IdentitySource;
    sourceKey: string;
  }) => Promise<boolean>;
  readonly exclude: (exclusion: {
    source: IdentitySource;
    sourceKey: string;
    reason: ExclusionReason;
  }) => Promise<boolean>;
  readonly include: (identity: {
    source: IdentitySource;
    sourceKey: string;
  }) => Promise<boolean>;
  readonly refetch: () => Promise<void>;
}

const messageOf = (caught: unknown): string =>
  caught instanceof Error ? caught.message : String(caught);

/**
 * The Identities screen's data, and the four writes it makes.
 *
 * Every write reloads the listing rather than patching the row in place. A
 * write changes more than the row it was made on — the suggestions on every
 * other row were computed against a directory one of whose people is now taken,
 * and an exclusion reaches every other account of the same person — and
 * reconciling that in the browser would be a second implementation of rules the
 * backend already owns.
 */
export const useIdentities = (
  service: IdentityService,
  filter: { sources?: readonly IdentitySource[]; linked?: boolean; excluded?: boolean },
): UseIdentitiesResult => {
  const [identities, setIdentities] = useState<IdentityRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);

  const { linked, excluded } = filter;
  // The sources are compared as a string rather than by reference. A caller
  // passing an inline array — which is the obvious way to call this — builds a
  // new array on every render, and a dependency on the array itself would
  // refetch forever. The failure mode is a page that never stops loading while
  // hammering the backend, so it is worth not leaving to callers to remember.
  const sourceKey = filter.sources === undefined ? null : [...filter.sources].sort().join(",");

  // Guards against an earlier, slower response overwriting a later one when the
  // filter is changed twice in quick succession.
  const requestId = useRef(0);

  const fetchIdentities = useCallback(async () => {
    const current = requestId.current + 1;
    requestId.current = current;
    setIsLoading(true);
    setError(null);

    const sources =
      sourceKey === null
        ? undefined
        : (sourceKey.split(",").filter(Boolean) as IdentitySource[]);

    try {
      const items = await service.listIdentities({
        ...(sources === undefined ? {} : { sources }),
        ...(linked === undefined ? {} : { linked }),
        ...(excluded === undefined ? {} : { excluded }),
      });
      if (requestId.current !== current) return;
      setIdentities(items);
    } catch (caught) {
      if (requestId.current !== current) return;
      setError(messageOf(caught));
    } finally {
      if (requestId.current === current) setIsLoading(false);
    }
  }, [service, sourceKey, linked, excluded]);

  useEffect(() => {
    void fetchIdentities();
  }, [fetchIdentities]);

  const write = useCallback(
    async (action: () => Promise<void>): Promise<boolean> => {
      setWriteError(null);
      try {
        await action();
        await fetchIdentities();
        return true;
      } catch (caught) {
        setWriteError(messageOf(caught));
        return false;
      }
    },
    [fetchIdentities],
  );

  const link = useCallback(
    (target: { source: IdentitySource; sourceKey: string; entityRef: string }) =>
      write(() => service.linkIdentity(target)),
    [service, write],
  );

  const unlink = useCallback(
    (target: { source: IdentitySource; sourceKey: string }) =>
      write(() => service.unlinkIdentity(target)),
    [service, write],
  );

  const exclude = useCallback(
    (target: { source: IdentitySource; sourceKey: string; reason: ExclusionReason }) =>
      write(() => service.excludeIdentity(target)),
    [service, write],
  );

  const include = useCallback(
    (target: { source: IdentitySource; sourceKey: string }) =>
      write(() => service.includeIdentity(target)),
    [service, write],
  );

  return {
    identities,
    isLoading,
    error,
    writeError,
    link,
    unlink,
    exclude,
    include,
    refetch: fetchIdentities,
  };
};
