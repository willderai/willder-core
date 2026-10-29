import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Structure tests for the app sidebar (components/app-nav.tsx). The nav-item data
// (NAV_GROUPS) is not exported, so we render AppNav via react-dom/server (node env, no
// JSX in the test file) with its heavy providers mocked to inert stubs. There is ONE
// nav, with no Product/Outbound view-toggle, and it no longer offers surfaces
// that have been cut from the product — the nav is the first place a removed
// surface leaks back in, so the absent links are pinned, not just the present
// ones.

// next/link → a plain anchor carrying href so we can assert link targets.
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children?: unknown }) =>
    createElement("a", { href }, children as never),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard", useRouter: () => ({ push: () => {} }) }));
vi.mock("@clerk/nextjs", () => ({
  UserButton: () => null,
  OrganizationSwitcher: () => null,
}));
vi.mock("@/hooks/use-nav-badges", () => ({
  useNavBadges: () => new Proxy({}, { get: () => 0 }),
}));
vi.mock("@/components/marks", () => ({
  WillderMark: () => null,
  Wordmark: () => null,
}));
vi.mock("@/components/theme-toggle", () => ({ ThemeToggle: () => null }));
vi.mock("@/components/help", () => ({
  HelpToggle: () => null,
  // HelpTip wraps each nav Link — render its children through so the <a> survives.
  HelpTip: ({ children }: { children?: unknown }) => children as never,
}));
// lucide-react icons stubbed to inert elements. This deliberately keeps the icons the
// cut nav entries used (Inbox, Megaphone, Users) alongside the ones in use: the tests
// below assert those entries are gone, and a mock that stopped exporting their icons
// would make re-adding one fail at import time rather than on its assertion.
vi.mock("lucide-react", () => {
  const Icon = () => null;
  return {
    LayoutDashboard: Icon,
    Brain: Icon,
    Bot: Icon,
    Lock: Icon,
    ScrollText: Icon,
    Settings: Icon,
    BookOpen: Icon,
    Plug: Icon,
    Search: Icon,
    X: Icon,
    Inbox: Icon,
    Megaphone: Icon,
    Users: Icon,
  };
});

import { AppNav } from "./app-nav";

const render = () => renderToStaticMarkup(createElement(AppNav));

describe("AppNav — single unified nav (no view toggle)", () => {
  it.each(["/campaigns", "/contacts", "/inbox", "/activity"])("does not link to the cut surface %s", (href) => {
    expect(render()).not.toContain(`href="${href}"`);
  });

  it("drops the cut surfaces' labels too, not just their links", () => {
    const html = render();
    expect(html).not.toContain("Campaigns");
    expect(html).not.toContain("Contacts");
    expect(html).not.toContain("Inbox");
  });

  it("keeps the surviving surfaces", () => {
    const html = render();
    for (const href of [
      "/dashboard",
      "/memory",
      "/agents",
      "/access",
      "/audit",
      "/integrations",
      "/settings",
      "/how-to-use",
    ]) {
      expect(html).toContain(`href="${href}"`);
    }
  });
});
