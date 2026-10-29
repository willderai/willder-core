import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { AuditLog } from "./audit-log";

const ENTRY = {
  id: "audit_01",
  actorType: "agent",
  actorName: "support-agent",
  triggeredBy: "Jane Doe",
  action: "memory.read",
  target: "org_test.support/query:What changed in the release policy?",
  decision: "allow",
  reason: "Capability permits memory.read in org_test.support",
  changeIds: [] as string[],
  at: "2026-09-29T13:24:01.123Z",
};

function payload(entries = [ENTRY], overrides = {}) {
  const allowed = entries.filter((entry) => entry.decision === "allow").length;
  const counts = { allowed, denied: entries.length - allowed };
  return {
    entries,
    total: entries.length,
    counts,
    page: 1,
    pageSize: 50,
    totalPages: entries.length ? 1 : 0,
    ...overrides,
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}

/** Leave the real identity picker in place, but isolate the records request so
 * request sequencing in these tests does not depend on picker mount order. */
function mockAuditFetch(load: (url: string, options?: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn((url: string, options?: RequestInit) => {
    if (url === "/api/audit/actors") {
      return Promise.resolve(
        json({
          actors: [
            { actorType: "human", actorId: "same-id", name: "Human with shared ID" },
            { actorType: "agent", actorId: "same-id", name: "Agent with shared ID" },
          ],
        }),
      );
    }
    return load(url, options);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  // The page, decision and identity live in the URL; each test starts from a bare one.
  window.history.replaceState(null, "", "/");
});

describe("AuditLog observability", () => {
  it("inspects the recorded reason and full source fields without confusing the display name with an identity ID", async () => {
    mockAuditFetch(async () => json(payload()));
    render(<AuditLog scope={null} />);

    const inspect = await screen.findByRole("button", { name: "Inspect event audit_01" });
    expect(screen.queryByText(ENTRY.reason)).toBeNull();
    fireEvent.click(inspect);

    const details = screen.getByRole("region", { name: "Details for event audit_01" });
    expect(inspect.getAttribute("aria-expanded")).toBe("true");
    expect(within(details).getByText(ENTRY.reason)).toBeTruthy();
    expect(within(details).getByText(ENTRY.target)).toBeTruthy();
    expect(within(details).getByText(ENTRY.action)).toBeTruthy();
    expect(within(details).getByText(ENTRY.at)).toBeTruthy();
    expect(within(details).getByText(ENTRY.id)).toBeTruthy();
    expect(within(details).getByText(ENTRY.actorName)).toBeTruthy();
    expect(within(details).getByText("Identity name")).toBeTruthy();
    expect(within(details).queryByText("Identity ID")).toBeNull();
    expect(within(details).getByText(ENTRY.triggeredBy)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close event audit_01" }));
    expect(screen.queryByRole("region", { name: "Details for event audit_01" })).toBeNull();
  });

  // The server resolves every agent's label (services/audit/actor-names.ts). Prettifying it
  // again here turned `"qa_agent" (agent token)` back into words that read like the built-in
  // QA agent, so the row shows the resolved label exactly as sent.
  it("shows an agent's resolved label exactly as the server sent it", async () => {
    const spoof = { ...ENTRY, id: "audit_spoof", actorName: '"qa_agent" (agent token)' };
    const real = { ...ENTRY, id: "audit_real", actorName: "Qa Agent Agent" };
    mockAuditFetch(async () => json(payload([spoof, real])));
    render(<AuditLog scope={null} />);

    const spoofRow = (await screen.findByRole("button", { name: "Inspect event audit_spoof" })).closest("li")!;
    const realRow = screen.getByRole("button", { name: "Inspect event audit_real" }).closest("li")!;
    expect(within(spoofRow).getByText('"qa_agent" (agent token)')).toBeTruthy();
    expect(within(realRow).getByText("Qa Agent Agent")).toBeTruthy();
  });

  // The page holds no denial, but the trail does: the summary must say so.
  it("shows allowed and denied across all pages, never a page-scoped zero beside a total", async () => {
    mockAuditFetch(async () =>
      json(
        payload([ENTRY, { ...ENTRY, id: "audit_02" }], {
          total: 4999,
          totalPages: 100,
          counts: { allowed: 4987, denied: 12 },
        }),
      ),
    );
    render(<AuditLog scope={null} />);

    const summary = await screen.findByLabelText("Audit summary");
    expect(within(summary).getByText("4,999")).toBeTruthy();
    expect(within(summary).getByText("4,987")).toBeTruthy();
    expect(within(summary).getByText("12")).toBeTruthy();
    expect(within(summary).queryByText("0")).toBeNull();
    expect(within(summary).queryByText("On this page")).toBeNull();
    expect(within(summary).getAllByText("Across all pages")).toHaveLength(3);
    expect(screen.getByText("Records 1–2 of 4,999 · Newest first")).toBeTruthy();
  });

  it("keeps the allowed count visible while the list shows denials only, and says the list is filtered", async () => {
    const denied = { ...ENTRY, id: "audit_denied", decision: "deny", reason: "No matching grant" };
    mockAuditFetch(async (url) =>
      json(
        url.includes("decision=deny")
          ? payload([denied], { total: 12, counts: { allowed: 4987, denied: 12 } })
          : payload([ENTRY], { total: 4999, totalPages: 100, counts: { allowed: 4987, denied: 12 } }),
      ),
    );
    render(<AuditLog scope={null} />);
    await screen.findByText("Records 1–1 of 4,999 · Newest first");
    fireEvent.click(screen.getByRole("button", { name: "Denied" }));

    expect(await screen.findByText("Records 1–1 of 12 · Denied only · Newest first")).toBeTruthy();
    const summary = screen.getByLabelText("Audit summary");
    expect(within(summary).getByText("4,999")).toBeTruthy();
    expect(within(summary).getByText("4,987")).toBeTruthy();
  });

  it("shows the token short id on a row written for a capability token", async () => {
    const refused = {
      ...ENTRY,
      id: "audit_refused",
      action: "capability.refused",
      decision: "deny",
      capabilityId: "cmg0abcd00001xyzrandom12",
    };
    mockAuditFetch(async () => json(payload([refused])));
    render(<AuditLog scope={null} />);
    expect(await screen.findByText("token random12")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Inspect event audit_refused" }));
    const details = screen.getByRole("region", { name: "Details for event audit_refused" });
    expect(within(details).getByText("cmg0abcd00001xyzrandom12")).toBeTruthy();
  });

  it("links a write's row to the change it made, in the scope on screen, so it can be handed on", async () => {
    const write = {
      ...ENTRY,
      id: "audit_write",
      action: "memory.write",
      target: "org_test.support/fact:f1",
      changeIds: ["chg-1", "chg-2"],
    };
    mockAuditFetch(async () => json(payload([write, ENTRY])));
    render(<AuditLog scope="org_test.support" />);
    const links = await screen.findAllByRole("link", { name: /See change \d it made/ });
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/audit?view=timeline&scope=org_test.support&change=chg-1",
      "/audit?view=timeline&scope=org_test.support&change=chg-2",
    ]);
    // The read beside it made no change, so it offers no link.
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });

  it("keeps network failure distinct from empty activity and gives retry a real loading state", async () => {
    const retry = deferred<Response>();
    const load = vi
      .fn<(url: string) => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockImplementationOnce(() => retry.promise);
    mockAuditFetch(load);
    render(<AuditLog scope={null} />);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("Your audit trail starts here")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByRole("status").textContent).toContain("Loading audit records");
    expect(screen.queryByText("Your audit trail starts here")).toBeNull();

    await act(async () => {
      retry.resolve(json(payload([])));
    });
    expect(await screen.findByText("Your audit trail starts here")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it.each([
    [401, "Your session needs attention"],
    [403, "Admin access required"],
    [500, "Couldn’t load the audit log"],
  ])("clears displayed records and open details before a refresh that returns HTTP %i", async (status, title) => {
    const refresh = deferred<Response>();
    const load = vi
      .fn<(url: string) => Promise<Response>>()
      .mockResolvedValueOnce(json(payload()))
      .mockImplementationOnce(() => refresh.promise);
    mockAuditFetch(load);
    render(<AuditLog scope={null} />);

    fireEvent.click(await screen.findByRole("button", { name: "Inspect event audit_01" }));
    expect(screen.getByText(ENTRY.reason)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(screen.queryByText(ENTRY.reason)).toBeNull();
    expect(screen.queryByRole("list", { name: "Audit records" })).toBeNull();
    expect(screen.queryByLabelText("Audit summary")).toBeNull();
    await act(async () => {
      refresh.resolve(json({ error: "failure" }, status));
    });
    expect(await screen.findByText(title)).toBeTruthy();
    expect(screen.queryByText(ENTRY.reason)).toBeNull();
  });

  it("never paints old response JSON after a different scope has loaded, even if transport ignores abort", async () => {
    const oldJson = deferred<unknown>();
    let oldSignal: AbortSignal | null | undefined;
    const newEntry = { ...ENTRY, id: "new_scope_event", actorName: "new-scope-agent" };
    mockAuditFetch(async (url, options) => {
      if (url.includes("org_old")) {
        oldSignal = options?.signal;
        return { ok: true, status: 200, json: () => oldJson.promise } as Response;
      }
      return json(payload([newEntry]));
    });
    const view = render(<AuditLog scope="org_old" />);
    // Let fetch complete, leaving its JSON parsing pending.
    await act(async () => {
      await Promise.resolve();
    });
    view.rerender(<AuditLog scope="org_new" />);
    expect(await screen.findByRole("button", { name: "Inspect event new_scope_event" })).toBeTruthy();
    expect(oldSignal?.aborted).toBe(true);

    await act(async () => {
      oldJson.resolve(payload());
    });
    expect(screen.queryByRole("button", { name: "Inspect event audit_01" })).toBeNull();
    expect(screen.getByRole("button", { name: "Inspect event new_scope_event" })).toBeTruthy();
  });

  it("resets pagination when filtering and sends the complete actor identity", async () => {
    const requests: URL[] = [];
    mockAuditFetch(async (url) => {
      const request = new URL(url, "https://willder.test");
      requests.push(request);
      return json(payload(undefined, { page: Number(request.searchParams.get("page")), total: 101, totalPages: 3 }));
    });
    render(<AuditLog scope="org_test.support" />);
    fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
    expect(await screen.findByText("Page 2 of 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Denied" }));
    expect(await screen.findByText("Page 1 of 3")).toBeTruthy();
    expect(requests.at(-1)?.searchParams.get("decision")).toBe("deny");
    expect(requests.at(-1)?.searchParams.get("page")).toBe("1");

    fireEvent.click(screen.getByRole("button", { name: "All identities" }));
    fireEvent.click(screen.getByRole("button", { name: "Agent with shared ID" }));
    await screen.findByRole("button", { name: "Inspect event audit_01" });
    expect(requests.at(-1)?.searchParams.get("actorType")).toBe("agent");
    expect(requests.at(-1)?.searchParams.get("actorId")).toBe("same-id");
    expect(requests.at(-1)?.searchParams.get("scope")).toBe("org_test.support");
  });

  it("keeps the page, decision and identity in the URL, and a link to them reopens that view", async () => {
    const requests: URL[] = [];
    mockAuditFetch(async (url) => {
      const request = new URL(url, "https://willder.test");
      requests.push(request);
      return json(payload(undefined, { page: Number(request.searchParams.get("page")), total: 101, totalPages: 3 }));
    });
    const first = render(<AuditLog scope={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Denied" }));
    fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
    await screen.findByText("Page 2 of 3");
    fireEvent.click(screen.getByRole("button", { name: "All identities" }));
    fireEvent.click(await screen.findByRole("button", { name: "Agent with shared ID" }));
    await screen.findByText("Page 1 of 3");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("Page 2 of 3");
    const link = new URLSearchParams(window.location.search);
    expect(Object.fromEntries(link)).toEqual({ decision: "deny", actorType: "agent", actorId: "same-id", page: "2" });

    // A reload, or the link handed to someone else, opens the same view.
    first.unmount();
    requests.length = 0;
    render(<AuditLog scope={null} />);
    await screen.findByText("Page 2 of 3");
    const reopened = requests.at(-1)!.searchParams;
    expect([
      reopened.get("decision"),
      reopened.get("actorType"),
      reopened.get("actorId"),
      reopened.get("page"),
    ]).toEqual(["deny", "agent", "same-id", "2"]);
    expect(screen.getByRole("button", { name: "Denied" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("reads a hand-edited decision or page it cannot use as the default view", async () => {
    const requests: URL[] = [];
    mockAuditFetch(async (url) => {
      const request = new URL(url, "https://willder.test");
      requests.push(request);
      return json(payload());
    });
    window.history.replaceState(null, "", "/?decision=maybe&page=-4&actorType=agent");
    render(<AuditLog scope={null} />);
    await screen.findByRole("button", { name: "Inspect event audit_01" });
    const sent = requests.at(-1)!.searchParams;
    expect([sent.get("decision"), sent.get("page"), sent.get("actorType")]).toEqual([null, "1", null]);
  });

  it("does not turn malformed successful responses into an empty trail", async () => {
    mockAuditFetch(async () => json({ entries: [], total: "unknown" }));
    render(<AuditLog scope={null} />);
    expect(await screen.findByText("Couldn’t load the audit log")).toBeTruthy();
    expect(screen.queryByText("Your audit trail starts here")).toBeNull();
  });

  it("refuses a response without decision counts rather than inventing zeros", async () => {
    const { counts: _omitted, ...withoutCounts } = payload();
    mockAuditFetch(async () => json(withoutCounts));
    render(<AuditLog scope={null} />);
    expect(await screen.findByText("Couldn’t load the audit log")).toBeTruthy();
    expect(screen.queryByLabelText("Audit summary")).toBeNull();
  });
});
