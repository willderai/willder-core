// @vitest-environment jsdom
//
// Pins StrikeThrough's contract: the strike reads as drawn without
// JavaScript; it only drops to zero width when the text mounts below the fold
// with motion allowed, then draws once the text scrolls into view. The words
// themselves are never hidden or dimmed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { StrikeThrough } from "./strike-through";

const reducedMotion = vi.hoisted(() => ({ value: false }));
const animation = vi.hoisted(() => ({
  onUpdate: null as ((progress: number) => void) | null,
  delay: null as number | null,
}));

vi.mock("framer-motion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("framer-motion")>();
  return {
    ...actual,
    useReducedMotion: () => reducedMotion.value,
    // Hand the test the progress callback so it can step the draw by hand.
    animate: (_from: number, _to: number, options: { delay: number; onUpdate: (progress: number) => void }) => {
      animation.onUpdate = options.onUpdate;
      animation.delay = options.delay;
      return { stop: vi.fn() };
    },
  };
});

// Never reports an intersection, so text mounted below the fold stays armed.
class NeverInView {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

// Reports an intersection as soon as the text is observed.
class InViewOnObserve {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe = (target: Element) =>
    this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as never);
  unobserve = vi.fn();
  disconnect = vi.fn();
}

const OLD_WAY = "Manual sharing, trust based";
const BELOW_THE_FOLD = 5000;
const ON_SCREEN = 0;

function mountAt(top: number, delay?: number) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top } as DOMRect);
  const view = render(<StrikeThrough delay={delay}>{OLD_WAY}</StrikeThrough>);
  const strike = view.container.querySelector<HTMLElement>("[data-strike]")!;
  return { ...view, strike };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  reducedMotion.value = false;
  animation.onUpdate = null;
  animation.delay = null;
});

describe("StrikeThrough", () => {
  it("server-renders the strike fully drawn, so it reads without JavaScript", () => {
    const html = renderToString(<StrikeThrough>{OLD_WAY}</StrikeThrough>);
    expect(html).toContain(OLD_WAY);
    expect(html).toContain("bg-[length:100%_1px]");
    expect(html).not.toContain("style=");
  });

  it("drops the strike to zero width when mounted below the fold, leaving the words alone", () => {
    vi.stubGlobal("IntersectionObserver", NeverInView);
    const { strike } = mountAt(BELOW_THE_FOLD);
    expect(strike.style.backgroundSize).toBe("0% 1px");
    expect(strike.textContent).toBe(OLD_WAY);
    expect(strike.style.opacity).toBe("");
    expect(strike.style.transform).toBe("");
  });

  it("leaves text already on screen struck instead of undrawing it", () => {
    vi.stubGlobal("IntersectionObserver", InViewOnObserve);
    const { strike } = mountAt(ON_SCREEN);
    expect(strike.style.backgroundSize).toBe("");
    expect(animation.onUpdate).toBeNull();
  });

  it("never draws under prefers-reduced-motion", () => {
    vi.stubGlobal("IntersectionObserver", InViewOnObserve);
    reducedMotion.value = true;
    const { strike } = mountAt(BELOW_THE_FOLD);
    expect(strike.style.backgroundSize).toBe("");
    expect(animation.onUpdate).toBeNull();
  });

  it("draws the strike across once the text scrolls into view, after its delay", () => {
    vi.stubGlobal("IntersectionObserver", InViewOnObserve);
    const { strike } = mountAt(BELOW_THE_FOLD, 0.24);
    expect(animation.delay).toBe(0.24);
    act(() => animation.onUpdate?.(0.5));
    expect(strike.style.backgroundSize).toBe("50% 1px");
    act(() => animation.onUpdate?.(1));
    expect(strike.style.backgroundSize).toBe("100% 1px");
  });

  it("restores the drawn strike if the draw is interrupted", () => {
    vi.stubGlobal("IntersectionObserver", InViewOnObserve);
    const { strike, unmount } = mountAt(BELOW_THE_FOLD);
    act(() => animation.onUpdate?.(0.3));
    unmount();
    expect(strike.style.backgroundSize).toBe("");
  });
});
