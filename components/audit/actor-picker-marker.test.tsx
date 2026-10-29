// @vitest-environment jsdom
//
// The picker caps each label's width with CSS truncation. A custom agent's label carries
// a marker, ` (agent key "...")`, that is the only visible difference from a product
// writer of the same name, so the marker sits outside the truncated element: the ellipsis
// can eat the name, never the marker.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ActorPicker } from "./actor-picker";

const MARKER = ' (agent key "custom-1")';
const ACTORS = [
  { actorType: "agent", actorId: "architecture-agent", name: "Architecture agent Agent" },
  { actorType: "agent", actorId: "custom-1", name: `Architecture agent Agent${MARKER}` },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function markerElements(): HTMLElement[] {
  return screen.getAllByText(MARKER.trim(), { normalizer: (t) => t.trim() });
}

describe("ActorPicker label truncation", () => {
  it("keeps a custom agent's marker outside the truncated name, in the list and on the trigger", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ actors: ACTORS }), { status: 200 })),
    );
    const { rerender } = render(<ActorPicker selected={null} onChange={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "All identities" }));

    const [inList] = markerElements();
    expect(inList!.classList.contains("truncate")).toBe(false);
    expect(inList!.closest(".truncate")).toBeNull();
    expect(inList!.classList.contains("shrink-0")).toBe(true);

    rerender(<ActorPicker selected={{ actorType: "agent", actorId: "custom-1" }} onChange={() => {}} />);
    for (const marker of markerElements()) {
      expect(marker.closest(".truncate")).toBeNull();
      expect(marker.classList.contains("shrink-0")).toBe(true);
    }
  });
});
