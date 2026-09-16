import type { DirectoryUser } from "@rios0rios0/backstage-plugin-code-health-common";
import { useEffect, useRef, useState } from "react";

/**
 * How much has to be typed before the directory is asked.
 *
 * One character matches most of an organisation, which is a listing rather
 * than a search and costs a catalog enumeration to answer.
 */
export const DIRECTORY_SEARCH_MIN_LENGTH = 2;

/**
 * How long the typing has to pause before the directory is asked.
 *
 * Long enough that "Felipe" is one request rather than six, short enough
 * that the list appears before the reader has looked away from it.
 */
export const DIRECTORY_SEARCH_DELAY_MS = 250;

export interface UseDirectorySearchResult {
  readonly users: readonly DirectoryUser[];
  readonly isSearching: boolean;
  readonly error: string | null;
}

const messageOf = (caught: unknown): string =>
  caught instanceof Error ? caught.message : String(caught);

/**
 * The catalog users matching what is being typed, asked for once the typing
 * pauses.
 *
 * Below the minimum length nothing is asked and the answer is empty, so a
 * field that has just been focused costs nothing. Every answer is checked
 * against the request that asked for it: a slower reply to "fe" must not land
 * on top of the reply to "felipe" and show the wrong people under the cursor.
 */
export const useDirectorySearch = (
  search: (query: string) => Promise<readonly DirectoryUser[]>,
  query: string,
): UseDirectorySearchResult => {
  const [users, setUsers] = useState<readonly DirectoryUser[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestId = useRef(0);
  const trimmed = query.trim();

  useEffect(() => {
    // Retiring the id is what makes a reply to a query that has since been
    // shortened below the minimum land nowhere.
    const current = requestId.current + 1;
    requestId.current = current;

    if (trimmed.length < DIRECTORY_SEARCH_MIN_LENGTH) {
      setUsers([]);
      setIsSearching(false);
      setError(null);
      return undefined;
    }

    setIsSearching(true);
    const timer = setTimeout(async () => {
      try {
        const found = await search(trimmed);
        if (requestId.current !== current) return;
        setUsers(found);
        setError(null);
      } catch (caught) {
        if (requestId.current !== current) return;
        setUsers([]);
        setError(messageOf(caught));
      } finally {
        if (requestId.current === current) setIsSearching(false);
      }
    }, DIRECTORY_SEARCH_DELAY_MS);

    return () => clearTimeout(timer);
  }, [search, trimmed]);

  return { users, isSearching, error };
};
