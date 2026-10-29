// @vitest-environment jsdom
//
// The Connectors panel's Retry, like the Knowledge sources panel's
// Refresh, clears the notice it was showing, so a disconnect's result line reported
// beside a failed reload does not come back beside the list the retry loads.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

beforeEach(() => vi.stubEnv("NEXT_PUBLIC_CONNECTORS_ENABLED", "true"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Connectors: Retry after a failed reload", () => {
  it("clears the disconnect's notice, so it never returns beside the retried list", async () => {
    let failGet = false;
    let status = "active";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (isSourcesList(url) && method === "GET") {
          if (failGet) return Response.json({ error: "boom" }, { status: 500 });
          return Response.json(sourcesPage(url, [source("slack", "s1", "#general", status)]));
        }
        if (method === "DELETE") return Response.json({ disconnected: "s1", retiredFacts: 2, retiredChunks: 3 });
        return Response.json({ integrations: [] });
      }),
    );
    const { ConnectorsPanel } = await import("./connectors-panel");
    render(<ConnectorsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    failGet = true;
    status = "disconnected";
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect and remove" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Connectors could not be loaded.");
    const notice = "#general disconnected. Removed 2 facts and 3 passages from memory.";
    expect(screen.getByText(notice)).toBeTruthy();

    failGet = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    await screen.findByText("#general");
    expect(screen.queryByText(notice)).toBeNull();
  });
});
