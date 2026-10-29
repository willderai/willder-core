// @vitest-environment jsdom
//
// A sources panel's notice describes a reload it follows, so it waits for that reload:
// "Updated after a change in Connectors" never sits beside the rows from before the
// change, and "#general disconnected" never sits beside a card still offering
// Disconnect. A write's result still shows if the reload then fails, because the write
// happened; "updated" shows only beside a list that did update, even on a server-paged
// panel whose reload keeps the old page "ready".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { isSourcesList, sourcesPage } from "./sources-test-api";

function source(type: string, id: string, name: string, status = "active") {
  return {
    id,
    type,
    name,
    externalId: id,
    scopePath: `org.${id}`,
    status,
    meta: null,
    createdAt: "2026-10-01T00:00:00Z",
    _count: { files: 1 },
  };
}

type Mode = "ok" | "hang" | "fail";

/** GET /api/sources answers, hangs or fails as `mode.get` says; a DELETE reports what it removed. */
function server(rows: () => ReturnType<typeof source>[], mode: { get: Mode }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (isSourcesList(url) && method === "GET") {
        if (mode.get === "hang") return new Promise<Response>(() => {});
        if (mode.get === "fail") return Response.json({ error: "boom" }, { status: 500 });
        return Response.json(sourcesPage(url, rows()));
      }
      if (method === "DELETE") return Response.json({ disconnected: "s1", retiredFacts: 2, retiredChunks: 3 });
      return Response.json({ integrations: [] });
    }),
  );
}

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)));

beforeEach(() => vi.stubEnv("NEXT_PUBLIC_CONNECTORS_ENABLED", "true"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Knowledge sources: a notice waits for the reload it describes", () => {
  it("says 'updated after a change' only once the reload has answered", async () => {
    const mode = { get: "ok" as Mode };
    server(() => [source("slack", "s1", "#general")], mode);
    const { SourcesPanel } = await import("./sources-panel");
    const { announceSourcesChanged } = await import("./sources-changed");
    render(<SourcesPanel />);
    await screen.findByRole("heading", { name: "#general" });
    mode.get = "hang";
    act(() => announceSourcesChanged("Connectors"));
    await settle();
    expect(screen.queryByText(/Updated after a change in Connectors/)).toBeNull();
  });

  it("does not say a source is disconnected while its card, still loading, offers Disconnect", async () => {
    const mode = { get: "ok" as Mode };
    let status = "active";
    server(() => [source("slack", "s1", "#general", status)], mode);
    const { SourcesPanel } = await import("./sources-panel");
    render(<SourcesPanel />);
    const card = within((await screen.findByRole("heading", { name: "#general" })).closest("article")!);
    fireEvent.click(card.getByRole("button", { name: "Disconnect" }));
    mode.get = "hang";
    status = "disconnected";
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect and remove" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await settle();
    expect(screen.queryByText(/#general disconnected/)).toBeNull();
  });

  it("still reports what a disconnect removed when the reload after it fails", async () => {
    const mode = { get: "ok" as Mode };
    server(() => [source("slack", "s1", "#general")], mode);
    const { SourcesPanel } = await import("./sources-panel");
    render(<SourcesPanel />);
    const card = within((await screen.findByRole("heading", { name: "#general" })).closest("article")!);
    fireEvent.click(card.getByRole("button", { name: "Disconnect" }));
    mode.get = "fail";
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect and remove" }));
    await screen.findByText("Could not load sources.");
    expect(screen.getByText("#general disconnected. Removed 2 facts and 3 passages from memory.")).toBeTruthy();
  });

  it("clears the notice when the person refreshes, so an old line never returns with a new list", async () => {
    const mode = { get: "ok" as Mode };
    server(() => [source("slack", "s1", "#general")], mode);
    const { SourcesPanel } = await import("./sources-panel");
    const { announceSourcesChanged } = await import("./sources-changed");
    render(<SourcesPanel />);
    await screen.findByRole("heading", { name: "#general" });
    act(() => announceSourcesChanged("Connectors"));
    expect(await screen.findByText("Updated after a change in Connectors.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    await settle();
    expect(screen.queryByText(/Updated after a change/)).toBeNull();
  });
});

describe("Connectors: a notice waits for the reload it describes", () => {
  it("says 'updated after a change' only once the reload has answered, and never beside a failed one", async () => {
    const mode = { get: "ok" as Mode };
    server(() => [source("slack", "s1", "#general")], mode);
    const { ConnectorsPanel } = await import("./connectors-panel");
    const { announceSourcesChanged } = await import("./sources-changed");
    render(<ConnectorsPanel />);
    await screen.findByText("#general");
    mode.get = "hang";
    act(() => announceSourcesChanged("Knowledge sources"));
    await settle();
    expect(screen.queryByText(/Updated after a change in Knowledge sources/)).toBeNull();
    cleanup();

    mode.get = "ok";
    render(<ConnectorsPanel />);
    await screen.findByText("#general");
    mode.get = "fail";
    act(() => announceSourcesChanged("Knowledge sources"));
    expect((await screen.findByRole("alert")).textContent).toContain("Connectors could not be loaded.");
    expect(screen.queryByText(/Updated after a change/)).toBeNull();
  });

  it("reports what a disconnect removed once the list has reloaded", async () => {
    const mode = { get: "ok" as Mode };
    let status = "active";
    server(() => [source("slack", "s1", "#general", status)], mode);
    const { ConnectorsPanel } = await import("./connectors-panel");
    render(<ConnectorsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    status = "disconnected";
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect and remove" }));
    expect(await screen.findByText("#general disconnected. Removed 2 facts and 3 passages from memory.")).toBeTruthy();
  });
});
