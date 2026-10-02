import type { GetAccessResponse } from "@rios0rios0/backstage-plugin-code-health-common";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IngestionResetButton } from "../../../src/presentation/components/ingestion_reset_button";
import { NO_ADMINISTRATION_ACCESS } from "../../../src/presentation/hooks/use_access";
import { StubAdministrationService } from "../../doubles/stub_administration_service";

/**
 * A fixed September instant, the same one `reset_reach.test.ts` uses and for
 * the same reason: the day count beside each reach is calendar arithmetic
 * against `new Date()`, which the dialog reads itself and no test can inject.
 * Left on the real clock this file asserts "1 month (31 days)" and passes only
 * in a month whose predecessor has 31 days -- it was green in August and red
 * on the second of October, for no reason connected to the code.
 *
 * Only `Date` is faked. The timers stay real, because React Testing Library's
 * `findBy`/`waitFor` are driven by them and a fake one makes them hang.
 */
const FROZEN_NOW = new Date(2026, 8, 9, 12, 0, 0, 0);

beforeAll(() => {
  jest.useFakeTimers({
    now: FROZEN_NOW,
    doNotFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "setImmediate",
      "clearImmediate",
      "nextTick",
      "queueMicrotask",
      "performance",
      "requestAnimationFrame",
      "cancelAnimationFrame",
    ],
  });
});

afterAll(() => {
  jest.useRealTimers();
});

/** What the backend answers a configured administrator. */
const administrator = (retentionDays = 365): GetAccessResponse => ({
  ...NO_ADMINISTRATION_ACCESS,
  canResetIngestion: true,
  retentionDays,
});

/**
 * The control is handed what the backend answered rather than asking itself:
 * the page asks once for every administrator control it draws. Whoever the
 * stub was configured as, the access here is what decides the drawing.
 */
const renderButton = (
  service: StubAdministrationService,
  onReset: () => void = () => undefined,
  access: GetAccessResponse = administrator(),
) =>
  render(
    <IngestionResetButton access={access} administrationService={service} onReset={onReset} />,
  );

/** Clicks the header control and waits for the confirmation to be on screen. */
const openDialog = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Re-collect history" }));
  return screen.findByRole("dialog");
};

const reachSelect = () => screen.getByLabelText("How far back") as HTMLSelectElement;

const optionStarting = (prefix: string): HTMLOptionElement => {
  const found = [...reachSelect().options].find((option) => option.text.startsWith(prefix));
  if (!found) throw new Error(`no reach option starting "${prefix}"`);
  return found;
};

describe("IngestionResetButton", () => {
  it("should draw nothing for a reader who may not reset the history", () => {
    // given
    // What a fresh install answers everybody: it names no administrators
    // until somebody configures one.
    const service = new StubAdministrationService();

    // when
    renderButton(service, () => undefined, NO_ADMINISTRATION_ACCESS);

    // then
    expect(screen.queryByRole("button", { name: "Re-collect history" })).not.toBeInTheDocument();
  });

  it("should draw nothing for somebody who may change the scoring but not reset", () => {
    // given
    // The two are separate permissions, and a policy can grant one without
    // the other; the control reads its own flag and nothing else.
    const service = new StubAdministrationService();

    // when
    renderButton(service, () => undefined, {
      ...NO_ADMINISTRATION_ACCESS,
      canManageScoring: true,
    });

    // then
    expect(screen.queryByRole("button", { name: "Re-collect history" })).not.toBeInTheDocument();
  });

  it("should offer an administrator a control in the header", async () => {
    // given
    const service = new StubAdministrationService().withAdministrator();

    // when
    renderButton(service);

    // then
    expect(await screen.findByRole("button", { name: "Re-collect history" })).toBeInTheDocument();
  });

  it("should say what a reset throws away, what it costs and what it keeps", async () => {
    // given
    renderButton(new StubAdministrationService().withAdministrator());

    // when
    await openDialog();

    // then
    expect(screen.getByText(/discarded and read again/)).toBeInTheDocument();
    expect(screen.getByText(/wider ranges unlock as it advances/)).toBeInTheDocument();
    expect(screen.getByText(/Releases, tags/)).toBeInTheDocument();
  });

  it("should offer only the reaches the retention has something behind", async () => {
    // given
    // Sixty days retained leaves a month reachable and nothing longer.
    renderButton(new StubAdministrationService().withAdministrator(60), () => undefined, administrator(60));

    // when
    await openDialog();

    // then
    expect([...reachSelect().options].map((option) => option.text)).toEqual([
      "1 month (31 days)",
      "Everything retained (60 days)",
    ]);
  });

  it("should open on the whole retention", async () => {
    // given
    renderButton(new StubAdministrationService().withAdministrator(365));

    // when
    await openDialog();

    // then
    // A reset is usually asked for because something was collected wrongly, and
    // a partial re-read leaves the older half wrong while looking finished.
    expect(reachSelect().selectedOptions[0].text).toBe("Everything retained (365 days)");
    expect(screen.getByRole("button", { name: "Re-collect 365 days" })).toBeInTheDocument();
  });

  it("should send the reach that was picked and then tell the caller", async () => {
    // given
    const service = new StubAdministrationService().withAdministrator(400);
    let reloads = 0;
    renderButton(
      service,
      () => {
        reloads += 1;
      },
      administrator(400),
    );
    await openDialog();
    const quarter = optionStarting("3 months");
    const days = Number(/\((\d+) days\)/.exec(quarter.text)?.[1]);

    // when
    fireEvent.change(reachSelect(), { target: { value: quarter.value } });
    fireEvent.click(screen.getByRole("button", { name: "Re-collect 3 months" }));

    // then
    // The figure the request carries is the one the option showed, so a reader
    // is never asked to trust a translation they cannot see.
    await waitFor(() => expect(service.resets).toEqual([{ days }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(reloads).toBe(1);
  });

  it("should name how many repositories were sent back to the start", async () => {
    // given
    const service = new StubAdministrationService().withAdministrator(365).withRepositoryCount(12);
    renderButton(service);
    await openDialog();

    // when
    fireEvent.click(screen.getByRole("button", { name: "Re-collect 365 days" }));

    // then
    expect(
      await screen.findByText("Re-collecting 365 days of history for 12 repositories."),
    ).toBeInTheDocument();
  });

  it("should let the confirmation be dismissed before it times out", async () => {
    // given
    const service = new StubAdministrationService().withAdministrator(365);
    renderButton(service);
    await openDialog();
    fireEvent.click(screen.getByRole("button", { name: "Re-collect 365 days" }));
    await screen.findByText(/Re-collecting 365 days/);

    // when
    // Clicking anywhere else: the confirmation is a receipt, not a question,
    // so it should never stand between the reader and the dashboard.
    fireEvent.click(document.body);

    // then
    await waitFor(() => expect(screen.queryByText(/Re-collecting/)).not.toBeInTheDocument());
  });

  it("should not write a plural over a single day and a single repository", async () => {
    // given
    // One day retained leaves the full-retention reach as the only one there is.
    const service = new StubAdministrationService().withAdministrator(1).withRepositoryCount(1);
    renderButton(service, () => undefined, administrator(1));
    await openDialog();

    // when
    fireEvent.click(screen.getByRole("button", { name: "Re-collect 1 day" }));

    // then
    expect(
      await screen.findByText("Re-collecting 1 day of history for 1 repository."),
    ).toBeInTheDocument();
  });

  it("should hold the dialog shut while the request is in flight", async () => {
    // given
    const service = new StubAdministrationService().withAdministrator();
    const release = service.holdResets();
    renderButton(service);
    await openDialog();

    // when
    fireEvent.click(screen.getByRole("button", { name: "Re-collect 365 days" }));

    // then
    // Both ways out are shut, because a second click would start a second walk
    // over the same repositories.
    await waitFor(() => expect(service.resets).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Re-collect 365 days" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("should show the backend's refusal without closing the dialog", async () => {
    // given
    const service = new StubAdministrationService()
      .withAdministrator()
      .withResetError(new Error("403 Forbidden"));
    let reloads = 0;
    renderButton(service, () => {
      reloads += 1;
    });
    await openDialog();

    // when
    fireEvent.click(screen.getByRole("button", { name: "Re-collect 365 days" }));

    // then
    // Kept where the reader is: the two answers to a refusal — a shorter reach,
    // or giving up — are both in this dialog.
    expect(await screen.findByText("403 Forbidden")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(reloads).toBe(0);
  });

  it("should report a refusal that arrives as something other than an error", async () => {
    // given
    // A rejected `fetch` chain settles with whatever it was handed, which is
    // not always an `Error`.
    const service = new StubAdministrationService()
      .withAdministrator()
      .withResetError("gateway said no");
    renderButton(service);
    await openDialog();

    // when
    fireEvent.click(screen.getByRole("button", { name: "Re-collect 365 days" }));

    // then
    expect(await screen.findByText("gateway said no")).toBeInTheDocument();
  });

  it("should ask for nothing when the reader cancels", async () => {
    // given
    const service = new StubAdministrationService().withAdministrator();
    renderButton(service);
    await openDialog();

    // when
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // then
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(service.resets).toEqual([]);
  });
});
