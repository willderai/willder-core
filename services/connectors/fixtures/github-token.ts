// What api.github.com answers a token that is asked what it can reach, before any
// repository is connected: `GET /user/repos` paged with a `Link` header, carrying
// the token's classic scopes in `X-OAuth-Scopes` and its expiry in
// `GitHub-Authentication-Token-Expiration`, and `GET /repos/:owner/:name` with
// the part reads a sync makes. Every refusal is GitHub's own: 401 "Bad
// credentials", 403 "Resource not accessible by integration" for an app token,
// the primary (403) and secondary (429) rate limits, and 404 for a repository
// the token cannot see.
//
// An organization whose SAML single sign-on has not authorized the token is not a
// refusal of the listing: GitHub answers `GET /user/repos` 200 without that
// organization's repositories and names it in `X-GitHub-SSO: partial-results;
// organizations=<ids>`. Only a read of one of its repositories is refused, 403
// "Resource protected by organization SAML enforcement" with `X-GitHub-SSO:
// required; url=...` (docs.github.com, "Authenticating to the REST API", SAML SSO).
//
// The rule this file keeps, as fixtures/github.ts does: a field exists because
// GitHub sends it. Every name and token here is made up.

import { gitHubRepo, listPage, type GitHubRepoPayload } from "./github";
import { providerResponse, requestUrl } from "./provider-response";
import type { ReadLog } from "./read-tracker";

/** A repository as `GET /user/repos` lists it: the repository payload plus the fields a listing carries. */
export interface GitHubListedRepoPayload extends GitHubRepoPayload {
  description: string | null;
  fork: boolean;
  archived: boolean;
  disabled: boolean;
  permissions: { admin: boolean; maintain: boolean; push: boolean; triage: boolean; pull: boolean };
}

/** A part of one repository a sync reads, as the token probe asks for it. */
export type GitHubPart = "readme" | "issues" | "pulls" | "commits";

export interface FakeTokenState {
  /** Every repository `GET /user/repos` lists for this token, in GitHub's `full_name` order. */
  repos: GitHubListedRepoPayload[];
  /** `X-OAuth-Scopes` as GitHub sends it for a classic or OAuth token; null for a fine-grained one, which gets no such header. */
  scopes: string | null;
  /** `GitHub-Authentication-Token-Expiration`, e.g. "2026-11-14 00:00:00 UTC"; null when the token never expires. */
  expiration: string | null;
  /** How GitHub refuses every request this token makes, or null when it answers. */
  refusal: "bad-credentials" | "app-token" | "primary-rate-limit" | "secondary-rate-limit" | "unavailable" | null;
  /**
   * Organizations whose SAML single sign-on has not authorized this token: owner
   * login to GitHub's numeric organization id. Their repositories in `repos` are
   * left out of the listing, which names them in `X-GitHub-SSO`; reading one of
   * them directly is refused 403.
   */
  ssoUnauthorized: Map<string, number>;
  /** Parts each repository refuses for lack of permission, by full name. */
  forbidden: Map<string, Set<GitHubPart>>;
  /** Repositories the token can read but `GET /user/repos` does not list (past what a caller reads, or never listed). */
  unlisted: GitHubListedRepoPayload[];
  /** Repositories with no README, which answer its read with 404. */
  noReadme: Set<string>;
}

/** A listed repository, built on `gitHubRepo`, with the listing's own fields. */
export function listedRepo(
  fullName: string,
  options: {
    private?: boolean;
    visibility?: GitHubRepoPayload["visibility"];
    description?: string | null;
    fork?: boolean;
    archived?: boolean;
    pushedAt?: string;
  } = {},
): GitHubListedRepoPayload {
  const repo = gitHubRepo(fullName, { private: options.private, visibility: options.visibility });
  return {
    ...repo,
    pushed_at: options.pushedAt ?? repo.pushed_at,
    description: options.description === undefined ? `What ${repo.name} does.` : options.description,
    fork: options.fork ?? false,
    archived: options.archived ?? false,
    disabled: false,
    permissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
  };
}

/**
 * `count` repositories across a handful of owners, named so sorting by name and
 * searching by owner both mean something, with every third private, every
 * seventh archived and every eleventh a fork, pushed one hour apart.
 */
export function manyRepos(count: number): GitHubListedRepoPayload[] {
  const owners = ["acme", "acme-labs", "octo-org", "tide-builds", "zeta"];
  const start = Date.parse("2026-10-15T12:00:00Z");
  return Array.from({ length: count }, (_, i) =>
    listedRepo(`${owners[i % owners.length]}/service-${String(i).padStart(4, "0")}`, {
      private: i % 3 === 0,
      archived: i % 7 === 6,
      fork: i % 11 === 10,
      description:
        i % 5 === 4
          ? null
          : `Service ${i}: ${["billing", "search", "ingest", "docs"][i % 4]} for the ${owners[i % owners.length]} team.`,
      pushedAt: new Date(start - i * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    }),
  ).sort((a, b) => a.full_name.localeCompare(b.full_name));
}

/** A token state with nothing refused: a fine-grained token over `repos`, with no expiry. */
export function tokenState(repos: GitHubListedRepoPayload[], overrides: Partial<FakeTokenState> = {}): FakeTokenState {
  return {
    repos,
    scopes: null,
    expiration: null,
    refusal: null,
    ssoUnauthorized: new Map(),
    forbidden: new Map(),
    unlisted: [],
    noReadme: new Set(),
    ...overrides,
  };
}

/**
 * A `fetch` that answers like api.github.com for one token. Each request is
 * recorded with its path, query and Authorization header, so a test can assert
 * what was asked and with which credential.
 */
export function fakeTokenGitHub(state: FakeTokenState, log?: ReadLog) {
  const requests: { path: string; query: Record<string, string>; authorization: string | null }[] = [];
  const tokenHeaders = (): Record<string, string> => ({
    "x-ratelimit-remaining": "4999",
    ...(state.scopes !== null ? { "x-oauth-scopes": state.scopes, "x-accepted-oauth-scopes": "" } : {}),
    ...(state.expiration !== null ? { "github-authentication-token-expiration": state.expiration } : {}),
  });
  const respond = (root: string, body: unknown, headers: Record<string, string> = {}) =>
    providerResponse(body, { headers: { ...tokenHeaders(), ...headers }, track: log ? { root, log } : undefined });
  const message = (status: number, text: string, headers: Record<string, string> = {}) =>
    providerResponse(
      { message: text, documentation_url: "https://docs.github.com/rest", status: String(status) },
      { status, headers },
    );

  // Read on every request, as the rest of `state` is, so a test can authorize the token part way through.
  const ssoOrgOf = (fullName: string) => {
    const owner = fullName.slice(0, fullName.indexOf("/")).toLowerCase();
    const login = [...state.ssoUnauthorized.keys()].find((l) => l.toLowerCase() === owner);
    return login === undefined ? undefined : { login, id: state.ssoUnauthorized.get(login)! };
  };

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    requests.push({
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    switch (state.refusal) {
      case "bad-credentials":
        return message(401, "Bad credentials");
      case "app-token":
        return message(403, "Resource not accessible by integration");
      case "primary-rate-limit":
        return message(403, "API rate limit exceeded for user ID 1.", {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1792015200",
        });
      case "secondary-rate-limit":
        return message(
          429,
          "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
          { "retry-after": "60" },
        );
      case "unavailable":
        return providerResponse("<html><body>Unicorn!</body></html>", {
          status: 503,
          headers: { "content-type": "text/html" },
        });
    }
    if (url.pathname === "/user/repos") {
      const { page, link } = listPage(
        state.repos.filter((r) => !ssoOrgOf(r.full_name)),
        url,
      );
      const sso: Record<string, string> =
        state.ssoUnauthorized.size > 0
          ? { "x-github-sso": `partial-results; organizations=${[...state.ssoUnauthorized.values()].join(",")}` }
          : {};
      return respond("userRepos", page, { ...(link ? { link } : {}), ...sso });
    }
    const match = /^\/repos\/([^/]+)\/([^/]+)(?:\/(readme|issues|pulls|commits))?$/.exec(url.pathname);
    const fullName = match ? `${match[1]}/${match[2]}` : null;
    const repo = fullName
      ? [...state.repos, ...state.unlisted].find((r) => r.full_name.toLowerCase() === fullName.toLowerCase())
      : undefined;
    if (!match || !repo) return message(404, "Not Found");
    const ssoOrg = ssoOrgOf(repo.full_name);
    if (ssoOrg) {
      return message(
        403,
        "Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization.",
        {
          "x-github-sso": `required; url=https://github.com/orgs/${ssoOrg.login}/sso?authorization_request=FAKEREQUEST1`,
        },
      );
    }
    const part = match[3] as GitHubPart | undefined;
    if (!part) return respond("repo", repo);
    if (state.forbidden.get(repo.full_name)?.has(part))
      return message(403, "Resource not accessible by personal access token");
    if (part === "readme" && state.noReadme.has(repo.full_name)) return message(404, "Not Found");
    return respond(part, part === "readme" ? { name: "README.md", path: "README.md", type: "file" } : []);
  };
  return { fetch, requests };
}
