// @vitest-environment jsdom
//
// What a server-paged Settings table (here the entity aliases) shows while the page it
// asked for is still on its way: no empty or no-match message left over from the answer
// before, and a pager that stays in place, inert, so keyboard focus stays on Next.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

let urlParams = new URLSearchParams();
vi.mock("next/navigation", () => ({ useSearchParams: () => urlParams }));

import { AliasesPanel } from "./aliases-panel";

const PAGE_SIZE = 25;
const alias = (i: number) => ({
  id: `a${i}`,
  entityId: `e${i}`,
  entityType: "org",
  canonicalName: `Org ${String(i).padStart(2, "0")}`,
  aliases: [],
  createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(),
});

/** The aliases route over `rows`: a page of them, searched by canonical name. */
function aliasesPage(url: string, rows: ReturnType<typeof alias>[]) {
  const params = new URL(url, "http://localhost").searchParams;
  const page = Number(params.get("page") ?? "1");
  const q = (params.get("q") ?? "").toLowerCase();
  const kept = rows.filter((r) => r.canonicalName.toLowerCase().includes(q));
  return {
    aliases: kept.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    total: kept.length,
    count: rows.length,
    page,
    pageSize: PAGE_SIZE,
  };
}

/** Holds list reads that `hold(url)` picks until `release()`; answers the rest at once. */
function serveAliases(rows: () => ReturnType<typeof alias>[], hold: (url: string) => boolean) {
  const held: Array<() => void> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return Response.json({ ok: true });
      if (!url.startsWith("/api/settings/aliases?")) return Response.json({ members: [] });
      if (hold(url)) await new Promise<void>((r) => held.push(r));
      return Response.json(aliasesPage(url, rows()));
    }),
  );
  return {
    release: () =>
      act(async () => {
        held.splice(0).forEach((r) => r());
      }),
    reads: () =>
      vi.mocked(fetch).mock.calls.filter(([u, i]) => !i?.method && String(u).startsWith("/api/settings/aliases?"))
        .length,
    heldCount: () => held.length,
  };
}

beforeEach(() => {
  urlParams = new URLSearchParams();
  window.history.replaceState(null, "", "/settings");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Settings aliases while a page is on its way", () => {
  it("does not keep saying there are no aliases while the reload after the first one is in flight", async () => {
    let rows: ReturnType<typeof alias>[] = [];
    let created = false;
    const api = serveAliases(
      () => rows,
      () => created,
    );
    render(<AliasesPanel />);
    expect(await screen.findByText(/No aliases yet/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "+ Add alias" }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "org" } });
    fireEvent.change(screen.getByPlaceholderText("Entity ID"), { target: { value: "e1" } });
    fireEvent.change(screen.getByPlaceholderText("e.g. Sarah Nguyen"), { target: { value: "Org 01" } });
    rows = [alias(1)];
    created = true;
    fireEvent.click(screen.getByRole("button", { name: "Save alias" }));

    await waitFor(() => expect(api.heldCount()).toBe(1));
    expect(screen.queryByText(/No aliases yet/)).toBeNull();
    expect(screen.getByText("Loading…")).toBeTruthy();

    await api.release();
    expect(await screen.findByText("Org 01")).toBeTruthy();
    expect(screen.queryByText(/No aliases yet/)).toBeNull();
  });

  it("does not show the last search's no-match message while the next search is on its way", async () => {
    const rows = [alias(1), alias(2)];
    const api = serveAliases(
      () => rows,
      (url) => new URL(url, "http://localhost").searchParams.get("q") === "zzzz",
    );
    render(<AliasesPanel />);
    await screen.findByText("Org 01");

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzz" } });
    expect(await screen.findByText(/No alias entries match/)).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzzz" } });
    await waitFor(() => expect(api.heldCount()).toBe(1));
    expect(screen.queryByText(/No alias entries match/)).toBeNull();
    expect(screen.getByText("Loading…")).toBeTruthy();

    await api.release();
    expect(await screen.findByText(/No alias entries match .zzzz./)).toBeTruthy();
  });

  it("keeps the pager, and focus on Next, through each page turn, with no count from the page before", async () => {
    const rows = Array.from({ length: 60 }, (_, i) => alias(i + 1));
    const api = serveAliases(
      () => rows,
      (url) => new URL(url, "http://localhost").searchParams.get("page") !== "1",
    );
    render(<AliasesPanel />);
    await screen.findByText("Org 01");
    expect(screen.getByText(/1–25 of 60 alias entries/)).toBeTruthy();
    const pager = () => screen.getByRole("navigation", { name: "Pages of alias entries" });
    const next = screen.getByRole("button", { name: "Next page" });
    const previous = screen.getByRole("button", { name: "Previous page" });
    next.focus();

    fireEvent.click(next);
    await waitFor(() => expect(api.heldCount()).toBe(1));
    expect(pager().getAttribute("aria-busy")).toBe("true");
    expect(pager().textContent).toContain("Loading page 2…");
    expect(pager().textContent).not.toMatch(/ of /);
    expect(document.activeElement).toBe(next);
    // Page 2 of 3 is not the last page: Next and Previous are inert only because it loads.
    expect(next.getAttribute("aria-disabled")).toBe("true");
    expect(previous.getAttribute("aria-disabled")).toBe("true");
    const readsWhileLoading = api.reads();
    fireEvent.click(next);
    fireEvent.click(previous);
    expect(api.reads()).toBe(readsWhileLoading);

    await api.release();
    expect(await screen.findByText("Org 26")).toBeTruthy();
    expect(pager().getAttribute("aria-busy")).toBe("false");
    expect(screen.getByText(/26–50 of 60 alias entries/)).toBeTruthy();
    expect(document.activeElement).toBe(next);
    expect(next.getAttribute("aria-disabled")).toBe("false");

    fireEvent.click(next);
    await waitFor(() => expect(api.heldCount()).toBe(1));
    await api.release();
    expect(await screen.findByText("Org 51")).toBeTruthy();
    expect(screen.getByText(/51–60 of 60 alias entries/)).toBeTruthy();
    // On the last page Next is dimmed but still holds focus, rather than being disabled.
    expect(document.activeElement).toBe(next);
    expect(next.getAttribute("aria-disabled")).toBe("true");
    const readsOnLast = api.reads();
    fireEvent.click(next);
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(api.reads()).toBe(readsOnLast);
    expect(window.location.search).toContain("aliases.page=3");
  });
});
