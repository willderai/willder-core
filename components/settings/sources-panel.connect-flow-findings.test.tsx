// @vitest-environment jsdom
//
// The connect flow on screen. Three defects a review
// found and left for later:
// - Knowledge sources kept one widening question for Drive and GitHub, so starting
//   one connect dropped the other's unanswered question.
// - A connect, sync or disconnect request was not cancelled when its panel unmounted,
//   so a hung one kept its 45-second timer and set state on a panel that was gone.
// - A real Drive sync's Google sign-in had no bound, so a sign-in Google never answered
//   left every Sync button disabled for good.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { gitHubProbeAnswer, pickGitHubRepository } from "./github-picker.testsupport";
import { sourceRequest } from "./source-requests";
import { isSourcesList, sourcesPage } from "./sources-test-api";

type Call = { url: string; method: string; body: Record<string, unknown> | undefined; signal: AbortSignal | undefined };

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const WIDENS = {
  error: "widens",
  code: "widening_not_acknowledged",
  widening: { status: "known", people: 1, agents: 2 },
  acknowledge: { people: 1, agents: 2 },
};

function source(id: string, type: string, name: string) {
  return {
    id,
    type,
    name,
    scopePath: `org_acme.${id}`,
    status: "active",
    meta: null,
    createdAt: "2026-10-01T00:00:00Z",
    _count: { files: 0 },
  };
}

function mockFetch(answer: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const call = {
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        signal: init?.signal ?? undefined,
      };
      calls.push(call);
      return answer(call);
    }),
  );
  return calls;
}

/** A request that never answers, and rejects once its signal aborts, as fetch does. */
const hangs = (signal: AbortSignal | undefined) =>
  new Promise<Response>((_, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("each connector keeps its own widening question", () => {
  it("starting a GitHub connect leaves the Drive question on screen, and both can be answered", async () => {
    const calls = mockFetch((call) => {
      const probe = gitHubProbeAnswer(call.url, ["acme/widgets"]);
      if (probe) return probe;
      if (call.method === "POST") {
        if (!call.body?.acknowledgeWidening) return json(WIDENS, 409);
        const name = call.body.type === "github" ? "acme/widgets" : "Mock Sales Collateral";
        return json(
          {
            source: {
              id: `s-${call.body.type}`,
              type: call.body.type,
              name,
              scopePath: "org_acme.x",
              status: "active",
            },
          },
          201,
        );
      }
      return json(sourcesPage(call.url, []));
    });
    const { SourcesPanel } = await import("./sources-panel");
    render(<SourcesPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "+ Connect Drive folder" }));
    await screen.findByRole("alertdialog");

    fireEvent.click(screen.getByRole("button", { name: "+ Connect GitHub repository" }));
    await pickGitHubRepository("github_pat_secret", "acme/widgets");
    const form = screen.getByRole("form", { name: "Connect a GitHub repository" });
    fireEvent.click(within(form).getByRole("button", { name: "Connect" }));
    await within(form).findByRole("alertdialog");

    const questions = screen.getAllByRole("alertdialog");
    expect(questions).toHaveLength(2);
    expect(questions.some((q) => /these files/.test(q.textContent ?? ""))).toBe(true);
    expect(questions.some((q) => /this repository/.test(q.textContent ?? ""))).toBe(true);

    // Confirming the Drive question sends Drive's request, not the repository's.
    const drive = questions.find((q) => /these files/.test(q.textContent ?? ""))!;
    fireEvent.click(within(drive).getByRole("button", { name: /Confirm/ }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.body?.type === "gdrive" && c.body.acknowledgeWidening)).toBe(
        true,
      ),
    );
    expect(calls.some((c) => c.method === "POST" && c.body?.type === "github" && c.body.acknowledgeWidening)).toBe(
      false,
    );
    // The repository's question is still waiting in its form.
    await waitFor(() => expect(screen.getAllByRole("alertdialog")).toHaveLength(1));
    expect(within(form).getByRole("alertdialog").textContent).toMatch(/this repository/);
  });
});

describe("a request ends with the panel that sent it", () => {
  it("sourceRequest cancels the request when the sender's signal aborts, and its timer with it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const calls = mockFetch((call) => hangs(call.signal));
    const sender = new AbortController();
    const request = sourceRequest("sync", "/api/sources/s1/sync", { method: "POST", signal: sender.signal });
    const settled = expect(request).rejects.toThrow(/Could not reach Willder/);
    expect(vi.getTimerCount()).toBe(1);
    sender.abort();
    await settled;
    expect(calls[0].signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a timeout still says it timed out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mockFetch((call) => hangs(call.signal));
    const request = sourceRequest("sync", "/api/sources/s1/sync", {
      method: "POST",
      signal: new AbortController().signal,
    });
    const settled = expect(request).rejects.toThrow(/did not answer within 45 seconds/);
    vi.advanceTimersByTime(45_000);
    await settled;
  });

  it.each([
    ["Knowledge sources", "./sources-panel", "SourcesPanel"],
    ["Connectors", "./connectors-panel", "ConnectorsPanel"],
  ] as const)("%s cancels a sync still in flight when it unmounts", async (_name, path, exported) => {
    vi.stubEnv("NEXT_PUBLIC_CONNECTORS_ENABLED", "true");
    const rows = [source("s1", "slack", "#general")];
    const calls = mockFetch((call) =>
      isSourcesList(call.url) && call.method === "GET"
        ? json(sourcesPage(call.url, rows))
        : call.method === "POST"
          ? hangs(call.signal)
          : json({ sources: rows }),
    );
    const Panel = (await import(path))[exported] as () => React.JSX.Element;
    const { unmount } = render(<Panel />);
    await screen.findByText("#general");
    fireEvent.click(screen.getByRole("button", { name: "Sync" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const sync = calls.find((c) => c.method === "POST")!;
    expect(sync.signal?.aborted).toBe(false);
    unmount();
    expect(sync.signal?.aborted).toBe(true);
  });
});

describe("a real Drive sync's Google sign-in is bounded", () => {
  let tokenConfig: { callback: (resp: { access_token?: string }) => void } | null;

  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_GDRIVE_MOCK", "false");
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_CLIENT_ID", "123456789012-test.apps.googleusercontent.com");
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_API_KEY", "test-api-key");
    tokenConfig = null;
    vi.stubGlobal("google", {
      accounts: {
        oauth2: {
          initTokenClient: (config: typeof tokenConfig) => {
            tokenConfig = config;
            return { requestAccessToken: () => {} };
          },
        },
      },
    });
    vi.stubGlobal("gapi", { load: () => {} });
  });

  it("gives up after 5 minutes, frees the Sync buttons, and ignores a token that arrives later", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const rows = [source("d1", "gdrive", "Sales folder"), source("s1", "slack", "#general")];
    const calls = mockFetch((call) =>
      isSourcesList(call.url) && call.method === "GET" ? json(sourcesPage(call.url, rows)) : json({ sources: rows }),
    );
    const { SourcesPanel } = await import("./sources-panel");
    render(<SourcesPanel />);
    const card = (await screen.findByText("Sales folder")).closest("article")!;
    fireEvent.click(within(card).getByRole("button", { name: "Sync" }));
    await waitFor(() => expect(tokenConfig).not.toBeNull());
    for (const button of screen.getAllByRole("button", { name: /^(Sync|Requesting…)$/ }))
      expect((button as HTMLButtonElement).disabled).toBe(true);

    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(await screen.findByText(/Google did not respond within 5 minutes, so no sync was requested/)).toBeTruthy();
    for (const button of screen.getAllByRole("button", { name: "Sync" }))
      expect((button as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      tokenConfig!.callback({ access_token: "late" });
    });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("a token that arrives in time sends the sync and stops the timer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const rows = [source("d1", "gdrive", "Sales folder")];
    const calls = mockFetch((call) =>
      isSourcesList(call.url) && call.method === "GET" ? json(sourcesPage(call.url, rows)) : json({ sources: rows }),
    );
    const { SourcesPanel } = await import("./sources-panel");
    render(<SourcesPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Sync" }));
    await waitFor(() => expect(tokenConfig).not.toBeNull());
    await act(async () => {
      tokenConfig!.callback({ access_token: "tok-1" });
    });
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.body?.token === "tok-1")).toBe(true));
    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(screen.queryByText(/Google did not respond within 5 minutes/)).toBeNull();
  });
});
