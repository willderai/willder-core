// @vitest-environment jsdom
//
// Regression test for scope-picker-silent-empty-state-no-retry's own retry
// path: `retryLoadScopes()` must not clear `loadError` until the retry
// actually settles. Clearing it eagerly would, for the whole duration of an
// in-flight retry, leave the component silently indistinguishable from a
// genuinely empty scope list with no affordance and no progress signal --
// the same follow-on review found on ActorPicker's retry path
// (actorpicker-degraded-retry-is-a-dead-end).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ScopePicker } from "./scope-picker";

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("ScopePicker — retry in flight must not silently look recovered", () => {
  it("keeps a visible affordance while the retry is still pending, not a bare empty menu", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError("Failed to fetch");
    });
    // A retry request that never settles: a slow or hanging network, the
    // condition that produced the failed load in the first place.
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    render(<ScopePicker selected={null} onChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Org root" }));

    const retryButton = await screen.findByRole("button", { name: "Try again" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(retryButton);
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The user must not be stranded with no affordance and no progress
    // signal: either the retry control or the error context has to survive.
    const stillHasAffordance =
      screen.queryByRole("button", { name: "Try again" }) !== null ||
      screen.queryByRole("button", { name: "Retrying…" }) !== null ||
      screen.queryByText("Couldn't load scopes.") !== null;
    expect(stillHasAffordance).toBe(true);
  });

  // Control: a genuine retry success clears the error box entirely. This is
  // what stops the test above from being satisfied by simply never clearing
  // the error state at all.
  it("clears the error box when a retry genuinely succeeds", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError("Failed to fetch");
    });
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ scopes: [{ id: "s1", path: "root_abc.sales_def", name: "Sales" }] }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<ScopePicker selected={null} onChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Org root" }));

    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Sales")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Couldn't load scopes.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});
