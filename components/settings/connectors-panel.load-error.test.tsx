// @vitest-environment jsdom
//
// A failed GET /api/sources must read as a failure, not as "nothing connected".
// The responses below use the route's own error shapes (app/api/sources/route.ts
// answers 401 { error: "unauthorized" } and 403 { error: <reason> }), plus a
// bodyless 500 and a network error. A 403 says what access the list needs; every
// other failure says the load failed and offers a retry.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { isSourcesList, sourcesPage } from "./sources-test-api";

const EMPTY_TEXT = /No Slack, Figma, PostHog or GitHub sources/;
const slackSource = { id: "src_2", type: "slack", externalId: "C1", name: "#general", status: "active" };

function sourcesList(url: string, sources: (typeof slackSource)[]) {
  return Response.json(
    sourcesPage(
      url,
      sources.map((s) => ({ ...s, scopePath: "org.eng", createdAt: "2026-10-01T00:00:00Z" })),
    ),
  );
}

/** Stubs fetch: GET /api/sources answers from `onList`, DELETE succeeds, anything else is a 404. */
function mockSources(onList: (url: string) => Response | Promise<Response>) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (isSourcesList(url) && method === "GET") return onList(url);
    if (url.startsWith("/api/sources/") && method === "DELETE")
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (url === "/api/sources" && method === "POST") {
      return new Response(JSON.stringify({ source: slackSource, jobId: "job_1" }), { status: 201 });
    }
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

async function renderPanel() {
  const { ConnectorsPanel } = await import("./connectors-panel");
  render(<ConnectorsPanel />);
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_CONNECTORS_ENABLED", "true");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("ConnectorsPanel — failed sources load", () => {
  it("says the load failed and offers a retry, never the empty state", async () => {
    mockSources(() => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
    await renderPanel();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Connectors could not be loaded.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText(EMPTY_TEXT)).toBeNull();
  });

  it("says the same for a bodyless server error", async () => {
    mockSources(() => new Response(null, { status: 500 }));
    await renderPanel();
    expect((await screen.findByRole("alert")).textContent).toContain("Connectors could not be loaded.");
  });

  it("reports a network error the same way", async () => {
    mockSources(() => {
      throw new TypeError("Failed to fetch");
    });
    await renderPanel();
    expect((await screen.findByRole("alert")).textContent).toContain("Connectors could not be loaded.");
    expect(screen.queryByText(EMPTY_TEXT)).toBeNull();
  });

  it("retry loads again and shows the sources once the server answers", async () => {
    let calls = 0;
    const fetchSpy = mockSources((url) => {
      calls += 1;
      return calls === 1 ? new Response(null, { status: 503 }) : sourcesList(url, [slackSource]);
    });
    await renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("#general")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    const listCalls = fetchSpy.mock.calls.filter(([url, init]) => isSourcesList(url) && !init?.method);
    expect(listCalls).toHaveLength(2);
  });

  it("clears previously shown rows when a later reload fails", async () => {
    let calls = 0;
    mockSources((url) => {
      calls += 1;
      return calls === 1
        ? sourcesList(url, [slackSource])
        : new Response(JSON.stringify({ error: "access revoked" }), { status: 403 });
    });
    await renderPanel();
    fireEvent.click(await screen.findByText("Disconnect"));
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect and remove" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Listing connectors needs write access to the whole organization.",
    );
    expect(screen.queryByText("#general")).toBeNull();
  });

  it("ignores a slow first load that answers after a newer one", async () => {
    let releaseFirst: (r: Response) => void = () => {};
    let calls = 0;
    mockSources((url) => {
      calls += 1;
      if (calls === 1)
        return new Promise<Response>((resolve) => {
          releaseFirst = resolve;
        });
      return sourcesList(url, [slackSource]);
    });
    await renderPanel();

    // The connect form stays usable while the first load is still in flight.
    fireEvent.click(screen.getByRole("button", { name: "+ Connect Slack" }));
    fireEvent.change(screen.getByPlaceholderText(/Channel ID/), { target: { value: "C1" } });
    fireEvent.change(screen.getByPlaceholderText(/Channel name/), { target: { value: "#general" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(calls).toBe(2));

    releaseFirst(new Response(null, { status: 500 }));
    expect(await screen.findByText("#general")).toBeTruthy();
    // Give the stale response time to land; it must not replace the newer list.
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText("#general")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("ignores a slow first list that answers after a newer one", async () => {
    let releaseFirst: (r: Response) => void = () => {};
    let calls = 0;
    mockSources((url) => {
      calls += 1;
      if (calls === 1)
        return new Promise<Response>((resolve) => {
          releaseFirst = resolve;
        });
      return sourcesList(url, [slackSource]);
    });
    await renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "+ Connect Slack" }));
    fireEvent.change(screen.getByPlaceholderText(/Channel ID/), { target: { value: "C1" } });
    fireEvent.change(screen.getByPlaceholderText(/Channel name/), { target: { value: "#general" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("#general")).toBeTruthy();

    // The stale list predates the connect; showing it would hide the new source.
    releaseFirst(sourcesList("/api/sources?page=1&kind=connector", []));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText("#general")).toBeTruthy();
    expect(screen.queryByText(EMPTY_TEXT)).toBeNull();
  });
});
