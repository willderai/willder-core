// POST /api/sources/github/reach against a GitHub that answers in its own shapes:
// the picked repository and the parts of it the token may not read, refused before
// GitHub is asked when the name or token is malformed, and never echoing the token.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: vi.fn(() => false), per: { hour: 3_600_000 } }));

import { requireAccessContext } from "@/lib/access-context";
import { isRateLimited } from "@/lib/rate-limit";
import {
  fakeTokenGitHub,
  listedRepo,
  tokenState,
  type FakeTokenState,
} from "@/services/connectors/fixtures/github-token";
import { providerResponse } from "@/services/connectors/fixtures/provider-response";
import { POST } from "./route";

const TOKEN = ["github", "_pat_", "11CCCC", "z".repeat(76)].join("");

function serve(state: FakeTokenState) {
  const github = fakeTokenGitHub(state);
  vi.stubGlobal("fetch", vi.fn(github.fetch));
  return github;
}

function post(body: unknown) {
  return POST(
    new Request("http://test/api/sources/github/reach", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isRateLimited).mockReturnValue(false);
  vi.mocked(requireAccessContext).mockResolvedValue({
    org: { id: "org_1" },
    user: { id: "user_7" },
    ctx: { orgId: "org_1", actor: { type: "human", id: "user_7", role: "member" } },
  } as never);
});

afterEach(() => vi.unstubAllGlobals());

describe("POST /api/sources/github/reach", () => {
  it("refuses a request with no signed-in person, before GitHub is asked", async () => {
    const github = serve(tokenState([listedRepo("acme/widgets")]));
    vi.mocked(requireAccessContext).mockResolvedValue(null);
    expect((await post({ token: TOKEN, repo: "acme/widgets" })).status).toBe(401);
    expect(github.requests).toEqual([]);
  });

  it("shares the person's probe limit with the listing", async () => {
    const github = serve(tokenState([listedRepo("acme/widgets")]));
    vi.mocked(isRateLimited).mockReturnValue(true);
    expect((await post({ token: TOKEN, repo: "acme/widgets" })).status).toBe(429);
    expect(vi.mocked(isRateLimited).mock.calls[0][0]).toBe("sources:github-probe:org_1:user_7");
    expect(github.requests).toEqual([]);
  });

  it.each([
    ["no repo", { token: TOKEN }],
    ["a repo that walks out of /repos", { token: TOKEN, repo: "acme/.." }],
    ["a repo with a path", { token: TOKEN, repo: "acme/widgets/../../user" }],
    ["a repo that is not a string", { token: TOKEN, repo: { owner: "acme" } }],
    ["no token", { repo: "acme/widgets" }],
    ["a malformed token", { token: "not a token", repo: "acme/widgets" }],
    ["a body that is not JSON", "nope"],
  ])("refuses %s with 400, before GitHub is asked", async (_, body) => {
    const github = serve(tokenState([listedRepo("acme/widgets")]));
    expect((await post(body)).status).toBe(400);
    expect(github.requests).toEqual([]);
  });

  it("answers the repository and the parts the token may not read", async () => {
    serve(
      tokenState([listedRepo("acme/widgets", { private: true })], {
        forbidden: new Map([["acme/widgets", new Set(["issues"] as const)]]),
      }),
    );
    const res = await post({ token: TOKEN, repo: "acme/widgets" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      repo: expect.objectContaining({ fullName: "acme/widgets", private: true, visibility: "private" }),
      unreadable: ["issues"],
    });
  });

  it("answers 404 for a repository the token cannot see, without guessing its parts", async () => {
    const github = serve(tokenState([]));
    const res = await post({ token: TOKEN, repo: "acme/hidden" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toMatch(/cannot see acme\/hidden/);
    expect(github.requests.map((r) => r.path)).toEqual(["/repos/acme/hidden"]);
  });

  it("a rate limit on a part is 429, never a part marked unreadable", async () => {
    const github = fakeTokenGitHub(tokenState([listedRepo("acme/widgets")]));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        new URL(String(input)).pathname.endsWith("/commits")
          ? providerResponse(
              { message: "API rate limit exceeded for user ID 1." },
              { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1792015200" } },
            )
          : github.fetch(input, init),
      ),
    );
    const res = await post({ token: TOKEN, repo: "acme/widgets" });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { reason: string }).reason).toBe("rate-limited");
  });

  it("a repository in an organization whose SAML single sign-on has not authorized the token is 400 org-blocked", async () => {
    serve(tokenState([listedRepo("octo-org/secret")], { ssoUnauthorized: new Map([["octo-org", 21955855]]) }));
    const res = await post({ token: TOKEN, repo: "octo-org/secret" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reason: string }).reason).toBe("org-blocked");
  });

  it("a rejected token is 400 with GitHub's reason, and the token is never in the reply", async () => {
    serve(tokenState([], { refusal: "bad-credentials" }));
    const res = await post({ token: TOKEN, repo: "acme/widgets" });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toMatch(/token-rejected/);
    expect(text).not.toContain(TOKEN);
  });
});
