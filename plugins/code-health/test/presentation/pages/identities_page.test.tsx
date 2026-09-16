import type { DirectoryUser } from "@rios0rios0/backstage-plugin-code-health-common";
import { NO_INTEGRATIONS } from "@rios0rios0/backstage-plugin-code-health-common";
import { fireEvent, render as renderBare, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { IdentitiesPage } from "../../../src/presentation/pages/identities_page";
import { IdentityRowBuilder } from "../../builders/identity_row_builder";
import { StubIdentityService } from "../../doubles/stub_identity_service";

const render = (ui: React.ReactElement) => renderBare(<MemoryRouter>{ui}</MemoryRouter>);

const renderPage = (
  service: StubIdentityService,
  capabilities = { ...NO_INTEGRATIONS, wakatime: true, jira: true, confluence: true },
) => render(<IdentitiesPage identityService={service} capabilities={capabilities} />);

/**
 * Turns off the "only accounts nobody has linked" filter, which the screen
 * opens with. It is the only checkbox on the page.
 */
const showEveryAccount = () => fireEvent.click(screen.getByRole("checkbox"));

const unlinked = IdentityRowBuilder.create()
  .from("wakatime", "jrios")
  .named("Felipe Rios")
  .withSuggestions(
    { entityRef: "user:default/felipe", displayName: "F. Rios (directory)" },
    { entityRef: "user:default/other", displayName: "Someone Else", reason: "most of the name matches" },
  )
  .build();

const linked = IdentityRowBuilder.create()
  .from("vcs", "dev@example.com")
  .named("Dev Example")
  .withEmail("dev@example.com")
  .linkedTo("user:default/dev", "catalog-email")
  .build();

/** The people a search can find, none of whom the suggestions name. */
const directory: DirectoryUser[] = [
  {
    entityRef: "user:default/f.rios_example.com",
    displayName: "Felipe Rios",
    email: "f.rios@example.com",
    picture: null,
  },
  {
    entityRef: "user:default/fernanda",
    displayName: "Fernanda Lima",
    email: "fernanda@example.com",
    picture: null,
  },
  {
    entityRef: "user:default/ana",
    displayName: "Ana Costa",
    email: "ana@example.com",
    picture: null,
  },
];

/** The picker on the one unlinked row, by the label it carries. */
const pickerFor = (sourceKey: string): HTMLElement =>
  screen.getByLabelText(`Catalog user for ${sourceKey}`);

/** The rows of the listing, header and filter rows left out. */
const listedRows = (): HTMLElement[] =>
  within(screen.getByRole("table", { name: "Identities" })).getAllByRole("row").slice(2);

describe("IdentitiesPage", () => {
  it("should list the accounts with their source and their person", async () => {
    // given
    const service = new StubIdentityService().withRows([unlinked, linked]);
    renderPage(service);
    await waitFor(() => expect(screen.getByText("Felipe Rios")).toBeInTheDocument());

    // when
    showEveryAccount();

    // then
    await waitFor(() => expect(screen.getByText("Dev Example")).toBeInTheDocument());
    // Twice each: once as a source filter option, once as the row's chip.
    expect(screen.getAllByText("WakaTime")).toHaveLength(2);
    expect(screen.getAllByText("Version control")).toHaveLength(2);
    expect(screen.getByText("user:default/dev")).toBeInTheDocument();
    expect(screen.getByText("matched on the e-mail address")).toBeInTheDocument();
    expect(screen.getByText("2 listed · 1 unlinked · 0 excluded")).toBeInTheDocument();
  });

  it("should open on the accounts nobody has linked", async () => {
    // given
    // The only work this screen exists for is the accounts without a person.
    // Opening on the full list means scrolling past every row that needs
    // nothing to reach the few that do.
    const service = new StubIdentityService().withRows([unlinked, linked]);

    // when
    renderPage(service);

    // then
    await waitFor(() => expect(screen.getByText("Felipe Rios")).toBeInTheDocument());
    expect(screen.queryByText("Dev Example")).not.toBeInTheDocument();
    expect(service.filters[0]).toEqual({ linked: false });
  });

  it("should link an account from a suggestion in one click", async () => {
    // given
    // The ranked match is right the overwhelming majority of the time, and
    // linking a fleet's worth of accounts should not take an afternoon.
    const service = new StubIdentityService().withRows([unlinked, linked]);
    renderPage(service);
    showEveryAccount();
    // The already-linked row appearing is what says the widened listing has
    // arrived; the cell's controls are disabled while a read is in flight.
    await waitFor(() => expect(screen.getByText("Dev Example")).toBeInTheDocument());

    // when
    fireEvent.click(screen.getByText("F. Rios (directory)"));

    // then
    await waitFor(() =>
      expect(screen.getByText("user:default/felipe")).toBeInTheDocument(),
    );
    expect(screen.getByText("linked by user:default/tester")).toBeInTheDocument();
  });

  it("should link an account to a user nobody suggested", async () => {
    // given
    // A bot with a plausible name, or somebody whose accounts share nothing.
    const service = new StubIdentityService().withRows([unlinked, linked]);
    renderPage(service);
    showEveryAccount();
    await waitFor(() => expect(screen.getByText("Dev Example")).toBeInTheDocument());

    // when
    fireEvent.change(pickerFor("jrios"), {
      target: { value: "  user:default/manual  " },
    });
    fireEvent.click(screen.getByText("Link"));

    // then
    await waitFor(() =>
      // Trimmed on the way out, so a pasted reference with stray whitespace is
      // not rejected by the backend for a reason nobody can see.
      expect(screen.getByText("user:default/manual")).toBeInTheDocument(),
    );
  });

  it("should find a user in the directory by part of their name and link them in one pick", async () => {
    // given
    // Nobody should have to type `user:default/f.rios_example.com` to say who
    // an account belongs to.
    const service = new StubIdentityService()
      .withRows([unlinked, linked])
      .withDirectory(directory);
    renderPage(service);
    showEveryAccount();
    await waitFor(() => expect(screen.getByText("Dev Example")).toBeInTheDocument());

    // when
    fireEvent.change(pickerFor("jrios"), { target: { value: "rios" } });
    const option = await screen.findByRole("option", { name: /f\.rios@example\.com/u });

    // then
    // Found by the address, under the directory heading, beside the two
    // suggestions the row already carried.
    expect(within(option).getByText("Felipe Rios")).toBeInTheDocument();
    expect(screen.getByText("Directory")).toBeInTheDocument();
    expect(screen.getByText("Likely matches")).toBeInTheDocument();
    expect(service.searches).toEqual(["rios"]);

    // when
    fireEvent.click(option);
    fireEvent.click(screen.getByText("Link"));

    // then
    await waitFor(() =>
      expect(screen.getByText("user:default/f.rios_example.com")).toBeInTheDocument(),
    );
  });

  it("should offer the likely matches in the picker before anything is typed", async () => {
    // given
    const service = new StubIdentityService().withRows([unlinked]).withDirectory(directory);
    renderPage(service);
    await waitFor(() => expect(screen.getByText("Felipe Rios")).toBeInTheDocument());

    // when
    // Pressing on the empty field is what opens the list; focusing and then
    // pressing would open it and close it again.
    fireEvent.mouseDown(pickerFor("jrios"));

    // then
    // Scoped to the picker's list: the page's native selects are options too.
    const options = within(await screen.findByRole("listbox")).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining("F. Rios (directory)"),
      expect.stringContaining("Someone Else"),
    ]);
    expect(within(options[1] as HTMLElement).getByText(/most of the name matches/u)).toBeInTheDocument();
    expect(service.searches).toEqual([]);
  });

  it("should refuse to send a bare name as a reference", async () => {
    // given
    // A name typed on its own is not a reference, and sending it would only
    // come back as a refusal the reader could not act on.
    const service = new StubIdentityService().withRows([unlinked]).withDirectory(directory);
    renderPage(service);
    await waitFor(() => expect(screen.getByText("Felipe Rios")).toBeInTheDocument());

    // when
    fireEvent.change(pickerFor("jrios"), { target: { value: "Ana" } });
    await screen.findByRole("option", { name: /Ana Costa/u });

    // then
    expect(screen.getByText("Link").closest("button")).toBeDisabled();
  });

  it("should say when nobody in the directory matches", async () => {
    // given
    const service = new StubIdentityService().withRows([unlinked]).withDirectory(directory);
    renderPage(service);
    await waitFor(() => expect(screen.getByText("Felipe Rios")).toBeInTheDocument());

    // when
    fireEvent.change(pickerFor("jrios"), { target: { value: "zzzz" } });

    // then
    expect(
      await screen.findByText("Nobody in the directory matches that."),
    ).toBeInTheDocument();
  });

  it("should say plainly when the directory could not be searched", async () => {
    // given
    const service = new StubIdentityService()
      .withRows([unlinked])
      .withSearchFailure(new Error("catalog is down"));
    renderPage(service);
    await waitFor(() => expect(screen.getByText("Felipe Rios")).toBeInTheDocument());

    // when
    fireEvent.change(pickerFor("jrios"), { target: { value: "rios" } });

    // then
    expect(
      await screen.findByText(/The directory could not be searched: catalog is down/u),
    ).toBeInTheDocument();
  });

  it("should page, sort and filter the listing like the tables", async () => {
    // given
    const rows = Array.from({ length: 12 }, (_, index) =>
      IdentityRowBuilder.create()
        .from("vcs", `dev-${String(index).padStart(2, "0")}@example.com`)
        .named(`Dev ${String(index).padStart(2, "0")}`)
        .build(),
    );
    const service = new StubIdentityService().withRows(rows);
    renderPage(service);
    await waitFor(() => expect(screen.getByText("Dev 00")).toBeInTheDocument());
    expect(listedRows()).toHaveLength(12);

    // when
    fireEvent.change(screen.getByLabelText("Rows per page"), { target: { value: "10" } });

    // then
    expect(listedRows()).toHaveLength(10);
    expect(screen.getByText("1 / 2")).toBeInTheDocument();

    // when
    fireEvent.click(screen.getByText("Next"));

    // then
    expect(listedRows()).toHaveLength(2);
    expect(screen.getByText("Dev 10")).toBeInTheDocument();

    // when
    fireEvent.click(screen.getByText("Account"));

    // then
    // Turned around, and back on the first page, which now opens on the last
    // accounts rather than the first.
    await waitFor(() => expect(screen.getByText("Dev 11")).toBeInTheDocument());
    expect(screen.queryByText("Dev 00")).not.toBeInTheDocument();

    // when
    fireEvent.change(screen.getByLabelText("Filter account"), { target: { value: "dev-07" } });

    // then
    await waitFor(() => expect(listedRows()).toHaveLength(1));
    expect(screen.getByText("Dev 07")).toBeInTheDocument();
  });

  it("should dim an excluded row rather than hide it", async () => {
    // given
    const bot = IdentityRowBuilder.create()
      .from("vcs", "build-service")
      .named(null)
      .excludedAs("automated-bot")
      .build();
    const service = new StubIdentityService().withRows([unlinked, bot]);

    // when
    renderPage(service);
    await waitFor(() => expect(screen.getByText("Automated bot")).toBeInTheDocument());

    // then
    const [person, excluded] = listedRows();
    expect(person?.className).not.toMatch(/excludedRow/u);
    expect(excluded?.className).toMatch(/excludedRow/u);
  });

  it("should drop a row off the listing once it has a person", async () => {
    // given
    // The screen opens on the accounts nobody has linked, so working through
    // them shortens the list as it goes rather than leaving the reader to
    // remember which rows they have already dealt with.
    const service = new StubIdentityService().withRows([unlinked]);
    renderPage(service);
    await waitFor(() => expect(screen.getByText("Felipe Rios")).toBeInTheDocument());

    // when
    fireEvent.click(screen.getByText("F. Rios (directory)"));

    // then
    await waitFor(() => expect(screen.queryByText("Felipe Rios")).not.toBeInTheDocument());
  });

  it("should refuse to submit an empty reference", async () => {
    // given
    const service = new StubIdentityService().withRows([unlinked]);
    renderPage(service);
    await waitFor(() => expect(screen.getByText("Felipe Rios")).toBeInTheDocument());

    // when / then
    expect(screen.getByText("Link").closest("button")).toBeDisabled();
  });

  it("should remove a link", async () => {
    // given
    const service = new StubIdentityService().withRows([linked]);
    renderPage(service);
    showEveryAccount();
    await waitFor(() => expect(screen.getByText("user:default/dev")).toBeInTheDocument());

    // when
    fireEvent.click(screen.getByText("Unlink"));

    // then
    await waitFor(() =>
      expect(screen.queryByText("user:default/dev")).not.toBeInTheDocument(),
    );
  });

  it("should say plainly when a link was refused", async () => {
    // given
    const service = new StubIdentityService()
      .withRows([unlinked])
      .withLinkFailure(new Error("user:default/ghost is not a user in the catalog"));
    renderPage(service);
    await waitFor(() => expect(screen.getByText("Felipe Rios")).toBeInTheDocument());

    // when
    fireEvent.change(pickerFor("jrios"), {
      target: { value: "user:default/ghost" },
    });
    fireEvent.click(screen.getByText("Link"));

    // then
    await waitFor(() =>
      expect(screen.getByText(/That change was not saved/u)).toBeInTheDocument(),
    );
  });

  it("should narrow the listing to one source", async () => {
    // given
    const service = new StubIdentityService().withRows([unlinked, linked]);
    renderPage(service);
    showEveryAccount();
    await waitFor(() => expect(screen.getByText("Dev Example")).toBeInTheDocument());

    // when
    fireEvent.change(screen.getByLabelText("Filter by source"), {
      target: { value: "wakatime" },
    });

    // then
    await waitFor(() =>
      expect(screen.queryByText("Dev Example")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Felipe Rios")).toBeInTheDocument();
  });

  it("should ignore a source value it does not recognise", async () => {
    // given
    const service = new StubIdentityService().withRows([unlinked, linked]);
    renderPage(service);
    showEveryAccount();
    await waitFor(() => expect(screen.getByText("Dev Example")).toBeInTheDocument());

    // when
    fireEvent.change(screen.getByLabelText("Filter by source"), {
      target: { value: "" },
    });

    // then
    await waitFor(() => expect(screen.getByText("Dev Example")).toBeInTheDocument());
  });

  it("should show an account somebody already linked when asked", async () => {
    // given
    const service = new StubIdentityService().withRows([unlinked, linked]);
    renderPage(service);
    await waitFor(() => expect(screen.getByText("Felipe Rios")).toBeInTheDocument());

    // when
    showEveryAccount();

    // then
    await waitFor(() => expect(screen.getByText("Dev Example")).toBeInTheDocument());
  });

  it("should keep both filter labels clear of the option they sit over", async () => {
    // given
    // A native select always renders whichever option is current, so Material
    // UI reading its empty value as an empty field draws the label straight
    // across the option text — "Source" on top of "All sources".
    const service = new StubIdentityService().withRows([unlinked]);

    // when
    renderPage(service);

    // then
    await waitFor(() => expect(screen.getByText("Felipe Rios")).toBeInTheDocument());
    // Scoped to the `label` element, because both words are also column
    // headings on the table below.
    for (const label of ["Source", "Measurement"]) {
      expect(screen.getByText(label, { selector: "label" })).toHaveClass(
        "MuiInputLabel-shrink",
      );
    }
  });

  it("should only offer sources whose integration is configured", async () => {
    // given
    // A filter that can only ever return nothing is a filter that looks broken.
    const service = new StubIdentityService().withRows([linked]);

    // when
    renderPage(service, NO_INTEGRATIONS);
    showEveryAccount();

    // then
    await waitFor(() => expect(screen.getByText("Dev Example")).toBeInTheDocument());
    const options = screen.getByLabelText("Filter by source").querySelectorAll("option");
    expect([...options].map((option) => option.textContent)).toEqual([
      "All sources",
      "Version control",
    ]);
  });

  it("should say so when nothing resembles an account", async () => {
    // given
    const orphan = IdentityRowBuilder.create().from("vcs", "bot@ci.local").named(null).build();
    const service = new StubIdentityService().withRows([orphan]);

    // when
    renderPage(service);

    // then
    await waitFor(() =>
      expect(
        screen.getByText("Nothing in the catalog resembles this account."),
      ).toBeInTheDocument(),
    );
    // And the account still gets a row, keyed on what it is called.
    expect(screen.getAllByText("bot@ci.local").length).toBeGreaterThan(0);
  });

  it("should explain an empty screen rather than showing a bare table", async () => {
    // given
    const service = new StubIdentityService().withRows([]);

    // when
    renderPage(service);

    // then
    await waitFor(() =>
      expect(screen.getByText(/No accounts to show/u)).toBeInTheDocument(),
    );
  });

  it("should surface a listing failure", async () => {
    // given
    const service = new StubIdentityService().withListFailure(new Error("backend is down"));

    // when
    renderPage(service);

    // then
    await waitFor(() =>
      expect(screen.getByText(/Failed to load identities/u)).toBeInTheDocument(),
    );
  });

  it("should exclude an account under the reason that was picked", async () => {
    // given
    // The reason is the only part of this decision anybody can review later, so
    // there is no path to excluding an account that does not record one.
    const bot = IdentityRowBuilder.create().from("vcs", "build-service").named(null).build();
    const service = new StubIdentityService().withRows([bot]);
    renderPage(service);
    await waitFor(() => expect(screen.getAllByText("build-service").length).toBeGreaterThan(0));

    // when
    fireEvent.click(screen.getByLabelText("Exclude build-service from measurement"));
    fireEvent.click(await screen.findByText("Service or system account"));

    // then
    await waitFor(() =>
      expect(screen.getByText("Service or system account")).toBeInTheDocument(),
    );
    expect(screen.getByText("1 listed · 1 unlinked · 1 excluded")).toBeInTheDocument();
  });

  it("should offer every reason the contract names", async () => {
    // given
    const bot = IdentityRowBuilder.create().from("vcs", "build-service").named(null).build();
    const service = new StubIdentityService().withRows([bot]);
    renderPage(service);
    await waitFor(() => expect(screen.getAllByText("build-service").length).toBeGreaterThan(0));

    // when
    fireEvent.click(screen.getByLabelText("Exclude build-service from measurement"));

    // then
    expect(await screen.findByText("Former contributor")).toBeInTheDocument();
    expect(screen.getByText("Open source contributor")).toBeInTheDocument();
    expect(screen.getByText("Automated bot")).toBeInTheDocument();
    expect(screen.getByText("Service or system account")).toBeInTheDocument();
  });

  it("should leave the account measured when the menu is dismissed", async () => {
    // given
    // Opening the menu is not the decision; picking a reason is.
    const bot = IdentityRowBuilder.create().from("vcs", "build-service").named(null).build();
    const service = new StubIdentityService().withRows([bot]);
    renderPage(service);
    await waitFor(() => screen.getAllByText("build-service"));
    fireEvent.click(screen.getByLabelText("Exclude build-service from measurement"));
    await screen.findByText("Automated bot");

    // when
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape", code: "Escape" });

    // then
    await waitFor(() => expect(screen.queryByText("Automated bot")).not.toBeInTheDocument());
    expect(screen.getByText("1 listed · 1 unlinked · 0 excluded")).toBeInTheDocument();
  });

  it("should measure an excluded account again", async () => {
    // given
    // Nothing was deleted, so this restores every window already collected.
    const bot = IdentityRowBuilder.create()
      .from("vcs", "build-service")
      .named(null)
      .excludedAs("service-account")
      .build();
    const service = new StubIdentityService().withRows([bot]);
    renderPage(service);
    await waitFor(() =>
      expect(screen.getByText("Service or system account")).toBeInTheDocument(),
    );

    // when
    fireEvent.click(screen.getByLabelText("Measure build-service again"));

    // then
    await waitFor(() =>
      expect(screen.queryByText("Service or system account")).not.toBeInTheDocument(),
    );
  });

  it("should not offer to undo an exclusion made on another account of the same person", async () => {
    // given
    // The decision lives on the account it was recorded against; a button here
    // would undo nothing, so the row says where it lives instead.
    const inherited = IdentityRowBuilder.create()
      .from("wakatime", "jrios")
      .named("Felipe Rios")
      .excludedAs("former-contributor", { source: "vcs", sourceKey: "jrios@example.com" })
      .build();
    const service = new StubIdentityService().withRows([inherited]);

    // when
    renderPage(service);

    // then
    await waitFor(() =>
      expect(screen.getByText("Former contributor")).toBeInTheDocument(),
    );
    expect(
      screen.getByText("Excluded with this person, on vcs:jrios@example.com."),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Measure jrios again")).not.toBeInTheDocument();
  });

  it("should narrow the listing to the accounts that are excluded", async () => {
    // given
    const bot = IdentityRowBuilder.create()
      .from("vcs", "build-service")
      .named(null)
      .excludedAs("automated-bot")
      .build();
    const service = new StubIdentityService().withRows([unlinked, bot]);
    renderPage(service);
    await waitFor(() => expect(screen.getByText("Felipe Rios")).toBeInTheDocument());

    // when
    fireEvent.change(screen.getByLabelText("Filter by measurement"), {
      target: { value: "excluded" },
    });

    // then
    await waitFor(() => expect(screen.queryByText("Felipe Rios")).not.toBeInTheDocument());
    expect(screen.getAllByText("build-service").length).toBeGreaterThan(0);
  });

  it("should ignore a measurement value it does not recognise", async () => {
    // given
    const service = new StubIdentityService().withRows([unlinked]);
    renderPage(service);
    await waitFor(() => expect(screen.getByText("Felipe Rios")).toBeInTheDocument());

    // when
    fireEvent.change(screen.getByLabelText("Filter by measurement"), {
      target: { value: "nonsense" },
    });

    // then
    await waitFor(() => expect(screen.getByText("Felipe Rios")).toBeInTheDocument());
    expect(service.filters[service.filters.length - 1]).toEqual({ linked: false });
  });

  it("should say plainly when an exclusion was refused", async () => {
    // given
    const bot = IdentityRowBuilder.create().from("vcs", "build-service").named(null).build();
    const service = new StubIdentityService()
      .withRows([bot])
      .withWriteFailure(new Error("no vcs identity called build-service has been observed"));
    renderPage(service);
    await waitFor(() => expect(screen.getAllByText("build-service").length).toBeGreaterThan(0));

    // when
    fireEvent.click(screen.getByLabelText("Exclude build-service from measurement"));
    fireEvent.click(await screen.findByText("Automated bot"));

    // then
    await waitFor(() =>
      expect(screen.getByText(/That change was not saved/u)).toBeInTheDocument(),
    );
  });
});
