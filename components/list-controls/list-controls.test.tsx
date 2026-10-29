// The shared list toolbar driven through its hook: search, filter and order
// change what is listed, the view lands in the URL after the search pause, a
// URL from elsewhere replaces the view, and every control is reachable and
// named for a keyboard and screen reader user.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";

let urlParams = new URLSearchParams();
vi.mock("next/navigation", () => ({ useSearchParams: () => urlParams }));

import { ListControls, ListNoMatch, SortHeader } from "./list-controls";
import { applyListState, compareText, compareTime, type ListConfig } from "./list-query";
import { SEARCH_DEBOUNCE_MS, useListState } from "./use-list-state";

/** What the toolbar's polite live region says: the count a screen reader hears. */
const liveCount = () => document.querySelector("[aria-live='polite']")?.textContent ?? "";

type Row = { id: string; name: string; status: "on" | "off"; at: string };

const ROWS: Row[] = [
  { id: "r1", name: "Pipeline notes", status: "on", at: "2026-10-01T00:00:00Z" },
  { id: "r2", name: "Board deck", status: "off", at: "2026-10-03T00:00:00Z" },
  { id: "r3", name: "Pricing sheet", status: "on", at: "2026-10-02T00:00:00Z" },
];

const CONFIG: ListConfig<Row> = {
  noun: { one: "document", many: "documents" },
  searchText: (r) => [r.name],
  sorts: [
    {
      key: "created",
      label: "Created",
      compare: (a, b) => compareTime(a.at, b.at),
      defaultDirection: "desc",
      directionLabels: { asc: "Oldest first", desc: "Newest first" },
    },
    {
      key: "name",
      label: "Name",
      compare: (a, b) => compareText(a.name, b.name),
      directionLabels: { asc: "A–Z", desc: "Z–A" },
    },
  ],
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

function Harness({ inUrl = true }: { inUrl?: boolean }) {
  const controls = useListState(CONFIG, { inUrl });
  const shown = applyListState(ROWS, CONFIG, controls.state);
  return createElement(
    "div",
    null,
    createElement(ListControls<Row>, { config: CONFIG, controls, total: ROWS.length, shown: shown.length }),
    createElement(
      "table",
      null,
      createElement(
        "thead",
        null,
        createElement("tr", null, createElement(SortHeader<Row>, { config: CONFIG, controls, sortKey: "name" })),
      ),
    ),
    shown.length === 0
      ? createElement(ListNoMatch<Row>, { config: CONFIG, controls })
      : createElement(
          "ul",
          { "aria-label": "Documents" },
          ...shown.map((r) => createElement("li", { key: r.id }, r.name)),
        ),
  );
}

const listed = () =>
  within(screen.getByRole("list", { name: "Documents" }))
    .getAllByRole("listitem")
    .map((li) => li.textContent);

beforeEach(() => {
  vi.useFakeTimers();
  window.history.replaceState(null, "", "/settings?tab=keep");
  urlParams = new URLSearchParams(window.location.search);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ListControls", () => {
  it("lists in the default order and shows no count until something narrows the list", () => {
    render(createElement(Harness));
    expect(listed()).toEqual(["Board deck", "Pricing sheet", "Pipeline notes"]);
    expect(screen.getByRole("button", { name: "Order: Newest first. Switch to oldest first" })).toBeTruthy();
    expect(liveCount()).toBe("");
  });

  it("filters on every keystroke and writes the search to the URL only after the pause", () => {
    render(createElement(Harness));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search documents" }), { target: { value: "p" } });
    expect(listed()).toEqual(["Pricing sheet", "Pipeline notes"]);
    expect(liveCount()).toBe("2 of 3 documents");
    expect(window.location.search).toBe("?tab=keep");

    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(new URLSearchParams(window.location.search).get("docs.q")).toBe("p");
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("keep");
  });

  it("with inUrl off, filters and commits the search but never writes it to the URL", () => {
    render(createElement(Harness, { inUrl: false }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search documents" }), { target: { value: "p" } });
    expect(listed()).toEqual(["Pricing sheet", "Pipeline notes"]);
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(window.location.search).toBe("?tab=keep");
  });

  it("restarts the pause on each keystroke, so only the settled search reaches the URL", () => {
    render(createElement(Harness));
    const box = screen.getByRole("searchbox", { name: "Search documents" });
    fireEvent.change(box, { target: { value: "pi" } });
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 50));
    fireEvent.change(box, { target: { value: "pip" } });
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 50));
    expect(window.location.search).toBe("?tab=keep");
    act(() => vi.advanceTimersByTime(50));
    expect(new URLSearchParams(window.location.search).get("docs.q")).toBe("pip");
  });

  it("applies a filter chip from the Filters panel and records it in the URL at once", () => {
    render(createElement(Harness));
    const trigger = screen.getByRole("button", { name: "Filters" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const panel = screen.getByRole("group", { name: "Filter documents" });
    const status = within(panel).getByRole("group", { name: "Status" });
    expect(within(status).getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(within(status).getByRole("button", { name: "Off" }));
    expect(within(status).getByRole("button", { name: "Off" }).getAttribute("aria-pressed")).toBe("true");
    expect(listed()).toEqual(["Board deck"]);
    expect(screen.getByRole("button", { name: "Filters, 1 on" })).toBeTruthy();
    act(() => vi.advanceTimersByTime(0));
    expect(new URLSearchParams(window.location.search).get("docs.status")).toBe("off");
  });

  it("shows an active filter as a chip that removes it", () => {
    urlParams = new URLSearchParams("docs.status=on");
    render(createElement(Harness));
    expect(listed()).toEqual(["Pricing sheet", "Pipeline notes"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove filter Status: On" }));
    expect(listed()).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /Remove filter/ })).toBeNull();
  });

  it("closes the Filters panel on Escape and returns focus to its button", () => {
    render(createElement(Harness));
    const trigger = screen.getByRole("button", { name: "Filters" });
    fireEvent.click(trigger);
    const chip = within(screen.getByRole("group", { name: "Filter documents" })).getByRole("button", { name: "On" });
    chip.focus();
    fireEvent.keyDown(chip, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Filter documents" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("shows the count and a Clear all only while narrowed", () => {
    urlParams = new URLSearchParams("docs.status=on&docs.q=p");
    render(createElement(Harness));
    expect(screen.getByText("2 of 3 documents", { selector: "p[aria-hidden]" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(listed()).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Clear all" })).toBeNull();
    expect(liveCount()).toBe("");
  });

  it("closes the Filters panel on a click outside it", () => {
    render(createElement(Harness));
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("group", { name: "Filter documents" })).toBeNull();
  });

  it("changes order from the select, the direction button and the column header", () => {
    render(createElement(Harness));
    fireEvent.change(screen.getByRole("combobox", { name: "Sort by" }), { target: { value: "name" } });
    expect(listed()).toEqual(["Board deck", "Pipeline notes", "Pricing sheet"]);
    const header = screen.getByRole("columnheader", { name: /Name/ });
    expect(header.getAttribute("aria-sort")).toBe("ascending");

    fireEvent.click(screen.getByRole("button", { name: "Order: A–Z. Switch to z–a" }));
    expect(listed()).toEqual(["Pricing sheet", "Pipeline notes", "Board deck"]);
    expect(header.getAttribute("aria-sort")).toBe("descending");

    fireEvent.click(within(header).getByRole("button", { name: /Name/ }));
    expect(header.getAttribute("aria-sort")).toBe("ascending");
    act(() => vi.advanceTimersByTime(0));
    expect(new URLSearchParams(window.location.search).get("docs.sort")).toBe("name");
    expect(new URLSearchParams(window.location.search).has("docs.dir")).toBe(false);
  });

  it("opens a shared link in the view it describes", () => {
    window.history.replaceState(null, "", "/settings?docs.q=deck&docs.sort=name&docs.dir=desc");
    urlParams = new URLSearchParams(window.location.search);
    render(createElement(Harness));
    expect((screen.getByRole("searchbox", { name: "Search documents" }) as HTMLInputElement).value).toBe("deck");
    expect(listed()).toEqual(["Board deck"]);
    expect(screen.getByRole("columnheader", { name: /Name/ }).getAttribute("aria-sort")).toBe("descending");
  });

  it("replaces the view when the URL changes from elsewhere, but not when it echoes its own write", () => {
    const { rerender } = render(createElement(Harness));
    const box = screen.getByRole("searchbox", { name: "Search documents" }) as HTMLInputElement;
    fireEvent.change(box, { target: { value: "pi" } });
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    fireEvent.change(box, { target: { value: "pip" } });
    // The router reports the earlier write while the newer keystroke waits.
    urlParams = new URLSearchParams(window.location.search);
    rerender(createElement(Harness));
    expect(box.value).toBe("pip");

    urlParams = new URLSearchParams("docs.status=off");
    rerender(createElement(Harness));
    expect(box.value).toBe("");
    expect(listed()).toEqual(["Board deck"]);
  });

  it("shows a no-match state whose button clears the search and filters but keeps the order", () => {
    render(createElement(Harness));
    fireEvent.change(screen.getByRole("combobox", { name: "Sort by" }), { target: { value: "name" } });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search documents" }), { target: { value: "zzz" } });
    expect(screen.getByText("No documents match “zzz”.")).toBeTruthy();
    expect(liveCount()).toBe("0 of 3 documents");

    fireEvent.click(screen.getByRole("button", { name: "Clear search and filters" }));
    expect(listed()).toEqual(["Board deck", "Pipeline notes", "Pricing sheet"]);
    expect(liveCount()).toBe("");
  });

  it("gives every control an accessible name, a native keyboard role and a polite live count", () => {
    render(createElement(Harness));
    const toolbar = screen.getByRole("search", { name: "Search, filter and sort documents" });
    fireEvent.click(within(toolbar).getByRole("button", { name: "Filters" }));
    expect(within(toolbar).getByRole("combobox", { name: "Sort by" }).tagName).toBe("SELECT");
    for (const button of within(toolbar).getAllByRole("button")) expect(button.getAttribute("type")).toBe("button");
    expect(document.querySelector("[aria-live='polite']")).toBeTruthy();
    // Every control is in the tab order: nothing is a div posing as a button.
    for (const el of within(toolbar).getAllByRole("button").concat(within(toolbar).getAllByRole("combobox"))) {
      expect(el.tabIndex).toBe(0);
    }
  });

  it("for a server list, reads an unknown total as matching rows and claims no count while the answer is out", () => {
    function ServerHarness({ total, shown }: { total: number | null; shown: number | null }) {
      const controls = useListState(CONFIG);
      return createElement(
        ListControls<Row>,
        { config: CONFIG, controls, total, shown },
        createElement("button", { type: "button" }, "Kept beside the search"),
      );
    }
    window.history.replaceState(null, "", "/settings?docs.q=deck");
    urlParams = new URLSearchParams(window.location.search);
    const view = render(createElement(ServerHarness, { total: null, shown: 12 }));
    expect(liveCount()).toBe("12 matching documents");
    const toolbar = screen.getByRole("search", { name: "Search, filter and sort documents" });
    expect(within(toolbar).getByRole("button", { name: "Kept beside the search" })).toBeTruthy();

    view.rerender(createElement(ServerHarness, { total: 40, shown: null }));
    expect(liveCount()).toBe("");
    expect(screen.queryByText(/of 40 documents/)).toBeNull();
    // With no count to go on, the way back stays offered.
    expect(screen.getByRole("button", { name: "Clear all" })).toBeTruthy();
  });
});
