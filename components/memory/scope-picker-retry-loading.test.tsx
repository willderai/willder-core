// @vitest-environment jsdom
//
// Regression test for scope-picker-silent-empty-state-no-retry: pins that
// clicking retry visibly changes the button (disabled, relabeled
// "Retrying…") for as long as the request is outstanding, distinguishable
// from the idle post-failure state the user just clicked from, and that the
// button reverts once the request settles either way. Mirrors ActorPicker's
// actorpicker-retry-fix follow-on.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

describe("ScopePicker — retry shows a visible in-flight state", () => {
  it('disables and relabels the button to "Retrying…" while the retry request is pending', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError("Failed to fetch");
    });
    let resolveRetry: (() => void) | undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRetry = () => resolve(new Response(JSON.stringify({ scopes: [] }), { status: 200 }));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<ScopePicker selected={null} onChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Org root" }));

    const idleRetryButton = (await screen.findByRole("button", {
      name: "Try again",
    })) as HTMLButtonElement;
    expect(idleRetryButton.disabled).toBe(false);

    fireEvent.click(idleRetryButton);
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    const retryingButton = (await screen.findByRole("button", {
      name: "Retrying…",
    })) as HTMLButtonElement;
    expect(retryingButton.disabled).toBe(true);
    expect(retryingButton.getAttribute("aria-busy")).toBe("true");

    resolveRetry?.();

    // Settles back once the request resolves: a genuine empty result clears
    // the error box (and its retry button) entirely.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Retrying…" })).toBeNull();
    });
    expect(screen.queryByText("Couldn't load scopes.")).toBeNull();
  });

  it('reverts to the idle, enabled "Try again" state after a retry fails again', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ScopePicker selected={null} onChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Org root" }));

    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    const retryButtonAgain = (await screen.findByRole("button", {
      name: "Try again",
    })) as HTMLButtonElement;
    expect(retryButtonAgain.disabled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
