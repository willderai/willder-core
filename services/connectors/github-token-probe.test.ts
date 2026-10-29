// The GitHub token probe against GitHub's own answer shapes (fixtures/github-token.ts):
// the listing a token reaches across pages, what kind of token it is and whether GitHub
// says it can write, which parts of one repository it may read, and every refusal
// GitHub sends, none of which may carry the token into an error.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitHubProbeError,
  MAX_LISTED_REPOSITORIES,
  cachedTokenRepositories,
  findRepository,
  looksLikeGitHubToken,
  readTokenRepositories,
  unreadableParts,
} from "./github-token-probe";
import { fakeTokenGitHub, listedRepo, manyRepos, tokenState, type FakeTokenState } from "./fixtures/github-token";
import { providerResponse } from "./fixtures/provider-response";

/** Token-shaped strings assembled at runtime, so no literal token sits in the repository. */
const FINE_GRAINED = ["github", "_pat_", "11AAAA", "x".repeat(76)].join("");
const CLASSIC = ["gh", "p_", "Q".repeat(36)].join("");
const LEGACY_CLASSIC = "a1".repeat(20);
const APP_USER = ["gh", "u_", "R".repeat(36)].join("");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function serve(state: FakeTokenState) {
  const github = fakeTokenGitHub(state);
  vi.stubGlobal("fetch", vi.fn(github.fetch));
  return github;
}

async function refusal(promise: Promise<unknown>): Promise<GitHubProbeError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(GitHubProbeError);
  return error as GitHubProbeError;
}

describe("looksLikeGitHubToken", () => {
  it.each([FINE_GRAINED, CLASSIC, LEGACY_CLASSIC, APP_USER])("accepts a token in GitHub's alphabet (%#)", (token) => {
    expect(looksLikeGitHubToken(token)).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["too short", "ghp_abc"],
    ["a header break", `${CLASSIC}\r\nX-Evil: 1`],
    ["a space", `${CLASSIC} ${CLASSIC}`],
    ["a URL", "https://api.github.com/user"],
    ["too long", "a".repeat(300)],
  ])("refuses %s", (_, token) => {
    expect(looksLikeGitHubToken(token)).toBe(false);
  });
});

describe("readTokenRepositories", () => {
  it("reads every page GitHub lists, 100 at a time in name order, with the token as a Bearer credential", async () => {
    const github = serve(tokenState(manyRepos(250)));
    const result = await readTokenRepositories(FINE_GRAINED);

    expect(result.repositories).toHaveLength(250);
    expect(result.truncated).toBe(false);
    const pages = github.requests.map((r) => r.query.page).sort();
    expect(pages).toEqual(["1", "2", "3"]);
    for (const request of github.requests) {
      expect(request.path).toBe("/user/repos");
      expect(request.query).toMatchObject({ per_page: "100", sort: "full_name" });
      expect(request.authorization).toBe(`Bearer ${FINE_GRAINED}`);
    }
  });

  it("reads a 1,000-repository token whole in ten requests", async () => {
    const github = serve(tokenState(manyRepos(1_000)));
    const result = await readTokenRepositories(FINE_GRAINED);
    expect(result.repositories).toHaveLength(1_000);
    expect(new Set(result.repositories.map((r) => r.fullName)).size).toBe(1_000);
    expect(github.requests).toHaveLength(10);
    expect(result.truncated).toBe(false);
  });

  it("stops at the listing cap and says so, rather than reading without end", async () => {
    const github = serve(tokenState(manyRepos(MAX_LISTED_REPOSITORIES + 50)));
    const result = await readTokenRepositories(FINE_GRAINED);
    expect(result.repositories).toHaveLength(MAX_LISTED_REPOSITORIES);
    expect(result.truncated).toBe(true);
    expect(github.requests).toHaveLength(MAX_LISTED_REPOSITORIES / 100);
  });

  it("is not truncated when the last page ends exactly at the cap", async () => {
    serve(tokenState(manyRepos(MAX_LISTED_REPOSITORIES)));
    const result = await readTokenRepositories(FINE_GRAINED);
    expect(result.repositories).toHaveLength(MAX_LISTED_REPOSITORIES);
    expect(result.truncated).toBe(false);
  });

  it("counts a repository once when the listing shifts between pages", async () => {
    const repos = manyRepos(150);
    const github = fakeTokenGitHub(tokenState(repos));
    // Page 2 answers as if one repository was created before page 1 while paging: its first entry repeats page 1's last.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await github.fetch(input, init);
        const url = new URL(String(input));
        if (url.searchParams.get("page") !== "2") return response;
        const body = (await response.json()) as unknown[];
        return providerResponse([repos[99], ...body], { headers: Object.fromEntries(response.headers) });
      }),
    );
    const result = await readTokenRepositories(FINE_GRAINED);
    expect(result.repositories).toHaveLength(150);
  });

  it("follows `next` one page at a time when GitHub sends no `last` link", async () => {
    const repos = manyRepos(230);
    const github = fakeTokenGitHub(tokenState(repos));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await github.fetch(input, init);
        const link = (response.headers.get("link") ?? "")
          .split(", ")
          .filter((rel) => !rel.endsWith('rel="last"'))
          .join(", ");
        const headers = Object.fromEntries(response.headers);
        if (link) headers.link = link;
        else delete headers.link;
        return providerResponse(await response.json(), { headers });
      }),
    );
    const result = await readTokenRepositories(FINE_GRAINED);
    expect(result.repositories).toHaveLength(230);
  });

  it("keeps what a picker shows of each repository and nothing it does not need", async () => {
    serve(
      tokenState([
        listedRepo("acme/widgets", {
          private: true,
          description: "Widgets.",
          archived: true,
          fork: true,
          pushedAt: "2026-10-01T09:00:00Z",
        }),
      ]),
    );
    const [repo] = (await readTokenRepositories(FINE_GRAINED)).repositories;
    expect(repo).toEqual({
      fullName: "acme/widgets",
      private: true,
      visibility: "private",
      description: "Widgets.",
      archived: true,
      fork: true,
      pushedAt: "2026-10-01T09:00:00Z",
    });
  });

  it("reads an internal repository's visibility, and a missing one from `private`", async () => {
    const internal = listedRepo("acme/handbook", { private: true, visibility: "internal" });
    const noVisibility = { ...listedRepo("acme/old", { private: true }), visibility: undefined };
    serve(tokenState([internal, noVisibility]));
    const { repositories } = await readTokenRepositories(FINE_GRAINED);
    expect(repositories.map((r) => r.visibility)).toEqual(["internal", "private"]);
  });
});

describe("the token's breadth, from GitHub's own headers", () => {
  it("a fine-grained token: GitHub reports no scopes, so whether it can write is unknown, and its expiry", async () => {
    serve(tokenState(manyRepos(3), { expiration: "2026-11-14 00:00:00 UTC" }));
    const { breadth } = await readTokenRepositories(FINE_GRAINED);
    expect(breadth).toEqual({
      kind: "fine-grained",
      scopes: null,
      canWrite: "unknown",
      writeScopes: [],
      expiresAt: "2026-11-14T00:00:00Z",
    });
  });

  it("a classic token with `repo`: it can write to every repository it reaches", async () => {
    serve(tokenState(manyRepos(3), { scopes: "repo, read:org" }));
    const { breadth } = await readTokenRepositories(CLASSIC);
    expect(breadth).toEqual({
      kind: "classic",
      scopes: ["repo", "read:org"],
      canWrite: "yes",
      writeScopes: ["repo"],
      expiresAt: null,
    });
  });

  it.each([
    ["public_repo", ["public_repo"]],
    ["read:org, public_repo", ["public_repo"]],
    ["delete_repo", ["delete_repo"]],
    ["admin:org, admin:repo_hook, workflow", ["admin:org", "admin:repo_hook", "workflow"]],
    ["read:org, some:future_scope", ["some:future_scope"]],
  ])("a classic token with %j can change things, named by the scopes that do", async (scopes, writing) => {
    serve(tokenState(manyRepos(1), { scopes }));
    const { breadth } = await readTokenRepositories(CLASSIC);
    expect(breadth.canWrite).toBe("yes");
    expect(breadth.writeScopes).toEqual(writing);
  });

  it.each([["read:org, read:user"], [""]])("a classic token whose scopes %j write no repository", async (scopes) => {
    serve(tokenState(manyRepos(1), { scopes }));
    const { breadth } = await readTokenRepositories(CLASSIC);
    expect(breadth.canWrite).toBe("no");
    expect(breadth.scopes).toEqual(scopes === "" ? [] : ["read:org", "read:user"]);
  });

  it("a classic token from before GitHub's prefixes is known by its scopes header", async () => {
    serve(tokenState(manyRepos(1), { scopes: "repo" }));
    expect((await readTokenRepositories(LEGACY_CLASSIC)).breadth).toMatchObject({ kind: "classic", canWrite: "yes" });
  });

  it("an app user token's empty scopes say nothing about its permissions", async () => {
    serve(tokenState(manyRepos(1), { scopes: "" }));
    expect((await readTokenRepositories(APP_USER)).breadth).toMatchObject({ kind: "github-app", canWrite: "unknown" });
  });

  it("an expiry GitHub sends in a shape it does not document is left out, not guessed", async () => {
    serve(tokenState(manyRepos(1), { expiration: "soon" }));
    expect((await readTokenRepositories(FINE_GRAINED)).breadth.expiresAt).toBeNull();
  });
});

describe("GitHub's refusals", () => {
  it("a rejected token", async () => {
    serve(tokenState([], { refusal: "bad-credentials" }));
    const error = await refusal(readTokenRepositories(CLASSIC));
    expect(error.reason).toBe("token-rejected");
    expect(error.message).toMatch(/GitHub rejected this token/);
  });

  it("an app installation token, which cannot list a user's repositories", async () => {
    serve(tokenState([], { refusal: "app-token" }));
    expect((await refusal(readTokenRepositories(CLASSIC))).reason).toBe("cannot-list");
  });

  it("the primary rate limit, with when it resets", async () => {
    serve(tokenState([], { refusal: "primary-rate-limit" }));
    const error = await refusal(readTokenRepositories(CLASSIC));
    expect(error.reason).toBe("rate-limited");
    expect(error.retryAt).toBe(new Date(1792015200 * 1000).toISOString());
  });

  it("the secondary rate limit, with GitHub's retry-after", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-15T12:00:00Z"), toFake: ["Date"] });
    serve(tokenState([], { refusal: "secondary-rate-limit" }));
    const error = await refusal(readTokenRepositories(CLASSIC));
    expect(error.reason).toBe("rate-limited");
    expect(error.retryAt).toBe("2026-10-15T12:01:00.000Z");
  });

  it("GitHub down, answering HTML", async () => {
    serve(tokenState([], { refusal: "unavailable" }));
    const error = await refusal(readTokenRepositories(CLASSIC));
    expect(error.reason).toBe("unavailable");
    expect(error.message).toMatch(/HTTP 503/);
  });

  it("a connection that fails before GitHub answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    expect((await refusal(readTokenRepositories(CLASSIC))).reason).toBe("unavailable");
  });

  it("a 200 whose body is not a list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => providerResponse({ message: "surprise" })),
    );
    expect((await refusal(readTokenRepositories(CLASSIC))).reason).toBe("unavailable");
  });

  it("an organization's SAML single sign-on or IP allow list is its own refusal, not a retry", async () => {
    for (const message of [
      "Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization.",
      "Although you appear to have the correct authorization credentials, the `acme` organization has an IP allow list enabled, and your IP address is not permitted to access this resource.",
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => providerResponse({ message }, { status: 403 })),
      );
      const error = await refusal(readTokenRepositories(CLASSIC));
      expect(error.reason).toBe("org-blocked");
      expect(error.message).toMatch(/Authorize the token for that organization/);
    }
  });

  it("a secondary limit sent as a 403 without retry-after names no time, rather than the primary reset", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        providerResponse(
          {
            message:
              "You have exceeded a secondary rate limit and have been temporarily blocked from content creation.",
          },
          { status: 403, headers: { "x-ratelimit-remaining": "4000", "x-ratelimit-reset": "1792015200" } },
        ),
      ),
    );
    const error = await refusal(readTokenRepositories(CLASSIC));
    expect(error.reason).toBe("rate-limited");
    expect(error.retryAt).toBeNull();
  });

  it("a Link header that is not an absolute URL reads as no more pages, never a crash", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        providerResponse([listedRepo("acme/one")], {
          headers: { link: '</user/repos?page=2>; rel="next", <not a url>; rel="last"' },
        }),
      ),
    );
    const result = await readTokenRepositories(CLASSIC);
    expect(result.repositories.map((r) => r.fullName)).toEqual(["acme/one"]);
  });

  it("a page past the first that fails fails the whole listing, never a partial one", async () => {
    const github = fakeTokenGitHub(tokenState(manyRepos(300)));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        new URL(String(input)).searchParams.get("page") === "3"
          ? providerResponse("bad gateway", { status: 502 })
          : github.fetch(input, init),
      ),
    );
    expect((await refusal(readTokenRepositories(CLASSIC))).reason).toBe("unavailable");
  });

  it.each(["bad-credentials", "app-token", "primary-rate-limit", "secondary-rate-limit", "unavailable"] as const)(
    "never puts the token in the error (%s)",
    async (kind) => {
      serve(tokenState([], { refusal: kind }));
      const error = await refusal(readTokenRepositories(CLASSIC));
      expect(error.message).not.toContain(CLASSIC);
      expect(JSON.stringify(error)).not.toContain(CLASSIC);
    },
  );
});

describe("a listing GitHub filtered for SAML single sign-on", () => {
  // GitHub answers GET /user/repos 200 without the repositories of an organization
  // whose SAML SSO has not authorized the token, and names it in
  // `X-GitHub-SSO: partial-results; organizations=<ids>`. The probe must carry that,
  // or the count it reports reads as everything the token lists.

  /** The fixture's listing, with `headerFor(page)` as each listing page's X-GitHub-SSO (null: none). */
  function serveWithSso(state: FakeTokenState, headerFor: (page: number) => string | null, dropLast = false) {
    const github = fakeTokenGitHub(state);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await github.fetch(input, init);
        const url = new URL(String(input));
        if (url.pathname !== "/user/repos") return response;
        const headers = Object.fromEntries(response.headers);
        delete headers["x-github-sso"];
        const sso = headerFor(Number(url.searchParams.get("page")));
        if (sso !== null) headers["x-github-sso"] = sso;
        if (dropLast) {
          const link = (headers.link ?? "")
            .split(", ")
            .filter((rel) => !rel.endsWith('rel="last"'))
            .join(", ");
          if (link) headers.link = link;
          else delete headers.link;
        }
        return providerResponse(await response.json(), { headers });
      }),
    );
    return github;
  }

  it("leaves the withheld organizations' repositories out and names those organizations", async () => {
    const repos = manyRepos(30);
    serve(
      tokenState(repos, {
        scopes: "repo",
        ssoUnauthorized: new Map([
          ["octo-org", 21955855],
          ["Zeta", 20582480],
        ]),
      }),
    );
    const result = await readTokenRepositories(CLASSIC);
    expect(result.repositories.map((r) => r.fullName.split("/")[0]).sort()).toEqual(
      repos
        .map((r) => r.owner.login)
        .filter((o) => o !== "octo-org" && o !== "zeta")
        .sort(),
    );
    expect(result.ssoWithheldOrganizationIds).toEqual(["21955855", "20582480"]);
  });

  it("is null when GitHub sends no X-GitHub-SSO, so a complete listing reads as complete", async () => {
    serve(tokenState(manyRepos(30), { scopes: "repo" }));
    expect((await readTokenRepositories(CLASSIC)).ssoWithheldOrganizationIds).toBeNull();
  });

  it.each([
    ["the pages read at once (GitHub sends `last`)", false],
    ["the pages followed by `next`", true],
  ])("reads the header on every page, not only the first: %s", async (_, dropLast) => {
    serveWithSso(
      tokenState(manyRepos(350), { scopes: "repo" }),
      (page) => (page === 3 ? "partial-results; organizations=7" : null),
      dropLast,
    );
    expect((await readTokenRepositories(CLASSIC)).ssoWithheldOrganizationIds).toEqual(["7"]);
  });

  it("names each organization once across pages, in the order GitHub first names it", async () => {
    serveWithSso(tokenState(manyRepos(250), { scopes: "repo" }), (page) =>
      page === 1
        ? "partial-results; organizations=21955855,20582480"
        : "partial-results; organizations=20582480,1342004",
    );
    expect((await readTokenRepositories(CLASSIC)).ssoWithheldOrganizationIds).toEqual([
      "21955855",
      "20582480",
      "1342004",
    ]);
  });

  it.each([
    ["GitHub's own spelling", "partial-results; organizations=21955855,20582480", ["21955855", "20582480"]],
    ["any case", "Partial-Results; Organizations=21955855", ["21955855"]],
    [
      "spaces around every separator",
      "  partial-results ;  organizations = 21955855 , 20582480  ",
      ["21955855", "20582480"],
    ],
    [
      "two headers that fetch joined with a comma",
      "partial-results; organizations=1,2, partial-results; organizations=3",
      ["1", "2", "3"],
    ],
    ["something that is not an organization id, dropped", "partial-results; organizations=abc,7,,-1,8x", ["7"]],
    ["results withheld with no organization named", "partial-results", []],
    ["results withheld with an empty organization list", "partial-results; organizations=", []],
    ["a parameter that only ends in `organizations`, ignored", "partial-results; xorganizations=5", []],
    [
      "`organizations=` inside another parameter's value, ignored",
      "partial-results; url=https://github.com/x?organizations=9",
      [],
    ],
    ["one id written with leading zeros, counted once", "partial-results; organizations=7,007", ["7"]],
  ])("reads %s", async (_, header, ids) => {
    serveWithSso(tokenState(manyRepos(3), { scopes: "repo" }), () => header);
    expect((await readTokenRepositories(CLASSIC)).ssoWithheldOrganizationIds).toEqual(ids);
  });

  it.each([
    [
      "`required`, which GitHub sends with a refusal",
      "required; url=https://github.com/orgs/acme/sso?authorization_request=X",
    ],
    ["a word that only starts like it", "partial-resultsx; organizations=5"],
    ["an empty header", ""],
  ])("does not read %s on a listing as withheld results", async (_, header) => {
    serveWithSso(tokenState(manyRepos(3), { scopes: "repo" }), () => header);
    expect((await readTokenRepositories(CLASSIC)).ssoWithheldOrganizationIds).toBeNull();
  });

  // Load-independent: a hostile header of 100,000 characters against one of 10,000, read in the
  // same run (best of three each, the smaller counted as at least 1 ms). A linear read grows
  // about 10x, a backtracking one about 100x. Each read must also still say what it found.
  it("reads a hostile 100,000-character header in linear time, and still reads it right", async () => {
    const headers: [build: (n: number) => string, per100k: number][] = [
      [(n) => `partial-results;${"organizations=;".repeat(n)}`, 7_000],
      [(n) => `partial-results; organizations=${" ,".repeat(n)}`, 50_000],
      [(n) => "partial-results,".repeat(n), 6_000],
    ];
    const bestOfThree = async (header: string) => {
      serveWithSso(tokenState(manyRepos(1), { scopes: "repo" }), () => header);
      const times: number[] = [];
      for (let run = 0; run < 3; run++) {
        const started = performance.now();
        const listing = await readTokenRepositories(CLASSIC);
        times.push(performance.now() - started);
        // Results were withheld, and no organization is named.
        expect(listing.ssoWithheldOrganizationIds).toEqual([]);
      }
      return Math.min(...times);
    };
    for (const [build, per100k] of headers) {
      const small = await bestOfThree(build(per100k / 10));
      const large = await bestOfThree(build(per100k));
      expect(large / Math.max(small, 1)).toBeLessThan(30);
    }
  });

  it("refuses a direct read of a withheld organization's repository as org-blocked", async () => {
    serve(
      tokenState([listedRepo("octo-org/secret")], {
        scopes: "repo",
        ssoUnauthorized: new Map([["octo-org", 21955855]]),
      }),
    );
    expect((await refusal(findRepository(CLASSIC, "octo-org/secret"))).reason).toBe("org-blocked");
    expect((await refusal(unreadableParts(CLASSIC, "octo-org/secret"))).reason).toBe("org-blocked");
  });

  it.each([
    ["partial-results", "partial-results; organizations=21955855"],
    ["a word that only ends like `required`", "notrequired; url=https://github.com/orgs/acme/sso"],
  ])("does not read a 403 whose X-GitHub-SSO says %s as org-blocked", async (_, header) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        providerResponse(
          { message: "Resource not accessible by integration" },
          { status: 403, headers: { "x-github-sso": header } },
        ),
      ),
    );
    expect((await refusal(readTokenRepositories(CLASSIC))).reason).toBe("cannot-list");
  });

  it("reads a part refused with X-GitHub-SSO: required as org-blocked, even when the body reads like a missing permission", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        providerResponse(
          { message: "Resource not accessible by personal access token" },
          {
            status: 403,
            headers: { "x-github-sso": "required; url=https://github.com/orgs/acme/sso?authorization_request=X" },
          },
        ),
      ),
    );
    expect((await refusal(unreadableParts(CLASSIC, "acme/widgets"))).reason).toBe("org-blocked");
  });

  it("knows a SAML refusal by its X-GitHub-SSO header even when GitHub words the body differently", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        providerResponse(
          { message: "Forbidden" },
          {
            status: 403,
            headers: { "x-github-sso": "required; url=https://github.com/orgs/acme/sso?authorization_request=X" },
          },
        ),
      ),
    );
    const error = await refusal(findRepository(CLASSIC, "acme/widgets"));
    expect(error.reason).toBe("org-blocked");
    expect(error.message).not.toContain(CLASSIC);
  });
});

describe("cachedTokenRepositories", () => {
  it("answers a second ask for the same key from the first reading, and reads again after a minute", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-15T12:00:00Z"), toFake: ["Date"] });
    const github = serve(tokenState(manyRepos(120)));
    await cachedTokenRepositories("org:user:a", FINE_GRAINED);
    await cachedTokenRepositories("org:user:a", FINE_GRAINED);
    expect(github.requests).toHaveLength(2);

    vi.setSystemTime(Date.parse("2026-10-15T12:01:01Z"));
    await cachedTokenRepositories("org:user:a", FINE_GRAINED);
    expect(github.requests).toHaveLength(4);
  });

  it("shares a read still in flight, so a search typed during the first read starts no second one", async () => {
    const github = serve(tokenState(manyRepos(250)));
    const [a, b] = await Promise.all([
      cachedTokenRepositories("org:user:inflight", FINE_GRAINED),
      cachedTokenRepositories("org:user:inflight", FINE_GRAINED),
    ]);
    expect(a).toBe(b);
    expect(github.requests).toHaveLength(3);
  });

  it("never answers one key from another key's reading", async () => {
    const github = serve(tokenState(manyRepos(5)));
    await cachedTokenRepositories("org:user:b", FINE_GRAINED);
    await cachedTokenRepositories("org:user:c", FINE_GRAINED);
    expect(github.requests).toHaveLength(2);
  });

  it("does not keep a refusal, so a retry asks GitHub again", async () => {
    const state = tokenState(manyRepos(5), { refusal: "unavailable" });
    const github = serve(state);
    await refusal(cachedTokenRepositories("org:user:d", FINE_GRAINED));
    state.refusal = null;
    expect((await cachedTokenRepositories("org:user:d", FINE_GRAINED)).repositories).toHaveLength(5);
    expect(github.requests).toHaveLength(2);
  });
});

describe("cachedTokenRepositories, asked to read again", () => {
  it("reads GitHub again when asked, so an organization authorized since shows up", async () => {
    const state = tokenState(manyRepos(10), { scopes: "repo", ssoUnauthorized: new Map([["acme", 7]]) });
    const github = serve(state);
    const key = `refresh-${Math.random()}`;
    expect((await cachedTokenRepositories(key, CLASSIC)).ssoWithheldOrganizationIds).toEqual(["7"]);
    state.ssoUnauthorized.clear();
    expect((await cachedTokenRepositories(key, CLASSIC)).ssoWithheldOrganizationIds).toEqual(["7"]);
    expect((await cachedTokenRepositories(key, CLASSIC, { refresh: true })).ssoWithheldOrganizationIds).toBeNull();
    expect((await cachedTokenRepositories(key, CLASSIC)).repositories).toHaveLength(10);
    expect(github.requests.filter((r) => r.path === "/user/repos")).toHaveLength(2);
  });

  /** The fake GitHub, holding every answer until `release` is called, so a read stays in flight. */
  function serveHeld(state: FakeTokenState) {
    const github = fakeTokenGitHub(state);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        await held;
        return github.fetch(input, init);
      }),
    );
    return { listings: () => github.requests.filter((r) => r.path === "/user/repos").length, release };
  }

  it.each([
    ["a refresh joins a plain read in flight", [false, true]],
    ["a plain read joins a refresh in flight", [true, false]],
  ])("%s instead of starting another listing", async (_, refreshes) => {
    const github = serveHeld(tokenState(manyRepos(10), { scopes: "repo" }));
    const key = `refresh-join-${Math.random()}`;
    const reads = refreshes.map((refresh) => cachedTokenRepositories(key, CLASSIC, { refresh }));
    github.release();
    await Promise.all(reads);
    expect(github.listings()).toBe(1);
  });

  it("reads GitHub again for a refresh once the reads it joined have finished", async () => {
    const github = serve(tokenState(manyRepos(10), { scopes: "repo" }));
    const key = `refresh-after-${Math.random()}`;
    await Promise.all([
      cachedTokenRepositories(key, CLASSIC, { refresh: true }),
      cachedTokenRepositories(key, CLASSIC, { refresh: true }),
    ]);
    await cachedTokenRepositories(key, CLASSIC, { refresh: true });
    expect(github.requests.filter((r) => r.path === "/user/repos")).toHaveLength(2);
  });

  it("joins a read still in flight past the minute instead of starting a second", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const github = serveHeld(tokenState(manyRepos(10), { scopes: "repo" }));
    const key = `refresh-slow-${Math.random()}`;
    const first = cachedTokenRepositories(key, CLASSIC);
    vi.setSystemTime(Date.now() + 61_000);
    const later = cachedTokenRepositories(key, CLASSIC);
    const refreshed = cachedTokenRepositories(key, CLASSIC, { refresh: true });
    github.release();
    await Promise.all([first, later, refreshed]);
    expect(github.listings()).toBe(1);
  });

  it("keeps a read in flight when 50 other listings arrive, so an overlapping refresh still joins it", async () => {
    const github = serveHeld(tokenState(manyRepos(10), { scopes: "repo" }));
    const key = `refresh-evict-${Math.random()}`;
    const first = cachedTokenRepositories(key, CLASSIC, { refresh: true });
    const others = Array.from({ length: 50 }, (_, i) =>
      cachedTokenRepositories(`refresh-evict-other-${i}-${Math.random()}`, CLASSIC),
    );
    const second = cachedTokenRepositories(key, CLASSIC, { refresh: true });
    github.release();
    await Promise.all([first, second, ...others]);
    expect(github.listings()).toBe(51);
  });

  it("drops the oldest finished listing past 50, and keeps the newest", async () => {
    const github = serve(tokenState(manyRepos(10), { scopes: "repo" }));
    const keys = Array.from({ length: 51 }, (_, i) => `refresh-cap-${i}-${Math.random()}`);
    for (const key of keys) await cachedTokenRepositories(key, CLASSIC);
    await cachedTokenRepositories(keys[50]!, CLASSIC);
    expect(github.requests.filter((r) => r.path === "/user/repos")).toHaveLength(51);
    await cachedTokenRepositories(keys[0]!, CLASSIC);
    expect(github.requests.filter((r) => r.path === "/user/repos")).toHaveLength(52);
  });

  it("fails a refresh that joined a refused read, and asks GitHub again on the next one", async () => {
    const state = tokenState(manyRepos(5), { refusal: "unavailable" });
    const github = serve(state);
    const key = `refresh-refused-${Math.random()}`;
    const [a, b] = [
      cachedTokenRepositories(key, FINE_GRAINED, { refresh: true }),
      cachedTokenRepositories(key, FINE_GRAINED, { refresh: true }),
    ];
    await refusal(a);
    await refusal(b);
    state.refusal = null;
    expect((await cachedTokenRepositories(key, FINE_GRAINED, { refresh: true })).repositories).toHaveLength(5);
    expect(github.requests).toHaveLength(2);
  });
});

describe("findRepository", () => {
  it("finds a repository the listing does not hold, by its name in any case", async () => {
    const github = serve(tokenState([], { unlisted: [listedRepo("Acme/Far-Away", { private: true })] }));
    expect(await findRepository(FINE_GRAINED, "acme/far-away")).toMatchObject({
      fullName: "Acme/Far-Away",
      private: true,
    });
    expect(github.requests[0]).toMatchObject({ path: "/repos/acme/far-away", authorization: `Bearer ${FINE_GRAINED}` });
  });

  it("answers null for a repository the token cannot see", async () => {
    serve(tokenState([]));
    expect(await findRepository(FINE_GRAINED, "acme/hidden")).toBeNull();
  });

  it("refuses a name that is not owner/name before asking GitHub, so no other path can be reached", async () => {
    const github = serve(tokenState([]));
    for (const name of [
      "acme/widgets/../../user",
      "../user",
      "acme",
      "acme/widgets?x=1",
      "acme/%2e%2e",
      "acme/..",
      "acme/.",
    ]) {
      await expect(findRepository(FINE_GRAINED, name)).rejects.toThrow(/owner\/name/);
    }
    expect(github.requests).toEqual([]);
  });

  it("passes GitHub's refusals on as probe errors", async () => {
    serve(tokenState([], { refusal: "bad-credentials" }));
    expect((await refusal(findRepository(FINE_GRAINED, "acme/widgets"))).reason).toBe("token-rejected");
  });
});

describe("unreadableParts", () => {
  it("names the parts GitHub refuses for lack of permission, in the order a sync reads them", async () => {
    const repo = listedRepo("acme/widgets");
    serve(tokenState([repo], { forbidden: new Map([["acme/widgets", new Set(["pulls", "issues"] as const)]]) }));
    expect(await unreadableParts(FINE_GRAINED, "acme/widgets")).toEqual(["issues", "pulls"]);
  });

  it("counts a missing README, issues turned off (410) and an empty repository's commits (409) as readable", async () => {
    const repo = listedRepo("acme/widgets");
    const github = fakeTokenGitHub(tokenState([repo], { noReadme: new Set(["acme/widgets"]) }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/issues"))
          return providerResponse({ message: "Issues are disabled for this repo", status: "410" }, { status: 410 });
        if (path.endsWith("/commits"))
          return providerResponse({ message: "Git Repository is empty.", status: "409" }, { status: 409 });
        return github.fetch(input, init);
      }),
    );
    expect(await unreadableParts(FINE_GRAINED, "acme/widgets")).toEqual([]);
  });

  it("asks one item of each part, with the token", async () => {
    const github = serve(tokenState([listedRepo("acme/widgets")]));
    await unreadableParts(FINE_GRAINED, "acme/widgets");
    expect(github.requests.map((r) => r.path).sort()).toEqual([
      "/repos/acme/widgets/commits",
      "/repos/acme/widgets/issues",
      "/repos/acme/widgets/pulls",
      "/repos/acme/widgets/readme",
    ]);
    expect(github.requests.every((r) => r.authorization === `Bearer ${FINE_GRAINED}`)).toBe(true);
    expect(github.requests.filter((r) => r.query.per_page !== undefined).every((r) => r.query.per_page === "1")).toBe(
      true,
    );
  });

  it("a rate limit on one part is a probe error, never a part marked unreadable", async () => {
    const repo = listedRepo("acme/widgets");
    const github = fakeTokenGitHub(tokenState([repo]));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        new URL(String(input)).pathname.endsWith("/pulls")
          ? providerResponse(
              { message: "API rate limit exceeded for user ID 1." },
              { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1792015200" } },
            )
          : github.fetch(input, init),
      ),
    );
    expect((await refusal(unreadableParts(FINE_GRAINED, "acme/widgets"))).reason).toBe("rate-limited");
  });

  it("an organization blocking the token on one part is a probe error that says so", async () => {
    const github = fakeTokenGitHub(tokenState([listedRepo("acme/widgets")]));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        new URL(String(input)).pathname.endsWith("/readme")
          ? providerResponse({ message: "Resource protected by organization SAML enforcement." }, { status: 403 })
          : github.fetch(input, init),
      ),
    );
    expect((await refusal(unreadableParts(FINE_GRAINED, "acme/widgets"))).reason).toBe("org-blocked");
  });

  it("refuses a name that is not owner/name before asking GitHub", async () => {
    const github = serve(tokenState([]));
    await expect(unreadableParts(FINE_GRAINED, "acme/../../user")).rejects.toThrow(/owner\/name/);
    expect(github.requests).toEqual([]);
  });
});
