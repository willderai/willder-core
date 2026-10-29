// @vitest-environment jsdom
//
// Regression test for actorpicker-degraded-retry-is-a-dead-end: the actors
// fetch used to live in a mount-only `useEffect([])`, and `ActorPicker` never
// unmounts when the dropdown closes (only the `{open && ...}` JSX toggles),
// so the "try reopening this menu" remedy on a failed load could never
// re-fetch -- closing and reopening left `actors`/`loadError` exactly as
// they were (probed empirically: 1 fetch after first open, still 1 after
// close+reopen). This pins that the "Try again" retry affordance actually
// re-runs the request and recovers once the retried request succeeds.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ActorPicker } from "./actor-picker";

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe("ActorPicker — retry after a failed load", () => {
  it('clicking "Try again" re-fetches and recovers once the retry succeeds', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError("Failed to fetch");
    });
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ actors: [{ actorType: "human", actorId: "u1", name: "Ada" }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<ActorPicker selected={null} onChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "All identities" }));

    const retryButton = await screen.findByRole("button", { name: "Try again" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(retryButton);

    expect(await screen.findByText("Ada")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("a second retry click after another failure fires a third real request, not a no-op", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ActorPicker selected={null} onChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "All identities" }));

    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });
});
