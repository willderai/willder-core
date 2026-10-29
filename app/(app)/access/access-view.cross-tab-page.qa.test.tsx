// The search box is shared by every Access tab, and each paged
// tab keeps its page in the URL. A search changed on one tab must open every other
// paged tab on page 1, not on a page that belonged to the old search.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AccessView } from "./access-view";
import { grantsPage, tokensPage } from "./access-test-api";
import { waitOnFakeClock } from "@/lib/fake-clock-waits.testsupport";

waitOnFakeClock();

let searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {} }),
  useSearchParams: () => searchParams,
}));
vi.mock("@/components/reveal", () => ({
  Reveal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

afterEach(() => {
  vi.unstubAllGlobals();
  searchParams = new URLSearchParams();
  window.history.replaceState(null, "", "/");
});

function stub(requests: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      requests.push(url);
      if (url.startsWith("/api/access/capabilities?")) return json(tokensPage(url, []));
      if (url.startsWith("/api/access/grants?")) return json(grantsPage(url, []));
      if (url.startsWith("/api/audit"))
        return json({ entries: [], total: 0, counts: { allowed: 0, denied: 0 }, page: 1, pageSize: 50, totalPages: 1 });
      if (url === "/api/access/scopes") return json({ scopes: [] });
      return json({});
    }),
  );
}

const pageOf = (url: string) => new URL(url, "https://w.test").searchParams.get("page");

describe.each([
  { tab: "Grants", param: "grants.page", path: "/api/access/grants?" },
  { tab: "Tokens", param: "tokens.page", path: "/api/access/capabilities?" },
])("$tab tab after a search typed on the Audit tab", ({ tab, param, path }) => {
  it("opens on page 1", async () => {
    const requests: string[] = [];
    stub(requests);
    searchParams = new URLSearchParams(`tab=audit&${param}=3`);
    window.history.replaceState(null, "", `/access?tab=audit&${param}=3`);
    render(<AccessView canManage />);
    fireEvent.change(await screen.findByRole("searchbox"), { target: { value: "deploy" } });
    fireEvent.click(screen.getByRole("button", { name: tab }));
    await waitFor(() => expect(requests.some((u) => u.startsWith(path))).toBe(true));
    const listRequests = requests.filter((u) => u.startsWith(path));
    expect(listRequests.map(pageOf)).toEqual(listRequests.map(() => "1"));
  });
});
