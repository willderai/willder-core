// @vitest-environment jsdom
//
// Names a user or an org admin can set (a source's name, a connector's author, an Agent
// row's name, a stored writer name) are drawn next to the identity of whoever wrote a
// fact. A bidi control in one of them reorders what the screen shows, so "‮metsyS‬"
// reads as "System". Every surface below draws those names with the controls escaped;
// each test puts a control in the name and checks that none reaches the DOM.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import type { Timeline } from "@/services/audit/timeline";
import type { MemoryFact, MemoryGraph, StoresOverview } from "@/types/memory";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children?: unknown }) =>
    createElement("a", { href, ...props }, children as never),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/help", () => ({ HelpTip: ({ children }: { children: ReactNode }) => <>{children}</> }));

import { AuditTimeline } from "./timeline";
import { FactProvenance } from "@/components/memory/fact-provenance";
import { FactCard } from "@/components/memory/memory-workbench";
import { GraphExplorer } from "@/components/memory/graph-explorer";
import { MemoryStores } from "@/components/memory/memory-stores";
import { NavSearch } from "@/components/access-search/nav-search";
import AgentsPage from "@/app/(app)/agents/page";

const BIDI = /\p{Bidi_Control}/u;
const SPOOF = "‮metsyS‬";
const SHOWN = "[U+202E]metsyS[U+202C]";

class NoopResizeObserver {
  observe() {}
  disconnect() {}
}
beforeEach(() => vi.stubGlobal("ResizeObserver", NoopResizeObserver));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("names set by users or admins are drawn with bidi controls escaped", () => {
  it("in the Timeline's change detail: the writer, the source name and the readers", async () => {
    const scope = "org_c1";
    const timeline: Timeline = {
      lanes: [
        { key: "agent:a", actorType: "agent", actorId: "a", name: `${SPOOF} Agent`, scopePath: scope },
        { key: "agent:b", actorType: "agent", actorId: "b", name: `Reader ${SPOOF}`, scopePath: scope },
      ],
      writes: [
        {
          id: "w1",
          at: "2026-09-25T12:10:00.000Z",
          laneKey: "agent:a",
          scopePath: scope,
          op: "create",
          recordType: "fact",
          recordId: "f1",
          origin: "mcp",
          outcome: "success",
        },
      ],
      sightings: [
        {
          writeId: "w1",
          laneKey: "agent:b",
          readId: "r1",
          at: "2026-09-25T12:10:06.000Z",
          latencyMs: 6000,
          action: "memory.read",
          scopePath: scope,
          origin: "mcp",
          outcome: "allow",
        },
      ],
      denials: [],
      latency: { count: 1, medianMs: 6000, p95Ms: 6000 },
      unseenWriteIds: [],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith("/api/audit/timeline/w1")
          ? json({
              id: "w1",
              op: "create",
              recordType: "fact",
              recordId: "f1",
              scopePath: scope,
              summary: "A change",
              writer: `${SPOOF} Agent`,
              source: { id: "src1", name: `${SPOOF} #eng`, type: "slack" },
              replacedById: null,
              replacesIds: [],
              actingFor: SPOOF,
              replacedBy: null,
              replaces: [],
              at: timeline.writes[0]!.at,
            })
          : json({
              scope,
              from: "2026-09-25T12:00:00.000Z",
              to: "2026-09-25T13:00:00.000Z",
              timeline,
              truncated: { writes: false, reads: false },
            }),
      ),
    );
    const { container } = render(<AuditTimeline scope={scope} selected="w1" onSelect={() => {}} />);
    const panel = await screen.findByRole("region", { name: "Selected change" });
    await within(panel).findByText("A change");
    await within(panel).findByText(`Reader ${SHOWN}`);
    const answer = (label: string) =>
      within(panel).getByText(label, { selector: "dt" }).nextElementSibling?.textContent;
    expect(answer("Source")).toBe(`${SHOWN} #eng (slack)`);
    expect(BIDI.test(container.innerHTML)).toBe(false);
  });

  it("in a fact's provenance and on its card", () => {
    const fact: MemoryFact = {
      uuid: "f1",
      fact: "Budget is $50k",
      validAt: null,
      actorType: "agent",
      actorName: `${SPOOF} Agent`,
    };
    const { container } = render(
      <>
        <FactProvenance fact={fact} scope={null} />
        <FactCard
          fact={fact}
          scope={null}
          canDelete={false}
          canWrite={false}
          onRemoved={() => {}}
          onEdited={() => {}}
          onNote={() => {}}
        />
      </>,
    );
    expect(screen.getAllByText(`${SHOWN} Agent`).length).toBeGreaterThan(0);
    expect(BIDI.test(container.innerHTML)).toBe(false);
  });

  it("in the graph explorer: the edge label, a node's relationships and the selected edge", async () => {
    const graph: MemoryGraph = {
      nodes: [
        { uuid: "n0", name: "Acme", type: "org" },
        { uuid: "n1", name: "Jane", type: "person" },
      ],
      edges: [
        { uuid: "e0", source: "n0", target: "n1", fact: "employs", actorType: "agent", actorName: `${SPOOF} Agent` },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(graph)),
    );
    const { container } = render(<GraphExplorer />);
    await waitFor(() => expect(container.querySelector("svg line")).not.toBeNull());
    fireEvent.pointerDown(container.querySelector("svg line")!);
    await screen.findAllByText(new RegExp(`${SHOWN.replace(/[[\]+]/g, "\\$&")} Agent`));
    expect(BIDI.test(container.innerHTML)).toBe(false);

    Element.prototype.setPointerCapture ??= () => {};
    const node = screen
      .getAllByText("Acme")
      .find((el) => el.closest("svg"))!
      .closest("g")!;
    fireEvent.pointerDown(node, { pointerId: 1 });
    await screen.findByText(/^Relationships \(1/);
    expect(BIDI.test(container.innerHTML)).toBe(false);
  });

  it("in the memory stores: a chunk's author, a file's source name, a note's agent, a scope name and a search hit's writer", async () => {
    const overview: StoresOverview = {
      scope: "org_1",
      counts: { records: 0, briefs: 0, rules: 0, notes: 1, chunks: 1, files: 1 },
      lowerBounds: [],
      records: [],
      briefs: [],
      rules: [],
      notes: [
        {
          id: "n1",
          kind: "claim",
          task: "A task",
          body: "b",
          agentName: `${SPOOF} Agent`,
          status: "live",
          scopePath: "org_1.sales_1a2b3c",
          scopeName: `${SPOOF} sales`,
          createdAt: "2026-09-29T10:00:00.000Z",
          expiresAt: "2026-09-29T11:00:00.000Z",
        },
      ],
      chunks: [
        {
          id: "c1",
          snippet: "A chunk",
          source: "slack",
          author: `${SPOOF} — Sam`,
          scopePath: "org_1",
          createdAt: "2026-09-29T10:00:00.000Z",
        },
      ],
      files: [
        {
          id: "file1",
          externalFileId: "doc-1",
          sourceName: `${SPOOF} drive`,
          sourceType: "google_drive",
          chunkCount: 1,
          scopePath: "org_1",
          syncedAt: "2026-09-29T10:00:00.000Z",
        },
      ],
    } as unknown as StoresOverview;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/memory/query") {
          return json({
            facts: [
              {
                uuid: "h1",
                fact: "A hit",
                validAt: null,
                store: "semantic",
                similarity: 0.9,
                actorName: `${SPOOF} Agent`,
              },
            ],
            breakdown: { stores: [{ store: "semantic", hits: 1 }], contextTokens: 5 },
          });
        }
        return url.startsWith("/api/memory/stores") ? json(overview) : json({ nodes: [], edges: [] });
      }),
    );
    const { container } = render(
      <MemoryStores initialScope="org_1" canDelete={false} canWrite={false} canManageScopes={false} />,
    );
    fireEvent.click(await screen.findByRole("tab", { name: /^Working notes/ }));
    expect(await screen.findByText(`${SHOWN} sales`)).toBeTruthy();
    expect(screen.getAllByText(`${SHOWN} Agent`)).toHaveLength(1);
    expect(BIDI.test(container.innerHTML)).toBe(false);

    fireEvent.click(screen.getByRole("tab", { name: /^Text passages/ }));
    expect(await screen.findByText(`${SHOWN} — Sam`)).toBeTruthy();
    expect(BIDI.test(container.innerHTML)).toBe(false);

    const box = screen.getByRole("searchbox", { name: "Search text passages by meaning" });
    fireEvent.change(box, { target: { value: "hit" } });
    fireEvent.submit(box.closest("form")!);
    expect(await screen.findByText(`${SHOWN} Agent`)).toBeTruthy();
    expect(BIDI.test(container.innerHTML)).toBe(false);

    fireEvent.click(screen.getByRole("tab", { name: /^Files/ }));
    await screen.findByText("doc-1");
    expect(BIDI.test(container.innerHTML)).toBe(false);
  });

  it("in the sidebar search: agent, source and audit-writer results", async () => {
    const empty = { denied: false, items: [], hasMore: false };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          scopes: empty,
          tokens: empty,
          agents: {
            denied: false,
            hasMore: false,
            items: [{ id: "g1", name: `${SPOOF} Agent`, agentKey: "custom-1" }],
          },
          sources: { denied: false, hasMore: false, items: [{ id: "s1", name: `${SPOOF} #eng`, type: "slack" }] },
          audit: {
            denied: false,
            hasMore: false,
            items: [
              { id: "a1", actorName: `${SPOOF} Agent`, action: "memory.read", target: "org_1", decision: "allow" },
            ],
          },
        }),
      ),
    );
    const { container } = render(
      createElement(NavSearch, { collapsed: false, onExpand: () => {}, onNavigate: () => {} }),
    );
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "sys" } });
    const panel = await screen.findByRole("region", { name: "Search results" });
    await within(panel).findByText(`${SHOWN} #eng`);
    expect(BIDI.test(container.innerHTML)).toBe(false);
  });

  it("on the Agents page: a custom agent's card, its run history and its runs", async () => {
    const run = {
      id: "run1",
      status: "completed",
      createdAt: "2026-09-29T10:00:00.000Z",
      completedAt: null,
      input: null,
      output: null,
      error: null,
      metadata: null,
    };
    const agent = {
      id: "g1",
      agentKey: "custom-1",
      name: `${SPOOF} Agent`,
      role: "custom",
      model: null,
      systemPrompt: null,
      tools: [],
      active: true,
      _count: { runs: 1 },
      runs: [run],
    };
    const rosterRow = {
      kind: "custom",
      id: "g1",
      key: "custom-1",
      name: agent.name,
      role: "custom",
      status: "idle",
      activity: 1,
      lastRunStatus: "completed",
      lastRunId: "run1",
      lastActiveAt: run.createdAt,
      scopes: [],
      permission: null,
      liveTokens: null,
      series: Array.from({ length: 7 }, () => ({ total: 0, failed: 0 })),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/agents?kind=builtin"
          ? json({ agents: [] })
          : url.startsWith("/api/agents/roster")
            ? json({ rows: [rosterRow], total: 1, page: 1, pageSize: 12 })
            : url === "/api/agents/g1"
              ? json({ agent })
              : url.startsWith("/api/agents/g1/runs")
                ? json({ runs: [run] })
                : json({}),
      ),
    );
    const { container } = render(<AgentsPage />);
    // The roster row, then the card and run history of the agent it opens.
    await screen.findByText(`${SHOWN} Agent`, { selector: "p" });
    fireEvent.click(screen.getByRole("button", { name: /^Open/ }));
    await waitFor(() => expect(screen.getAllByText(`${SHOWN} Agent`).length).toBeGreaterThanOrEqual(3));
    expect(BIDI.test(container.innerHTML)).toBe(false);
  });
});
