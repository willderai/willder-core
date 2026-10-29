// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SessionStarts, sessionSummary } from "./session-starts";

type Body = Record<string, unknown>;

function session(overrides: Body = {}): Body {
  return {
    servingId: "srv-1",
    agentId: "agent-1",
    agentName: "Builder Agent",
    sessionKey: "mcp:conn-1",
    scopePath: "org_a.team",
    taskKey: "TASK-41",
    servedAt: "2026-10-14T10:00:00.000Z",
    lineCount: 3,
    lines: [
      { position: 1, itemType: "convention", namedIds: ["rule-1"], use: "named", changeId: "chg-rule-1" },
      { position: 2, itemType: "fact", namedIds: ["fact-1"], use: "returned", changeId: "chg-fact-1" },
      { position: 3, itemType: "provenance", namedIds: ["graph-1"], use: null, changeId: null },
    ],
    ...overrides,
  };
}

function respond(status: number, body: Body = {}) {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
}

function page(sessions: Body[], extra: Body = {}): Body {
  return { sessions, total: sessions.length, page: 1, pageSize: 20, totalPages: sessions.length ? 1 : 0, ...extra };
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("sessionSummary", () => {
  it("says what the session got and how much of it it used", () => {
    expect(sessionSummary(session() as never)).toEqual({
      headline: "Got 3 things at start and used 2 of them.",
      erased: null,
    });
  });

  it("never reports a session with no name as having used nothing", () => {
    const unnamed = session({
      sessionKey: "",
      lines: [{ position: 1, itemType: "fact", namedIds: ["f"], use: null, changeId: null }],
      lineCount: 1,
    });
    expect(sessionSummary(unnamed as never).headline).toBe(
      "Got 1 thing at start. Which it used can’t be told: the session had no name.",
    );
  });

  it("counts lines erased since toward what it got, and says they are not shown", () => {
    const erased = session({ lineCount: 5 });
    expect(sessionSummary(erased as never)).toEqual({
      headline: "Got 5 things at start and used 2 of them.",
      erased: "2 of them have been erased since and are not shown.",
    });
  });
});

describe("SessionStarts", () => {
  it("asks for the selected scope and shows each line, its use and a link to its record", async () => {
    fetchMock.mockReturnValueOnce(respond(200, page([session()])));
    render(<SessionStarts scope="org_a.team" />);

    const row = await screen.findByText("Got 3 things at start and used 2 of them.");
    const url = new URL(fetchMock.mock.calls[0]![0] as string, "http://t");
    expect(url.pathname).toBe("/api/audit/sessions");
    expect(url.searchParams.get("scope")).toBe("org_a.team");

    const item = row.closest("li")!;
    expect(within(item).getByText("Builder Agent")).toBeTruthy();
    expect(within(item).getByText("TASK-41")).toBeTruthy();
    const lines = within(item).getAllByRole("listitem");
    expect(lines.map((line) => line.textContent)).toEqual([
      expect.stringContaining("Rule"),
      expect.stringContaining("Fact"),
      expect.stringContaining("Graph fact"),
    ]);
    expect(within(lines[0]!).getByText("Used: named it in a call")).toBeTruthy();
    expect(within(lines[1]!).getByText("Used: came back in an answer")).toBeTruthy();
    expect(within(lines[2]!).getByText("Not used")).toBeTruthy();
    expect(within(lines[0]!).getByRole("link", { name: "Open the record" }).getAttribute("href")).toBe(
      "/audit?view=timeline&scope=org_a.team&change=chg-rule-1",
    );
    expect(within(lines[2]!).queryByRole("link")).toBeNull();
  });

  it("shows use as unknown, not as unused, for a session with no name", async () => {
    fetchMock.mockReturnValueOnce(
      respond(
        200,
        page([
          session({
            sessionKey: "",
            lines: [{ position: 1, itemType: "fact", namedIds: ["f"], use: null, changeId: null }],
            lineCount: 1,
          }),
        ]),
      ),
    );
    render(<SessionStarts scope={null} />);
    expect(await screen.findByText("Use unknown")).toBeTruthy();
    expect(screen.queryByText("Not used")).toBeNull();
    expect(new URL(fetchMock.mock.calls[0]![0] as string, "http://t").searchParams.has("scope")).toBe(false);
  });

  it("shows an empty state when no session has started in the scope", async () => {
    fetchMock.mockReturnValueOnce(respond(200, page([])));
    render(<SessionStarts scope={null} />);
    expect(await screen.findByText("No session starts yet")).toBeTruthy();
    expect(screen.getByText("None yet")).toBeTruthy();
  });

  it("shows a loading state until the answer arrives", async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((r) => {
        resolve = r;
      }),
    );
    render(<SessionStarts scope={null} />);
    expect(screen.getByRole("status").textContent).toBe("Loading session starts…");
    resolve(new Response(JSON.stringify(page([])), { status: 200 }));
    expect(await screen.findByText("No session starts yet")).toBeTruthy();
  });

  it("tells a member they need admin access, and shows nothing else", async () => {
    fetchMock.mockReturnValueOnce(respond(403, { error: "forbidden" }));
    render(<SessionStarts scope={null} />);
    expect(await screen.findByText("Admin access required")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Session starts" })).toBeNull();
  });

  it("treats a malformed answer as an error and retries on request", async () => {
    fetchMock.mockReturnValueOnce(respond(200, { sessions: [{ servingId: 1 }] }));
    render(<SessionStarts scope={null} />);
    expect(await screen.findByText("Couldn’t load session starts")).toBeTruthy();
    fetchMock.mockReturnValueOnce(respond(200, page([session()])));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Got 3 things at start and used 2 of them.")).toBeTruthy();
  });

  it("pages through older sessions", async () => {
    fetchMock.mockReturnValueOnce(respond(200, page([session()], { total: 25, totalPages: 2 })));
    render(<SessionStarts scope={null} />);
    await screen.findByText("Page 1 of 2");
    fetchMock.mockReturnValueOnce(
      respond(200, page([session({ servingId: "srv-2", taskKey: "TASK-7" })], { total: 25, page: 2, totalPages: 2 })),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(screen.getByText("TASK-7")).toBeTruthy());
    expect(new URL(fetchMock.mock.calls[1]![0] as string, "http://t").searchParams.get("page")).toBe("2");
    expect(new URLSearchParams(window.location.search).get("sessions.page")).toBe("2");
  });

  it("opens the page a link names", async () => {
    window.history.replaceState(null, "", "/audit?view=sessions&sessions.page=2");
    fetchMock.mockReturnValueOnce(
      respond(200, page([session({ taskKey: "TASK-7" })], { total: 25, page: 2, totalPages: 2 })),
    );
    render(<SessionStarts scope={null} />);
    await screen.findByText("TASK-7");
    expect(new URL(fetchMock.mock.calls[0]![0] as string, "http://t").searchParams.get("page")).toBe("2");
  });

  it("narrows to the days picked, from the start of the first to the start of the day after the last, and starts again at page 1", async () => {
    window.history.replaceState(null, "", "/audit?view=sessions&sessions.page=2");
    fetchMock.mockImplementation(() => respond(200, page([session()], { total: 25, page: 2, totalPages: 2 })));
    render(<SessionStarts scope={null} />);
    await screen.findByText("Page 2 of 2");

    fetchMock.mockImplementation(() => respond(200, page([])));
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-10-01" } });
    await screen.findByText("No session starts in these dates");
    fireEvent.change(screen.getByLabelText("Through"), { target: { value: "2026-10-14" } });
    // The new range remounts the results: the third request is made while they load, and the
    // empty state the first range left is gone. Wait for that request, then for what the reader
    // sees. Asserting on the screen right after the request finds the loading state.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await screen.findByText("None in these dates");

    const last = new URL(fetchMock.mock.calls[2]![0] as string, "http://t").searchParams;
    expect(last.get("from")).toBe(new Date(2026, 9, 1).toISOString());
    expect(last.get("to")).toBe(new Date(2026, 9, 15).toISOString());
    expect(last.get("page")).toBe("1");
    const query = new URLSearchParams(window.location.search);
    expect([query.get("sessions.from"), query.get("sessions.through"), query.get("sessions.page")]).toEqual([
      "2026-10-01",
      "2026-10-14",
      null,
    ]);
  });

  it("opens the range a link names and clears it from the empty state", async () => {
    window.history.replaceState(null, "", "/audit?view=sessions&sessions.from=2026-10-01&sessions.through=2026-10-02");
    fetchMock.mockReturnValueOnce(respond(200, page([])));
    render(<SessionStarts scope={null} />);
    await screen.findByText("No session starts in these dates");
    expect(new URL(fetchMock.mock.calls[0]![0] as string, "http://t").searchParams.get("from")).toBe(
      new Date(2026, 9, 1).toISOString(),
    );
    expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe("2026-10-01");

    fetchMock.mockReturnValueOnce(respond(200, page([session()])));
    const clears = screen.getAllByRole("button", { name: "Clear dates" });
    fireEvent.click(clears[clears.length - 1]!);
    await screen.findByText("Got 3 things at start and used 2 of them.");
    const params = new URL(fetchMock.mock.calls[1]![0] as string, "http://t").searchParams;
    expect(params.has("from") || params.has("to")).toBe(false);
    expect(window.location.search).not.toContain("sessions.from");
    expect(screen.queryByRole("button", { name: "Clear dates" })).toBeNull();
  });
});
