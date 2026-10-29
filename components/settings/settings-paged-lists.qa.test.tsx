// @vitest-environment jsdom
//
// The Settings role and alias tables' failure states: a refusal or
// failure that answers a later page replaces the rows already on screen instead of
// leaving them behind as if they answered it, a request that never reaches the server
// says it could not load, and the alias table says the same things the role table does.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

let urlParams = new URLSearchParams();
vi.mock("next/navigation", () => ({ useSearchParams: () => urlParams }));

import { AliasesPanel } from "./aliases-panel";
import { OrgRolesPanel } from "./org-roles-panel";

const role = (n: number) => ({
  id: `r${n}`,
  role: `Role ${n}`,
  aliases: [],
  user: { id: `u${n}`, name: `Person ${n}`, email: `p${n}@acme.test` },
});
const PAGE_ONE = Array.from({ length: 25 }, (_, i) => role(i + 1));

let answer: (url: string) => Promise<Response> | Response;

beforeEach(() => {
  urlParams = new URLSearchParams();
  window.history.replaceState(null, "", "/settings");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.startsWith("/api/settings/org-roles?") || url.startsWith("/api/settings/aliases?")) return answer(url);
      return Response.json({ members: [] });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const pageOf = (url: string) => Number(new URL(url, "http://t").searchParams.get("page"));

describe("QA: Settings tables never pass old rows off as a refused or failed page", () => {
  for (const [label, refuse, says] of [
    [
      "a refusal",
      () => Response.json({ error: "admin required" }, { status: 403 }),
      /^Admin access required to view roles\.$/,
    ],
    ["a server error", () => Response.json({ error: "boom" }, { status: 502 }), /^Could not load roles\./],
    ["a sign-out", () => Response.json({ error: "unauthorized" }, { status: 401 }), /^Could not load roles\./],
    ["a network failure", () => Promise.reject(new TypeError("Failed to fetch")), /^Could not load roles\./],
  ] as const) {
    it(`replaces page 1's rows when page 2 answers with ${label}`, async () => {
      answer = (url) =>
        pageOf(url) === 1 ? Response.json({ roles: PAGE_ONE, total: 30, count: 30, page: 1, pageSize: 25 }) : refuse();
      render(<OrgRolesPanel />);
      await screen.findByText("Role 1");
      fireEvent.click(screen.getByRole("button", { name: /next/i }));
      await waitFor(() => expect(screen.getByText(says)).toBeTruthy());
      expect(screen.queryByText("Role 1")).toBeNull();
      expect(screen.queryByText(/No roles mapped yet/)).toBeNull();
      expect(window.location.search).toContain("roles.page=2");
    });
  }

  it("says the alias table was refused or failed, never that the org has no aliases", async () => {
    answer = () => Response.json({ error: "admin required" }, { status: 403 });
    render(<AliasesPanel />);
    expect(await screen.findByText("Admin access required to view alias entries.")).toBeTruthy();
    expect(screen.queryByText(/No aliases yet/)).toBeNull();
    cleanup();

    answer = () => Response.json({ error: "boom" }, { status: 500 });
    render(<AliasesPanel />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/^Could not load alias entries\./);
    expect(screen.queryByText(/No aliases yet/)).toBeNull();
  });
});
