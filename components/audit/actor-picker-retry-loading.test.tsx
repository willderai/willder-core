// @vitest-environment jsdom
//
// Regression test: the "Try again" retry affordance must genuinely re-fetch
// and must not claim an empty trail while a retry is pending, but a click
// alone gives the user no feedback of its own -- the button would otherwise
// sit there reading "Try again" for the whole in-flight request, identical
// to how it looked before the click. This pins that clicking
// retry visibly changes the button (disabled, relabeled "Retrying…")
// for as long as the request is outstanding, distinguishable from the idle
// post-failure state the user just clicked from, and that the button
// reverts once the request settles either way.
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

describe("ActorPicker — retry shows a visible in-flight state", () => {
  it('disables and relabels the button to "Retrying…" while the retry request is pending', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError("Failed to fetch");
    });
    // A retry that never settles on its own: proves the in-flight state is
    // driven by the request being outstanding, not by a timer or a guess.
    let resolveRetry: (() => void) | undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRetry = () => resolve(new Response(JSON.stringify({ actors: [] }), { status: 200 }));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<ActorPicker selected={null} onChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "All identities" }));

    const idleRetryButton = (await screen.findByRole("button", {
      name: "Try again",
    })) as HTMLButtonElement;
    expect(idleRetryButton.disabled).toBe(false);

    fireEvent.click(idleRetryButton);
    await flushMicrotasks();

    // Distinguishable from the idle state the user just clicked: relabeled
    // and disabled while genuinely in flight, not just re-rendering the
    // same "Try again" button with nothing to show for the click.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    const retryingButton = (await screen.findByRole("button", {
      name: "Retrying…",
    })) as HTMLButtonElement;
    expect(retryingButton.disabled).toBe(true);
    expect(retryingButton.getAttribute("aria-busy")).toBe("true");

    resolveRetry?.();

    // Settles back once the request resolves, whichever way it resolves.
    await screen.findByText("No actors in the audit trail yet.");
    expect(screen.queryByRole("button", { name: "Retrying…" })).toBeNull();
  });

  it('reverts to the idle, enabled "Try again" state after a retry fails again', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ActorPicker selected={null} onChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "All identities" }));

    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    const retryButtonAgain = (await screen.findByRole("button", {
      name: "Try again",
    })) as HTMLButtonElement;
    expect(retryButtonAgain.disabled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
