// @vitest-environment jsdom
//
// The Sync control must not be gated to `s.type === "gdrive"`, or a
// Slack/Figma/PostHog source in "error" status (exactly what an empty-token
// re-sync produces) has no way to retry from the UI at all — the real
// failure is invisible, not just unfixed. This pins that Sync is offered for
// every syncable type (not the inert "website" type, which nothing ever
// ingests), and that clicking it for a non-gdrive source posts no body —
// there is no OAuth flow to collect a client-side token from, the sync route
// resolves one server-side instead.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { isSourcesList, sourcesPage } from "./sources-test-api";

function source(type: string, id: string, name: string, status = "active") {
  return { id, type, name, scopePath: `org.${id}`, status, meta: null, createdAt: "", _count: { files: 1 } };
}

function mockFetch(sources: ReturnType<typeof source>[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (isSourcesList(url)) return Response.json(sourcesPage(url, sources));
      if (url.endsWith("/sync")) return new Response(JSON.stringify({ jobId: "job_1" }), { status: 202 });
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SourcesPanel — Sync control per source type", () => {
  it("offers Sync for slack, figma and posthog, not just gdrive", async () => {
    mockFetch([
      source("gdrive", "s1", "Sales Drive"),
      source("website", "s2", "acme.com"),
      source("slack", "s3", "#general"),
      source("figma", "s4", "Design System"),
      source("posthog", "s5", "Weekly signups"),
    ]);
    const { SourcesPanel } = await import("./sources-panel");
    render(<SourcesPanel />);
    await waitFor(() => expect(screen.getByText("Weekly signups")).toBeTruthy());

    const rowOf = (name: string) => screen.getByText(name).closest("article")!;
    const buttonTextsOf = (name: string) =>
      Array.from(rowOf(name).querySelectorAll("button")).map((b) => b.textContent);
    for (const name of ["Sales Drive", "#general", "Design System", "Weekly signups"]) {
      expect(buttonTextsOf(name)).toContain("Sync");
    }
    const websiteRow = rowOf("acme.com");
    const buttons = Array.from(websiteRow.querySelectorAll("button")).map((b) => b.textContent);
    expect(buttons).not.toContain("Sync");
    expect(buttons).toContain("Disconnect");
  });

  it("re-syncing a slack source posts with no body — no client-side token to send", async () => {
    const calls = mockFetch([source("slack", "s3", "#general", "error")]);
    const { SourcesPanel } = await import("./sources-panel");
    render(<SourcesPanel />);
    await waitFor(() => expect(screen.getByText("#general")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Sync" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/sources/s3/sync")).toBe(true));

    const syncCall = calls.find((c) => c.url === "/api/sources/s3/sync")!;
    expect(syncCall.init?.method).toBe("POST");
    expect(syncCall.init?.body).toBeUndefined();
    expect(await screen.findByText("Sync requested for #general. Refresh status to check the result.")).toBeTruthy();
    expect(screen.queryByText("Sync complete")).toBeNull();
  });
});
