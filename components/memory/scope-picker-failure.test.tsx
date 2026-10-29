// @vitest-environment jsdom
//
// Regression test: `ScopePicker` must not load its scopes with
// `fetch(...).then(r => r.json()).catch(() => ({ scopes: [] }))` and then
// `setScopes(data.scopes ?? [])` without checking `r.ok` on either half — that
// silently produces scopes=[] on both a network failure and an HTTP error
// whose body is valid JSON, with no signal anything failed and no way to
// recover short of a full page reload. Same class of bug as ActorPicker's
// load-failure and retry handling.
//
// These tests are behavior-level on purpose: they pin only that a failure is
// now DISTINGUISHABLE (an error message renders) and recoverable (a "Try
// again" affordance exists). The control test (a genuine empty response)
// stops a fix from passing by inventing an error where none occurred.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ScopePicker } from "./scope-picker";

const LOAD_ERROR_MESSAGE = "Couldn't load scopes.";

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

async function renderPickerOpen() {
  render(<ScopePicker selected={null} onChange={vi.fn()} />);
  const trigger = await screen.findByRole("button", { name: "Org root" });
  trigger.click();
  // Once open, the dropdown adds its own "Org root" row, so the same name
  // matches twice. Waiting for that second match proves the menu actually
  // opened.
  await waitFor(() => {
    expect(screen.getAllByRole("button", { name: "Org root" })).toHaveLength(2);
  });
}

describe("ScopePicker — a failed load is not a genuinely empty scope list", () => {
  it("a network failure surfaces an error and a retry affordance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    await renderPickerOpen();

    expect(await screen.findByText(LOAD_ERROR_MESSAGE)).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("a 403 from the scopes route surfaces an error and a retry affordance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })),
    );

    await renderPickerOpen();

    expect(await screen.findByText(LOAD_ERROR_MESSAGE)).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("CONTROL: a genuinely empty scope list renders no error and no retry button", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ scopes: [] }), { status: 200 })),
    );

    await renderPickerOpen();

    expect(screen.queryByText(LOAD_ERROR_MESSAGE)).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});
