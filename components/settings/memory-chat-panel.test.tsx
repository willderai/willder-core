// @vitest-environment jsdom
//
// The memory chat panel shows only the memory chat name, never the retired
// outreach drafting fields or send caps, and saves through /api/settings/memory-chat.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryChatPanel } from "./memory-chat-panel";

function mockFetch(initial: string | null, saveResponse?: { status: number; body: unknown }) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      const r = saveResponse ?? { status: 200, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify(r.body), { status: r.status });
    }
    return new Response(JSON.stringify({ memoryChatName: initial }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MemoryChatPanel", () => {
  it("loads the stored name and shows no outreach settings", async () => {
    mockFetch("Jane");
    render(<MemoryChatPanel />);
    const input = await screen.findByLabelText("Name in memory chat");
    await waitFor(() => expect((input as HTMLInputElement).value).toBe("Jane"));
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/copy agent|campaign|guardrail|sends? \/ day|drafts? \/ day|sign-off|opener|forbidden/i);
  });

  it("saves the edited name with a PATCH to the memory chat endpoint", async () => {
    const fetchMock = mockFetch(null);
    render(<MemoryChatPanel />);
    const input = await screen.findByLabelText("Name in memory chat");
    await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(input, { target: { value: "the Sales team" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved");
    const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(patchCall?.[0]).toBe("/api/settings/memory-chat");
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({ memoryChatName: "the Sales team" });
  });

  it("shows the server's refusal instead of claiming success", async () => {
    mockFetch(null, { status: 403, body: { error: "admin or owner required" } });
    render(<MemoryChatPanel />);
    const input = await screen.findByLabelText("Name in memory chat");
    await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(input, { target: { value: "Jane" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("admin or owner required");
    expect(screen.queryByText("Saved")).toBeNull();
  });
});
