import {
  ListDirectoryUsers,
  MAX_DIRECTORY_USERS_LIMIT,
} from "../../../src/domain/commands/list_directory_users";
import { StubDirectoryReader } from "../../doubles/stub_directory_reader";

const users = [
  {
    entityRef: "user:default/felipe",
    displayName: "Felipe Rios",
    email: "felipe.rios@example.com",
    picture: null,
  },
  {
    entityRef: "user:default/ana",
    displayName: "Ana Costa",
    email: "ana@example.com",
    picture: null,
  },
  {
    entityRef: "user:default/fernanda",
    displayName: "Fernanda Lima",
    email: "fernanda@example.com",
    picture: null,
  },
];

describe("ListDirectoryUsers", () => {
  it("should find the users whose name contains what was typed", async () => {
    // given
    const directory = new StubDirectoryReader(users);

    // when
    const found = await new ListDirectoryUsers(directory).run({ query: "fe" });

    // then
    expect(found.map((user) => user.entityRef)).toEqual([
      "user:default/felipe",
      "user:default/fernanda",
    ]);
  });

  it("should answer an empty query with nobody, without touching the catalog", async () => {
    // given
    // Searching for nothing would be a listing of the whole directory, which is
    // the one thing this screen refuses to do behind a search box.
    const directory = new StubDirectoryReader(users);

    // when
    const found = await new ListDirectoryUsers(directory).run({ query: "   " });

    // then
    expect(found).toEqual([]);
    expect(directory.listUserCalls).toBe(0);
  });

  it("should honour a limit and bound it", async () => {
    // given
    const directory = new StubDirectoryReader(users);
    const command = new ListDirectoryUsers(directory);

    // when
    const one = await command.run({ query: "example", limit: 1 });
    const bounded = await command.run({ query: "example", limit: MAX_DIRECTORY_USERS_LIMIT * 10 });
    const floored = await command.run({ query: "example", limit: 0 });

    // then
    expect(one).toHaveLength(1);
    expect(bounded).toHaveLength(3);
    expect(floored).toHaveLength(1);
  });
});
