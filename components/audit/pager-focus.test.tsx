import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ListPagination } from "@/components/list-controls/list-controls";
import { AuditLog } from "./audit-log";
import { SessionStarts } from "./session-starts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const auditEntry = {
  id: "event",
  actorType: "agent",
  actorName: "Prior actor",
  action: "memory.read",
  target: null,
  decision: "allow",
  reason: null,
  changeIds: [],
  at: "2026-10-15T12:00:00Z",
};
const session = {
  servingId: "session",
  agentName: "Prior actor",
  sessionKey: "s",
  scopePath: "org_a",
  taskKey: "task",
  servedAt: "2026-10-15T12:00:00Z",
  lineCount: 0,
  lines: [],
};
const views = [
  {
    name: "audit",
    View: AuditLog,
    size: 50,
    key: "page",
    payload: (page: number, empty = false) => ({
      entries: empty ? [] : [auditEntry],
      counts: { allowed: 101, denied: 0 },
      total: 101,
      pageSize: 50,
      totalPages: 3,
      page,
    }),
  },
  {
    name: "sessions",
    View: SessionStarts,
    size: 20,
    key: "sessions.page",
    payload: (page: number, empty = false) => ({
      sessions: empty ? [] : [session],
      total: 101,
      pageSize: 50,
      totalPages: 3,
      page,
    }),
  },
];
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

for (const { name, View, payload, size, key } of views)
  describe(`${name} pager focus`, () => {
    it.each(["success", "empty", "401", "403", "500", "network", "malformed"])(
      "keeps Next focused through a held page and %s result without stale records or counts",
      async (outcome) => {
        let resolve!: (response: Response) => void;
        let reject!: (error: Error) => void;
        const pending = new Promise<Response>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        const load = vi.fn((url: string) => (url.includes("page=2") ? pending : Promise.resolve(json(payload(1)))));
        vi.stubGlobal("fetch", (url: string) =>
          url === "/api/audit/actors" ? Promise.resolve(json({ actors: [] })) : load(url),
        );
        render(<View scope="org_a" />);
        const next = await screen.findByRole("button", { name: "Next page" });
        next.focus();
        fireEvent.click(next);
        await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
        expect(document.activeElement).toBe(next);
        expect(next.getAttribute("aria-disabled")).toBe("true");
        expect(screen.getByRole("button", { name: "Previous page" }).getAttribute("aria-disabled")).toBe("true");
        expect(screen.queryByText("Prior actor")).toBeNull();
        const nav = next.closest("nav")!;
        expect(nav.getAttribute("aria-busy")).toBe("true");
        expect(within(nav).queryByText(/of 101|of 3/)).toBeNull();
        fireEvent.click(next);
        expect(load).toHaveBeenCalledTimes(2);
        await act(async () => {
          if (outcome === "network") reject(new Error("offline"));
          else
            resolve(
              outcome === "success" || outcome === "empty"
                ? json(payload(2, outcome === "empty"))
                : outcome === "malformed"
                  ? json({})
                  : json({}, Number(outcome)),
            );
        });
        expect(document.activeElement).toBe(next);
        expect(nav.getAttribute("aria-busy")).toBe("false");
        if (outcome === "success" || outcome === "empty") {
          expect(next.getAttribute("aria-disabled")).toBe("false");
          expect(within(nav).getByText("Page 2 of 3")).toBeTruthy();
          if (outcome === "empty") {
            expect(within(nav).queryByText(/\d+–\d+/)).toBeNull();
            expect(within(nav).getByText(/101 (records|sessions) total/)).toBeTruthy();
          }
        } else {
          expect(await screen.findByRole("alert")).toBeTruthy();
          expect(next.getAttribute("aria-disabled")).toBe("true");
          expect(within(nav).getByText("Page unavailable")).toBeTruthy();
          expect(within(nav).queryByText(/of 101|of 3|Loading/)).toBeNull();
          const previous = screen.getByRole("button", { name: "Previous page" });
          expect(previous.getAttribute("aria-disabled")).toBe("true");
          fireEvent.click(previous);
          fireEvent.click(next);
          expect(load).toHaveBeenCalledTimes(2);
        }
      },
    );
    it("keeps Previous focused during a return page turn without retaining old records", async () => {
      let resolve!: (response: Response) => void;
      const pending = new Promise<Response>((done) => {
        resolve = done;
      });
      const load = vi
        .fn()
        .mockResolvedValueOnce(json(payload(1)))
        .mockResolvedValueOnce(json(payload(2)))
        .mockReturnValueOnce(pending);
      vi.stubGlobal("fetch", (url: string) =>
        url === "/api/audit/actors" ? Promise.resolve(json({ actors: [] })) : load(url),
      );
      render(<View scope="org_a" />);
      fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
      await screen.findByText("Page 2 of 3");
      const previous = screen.getByRole("button", { name: "Previous page" });
      previous.focus();
      fireEvent.click(previous);
      expect(document.activeElement).toBe(previous);
      expect(screen.queryByText("Prior actor")).toBeNull();
      await act(async () => {
        resolve(json(payload(1)));
      });
      expect(document.activeElement).toBe(previous);
      expect(previous.getAttribute("aria-disabled")).toBe("true");
      expect(screen.getByText("Page 1 of 3")).toBeTruthy();
    });

    it.each([0, 1, "one page", "two pages"])(
      "retains focus and truthful counts when the list shrinks to %s, through recovery",
      async (remaining) => {
        const total = remaining === "one page" ? size : remaining === "two pages" ? size + 1 : Number(remaining);
        const initialPage = total > size ? 2 : 1;
        const requestedPage = initialPage + 1;
        window.history.replaceState(null, "", `/?${key}=${initialPage}`);
        const response = (page: number, count: number) => ({
          ...payload(page, page > Math.ceil(count / size)),
          total: count,
          pageSize: size,
          totalPages: Math.ceil(count / size),
        });
        const load = vi
          .fn()
          .mockResolvedValueOnce(json(response(initialPage, size * 2 + 1)))
          .mockResolvedValueOnce(json(response(requestedPage, total)))
          .mockResolvedValueOnce(json(response(initialPage, total)));
        vi.stubGlobal("fetch", (url: string) =>
          url === "/api/audit/actors" ? Promise.resolve(json({ actors: [] })) : load(url),
        );
        render(<View scope="org_a" />);
        const next = await screen.findByRole("button", { name: "Next page" });
        next.focus();
        fireEvent.click(next);
        await screen.findByRole("button", { name: "Return to first page" });
        expect(document.activeElement).toBe(next);
        const nav = next.closest("nav")!;
        expect(nav.getAttribute("aria-busy")).toBe("false");
        expect(within(nav).queryByText(/\d+–\d+|Page \d+ of \d+/)).toBeNull();
        expect(
          within(nav).getByText(
            `${total} ${total === 1 ? (name === "audit" ? "record" : "session") : name === "audit" ? "records" : "sessions"} total`,
          ),
        ).toBeTruthy();
        expect(next.getAttribute("aria-disabled")).toBe("true");
        const previous = within(nav).getByRole("button", { name: "Previous page" });
        expect(previous.getAttribute("aria-disabled")).toBe("false");
        previous.focus();
        fireEvent.click(previous);
        await waitFor(() => expect(nav.getAttribute("aria-busy")).toBe("false"));
        expect(document.activeElement).toBe(previous);
        expect(new URLSearchParams(window.location.search).get(key) ?? "1").toBe(String(initialPage));
        expect(load).toHaveBeenCalledTimes(3);
      },
    );

    it("retries a failed page and enables paging after success", async () => {
      const load = vi
        .fn()
        .mockResolvedValueOnce(json(payload(1)))
        .mockResolvedValueOnce(json({}, 500))
        .mockResolvedValueOnce(json(payload(2)));
      vi.stubGlobal("fetch", (url: string) =>
        url === "/api/audit/actors" ? Promise.resolve(json({ actors: [] })) : load(url),
      );
      render(<View scope="org_a" />);
      const next = await screen.findByRole("button", { name: "Next page" });
      fireEvent.click(next);
      fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
      await screen.findByText("Page 2 of 3");
      expect(next.getAttribute("aria-disabled")).toBe("false");
      expect(load).toHaveBeenCalledTimes(3);
    });

    it("ignores delayed page JSON after a newer history page settles", async () => {
      let resolve!: (value: unknown) => void;
      const oldBody = new Promise((done) => {
        resolve = done;
      });
      const load = vi
        .fn()
        .mockResolvedValueOnce(json(payload(1)))
        .mockResolvedValueOnce({ status: 200, ok: true, json: () => oldBody })
        .mockResolvedValueOnce(json(payload(3)));
      vi.stubGlobal("fetch", (url: string) =>
        url === "/api/audit/actors" ? Promise.resolve(json({ actors: [] })) : load(url),
      );
      render(<View scope="org_a" />);
      fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        window.history.replaceState(null, "", `/?${key}=3`);
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      await screen.findByText("Page 3 of 3");
      await act(async () => {
        resolve(payload(2));
      });
      expect(screen.getByText("Page 3 of 3")).toBeTruthy();
    });

    it("hides a pager for an initially single-page list", async () => {
      vi.stubGlobal("fetch", (url: string) =>
        Promise.resolve(
          json(url === "/api/audit/actors" ? { actors: [] } : { ...payload(1), total: 1, totalPages: 1 }),
        ),
      );
      render(<View scope="org_a" />);
      await screen.findByText("Prior actor");
      expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
    });
  });

// The pager may learn about a smaller result before its caller knows whether rows exist.
// Its own boundaries must not display an inverted range or lose an already visible control.
describe("retained pager boundaries", () => {
  const paging = (page: number, total: number) => ({
    rows: [],
    page,
    total,
    pageSize: 50,
    pageCount: Math.max(1, Math.ceil(total / 50)),
    setPage: vi.fn(),
  });
  it("keeps controls after a single-page list grows and then empties", () => {
    const view = render(<ListPagination noun={{ one: "record", many: "records" }} paging={paging(1, 1)} keepVisible />);
    expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
    view.rerender(<ListPagination noun={{ one: "record", many: "records" }} paging={paging(1, 101)} keepVisible />);
    const next = screen.getByRole("button", { name: "Next page" });
    next.focus();
    view.rerender(<ListPagination noun={{ one: "record", many: "records" }} paging={paging(1, 0)} keepVisible />);
    expect(document.activeElement).toBe(next);
    expect(screen.getByText("0 records total")).toBeTruthy();
    expect(screen.queryByText(/\d+–\d+/)).toBeNull();
  });
  it.each([1, 51])("offers recovery for an initially out-of-range page with %i records", (total) => {
    const page = paging(3, total);
    render(<ListPagination noun={{ one: "record", many: "records" }} paging={page} keepVisible />);
    expect(screen.getByText(`${total} ${total === 1 ? "record" : "records"} total`)).toBeTruthy();
    expect(screen.queryByText(/\d+–\d+|Page 3 of/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(page.setPage).toHaveBeenCalledWith(2);
  });
});
