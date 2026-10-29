// @vitest-environment jsdom
//
// QA for the connect flow on screen. The change under test says every
// connect, sync and disconnect in both panels passes the panel's unmount signal; its own
// tests cover one sync per panel. These rows cover each other call site, plus the guards
// of the sync sign-in bound and the per-connector question that no test reached.
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
    externalId: id,
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

const hangs = (signal: AbortSignal | undefined) =>
  new Promise<Response>((_, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });

let tokenConfig: {
  callback: (resp: { access_token?: string }) => void;
  error_callback: (err: { type: string }) => void;
} | null = null;
function realGoogle() {
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
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_CONNECTORS_ENABLED", "true");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const card = async (name: string) => within((await screen.findByText(name)).closest("article")!);

type Row = {
  name: string;
  panel: "SourcesPanel" | "ConnectorsPanel";
  rows: ReturnType<typeof source>[];
  setup?: () => void;
  method: "POST" | "DELETE";
  start: () => Promise<void>;
};

const ROWS: Row[] = [
  {
    name: "Knowledge sources: Drive connect (mock mode)",
    panel: "SourcesPanel",
    rows: [],
    method: "POST",
    start: async () => {
      fireEvent.click(await screen.findByRole("button", { name: "+ Connect Drive folder" }));
    },
  },
  {
    name: "Knowledge sources: GitHub connect",
    panel: "SourcesPanel",
    rows: [],
    method: "POST",
    start: async () => {
      fireEvent.click(await screen.findByRole("button", { name: "+ Connect GitHub repository" }));
      await pickGitHubRepository("github_pat_secret", "acme/widgets");
      fireEvent.click(
        within(screen.getByRole("form", { name: "Connect a GitHub repository" })).getByRole("button", {
          name: "Connect",
        }),
      );
    },
  },
  {
    name: "Knowledge sources: Drive sync (mock mode)",
    panel: "SourcesPanel",
    rows: [source("d1", "gdrive", "Sales folder")],
    method: "POST",
    start: async () => {
      fireEvent.click((await card("Sales folder")).getByRole("button", { name: "Sync" }));
    },
  },
  {
    name: "Knowledge sources: Drive sync after a Google token",
    panel: "SourcesPanel",
    rows: [source("d1", "gdrive", "Sales folder")],
    method: "POST",
    setup: realGoogle,
    start: async () => {
      fireEvent.click((await card("Sales folder")).getByRole("button", { name: "Sync" }));
      await waitFor(() => expect(tokenConfig).not.toBeNull());
      await act(async () => {
        tokenConfig!.callback({ access_token: "tok" });
      });
    },
  },
  {
    name: "Knowledge sources: disconnect",
    panel: "SourcesPanel",
    rows: [source("s1", "slack", "#general")],
    method: "DELETE",
    start: async () => {
      fireEvent.click((await card("#general")).getByRole("button", { name: "Disconnect" }));
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Disconnect and remove" }));
    },
  },
  {
    name: "Connectors: Slack connect",
    panel: "ConnectorsPanel",
    rows: [],
    method: "POST",
    start: async () => {
      fireEvent.click(await screen.findByRole("button", { name: "+ Connect Slack" }));
      fireEvent.change(screen.getByPlaceholderText(/Channel ID/), { target: { value: "C123" } });
      fireEvent.change(screen.getByPlaceholderText(/Channel name/), { target: { value: "#eng" } });
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    },
  },
  {
    name: "Connectors: disconnect",
    panel: "ConnectorsPanel",
    rows: [source("s1", "slack", "#general")],
    method: "DELETE",
    start: async () => {
      fireEvent.click(await screen.findByText("Disconnect"));
      fireEvent.click(await screen.findByRole("button", { name: "Disconnect and remove" }));
    },
  },
];

describe("every connect, sync and disconnect ends with its panel", () => {
  it.each(ROWS.map((r) => [r.name, r] as const))("%s", async (_name, row) => {
    row.setup?.();
    const calls = mockFetch((call) => {
      const probe = gitHubProbeAnswer(call.url, ["acme/widgets"]);
      if (probe) return probe;
      if (call.method === row.method && !call.url.startsWith("/api/sources/github/")) return hangs(call.signal);
      if (isSourcesList(call.url) && call.method === "GET") return json(sourcesPage(call.url, row.rows));
      return json({ sources: row.rows });
    });
    const panels = row.panel === "SourcesPanel" ? await import("./sources-panel") : await import("./connectors-panel");
    const Panel = (panels as Record<string, () => React.JSX.Element>)[row.panel];
    const { unmount } = render(<Panel />);
    await row.start();
    await waitFor(() =>
      expect(calls.some((c) => c.method === row.method && !c.url.startsWith("/api/sources/github/"))).toBe(true),
    );
    const request = calls.find((c) => c.method === row.method && !c.url.startsWith("/api/sources/github/"))!;
    expect(request.signal?.aborted).toBe(false);
    unmount();
    expect(request.signal?.aborted).toBe(true);
  });
});

describe("sourceRequest and the sender's signal", () => {
  it("never sends a request whose sender is already gone", async () => {
    const calls = mockFetch((call) =>
      call.signal?.aborted ? Promise.reject(new DOMException("aborted", "AbortError")) : json({}),
    );
    const sender = new AbortController();
    sender.abort();
    await expect(
      sourceRequest("sync", "/api/sources/s1/sync", { method: "POST", signal: sender.signal }),
    ).rejects.toThrow(/Could not reach Willder/);
    expect(calls[0].signal?.aborted).toBe(true);
  });

  it("a finished request is not touched when its long-lived sender later aborts", async () => {
    const calls = mockFetch(() => json({ ok: true }));
    const sender = new AbortController();
    await sourceRequest("sync", "/api/sources/s1/sync", { method: "POST", signal: sender.signal });
    sender.abort();
    expect(calls[0].signal?.aborted).toBe(false);
  });
});

describe("the Drive sync sign-in bound", () => {
  beforeEach(realGoogle);

  it("a sign-in error after the 5-minute give-up changes nothing on screen", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const rows = [source("d1", "gdrive", "Sales folder")];
    mockFetch((call) =>
      isSourcesList(call.url) && call.method === "GET" ? json(sourcesPage(call.url, rows)) : json({ sources: rows }),
    );
    const { SourcesPanel } = await import("./sources-panel");
    render(<SourcesPanel />);
    fireEvent.click((await card("Sales folder")).getByRole("button", { name: "Sync" }));
    await waitFor(() => expect(tokenConfig).not.toBeNull());
    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    await screen.findByText(/Google did not respond within 5 minutes/);
    act(() => {
      tokenConfig!.error_callback({ type: "popup_closed" });
    });
    expect(screen.getByText(/Google did not respond within 5 minutes/)).toBeTruthy();
  });

  it("unmounting during the sign-in clears the 5-minute timer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const rows = [source("d1", "gdrive", "Sales folder")];
    mockFetch((call) =>
      isSourcesList(call.url) && call.method === "GET" ? json(sourcesPage(call.url, rows)) : json({ sources: rows }),
    );
    const { SourcesPanel } = await import("./sources-panel");
    const { unmount } = render(<SourcesPanel />);
    fireEvent.click((await card("Sales folder")).getByRole("button", { name: "Sync" }));
    await waitFor(() => expect(tokenConfig).not.toBeNull());
    const before = vi.getTimerCount();
    unmount();
    expect(vi.getTimerCount()).toBeLessThan(before);
  });
});

describe("each connector's question stays its own", () => {
  async function bothQuestions() {
    mockFetch((call) => {
      const probe = gitHubProbeAnswer(call.url, ["acme/widgets"]);
      if (probe) return probe;
      if (call.method === "POST") return json(WIDENS, 409);
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
    return form;
  }

  it("cancelling the Drive question keeps the repository's question", async () => {
    const form = await bothQuestions();
    const drive = screen.getAllByRole("alertdialog").find((q) => /these files/.test(q.textContent ?? ""))!;
    fireEvent.click(within(drive).getByRole("button", { name: "Cancel" }));
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    expect(within(form).getByRole("alertdialog").textContent).toMatch(/this repository/);
  });

  it("cancelling the repository question keeps the Drive question", async () => {
    const form = await bothQuestions();
    fireEvent.click(within(within(form).getByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(within(form).queryByRole("alertdialog")).toBeNull();
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    expect(screen.getByRole("alertdialog").textContent).toMatch(/these files/);
  });
});
