import type { DirectoryUser } from "@rios0rios0/backstage-plugin-code-health-common";
import { renderHook, waitFor } from "@testing-library/react";
import {
  DIRECTORY_SEARCH_DELAY_MS,
  useDirectorySearch,
} from "../../../src/presentation/hooks/use_directory_search";

const felipe: DirectoryUser = {
  entityRef: "user:default/felipe",
  displayName: "Felipe Rios",
  email: null,
  picture: null,
};

/** A directory that records what it was asked and can be told to answer late. */
class RecordingSearch {
  readonly queries: string[] = [];
  private delays = new Map<string, number>();
  private failure: Error | null = null;

  answeringLate(query: string, milliseconds: number): this {
    this.delays.set(query, milliseconds);
    return this;
  }

  failing(failure: Error): this {
    this.failure = failure;
    return this;
  }

  readonly search = async (query: string): Promise<readonly DirectoryUser[]> => {
    this.queries.push(query);
    const delay = this.delays.get(query) ?? 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    if (this.failure) throw this.failure;
    return [{ ...felipe, displayName: `${felipe.displayName} for ${query}` }];
  };
}

describe("useDirectorySearch", () => {
  it("should ask the directory once the typing pauses, and only for enough characters", async () => {
    // given
    const directory = new RecordingSearch();
    const { result, rerender } = renderHook(
      ({ query }) => useDirectorySearch(directory.search, query),
      { initialProps: { query: "f" } },
    );

    // when
    rerender({ query: "fe" });
    rerender({ query: "fel" });

    // then
    await waitFor(() => expect(result.current.users).toHaveLength(1));
    // One character was never asked, and the two keystrokes inside the pause
    // were one request rather than two.
    expect(directory.queries).toEqual(["fel"]);
    expect(result.current.isSearching).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("should report that it is searching while the reply is on its way", async () => {
    // given
    const directory = new RecordingSearch().answeringLate("felipe", 50);

    // when
    const { result } = renderHook(() => useDirectorySearch(directory.search, "felipe"));

    // then
    expect(result.current.isSearching).toBe(true);
    await waitFor(() => expect(result.current.isSearching).toBe(false));
    expect(result.current.users[0]?.displayName).toBe("Felipe Rios for felipe");
  });

  it("should not let a slower reply to an earlier query overwrite a later one", async () => {
    // given
    // The reply to "fe" must not land on top of the reply to "felipe" and show
    // the wrong people under the cursor.
    const directory = new RecordingSearch().answeringLate("fe", DIRECTORY_SEARCH_DELAY_MS * 3);
    const { result, rerender } = renderHook(
      ({ query }) => useDirectorySearch(directory.search, query),
      { initialProps: { query: "fe" } },
    );
    await waitFor(() => expect(directory.queries).toEqual(["fe"]));

    // when
    rerender({ query: "felipe" });

    // then
    await waitFor(() => expect(directory.queries).toEqual(["fe", "felipe"]));
    await waitFor(() =>
      expect(result.current.users[0]?.displayName).toBe("Felipe Rios for felipe"),
    );
    await new Promise((resolve) => setTimeout(resolve, DIRECTORY_SEARCH_DELAY_MS * 3));
    expect(result.current.users[0]?.displayName).toBe("Felipe Rios for felipe");
  });

  it("should empty the answer, without asking, when the typing drops below the minimum", async () => {
    // given
    const directory = new RecordingSearch();
    const { result, rerender } = renderHook(
      ({ query }) => useDirectorySearch(directory.search, query),
      { initialProps: { query: "felipe" } },
    );
    await waitFor(() => expect(result.current.users).toHaveLength(1));

    // when
    rerender({ query: " f " });

    // then
    expect(result.current.users).toEqual([]);
    expect(result.current.isSearching).toBe(false);
    expect(directory.queries).toEqual(["felipe"]);
  });

  it("should surface a failed search rather than an empty directory", async () => {
    // given
    const directory = new RecordingSearch().failing(new Error("catalog is down"));

    // when
    const { result } = renderHook(() => useDirectorySearch(directory.search, "felipe"));

    // then
    await waitFor(() => expect(result.current.error).toBe("catalog is down"));
    expect(result.current.users).toEqual([]);
    expect(result.current.isSearching).toBe(false);
  });
});
