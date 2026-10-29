// @vitest-environment jsdom
//
// A person connects a repository without reading documentation: every answer to Connect
// (including a 409's question about widening who reads it) shows in the form that sent it,
// and the source just connected shows with its scope at once, even off the list's first page.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { gitHubProbeAnswer, pickGitHubRepository } from "./github-picker.testsupport";
import { isSourcesList, sourcesPage } from "./sources-test-api";

type Call = { url: string; method: string; body: Record<string, unknown> | undefined; signal?: AbortSignal };
type Row = {
  id: string;
  type: string;
  name: string;
  scopePath: string;
  status: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
  _count: { files: number };
};

const REPO = "acme/widgets";
const SCOPE = "org_acme.widgets_4d11a1";

function row(id: string, name: string, createdAt: string, extra: Partial<Row> = {}): Row {
  return {
    id,
    type: "github",
    name,
    scopePath: `org_acme.${id}`,
    status: "active",
    meta: null,
    createdAt,
    _count: { files: 0 },
    ...extra,
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

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** Opens the GitHub form in Knowledge sources, picks REPO and clicks Connect; returns the form. */
async function connectRepo(): Promise<HTMLElement> {
  const { SourcesPanel } = await import("./sources-panel");
  render(<SourcesPanel />);
  fireEvent.click(await screen.findByRole("button", { name: "+ Connect GitHub repository" }));
  await pickGitHubRepository("github_pat_secret", REPO);
  const form = screen.getByRole("form", { name: "Connect a GitHub repository" });
  fireEvent.click(within(form).getByRole("button", { name: "Connect" }));
  return form;
}

const WIDENS = {
  error: "widens",
  code: "widening_not_acknowledged",
  widening: { status: "known", people: 1, agents: 2 },
  acknowledge: { people: 1, agents: 2 },
};

describe("Connect on a repository that widens who reads it", () => {
  function widensThenConnects(listed: Row[] = []) {
    return mockFetch((call) => {
      const probe = gitHubProbeAnswer(call.url, [REPO]);
      if (probe) return probe;
      if (call.method === "POST") {
        return call.body?.acknowledgeWidening
          ? json({ source: { id: "s9", type: "github", name: REPO, scopePath: SCOPE, status: "active" } }, 201)
          : json(WIDENS, 409);
      }
      return json(sourcesPage(call.url, listed));
    });
  }

  it("asks inside the form, in place of Connect, and takes focus", async () => {
    widensThenConnects();
    const form = await connectRepo();
    const question = await within(form).findByRole("alertdialog");
    expect(question.textContent).toContain(
      "This lets 1 more person and 2 agents read this repository through Willder.",
    );
    await act(async () => {});
    expect(document.activeElement).toBe(question);
    expect(within(form).queryByRole("button", { name: "Connect" })).toBeNull();
  });

  it("drops the question when the token changes, so it never confirms a repository no longer picked", async () => {
    const calls = widensThenConnects();
    const form = await connectRepo();
    await within(form).findByRole("alertdialog");
    fireEvent.change(within(form).getByLabelText("Token"), { target: { value: "github_pat_other" } });
    expect(within(form).queryByRole("alertdialog")).toBeNull();
    expect(calls.filter((c) => c.method === "POST" && c.url === "/api/sources")).toHaveLength(1);
  });

  it("a confirm that is then refused says why in the form, with Connect back to retry", async () => {
    mockFetch((call) => {
      const probe = gitHubProbeAnswer(call.url, [REPO]);
      if (probe) return probe;
      if (call.method === "POST")
        return call.body?.acknowledgeWidening ? new Response("", { status: 503 }) : json(WIDENS, 409);
      return json(sourcesPage(call.url, []));
    });
    const form = await connectRepo();
    fireEvent.click(
      within(await within(form).findByRole("alertdialog")).getByRole("button", { name: "Confirm and connect" }),
    );
    expect((await within(form).findByRole("alert")).textContent).toMatch(/HTTP 503\)\. Try again in a minute/);
    expect(within(form).getByRole("button", { name: "Connect" })).toBeTruthy();
  });

  it("locks the token and the pick while Connect is in flight, so its answer is about what is on screen", async () => {
    let answer: (r: Response) => void = () => {};
    mockFetch((call) => {
      const probe = gitHubProbeAnswer(call.url, [REPO]);
      if (probe) return probe;
      if (call.method === "POST")
        return new Promise<Response>((resolve) => {
          answer = resolve;
        });
      return json(sourcesPage(call.url, []));
    });
    const form = await connectRepo();
    expect((within(form).getByLabelText("Token") as HTMLInputElement).disabled).toBe(true);
    expect((within(form).getByRole("radio", { name: REPO }) as HTMLInputElement).matches(":disabled")).toBe(true);
    await act(async () => answer(json(WIDENS, 409)));
    await within(form).findByRole("alertdialog");
    expect((within(form).getByLabelText("Token") as HTMLInputElement).disabled).toBe(false);
  });

  it("Enter in a field while the question is open sends nothing more", async () => {
    const calls = widensThenConnects();
    const form = await connectRepo();
    await within(form).findByRole("alertdialog");
    fireEvent.submit(form);
    expect(calls.filter((c) => c.method === "POST" && c.url === "/api/sources")).toHaveLength(1);
  });
});

describe("Connect that is refused shows why in the form, naming the fix", () => {
  // Each row: what the server (or the network) answered, and words the message must hold.
  const cases: { name: string; answer: () => Response | Promise<Response>; says: RegExp }[] = [
    {
      name: "401",
      answer: () => json({ error: "unauthorized" }, 401),
      says: /^Your session has ended, so it was not connected\. Sign in again, then try again\.$/,
    },
    // The access check's reason names user ids and actions; it is never shown, and the fix is said once.
    {
      name: "403 never quotes the access check",
      answer: () => json({ error: "user_2x9 lacks memory.write on org_acme" }, 403),
      says: /^You do not have write access to this source's scope, so it was not connected\. Ask an admin of this organization for that access\.$/,
    },
    { name: "429", answer: () => json({ error: "rate limit exceeded" }, 429), says: /Wait a minute, then try again/ },
    {
      name: "400 with the route's reason",
      answer: () => json({ error: "token is required for github" }, 400),
      says: /^token is required for github\. Fix that, then try again\.$/,
    },
    {
      name: "404 without a body",
      answer: () => new Response(null, { status: 404 }),
      says: /HTTP 404\)\. Reload the page, then try again/,
    },
    {
      name: "500 as an HTML page",
      answer: () => new Response("<!doctype html><h1>Internal Server Error</h1>", { status: 500 }),
      says: /HTTP 500\)\. Try again in a minute/,
    },
    { name: "502 empty", answer: () => new Response("", { status: 502 }), says: /HTTP 502\)\. Try again in a minute/ },
    // A 504 says nothing about whether the write happened.
    {
      name: "504",
      answer: () => new Response("", { status: 504 }),
      says: /HTTP 504\)\. The connect may have gone through\. Check the sources list before trying again\./,
    },
    {
      name: "409 widening without its counts",
      answer: () => json({ error: "widens", code: "widening_not_acknowledged" }, 409),
      says: /question did not arrive\. Reload the page, then connect again/,
    },
    // Only a 400's text is quoted; any other refusal's may be written for logs, not people.
    {
      name: "409 for another reason, not quoted",
      answer: () => json({ error: "the source moved while connecting" }, 409),
      says: /^Willder refused this \(HTTP 409\)\. Reload the page, then try again\.$/,
    },
    {
      name: "no answer at all",
      answer: () => Promise.reject(new TypeError("Failed to fetch")),
      says: /^Could not reach Willder\. The connect may have gone through\. Check the sources list/,
    },
  ];

  it.each(cases)("$name", async ({ answer, says }) => {
    mockFetch((call) => {
      const probe = gitHubProbeAnswer(call.url, [REPO]);
      if (probe) return probe;
      if (call.method === "POST") return answer();
      return json(sourcesPage(call.url, []));
    });
    const form = await connectRepo();
    const alert = await within(form).findByRole("alert");
    expect(alert.textContent).toMatch(says);
    expect(alert.textContent).not.toMatch(/user_2x9|memory\.write/);
    // The form stays open with Connect, so the person can act on the message and retry.
    expect(within(form).getByRole("button", { name: "Connect" })).toBeTruthy();
  });
});

describe("The source just connected shows with its scope at once", () => {
  // A reconnect keeps its first connect date, so in the default newest-first order it sits
  // on page 2 behind ten newer sources.
  const newer = Array.from({ length: 10 }, (_, i) => row(`n${i}`, `acme/newer-${i}`, `2026-10-1${i % 10}T00:00:00Z`));

  it("pins it under Just connected with its scope and a link to ask that scope", async () => {
    const old = row("s9", REPO, "2026-09-01T00:00:00Z", {
      scopePath: SCOPE,
      meta: { lastSyncAt: "2026-10-09T00:00:00Z", synced: 63, syncRequestedAt: "2026-10-17T07:44:00Z" },
    });
    mockFetch((call) => {
      const probe = gitHubProbeAnswer(call.url, [REPO]);
      if (probe) return probe;
      if (call.method === "POST")
        return json({ source: { id: "s9", type: "github", name: REPO, scopePath: SCOPE, status: "active" } }, 201);
      return json(sourcesPage(call.url, [...newer, old]));
    });
    await connectRepo();
    const pinned = within(await screen.findByRole("region", { name: "Just connected" }));
    expect(pinned.getByRole("heading", { name: REPO })).toBeTruthy();
    expect(pinned.getByText(SCOPE)).toBeTruthy();
    expect(pinned.getByRole("link", { name: /Ask this scope/ }).getAttribute("href")).toBe(
      `/memory?scope=${encodeURIComponent(SCOPE)}`,
    );
    // Its last result is the sync before this connect: it reads queued, never "Connected" with old counts as current.
    expect(await pinned.findByText("Sync queued")).toBeTruthy();
    expect(pinned.getByText(/^Previous sync attempt/)).toBeTruthy();
  });

  it("follows the queued sync until it finishes, then reads Connected", async () => {
    let finished = false;
    const current = () =>
      row("s9", REPO, "2026-09-01T00:00:00Z", {
        scopePath: SCOPE,
        meta: finished
          ? { lastSyncAt: "2026-10-17T07:52:00Z", synced: 63, syncRequestedAt: "2026-10-17T07:44:00Z" }
          : { syncRequestedAt: "2026-10-17T07:44:00Z" },
      });
    const calls = mockFetch((call) => {
      const probe = gitHubProbeAnswer(call.url, [REPO]);
      if (probe) return probe;
      if (call.method === "POST")
        return json({ source: { id: "s9", type: "github", name: REPO, scopePath: SCOPE, status: "active" } }, 201);
      return json(sourcesPage(call.url, [...newer, current()]));
    });
    // Time runs as usual for the steps before; the 10 s wait is skipped, not waited out.
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
    await connectRepo();
    const pinned = within(await screen.findByRole("region", { name: "Just connected" }));
    expect(await pinned.findByText("Sync queued")).toBeTruthy();
    expect(pinned.getByText("No earlier sync result")).toBeTruthy();
    const reads = () => calls.filter((c) => c.method === "GET" && c.url.includes("at=s9")).length;
    const before = reads();

    finished = true;
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(await pinned.findByText("Connected")).toBeTruthy();
    expect(reads()).toBe(before + 1);
  });

  it("keeps following after a status read fails, and says nothing went wrong only once one succeeds", async () => {
    let atReads = 0;
    const finished = row("s9", REPO, "2026-09-01T00:00:00Z", {
      scopePath: SCOPE,
      meta: { lastSyncAt: "2026-10-17T07:52:00Z", synced: 63, syncRequestedAt: "2026-10-17T07:44:00Z" },
    });
    const queued = row("s9", REPO, "2026-09-01T00:00:00Z", {
      scopePath: SCOPE,
      meta: { syncRequestedAt: "2026-10-17T07:44:00Z" },
    });
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
    mockFetch((call) => {
      const probe = gitHubProbeAnswer(call.url, [REPO]);
      if (probe) return probe;
      if (call.method === "POST")
        return json({ source: { id: "s9", type: "github", name: REPO, scopePath: SCOPE, status: "active" } }, 201);
      if (call.url.includes("at=s9")) {
        atReads += 1;
        if (atReads === 2) return new Response("", { status: 500 });
        return json(sourcesPage(call.url, [...newer, atReads === 1 ? queued : finished]));
      }
      return json(sourcesPage(call.url, newer));
    });
    await connectRepo();
    const pinned = within(await screen.findByRole("region", { name: "Just connected" }));
    expect(await pinned.findByText("Sync queued")).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect((await pinned.findByRole("alert")).textContent).toMatch(/HTTP 500\)\. Use Refresh status to try again/);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(await pinned.findByText("Connected")).toBeTruthy();
    expect(pinned.queryByRole("alert")).toBeNull();
  });

  it("says why its status cannot be read when the list is not this person's to read", async () => {
    mockFetch((call) => {
      const probe = gitHubProbeAnswer(call.url, [REPO]);
      if (probe) return probe;
      if (call.method === "POST")
        return json({ source: { id: "s9", type: "github", name: REPO, scopePath: SCOPE, status: "active" } }, 201);
      if (call.url.includes("at=s9")) return json({ error: "no grant" }, 403);
      return json(sourcesPage(call.url, newer));
    });
    await connectRepo();
    const pinned = within(await screen.findByRole("region", { name: "Just connected" }));
    expect((await pinned.findByRole("alert")).textContent).toMatch(
      /needs write access to the whole organization\. You can still ask its scope below/,
    );
    expect(pinned.getByText(SCOPE)).toBeTruthy();
    expect(pinned.queryByText("Reading its sync status…")).toBeNull();
  });

  it("shows the connect's own answer before the row is read, so the scope is never missing", async () => {
    mockFetch((call) => {
      const probe = gitHubProbeAnswer(call.url, [REPO]);
      if (probe) return probe;
      if (call.method === "POST")
        return json({ source: { id: "s9", type: "github", name: REPO, scopePath: SCOPE, status: "active" } }, 201);
      // The by-id read never answers.
      if (isSourcesList(call.url) && call.url.includes("at=s9")) return new Promise<Response>(() => {});
      return json(sourcesPage(call.url, newer));
    });
    await connectRepo();
    const pinned = within(await screen.findByRole("region", { name: "Just connected" }));
    expect(pinned.getByText(SCOPE)).toBeTruthy();
    expect(pinned.getByText("Reading its sync status…")).toBeTruthy();
  });
});

// A request that never answers, closing the form while one is in flight, and where focus
// goes when a sync's answer arrives.
describe("A request that never answers, or that the person walks away from", () => {
  it("stops waiting after 45 seconds and says the connect may have gone through", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
    mockFetch((call) => {
      const probe = gitHubProbeAnswer(call.url, [REPO]);
      if (probe) return probe;
      if (call.method === "POST") {
        // Never answers; rejects only when the panel gives up, as fetch does on abort.
        return new Promise<Response>((_, reject) => {
          call.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }
      return json(sourcesPage(call.url, []));
    });
    const form = await connectRepo();
    await act(() => vi.advanceTimersByTimeAsync(45_000));
    expect((await within(form).findByRole("alert")).textContent).toMatch(
      /^Willder did not answer within 45 seconds\. The connect may have gone through\./,
    );
    expect((within(form).getByLabelText("Token") as HTMLInputElement).disabled).toBe(false);
  });

  it("closing the form mid-connect ends its wait, so a reopened form takes a token, and a late success still pins", async () => {
    let answer: (r: Response) => void = () => {};
    mockFetch((call) => {
      const probe = gitHubProbeAnswer(call.url, [REPO]);
      if (probe) return probe;
      if (call.method === "POST")
        return new Promise<Response>((resolve) => {
          answer = resolve;
        });
      return json(sourcesPage(call.url, []));
    });
    const form = await connectRepo();
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Connect GitHub repository" }));
    const reopened = screen.getByRole("form", { name: "Connect a GitHub repository" });
    expect((within(reopened).getByLabelText("Token") as HTMLInputElement).disabled).toBe(false);
    await act(async () =>
      answer(json({ source: { id: "s9", type: "github", name: REPO, scopePath: SCOPE, status: "active" } }, 201)),
    );
    expect(await screen.findByRole("region", { name: "Just connected" })).toBeTruthy();
    // The reopened form is the person's; the late answer does not close it.
    expect(screen.getByRole("form", { name: "Connect a GitHub repository" })).toBe(reopened);
  });

  it("a refused sync says why without the access check's text, and takes focus", async () => {
    mockFetch((call) => {
      if (call.method === "POST") return json({ error: "user_2x9 lacks memory.write on org_acme" }, 403);
      return json(sourcesPage(call.url, [row("s1", REPO, "2026-10-01T00:00:00Z")]));
    });
    const { SourcesPanel } = await import("./sources-panel");
    render(<SourcesPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Sync" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "You do not have write access to this source's scope, so no sync was requested. Ask an admin of this organization for that access.",
    );
    await act(async () => {});
    expect(document.activeElement).toBe(alert.closest("[tabindex]"));
  });
});

// The same failure classes in the other async actions of both panels.
describe("Every async action keeps focus, ends, and keeps raw text off the screen", () => {
  /** A fetch that never answers on its own and rejects on abort, as the browser's does. */
  const hangs = (init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });

  it("a late success from a form the person closed does not take focus from the reopened one", async () => {
    let answer: (r: Response) => void = () => {};
    mockFetch((call) => {
      const probe = gitHubProbeAnswer(call.url, [REPO]);
      if (probe) return probe;
      if (call.method === "POST")
        return new Promise<Response>((resolve) => {
          answer = resolve;
        });
      return json(sourcesPage(call.url, []));
    });
    const form = await connectRepo();
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Connect GitHub repository" }));
    const token = screen.getByLabelText("Token");
    token.focus();
    await act(async () =>
      answer(json({ source: { id: "s9", type: "github", name: REPO, scopePath: SCOPE, status: "active" } }, 201)),
    );
    await screen.findByRole("region", { name: "Just connected" });
    // The card's focus effect runs after the render that shows it; let it run before reading.
    await act(async () => {});
    expect(document.activeElement).toBe(token);
  });

  it("Cancel on a Drive question gives focus to the Drive button", async () => {
    mockFetch((call) => (call.method === "POST" ? json(WIDENS, 409) : json(sourcesPage(call.url, []))));
    const { SourcesPanel } = await import("./sources-panel");
    render(<SourcesPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "+ Connect Drive folder" }));
    // Cancel as a person does: after the question's focus effect has run. Clicked before it, the
    // effect would run first on the next render and leave focus on the page.
    const question = await screen.findByRole("alertdialog");
    await act(async () => {});
    expect(document.activeElement).toBe(question);
    fireEvent.click(within(question).getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "+ Connect Drive folder" }));
  });

  it("a repository lookup and a records check both give up after 45 seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => hangs(init)),
    );
    const { GitHubConnectForm } = await import("./github-connect-form");
    const { RemainingRecords } = await import("./remaining-records");
    render(
      <>
        <GitHubConnectForm busy={false} onConnect={() => {}} onCancel={() => {}} />
        <RemainingRecords sourceId="s1" removing={false} onRemoveAgain={async () => {}} />
      </>,
    );
    fireEvent.change(screen.getByLabelText("Token"), { target: { value: "github_pat_x" } });
    fireEvent.click(screen.getByRole("button", { name: "Find repositories" }));
    fireEvent.click(screen.getByRole("button", { name: "Check what's left in memory" }));
    await act(() => vi.advanceTimersByTimeAsync(45_000));
    expect(screen.getByRole("alert").textContent).toMatch(/Try again/);
    expect(screen.getByText(/The check did not answer within 45 seconds\. Try again\./)).toBeTruthy();
  });

  it("a records check that fails never shows the memory service's text", async () => {
    mockFetch(() => json({ error: "Could not count records. memory service failed: Traceback group org_2abc" }, 502));
    const { RemainingRecords } = await import("./remaining-records");
    render(<RemainingRecords sourceId="s1" removing={false} onRemoveAgain={async () => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Check what's left in memory" }));
    expect(
      await screen.findByText("Could not check this source's records (HTTP 502). Try again in a minute."),
    ).toBeTruthy();
    expect(screen.queryByText(/Traceback/)).toBeNull();
  });
});
