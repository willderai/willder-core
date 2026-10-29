// @vitest-environment jsdom
//
// refreshScopes() must not silently replace a known-good scope list with [].
// All three loaders route through one shared loadScopes(), which on failure
// leaves `scopes` untouched and sets `loadError`. That closes the
// silent-EMPTY half.
//
// This file pins what is left: the error box and its "Try again" button are
// gated on `subScopes.length === 0 && !loading && loadError`, so when the
// surviving list is NOT empty the failure is never rendered at all. After a
// DELETE that really succeeded server-side plus a refresh that failed, the
// dropdown stays open showing the just-deleted scope, the confirm UI clears
// (handleDelete calls setConfirmDelete(null) on the success path regardless of
// the refresh outcome), and `deleteError` stays "". The admin must not be
// shown a state that is both wrong and silent, with no retry affordance, on
// this path.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ScopePicker } from "./scope-picker";

const LOAD_ERROR_MESSAGE = "Couldn't load scopes.";

const SCOPES = [
  { id: "s_root", path: "org_abc", name: "Acme" },
  { id: "s_sales", path: "org_abc.sales_def", name: "Sales" },
  { id: "s_eng", path: "org_abc.eng_ghi", name: "Engineering" },
];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

async function openAndArmDelete(label: string) {
  render(<ScopePicker selected={null} onChange={vi.fn()} manageable />);
  fireEvent.click(await screen.findByRole("button", { name: "Org root" }));
  expect(await screen.findByText(label)).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: `Delete ${label}` }));
  return screen.findByRole("button", { name: "Delete" });
}

describe("ScopePicker — a failed post-delete refresh must be surfaced even when the surviving list is NOT empty", () => {
  it("network failure on the refresh: the failure must be visible, not hidden behind a stale list", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockImplementationOnce(async () => jsonResponse({ scopes: SCOPES })); // mount
    fetchMock.mockImplementationOnce(async () => jsonResponse({ ok: true })); // DELETE succeeds
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError("Failed to fetch");
    }); // refresh fails
    vi.stubGlobal("fetch", fetchMock);

    fireEvent.click(await openAndArmDelete("Sales"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    // REQUIREMENT: the refresh failed, so the list on screen is known-stale
    // (it still contains the scope the server already deleted). The user must
    // be told, and must be given the same recovery affordance the mount path
    // already offers. Failed before the fix: the box is gated on
    // `subScopes.length === 0`, so a non-empty stale list renders nothing.
    await waitFor(() => {
      expect(screen.queryByText(LOAD_ERROR_MESSAGE)).not.toBeNull();
    });
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("HTTP error with a JSON body on the refresh: same requirement, the other failure shape", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockImplementationOnce(async () => jsonResponse({ scopes: SCOPES }));
    fetchMock.mockImplementationOnce(async () => jsonResponse({ ok: true }));
    fetchMock.mockImplementationOnce(async () => jsonResponse({ error: "internal error" }, 500));
    vi.stubGlobal("fetch", fetchMock);

    fireEvent.click(await openAndArmDelete("Sales"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    await waitFor(() => {
      expect(screen.queryByText(LOAD_ERROR_MESSAGE)).not.toBeNull();
    });
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("CONTROL: the same failure on an EMPTY list already surfaces today, so the gate is the only difference", async () => {
    const ONE = [SCOPES[0], SCOPES[1]];
    const fetchMock = vi.fn();
    // Mount load fails outright -> subScopes.length === 0 -> the box renders.
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ScopePicker selected={null} onChange={vi.fn()} manageable />);
    fireEvent.click(await screen.findByRole("button", { name: "Org root" }));

    expect(await screen.findByText(LOAD_ERROR_MESSAGE)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(ONE.length).toBe(2); // keeps the fixture referenced, no behavioural meaning
  });
});
