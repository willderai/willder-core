// @vitest-environment jsdom
//
// The connector card's disconnect and remove controls.
//
// 1. "Remove what's left" is offered exactly when another disconnect would retire
//    something: the client's reading of GET /api/sources/:id/records must agree with
//    the server's `holdsRetirableRecords`, field by field, or the card either hides
//    leftovers a disconnect would remove or offers a removal that can never finish.
// 2. A disconnect the server refuses says so, and does not claim the source went.
// 3. The flag-gated Connectors panel asks first too: Cancel sends nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { remainingRecords } from "./connector-data";
import { isSourcesList, sourcesPage } from "./sources-test-api";
import { holdsRetirableRecords, type SourceRecordCounts } from "@/services/memory/source-records";

type Call = { url: string; method: string };

function mockFetch(answer: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const call = { url, method: init?.method ?? "GET" };
      calls.push(call);
      return answer(call);
    }),
  );
  return calls;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

const EMPTY: SourceRecordCounts = {
  scopePath: "org.a",
  chunks: 0,
  chunkEmbeddings: 0,
  syncRecords: 0,
  feedSummaries: 0,
  episodes: 0,
  facts: 0,
  factEmbeddings: 0,
  verbatimNodes: 0,
  orphans: 0,
  danglingFacts: 0,
};

describe("remainingRecords agrees with the server on what a disconnect would still retire", () => {
  // The two embedding counts are subsets of `chunks` and `facts`: the server never
  // reports one above zero while its parent is zero, so each is tested with its parent.
  const rows: [string, Partial<SourceRecordCounts>][] = [
    ["chunks", { chunks: 1, chunkEmbeddings: 1 }],
    ["syncRecords", { syncRecords: 1 }],
    ["feedSummaries", { feedSummaries: 1 }],
    ["episodes", { episodes: 1 }],
    ["facts", { facts: 1, factEmbeddings: 1 }],
    ["verbatimNodes", { verbatimNodes: 1 }],
    ["danglingFacts", { danglingFacts: 1 }],
    ["orphans", { orphans: 1 }],
    ["nothing", {}],
  ];

  for (const [name, counts] of rows) {
    it(`${name}`, () => {
      const row = { ...EMPTY, ...counts };
      expect(remainingRecords([row]).retirable).toBe(holdsRetirableRecords(row));
    });
  }

  it("a leftover in a scope the source moved away from still counts", () => {
    const rows = [EMPTY, { ...EMPTY, scopePath: "org.b", episodes: 2 }];
    expect(remainingRecords(rows)).toEqual({ text: "Still in memory: 2 other records.", retirable: true });
  });
});

function source(type: string, id: string, name: string, status = "active") {
  return {
    id,
    type,
    name,
    scopePath: `org.${id}`,
    status,
    meta: null,
    createdAt: "2026-10-01T00:00:00Z",
    _count: { files: 1 },
  };
}

describe("SourcesPanel: a refused disconnect", () => {
  it("shows the server's reason, closes the question, and does not report the source gone", async () => {
    const calls = mockFetch((call) =>
      call.method === "DELETE"
        ? json({ error: "Could not remove this source's facts from memory, so it is still connected. timeout" }, 502)
        : json(sourcesPage(call.url, [source("github", "s1", "acme/widgets")])),
    );
    const { SourcesPanel } = await import("./sources-panel");
    render(<SourcesPanel />);
    const card = within((await screen.findByRole("heading", { name: "acme/widgets" })).closest("article")!);

    fireEvent.click(await card.findByRole("button", { name: "Disconnect" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Disconnect and remove" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/so it is still connected/);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(/acme\/widgets disconnected/)).toBeNull();
    expect(card.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  });
});

describe("ConnectorsPanel: disconnect asks first", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_CONNECTORS_ENABLED", "true");
  });

  it("names what goes for the source's kind, and Cancel sends no DELETE", async () => {
    const figma = {
      id: "s5",
      type: "figma",
      externalId: "F1",
      name: "Design System",
      scopePath: "org.s5",
      status: "active",
      createdAt: "2026-10-01T00:00:00Z",
    };
    const calls = mockFetch((call) =>
      isSourcesList(call.url) && call.method === "GET"
        ? json(sourcesPage(call.url, [figma]))
        : json({ sources: [figma] }),
    );
    const { ConnectorsPanel } = await import("./connectors-panel");
    render(<ConnectorsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    const dialog = screen.getByRole("dialog", { name: "Disconnect Design System?" });
    expect(within(dialog).getByText(/The token still works at Figma/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});
