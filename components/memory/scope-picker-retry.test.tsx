// @vitest-environment jsdom
//
// Regression test for scope-picker-silent-empty-state-no-retry: pins that
// the "Try again" retry affordance actually re-runs the request and recovers
// once the retried request succeeds, mirroring ActorPicker's
// actorpicker-degraded-retry-is-a-dead-end fix.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ScopePicker } from "./scope-picker";

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe("ScopePicker — retry after a failed load", () => {
  it('clicking "Try again" re-fetches and recovers once the retry succeeds', async () => {
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

    const retryButton = await screen.findByRole("button", { name: "Try again" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(retryButton);

    expect(await screen.findByText("Sales")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("a second retry click after another failure fires a third real request, not a no-op", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ScopePicker selected={null} onChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Org root" }));

    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });
});
