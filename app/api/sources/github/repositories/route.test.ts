// POST /api/sources/github/repositories against a GitHub that answers in its own
// shapes (services/connectors/fixtures/github-token.ts): who may ask, what is refused
// before GitHub is asked, the server-side search, filter, order and paging over a
// 1,000-repository token, an exact owner/name looked up past the listing, how
// GitHub's refusals reach the form, and that the token is never echoed or logged.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: vi.fn(() => false), per: { hour: 3_600_000 } }));

import { requireAccessContext } from "@/lib/access-context";
import { isRateLimited } from "@/lib/rate-limit";
import {
  fakeTokenGitHub,
  listedRepo,
  manyRepos,
  tokenState,
  type FakeTokenState,
} from "@/services/connectors/fixtures/github-token";
import { MAX_LISTED_REPOSITORIES } from "@/services/connectors/github-token-probe";
import { GITHUB_REPO_PAGE_SIZE } from "@/components/settings/github-repo-list";
import { providerResponse } from "@/services/connectors/fixtures/provider-response";
import { POST } from "./route";

const TOKEN = ["github", "_pat_", "11BBBB", "y".repeat(76)].join("");
const CLASSIC = ["gh", "p_", "Z".repeat(36)].join("");

let userSeq = 0;
function signIn() {
  // A fresh person per test, so one test's cached listing never answers another's.
  userSeq += 1;
  vi.mocked(requireAccessContext).mockResolvedValue({
    org: { id: "org_1" },
    user: { id: `user_${userSeq}` },
    ctx: { orgId: "org_1", actor: { type: "human", id: `user_${userSeq}`, role: "member" } },
  } as never);
}

function serve(state: FakeTokenState) {
  const github = fakeTokenGitHub(state);
  vi.stubGlobal("fetch", vi.fn(github.fetch));
  return github;
}

function post(body: unknown) {
  return POST(
    new Request("http://test/api/sources/github/repositories", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

type Page = {
  token: { kind: string; scopes: string[] | null; canWrite: string; writeScopes: string[]; expiresAt: string | null };
  reached: number;
  truncated: boolean;
  ssoPartialResults: boolean;
  ssoWithheldOrganizations: number;
  ssoWithheldOrganizationIds: string[];
  rows: { fullName: string; visibility: string; pushedAt: string | null }[];
  total: number;
  page: number;
  pageSize: number;
};

const logs: unknown[][] = [];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isRateLimited).mockReturnValue(false);
  signIn();
  logs.length = 0;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args);
    });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("who may ask, and what is refused before GitHub is asked", () => {
  it("refuses a request with no signed-in person", async () => {
    const github = serve(tokenState(manyRepos(3)));
    vi.mocked(requireAccessContext).mockResolvedValue(null);
    expect((await post({ token: TOKEN })).status).toBe(401);
    expect(github.requests).toEqual([]);
  });

  it("refuses past the per-person limit, keyed to that person", async () => {
    const github = serve(tokenState(manyRepos(3)));
    vi.mocked(isRateLimited).mockReturnValue(true);
    expect((await post({ token: TOKEN })).status).toBe(429);
    expect(vi.mocked(isRateLimited).mock.calls[0][0]).toBe(`sources:github-probe:org_1:user_${userSeq}`);
    expect(github.requests).toEqual([]);
  });

  it.each([
    ["a body that is not JSON", "{not json"],
    ["no token", {}],
    ["a token that is not a string", { token: 12345 }],
    ["a token with a header break", { token: `${TOKEN}\r\nX-Evil: 1` }],
    ["an unknown order", { token: TOKEN, sort: "stars" }],
    ["an unknown direction", { token: TOKEN, order: "up" }],
    ["an unknown visibility", { token: TOKEN, visibility: "secret" }],
    ["page 0", { token: TOKEN, page: 0 }],
    ["a fractional page", { token: TOKEN, page: 1.5 }],
    ["a page given as text", { token: TOKEN, page: "2" }],
    ["a page past any listing", { token: TOKEN, page: 10_001 }],
    ["a search longer than a list route takes", { token: TOKEN, q: "a".repeat(101) }],
    ["a search holding NUL", { token: TOKEN, q: "acme\u0000" }],
    ["a search that is not a string", { token: TOKEN, q: ["acme"] }],
  ])("refuses %s with 400", async (_, body) => {
    const github = serve(tokenState(manyRepos(3)));
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBeTruthy();
    expect(github.requests).toEqual([]);
  });
});

describe("one page of the token's repositories, narrowed on the server", () => {
  it("answers page 1 of a 1,000-repository token, newest push first, with every count labelled", async () => {
    serve(tokenState(manyRepos(1_000)));
    const res = await post({ token: TOKEN });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Page;
    expect(body).toMatchObject({
      reached: 1_000,
      truncated: false,
      total: 1_000,
      page: 1,
      pageSize: GITHUB_REPO_PAGE_SIZE,
    });
    expect(body.rows).toHaveLength(GITHUB_REPO_PAGE_SIZE);
    const pushed = body.rows.map((r) => Date.parse(r.pushedAt ?? ""));
    expect(pushed).toEqual([...pushed].sort((a, b) => b - a));
    expect(body.rows[0].fullName).toBe("acme/service-0000");
  });

  it("searches the whole listing, not the page: an owner prefix finds all 200 of that owner's", async () => {
    serve(tokenState(manyRepos(1_000)));
    const body = (await (await post({ token: TOKEN, q: "acme-labs/" })).json()) as Page;
    expect(body.total).toBe(200);
    expect(body.reached).toBe(1_000);
    expect(body.rows.every((r) => r.fullName.startsWith("acme-labs/"))).toBe(true);
  });

  it("finds one named repository among 1,000 with one search", async () => {
    serve(tokenState(manyRepos(1_000)));
    const body = (await (await post({ token: TOKEN, q: "service-0737" })).json()) as Page;
    expect(body.total).toBe(1);
    expect(body.rows.map((r) => r.fullName)).toEqual(["octo-org/service-0737"]);
  });

  it("filters by visibility across every page", async () => {
    const repos = manyRepos(1_000);
    serve(tokenState(repos));
    const body = (await (await post({ token: TOKEN, visibility: "private" })).json()) as Page;
    expect(body.total).toBe(repos.filter((r) => r.private).length);
    expect(body.rows.every((r) => r.visibility === "private")).toBe(true);
  });

  it("orders by name in either direction", async () => {
    serve(tokenState(manyRepos(1_000)));
    const asc = (await (await post({ token: TOKEN, sort: "name", order: "asc" })).json()) as Page;
    const desc = (await (await post({ token: TOKEN, sort: "name", order: "desc" })).json()) as Page;
    expect(asc.rows[0].fullName).toBe("acme-labs/service-0001");
    expect(desc.rows[0].fullName).toBe("zeta/service-0999");
  });

  it("answers the page asked for, and an empty page past the end with the real total", async () => {
    serve(tokenState(manyRepos(1_000)));
    const all = (await (await post({ token: TOKEN, sort: "name", order: "asc" })).json()) as Page;
    const third = (await (await post({ token: TOKEN, sort: "name", order: "asc", page: 3 })).json()) as Page;
    expect(third.page).toBe(3);
    expect(third.rows).toHaveLength(GITHUB_REPO_PAGE_SIZE);
    expect(third.rows[0].fullName).not.toBe(all.rows[0].fullName);
    const last = (await (await post({ token: TOKEN, page: 50 })).json()) as Page;
    expect(last.rows).toHaveLength(GITHUB_REPO_PAGE_SIZE);
    const past = (await (await post({ token: TOKEN, page: 51 })).json()) as Page;
    expect(past).toMatchObject({ rows: [], total: 1_000, page: 51 });
  });

  it("reads GitHub once for a person's searching and paging, and again for another person", async () => {
    const github = serve(tokenState(manyRepos(250)));
    await post({ token: TOKEN });
    await post({ token: TOKEN, q: "zeta" });
    await post({ token: TOKEN, page: 2 });
    expect(github.requests.filter((r) => r.path === "/user/repos")).toHaveLength(3);
    signIn();
    await post({ token: TOKEN });
    expect(github.requests.filter((r) => r.path === "/user/repos")).toHaveLength(6);
  });

  it("says when the token lists more than the listing holds", async () => {
    serve(tokenState(manyRepos(MAX_LISTED_REPOSITORIES + 50)));
    const body = (await (await post({ token: TOKEN })).json()) as Page;
    expect(body).toMatchObject({ truncated: true, reached: MAX_LISTED_REPOSITORIES });
  });
});

describe("an exact owner/name the listing does not hold", () => {
  it("is looked up directly and offered, so a repository past the listing can still be picked", async () => {
    const github = serve(tokenState(manyRepos(5), { unlisted: [listedRepo("vercel/next.js")] }));
    const body = (await (await post({ token: TOKEN, q: " Vercel/Next.js " })).json()) as Page;
    expect(body.rows.map((r) => r.fullName)).toEqual(["vercel/next.js"]);
    expect(body.total).toBe(1);
    expect(body.reached).toBe(5);
    expect(github.requests.at(-1)).toMatchObject({ path: "/repos/Vercel/Next.js" });
  });

  it("answers a renamed repository under its new name: GitHub redirects the old one", async () => {
    const github = fakeTokenGitHub(tokenState(manyRepos(5)));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        new URL(String(input)).pathname === "/repos/old-owner/widgets"
          ? // fetch follows GitHub's 301 itself, so the route sees the new repository's 200.
            providerResponse(listedRepo("new-owner/widgets"))
          : github.fetch(input, init),
      ),
    );
    const body = (await (await post({ token: TOKEN, q: "old-owner/widgets" })).json()) as Page;
    expect(body.rows.map((r) => r.fullName)).toEqual(["new-owner/widgets"]);
  });

  it("takes its place in the chosen order instead of always coming first", async () => {
    // "acme/service-00" matches 20 listed rows by substring; "acme/service-00" itself is unlisted.
    serve(
      tokenState(manyRepos(500), { unlisted: [listedRepo("acme/service-00", { pushedAt: "2020-01-01T00:00:00Z" })] }),
    );
    const newest = (await (await post({ token: TOKEN, q: "acme/service-00" })).json()) as Page;
    expect(newest.rows[0].fullName).not.toBe("acme/service-00");
    expect(newest.total).toBe(21);
    const oldest = (await (await post({ token: TOKEN, q: "acme/service-00", order: "asc" })).json()) as Page;
    expect(oldest.rows[0].fullName).toBe("acme/service-00");
  });

  it("matches nothing when the token cannot see it", async () => {
    serve(tokenState(manyRepos(5)));
    const body = (await (await post({ token: TOKEN, q: "someone/private-thing" })).json()) as Page;
    expect(body).toMatchObject({ rows: [], total: 0 });
  });

  it("is not looked up when the listing already holds it", async () => {
    const github = serve(tokenState(manyRepos(5)));
    await post({ token: TOKEN, q: "acme/service-0000" });
    expect(github.requests.some((r) => r.path.startsWith("/repos/"))).toBe(false);
  });

  it("still answers to the visibility filter", async () => {
    serve(tokenState(manyRepos(5), { unlisted: [listedRepo("vercel/next.js")] }));
    const body = (await (await post({ token: TOKEN, q: "vercel/next.js", visibility: "private" })).json()) as Page;
    expect(body.total).toBe(0);
  });

  it("is never looked up for text that is not a repository name", async () => {
    const github = serve(tokenState(manyRepos(5)));
    await post({ token: TOKEN, q: "acme/../../user" });
    await post({ token: TOKEN, q: "service" });
    expect(github.requests.some((r) => r.path !== "/user/repos")).toBe(false);
  });
});

describe("the token's breadth, reported and never refused", () => {
  it("a classic token that can write everywhere it reaches is listed, with that said", async () => {
    serve(tokenState(manyRepos(1_000), { scopes: "repo, read:org" }));
    const res = await post({ token: CLASSIC });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Page;
    expect(body.token).toEqual({
      kind: "classic",
      scopes: ["repo", "read:org"],
      canWrite: "yes",
      writeScopes: ["repo"],
      expiresAt: null,
    });
    expect(body.reached).toBe(1_000);
  });

  it("a fine-grained token's write access is unknown, with its expiry", async () => {
    serve(tokenState(manyRepos(2), { expiration: "2026-11-14 00:00:00 UTC" }));
    const body = (await (await post({ token: TOKEN })).json()) as Page;
    expect(body.token).toEqual({
      kind: "fine-grained",
      scopes: null,
      canWrite: "unknown",
      writeScopes: [],
      expiresAt: "2026-11-14T00:00:00Z",
    });
  });
});

describe("GitHub's refusals, as the form shows them", () => {
  it.each([
    ["bad-credentials", 400, "token-rejected"],
    ["app-token", 400, "cannot-list"],
    ["primary-rate-limit", 429, "rate-limited"],
    ["secondary-rate-limit", 429, "rate-limited"],
    ["unavailable", 502, "unavailable"],
  ] as const)("%s answers %i with reason %s", async (refusal, status, reason) => {
    serve(tokenState([], { refusal }));
    const res = await post({ token: TOKEN });
    expect(res.status).toBe(status);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { error: string; reason: string; retryAt?: string | null };
    expect(body.reason).toBe(reason);
    expect(body.error).toBeTruthy();
    if (reason === "rate-limited") expect(body.retryAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("a listing GitHub filtered for SAML single sign-on", () => {
  const SSO = new Map([
    ["octo-org", 21955855],
    ["zeta", 20582480],
  ]);

  it("counts only what GitHub listed, and says which organizations withheld theirs", async () => {
    const repos = manyRepos(100);
    serve(tokenState(repos, { scopes: "repo", ssoUnauthorized: SSO }));
    const body = (await (await post({ token: CLASSIC })).json()) as Page;
    const listed = repos.filter((r) => !SSO.has(r.owner.login));
    expect(body.reached).toBe(listed.length);
    expect(body.total).toBe(listed.length);
    expect(body).toMatchObject({
      ssoPartialResults: true,
      ssoWithheldOrganizations: 2,
      ssoWithheldOrganizationIds: ["21955855", "20582480"],
    });
    expect(body.rows.some((r) => r.fullName.startsWith("octo-org/") || r.fullName.startsWith("zeta/"))).toBe(false);
  });

  it("says nothing was withheld when GitHub sends no X-GitHub-SSO", async () => {
    serve(tokenState(manyRepos(5), { scopes: "repo" }));
    const body = (await (await post({ token: CLASSIC })).json()) as Page;
    expect(body).toMatchObject({
      ssoPartialResults: false,
      ssoWithheldOrganizations: 0,
      ssoWithheldOrganizationIds: [],
    });
  });

  it("says results were withheld even when GitHub names no organization", async () => {
    const github = fakeTokenGitHub(tokenState(manyRepos(5), { scopes: "repo" }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const res = await github.fetch(input, init);
        return providerResponse(await res.json(), {
          headers: { ...Object.fromEntries(res.headers), "x-github-sso": "partial-results" },
        });
      }),
    );
    const body = (await (await post({ token: CLASSIC })).json()) as Page;
    expect(body).toMatchObject({
      ssoPartialResults: true,
      ssoWithheldOrganizations: 0,
      ssoWithheldOrganizationIds: [],
    });
  });

  it("keeps saying so on every page and search the cached listing answers", async () => {
    serve(tokenState(manyRepos(100), { scopes: "repo", ssoUnauthorized: SSO }));
    for (const request of [{ page: 2 }, { q: "acme" }, { visibility: "private" }]) {
      const body = (await (await post({ token: CLASSIC, ...request })).json()) as Page;
      expect(body.ssoWithheldOrganizations).toBe(2);
    }
  });

  it("reads GitHub again on `refresh`, and only then, so an organization authorized since is counted", async () => {
    const state = tokenState(manyRepos(10), { scopes: "repo", ssoUnauthorized: new Map(SSO) });
    const github = serve(state);
    expect(((await (await post({ token: CLASSIC })).json()) as Page).ssoWithheldOrganizations).toBe(2);
    state.ssoUnauthorized.clear();
    expect(((await (await post({ token: CLASSIC, page: 1 })).json()) as Page).ssoWithheldOrganizations).toBe(2);
    const fresh = (await (await post({ token: CLASSIC, refresh: true })).json()) as Page;
    expect(fresh).toMatchObject({ reached: 10, ssoPartialResults: false });
    expect(github.requests.filter((r) => r.path === "/user/repos")).toHaveLength(2);
  });

  it.each([
    ["a string", "yes"],
    ["a number", 1],
    ["null", null],
  ])("refuses `refresh` given as %s", async (_, refresh) => {
    const github = serve(tokenState(manyRepos(3)));
    expect((await post({ token: CLASSIC, refresh })).status).toBe(400);
    expect(github.requests).toEqual([]);
  });

  it("refuses an exact owner/name in a withheld organization as org-blocked, not as absent", async () => {
    serve(tokenState([...manyRepos(5), listedRepo("octo-org/secret")], { scopes: "repo", ssoUnauthorized: SSO }));
    const res = await post({ token: CLASSIC, q: "octo-org/secret" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reason: string }).reason).toBe("org-blocked");
  });
});

describe("the token never leaves the request", () => {
  it.each([
    ["a listing", tokenState(manyRepos(30), { scopes: "repo" })],
    ["a lookup", tokenState(manyRepos(2), { unlisted: [listedRepo("acme/far")] })],
    ["a rejected token", tokenState([], { refusal: "bad-credentials" })],
    ["GitHub down", tokenState([], { refusal: "unavailable" })],
  ])("not in the response or any log line: %s", async (_, state) => {
    serve(state);
    for (const token of [TOKEN, CLASSIC]) {
      signIn();
      const res = await post({ token, q: "acme/far" });
      expect(await res.text()).not.toContain(token);
    }
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
    expect(JSON.stringify(logs)).not.toContain(CLASSIC);
  });

  it("not in a log line when the request itself throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(`connect failed for ${TOKEN}`);
      }),
    );
    const res = await post({ token: TOKEN });
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain(TOKEN);
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
  });
});
