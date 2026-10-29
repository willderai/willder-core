// QA tests for POST /api/sources/github/repositories, written by the reviewer:
// the listing cache must never answer one token's request with another token's
// listing or breadth, nor carry across organizations, and its key must not hold
// the token. And a listing GitHub filtered for SAML single sign-on must say so,
// so its count never reads as everything the token reaches.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: vi.fn(() => false), per: { hour: 3_600_000 } }));
vi.mock("@/services/connectors/github-token-probe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/connectors/github-token-probe")>();
  return { ...actual, cachedTokenRepositories: vi.fn(actual.cachedTokenRepositories) };
});

import { requireAccessContext } from "@/lib/access-context";
import { cachedTokenRepositories } from "@/services/connectors/github-token-probe";
import {
  fakeTokenGitHub,
  manyRepos,
  tokenState,
  type FakeTokenState,
} from "@/services/connectors/fixtures/github-token";
import { POST } from "./route";

const FINE_GRAINED = ["github", "_pat_", "11QAQA", "q".repeat(76)].join("");
const CLASSIC = ["gh", "p_", "W".repeat(36)].join("");

let userSeq = 0;
function signIn(orgId = "org_qa", userId = `qa_user_${++userSeq}`) {
  vi.mocked(requireAccessContext).mockResolvedValue({
    org: { id: orgId },
    user: { id: userId },
    ctx: { orgId, actor: { type: "human", id: userId, role: "member" } },
  } as never);
}

/** One fake GitHub per token, as api.github.com answers each credential differently. */
function serveByToken(states: Record<string, FakeTokenState>, extraListingHeaders: Record<string, string> = {}) {
  const fakes = Object.fromEntries(Object.entries(states).map(([token, state]) => [token, fakeTokenGitHub(state)]));
  const listingReads: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      const token = auth.replace(/^Bearer /, "");
      const fake = fakes[token];
      if (!fake) throw new Error("no fake GitHub for this credential");
      const res = await fake.fetch(input, init);
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname !== "/user/repos") return res;
      listingReads.push(token);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(extraListingHeaders)) headers.set(k, v);
      return new Response(await res.text(), { status: res.status, headers });
    }),
  );
  return { listingReads };
}

async function page(body: unknown) {
  const res = await POST(
    new Request("http://test/api/sources/github/repositories", { method: "POST", body: JSON.stringify(body) }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    token: { kind: string; canWrite: string };
    reached: number;
    truncated: boolean;
    total: number;
  } & Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  signIn();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the listing cache", () => {
  it("never answers a second token from the same person with the first token's listing or breadth", async () => {
    serveByToken({
      [FINE_GRAINED]: tokenState(manyRepos(3)),
      [CLASSIC]: tokenState(manyRepos(40), { scopes: "repo, delete_repo" }),
    });
    const first = await page({ token: FINE_GRAINED });
    expect(first).toMatchObject({ reached: 3, token: { kind: "fine-grained", canWrite: "unknown" } });
    const second = await page({ token: CLASSIC });
    expect(second).toMatchObject({ reached: 40, token: { kind: "classic", canWrite: "yes" } });
  });

  it("reads again for the same person and token in another organization", async () => {
    const { listingReads } = serveByToken({ [FINE_GRAINED]: tokenState(manyRepos(3)) });
    signIn("org_a", "qa_same_person");
    await page({ token: FINE_GRAINED });
    signIn("org_b", "qa_same_person");
    await page({ token: FINE_GRAINED });
    expect(listingReads).toHaveLength(2);
  });

  it("is keyed by a hash of the token, never the token itself", async () => {
    serveByToken({ [FINE_GRAINED]: tokenState(manyRepos(3)) });
    await page({ token: FINE_GRAINED });
    const key = vi.mocked(cachedTokenRepositories).mock.calls.at(-1)?.[0];
    expect(key).toBeTypeOf("string");
    expect(key).not.toContain(FINE_GRAINED);
    expect(key).toMatch(/[0-9a-f]{64}$/);
  });
});

describe("a listing GitHub filtered for SAML single sign-on", () => {
  // GitHub does not refuse GET /user/repos when an organization's SAML SSO has not
  // authorized a classic token: it answers 200 without that organization's
  // repositories and sends `X-GitHub-SSO: partial-results; organizations=<ids>`
  // (docs.github.com, "Authenticating to the REST API", SAML SSO). The count the
  // form shows ("lists 12 repositories") then hides the withheld ones, and the
  // person cannot find their organization's repository in the list.
  it("tells the form that an organization withheld repositories, so the count is not read as all of them", async () => {
    serveByToken(
      { [CLASSIC]: tokenState(manyRepos(12), { scopes: "repo" }) },
      { "x-github-sso": "partial-results; organizations=21955855,20582480" },
    );
    const body = await page({ token: CLASSIC });
    expect(body.reached).toBe(12);
    // Field name is the reviewer's suggestion; any field the form turns into a line
    // naming SSO (and the withheld organization count) satisfies the intent.
    expect(body).toHaveProperty("ssoWithheldOrganizations", 2);
  });
});
