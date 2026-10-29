// @vitest-environment jsdom
//
// The access log searches and orders on the server: it is paged, and only GET
// /api/audit can leave out the rows the log hides before it counts. These tests
// check what the log asks the route for and how it shows each answer; the route's
// own rule is proven against a real database in app/api/audit/search.realdb.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

let urlParams = new URLSearchParams();
vi.mock("next/navigation", () => ({ useSearchParams: () => urlParams }));

import { AuditLog } from "./audit-log";

/** What the toolbar's polite live region says: the count a screen reader hears. */
const liveCount = () =>
  [...document.querySelectorAll("[aria-live='polite']")]
    .map((n) => n.textContent ?? "")
    .find((t) => t.includes("matching")) ?? "";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function entry(id: string) {
  return {
    id,
    actorType: "human",
    actorName: "Ada",
    action: "memory.read",
    target: `org_1.sales/${id}`,
    decision: "allow",
    reason: null,
    changeIds: [],
    at: "2026-10-01T00:00:00.000Z",
  };
}

function page(entries: ReturnType<typeof entry>[], total = entries.length) {
  return {
    entries,
    total,
    counts: { allowed: total, denied: 0 },
    page: 1,
    pageSize: 50,
    totalPages: Math.ceil(total / 50),
  };
}

let answer: (url: URL) => Response;
const auditRequests = () =>
  vi
    .mocked(fetch)
    .mock.calls.map(([url]) => new URL(String(url), "https://w.test"))
    .filter((url) => url.pathname === "/api/audit");

beforeEach(() => {
  urlParams = new URLSearchParams();
  window.history.replaceState(null, "", "/audit");
  answer = () => json(page([entry("latest")], 3));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/audit/actors") return json({ actors: [] });
      return answer(new URL(url, "https://w.test"));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("access log search and order", () => {
  it("sends the search to the server after a pause and says how many records matched", async () => {
    answer = (url) =>
      url.searchParams.get("q") === "acme" ? json(page([entry("acme")], 12)) : json(page([entry("latest")], 3));
    render(<AuditLog scope={null} />);
    await screen.findByRole("button", { name: "Inspect event latest" });

    fireEvent.change(screen.getByRole("searchbox", { name: "Search records" }), { target: { value: " acme " } });
    await screen.findByRole("button", { name: "Inspect event acme" });
    expect(auditRequests().at(-1)?.searchParams.get("q")).toBe("acme");
    expect(auditRequests().at(-1)?.searchParams.get("page")).toBe("1");
    await waitFor(() => expect(liveCount()).toBe("12 matching records"));
    expect(window.location.search).toBe("?q=acme");
  });

  it("opens a shared link in the view it names", async () => {
    urlParams = new URLSearchParams("q=globex&dir=asc");
    render(<AuditLog scope="org_1.sales" />);
    await screen.findByRole("button", { name: "Inspect event latest" });
    const sent = auditRequests()[0];
    expect(sent?.searchParams.get("q")).toBe("globex");
    expect(sent?.searchParams.get("order")).toBe("asc");
    expect(sent?.searchParams.get("scope")).toBe("org_1.sales");
    expect(screen.getByText(/Records 1–1 of 3 · Oldest first/)).toBeTruthy();
  });

  it("orders oldest first on request and starts again at page 1", async () => {
    answer = (url) =>
      json({
        ...page([entry(`p${url.searchParams.get("page")}`)], 120),
        page: Number(url.searchParams.get("page")),
        totalPages: 3,
      });
    render(<AuditLog scope={null} />);
    fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
    await screen.findByRole("button", { name: "Inspect event p2" });

    fireEvent.click(screen.getByRole("button", { name: /^Order: Newest first/ }));
    await screen.findByRole("button", { name: "Inspect event p1" });
    expect(auditRequests().at(-1)?.searchParams.get("order")).toBe("asc");
    expect(auditRequests().at(-1)?.searchParams.get("page")).toBe("1");
  });

  it("offers the way back when a search matches nothing", async () => {
    answer = (url) => (url.searchParams.get("q") ? json(page([])) : json(page([entry("latest")])));
    urlParams = new URLSearchParams("q=nothing");
    render(<AuditLog scope={null} />);

    expect(await screen.findByText(/No records match/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear search and filters" }));
    await screen.findByRole("button", { name: "Inspect event latest" });
    expect(auditRequests().at(-1)?.searchParams.has("q")).toBe(false);
  });

  it("says the log could not load, never that nothing matched, when a search fails", async () => {
    answer = () => json({ error: "boom" }, 500);
    urlParams = new URLSearchParams("q=acme");
    render(<AuditLog scope={null} />);

    expect(await screen.findByText("Couldn’t load the audit log")).toBeTruthy();
    expect(screen.queryByText(/No records match/)).toBeNull();
    expect(liveCount()).toBe("");
  });
});
