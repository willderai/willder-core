// @vitest-environment jsdom
//
// The Knowledge sources list asks the server for one page searched, filtered and
// ordered (sources-test-api.ts stands in for GET /api/sources), says how many
// sources a search kept, and opens a shared link in the view it names. A single
// source gets no controls.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within, waitFor } from "@testing-library/react";

let urlParams = new URLSearchParams();
vi.mock("next/navigation", () => ({ useSearchParams: () => urlParams }));

import { SourcesPanel } from "./sources-panel";
import { answerSources } from "./sources-test-api";

/** What the toolbar's polite live region says: the count a screen reader hears. */
const liveCount = () => document.querySelector("[aria-live='polite']")?.textContent ?? "";

function source(id: string, type: string, name: string, status: string, createdAt: string) {
  return { id, type, name, scopePath: `org.team_${id}`, status, meta: null, createdAt, _count: { files: 1 } };
}

const SOURCES = [
  source("s1", "gdrive", "Sales Drive", "active", "2026-10-01T00:00:00Z"),
  source("s2", "github", "acme/api", "error", "2026-10-03T00:00:00Z"),
  source("s3", "website", "acme.com", "active", "2026-10-02T00:00:00Z"),
];

function serve(sources: ReturnType<typeof source>[]) {
  vi.stubGlobal("fetch", vi.fn(answerSources(sources)));
}

/** Opens the Filters panel and presses one chip in one filter group. */
function chooseFilter(group: string, chip: string) {
  if (!screen.queryByRole("group", { name: "Filter sources" }))
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
  const panel = screen.getByRole("group", { name: "Filter sources" });
  fireEvent.click(within(within(panel).getByRole("group", { name: group })).getByRole("button", { name: chip }));
}

const names = () =>
  screen.queryAllByRole("article").map((a) => within(a).getByRole("heading", { level: 3 }).textContent);

beforeEach(() => {
  urlParams = new URLSearchParams();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SourcesPanel list controls", () => {
  it("lists newest first, then narrows by search and by type", async () => {
    serve(SOURCES);
    render(<SourcesPanel />);
    await screen.findByText("Sales Drive");
    await waitFor(() => expect(names()).toEqual(["acme/api", "acme.com", "Sales Drive"]));

    fireEvent.change(screen.getByRole("searchbox", { name: "Search sources" }), { target: { value: "acme" } });
    await waitFor(() => expect(names()).toEqual(["acme/api", "acme.com"]));
    await waitFor(() => expect(liveCount()).toBe("2 of 3 sources"));

    chooseFilter("Type", "Website");
    await waitFor(() => expect(names()).toEqual(["acme.com"]));
  });

  it("searches the destination scope and filters by status", async () => {
    serve(SOURCES);
    render(<SourcesPanel />);
    await screen.findByText("Sales Drive");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search sources" }), { target: { value: "team_s1" } });
    await waitFor(() => expect(names()).toEqual(["Sales Drive"]));

    fireEvent.change(screen.getByRole("searchbox", { name: "Search sources" }), { target: { value: "" } });
    chooseFilter("Status", "Needs attention");
    await waitFor(() => expect(names()).toEqual(["acme/api"]));
  });

  it("says when nothing matches and offers the way back", async () => {
    serve(SOURCES);
    render(<SourcesPanel />);
    await screen.findByText("Sales Drive");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search sources" }), {
      target: { value: "nothing like it" },
    });
    await waitFor(() => expect(names()).toEqual([]));
    expect(screen.getByText("No sources match “nothing like it”.")).toBeTruthy();
    // The panel's own first-run empty state is for an org with no sources, not a search with no hits.
    expect(screen.queryByText("Start with one source your agents need.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Clear search and filters" }));
    await waitFor(() => expect(names()).toHaveLength(3));
  });

  it("opens a shared link sorted and filtered as it says", async () => {
    urlParams = new URLSearchParams("sources.sort=name&sources.status=active");
    serve(SOURCES);
    render(<SourcesPanel />);
    await screen.findByText("Sales Drive");
    await waitFor(() => expect(names()).toEqual(["acme.com", "Sales Drive"]));
    expect((screen.getByRole("combobox", { name: "Sort by" }) as HTMLSelectElement).value).toBe("name");
  });

  it("shows no controls over a single source", async () => {
    serve([SOURCES[0]]);
    render(<SourcesPanel />);
    await screen.findByText("Sales Drive");
    expect(screen.queryByRole("search")).toBeNull();
  });
});
