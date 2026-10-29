// @vitest-environment jsdom
// The GitHub connect form through the real probe routes, with only GitHub faked in
// its own answer shapes (services/connectors/fixtures/github-token.ts) and the
// session mocked: a stranger's first connect against a token that reaches 1,000
// repositories. The form must find one named repository with one search, page
// through the rest on the server, and connect exactly the one picked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: vi.fn(() => false), per: { hour: 3_600_000 } }));

import { requireAccessContext } from "@/lib/access-context";
import {
  fakeTokenGitHub,
  listedRepo,
  manyRepos,
  tokenState,
  type FakeTokenState,
} from "@/services/connectors/fixtures/github-token";
import { POST as listRepositories } from "@/app/api/sources/github/repositories/route";
import { POST as reachRepository } from "@/app/api/sources/github/reach/route";
import { GitHubConnectForm } from "./github-connect-form";

const TOKEN = ["gh", "p_", "K".repeat(36)].join("");
const ROUTES: Record<string, (req: Request) => Promise<Response>> = {
  "/api/sources/github/repositories": listRepositories,
  "/api/sources/github/reach": reachRepository,
};

let routeCalls: string[] = [];

beforeEach(() => {
  routeCalls = [];
  window.history.replaceState(null, "", "/integrations");
  vi.mocked(requireAccessContext).mockResolvedValue({
    org: { id: "org_contract" },
    user: { id: `user_${Math.random()}` },
    ctx: { orgId: "org_contract", actor: { type: "human", id: "u", role: "member" } },
  } as never);
  serveGitHub(tokenState(manyRepos(1_000), { scopes: "repo, read:org" }));
});

/** The real probe routes in front of a GitHub that answers like `state`. */
function serveGitHub(state: FakeTokenState) {
  const github = fakeTokenGitHub(state);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const route = ROUTES[url];
      if (route) {
        routeCalls.push(url);
        return route(new Request(`http://willder.test${url}`, init));
      }
      return github.fetch(input, init);
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("connecting one repository out of 1,000, through the real routes", () => {
  it("shows the token's real breadth, finds one by search, pages on the server and connects the pick", async () => {
    const onConnect = vi.fn();
    render(<GitHubConnectForm busy={false} onConnect={onConnect} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText("Token"), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: "Find repositories" }));

    const breadth = await screen.findByRole("group", { name: "What this token reaches" });
    expect(breadth.textContent).toContain("Classic token · lists 1,000 repositories");
    expect(breadth.textContent).toMatch(/can change things at GitHub \(scope repo\)/);
    await waitFor(() => expect(screen.getAllByRole("radio")).toHaveLength(20));
    expect(screen.getByText(/1–20 of 1,000 repositories/)).toBeTruthy();
    expect(screen.getAllByRole("radio")[0].getAttribute("aria-label")).toBe("acme/service-0000");

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(screen.getByText(/21–40 of 1,000 repositories/)).toBeTruthy());

    fireEvent.change(screen.getByRole("searchbox", { name: "Search repositories" }), {
      target: { value: "service-0737" },
    });
    await waitFor(() =>
      expect(screen.getAllByRole("radio").map((r) => r.getAttribute("aria-label"))).toEqual(["octo-org/service-0737"]),
    );

    fireEvent.click(screen.getByRole("radio", { name: "octo-org/service-0737" }));
    expect(
      await screen.findByText(
        /can read the README, docs, the file tree \(paths only\), issues with their comments, pull requests with their reviews, and commits of octo-org\/service-0737/,
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(onConnect).toHaveBeenCalledExactlyOnceWith({ type: "github", repo: "octo-org/service-0737", token: TOKEN });
    expect(routeCalls.filter((u) => u.endsWith("/reach"))).toHaveLength(1);
  });

  it("says an organization's SSO withheld its repositories, and refuses a search for one of them by name", async () => {
    serveGitHub(
      tokenState([...manyRepos(10), listedRepo("octo-corp/payments")], {
        scopes: "repo",
        ssoUnauthorized: new Map([["octo-corp", 21955855]]),
      }),
    );
    render(<GitHubConnectForm busy={false} onConnect={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText("Token"), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: "Find repositories" }));

    const breadth = await screen.findByRole("group", { name: "What this token reaches" });
    expect(breadth.textContent).toContain(
      "Classic token · lists 10 repositories1 organization withheld its repositories: authorize this token for SSO at GitHub to include them.",
    );
    fireEvent.change(screen.getByRole("searchbox", { name: "Search repositories" }), {
      target: { value: "octo-corp/payments" },
    });
    expect((await screen.findByRole("alert")).textContent).toMatch(/Authorize the token for that organization/);
  });

  it("shows the route's own refusal of a malformed token, before GitHub is asked", async () => {
    render(<GitHubConnectForm busy={false} onConnect={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText("Token"), { target: { value: "my password" } });
    fireEvent.click(screen.getByRole("button", { name: "Find repositories" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/does not look like a GitHub token/);
  });
});
