// @vitest-environment jsdom
//
// Pins that the picker says when GET /api/memory/scopes cut its list short
// (`truncated: true`), instead of showing a short or empty list as complete.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ScopePicker } from "./scope-picker";

const NOTICE = /more scopes than this list can show/;

function stubScopesResponse(body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function openPicker() {
  render(<ScopePicker selected={null} onChange={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Org root" }));
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe("ScopePicker — truncated scope list", () => {
  it("shows the notice when the route reports truncated: true", async () => {
    stubScopesResponse({
      scopes: [{ id: "s1", path: "root_abc.sales_def", name: "Sales" }],
      truncated: true,
    });
    await openPicker();

    expect(await screen.findByText("Sales")).toBeTruthy();
    expect(screen.getByRole("note").textContent).toMatch(NOTICE);
  });

  it("shows the notice even when every listed scope was filtered out", async () => {
    stubScopesResponse({ scopes: [], truncated: true });
    await openPicker();

    expect(screen.getByRole("note").textContent).toMatch(NOTICE);
  });

  it("shows no notice when truncated is false", async () => {
    stubScopesResponse({
      scopes: [{ id: "s1", path: "root_abc.sales_def", name: "Sales" }],
      truncated: false,
    });
    await openPicker();

    expect(await screen.findByText("Sales")).toBeTruthy();
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("clears the notice when a refresh after create is no longer truncated", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ scopes: [], truncated: true }), { status: 200 }),
    );
    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ scope: { path: "root_abc.ops_123456" } }), { status: 201 }),
    );
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            scopes: [{ id: "s2", path: "root_abc.ops_123456", name: "Ops" }],
            truncated: false,
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<ScopePicker selected={null} onChange={vi.fn()} manageable />);
    fireEvent.click(await screen.findByRole("button", { name: "Org root" }));
    expect(screen.getByRole("note")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create scope" }));
    fireEvent.change(screen.getByPlaceholderText("Scope name"), { target: { value: "Ops" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    fireEvent.click(await screen.findByRole("button", { name: "Org root" }));
    expect(await screen.findByText("Ops")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("note")).toBeNull());
  });
});
