// @vitest-environment jsdom
//
// The Settings tables of organization roles and entity aliases are paged, searched,
// filtered and ordered on the server (GET /api/settings/org-roles?page=, GET
// /api/settings/aliases?page=), with each view and page under its own prefix in the
// URL. These tests check what each panel asks its route for and that it shows each
// answer as served, including a refusal and a failure; the queries themselves are
// proven against a real database in app/api/settings/settings-lists.realdb.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

let urlParams = new URLSearchParams();
vi.mock("next/navigation", () => ({ useSearchParams: () => urlParams }));

import { AliasesPanel } from "./aliases-panel";
import { OrgRolesPanel } from "./org-roles-panel";

const role = (id: string, title: string, name: string | null, email: string, aliases: string[] = []) => ({
  id,
  role: title,
  aliases,
  user: { id: `u_${id}`, name, email },
});
// Served deliberately out of title order: the panel must show the route's order, not re-sort it.
const ROLES = [
  role("r2", "CTO", "Ben", "ben@acme.test"),
  role("r1", "Head of Sales", "Maya", "maya@acme.test", ["sales lead"]),
  role("r3", "Designer", null, "ana@acme.test"),
];

const alias = (id: string, entityType: string, canonicalName: string, aliases: string[]) => ({
  id,
  entityId: `e_${id}`,
  entityType,
  canonicalName,
  aliases,
  createdAt: "2026-10-01T00:00:00.000Z",
});
const ALIASES = [alias("a2", "user", "Dana Ruiz", ["DR"]), alias("a1", "account", "Acme Corp", ["ACME"])];

/** The answer of each list route, by request URL. */
let answer: (url: string) => Response;
const listRequests = (path: string) =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([, init]) => !init?.method)
    .map(([url]) => String(url))
    .filter((url) => url.startsWith(`${path}?`));

beforeEach(() => {
  urlParams = new URLSearchParams();
  window.history.replaceState(null, "", "/settings");
  answer = (url) =>
    url.startsWith("/api/settings/org-roles?")
      ? Response.json({ roles: ROLES, total: 3, count: 3, page: 1, pageSize: 25 })
      : Response.json({ aliases: ALIASES, total: 2, count: 2, page: 1, pageSize: 25 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return Response.json({ ok: true });
      if (url.startsWith("/api/settings/org-roles?") || url.startsWith("/api/settings/aliases?")) return answer(url);
      return Response.json({ members: [] });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const tableFirstCells = (region: string) =>
  within(screen.getByRole("region", { name: region }))
    .getAllByRole("row")
    .slice(1)
    .map((r) => within(r).getAllByRole("cell")[0].textContent);

describe("organization roles", () => {
  it("asks for the first page and shows it in the order served", async () => {
    render(<OrgRolesPanel />);
    await screen.findByText("CTO");
    expect(listRequests("/api/settings/org-roles")).toEqual(["/api/settings/org-roles?page=1&sort=role&order=asc"]);
    expect(tableFirstCells("Organization roles")).toEqual(["CTO", "Head of Sales", "Designer"]);
  });

  it("sends the page from the URL, then the order and the search, each starting again at page 1", async () => {
    window.history.replaceState(null, "", "/settings?roles.page=3");
    render(<OrgRolesPanel />);
    await waitFor(() =>
      expect(listRequests("/api/settings/org-roles").at(-1)).toBe("/api/settings/org-roles?page=3&sort=role&order=asc"),
    );
    await screen.findByText("CTO");

    fireEvent.click(within(screen.getByRole("columnheader", { name: /Person/ })).getByRole("button"));
    await waitFor(() =>
      expect(listRequests("/api/settings/org-roles").at(-1)).toBe(
        "/api/settings/org-roles?page=1&sort=person&order=asc",
      ),
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Search roles" }), { target: { value: "sales lead" } });
    await waitFor(() =>
      expect(listRequests("/api/settings/org-roles").at(-1)).toBe(
        "/api/settings/org-roles?page=1&sort=person&order=asc&q=sales+lead",
      ),
    );
    expect(new URLSearchParams(window.location.search).get("roles.page")).toBeNull();
  });

  it("pages with the shared pager and keeps the page in the URL", async () => {
    answer = (url) => {
      const page = Number(new URL(url, "http://t").searchParams.get("page"));
      return Response.json({ roles: page === 1 ? ROLES : [ROLES[2]], total: 26, count: 26, page, pageSize: 25 });
    };
    render(<OrgRolesPanel />);
    expect(await screen.findByText("1–25 of 26 roles")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(tableFirstCells("Organization roles")).toEqual(["Designer"]));
    expect(listRequests("/api/settings/org-roles").at(-1)).toBe("/api/settings/org-roles?page=2&sort=role&order=asc");
    expect(new URLSearchParams(window.location.search).get("roles.page")).toBe("2");
  });

  it("shows no matching count while the next search's answer is still loading", async () => {
    let answerSecond: (r: Response) => void = () => {};
    answer = (url) => {
      const q = new URL(url, "http://t").searchParams.get("q");
      return q === "ct"
        ? Response.json({ roles: [ROLES[0]], total: 1, count: 3, page: 1, pageSize: 25 })
        : Response.json({ roles: ROLES, total: 3, count: 3, page: 1, pageSize: 25 });
    };
    render(<OrgRolesPanel />);
    await screen.findByText("Head of Sales");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search roles" }), { target: { value: "ct" } });
    expect((await screen.findAllByText("1 of 3 roles")).length).toBeGreaterThan(0);

    answer = () =>
      new Promise<Response>((resolve) => {
        answerSecond = resolve;
      }) as unknown as Response;
    fireEvent.change(screen.getByRole("searchbox", { name: "Search roles" }), { target: { value: "cto" } });
    await waitFor(() => expect(listRequests("/api/settings/org-roles").at(-1)).toContain("q=cto"));
    expect(screen.queryAllByText("1 of 3 roles")).toHaveLength(0);
    answerSecond(Response.json({ roles: [ROLES[0]], total: 1, count: 3, page: 1, pageSize: 25 }));
    expect((await screen.findAllByText("1 of 3 roles")).length).toBeGreaterThan(0);
  });

  it("reads the same page again after a remove", async () => {
    render(<OrgRolesPanel />);
    await screen.findByText("CTO");
    fireEvent.click(
      within(screen.getByRole("region", { name: "Organization roles" })).getAllByRole("button", { name: "remove" })[0],
    );
    await waitFor(() => expect(listRequests("/api/settings/org-roles")).toHaveLength(2));
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/settings/org-roles/r2", { method: "DELETE" });
  });

  it("says an empty org has no roles, and never says so to a refused or failed request", async () => {
    answer = () => Response.json({ roles: [], total: 0, count: 0, page: 1, pageSize: 25 });
    render(<OrgRolesPanel />);
    expect(await screen.findByText(/^No roles mapped yet\./)).toBeTruthy();
    cleanup();

    answer = () => Response.json({ error: "admin required" }, { status: 403 });
    render(<OrgRolesPanel />);
    expect(await screen.findByText("Admin access required to view roles.")).toBeTruthy();
    expect(screen.queryByText(/No roles mapped yet/)).toBeNull();
    cleanup();

    answer = () => Response.json({ error: "boom" }, { status: 500 });
    render(<OrgRolesPanel />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/^Could not load roles\./);
    expect(screen.queryByText(/No roles mapped yet/)).toBeNull();
    answer = () => Response.json({ roles: ROLES, total: 3, count: 3, page: 1, pageSize: 25 });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("CTO")).toBeTruthy();
  });

  it("offers page 1 from a page past the last one", async () => {
    window.history.replaceState(null, "", "/settings?roles.page=9");
    answer = (url) => {
      const page = Number(new URL(url, "http://t").searchParams.get("page"));
      return Response.json({ roles: page === 1 ? ROLES : [], total: 3, count: 3, page, pageSize: 25 });
    };
    render(<OrgRolesPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Go to page 1" }));
    expect(await screen.findByText("CTO")).toBeTruthy();
  });
});

describe("entity aliases", () => {
  it("sends the type filter and the date order to the route, each starting again at page 1", async () => {
    window.history.replaceState(null, "", "/settings?aliases.page=2");
    render(<AliasesPanel />);
    await waitFor(() =>
      expect(listRequests("/api/settings/aliases").at(-1)).toBe("/api/settings/aliases?page=2&sort=name&order=asc"),
    );
    await screen.findByText("Dana Ruiz");
    expect(tableFirstCells("Entity aliases")).toEqual(["Dana Ruiz", "Acme Corp"]);

    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    fireEvent.click(
      within(
        within(screen.getByRole("group", { name: "Filter alias entries" })).getByRole("group", { name: "Type" }),
      ).getByRole("button", { name: "Account" }),
    );
    await waitFor(() =>
      expect(listRequests("/api/settings/aliases").at(-1)).toBe(
        "/api/settings/aliases?page=1&sort=name&order=asc&type=account",
      ),
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Sort by" }), { target: { value: "created" } });
    await waitFor(() =>
      expect(listRequests("/api/settings/aliases").at(-1)).toBe(
        "/api/settings/aliases?page=1&sort=created&order=desc&type=account",
      ),
    );
  });

  it("counts entries, not alias strings: each entry holds several aliases", async () => {
    answer = (url) => {
      const page = Number(new URL(url, "http://t").searchParams.get("page"));
      return Response.json({ aliases: ALIASES, total: 1060, count: 1060, page, pageSize: 25 });
    };
    render(<AliasesPanel />);
    expect(await screen.findByText("1–25 of 1,060 alias entries")).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Search alias entries" })).toBeTruthy();
  });

  it("says nothing matches a search, with the count the server gave", async () => {
    answer = () => Response.json({ aliases: [], total: 0, count: 2, page: 1, pageSize: 25 });
    window.history.replaceState(null, "", "/settings?aliases.q=nobody");
    urlParams = new URLSearchParams("aliases.q=nobody");
    render(<AliasesPanel />);
    expect(await screen.findByText("No alias entries match “nobody”.")).toBeTruthy();
    expect(listRequests("/api/settings/aliases").at(-1)).toBe(
      "/api/settings/aliases?page=1&sort=name&order=asc&q=nobody",
    );
  });
});
