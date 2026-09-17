import type { DirectoryUser } from "@rios0rios0/backstage-plugin-code-health-common";
import {
  MAX_DIRECTORY_SEARCH_RESULTS,
  searchDirectoryUsers,
} from "@rios0rios0/backstage-plugin-code-health-common";
import type { DirectoryReader } from "../services/identity_resolver";

/**
 * The most hits a caller may ask for; more than that is a listing, not a search.
 *
 * Distinct from `MAX_DIRECTORY_USERS` in the catalog reader, which is how much
 * of the directory is ever *read*. The two are named apart on purpose: one
 * bounds the answer, the other bounds the question.
 */
export const MAX_DIRECTORY_SEARCH_HITS = 50;

/**
 * The catalog users whose name, address or entity name contains what somebody
 * typed into the Identities screen.
 *
 * The directory is enumerated and filtered here rather than asked to search
 * itself. The catalog's filter API matches whole values, not substrings, so a
 * "like" search over a display name is not something it can be asked for
 * directly — and enumerating the directory is exactly what {@link ListIdentities}
 * already does once per listing, on the same screen, for the same reason: a
 * person is deliberately asking about the directory. The frontend waits for
 * the typing to pause and asks for two characters at least, so a fleet's worth
 * of linking is a handful of these rather than one per keystroke.
 *
 * An empty query answers with nobody without touching the catalog. Searching
 * for nothing would return the first page of a directory of thousands, which
 * is a listing nobody asked for and the one thing this screen refuses to do
 * behind a search box.
 *
 * The read is the reader's capped one — `MAX_DIRECTORY_USERS` entities at
 * most — so on a tenant larger than the cap a person can exist and still not
 * be found here. The screen therefore never says "nobody in the directory
 * matches"; it says no match was found and offers the pasted reference, which
 * is looked up by itself and does not depend on the cap.
 */
export class ListDirectoryUsers {
  constructor(private readonly directory: DirectoryReader) {}

  async run(input: { query: string; limit?: number }): Promise<DirectoryUser[]> {
    const query = input.query.trim();
    if (query === "") return [];

    const limit = Math.min(
      Math.max(1, Math.trunc(input.limit ?? MAX_DIRECTORY_SEARCH_RESULTS)),
      MAX_DIRECTORY_SEARCH_HITS,
    );
    const users = await this.directory.listUsers();
    return searchDirectoryUsers(users, query, limit);
  }
}
