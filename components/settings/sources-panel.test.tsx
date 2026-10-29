// @vitest-environment jsdom
//
// This panel lists every /api/sources row (unlike connectors-panel.tsx, which
// filters to slack/figma/posthog only), so its badge must name each type: a Slack
// or Figma source must not read as a website.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { answerSources } from "./sources-test-api";

function mockSourcesList(sources: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(answerSources(sources as Parameters<typeof answerSources>[0])));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function source(type: string, id: string, name: string) {
  return { id, type, name, scopePath: `org.${id}`, status: "active", meta: null, createdAt: "", _count: { files: 1 } };
}

describe("SourcesPanel — badge per source type", () => {
  it("badges each source with its real connector type, not a gdrive/website guess", async () => {
    mockSourcesList([
      source("gdrive", "s1", "Sales Drive"),
      source("website", "s2", "acme.com"),
      source("slack", "s3", "#general"),
      source("figma", "s4", "Design System"),
      source("posthog", "s5", "Weekly signups"),
    ]);
    const { SourcesPanel } = await import("./sources-panel");
    render(<SourcesPanel />);
    await waitFor(() => expect(screen.getByText("Weekly signups")).toBeTruthy());

    const logoFor = (name: string) =>
      screen
        .getByText(name)
        .closest("article")!
        .querySelector("[data-connector-logo]")
        ?.getAttribute("data-connector-logo");

    expect(logoFor("Sales Drive")).toBe("gdrive");
    expect(logoFor("acme.com")).toBeUndefined();
    expect(screen.getByText("acme.com").closest("article")!.querySelector("svg.lucide-globe")).not.toBeNull();
    expect(logoFor("#general")).toBe("slack");
    expect(logoFor("Design System")).toBe("figma");
    expect(logoFor("Weekly signups")).toBe("posthog");
  });
});

// A failed disconnect must say why, not just reload with the source still listed.
describe("SourcesPanel — failed disconnect", () => {
  function mockDisconnectFailure(response: Response) {
    const errored = { ...source("gdrive", "s1", "Mock Sales Collateral"), status: "error" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) =>
        init?.method === "DELETE" ? response : answerSources([errored])(url, init),
      ),
    );
  }

  async function clickDisconnect() {
    const { SourcesPanel } = await import("./sources-panel");
    render(<SourcesPanel />);
    fireEvent.click(await screen.findByText("Disconnect"));
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect and remove" }));
  }

  it("never quotes a 5xx's text, which can carry a downstream service's error", async () => {
    mockDisconnectFailure(
      new Response(
        JSON.stringify({ error: "Could not remove this source's facts from memory, so it is still connected." }),
        { status: 502 },
      ),
    );
    await clickDisconnect();
    expect(
      await screen.findByText(
        "Willder could not remove this source's content from memory (HTTP 502), so it is still connected. Try again in a minute.",
      ),
    ).toBeTruthy();
  });

  it("names the status when the response has no body", async () => {
    mockDisconnectFailure(new Response(null, { status: 500 }));
    await clickDisconnect();
    expect(
      await screen.findByText(
        "Willder could not remove this source's content from memory (HTTP 500), so it is still connected. Try again in a minute.",
      ),
    ).toBeTruthy();
  });
});

describe("SourcesPanel — scoped source evidence", () => {
  it("links the actual destination to memory and its recorded changes", async () => {
    mockSourcesList([{ ...source("github", "s1", "Product repository"), scopePath: "org.product.engineering" }]);
    const { SourcesPanel } = await import("./sources-panel");
    render(<SourcesPanel />);
    const row = (await screen.findByText("Product repository")).closest("article")!;
    expect(within(row).getByText("Destination scope")).toBeTruthy();
    expect(within(row).getByText("org.product.engineering")).toBeTruthy();
    expect(within(row).getByRole("link", { name: "Ask this scope" }).getAttribute("href")).toBe(
      "/memory?scope=org.product.engineering",
    );
    expect(within(row).getByRole("link", { name: "View scope changes" }).getAttribute("href")).toBe(
      "/audit?view=timeline&scope=org.product.engineering",
    );
  });

  it("does not turn updatedAt or an active connection into a successful sync", async () => {
    mockSourcesList([{ ...source("github", "s1", "Product repository"), updatedAt: "2026-09-29T12:00:00Z" }]);
    const { SourcesPanel } = await import("./sources-panel");
    render(<SourcesPanel />);
    await screen.findByText("Product repository");
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("No sync result recorded")).toBeTruthy();
    expect(screen.queryByText(/Last sync attempt/)).toBeNull();
  });

  it("shows partial ingestion even when the backend connection status is active", async () => {
    mockSourcesList([
      {
        ...source("github", "s1", "Product repository"),
        meta: { lastSyncAt: "2026-09-29T12:00:00Z", synced: 2, skipped: 1, failed: 3 },
      },
    ]);
    const { SourcesPanel } = await import("./sources-panel");
    render(<SourcesPanel />);
    expect(await screen.findByText("Partial sync")).toBeTruthy();
    expect(screen.getByText(/Last sync attempt/)).toBeTruthy();
    expect(screen.getByText("2 synced · 1 unchanged · 3 failed")).toBeTruthy();
  });

  it("surfaces a failed run without calling its attempt timestamp a success", async () => {
    mockSourcesList([
      {
        ...source("github", "s1", "Product repository"),
        status: "error",
        meta: { lastSyncAt: "2026-09-29T12:00:00Z", synced: 0, failed: 1, error: "Upstream access was revoked." },
      },
    ]);
    const { SourcesPanel } = await import("./sources-panel");
    render(<SourcesPanel />);
    expect(await screen.findByText("Needs attention")).toBeTruthy();
    expect(screen.getByText("Upstream access was revoked.")).toBeTruthy();
    expect(screen.getByText(/Last sync attempt/)).toBeTruthy();
    expect(screen.queryByText(/Last successful sync/)).toBeNull();
  });

  it("does not hide a load failure behind the empty-source onboarding", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Source access is unavailable." }), { status: 403 }))
      .mockImplementation(answerSources([source("github", "s1", "Product repository")]));
    vi.stubGlobal("fetch", fetcher);
    const { SourcesPanel } = await import("./sources-panel");
    render(<SourcesPanel />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Listing sources needs write access to the whole organization.")).toBeTruthy();
    expect(screen.queryByText("Start with one source your agents need.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    expect(await screen.findByText("Product repository")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // A refresh that fails cannot confirm the rows it would show, so it says so in their
  // place, the rule every server-paged list follows, and Refresh status brings them back.
  it("says a failed refresh failed instead of showing rows it could not confirm", async () => {
    const row = source("github", "s1", "Product repository");
    const fetcher = vi
      .fn()
      .mockImplementationOnce(answerSources([row]))
      .mockRejectedValueOnce(new Error("Connection lost."))
      .mockImplementation(answerSources([row]));
    vi.stubGlobal("fetch", fetcher);
    const { SourcesPanel } = await import("./sources-panel");
    render(<SourcesPanel />);
    await screen.findByText("Product repository");
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    expect(await screen.findByText("Could not load sources.")).toBeTruthy();
    expect(screen.queryByText("Product repository")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    expect(await screen.findByText("Product repository")).toBeTruthy();
  });
});

// A GitHub token without Issues or Pull requests read makes the sync skip those
// parts and record them in meta.unreadable; the row must not read as a plain
// "Connected" source.
describe("SourcesPanel — parts the token cannot read", () => {
  function githubSource(meta: Record<string, unknown>, status = "active") {
    return {
      ...source("github", "s1", "acme/api"),
      status,
      meta: { lastSyncAt: "2026-10-08T12:00:00Z", synced: 3, ...meta },
    };
  }

  async function rowText(row: unknown) {
    mockSourcesList([row]);
    const { SourcesPanel } = await import("./sources-panel");
    render(<SourcesPanel />);
    return (await screen.findByText("acme/api")).closest("article")!.textContent ?? "";
  }

  it("names the skipped parts and the permission that fixes them", async () => {
    const text = await rowText(githubSource({ unreadable: ["issues", "pulls"] }));
    // Comments and reviews follow their issue or pull request, so the record names only the parents.
    expect(text).toContain(
      "Not synced: issues with their comments, pull requests with their comments and reviews. The token cannot read them.",
    );
    expect(text).toContain("Give the token Issues and Pull requests read access, then sync.");
  });

  it("names one Contents permission for README and commits together", async () => {
    const text = await rowText(githubSource({ unreadable: ["readme", "commits"] }));
    expect(text).toContain("Not synced: README, commits.");
    expect(text).toContain("Give the token Contents read access, then sync.");
  });

  it("says nothing when the last sync read every part", async () => {
    const text = await rowText(githubSource({ unreadable: [] }));
    expect(text).not.toContain("Not synced");
  });

  it("says nothing for a source whose sync never recorded unreadable parts", async () => {
    // Slack, Figma and PostHog listings never set meta.unreadable, nor did any
    // GitHub sync before it existed: no key must mean no notice.
    const text = await rowText(githubSource({}));
    expect(text).not.toContain("Not synced");
  });

  it("ignores entries that are not part names", async () => {
    const text = await rowText(githubSource({ unreadable: [null, 7, "issues"] }));
    expect(text).toContain("Not synced: issues with their comments. The token cannot read them.");
    expect(text).toContain("Give the token Issues read access, then sync.");
  });

  it("says nothing for a disconnected source", async () => {
    const text = await rowText(githubSource({ unreadable: ["issues"] }, "disconnected"));
    expect(text).not.toContain("Not synced");
  });

  // A sync that lost access read nothing. A row it wrote before it stopped
  // storing them still carries an earlier run's counts and skipped parts.
  it("shows only the fix under Access lost, not an earlier run's counts or skipped parts", async () => {
    const text = await rowText(
      githubSource(
        {
          synced: 0,
          skipped: 0,
          failed: 0,
          unreadable: ["issues"],
          accessLost: true,
          error: "This token can't read acme/api. Grant the token access to acme/api and reconnect.",
        },
        "error",
      ),
    );
    expect(text).toContain("Access lost");
    expect(text).toContain("Grant the token access to acme/api and reconnect.");
    expect(text).not.toContain("Not synced");
    expect(text).not.toMatch(/synced ·|unchanged/);
  });
});

// A Drive folder whose listing came back empty (no access to the files inside
// a picked folder under drive.file, no supported file types, or no files) used
// to read "Connected · 0 synced", indistinguishable from a working sync.
describe("SourcesPanel — Drive sync that found no files", () => {
  const NOTHING = /Nothing from this folder is in memory/;

  function drive(meta: Record<string, unknown> | null, status = "active") {
    return { ...source("gdrive", "s1", "Sales Drive"), status, meta, _count: { files: 0 } };
  }

  async function renderWith(sources: unknown[]) {
    mockSourcesList(sources);
    const { SourcesPanel } = await import("./sources-panel");
    render(<SourcesPanel />);
    await screen.findByText("Sales Drive");
  }

  it("says nothing synced and why, instead of Connected", async () => {
    await renderWith([drive({ lastSyncAt: "2026-10-10T03:00:00Z", fileCount: 0, synced: 0, skipped: 0, failed: 0 })]);
    expect(screen.getByText("No files synced")).toBeTruthy();
    expect(screen.queryByText("Connected")).toBeNull();
    expect(screen.getByText(NOTHING).textContent).toMatch(/may not include the files inside a picked folder/);
  });

  it("stays Connected with no warning once the folder listed files", async () => {
    await renderWith([drive({ lastSyncAt: "2026-10-10T03:00:00Z", fileCount: 3, synced: 3, skipped: 0, failed: 0 })]);
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.queryByText(NOTHING)).toBeNull();
  });

  it("does not warn before the first sync has finished", async () => {
    await renderWith([drive(null)]);
    expect(screen.queryByText(NOTHING)).toBeNull();
  });
});
