// @vitest-environment jsdom
//
// Pins CountUp's contract: the final value reads without JavaScript and to a
// screen reader at every moment; the visible copy only drops to zero when the
// figure mounts below the fold with motion allowed, then counts to the final
// value once it scrolls into view.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { CountUp } from "./count-up";

const reducedMotion = vi.hoisted(() => ({ value: false }));
const animation = vi.hoisted(() => ({
  onUpdate: null as ((progress: number) => void) | null,
}));

vi.mock("framer-motion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("framer-motion")>();
  return {
    ...actual,
    useReducedMotion: () => reducedMotion.value,
    // Hand the test the progress callback so it can step the count by hand.
    animate: (_from: number, _to: number, options: { onUpdate: (progress: number) => void }) => {
      animation.onUpdate = options.onUpdate;
      return { stop: vi.fn() };
    },
  };
});

const leakSuite = (progress: number) => `${Math.round(25 * progress)}/25`;

// Never reports an intersection, so a figure mounted below the fold stays
// armed at zero.
class NeverInView {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

// Reports an intersection as soon as the figure is observed.
class InViewOnObserve {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe = (target: Element) =>
    this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as never);
  unobserve = vi.fn();
  disconnect = vi.fn();
}

function mountAt(top: number) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top } as DOMRect);
  const { container } = render(<CountUp format={leakSuite} />);
  const [spoken, sizer, visible] = container.querySelectorAll("span > span");
  return { spoken, sizer, visible };
}

const BELOW_THE_FOLD = 5000;
const ON_SCREEN = 0;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  reducedMotion.value = false;
  animation.onUpdate = null;
});

describe("CountUp", () => {
  it("server-renders the final value in every copy, so it reads without JavaScript", () => {
    const html = renderToString(<CountUp format={leakSuite} />);
    expect(html.match(/25\/25/g)).toHaveLength(3);
    expect(html).not.toContain("0/25");
  });

  it("drops the visible copy to zero when mounted below the fold, and never the spoken one", () => {
    vi.stubGlobal("IntersectionObserver", NeverInView);
    const { spoken, sizer, visible } = mountAt(BELOW_THE_FOLD);
    expect(visible.textContent).toBe("0/25");
    expect(spoken.textContent).toBe("25/25");
    expect(sizer.textContent).toBe("25/25");
    expect(spoken.getAttribute("aria-hidden")).toBeNull();
    expect(visible.getAttribute("aria-hidden")).toBe("true");
  });

  it("leaves a figure already on screen at its final value instead of flashing to zero", () => {
    vi.stubGlobal("IntersectionObserver", NeverInView);
    const { visible } = mountAt(ON_SCREEN);
    expect(visible.textContent).toBe("25/25");
  });

  it("never counts under prefers-reduced-motion", () => {
    vi.stubGlobal("IntersectionObserver", InViewOnObserve);
    reducedMotion.value = true;
    const { visible } = mountAt(BELOW_THE_FOLD);
    expect(visible.textContent).toBe("25/25");
    expect(animation.onUpdate).toBeNull();
  });

  it("counts up to the final value once the figure scrolls into view", () => {
    vi.stubGlobal("IntersectionObserver", InViewOnObserve);
    const { visible } = mountAt(BELOW_THE_FOLD);
    expect(animation.onUpdate).not.toBeNull();
    act(() => animation.onUpdate?.(0.4));
    expect(visible.textContent).toBe("10/25");
    act(() => animation.onUpdate?.(1));
    expect(visible.textContent).toBe("25/25");
  });
});
