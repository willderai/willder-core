// @vitest-environment jsdom
//
// Memory is one sidebar entry. Ask and Explore are switched inside the memory pages
// (MemorySubnav), not listed under Memory in the sidebar; the entry marks its section
// as current on either page.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";

let pathname = "/memory/explore";
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children?: unknown }) =>
    createElement("a", { href, ...props }, children as never),
}));
vi.mock("next/navigation", () => ({ usePathname: () => pathname, useRouter: () => ({ push: () => {} }) }));
vi.mock("@clerk/nextjs", () => ({ UserButton: () => null, OrganizationSwitcher: () => null }));
vi.mock("@/hooks/use-nav-badges", () => ({ useNavBadges: () => new Proxy({}, { get: () => 0 }) }));
vi.mock("@/components/marks", () => ({ WillderMark: () => null, Wordmark: () => null }));
vi.mock("@/components/theme-toggle", () => ({ ThemeToggle: () => null }));
vi.mock("@/components/help", () => ({
  HelpToggle: () => null,
  HelpTip: ({ children }: { children?: unknown }) => children as never,
}));

import { AppNav } from "./app-nav";

afterEach(cleanup);

describe("AppNav Memory entry", () => {
  it.each(["/memory/ask", "/memory/explore"])(
    "lists no Ask or Explore links under Memory, and marks Memory current on %s",
    (path) => {
      pathname = path;
      window.matchMedia = (() => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      })) as never;
      render(createElement(AppNav));
      const nav = document.querySelector("aside")!;
      expect(nav.querySelector('a[href="/memory/ask"]')).toBeNull();
      expect(nav.querySelector('a[href="/memory/explore"]')).toBeNull();
      const memory = nav.querySelector('a[href="/memory"]')!;
      expect(memory.getAttribute("aria-current")).toBe("true");
    },
  );
});
