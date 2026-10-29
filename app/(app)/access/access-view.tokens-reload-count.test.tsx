// The Tokens tab while its page reloads after a revoke: the rows from before the
// revoke stay on screen, dimmed, and no count from that page is shown as current,
// the pager's "1–25 of N tokens" included. The Grants tab's twin of this check is
// access-view.reload-count.qa.test.tsx.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {} }),
  useSearchParams: () => new URLSearchParams("tab=tokens"),
}));
vi.mock("@/components/reveal", () => ({
  Reveal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { AccessView } from "./access-view";
import { tokensPage, type TokenFixture } from "./access-test-api";
import { waitOnFakeClock } from "@/lib/fake-clock-waits.testsupport";

waitOnFakeClock();

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const DAY_MS = 24 * 60 * 60 * 1000;

const tokens: TokenFixture[] = Array.from({ length: 30 }, (_, i) => ({
  id: `tok_${String(i).padStart(8, "0")}`,
  agentId: `agent-${String(i).padStart(2, "0")}`,
  scopePath: "org_1",
  permission: "read",
  expiresAt: new Date(Date.now() + 30 * DAY_MS).toISOString(),
  revokedAt: null,
  createdAt: new Date(Date.now() - (i + 1) * DAY_MS).toISOString(),
  agentDeactivated: false,
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Tokens tab while the page reloads after a revoke", () => {
  it("shows no count from before the revoke, in the header or the pager", async () => {
    let rows = [...tokens];
    let holdReload: (() => void) | null = null;
    let revoked = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          const id = url.split("/").pop();
          rows = rows.map((t) => (t.id === id ? { ...t, revokedAt: new Date().toISOString() } : t));
          revoked = true;
          return json({ ok: true });
        }
        if (url.startsWith("/api/access/capabilities?")) {
          const body = tokensPage(url, rows);
          if (revoked)
            await new Promise<void>((resolve) => {
              holdReload = resolve;
            });
          return json(body);
        }
        return json({ scopes: [], members: [], agents: [] });
      }),
    );

    render(<AccessView canManage />);
    await screen.findByText("agent-00");
    expect(screen.getByText("30 tokens")).toBeTruthy();
    expect(screen.getByText(/of 30 tokens/)).toBeTruthy();

    const firstRow = screen.getByText("agent-00").closest("tr")!;
    fireEvent.click(within(firstRow).getByRole("button", { name: "revoke" }));
    fireEvent.click(within(firstRow).getByRole("button", { name: "yes" }));
    await waitFor(() => expect(holdReload).not.toBeNull());

    expect(screen.getByRole("region", { name: "Agent tokens" }).getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByText("30 tokens")).toBeNull();
    expect(screen.queryByText(/of 30 tokens/)).toBeNull();

    // A revoked token still counts as one of the org's tokens; the counts return
    // with the fresh page, and the row now reads revoked.
    await act(async () => {
      holdReload!();
    });
    await waitFor(() => expect(screen.getByText("30 tokens")).toBeTruthy());
    expect(screen.getByText(/of 30 tokens/)).toBeTruthy();
    expect(within(screen.getByText("agent-00").closest("tr")!).getByText("revoked")).toBeTruthy();
  });
});
