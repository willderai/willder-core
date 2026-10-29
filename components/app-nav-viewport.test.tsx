// @vitest-environment jsdom
//
// Pins how the app sidebar sizes itself by viewport. At 390px the full 240px
// sidebar left Settings panels about 150px, so below the `md` breakpoint it starts
// as its 72px icon rail; wider viewports keep the full sidebar, and an explicit
// Expand/Collapse click overrides the viewport default in either direction.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children?: unknown; title?: string; onClick?: () => void }) =>
    createElement("a", { href, ...props }, children as never),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/settings", useRouter: () => ({ push: () => {} }) }));
vi.mock("@clerk/nextjs", () => ({ UserButton: () => null, OrganizationSwitcher: () => null }));
vi.mock("@/hooks/use-nav-badges", () => ({
  useNavBadges: () => new Proxy({}, { get: () => 0 }),
}));
vi.mock("@/components/marks", () => ({ WillderMark: () => null, Wordmark: () => null }));
vi.mock("@/components/theme-toggle", () => ({ ThemeToggle: () => null }));
vi.mock("@/components/help", () => ({
  HelpToggle: () => null,
  HelpTip: ({ children }: { children?: unknown }) => children as never,
}));

import { AppNav } from "./app-nav";

type Listener = () => void;

// A controllable matchMedia: `setWidth` flips the query result and notifies
// subscribers the way a real resize across the breakpoint does.
function installViewport(initialWidth: number) {
  let width = initialWidth;
  const listeners = new Set<Listener>();
  window.matchMedia = ((query: string) => {
    const maxWidth = Number(/max-width:\s*(\d+)px/.exec(query)?.[1]);
    return {
      get matches() {
        return width <= maxWidth;
      },
      media: query,
      addEventListener: (_: string, listener: Listener) => listeners.add(listener),
      removeEventListener: (_: string, listener: Listener) => listeners.delete(listener),
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
  return {
    setWidth(next: number) {
      width = next;
      act(() => listeners.forEach((listener) => listener()));
    },
  };
}

const sidebar = () => document.querySelector("aside")!;

afterEach(cleanup);

describe("AppNav viewport sizing", () => {
  it("starts as the icon rail on a 390px phone", () => {
    installViewport(390);
    render(createElement(AppNav));
    expect(sidebar().className).toContain("w-[4.5rem]");
    expect(sidebar().className).not.toContain("w-60");
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeTruthy();
  });

  it("keeps the full sidebar on tablet and desktop widths", () => {
    for (const width of [768, 1280]) {
      installViewport(width);
      render(createElement(AppNav));
      expect(sidebar().className).toContain("w-60");
      expect(screen.getByText("Settings")).toBeTruthy();
      cleanup();
    }
  });

  // Three stacked labelled rows pushed the Account group below the fold at 1440x900
  // (measured in Chromium: its last link ended 114px below the nav's visible bottom).
  // Expanded, the controls share one row of named icon buttons instead.
  it("puts the expanded sidebar's footer controls in one row of named icon buttons", () => {
    installViewport(1440);
    render(createElement(AppNav));
    const controls = document.querySelector("[data-nav-controls]")!;
    expect(controls.className).toContain("flex-row");
    const collapse = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(controls.contains(collapse)).toBe(true);
    expect(collapse.textContent).toBe("");
    expect(collapse.getAttribute("title")).toBe("Collapse");
  });

  it("follows the viewport across the breakpoint until the user toggles", () => {
    const viewport = installViewport(1280);
    render(createElement(AppNav));
    expect(sidebar().className).toContain("w-60");

    viewport.setWidth(390);
    expect(sidebar().className).toContain("w-[4.5rem]");

    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(sidebar().className).toContain("w-60");

    // The user's explicit choice outlasts a later resize.
    viewport.setWidth(360);
    expect(sidebar().className).toContain("w-60");
  });

  it("closes the phone drawer from its backdrop and Escape key", () => {
    installViewport(390);
    render(createElement(AppNav));
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    fireEvent.click(screen.getByRole("button", { name: "Close navigation" }));
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close navigation" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBe(document.activeElement);
    expect(screen.queryByRole("button", { name: "Close navigation" })).toBeNull();
  });

  it("closes the phone drawer after choosing a destination", () => {
    installViewport(390);
    render(createElement(AppNav));
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    fireEvent.click(screen.getByRole("link", { name: "Memory" }));
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close navigation" })).toBeNull();
  });
});
