// @vitest-environment jsdom
//
// Integrations shows sources in two panels, Knowledge sources and Connectors, and each loads
// /api/sources itself. A connect, sync or disconnect in one panel must refresh the other
// and say so: a stranger who connects a repository in Connectors used to see the old
// "Disconnected" row in Knowledge sources, with no message, until they reloaded the page.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { isSourcesList, sourcesPage } from "./sources-test-api";
import { gitHubProbeAnswer, pickGitHubRepository } from "./github-picker.testsupport";

type Status = "active" | "syncing" | "error" | "disconnected";

function repoSource(status: Status) {
  return {
    id: "src_repo",
    type: "github",
    externalId: "owner/scratch",
    name: "owner/scratch",
    scopePath: "org.scratch",
    status,
    meta: null,
    createdAt: "",
    _count: { files: 0 },
  };
}

/** /api/sources as the server answers it: the list reflects every write before it. */
function mockServer(initial: Status) {
  let status: Status = initial;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const probe = gitHubProbeAnswer(url, ["owner/scratch"]);
      if (probe) return probe;
      if (isSourcesList(url) && method === "GET") return Response.json(sourcesPage(url, [repoSource(status)]));
      if (url === "/api/sources" && method === "POST") {
        status = "syncing";
        return Response.json({ source: repoSource(status) }, { status: 201 });
      }
      if (url === "/api/sources/src_repo" && method === "DELETE") {
        status = "disconnected";
        return Response.json({ ok: true });
      }
      throw new Error(`unexpected ${method} ${url}`);
    }),
  );
}

async function renderSourcePanels() {
  const { SourcesPanel } = await import("./sources-panel");
  const { ConnectorsPanel } = await import("./connectors-panel");
  render(
    <>
      <section aria-label="Knowledge sources">
        <SourcesPanel />
      </section>
      <section aria-label="Source connectors">
        <ConnectorsPanel />
      </section>
    </>,
  );
  return {
    knowledge: () => within(screen.getByRole("region", { name: "Knowledge sources" })),
    connectors: () => within(screen.getByRole("region", { name: "Source connectors" })),
  };
}

beforeEach(() => vi.stubEnv("NEXT_PUBLIC_CONNECTORS_ENABLED", "true"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Integrations sources: one panel's change refreshes the other", () => {
  it("a GitHub connect in Connectors updates the Knowledge sources row and says so", async () => {
    mockServer("disconnected");
    const { knowledge, connectors } = await renderSourcePanels();
    expect(await knowledge().findByText("Disconnected")).toBeTruthy();

    fireEvent.click(connectors().getByRole("button", { name: /Connect GitHub/ }));
    await pickGitHubRepository(
      "github_pat_test",
      "owner/scratch",
      screen.getByRole("region", { name: "Source connectors" }),
    );
    fireEvent.click(connectors().getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(knowledge().getByText("Syncing")).toBeTruthy());
    expect(knowledge().queryByText("Disconnected")).toBeNull();
    // Each status line is drawn by its own panel's render, after the reload it describes.
    await waitFor(() =>
      expect(knowledge().getByRole("status").textContent).toMatch(/updated after a change in Connectors/i),
    );
    await waitFor(() => expect(connectors().getByRole("status").textContent).toMatch(/owner\/scratch connected/));
  });

  it("a disconnect in Knowledge sources updates the Connectors row", async () => {
    mockServer("active");
    const { knowledge, connectors } = await renderSourcePanels();
    expect(await connectors().findByText("active")).toBeTruthy();

    fireEvent.click(await knowledge().findByRole("button", { name: "Disconnect" }));
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect and remove" }));

    await waitFor(() => expect(connectors().getByText("disconnected")).toBeTruthy());
    await waitFor(() =>
      expect(connectors().getByRole("status").textContent).toMatch(/updated after a change in Knowledge sources/i),
    );
  });
});
