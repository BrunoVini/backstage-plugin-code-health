import { NO_INTEGRATIONS } from "@rios0rios0/backstage-plugin-code-health-common";
import { fireEvent, render as renderBare, screen, waitFor } from "@testing-library/react";
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
    fireEvent.change(screen.getByLabelText("Catalog user for jrios"), {
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
    fireEvent.change(screen.getByLabelText("Catalog user for jrios"), {
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
