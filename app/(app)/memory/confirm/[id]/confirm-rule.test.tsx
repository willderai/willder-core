// @vitest-environment jsdom
//
// The confirm button says "Confirmed" only after the server answered 200, never because a
// click happened: while the call is in flight, after a refusal and after a network failure,
// the card still offers the button or says why not. The call goes to the rule's own route.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConfirmRule, type ConfirmableRule } from "./confirm-rule";

afterEach(() => vi.unstubAllGlobals());

const rule: ConfirmableRule = {
  id: "cv_1",
  kind: "decision",
  subject: "Session store",
  text: "Store sessions in Postgres, not Redis.",
  scopePath: "org_1.coding",
  scopeName: "Coding",
  recordedBy: "agent",
  writerName: "Claude Code Agent",
  inForce: true,
};

const reply = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));

describe("ConfirmRule", () => {
  it("posts to the rule's confirm route and says Confirmed only after the 200", async () => {
    let answer!: (r: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => (answer = resolve)));
    vi.stubGlobal("fetch", fetchMock);
    render(<ConfirmRule rule={rule} canWrite />);

    fireEvent.click(screen.getByRole("button", { name: "Confirm decision" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/memory/conventions/cv_1/confirm", { method: "POST" });
    expect((screen.getByRole("button", { name: "Confirming…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/^Confirmed\./)).toBeNull();

    answer(new Response(JSON.stringify({ confirmed: "cv_2", replaced: "cv_1" }), { status: 200 }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toMatch(/^Confirmed\. Your version replaces the agent's/),
    );
  });

  it("keeps the button and shows the server's reason on a refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => reply(409, { error: "This rule was replaced or retired, so there is nothing to confirm." })),
    );
    render(<ConfirmRule rule={rule} canWrite />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm decision" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("replaced or retired"));
    expect(screen.queryByRole("status")).toBeNull();
    expect((screen.getByRole("button", { name: "Confirm decision" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("says nothing was confirmed when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("offline"))),
    );
    render(<ConfirmRule rule={rule} canWrite />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm decision" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Nothing was confirmed"));
  });

  it("offers no button to a reader, for a person's rule, or for a version no longer served", () => {
    const { rerender } = render(<ConfirmRule rule={rule} canWrite={false} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/cannot confirm it/)).toBeTruthy();

    rerender(<ConfirmRule rule={{ ...rule, recordedBy: "person", writerName: "Ana" }} canWrite />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Recorded by Ana")).toBeTruthy();

    rerender(<ConfirmRule rule={{ ...rule, inForce: false }} canWrite />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("link", { name: "Explore memory" }).getAttribute("href")).toBe(
      "/memory/explore?scope=org_1.coding",
    );
  });
});
