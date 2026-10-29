// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryWorkbench, FactCard } from "./memory-workbench";
import MemoryPage from "@/app/(app)/memory/ask/page";
import type { MemoryFact } from "@/types/memory";

vi.mock("@/components/reveal", () => ({ Reveal: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/help", () => ({ HelpTip: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("./graph-explorer", () => ({ GraphExplorer: () => <div>Graph</div> }));
vi.mock("@/lib/access-context", () => ({ requireAccessContext: async () => ({ org: { id: "testorg" }, ctx: {} }) }));
vi.mock("@/services/access", () => ({
  can: async () => ({ allowed: true }),
  orgRootPath: (orgId: string) => `org_${orgId}`,
}));
vi.mock("@/components/onboarding/first-use-tips", () => ({ FirstUseTips: () => null }));
vi.mock("./scope-picker", () => ({
  ScopePicker: ({ selected, onChange }: { selected: string | null; onChange: (value: string | null) => void }) => (
    <select aria-label="Search scope" value={selected ?? ""} onChange={(event) => onChange(event.target.value || null)}>
      <option value="">Organization root</option>
      <option value="org.engineering">Engineering</option>
      <option value="org.support">Support</option>
      <option value="org_testorg.engineering">Test organization engineering</option>
      <option value="org_testorg.support">Test organization support</option>
    </select>
  ),
}));

afterEach(() => vi.unstubAllGlobals());

const fact: MemoryFact = {
  uuid: "fact-release-owner",
  fact: "Morgan owns the next release.",
  validAt: "2026-09-27T10:00:00.000Z",
  actorType: "human",
  actorName: "Morgan Lee",
  sourceId: "source-linear",
  sourceEventIds: ["event-release-plan"],
};

function stream(events: unknown[]) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function ask(question = "Who owns the next release?") {
  const input = screen.getByRole("textbox", { name: "Ask memory" });
  fireEvent.change(input, { target: { value: question } });
  fireEvent.submit(input.closest("form")!);
}

describe("Memory provenance inspection", () => {
  it("reveals returned provenance without treating a memory date as source freshness", () => {
    render(
      <FactCard
        fact={fact}
        scope="org.engineering"
        canWrite={false}
        canDelete={false}
        onEdited={vi.fn()}
        onRemoved={vi.fn()}
        onNote={vi.fn()}
      />,
    );
    const toggle = screen.getByText("Source & history");
    const details = toggle.closest("details")!;
    expect(details.open).toBe(false);
    fireEvent.click(toggle);
    expect(details.open).toBe(true);
    expect(within(details).getByText("Morgan Lee")).toBeTruthy();
    expect(within(details).getByText("source-linear")).toBeTruthy();
    expect(within(details).getByText("event-release-plan")).toBeTruthy();
    expect(within(details).getByText("org.engineering")).toBeTruthy();
    expect(details.querySelector("time")?.dateTime).toBe(fact.validAt);
    expect(within(details).getByText("Memory timestamp")).toBeTruthy();
    expect(within(details).getByText(/may describe when a fact applies or when it was stored/)).toBeTruthy();
    expect(within(details).queryByText("Valid from")).toBeNull();
    expect(within(details).getByText(/Source freshness is not included/)).toBeTruthy();
    expect(screen.queryByText(/confidence|similarity|tokens/i)).toBeNull();
  });

  it("distinguishes missing provenance from a known manual source", () => {
    render(
      <FactCard
        fact={{ uuid: "legacy", fact: "Legacy note", validAt: "invalid-date" }}
        scope={null}
        canWrite={false}
        canDelete={false}
        onEdited={vi.fn()}
        onRemoved={vi.fn()}
        onNote={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Source & history"));
    expect(screen.getByText("Name not recorded")).toBeTruthy();
    expect(screen.getByText("No source identifier returned")).toBeTruthy();
    expect(screen.getByText("Not recorded")).toBeTruthy();
    expect(screen.queryByText("Invalid Date")).toBeNull();
  });
});

describe("Memory page scoped navigation", () => {
  it("resets conversation state when navigating to a different scope URL", async () => {
    const requests: { scope?: string; history: unknown[] }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        requests.push(JSON.parse(init!.body as string));
        return stream([{ type: "delta", text: `Scoped answer ${requests.length}` }, { type: "done" }]);
      }),
    );
    const view = render(await MemoryPage({ searchParams: Promise.resolve({ scope: "org_testorg.engineering" }) }));
    ask("Engineering question");
    await screen.findByText("Scoped answer 1");
    expect(requests[0].scope).toBe("org_testorg.engineering");

    view.rerender(await MemoryPage({ searchParams: Promise.resolve({ scope: "org_testorg.support" }) }));
    expect(screen.queryByText("Scoped answer 1")).toBeNull();
    expect((screen.getByRole("combobox", { name: "Search scope" }) as HTMLSelectElement).value).toBe(
      "org_testorg.support",
    );
    ask("Support question");
    await screen.findByText("Scoped answer 2");
    expect(requests[1]).toMatchObject({ scope: "org_testorg.support", history: [] });
  });

  it.each([
    "org_other.engineering",
    "org_testorg_lookalike.engineering",
    "org_testorg..engineering",
    ["org_testorg.engineering", "org_testorg.support"],
  ])("does not adopt an invalid or foreign scope URL: %j", async (scope) => {
    const requests: { scope?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        requests.push(JSON.parse(init!.body as string));
        return stream([{ type: "delta", text: "Root answer" }, { type: "done" }]);
      }),
    );
    render(await MemoryPage({ searchParams: Promise.resolve({ scope }) }));
    expect((screen.getByRole("combobox", { name: "Search scope" }) as HTMLSelectElement).value).toBe("");
    ask();
    await screen.findByText("Root answer");
    expect(requests[0].scope).toBeUndefined();
  });
});

describe("MemoryWorkbench request context", () => {
  it("explains the active boundary before sending a question from a scoped link", async () => {
    const fetchMock = vi.fn(async () =>
      stream([
        { type: "intent", intent: "read" },
        { type: "facts", facts: [fact] },
        { type: "delta", text: "Morgan owns the release." },
        { type: "done" },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryWorkbench initialScope="org.engineering" canWrite canDelete={false} canManageScopes={false} />);
    expect(screen.getByText("Search within")).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Search scope" }) as HTMLSelectElement).value).toBe("org.engineering");
    expect(screen.getByText(/Only memory you can access in this scope is searched/)).toBeTruthy();
    ask();
    await screen.findByText("Morgan owns the release.");
    expect(JSON.parse((fetchMock.mock.calls as unknown as [string, RequestInit][])[0][1].body as string)).toMatchObject(
      { scope: "org.engineering", mode: "ask" },
    );
    fireEvent.click(screen.getByRole("button", { name: "write" }));
    expect(screen.getByText("Save into")).toBeTruthy();
    expect(screen.getByText(/Your permission is checked when you save/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "chat" }));
    expect(screen.queryByRole("combobox", { name: "Search scope" })).toBeNull();
    expect(screen.getByText(/Memory is off/)).toBeTruthy();
  });

  it("counts distinct returned sources without inventing sources for unattributed facts", async () => {
    const sameSource = { ...fact, uuid: "same-source-fact", fact: "The release is on Friday." };
    const unattributed = { uuid: "unknown-source-fact", fact: "The release needs review.", validAt: null };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        stream([
          { type: "intent", intent: "read" },
          { type: "facts", facts: [fact, sameSource, unattributed] },
          { type: "delta", text: "Morgan owns the release." },
          { type: "done" },
        ]),
      ),
    );
    render(<MemoryWorkbench canWrite={false} canDelete={false} canManageScopes={false} />);
    ask();
    const context = await screen.findByRole("region", { name: "Retrieved context" });
    expect(within(context).getByText("3 facts")).toBeTruthy();
    expect(within(context).getByText(/1 identified source/)).toBeTruthy();
    fireEvent.click(within(context).getByRole("button", { name: /Retrieved context/ }));
    expect(within(context).getByText(/A source is not recorded for 1 fact/)).toBeTruthy();
    expect(within(context).queryByText(/confidence|similarity|tokens saved/i)).toBeNull();
  });

  it("shows where the answer came from: hits per store and the context tokens used", async () => {
    const breakdown = {
      stores: [
        { store: "graph", hits: 1 },
        { store: "semantic", hits: 2 },
      ],
      contextTokens: 1240,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        stream([
          { type: "intent", intent: "read" },
          { type: "facts", facts: [fact], breakdown },
          { type: "delta", text: "Morgan owns the release." },
          { type: "done" },
        ]),
      ),
    );
    render(<MemoryWorkbench canWrite={false} canDelete={false} canManageScopes={false} />);
    ask();
    const row = await screen.findByRole("region", { name: "Where this came from" });
    expect(row.textContent).toContain("Graph 1 hit");
    expect(row.textContent).toContain("Chunks 2 hits");
    expect(row.textContent).toContain("about 1,240 context tokens");
  });

  it("says a store failed instead of reporting it as zero hits", async () => {
    const breakdown = {
      stores: [
        { store: "graph", hits: 0, failed: true },
        { store: "semantic", hits: 1 },
      ],
      contextTokens: 8,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        stream([
          { type: "intent", intent: "read" },
          { type: "facts", facts: [fact], breakdown },
          { type: "delta", text: "Morgan." },
          { type: "done" },
        ]),
      ),
    );
    render(<MemoryWorkbench canWrite={false} canDelete={false} canManageScopes={false} />);
    ask();
    const row = await screen.findByRole("region", { name: "Where this came from" });
    expect(row.textContent).toContain("Graph unavailable");
    expect(row.textContent).not.toContain("Graph 0 hits");
  });

  it("shows no breakdown until the answer has finished", async () => {
    const breakdown = { stores: [{ store: "semantic", hits: 1 }], contextTokens: 8 };
    const encoder = new TextEncoder();
    let finish!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of [
          { type: "intent", intent: "read" },
          { type: "facts", facts: [fact], breakdown },
          { type: "delta", text: "Morgan" },
        ]) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        finish = () => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`));
          controller.close();
        };
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { headers: { "content-type": "text/event-stream" } })),
    );
    render(<MemoryWorkbench canWrite={false} canDelete={false} canManageScopes={false} />);
    ask();
    await screen.findByText("Morgan");
    expect(screen.queryByRole("region", { name: "Where this came from" })).toBeNull();
    finish();
    expect(await screen.findByRole("region", { name: "Where this came from" })).toBeTruthy();
  });

  it("preserves the original citation numbers and disables removed facts after a deletion", async () => {
    const secondFact = { ...fact, uuid: "fact-release-date", fact: "The release is scheduled for Friday." };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === "DELETE"
          ? new Response(JSON.stringify({ removed: fact.uuid }), { status: 200 })
          : stream([
              { type: "intent", intent: "read" },
              { type: "facts", facts: [fact, secondFact] },
              { type: "delta", text: "Morgan owns the release [1], scheduled for Friday [2]." },
              { type: "done" },
            ]),
      ),
    );
    render(<MemoryWorkbench canWrite canDelete canManageScopes={false} />);
    ask();
    fireEvent.click(await screen.findByRole("button", { name: /Retrieved context/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "remove" })[0]);
    expect(await screen.findByText(/Removed from memory/)).toBeTruthy();
    expect(screen.getByText(fact.fact).textContent).toContain("[1]");
    expect(screen.getByText(secondFact.fact).textContent).toContain("[2]");
    expect(screen.getAllByRole("button", { name: "remove" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "edit" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /Retrieved context/ }));
    fireEvent.click(screen.getByRole("button", { name: /Retrieved context/ }));
    expect(screen.getByText(/Removed from memory/)).toBeTruthy();
    expect(screen.getByText(secondFact.fact).textContent).toContain("[2]");
    expect(screen.getAllByRole("button", { name: "remove" })).toHaveLength(1);
  });

  it("sends conversation history only from the request's captured scope and mode", async () => {
    const requests: { scope?: string; mode: string; history: { role: string; content: string }[] }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        requests.push(JSON.parse(init!.body as string));
        return stream([{ type: "delta", text: `Answer ${requests.length}` }, { type: "done" }]);
      }),
    );
    render(<MemoryWorkbench canWrite canDelete={false} canManageScopes={false} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Search scope" }), { target: { value: "org.engineering" } });
    ask("Engineering question");
    await screen.findByText("Answer 1");
    fireEvent.change(screen.getByRole("combobox", { name: "Search scope" }), { target: { value: "org.support" } });
    ask("Support question");
    await screen.findByText("Answer 2");
    expect(requests[1].history).toEqual([]);
    ask("Support follow-up");
    await screen.findByText("Answer 3");
    expect(requests[2].history).toEqual([
      { role: "user", content: "Support question" },
      { role: "assistant", content: "Answer 2" },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "chat" }));
    const chatInput = screen.getByRole("textbox", { name: "Chat message" });
    fireEvent.change(chatInput, { target: { value: "Conversation without memory" } });
    fireEvent.submit(chatInput.closest("form")!);
    await screen.findByText("Answer 4");
    expect(requests[3].history).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "ask" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Search scope" }), { target: { value: "org.engineering" } });
    ask("Engineering follow-up");
    await screen.findByText("Answer 5");
    expect(requests[4].history).toEqual([
      { role: "user", content: "Engineering question" },
      { role: "assistant", content: "Answer 1" },
    ]);
  });

  it("keeps retrieved facts and their mutations in the original search scope after the picker changes", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "PATCH"
        ? new Response(JSON.stringify({ jobId: "queued" }), { status: 202 })
        : stream([
            { type: "intent", intent: "read" },
            { type: "facts", facts: [fact] },
            { type: "delta", text: "Morgan owns it. [1]" },
            { type: "done" },
          ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryWorkbench canWrite canDelete canManageScopes={false} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Search scope" }), { target: { value: "org.engineering" } });
    ask();
    await screen.findByText("Generated answer");
    fireEvent.change(screen.getByRole("combobox", { name: "Search scope" }), { target: { value: "org.support" } });
    fireEvent.click(screen.getByRole("button", { name: /Retrieved context/ }));
    const context = screen.getByRole("region", { name: "Retrieved context" });
    expect(within(context).getAllByText("org.engineering")).toHaveLength(3);
    expect(within(context).queryByText("org.support")).toBeNull();
    expect(screen.getByText("[1]")).toBeTruthy();
    fireEvent.click(screen.getByText("edit"));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit fact" }), {
      target: { value: "Avery owns the next release." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetchMock.mock.calls[1][1]!.body as string)).toEqual({
      fact: "Avery owns the next release.",
      scope: "org.engineering",
    });
    expect(await screen.findByText(/This is the earlier retrieved fact/)).toBeTruthy();
    expect(screen.getByText("Morgan owns the next release.")).toBeTruthy();
    expect(screen.queryByText("Avery owns the next release.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Retrieved context/ }));
    fireEvent.click(screen.getByRole("button", { name: /Retrieved context/ }));
    expect(screen.getByText(/This is the earlier retrieved fact/)).toBeTruthy();
    expect(screen.queryByText("edit")).toBeNull();
  });

  it("confirms a pending write in its original mode and destination", async () => {
    const fetchMock = vi.fn(async () =>
      stream([
        { type: "confirm", summary: "Morgan owns the release.", pendingContent: "Morgan owns the release." },
        { type: "done" },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryWorkbench canWrite canDelete={false} canManageScopes={false} />);
    fireEvent.click(screen.getByRole("button", { name: "write" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Search scope" }), { target: { value: "org.engineering" } });
    const input = screen.getByRole("textbox", { name: "Write to memory" });
    fireEvent.change(input, { target: { value: "Remember Morgan owns the release." } });
    fireEvent.submit(input.closest("form")!);
    const confirm = await screen.findByRole("button", { name: "Save to memory" });
    fireEvent.change(screen.getByRole("combobox", { name: "Search scope" }), { target: { value: "org.support" } });
    fireEvent.click(screen.getByRole("button", { name: "chat" }));
    fireEvent.click(confirm);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const request = (fetchMock.mock.calls as unknown as [string, RequestInit][])[1][1];
    expect(JSON.parse(request.body as string)).toMatchObject({
      scope: "org.engineering",
      mode: "write",
      confirmed: true,
      pendingContent: "Morgan owns the release.",
    });
  });

  it("shows an empty retrieval and switches to Write when adding missing information", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        stream([
          { type: "intent", intent: "read" },
          { type: "facts", facts: [] },
          { type: "no_data", entities: ["Morgan"] },
          { type: "delta", text: "No matching information." },
          { type: "done" },
        ]),
      ),
    );
    render(<MemoryWorkbench canWrite canDelete={false} canManageScopes={false} />);
    ask();
    expect(await screen.findByText(/No matching facts were returned/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "+ Add Morgan to memory" }));
    expect((screen.getByRole("textbox", { name: "Write to memory" }) as HTMLInputElement).value).toBe("Morgan is ");
  });

  it("makes an empty search actionable without silently changing its scope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        stream([
          { type: "intent", intent: "read" },
          { type: "facts", facts: [] },
          { type: "no_data", entities: [] },
          { type: "delta", text: "No matching information." },
          { type: "done" },
        ]),
      ),
    );
    render(
      <MemoryWorkbench initialScope="org.engineering" canWrite={false} canDelete={false} canManageScopes={false} />,
    );
    ask("Who owns the next release?");
    const revise = await screen.findByRole("button", { name: "Revise question" });
    fireEvent.change(screen.getByRole("combobox", { name: "Search scope" }), { target: { value: "org.support" } });
    fireEvent.click(revise);
    const input = screen.getByRole("textbox", { name: "Ask memory" }) as HTMLInputElement;
    expect(input.value).toBe("Who owns the next release?");
    expect(document.activeElement).toBe(input);
    expect((screen.getByRole("combobox", { name: "Search scope" }) as HTMLSelectElement).value).toBe("org.engineering");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("restores the failed message and original scope for an explicit retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "Memory is temporarily unavailable." }), { status: 503 })),
    );
    render(<MemoryWorkbench canWrite canDelete={false} canManageScopes={false} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Search scope" }), { target: { value: "org.engineering" } });
    ask("Who owns the release?");
    await screen.findByRole("alert");
    fireEvent.change(screen.getByRole("combobox", { name: "Search scope" }), { target: { value: "org.support" } });
    fireEvent.click(screen.getByRole("button", { name: "Edit and try again" }));
    expect((screen.getByRole("textbox", { name: "Ask memory" }) as HTMLInputElement).value).toBe(
      "Who owns the release?",
    );
    expect((screen.getByRole("combobox", { name: "Search scope" }) as HTMLSelectElement).value).toBe("org.engineering");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("ends loading with an actionable error when a stream closes without completion", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => stream([{ type: "intent", intent: "read" }])),
    );
    render(<MemoryWorkbench canWrite={false} canDelete={false} canManageScopes={false} />);
    ask();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/connection ended before the response finished/)).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
