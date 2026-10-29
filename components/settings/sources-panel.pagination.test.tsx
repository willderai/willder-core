// @vitest-environment jsdom
//
// Knowledge sources shows ten at a time, a page per request. A link to one source's
// card (`/integrations#source-<id>`, from the audit page) asks the server which page
// holds it, opens that page and brings the card into view, once; paging away
// afterwards stays where it was put.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within, waitFor } from "@testing-library/react";

let urlParams = new URLSearchParams();
vi.mock("next/navigation", () => ({ useSearchParams: () => urlParams }));

import { SourcesPanel } from "./sources-panel";
import { answerSources } from "./sources-test-api";

/** Fourteen sources, newest first by creation day: "Source 14" on page 1, "Source 01" on page 2. */
const SOURCES = Array.from({ length: 14 }, (_, i) => {
  const n = String(i + 1).padStart(2, "0");
  return {
    id: `s${n}`,
    type: "website",
    name: `Source ${n}`,
    scopePath: `org.team_${n}`,
    status: "active",
    meta: null,
    createdAt: `2026-10-${n}T00:00:00Z`,
    _count: { files: 1 },
  };
});

const names = () =>
  screen.queryAllByRole("article").map((a) => within(a).getByRole("heading", { level: 3 }).textContent);
const pager = () => screen.getByRole("navigation", { name: "Pages of sources" });

const scrolled = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(answerSources(SOURCES)));
  Element.prototype.scrollIntoView = scrolled;
  scrolled.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function openAt(url: string) {
  window.history.replaceState(null, "", url);
  urlParams = new URLSearchParams(window.location.search);
}

describe("SourcesPanel pages", () => {
  it("shows ten sources and steps to the rest", async () => {
    openAt("/integrations#sources");
    render(<SourcesPanel />);
    await screen.findByText("Source 14");
    expect(names()).toHaveLength(10);
    await waitFor(() => expect(within(pager()).getByText("1–10 of 14 sources")).toBeTruthy());
    act(() => fireEvent.click(screen.getByRole("button", { name: "Next page" })));
    await waitFor(() => expect(names()).toEqual(["Source 04", "Source 03", "Source 02", "Source 01"]));
    expect(window.location.search).toBe("?sources.page=2");
  });

  it("opens a linked source on the page it is on, brings it into view, then lets the reader page away", async () => {
    openAt("/integrations#source-s01");
    render(<SourcesPanel />);
    await screen.findByText("Source 01");
    await waitFor(() => expect(within(pager()).getByText("Page 2 of 2")).toBeTruthy());
    // The scroll is an effect that runs after the card renders, so it may not have run when the
    // card first shows. Wait for it rather than reading the mock at that instant.
    await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(1));
    expect(scrolled.mock.contexts[0]).toBe(screen.getByText("Source 01").closest("article"));

    act(() => fireEvent.click(screen.getByRole("button", { name: "Previous page" })));
    await waitFor(() => expect(within(pager()).getByText("Page 1 of 2")).toBeTruthy());
    await waitFor(() => expect(names()[0]).toBe("Source 14"));
    // Paging away is not pulled back to the linked card.
    expect(scrolled).toHaveBeenCalledTimes(1);
  });
});
