// @vitest-environment jsdom
//
// Paging a list in the browser: the arithmetic on its own, then a list driven through
// the shared toolbar and pager. The edges: no rows, one row, exactly one page, the last
// page, a search or filter that leaves fewer pages than the one showing, rows removed
// from under the last page, and a page held in, and read back from, the URL.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";

let urlParams = new URLSearchParams();
vi.mock("next/navigation", () => ({ useSearchParams: () => urlParams }));

import { ListControls, ListPagination } from "./list-controls";
import { clampPage, listViewKey, pageCount, pageRows, parsePage, writePage, PAGE_SIZE } from "./list-page";
import { applyListState, compareText, type ListConfig } from "./list-query";
import { useListPage } from "./use-list-page";
import { useListState } from "./use-list-state";

describe("page arithmetic", () => {
  it.each([
    [0, 1],
    [1, 1],
    [PAGE_SIZE, 1],
    [PAGE_SIZE + 1, 2],
    [PAGE_SIZE * 3, 3],
  ])("fits %i rows on %i pages", (total, pages) => {
    expect(pageCount(total)).toBe(pages);
  });

  it("clamps a page into the pages there are", () => {
    expect(clampPage(0, 3)).toBe(1);
    expect(clampPage(-2, 3)).toBe(1);
    expect(clampPage(2, 3)).toBe(2);
    expect(clampPage(9, 3)).toBe(3);
    expect(clampPage(4, 0)).toBe(1);
  });

  it("slices a page, the last one short", () => {
    const rows = Array.from({ length: 23 }, (_, i) => i);
    expect(pageRows(rows, 1)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(pageRows(rows, 3)).toEqual([20, 21, 22]);
    expect(pageRows([], 1)).toEqual([]);
  });

  it.each([
    ["x.page=3", 3],
    ["", 1],
    ["x.page=0", 1],
    ["x.page=-1", 1],
    ["x.page=2.5", 1],
    ["x.page=abc", 1],
    ["x.page=02", 1],
    ["x.page=99999999", 1],
    ["page=4", 1],
  ])("reads %j as page %i", (query, page) => {
    expect(parsePage(new URLSearchParams(query), "x.")).toBe(page);
  });

  it("writes page 1 out of the URL and leaves other parameters alone", () => {
    const params = new URLSearchParams("keep=1&x.page=4");
    expect(writePage(params, "x.", 2).toString()).toBe("keep=1&x.page=2");
    expect(writePage(params, "x.", 1).toString()).toBe("keep=1");
  });
});

type Row = { id: string; name: string; status: "on" | "off" };

const CONFIG: ListConfig<Row> = {
  noun: { one: "document", many: "documents" },
  searchText: (r) => [r.name],
  sorts: [{ key: "name", label: "Name", compare: (a, b) => compareText(a.name, b.name) }],
  filters: [
    {
      key: "status",
      label: "Status",
      options: [
        { value: "on", label: "On" },
        { value: "off", label: "Off" },
      ],
      matches: (r, v) => r.status === v,
    },
  ],
  paramPrefix: "docs.",
};

/** `n` rows named "Doc 01".., every third one "off". */
function rows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `r${i + 1}`,
    name: `Doc ${String(i + 1).padStart(2, "0")}`,
    status: i % 3 === 2 ? "off" : "on",
  }));
}

function List({ items }: { items: Row[] }) {
  const view = useListState(CONFIG);
  const shown = applyListState(items, CONFIG, view.state);
  const paging = useListPage(shown, { prefix: "docs.", viewKey: listViewKey(CONFIG, view.state) });
  return createElement(
    "div",
    null,
    createElement(ListControls<Row>, { config: CONFIG, controls: view, total: items.length, shown: shown.length }),
    createElement(
      "ul",
      { "aria-label": "Documents" },
      paging.rows.map((r) => createElement("li", { key: r.id }, r.name)),
    ),
    createElement(ListPagination<Row>, { noun: CONFIG.noun, paging }),
  );
}

const listed = () =>
  within(screen.getByRole("list", { name: "Documents" }))
    .queryAllByRole("listitem")
    .map((li) => li.textContent);
const pager = () => screen.queryByRole("navigation", { name: "Pages of documents" });
const next = () => act(() => fireEvent.click(screen.getByRole("button", { name: "Next page" })));
const previous = () => act(() => fireEvent.click(screen.getByRole("button", { name: "Previous page" })));

function openAt(query: string) {
  window.history.replaceState(null, "", `/integrations${query}#sources`);
  urlParams = new URLSearchParams(window.location.search);
}

beforeEach(() => {
  vi.useFakeTimers();
  openAt("");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a paged list", () => {
  it.each([0, 1, PAGE_SIZE])("shows no pager over %i rows", (n) => {
    render(createElement(List, { items: rows(n) }));
    expect(listed()).toHaveLength(n);
    expect(pager()).toBeNull();
  });

  it("steps through the pages to a short last page and keeps the page in the URL", () => {
    render(createElement(List, { items: rows(23) }));
    expect(listed()).toHaveLength(10);
    expect(within(pager()!).getByText("1–10 of 23 documents")).toBeTruthy();
    expect(within(pager()!).getByText("Page 1 of 3")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Previous page" }).getAttribute("aria-disabled")).toBe("true");

    next();
    next();
    expect(listed()).toEqual(["Doc 21", "Doc 22", "Doc 23"]);
    expect(within(pager()!).getByText("21–23 of 23 documents")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next page" }).getAttribute("aria-disabled")).toBe("true");
    expect(window.location.search).toBe("?docs.page=3");
    // The tab's anchor stays.
    expect(window.location.hash).toBe("#sources");

    previous();
    expect(listed()?.[0]).toBe("Doc 11");
    expect(window.location.search).toBe("?docs.page=2");
  });

  it("opens the page a link names, and the last page for a link past the end", () => {
    openAt("?docs.page=2");
    render(createElement(List, { items: rows(23) }));
    expect(listed()?.[0]).toBe("Doc 11");
    cleanup();
    openAt("?docs.page=9");
    render(createElement(List, { items: rows(23) }));
    expect(listed()).toEqual(["Doc 21", "Doc 22", "Doc 23"]);
  });

  it("goes back to page 1 when a filter leaves fewer pages than the one showing", () => {
    render(createElement(List, { items: rows(23) }));
    next();
    next();
    act(() => fireEvent.click(screen.getByRole("button", { name: "Filters" })));
    act(() => fireEvent.click(screen.getByRole("button", { name: "On" })));
    // Sixteen "on" rows: two pages, from the top, not the last page clamped to.
    expect(listed()?.[0]).toBe("Doc 01");
    expect(within(pager()!).getByText("Page 1 of 2")).toBeTruthy();
    act(() => vi.runAllTimers());
    expect(window.location.search).toBe("?docs.status=on");
  });

  it("goes back to page 1 on a new search, as the first keystroke lands", () => {
    render(createElement(List, { items: rows(23) }));
    next();
    act(() =>
      fireEvent.change(screen.getByRole("searchbox", { name: "Search documents" }), { target: { value: "Doc" } }),
    );
    expect(listed()?.[0]).toBe("Doc 01");
    expect(within(pager()!).getByText("Page 1 of 3")).toBeTruthy();
  });

  it("stays on page 1 when a search is cleared, not the page showing before it", () => {
    render(createElement(List, { items: rows(23) }));
    next();
    next();
    const search = screen.getByRole("searchbox", { name: "Search documents" });
    act(() => fireEvent.change(search, { target: { value: "Doc" } }));
    act(() => fireEvent.change(search, { target: { value: "" } }));
    act(() => vi.runAllTimers());
    expect(listed()?.[0]).toBe("Doc 01");
    expect(within(pager()!).getByText("Page 1 of 3")).toBeTruthy();
    expect(window.location.search).toBe("");
  });

  it("shows the new last page when rows are removed from under the page showing", () => {
    const { rerender } = render(createElement(List, { items: rows(23) }));
    next();
    next();
    rerender(createElement(List, { items: rows(19) }));
    expect(listed()?.[0]).toBe("Doc 11");
    expect(within(pager()!).getByText("Page 2 of 2")).toBeTruthy();
  });
});
