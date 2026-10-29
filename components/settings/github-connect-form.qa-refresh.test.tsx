// @vitest-environment jsdom
// QA tests for the connect form's "Check again", written by the reviewer: it reads
// GitHub afresh for the one request it sends, and for no other. Coming back to the
// view it checked, or pressing it again while its check is still loading, must not
// start another full re-read of the token's listing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GitHubConnectForm, type RepositoryPage } from "./github-connect-form";
import type { GitHubRepositorySummary, GitHubTokenBreadth } from "@/services/connectors/github-token-probe";

const TOKEN = ["github", "_pat_", "QAQA", "r".repeat(78)].join("");
const FINE: GitHubTokenBreadth = {
  kind: "fine-grained",
  scopes: null,
  canWrite: "unknown",
  writeScopes: [],
  expiresAt: null,
};
const SSO = { ssoPartialResults: true, ssoWithheldOrganizations: 1, ssoWithheldOrganizationIds: ["7"] };

const repo = (fullName: string): GitHubRepositorySummary => ({
  fullName,
  private: false,
  visibility: "public",
  description: null,
  archived: false,
  fork: false,
  pushedAt: "2026-10-14T18:31:02Z",
});
const rows = Array.from({ length: 25 }, (_, i) => repo(`acme/r${String(i).padStart(2, "0")}`));

function page(n: number, extra: Partial<RepositoryPage> = {}): RepositoryPage {
  return {
    token: FINE,
    reached: 25,
    truncated: false,
    ...SSO,
    rows: rows.slice((n - 1) * 20, n * 20),
    total: 25,
    page: n,
    pageSize: 20,
    ...extra,
  };
}

type Call = { url: string; body: Record<string, unknown>; resolve: (res: Response) => void };
let calls: Call[] = [];
const listings = () => calls.filter((c) => c.url === "/api/sources/github/repositories");
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
async function answer(call: Call | undefined, res: Response) {
  if (!call) throw new Error("no such request");
  await act(async () => call.resolve(res));
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (url: string, init?: RequestInit) =>
        new Promise<Response>((resolve) => calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")), resolve })),
    ),
  );
});
afterEach(() => vi.unstubAllGlobals());

async function probedWithSso() {
  render(<GitHubConnectForm busy={false} onConnect={vi.fn()} onCancel={() => {}} />);
  fireEvent.change(screen.getByLabelText("Token"), { target: { value: TOKEN } });
  fireEvent.click(screen.getByRole("button", { name: "Find repositories" }));
  await waitFor(() => expect(listings()).toHaveLength(1));
  await answer(listings()[0], json(page(1)));
}

describe("Check again (QA)", () => {
  it("does not read GitHub afresh again on coming back to the page it checked", async () => {
    await probedWithSso();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(listings()).toHaveLength(2));
    expect(listings()[1].body).toMatchObject({ page: 1, refresh: true });
    await answer(listings()[1], json(page(1)));

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(listings()).toHaveLength(3));
    await answer(listings()[2], json(page(2)));
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    await waitFor(() => expect(listings()).toHaveLength(4));
    expect(listings()[3].body).toMatchObject({ page: 1 });
    expect(listings()[3].body).not.toHaveProperty("refresh");
  });

  it("sends one fresh read however often it is pressed while that read loads", async () => {
    await probedWithSso();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(listings()).toHaveLength(2));
    const again = screen.queryByRole("button", { name: "Check again" }) as HTMLButtonElement | null;
    if (again && !again.disabled) fireEvent.click(again);
    if (again && !again.disabled) fireEvent.click(again);
    await act(async () => {});
    expect(listings().filter((c) => c.body.refresh === true)).toHaveLength(1);
  });
});
