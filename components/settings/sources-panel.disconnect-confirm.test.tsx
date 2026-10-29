// @vitest-environment jsdom
//
// Item connector-control-ui-20261014: Disconnect used to delete a source's memory
// on one click, with nothing saying what went. It now asks first, says what is
// removed and kept, reports the counts the server removed, and lets a person check
// a disconnected source's leftovers and remove them.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { gitHubProbeAnswer, pickGitHubRepository } from "./github-picker.testsupport";
import { isSourcesList, sourcesPage } from "./sources-test-api";

type Call = { url: string; method: string; body: unknown };

function source(type: string, id: string, name: string, status = "active") {
  return {
    id,
    type,
    name,
    scopePath: `org.${id}`,
    status,
    meta: null,
    createdAt: "2026-10-01T00:00:00Z",
    _count: { files: 1 },
  };
}

/** A fetch that records every call and answers from `answer`. */
function mockFetch(answer: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const call = { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      return answer(call);
    }),
  );
  return calls;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

/** The paged sources list over `rows` for a GET of it, and `{ sources: rows }` for any other call. */
const sources = (call: Call, rows: ReturnType<typeof source>[]) =>
  isSourcesList(call.url) && call.method === "GET" ? json(sourcesPage(call.url, rows)) : json({ sources: rows });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function renderPanel() {
  const { SourcesPanel } = await import("./sources-panel");
  render(<SourcesPanel />);
}

const card = async (name: string) => within((await screen.findByRole("heading", { name })).closest("article")!);

describe("SourcesPanel: disconnect asks first", () => {
  it("says what is removed and kept for this source's kind, and Cancel sends nothing", async () => {
    const calls = mockFetch((call) => sources(call, [source("github", "s1", "acme/widgets")]));
    await renderPanel();
    fireEvent.click(await (await card("acme/widgets")).findByRole("button", { name: "Disconnect" }));

    const dialog = screen.getByRole("dialog", { name: "Disconnect acme/widgets?" });
    expect(within(dialog).getByText(/Every fact and passage this source added/)).toBeTruthy();
    expect(within(dialog).getByText("The token Willder stored for it.")).toBeTruthy();
    expect(within(dialog).getByText(/The token still works at GitHub/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("deletes the source the dialog named, then reports what the server removed", async () => {
    let disconnected = false;
    const calls = mockFetch((call) => {
      if (call.method === "DELETE") {
        disconnected = true;
        return json({ disconnected: "s2", retiredFacts: 12, retiredChunks: 40 });
      }
      return sources(call, [
        source("gdrive", "s1", "Sales"),
        source("slack", "s2", "#general", disconnected ? "disconnected" : "active"),
      ]);
    });
    await renderPanel();
    fireEvent.click(await (await card("#general")).findByRole("button", { name: "Disconnect" }));
    const dialog = screen.getByRole("dialog", { name: "Disconnect #general?" });
    expect(within(dialog).getByText(/The token still works at Slack/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect and remove" }));

    expect(
      await screen.findByText("#general disconnected. Removed 12 facts and 40 passages from memory."),
    ).toBeTruthy();
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual(["/api/sources/s2"]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("states the Drive case: no token to delete, and access ends at Google", async () => {
    mockFetch((call) => sources(call, [source("gdrive", "s1", "Sales")]));
    await renderPanel();
    fireEvent.click(await (await card("Sales")).findByRole("button", { name: "Disconnect" }));
    const dialog = screen.getByRole("dialog", { name: "Disconnect Sales?" });
    expect(within(dialog).getByText(/holds no Google token/)).toBeTruthy();
    expect(within(dialog).getByText(/Third-party apps and services/)).toBeTruthy();
  });
});

describe("SourcesPanel: what each source keeps", () => {
  it("prints the kind's what-we-store line on its card", async () => {
    mockFetch((call) =>
      sources(call, [source("github", "s1", "acme/widgets"), source("posthog", "s2", "Weekly signups")]),
    );
    await renderPanel();
    expect(
      await (await card("acme/widgets")).findByText(/Never stores source files, diffs or inline review comments/),
    ).toBeTruthy();
    expect((await card("Weekly signups")).getByText(/Never raw events/)).toBeTruthy();
  });
});

describe("SourcesPanel: connecting GitHub", () => {
  it("posts the repository and token from the Knowledge sources panel and closes the form", async () => {
    const calls = mockFetch((call) => {
      const probe = gitHubProbeAnswer(call.url, ["acme/widgets"]);
      if (probe) return probe;
      if (call.method === "POST") return json({ source: { id: "s9" } }, 201);
      return sources(call, []);
    });
    await renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "+ Connect GitHub repository" }));
    await pickGitHubRepository("github_pat_secret", "acme/widgets");
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(
      await screen.findByText(
        "acme/widgets connected. Its card under Just connected shows its scope and its sync status.",
      ),
    ).toBeTruthy();
    expect(calls.find((c) => c.method === "POST" && c.url === "/api/sources")).toEqual({
      url: "/api/sources",
      method: "POST",
      body: { type: "github", repo: "acme/widgets", token: "github_pat_secret" },
    });
    expect(screen.queryByLabelText("Token")).toBeNull();
  });

  it("asks about a widening in the repository's words, then resends with the acknowledgement", async () => {
    const calls = mockFetch((call) => {
      const probe = gitHubProbeAnswer(call.url, ["acme/widgets"]);
      if (probe) return probe;
      if (call.method === "POST" && !(call.body as Record<string, unknown>).acknowledgeWidening) {
        return json(
          {
            error: "widens",
            code: "widening_not_acknowledged",
            widening: { status: "unknown", atMost: 4, agents: 0 },
            acknowledge: { people: "unknown", agents: 0 },
          },
          409,
        );
      }
      if (call.method === "POST") return json({ source: { id: "s9" } }, 201);
      return sources(call, []);
    });
    await renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "+ Connect GitHub repository" }));
    await pickGitHubRepository("github_pat_secret", "acme/widgets");
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    const question = await screen.findByRole("alertdialog");
    expect(question.textContent).toMatch(/who can read this repository at the source/);
    fireEvent.click(within(question).getByRole("button", { name: "Confirm and connect" }));
    await screen.findByText(
      "acme/widgets connected. Its card under Just connected shows its scope and its sync status.",
    );
    expect(calls.filter((c) => c.method === "POST" && c.url === "/api/sources").at(-1)!.body).toEqual({
      type: "github",
      repo: "acme/widgets",
      token: "github_pat_secret",
      acknowledgeWidening: { people: "unknown", agents: 0 },
    });
  });
});

describe("SourcesPanel: what a disconnected source left", () => {
  it("reads the counts only when asked, and removes what is left on request", async () => {
    let left = true;
    const calls = mockFetch((call) => {
      if (call.url === "/api/sources/s1/records") {
        return json({
          sourceId: "s1",
          status: "disconnected",
          scopes: [
            {
              scopePath: "org.s1",
              chunks: left ? 3 : 0,
              syncRecords: 0,
              feedSummaries: 0,
              episodes: 0,
              facts: left ? 2 : 0,
              verbatimNodes: 0,
              danglingFacts: 0,
              orphans: 1,
            },
          ],
        });
      }
      if (call.method === "DELETE") {
        left = false;
        return json({ disconnected: "s1", retiredFacts: 2, retiredChunks: 3 });
      }
      return sources(call, [source("slack", "s1", "#general", "disconnected")]);
    });
    await renderPanel();
    const general = await card("#general");
    await general.findByRole("button", { name: "Check what's left in memory" });
    expect(calls.some((c) => c.url.endsWith("/records"))).toBe(false);
    expect(general.queryByRole("button", { name: "Disconnect" })).toBeNull();

    fireEvent.click(general.getByRole("button", { name: "Check what's left in memory" }));
    expect(await general.findByText("Still in memory: 2 facts, 3 passages.")).toBeTruthy();
    fireEvent.click(general.getByRole("button", { name: "Remove what's left" }));

    expect(await general.findByText("Nothing this source synced is left in memory.")).toBeTruthy();
    expect(general.queryByRole("button", { name: "Remove what's left" })).toBeNull();
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual(["/api/sources/s1"]);
  });

  it("says why it cannot check instead of a count, without quoting the access check", async () => {
    mockFetch((call) =>
      call.url.endsWith("/records")
        ? json({ error: "access denied: this source still holds records in a scope you have no grant on" }, 403)
        : sources(call, [source("github", "s1", "acme/widgets", "disconnected")]),
    );
    await renderPanel();
    fireEvent.click(await (await card("acme/widgets")).findByRole("button", { name: "Check what's left in memory" }));
    expect(
      await screen.findByText(
        "Checking needs read access to every scope this source wrote to. Ask an admin of this organization for that access.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/no grant on/)).toBeNull();
    expect(screen.queryByText(/Still in memory|Nothing this source/)).toBeNull();
  });
});
