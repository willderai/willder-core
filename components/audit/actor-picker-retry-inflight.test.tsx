// @vitest-environment jsdom
//
// Regression test: `retryLoadActors()` must not clear `loadError` without
// also setting `loading`, or for the entire duration of the retry request the
// component sits in actors=[] / !loading / !loadError -- the one branch that
// renders the positive claim "No actors in the audit trail yet."
//
// That breaks the invariant this component states in its own source comment
// above `loadError` (actor-picker.tsx): a failed load and a genuinely empty
// trail "must never both collapse into 'no actors' -- the caller learned
// nothing about the trail, that's not the same claim." This is that same
// defect class reappearing on the retry path.
//
// It also matters most exactly when it is most wrong: a user only clicks
// "Try again" because the network is already degraded, so the window where
// the audit screen falsely asserts an empty trail is widest precisely when
// the request is slowest -- and the "Try again" button unmounts along with
// the error copy, leaving no affordance and no progress indication.
//
// These tests pin the contract, not the fix shape. Any of a `retrying`
// state, holding `loadError` until the retry settles, or reusing `loading`
// will satisfy them; deleting the empty-state message will not (see the
// second test, which is the control).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ActorPicker } from "./actor-picker";

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("ActorPicker — retry in flight must not claim an empty audit trail", () => {
  it('does not render "No actors in the audit trail yet." while the retry is still pending', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError("Failed to fetch");
    });
    // A retry request that never settles: a slow or hanging network, which is
    // the condition that produced the failed load in the first place.
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    render(<ActorPicker selected={null} onChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "All identities" }));

    const retryButton = await screen.findByRole("button", { name: "Try again" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(retryButton);
    await flushMicrotasks();

    // The retry is genuinely in flight...
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // ...so the component knows nothing about the trail's contents, and must
    // not assert that it is empty.
    expect(screen.queryByText("No actors in the audit trail yet.")).toBeNull();

    // And the user must not be stranded with no affordance and no progress
    // signal: either the retry control or the error context has to survive.
    const stillHasAffordance =
      screen.queryByRole("button", { name: "Try again" }) !== null ||
      screen.queryByText("Couldn't load actors.") !== null;
    expect(stillHasAffordance).toBe(true);
  });

  // Control: the empty-state message is correct and must stay for the case it
  // was written for. This is what stops the test above from being "satisfied"
  // by simply deleting the message.
  it("still renders the empty-trail message when a retry genuinely succeeds with zero actors", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError("Failed to fetch");
    });
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ actors: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<ActorPicker selected={null} onChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "All identities" }));

    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByText("No actors in the audit trail yet.")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Couldn't load actors.")).toBeNull();
  });
});
