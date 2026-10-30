// @vitest-environment jsdom
// GraphExplorer's entity-detail lookup under selection changes, with entity
// fetches parked until the test answers them ("B answers first, A answers last").
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphExplorer } from "@/components/memory/graph-explorer";

const graph = {
  nodes: [
    { uuid: "n0", name: "Acme Corp", type: "org" },
    { uuid: "n1", name: "Jane Doe", type: "person" },
  ],
  edges: [{ uuid: "e0", source: "n0", target: "n1", fact: "employs" }],
};
(
  Element.prototype as unknown as { setPointerCapture: () => void; releasePointerCapture: () => void }
).setPointerCapture = () => {};
(Element.prototype as unknown as { releasePointerCapture: () => void }).releasePointerCapture = () => {};
type Res = (r: Response) => void;
const entity: Record<string, Res[]> = {};
function stub() {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const m = /entities\/([^?]+)/.exec(url);
      if (m) return new Promise<Response>((res) => (entity[m[1]] ??= []).push(res));
      return Promise.resolve(new Response(JSON.stringify(graph), { status: 200 }));
    }),
  );
}
const reply = (id: string, summary: string | null, ok = true) =>
  act(async () => {
    entity[id].shift()!(
      ok ? new Response(JSON.stringify({ summary }), { status: 200 }) : new Response("x", { status: 500 }),
    );
    await new Promise((r) => setTimeout(r, 0));
  });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const k of Object.keys(entity)) delete entity[k];
});

async function mount() {
  const { container } = render(<GraphExplorer />);
  await waitFor(() => {
    if (!container.querySelector("svg g[transform]")) throw new Error("no nodes");
  });
  return container;
}
function select(container: HTMLElement, name: string) {
  const g = Array.from(container.querySelectorAll("g"))
    .filter((el) => el.textContent?.includes(name) && el.getAttribute("transform")?.startsWith("translate"))
    .sort((a, b) => a.textContent!.length - b.textContent!.length)[0];
  (g as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
  fireEvent.pointerDown(g, { pointerId: 1, clientX: 1, clientY: 1 });
}
const loadingShown = () => screen.queryAllByText("Loading…").length > 0;

describe("GraphExplorer entity detail", () => {
  it("select -> Loading… -> summary", async () => {
    stub();
    const c = await mount();
    select(c, "Acme Corp");
    expect(loadingShown()).toBe(true);
    await reply("n0", "SUM-A");
    expect(loadingShown()).toBe(false);
    expect(screen.getByText("SUM-A")).toBeTruthy();
  });
  it("failed lookup ends loading with no summary", async () => {
    stub();
    const c = await mount();
    select(c, "Acme Corp");
    await reply("n0", null, false);
    expect(loadingShown()).toBe(false);
  });
  it("A then B selected, B answers first, A answers last -> B's summary, not stuck loading", async () => {
    stub();
    const c = await mount();
    select(c, "Acme Corp");
    select(c, "Jane Doe");
    await reply("n1", "SUM-B");
    await reply("n0", "SUM-A");
    expect(screen.queryByText("SUM-A")).toBeNull();
    expect(loadingShown()).toBe(false);
    expect(screen.getByText("SUM-B")).toBeTruthy();
  });
  it("A then B selected, A answers first -> B stays loading until B answers", async () => {
    stub();
    const c = await mount();
    select(c, "Acme Corp");
    select(c, "Jane Doe");
    await reply("n0", "SUM-A");
    expect(screen.queryByText("SUM-A")).toBeNull();
    expect(loadingShown()).toBe(true);
    await reply("n1", "SUM-B");
    expect(screen.getByText("SUM-B")).toBeTruthy();
  });
});
