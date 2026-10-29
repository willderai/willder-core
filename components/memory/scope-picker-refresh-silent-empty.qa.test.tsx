// @vitest-environment jsdom
//
// The silent-empty-state fix on the MOUNT load path (`useEffect` ->
// `loadError` + "Try again") does not by itself cover `refreshScopes()` — the
// second loader in the same component — which must not carry the same
// pre-fix pattern:
//
//   const data = await fetch("/api/memory/scopes")
//     .then((r) => r.json())          // no r.ok check
//     .catch(() => ({ scopes: [] }))  // failure collapses to "empty"
//   setScopes(data.scopes ?? []);
//
// It runs after a SUCCESSFUL scope create (handleCreate) and after a
// SUCCESSFUL scope delete (handleDelete). When that refresh request fails, it
// must not silently replace a known-good scope list with [] without setting
// `loadError`, since the error box and its retry affordance are gated on
// `subScopes.length === 0 && !loading && loadError`.
//
// The delete path is the sharpest repro because `handleDelete` leaves the
// dropdown OPEN, so the user watches a populated list become empty with no
// error and no way to recover short of a full page reload. It is also
// strictly worse than the mount case the PR fixed: this one destroys data
// that had already loaded correctly.
//
// Both failure shapes the PR's own mount tests cover are exercised here on
// the refresh path: a network throw, and an HTTP error whose body is valid
// JSON. The control proves these tests are not simply asserting that a
// refresh can never empty a list.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ScopePicker } from "./scope-picker";

const LOAD_ERROR_MESSAGE = "Couldn't load scopes.";

const SCOPES = [
  { id: "s_root", path: "org_abc", name: "Acme" },
  { id: "s_sales", path: "org_abc.sales_def", name: "Sales" },
];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

/** Open the picker with a healthy scope list already loaded, then drive the
 *  inline delete confirmation for "Sales" up to (not including) the confirm
 *  click. Returns the confirm button. */
async function openAndArmDelete() {
  render(<ScopePicker selected={null} onChange={vi.fn()} manageable />);

  fireEvent.click(await screen.findByRole("button", { name: "Org root" }));
  // The healthy list really did load before we break anything.
  expect(await screen.findByText("Sales")).toBeTruthy();

  // The row's delete control is an icon-only button with no accessible name
  // (a separate, minor a11y nit noted in the QA verdict), so it is addressed
  // structurally: the second button inside the "Sales" row.
  const salesRow = screen.getByText("Sales").closest("div.group");
  if (!salesRow) throw new Error("could not locate the Sales scope row");
  const rowButtons = salesRow.querySelectorAll("button");
  const deleteIcon = rowButtons[rowButtons.length - 1];
  fireEvent.click(deleteIcon);

  return screen.findByRole("button", { name: "Delete" });
}

describe("ScopePicker — a failed post-delete refresh must not silently empty the list", () => {
  it("network failure on the refresh: does not leave a silent empty list with no error", async () => {
    const fetchMock = vi.fn();
    // 1. mount load — healthy
    fetchMock.mockImplementationOnce(async () => jsonResponse({ scopes: SCOPES }));
    // 2. DELETE /api/access/scopes/:id — succeeds
    fetchMock.mockImplementationOnce(async () => jsonResponse({ ok: true }));
    // 3. refreshScopes() GET — the network drops
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    fireEvent.click(await openAndArmDelete());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    // The user is still looking at an open dropdown. Whatever we show, it
    // must not be an unexplained empty list: either the previously-loaded
    // scopes survive, or the failure is surfaced and recoverable.
    await waitFor(() => {
      const listSurvived = screen.queryByText("Sales") !== null;
      const failureSurfaced =
        screen.queryByText(LOAD_ERROR_MESSAGE) !== null || screen.queryByRole("button", { name: "Try again" }) !== null;
      expect(listSurvived || failureSurfaced).toBe(true);
    });
  });

  it("HTTP error with a JSON body on the refresh: does not silently empty the list", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockImplementationOnce(async () => jsonResponse({ scopes: SCOPES }));
    fetchMock.mockImplementationOnce(async () => jsonResponse({ ok: true }));
    // A 500 whose body parses as JSON — `.then(r => r.json())` resolves, so
    // the `.catch` never fires and `data.scopes ?? []` yields []. This is the
    // half of the original bug that a bare try/catch would still miss.
    fetchMock.mockImplementationOnce(async () => jsonResponse({ error: "internal error" }, 500));
    vi.stubGlobal("fetch", fetchMock);

    fireEvent.click(await openAndArmDelete());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    await waitFor(() => {
      const listSurvived = screen.queryByText("Sales") !== null;
      const failureSurfaced =
        screen.queryByText(LOAD_ERROR_MESSAGE) !== null || screen.queryByRole("button", { name: "Try again" }) !== null;
      expect(listSurvived || failureSurfaced).toBe(true);
    });
  });

  it("CONTROL: a refresh that genuinely succeeds updates the list and shows no error", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockImplementationOnce(async () => jsonResponse({ scopes: SCOPES }));
    fetchMock.mockImplementationOnce(async () => jsonResponse({ ok: true }));
    // The scope really is gone now — an empty sub-scope list here is the
    // truth, not a failure, and must stay silent.
    fetchMock.mockImplementationOnce(async () => jsonResponse({ scopes: [SCOPES[0]] }));
    vi.stubGlobal("fetch", fetchMock);

    fireEvent.click(await openAndArmDelete());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryByText("Sales")).toBeNull());

    expect(screen.queryByText(LOAD_ERROR_MESSAGE)).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});
