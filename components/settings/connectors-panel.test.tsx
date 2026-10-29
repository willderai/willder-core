// @vitest-environment jsdom
//
// The panel must target the real /api/sources contract, not an invented
// app/api/connectors/** surface. Covers (a) the flag gate — the panel must
// stay hidden unless explicitly enabled — and (b) the connect/sync/disconnect
// flow driven against the real endpoint shapes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { isSourcesList, sourcesPage } from "./sources-test-api";
import { gitHubProbeAnswer, pickGitHubRepository } from "./github-picker.testsupport";

type FetchCall = { url: string; method: string; body: unknown };

function mockFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const call: FetchCall = {
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    return handler(call);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("ConnectorsPanel — flag gate", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_CONNECTORS_ENABLED", "");
  });

  it("renders nothing, and never calls the API, when the flag is unset (production default)", async () => {
    const fetchSpy = mockFetch(() => {
      throw new Error("must not fetch while the panel is hidden");
    });
    const { ConnectorsPanel } = await import("./connectors-panel");
    const { container } = render(<ConnectorsPanel />);
    expect(container.firstChild).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("ConnectorsPanel — real /api/sources contract", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_CONNECTORS_ENABLED", "true");
  });

  function sourcesList(url: string, sources: unknown[]) {
    return Response.json(sourcesPage(url, sources as Parameters<typeof sourcesPage>[1]));
  }

  it("lists only slack/figma sources, ignoring gdrive/website", async () => {
    mockFetch((call) => {
      if (isSourcesList(call.url) && call.method === "GET") {
        return sourcesList(call.url, [
          { id: "src_1", type: "gdrive", externalId: "f1", name: "Sales Drive", status: "active" },
          { id: "src_2", type: "slack", externalId: "C1", name: "#general", status: "active" },
        ]);
      }
      throw new Error(`unexpected fetch: ${call.method} ${call.url}`);
    });
    const { ConnectorsPanel } = await import("./connectors-panel");
    render(<ConnectorsPanel />);
    await waitFor(() => expect(screen.getByText("#general")).toBeTruthy());
    expect(screen.queryByText("Sales Drive")).toBeNull();
  });

  it("connecting a Slack channel POSTs the real /api/sources body shape and reloads", async () => {
    let connected: Record<string, unknown> | null = null;
    mockFetch((call) => {
      if (isSourcesList(call.url) && call.method === "GET") {
        return sourcesList(call.url, connected ? [connected] : []);
      }
      if (call.url === "/api/sources" && call.method === "POST") {
        expect(call.body).toEqual({ type: "slack", channelId: "C123", channelName: "#eng" });
        connected = { id: "src_9", type: "slack", externalId: "C123", name: "#eng", status: "active" };
        return new Response(JSON.stringify({ source: connected, jobId: "job_1" }), { status: 201 });
      }
      throw new Error(`unexpected fetch: ${call.method} ${call.url}`);
    });
    const { ConnectorsPanel } = await import("./connectors-panel");
    render(<ConnectorsPanel />);
    await waitFor(() => expect(screen.getByText(/No Slack, Figma, PostHog or GitHub sources/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "+ Connect Slack" }));
    fireEvent.change(screen.getByPlaceholderText(/Channel ID/), { target: { value: "C123" } });
    fireEvent.change(screen.getByPlaceholderText(/Channel name/), { target: { value: "#eng" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(screen.getByText("#eng")).toBeTruthy());
  });

  it("connecting a PostHog insight POSTs the real body shape, sends the key as a password field, and reloads", async () => {
    let connected: Record<string, unknown> | null = null;
    mockFetch((call) => {
      if (isSourcesList(call.url) && call.method === "GET") {
        return sourcesList(call.url, connected ? [connected] : []);
      }
      if (call.url === "/api/sources" && call.method === "POST") {
        expect(call.body).toEqual({
          type: "posthog",
          projectId: "123",
          insightId: "456",
          insightName: "Weekly signups",
          apiKey: "phx_secret",
        });
        connected = { id: "src_ph", type: "posthog", externalId: "456", name: "Weekly signups", status: "active" };
        return new Response(JSON.stringify({ source: connected, jobId: "job_1" }), { status: 201 });
      }
      throw new Error(`unexpected fetch: ${call.method} ${call.url}`);
    });
    const { ConnectorsPanel } = await import("./connectors-panel");
    render(<ConnectorsPanel />);
    await waitFor(() => expect(screen.getByText(/No Slack, Figma, PostHog or GitHub sources/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "+ Connect PostHog" }));
    fireEvent.change(screen.getByPlaceholderText(/Project ID/), { target: { value: "123" } });
    fireEvent.change(screen.getByPlaceholderText(/Insight ID/), { target: { value: "456" } });
    fireEvent.change(screen.getByPlaceholderText(/A name for this insight/), { target: { value: "Weekly signups" } });
    const keyInput = screen.getByPlaceholderText(/Personal API key/);
    expect(keyInput.getAttribute("type")).toBe("password");
    fireEvent.change(keyInput, { target: { value: "phx_secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(screen.getByText("Weekly signups")).toBeTruthy());
  });

  it("connecting a GitHub repository POSTs { type, repo, token }, sends the token as a password field, and reloads", async () => {
    let connected: Record<string, unknown> | null = null;
    mockFetch((call) => {
      const probe = gitHubProbeAnswer(call.url, ["acme/widgets"]);
      if (probe) return probe;
      if (isSourcesList(call.url) && call.method === "GET") {
        return sourcesList(call.url, connected ? [connected] : []);
      }
      if (call.url === "/api/sources" && call.method === "POST") {
        expect(call.body).toEqual({ type: "github", repo: "acme/widgets", token: "github_pat_secret" });
        connected = {
          id: "src_gh",
          type: "github",
          externalId: "acme/widgets",
          name: "acme/widgets",
          status: "active",
        };
        return new Response(JSON.stringify({ source: connected, jobId: "job_1" }), { status: 201 });
      }
      throw new Error(`unexpected fetch: ${call.method} ${call.url}`);
    });
    const { ConnectorsPanel } = await import("./connectors-panel");
    render(<ConnectorsPanel />);
    await waitFor(() => expect(screen.getByText(/No Slack, Figma, PostHog or GitHub sources/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "+ Connect GitHub" }));
    expect(screen.getByLabelText("Token").getAttribute("type")).toBe("password");
    await pickGitHubRepository("github_pat_secret", "acme/widgets");
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(screen.getByText("acme/widgets")).toBeTruthy());
  });

  it("the Connect button for GitHub stays disabled until a repository the token lists is picked", async () => {
    mockFetch((call) => {
      const probe = gitHubProbeAnswer(call.url, ["acme/widgets"]);
      if (probe) return probe;
      if (isSourcesList(call.url) && call.method === "GET") return sourcesList(call.url, []);
      throw new Error(`unexpected fetch: ${call.method} ${call.url}`);
    });
    const { ConnectorsPanel } = await import("./connectors-panel");
    render(<ConnectorsPanel />);
    await waitFor(() => expect(screen.getByText(/No Slack, Figma, PostHog or GitHub sources/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "+ Connect GitHub" }));
    const connect = screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Token"), { target: { value: "github_pat_secret" } });
    expect(connect.disabled).toBe(true);
    await pickGitHubRepository("github_pat_secret", "acme/widgets");
    expect(connect.disabled).toBe(false);
  });

  it("the Connect button for PostHog stays disabled until all four fields are filled", async () => {
    mockFetch((call) => {
      if (isSourcesList(call.url) && call.method === "GET") return sourcesList(call.url, []);
      throw new Error(`unexpected fetch: ${call.method} ${call.url}`);
    });
    const { ConnectorsPanel } = await import("./connectors-panel");
    render(<ConnectorsPanel />);
    await waitFor(() => expect(screen.getByText(/No Slack, Figma, PostHog or GitHub sources/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "+ Connect PostHog" }));
    const connectButton = screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement;
    expect(connectButton.disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText(/Project ID/), { target: { value: "123" } });
    fireEvent.change(screen.getByPlaceholderText(/Insight ID/), { target: { value: "456" } });
    fireEvent.change(screen.getByPlaceholderText(/A name for this insight/), { target: { value: "Weekly signups" } });
    expect(connectButton.disabled).toBe(true); // apiKey still empty

    fireEvent.change(screen.getByPlaceholderText(/Personal API key/), { target: { value: "phx_secret" } });
    expect(connectButton.disabled).toBe(false);
  });

  it("sync and disconnect call the real per-source /api/sources/:id endpoints", async () => {
    const source = { id: "src_5", type: "figma", externalId: "F1", name: "Design System", status: "active" };
    let holdReload = false;
    let releaseReload: (() => void) | undefined;
    let disconnected = false;
    const fetchSpy = mockFetch((call) => {
      if (isSourcesList(call.url) && call.method === "GET") {
        const answer = () => sourcesList(call.url, [{ ...source, status: disconnected ? "disconnected" : "active" }]);
        if (holdReload)
          return new Promise<Response>((resolve) => {
            releaseReload = () => resolve(answer());
          });
        return answer();
      }
      if (call.url === "/api/sources/src_5/sync" && call.method === "POST") {
        holdReload = true;
        return new Response(JSON.stringify({ jobId: "job_2" }), { status: 202 });
      }
      if (call.url === "/api/sources/src_5" && call.method === "DELETE") {
        disconnected = true;
        return new Response(JSON.stringify({ disconnected: "src_5" }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${call.method} ${call.url}`);
    });
    const writes = (method: string) => fetchSpy.mock.calls.filter(([, init]) => init?.method === method);
    const { ConnectorsPanel } = await import("./connectors-panel");
    render(<ConnectorsPanel />);
    await screen.findByText("Design System");

    fireEvent.click(screen.getByRole("button", { name: "Sync" }));
    await waitFor(() => expect(releaseReload).toBeDefined());
    expect(writes("POST")).toEqual([["/api/sources/src_5/sync", expect.objectContaining({ method: "POST" })]]);
    const disconnect = screen.getByRole("button", { name: "Disconnect" });
    expect(screen.getByText("Design System")).toBeTruthy();
    expect(disconnect.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(disconnect);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(writes("DELETE")).toHaveLength(0);

    holdReload = false;
    await act(async () => releaseReload?.());
    await waitFor(() => expect(disconnect.getAttribute("aria-disabled")).toBe("false"));
    fireEvent.click(disconnect);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect and remove" }));
    await waitFor(() =>
      expect(writes("DELETE")).toEqual([["/api/sources/src_5", expect.objectContaining({ method: "DELETE" })]]),
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull());
    expect(writes("POST")).toHaveLength(1);
  });
});

describe("ConnectorsPanel — a connect that widens who reads the source", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_CONNECTORS_ENABLED", "true");
  });

  async function startSlackConnect() {
    const posts: Record<string, unknown>[] = [];
    let connected = false;
    mockFetch((call) => {
      if (call.method === "GET") {
        const sources = connected
          ? [
              {
                id: "src_w",
                type: "slack",
                externalId: "C9",
                name: "#wide",
                scopePath: "org.wide",
                status: "active",
                createdAt: "2026-10-01T00:00:00Z",
              },
            ]
          : [];
        return isSourcesList(call.url)
          ? Response.json(sourcesPage(call.url, sources))
          : Response.json({ integrations: [] });
      }
      const body = call.body as Record<string, unknown>;
      posts.push(body);
      const ack = body.acknowledgeWidening as { people?: unknown; agents?: unknown } | undefined;
      if (ack?.people !== 12 || ack?.agents !== 3) {
        return new Response(
          JSON.stringify({
            error: "refused",
            code: "widening_not_acknowledged",
            widening: { status: "known", people: 12, agents: 3 },
            acknowledge: { people: 12, agents: 3 },
          }),
          { status: 409 },
        );
      }
      connected = true;
      return new Response(JSON.stringify({ source: { id: "src_w" } }), { status: 201 });
    });
    const { ConnectorsPanel } = await import("./connectors-panel");
    render(<ConnectorsPanel />);
    await waitFor(() => expect(screen.getByText(/No Slack, Figma, PostHog or GitHub sources/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "+ Connect Slack" }));
    fireEvent.change(screen.getByPlaceholderText(/Channel ID/), { target: { value: "C9" } });
    fireEvent.change(screen.getByPlaceholderText(/Channel name/), { target: { value: "#wide" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() =>
      expect(
        screen.getByText("This lets 12 more people and 3 agents read this source through Willder. Confirm to connect."),
      ).toBeTruthy(),
    );
    return posts;
  }

  it("shows the count and connects nothing until confirmed, then resends with the acknowledgement", async () => {
    const posts = await startSlackConnect();
    expect(posts).toHaveLength(1);
    expect(screen.queryByText("#wide")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Confirm and connect" }));
    await waitFor(() => expect(screen.getByText("#wide")).toBeTruthy());
    expect(await screen.findByText("#wide connected. The Knowledge sources tab shows its sync status.")).toBeTruthy();
    expect(posts[1]).toEqual({ ...posts[0], acknowledgeWidening: { people: 12, agents: 3 } });
  });

  it("cancelling sends nothing more", async () => {
    const posts = await startSlackConnect();
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText(/Confirm to connect/)).toBeNull());
    await act(async () => {});
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Connect" }));
    expect(posts).toHaveLength(1);
  });
});

// A refused connect shows next to the form that sent it, not at the top of the panel, above
// the whole list, while the person is looking at the form at the bottom.
describe("ConnectorsPanel — a refused connect shows with the form that sent it", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_CONNECTORS_ENABLED", "true");
  });

  it("puts the message, naming the fix, after the form's Connect button", async () => {
    mockFetch((call) => {
      if (call.method === "GET")
        return isSourcesList(call.url) ? Response.json(sourcesPage(call.url, [])) : Response.json({ integrations: [] });
      return new Response("<html>Bad gateway</html>", { status: 502 });
    });
    const { ConnectorsPanel } = await import("./connectors-panel");
    render(<ConnectorsPanel />);
    await waitFor(() => expect(screen.getByText(/No Slack, Figma, PostHog or GitHub sources/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "+ Connect Slack" }));
    fireEvent.change(screen.getByPlaceholderText(/Channel ID/), { target: { value: "C9" } });
    fireEvent.change(screen.getByPlaceholderText(/Channel name/), { target: { value: "#wide" } });
    const connect = screen.getByRole("button", { name: "Connect" });
    fireEvent.click(connect);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/HTTP 502\)\. Try again in a minute/);
    expect(connect.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The fields locked while it was in flight; focus goes back to Connect, not to the page.
    // An effect moves it in the alert's own commit: flush effects, then read it once, so a late move fails.
    await act(async () => {});
    expect(document.activeElement).toBe(connect);
    // Editing a field drops a message about values no longer on screen.
    fireEvent.change(screen.getByPlaceholderText(/Channel name/), { target: { value: "#narrow" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("ConnectorsPanel — edge cases", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_CONNECTORS_ENABLED", "true");
  });

  it("Cancel stays usable while a connect is in flight, and a successful Sync says so and takes focus", async () => {
    const slack = {
      id: "c1",
      type: "slack",
      externalId: "C1",
      name: "#eng",
      scopePath: "org_acme.eng",
      status: "active",
      createdAt: "2026-10-01T00:00:00Z",
      meta: null,
      _count: { files: 0 },
    };
    mockFetch((call) => {
      if (call.method === "GET")
        return isSourcesList(call.url)
          ? Response.json(sourcesPage(call.url, [slack]))
          : Response.json({ integrations: [] });
      if (call.url.endsWith("/sync")) return Response.json({ jobId: "j" }, { status: 202 });
      return new Promise<Response>(() => {});
    });
    const { ConnectorsPanel } = await import("./connectors-panel");
    render(<ConnectorsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "+ Connect Slack" }));
    fireEvent.change(screen.getByPlaceholderText(/Channel ID/), { target: { value: "C9" } });
    fireEvent.change(screen.getByPlaceholderText(/Channel name/), { target: { value: "#wide" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    const cancel = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    fireEvent.click(cancel);

    fireEvent.click(await screen.findByRole("button", { name: "Sync" }));
    const notice = await screen.findByText("Sync requested for #eng. The Knowledge sources tab shows its result.");
    await act(async () => {});
    expect(document.activeElement).toBe(notice);
  });
});

describe("WideningConfirm — the question names people and agents", () => {
  async function question(widening: import("./widening-confirm").PendingWidening["widening"]) {
    const { WideningConfirm } = await import("./widening-confirm");
    const pending = { body: {}, widening, acknowledge: { people: 0, agents: 0 } };
    const view = render(
      <WideningConfirm pending={pending} what="these files" busy={false} onConfirm={() => {}} onCancel={() => {}} />,
    );
    const text = within(view.container).getByRole("alertdialog").textContent ?? "";
    view.unmount();
    return text;
  }

  it("names both counts, or only the one that is not zero", async () => {
    expect(await question({ status: "known", people: 9, agents: 3 })).toContain(
      "This lets 9 more people and 3 agents read these files through Willder.",
    );
    expect(await question({ status: "known", people: 0, agents: 1 })).toContain(
      "This lets 1 agent read these files through Willder.",
    );
    expect(await question({ status: "known", people: 1, agents: 0 })).toContain(
      "This lets 1 more person read these files through Willder.",
    );
  });

  it("an unknown source still names its agents exactly", async () => {
    expect(await question({ status: "unknown", atMost: 4, agents: 2 })).toContain(
      "Willder can't see who can read these files at the source, so up to 4 more people could read it through Willder, and 2 agents will.",
    );
  });
});
