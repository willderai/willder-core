// @vitest-environment jsdom
//
// Regression test: picker failures must not look like an empty trail.
//
// `ActorPicker` loads its identities with
// `fetch(...).then(r => r.json()).catch(() => ({ actors: [] }))` and then
// `setActors(data.actors ?? [])`. Neither half checks `r.ok`, so BOTH of
// these collapse to the same empty list:
//
//   1. a network / JSON-parse failure, caught into `{ actors: [] }`;
//   2. an HTTP error whose body is valid JSON — and this route's own
//      guards return exactly that: `{ error: "unauthorized" }` (401) and
//      `{ error: "forbidden" }` (403) from `app/api/audit/actors/route.ts`.
//      `r.json()` succeeds, `data.actors` is undefined, `?? []` wins.
//
// The picker then renders "No actors in the audit trail yet." — a confident,
// specific claim about the audit trail — when what actually happened is that
// it never learned anything about the audit trail at all. On the audit
// screen, during the investigation the picker exists to support, a
// swallowed failure that presents as a valid empty answer is the wrong
// failure shape. An admin has no signal and no retry path.
//
// These tests are behavior-level on purpose: they pin only that a failure is
// DISTINGUISHABLE from a genuine empty trail. They deliberately do not
// prescribe the error copy, an error element, or a retry affordance — that
// shape is the builder's call. The third test is the control: a real empty trail
// must still say so, so a fix cannot pass by simply deleting the message.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ActorPicker } from "./actor-picker";

const EMPTY_TRAIL_MESSAGE = "No actors in the audit trail yet.";

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

async function renderPickerOpen() {
  render(<ActorPicker selected={null} onChange={vi.fn()} />);
  // While the dropdown is closed only the trigger carries this accessible
  // name, so this query is unambiguous here and nowhere else.
  const trigger = await screen.findByRole("button", { name: "All identities" });
  trigger.click();
  // Once open, the dropdown adds its own "All identities" row, so the same
  // name matches twice. Waiting for that second match is what proves the menu
  // actually opened — without it every `queryByText(...)).toBeNull()` below
  // could pass vacuously against a dropdown that never rendered at all.
  await waitFor(() => {
    expect(screen.getAllByRole("button", { name: "All identities" })).toHaveLength(2);
  });
}

describe("ActorPicker — a failed load is not an empty audit trail", () => {
  it("a network failure does not claim the audit trail is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    await renderPickerOpen();

    expect(screen.queryByText(EMPTY_TRAIL_MESSAGE)).toBeNull();
  });

  it("a 403 from the actors route does not claim the audit trail is empty", async () => {
    // The exact body app/api/audit/actors/route.ts returns when `access.manage`
    // is denied. Valid JSON, so `r.json()` resolves and the `.catch` never runs.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })),
    );

    await renderPickerOpen();

    expect(screen.queryByText(EMPTY_TRAIL_MESSAGE)).toBeNull();
  });

  it("CONTROL: a genuinely empty trail still says the trail is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ actors: [] }), { status: 200 })),
    );

    await renderPickerOpen();

    expect(await screen.findByText(EMPTY_TRAIL_MESSAGE)).toBeTruthy();
  });
});
