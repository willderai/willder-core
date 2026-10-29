// @vitest-environment jsdom
//
// Pins Reveal's mount-time transform before adding a prefers-reduced-motion
// guard (per the landing-page-redesign wireframe's flagged gap: Backdrop and
// grain-background already check matchMedia explicitly, Reveal never did,
// so every Reveal-wrapped block -- most of the page -- ignored the setting).
//
// useReducedMotion itself is framer-motion's own matchMedia wiring, not
// Reveal's -- mocked here so this test exercises what Reveal actually does
// with that signal, not framer-motion's browser-detection plumbing.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { Reveal } from "./reveal";

// `null` is what framer-motion reports before it can read the preference,
// which is always the case on the server.
const reducedMotion = vi.hoisted(() => ({ value: false as boolean | null }));

vi.mock("framer-motion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("framer-motion")>();
  return { ...actual, useReducedMotion: () => reducedMotion.value };
});

// jsdom has no IntersectionObserver; framer-motion's whileInView needs one
// to mount at all. A minimal stub is enough -- these tests only assert the
// synchronous mount-time transform, never an actual in-view trigger.
class IntersectionObserverStub {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  reducedMotion.value = false;
});

describe("Reveal", () => {
  it("starts offset (y: 24px) by default, matching the existing entrance animation", () => {
    vi.stubGlobal("IntersectionObserver", IntersectionObserverStub);
    const { container } = render(<Reveal>content</Reveal>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.style.transform).toContain("translateY(24px)");
  });

  it("settles in its resting position with no offset when prefers-reduced-motion is set", async () => {
    vi.stubGlobal("IntersectionObserver", IntersectionObserverStub);
    reducedMotion.value = true;
    const { container } = render(<Reveal>content</Reveal>);
    const el = container.firstElementChild as HTMLElement;
    await waitFor(() => expect(el.style.transform || "").not.toContain("translateY(24px)"));
  });

  // The server cannot read the preference, so it always renders the offset.
  // A client that rendered no offset under reduced motion hydrated against
  // markup it did not produce: React logged the mismatch and kept the
  // server's transform, so the block stayed 24px low.
  it("hydrates the server markup without a mismatch under prefers-reduced-motion, then settles", async () => {
    vi.stubGlobal("IntersectionObserver", IntersectionObserverStub);
    reducedMotion.value = null;
    const host = document.createElement("div");
    host.innerHTML = renderToString(<Reveal>content</Reveal>);
    document.body.append(host);
    const el = host.firstElementChild as HTMLElement;
    expect(el.style.transform).toContain("translateY(24px)");

    reducedMotion.value = true;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await act(async () => {
        hydrateRoot(host, <Reveal>content</Reveal>);
      });
      expect(consoleError).not.toHaveBeenCalled();
      expect(host.firstElementChild).toBe(el);
      await waitFor(() => expect(el.style.transform || "").not.toContain("translateY(24px)"));
    } finally {
      consoleError.mockRestore();
      host.remove();
    }
  });
});
