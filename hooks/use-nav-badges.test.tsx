import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNavBadges } from "./use-nav-badges";

vi.mock("next/navigation", () => ({ usePathname: () => "/settings" }));

const answer = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

/** Let the pending fetch and its json() settle inside act(). */
const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// A count the server could not run arrives as null. Shown as 0 it would claim a
// quiet period nobody measured; the nav shows no badge for it instead.
describe("useNavBadges", () => {
  it("keeps a count the server could not run as unknown, not 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => answer(200, { activeAgentRuns: null, newContacts: 0, newMemoryChunks: 3 })),
    );
    const { result } = renderHook(() => useNavBadges());
    await settle();
    expect(result.current).toEqual({ "/agents": null, "/memory": 3 });
  });

  it("drops counts it can no longer vouch for after a failed poll, and keeps polling", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => answer(200, { activeAgentRuns: 2, newContacts: 0, newMemoryChunks: 3 }))
      .mockImplementationOnce(() => answer(500, { error: "internal" }))
      .mockImplementation(() => answer(200, { activeAgentRuns: 1, newContacts: 0, newMemoryChunks: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useNavBadges());
    await settle();
    expect(result.current).toEqual({ "/agents": 2, "/memory": 3 });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(result.current).toEqual({ "/agents": null, "/memory": null });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.current).toEqual({ "/agents": 1, "/memory": 0 });
  });
});
