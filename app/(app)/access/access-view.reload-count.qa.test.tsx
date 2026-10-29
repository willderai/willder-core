// After a revoke, the Grants tab reloads its page. Until the fresh page arrives the old
// rows stay on screen, dimmed, and no count from before the revoke may be shown as the
// count: a stale number would hide the real one.
// The header count and the toolbar count already
// blank; this checks every count on the tab, the pager's "1–25 of N" included.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/reveal", () => ({
  Reveal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { AccessView } from "./access-view";
import { grantsPage } from "./access-test-api";
import { waitOnFakeClock } from "@/lib/fake-clock-waits.testsupport";

waitOnFakeClock();

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

const grants = Array.from({ length: 30 }, (_, i) => ({
  id: `g${String(i).padStart(2, "0")}`,
  granteeType: "agent",
  granteeId: `agent_${i}`,
  granteeName: `Agent ${String(i).padStart(2, "0")}`,
  permission: "read",
  expiresAt: null,
  createdAt: new Date(Date.UTC(2026, 0, 30 - i)).toISOString(),
  scope: { id: `s${i}`, path: `org_1.team${String(i).padStart(2, "0")}`, name: `team${String(i).padStart(2, "0")}` },
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Grants tab while the page reloads after a revoke", () => {
  it("shows no count from before the revoke, in the header, the toolbar or the pager", async () => {
    let rows = [...grants];
    let holdReload: (() => void) | null = null;
    let revoked = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          const id = url.split("/").pop();
          rows = rows.filter((g) => g.id !== id);
          revoked = true;
          return json({ ok: true });
        }
        if (url.startsWith("/api/access/grants?")) {
          const body = grantsPage(url, rows);
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
    await screen.findByText("team00");
    expect(screen.getByText("30 grants")).toBeTruthy();
    expect(screen.getByText(/of 30 grants/)).toBeTruthy();

    const firstRow = screen.getByText("team00").closest("tr")!;
    fireEvent.click(within(firstRow).getByRole("button", { name: "revoke" }));
    fireEvent.click(within(firstRow).getByRole("button", { name: "yes" }));
    await waitFor(() => expect(holdReload).not.toBeNull());

    // The reload is in flight: the rows from before the revoke are dimmed...
    expect(screen.getByRole("region", { name: "Access grants" }).getAttribute("aria-busy")).toBe("true");
    // ...and no count from before the revoke is presented anywhere on the tab.
    expect(screen.queryByText("30 grants")).toBeNull();
    expect(screen.queryByText(/of 30 grants/)).toBeNull();

    await act(async () => {
      holdReload!();
    });
    await waitFor(() => expect(screen.getByText("29 grants")).toBeTruthy());
    expect(screen.getByText(/of 29 grants/)).toBeTruthy();
  });
});
