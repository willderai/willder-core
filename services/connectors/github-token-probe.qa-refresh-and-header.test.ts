// QA tests for the token probe, written by the reviewer: how `X-GitHub-SSO` is
// read on a listing page, and how a `refresh` read shares GitHub with a read
// already in flight. A refresh exists so a person who just authorized the token
// for an organization's SSO sees it counted; it must not let one person start a
// full re-read of the token's listing (up to 20 GitHub requests) per request.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cachedTokenRepositories, readTokenRepositories } from "./github-token-probe";
import { fakeTokenGitHub, manyRepos, tokenState } from "./fixtures/github-token";
import { providerResponse } from "./fixtures/provider-response";

/** Token-shaped string assembled at runtime, so no literal token sits in the repository. */
const CLASSIC = ["gh", "p_", "L".repeat(36)].join("");

afterEach(() => vi.unstubAllGlobals());

/** The fixture's listing with `header` as every listing page's X-GitHub-SSO. */
function serveListingWithSso(header: string) {
  const github = fakeTokenGitHub(tokenState(manyRepos(3), { scopes: "repo" }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await github.fetch(input, init);
      if (new URL(String(input)).pathname !== "/user/repos") return response;
      const headers = Object.fromEntries(response.headers);
      headers["x-github-sso"] = header;
      return providerResponse(await response.json(), { headers });
    }),
  );
}

describe("X-GitHub-SSO on a listing page (QA)", () => {
  it.each([
    ["a word that only ends in `partial-results`", "notpartial-results; organizations=5"],
    ["`partial-results` as a parameter value, not the directive", "required; reason=partial-results"],
  ])("does not read %s as withheld results", async (_, header) => {
    serveListingWithSso(header);
    expect((await readTokenRepositories(CLASSIC)).ssoWithheldOrganizationIds).toBeNull();
  });

  it("reads `partial-results` after another directive fetch joined to it", async () => {
    serveListingWithSso("required; url=https://github.com/orgs/a/sso, partial-results; organizations=42");
    expect((await readTokenRepositories(CLASSIC)).ssoWithheldOrganizationIds).toEqual(["42"]);
  });

  it("reads `partial-results` with no organizations before another directive fetch joined to it", async () => {
    serveListingWithSso("partial-results, required; url=https://github.com/orgs/a/sso");
    expect((await readTokenRepositories(CLASSIC)).ssoWithheldOrganizationIds).toEqual([]);
  });

  it("counts a large organization list once per id", async () => {
    const ids = Array.from({ length: 500 }, (_, i) => String(1000 + i));
    serveListingWithSso(`partial-results; organizations=${[...ids, ...ids].join(",")}`);
    expect((await readTokenRepositories(CLASSIC)).ssoWithheldOrganizationIds).toHaveLength(500);
  });
});

describe("cachedTokenRepositories with refresh (QA)", () => {
  it("joins a read already in flight instead of starting another full listing", async () => {
    const github = fakeTokenGitHub(tokenState(manyRepos(250), { scopes: "repo" }));
    vi.stubGlobal("fetch", vi.fn(github.fetch));
    const key = `qa-refresh-inflight-${Math.random()}`;
    // A person pressing Check again twice, or a script sending refresh in a loop:
    // every request after the first arrives while the first read is still running.
    await Promise.all([
      cachedTokenRepositories(key, CLASSIC, { refresh: true }),
      cachedTokenRepositories(key, CLASSIC, { refresh: true }),
      cachedTokenRepositories(key, CLASSIC, { refresh: true }),
    ]);
    // One full listing of 250 repositories is 3 pages.
    expect(github.requests.filter((r) => r.path === "/user/repos")).toHaveLength(3);
  });
});
