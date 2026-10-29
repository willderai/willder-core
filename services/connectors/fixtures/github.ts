// GitHub REST payloads in the shape api.github.com returns them (API version
// 2022-11-28), and an in-memory GitHub that serves them the way the real one
// does: `per_page` defaults to 30 and caps at 100, lists page with a `Link`
// header, the issues endpoint also returns pull requests, `since` filters
// issues by update and commits by commit date (as `until` does commits), one
// item read by number or sha answers 404, or 410 for a deleted issue and 422
// for a commit the repository no longer has, and a rate limit is a 403 or 429
// with GitHub's own headers. Issue comments list repository-wide (pull request
// conversations included), reviews list per pull request, and the default
// branch's tree and blobs are served from the repository's files.
//
// The rule this file keeps: a fixture field exists because GitHub sends it. No
// shape here is invented for a test's convenience, so a parser that passes
// against it parses what production sees. Every name, email and token is made
// up; a token-shaped string is assembled at runtime, never written out.

import { createHash } from "node:crypto";
import { providerResponse, requestUrl } from "./provider-response";
import type { ReadLog } from "./read-tracker";

const API = "https://api.github.com";

export interface GitHubUserPayload {
  login: string;
  id: number;
  node_id: string;
  avatar_url: string;
  gravatar_id: string;
  url: string;
  html_url: string;
  type: "User" | "Bot" | "Organization";
  site_admin: boolean;
}

export interface GitHubLabelPayload {
  id: number;
  node_id: string;
  url: string;
  name: string;
  color: string;
  default: boolean;
  description: string | null;
}

export interface GitHubIssuePayload {
  id: number;
  node_id: string;
  url: string;
  html_url: string;
  number: number;
  state: "open" | "closed";
  state_reason: "completed" | "not_planned" | "reopened" | null;
  title: string;
  body: string | null;
  user: GitHubUserPayload | null;
  labels: GitHubLabelPayload[];
  assignees: GitHubUserPayload[];
  locked: boolean;
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  author_association: string;
  /** Present only when the issue is a pull request. */
  pull_request?: { url: string; html_url: string; diff_url: string; patch_url: string; merged_at: string | null };
}

interface GitHubBranchRefPayload {
  label: string;
  ref: string;
  sha: string;
  user: GitHubUserPayload;
  /** Null when the pull request came from a fork that has since been deleted. */
  repo: { id: number; full_name: string } | null;
}

export interface GitHubPullPayload {
  id: number;
  node_id: string;
  url: string;
  html_url: string;
  number: number;
  state: "open" | "closed";
  locked: boolean;
  title: string;
  body: string | null;
  user: GitHubUserPayload | null;
  labels: GitHubLabelPayload[];
  draft: boolean;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: GitHubBranchRefPayload;
  base: GitHubBranchRefPayload;
  author_association: string;
}

interface GitHubGitActorPayload {
  name: string;
  email: string;
  date: string;
}

export interface GitHubCommitPayload {
  sha: string;
  node_id: string;
  commit: {
    author: GitHubGitActorPayload | null;
    committer: GitHubGitActorPayload | null;
    message: string;
    tree: { sha: string; url: string };
    url: string;
    comment_count: number;
    verification: { verified: boolean; reason: string; signature: string | null; payload: string | null };
  };
  url: string;
  html_url: string;
  /** The GitHub account the commit email maps to; null when it maps to none. */
  author: GitHubUserPayload | null;
  committer: GitHubUserPayload | null;
  parents: { sha: string; url: string; html_url: string }[];
}

export interface GitHubReadmePayload {
  type: "file";
  name: string;
  path: string;
  sha: string;
  size: number;
  /** Base64 with a newline every 60 characters, as GitHub sends it; empty for a file over 1 MB. */
  content: string;
  /** "base64", or "none" when the file is too large to inline. */
  encoding: "base64" | "none";
  url: string;
  html_url: string;
  download_url: string;
}

export interface GitHubCommentPayload {
  id: number;
  node_id: string;
  url: string;
  html_url: string;
  /** The issue's API url; a pull request's conversation comment points at its issue view. */
  issue_url: string;
  body: string | null;
  user: GitHubUserPayload | null;
  created_at: string;
  updated_at: string;
  author_association: string;
}

export interface GitHubReviewPayload {
  id: number;
  node_id: string;
  user: GitHubUserPayload | null;
  /** Empty string, not null, when the reviewer wrote nothing. */
  body: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  html_url: string;
  pull_request_url: string;
  author_association: string;
  /** Absent on a pending review. */
  submitted_at?: string;
  commit_id: string;
}

export interface GitHubTreePayload {
  sha: string;
  url: string;
  tree: { path: string; mode: string; type: "blob" | "tree"; sha: string; size?: number; url: string }[];
  truncated: boolean;
}

export interface GitHubBlobPayload {
  sha: string;
  node_id: string;
  size: number;
  url: string;
  /** Base64 with a newline every 60 characters, as GitHub sends it. */
  content: string;
  encoding: "base64";
}

export interface GitHubRepoPayload {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  private: boolean;
  visibility?: "public" | "private" | "internal";
  default_branch: string;
  owner: GitHubUserPayload;
  html_url: string;
  updated_at: string;
  pushed_at: string;
}

/** A deterministic 40-character hex sha for `seed`. */
export function fakeSha(seed: string): string {
  return createHash("sha1").update(seed).digest("hex");
}

function nodeId(prefix: string, n: number): string {
  return `${prefix}_kwDO${Buffer.from(String(n)).toString("base64").replace(/=/g, "")}`;
}

/** A GitHub account. `type: "Bot"` logins end in `[bot]`, as GitHub's do. */
export function gitHubUser(login: string, type: GitHubUserPayload["type"] = "User"): GitHubUserPayload {
  const id = parseInt(fakeSha(login).slice(0, 7), 16);
  return {
    login,
    id,
    node_id: nodeId(type === "Bot" ? "BOT" : "U", id),
    avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
    gravatar_id: "",
    url: `${API}/users/${encodeURIComponent(login)}`,
    html_url: `https://github.com/${encodeURIComponent(login)}`,
    type,
    site_admin: false,
  };
}

/** GitHub's placeholder for a deleted account, as issues by one report it. */
export const GHOST = gitHubUser("ghost");

export function gitHubLabel(name: string, description: string | null = null): GitHubLabelPayload {
  const id = parseInt(fakeSha(`label:${name}`).slice(0, 8), 16);
  return {
    id,
    node_id: nodeId("LA", id),
    url: `${API}/labels/${id}`,
    name,
    color: "d73a4a",
    default: false,
    description,
  };
}

export interface FakeRepositoryState {
  repo: GitHubRepoPayload;
  readme: GitHubReadmePayload | null;
  issues: GitHubIssuePayload[];
  pulls: GitHubPullPayload[];
  /** Newest first, as the commits endpoint lists them. */
  commits: GitHubCommitPayload[];
  /** Issue and pull request conversation comments, repository-wide. */
  comments: GitHubCommentPayload[];
  /** Each pull request's reviews, by number, oldest first as GitHub lists them. */
  reviews: Record<number, GitHubReviewPayload[]>;
  /** The default branch's files other than the README, by path, with their contents. */
  files: Record<string, string>;
  /** Answer the tree with `truncated: true`, as GitHub does past 100,000 entries. */
  treeTruncated: boolean;
  /** Issues an admin deleted: gone from every listing, 410 when read by number. */
  deletedIssues: Set<number>;
  /**
   * Kinds the token lacks permission for: each answers GitHub's 403 "Resource
   * not accessible". Reviews sit behind `pulls`, and the tree and blobs behind
   * `contents`. Issue comments answer a token with either `issues` or `pulls`,
   * as GitHub documents, and are refused only without both. With one of the
   * two, this fake still lists every comment, the conversations of the refused
   * kind included: GitHub does not document what that listing holds, so the
   * fake serves the case where the connector's own check is all that keeps a
   * comment on a refused parent out.
   */
  forbidden: Set<"readme" | "issues" | "pulls" | "commits" | "contents">;
  /** Answer every request with GitHub's primary (403) or secondary (429) rate limit. */
  rateLimited: "primary" | "secondary" | null;
}

export function gitHubRepo(
  fullName: string,
  options: { private?: boolean; visibility?: GitHubRepoPayload["visibility"] } = {},
): GitHubRepoPayload {
  const [owner, name] = fullName.split("/");
  const id = parseInt(fakeSha(fullName).slice(0, 8), 16);
  const isPrivate = options.private ?? false;
  const repo: GitHubRepoPayload = {
    id,
    node_id: nodeId("R", id),
    name,
    full_name: fullName,
    private: isPrivate,
    default_branch: "main",
    owner: gitHubUser(owner, "Organization"),
    html_url: `https://github.com/${fullName}`,
    updated_at: "2026-10-14T18:00:00Z",
    pushed_at: "2026-10-14T18:31:02Z",
  };
  if (options.visibility !== undefined) repo.visibility = options.visibility;
  else repo.visibility = isPrivate ? "private" : "public";
  return repo;
}

/** A README as the contents API returns it: base64 wrapped at 60 characters. */
export function gitHubReadme(fullName: string, markdown: string): GitHubReadmePayload {
  const base64 = Buffer.from(markdown, "utf8").toString("base64");
  return {
    type: "file",
    name: "README.md",
    path: "README.md",
    sha: fakeSha(markdown),
    size: Buffer.byteLength(markdown, "utf8"),
    content: `${base64.match(/.{1,60}/g)?.join("\n") ?? ""}\n`,
    encoding: "base64",
    url: `${API}/repos/${fullName}/contents/README.md?ref=main`,
    html_url: `https://github.com/${fullName}/blob/main/README.md`,
    download_url: `https://raw.githubusercontent.com/${fullName}/main/README.md`,
  };
}

/** A comment on issue (or pull request) `number`, as the issue comments endpoint lists it. */
export function gitHubComment(
  fullName: string,
  id: number,
  fields: {
    number: number;
    body: string | null;
    updated_at: string;
    onPull?: boolean;
    user?: GitHubUserPayload | null;
  },
): GitHubCommentPayload {
  const view = fields.onPull ? "pull" : "issues";
  return {
    id,
    node_id: nodeId("IC", id),
    url: `${API}/repos/${fullName}/issues/comments/${id}`,
    html_url: `https://github.com/${fullName}/${view}/${fields.number}#issuecomment-${id}`,
    issue_url: `${API}/repos/${fullName}/issues/${fields.number}`,
    body: fields.body,
    user: fields.user === undefined ? gitHubUser("dev-avery") : fields.user,
    created_at: fields.updated_at,
    updated_at: fields.updated_at,
    author_association: "MEMBER",
  };
}

/** A review of pull request `number`, as the reviews endpoint lists it. */
export function gitHubReview(
  fullName: string,
  id: number,
  fields: {
    number: number;
    state: GitHubReviewPayload["state"];
    body?: string;
    submitted_at: string;
    user?: GitHubUserPayload | null;
  },
): GitHubReviewPayload {
  const review: GitHubReviewPayload = {
    id,
    node_id: nodeId("PRR", id),
    user: fields.user === undefined ? gitHubUser("dev-blake") : fields.user,
    body: fields.body ?? "",
    state: fields.state,
    html_url: `https://github.com/${fullName}/pull/${fields.number}#pullrequestreview-${id}`,
    pull_request_url: `${API}/repos/${fullName}/pulls/${fields.number}`,
    author_association: "MEMBER",
    commit_id: fakeSha(`review:${id}`),
  };
  if (fields.state !== "PENDING") review.submitted_at = fields.submitted_at;
  return review;
}

function base64Wrapped(text: string): string {
  return `${
    Buffer.from(text, "utf8")
      .toString("base64")
      .match(/.{1,60}/g)
      ?.join("\n") ?? ""
  }\n`;
}

/** A README over 1 MB: GitHub sends no inline content and `encoding: "none"`. */
export function oversizedGitHubReadme(fullName: string, sizeBytes: number): GitHubReadmePayload {
  return { ...gitHubReadme(fullName, ""), size: sizeBytes, content: "", encoding: "none" };
}

export function gitHubIssue(
  fullName: string,
  number: number,
  fields: Partial<Omit<GitHubIssuePayload, "number">> & { title: string; updated_at: string },
): GitHubIssuePayload {
  const state = fields.state ?? "open";
  return {
    id: 1_000_000 + number,
    node_id: nodeId("I", number),
    url: `${API}/repos/${fullName}/issues/${number}`,
    html_url: `https://github.com/${fullName}/issues/${number}`,
    number,
    state,
    state_reason: state === "closed" ? "completed" : null,
    body: "",
    user: gitHubUser("dev-avery"),
    labels: [],
    assignees: [],
    locked: false,
    comments: 0,
    created_at: fields.updated_at,
    closed_at: state === "closed" ? fields.updated_at : null,
    author_association: "MEMBER",
    ...fields,
  };
}

export function gitHubPull(
  fullName: string,
  number: number,
  fields: Partial<Omit<GitHubPullPayload, "number" | "head" | "base">> & {
    title: string;
    updated_at: string;
    head?: Partial<GitHubBranchRefPayload>;
    base?: Partial<GitHubBranchRefPayload>;
  },
): GitHubPullPayload {
  const { head, base, ...rest } = fields;
  const state = rest.state ?? "open";
  const user = rest.user === undefined ? gitHubUser("dev-avery") : rest.user;
  const repo = { id: parseInt(fakeSha(fullName).slice(0, 8), 16), full_name: fullName };
  const ref = (r: string, sha: string): GitHubBranchRefPayload => ({
    label: `${fullName.split("/")[0]}:${r}`,
    ref: r,
    sha,
    user: user ?? GHOST,
    repo,
  });
  return {
    id: 2_000_000 + number,
    node_id: nodeId("PR", number),
    url: `${API}/repos/${fullName}/pulls/${number}`,
    html_url: `https://github.com/${fullName}/pull/${number}`,
    number,
    state,
    locked: false,
    body: "",
    labels: [],
    draft: false,
    created_at: rest.updated_at,
    closed_at: state === "closed" ? rest.updated_at : null,
    merged_at: null,
    merge_commit_sha: null,
    author_association: "MEMBER",
    ...rest,
    user,
    head: { ...ref(`feature/${number}`, fakeSha(`head:${number}`)), ...head },
    base: { ...ref("main", fakeSha(`base:${number}`)), ...base },
  };
}

export function gitHubCommit(
  fullName: string,
  seed: string,
  fields: {
    message: string;
    date: string;
    author?: GitHubUserPayload | null;
    gitAuthorName?: string;
    parents?: number;
    gitAuthor?: null;
  },
): GitHubCommitPayload {
  const sha = fakeSha(`${fullName}:${seed}`);
  const account = fields.author === undefined ? gitHubUser("dev-avery") : fields.author;
  const name = fields.gitAuthorName ?? account?.login ?? "Unmapped Author";
  const actor: GitHubGitActorPayload = {
    name,
    email: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@example.com`,
    date: fields.date,
  };
  return {
    sha,
    node_id: nodeId("C", parseInt(sha.slice(0, 8), 16)),
    commit: {
      author: fields.gitAuthor === null ? null : actor,
      committer: actor,
      message: fields.message,
      tree: { sha: fakeSha(`tree:${sha}`), url: `${API}/repos/${fullName}/git/trees/${fakeSha(`tree:${sha}`)}` },
      url: `${API}/repos/${fullName}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: "unsigned", signature: null, payload: null },
    },
    url: `${API}/repos/${fullName}/commits/${sha}`,
    html_url: `https://github.com/${fullName}/commit/${sha}`,
    author: account,
    committer: account,
    parents: Array.from({ length: fields.parents ?? 1 }, (_, i) => {
      const parent = fakeSha(`parent:${sha}:${i}`);
      return {
        sha: parent,
        url: `${API}/repos/${fullName}/commits/${parent}`,
        html_url: `https://github.com/${fullName}/commit/${parent}`,
      };
    }),
  };
}

/** The issue-endpoint view of a pull request: GitHub lists every PR there too. */
function pullAsIssue(pull: GitHubPullPayload): GitHubIssuePayload {
  return {
    id: pull.id,
    node_id: pull.node_id,
    url: pull.url.replace("/pulls/", "/issues/"),
    html_url: pull.html_url,
    number: pull.number,
    state: pull.state,
    state_reason: pull.state === "closed" ? "completed" : null,
    title: pull.title,
    body: pull.body,
    user: pull.user,
    labels: pull.labels,
    assignees: [],
    locked: pull.locked,
    comments: 0,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.closed_at,
    author_association: pull.author_association,
    pull_request: {
      url: pull.url,
      html_url: pull.html_url,
      diff_url: `${pull.html_url}.diff`,
      patch_url: `${pull.html_url}.patch`,
      merged_at: pull.merged_at,
    },
  };
}

export interface GitHubRequest {
  path: string;
  query: Record<string, string>;
}

const SORT_FIELDS = { created: "created_at", updated: "updated_at" } as const;

/** One page of `all` as GitHub pages a list: `per_page` (default 30, at most 100), `page`, and the `Link` header. */
export function listPage<T>(all: T[], url: URL): { page: T[]; link: string | null } {
  const perPage = Math.min(Math.max(parseInt(url.searchParams.get("per_page") ?? "30", 10) || 30, 1), 100);
  const pageNumber = Math.max(parseInt(url.searchParams.get("page") ?? "1", 10) || 1, 1);
  const lastPage = Math.max(Math.ceil(all.length / perPage), 1);
  const page = all.slice((pageNumber - 1) * perPage, pageNumber * perPage);
  const pageUrl = (n: number) => {
    const next = new URL(url);
    next.searchParams.set("page", String(n));
    return `<${next.toString()}>`;
  };
  const rels: string[] = [];
  if (pageNumber < lastPage) rels.push(`${pageUrl(pageNumber + 1)}; rel="next"`, `${pageUrl(lastPage)}; rel="last"`);
  if (pageNumber > 1) rels.push(`${pageUrl(1)}; rel="first"`, `${pageUrl(pageNumber - 1)}; rel="prev"`);
  return { page, link: rels.length ? rels.join(", ") : null };
}

/** Whether `at` falls inside the request's `since` and `until`, both inclusive. */
function withinWindow(at: string, url: URL): boolean {
  const since = url.searchParams.get("since");
  const until = url.searchParams.get("until");
  return (!since || Date.parse(at) >= Date.parse(since)) && (!until || Date.parse(at) <= Date.parse(until));
}

function sortedAndFiltered<T extends { state: string; created_at: string; updated_at: string }>(
  items: T[],
  url: URL,
): T[] {
  const state = url.searchParams.get("state") ?? "open";
  const sort = (url.searchParams.get("sort") ?? "created") as keyof typeof SORT_FIELDS;
  const field = SORT_FIELDS[sort] ?? "created_at";
  const ascending = (url.searchParams.get("direction") ?? "desc") === "asc";
  return items
    .filter((item) => state === "all" || item.state === state)
    .sort((a, b) => (ascending ? 1 : -1) * a[field].localeCompare(b[field]));
}

const RATE_LIMIT_RESET = "1792015200";

/**
 * A `fetch` that answers like api.github.com for one repository. Requests are
 * recorded in order, with their query, so a test can assert what the parser
 * asked for. With a read log, every JSON body is tracked for the drift check
 * under its endpoint name (`repo`, `readme`, `issues`, `pulls`, `commits`).
 */
export function fakeGitHub(state: FakeRepositoryState, log?: ReadLog) {
  const requests: GitHubRequest[] = [];
  const base = `/repos/${state.repo.full_name}`;
  const respond = (root: string, body: unknown, headers: Record<string, string> = {}) =>
    providerResponse(body, {
      headers: { "x-ratelimit-remaining": "4999", ...headers },
      track: log ? { root, log } : undefined,
    });
  const forbidden = () =>
    providerResponse(
      {
        message: "Resource not accessible by personal access token",
        documentation_url: "https://docs.github.com/rest",
        status: "403",
      },
      { status: 403 },
    );
  /** GitHub serves issue comments to a token with either the issues or the pull requests permission. */
  const commentsForbidden = () => state.forbidden.has("issues") && state.forbidden.has("pulls");
  const notFound = () =>
    providerResponse(
      { message: "Not Found", documentation_url: "https://docs.github.com/rest", status: "404" },
      { status: 404 },
    );

  const fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = requestUrl(input);
    requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
    if (state.rateLimited === "primary") {
      return providerResponse(
        {
          message: "API rate limit exceeded for user ID 1.",
          documentation_url: "https://docs.github.com/rest/overview/rate-limits-for-the-rest-api",
          status: "403",
        },
        { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": RATE_LIMIT_RESET } },
      );
    }
    if (state.rateLimited === "secondary") {
      return providerResponse(
        {
          message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
          status: "429",
        },
        { status: 429, headers: { "retry-after": "60" } },
      );
    }
    if (url.pathname.startsWith(`${base}/git/`)) return gitObject(url.pathname.slice(base.length + "/git/".length));
    const reviews = new RegExp(`^${base}/pulls/(\\d+)/reviews$`).exec(url.pathname);
    if (reviews) {
      if (state.forbidden.has("pulls")) return forbidden();
      const number = Number(reviews[1]);
      if (!state.pulls.some((p) => p.number === number)) return notFound();
      const { page, link } = listPage(state.reviews[number] ?? [], url);
      return respond("reviews", page, link ? { link } : {});
    }
    switch (url.pathname) {
      case base:
        return respond("repo", state.repo);
      case `${base}/readme`:
        if (state.forbidden.has("readme")) return forbidden();
        return state.readme ? respond("readme", state.readme) : notFound();
      case `${base}/issues`: {
        if (state.forbidden.has("issues")) return forbidden();
        const all = sortedAndFiltered([...state.issues, ...state.pulls.map(pullAsIssue)], url).filter((issue) =>
          withinWindow(issue.updated_at, url),
        );
        const { page, link } = listPage(all, url);
        return respond("issues", page, link ? { link } : {});
      }
      case `${base}/issues/comments`: {
        if (commentsForbidden()) return forbidden();
        const sort = (url.searchParams.get("sort") ?? "created") as keyof typeof SORT_FIELDS;
        const field = SORT_FIELDS[sort] ?? "created_at";
        const ascending = (url.searchParams.get("direction") ?? "asc") === "asc";
        const all = [...state.comments]
          .filter((c) => withinWindow(c.updated_at, url))
          .sort((a, b) => (ascending ? 1 : -1) * a[field].localeCompare(b[field]));
        const { page, link } = listPage(all, url);
        return respond("comments", page, link ? { link } : {});
      }
      case `${base}/pulls`: {
        if (state.forbidden.has("pulls")) return forbidden();
        const { page, link } = listPage(sortedAndFiltered(state.pulls, url), url);
        return respond("pulls", page, link ? { link } : {});
      }
      case `${base}/commits`: {
        if (state.forbidden.has("commits")) return forbidden();
        const { page, link } = listPage(
          state.commits.filter((c) => {
            const date = (c.commit.committer ?? c.commit.author)?.date;
            return date === undefined || withinWindow(date, url);
          }),
          url,
        );
        return respond("commits", page, link ? { link } : {});
      }
      default:
        return oneItem(url.pathname.slice(base.length));
    }
  };

  /** The default branch's files: the README (when there is one) and `state.files`, in git's path order. */
  const branchFiles = (): [string, string][] => {
    const files = Object.entries(state.files);
    if (state.readme && state.readme.encoding === "base64") {
      files.push([state.readme.path, Buffer.from(state.readme.content, "base64").toString("utf8")]);
    }
    return files.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  };

  /** `GET /git/trees/:branch?recursive=1` and `/git/blobs/:sha`. */
  const gitObject = (rest: string): Response => {
    if (state.forbidden.has("contents")) return forbidden();
    const [kind, key] = rest.split("/");
    const files = branchFiles();
    if (kind === "trees") {
      if (key !== state.repo.default_branch) return notFound();
      if (files.length === 0) {
        return providerResponse(
          { message: "Git Repository is empty.", documentation_url: "https://docs.github.com/rest", status: "409" },
          { status: 409 },
        );
      }
      const dirs = new Set(
        files.flatMap(([path]) =>
          path
            .split("/")
            .slice(0, -1)
            .map((_, i, parts) => parts.slice(0, i + 1).join("/")),
        ),
      );
      const entries: GitHubTreePayload["tree"] = [
        ...[...dirs].map((path) => ({
          path,
          mode: "040000",
          type: "tree" as const,
          sha: fakeSha(`dir:${path}`),
          url: `${API}${base}/git/trees/${fakeSha(`dir:${path}`)}`,
        })),
        ...files.map(([path, content]) => ({
          path,
          mode: "100644",
          type: "blob" as const,
          sha: fakeSha(content),
          size: Buffer.byteLength(content, "utf8"),
          url: `${API}${base}/git/blobs/${fakeSha(content)}`,
        })),
      ].sort((a, b) => (a.path < b.path ? -1 : 1));
      const tree: GitHubTreePayload = {
        sha: fakeSha(`tree:${key}`),
        url: `${API}${base}/git/trees/${fakeSha(`tree:${key}`)}`,
        tree: entries,
        truncated: state.treeTruncated,
      };
      return respond("tree", tree);
    }
    if (kind === "blobs") {
      const file = files.find(([, content]) => fakeSha(content) === key);
      if (!file) return notFound();
      const blob: GitHubBlobPayload = {
        sha: key,
        node_id: nodeId("B", parseInt(key.slice(0, 8), 16)),
        size: Buffer.byteLength(file[1], "utf8"),
        url: `${API}${base}/git/blobs/${key}`,
        content: base64Wrapped(file[1]),
        encoding: "base64",
      };
      return respond("blob", blob);
    }
    return notFound();
  };

  /** `GET /issues/:number`, `/issues/comments/:id`, `/pulls/:number` or `/commits/:sha`, as GitHub answers each. */
  const oneItem = (rest: string): Response => {
    const [, kind, key, commentId] = rest.split("/");
    if (kind === "issues" && key === "comments") {
      if (commentsForbidden()) return forbidden();
      const comment = state.comments.find((c) => c.id === Number(commentId));
      return comment ? respond("comment", comment) : notFound();
    }
    if (kind !== "issues" && kind !== "pulls" && kind !== "commits") return notFound();
    if (state.forbidden.has(kind)) return forbidden();
    if (kind === "commits") {
      const commit = state.commits.find((c) => c.sha === key);
      return commit
        ? respond("commit", commit)
        : providerResponse(
            {
              message: `No commit found for SHA: ${key}`,
              documentation_url: "https://docs.github.com/rest",
              status: "422",
            },
            { status: 422 },
          );
    }
    const number = Number(key);
    const pull = state.pulls.find((p) => p.number === number);
    if (kind === "pulls") return pull ? respond("pull", pull) : notFound();
    const issue = state.issues.find((i) => i.number === number) ?? (pull && pullAsIssue(pull));
    if (issue) return respond("issue", issue);
    return state.deletedIssues.has(number)
      ? providerResponse(
          { message: "This issue was deleted", documentation_url: "https://docs.github.com/rest", status: "410" },
          { status: 410 },
        )
      : notFound();
  };
  return { fetch, requests };
}

function emptyState(fullName: string): FakeRepositoryState {
  return {
    repo: gitHubRepo(fullName),
    readme: null,
    issues: [],
    pulls: [],
    commits: [],
    comments: [],
    reviews: {},
    files: {},
    treeTruncated: false,
    deletedIssues: new Set(),
    forbidden: new Set(),
    rateLimited: null,
  };
}

/**
 * A token-shaped string that matches GitHub's classic personal access token
 * format, assembled here so no literal token sits in the repository.
 */
export function tokenShapedSecret(): string {
  return ["gh", "p_", "Fx".repeat(18)].join("");
}

/** An AWS access key id shape, assembled at runtime for the same reason. */
export function awsKeyShapedSecret(): string {
  return ["AK", "IA", "EXAMPLE0", "KEYID000"].join("");
}

/**
 * One small repository carrying the mess a real one has: a ghost and a bot
 * author, a null author, a null body, a body over the 8,000-character clip,
 * unicode, emoji and right-to-left text, CRLF line endings, a draft, a merged
 * and a closed-unmerged pull request, a pull request from a deleted fork, a
 * merge commit, a commit whose email maps to no account and one with no git
 * author, a README holding a token-shaped secret, issue and pull request
 * comments (chatter, a decision, an email address, a null body), reviews of
 * every state, and a file tree with an ADR, CONTRIBUTING, CHANGELOG, a doc
 * holding a key and an email, source code and a CI workflow.
 */
export function messyRepository(fullName = "example-org/lantern"): FakeRepositoryState {
  const state = emptyState(fullName);
  const at = (minute: number) =>
    `2026-10-14T${String(10 + Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00Z`;
  const bot = gitHubUser("dependabot[bot]", "Bot");

  state.readme = gitHubReadme(
    fullName,
    [
      "# Lantern",
      "",
      "Lantern summarizes pull requests for reviewers. It reads the diff,",
      "the linked issue and the review thread, and writes a short brief.",
      "",
      "## Setup",
      "",
      "Copy `.env.example` to `.env`. For local runs only:",
      "",
      `    GITHUB_TOKEN=${tokenShapedSecret()}`,
      "",
      "## Ünïcödé, emoji 🚀 and right-to-left text: שלום עולם",
      "",
      "Names in other scripts stay intact: 東京, Zoë, Ångström.",
    ].join("\n"),
  );

  state.issues = [
    gitHubIssue(fullName, 101, {
      title: "Crash when a title has emoji 🚀 or RTL text שלום",
      body: "Steps:\r\n1. Open a PR titled 🚀\r\n2. Brief is empty\r\n",
      updated_at: at(1),
      labels: [gitHubLabel("bug", "Something isn't working"), gitHubLabel("good first issue")],
    }),
    gitHubIssue(fullName, 102, {
      title: "Old proposal from a deleted account",
      body: null,
      state: "closed",
      state_reason: "not_planned",
      user: GHOST,
      updated_at: at(2),
    }),
    gitHubIssue(fullName, 103, {
      title: "Bump undici from 6.19.2 to 6.21.1",
      body: "Bumps undici.",
      user: bot,
      updated_at: at(3),
    }),
    gitHubIssue(fullName, 104, {
      title: "Paste of a full stack trace",
      body: `${"at render (/app/lib/brief.ts:42:7)\n".repeat(400)}`,
      updated_at: at(4),
    }),
    gitHubIssue(fullName, 105, {
      title: "Issue whose author field is null",
      body: "Imported from another tracker.",
      user: null,
      updated_at: at(5),
    }),
    gitHubIssue(fullName, 106, {
      title: "Locked thread",
      body: "Locked after a heated review.",
      state: "closed",
      locked: true,
      updated_at: at(6),
    }),
  ];

  state.pulls = [
    gitHubPull(fullName, 201, {
      title: "WIP: switch to GraphQL",
      body: "closes #101",
      draft: true,
      updated_at: at(7),
      head: { ref: "gql" },
    }),
    gitHubPull(fullName, 202, {
      title: "Cache review threads",
      body: "Adds an LRU in front of the threads call.",
      state: "closed",
      merged_at: at(8),
      merge_commit_sha: fakeSha("merge:202"),
      updated_at: at(8),
      labels: [gitHubLabel("performance")],
    }),
    gitHubPull(fullName, 203, { title: "Rejected approach", body: null, state: "closed", updated_at: at(9) }),
    gitHubPull(fullName, 204, {
      title: "chore(deps): update node to v24",
      body: "Renovate update.",
      user: gitHubUser("renovate[bot]", "Bot"),
      updated_at: at(10),
    }),
    gitHubPull(fullName, 205, {
      title: "Fix from a fork that was deleted",
      body: "Thanks!",
      updated_at: at(11),
      head: { ref: "patch-1", repo: null },
    }),
  ];

  state.commits = [
    gitHubCommit(fullName, "c6", {
      message: "Merge pull request #202 from example-org/cache\n\nCache review threads",
      date: at(12),
      parents: 2,
    }),
    gitHubCommit(fullName, "c5", {
      message:
        "Brief: keep emoji in titles 🚀\n\nThe sanitizer dropped astral-plane characters.\n\nCo-authored-by: Zoë Example <zoe@example.com>",
      date: at(11),
    }),
    gitHubCommit(fullName, "c4", {
      message: "Fix typo",
      date: at(10),
      author: null,
      gitAuthorName: "Unmapped Laptop User",
    }),
    gitHubCommit(fullName, "c3", {
      message: "Update dependencies",
      date: at(9),
      author: gitHubUser("github-actions[bot]", "Bot"),
    }),
    gitHubCommit(fullName, "c2", {
      message: "Imported history with no git author",
      date: at(8),
      author: null,
      gitAuthor: null,
    }),
  ];

  state.comments = [
    gitHubComment(fullName, 9001, {
      number: 101,
      body: "Reproduced on Safari too. Reach me at zoe@example.com if you need a trace.",
      updated_at: at(13),
    }),
    gitHubComment(fullName, 9002, { number: 202, body: "Nice! 🎉", updated_at: at(14), onPull: true }),
    gitHubComment(fullName, 9003, {
      number: 202,
      body: "Agreed: we will keep the LRU at 500 entries instead of making it configurable.",
      updated_at: at(15),
      onPull: true,
      user: gitHubUser("dev-blake"),
    }),
    gitHubComment(fullName, 9004, { number: 106, body: null, updated_at: at(16), user: null }),
  ];

  state.reviews = {
    201: [
      gitHubReview(fullName, 7001, {
        number: 201,
        state: "COMMENTED",
        body: "We decided GraphQL waits until the REST client is stable.",
        submitted_at: at(7),
      }),
    ],
    202: [
      gitHubReview(fullName, 7002, { number: 202, state: "COMMENTED", body: "typo on line 3", submitted_at: at(8) }),
      gitHubReview(fullName, 7003, {
        number: 202,
        state: "CHANGES_REQUESTED",
        body: "Blocking: the cache must be keyed by repository, not by PR number.",
        submitted_at: at(8),
      }),
      gitHubReview(fullName, 7004, { number: 202, state: "APPROVED", submitted_at: at(8), user: null }),
      gitHubReview(fullName, 7005, {
        number: 202,
        state: "PENDING",
        body: "Draft thoughts, not submitted",
        submitted_at: at(8),
      }),
    ],
  };

  state.files = {
    "docs/adr/0001-review-threads-in-postgres.md": [
      "# 1. Keep review threads in Postgres",
      "",
      "Status: accepted",
      "",
      "We decided to keep review threads in Postgres instead of Redis, because",
      "briefs must survive a restart.",
    ].join("\n"),
    "CONTRIBUTING.md": "# Contributing\n\nEvery pull request needs one approval. Run `npm test` before pushing.\n",
    "CHANGELOG.md": "# Changelog\n\n## 1.2.0\n\n- Briefs keep emoji in titles.\n",
    "docs/setup.md": `# Setup\n\nAsk ops@example.com for access, then set:\n\n    AWS_ACCESS_KEY_ID=${awsKeyShapedSecret()}\n`,
    "src/brief.ts": "export function brief(diff: string): string {\n  return summarizeDiffForReviewers(diff);\n}\n",
    ".github/workflows/ci.yml": "on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n",
  };
  return state;
}

/**
 * A busy repository at real scale: `commits` commits plus `issues` issues and
 * `pulls` pull requests, one a minute, newest last. Issues and pull requests
 * interleave in time (every third is a pull request at the defaults), as they
 * do in a real tracker, so the issues endpoint pages hold both. The defaults
 * total 900 items, about one half-hour sync window of a busy repository.
 */
export function busyRepository(
  counts: { commits: number; issues: number; pulls: number } = { commits: 600, issues: 200, pulls: 100 },
  fullName = "example-org/busy",
): FakeRepositoryState {
  const state = emptyState(fullName);
  state.readme = gitHubReadme(fullName, "# Busy\n\nA repository with steady traffic.");
  const minute = (n: number) => new Date(Date.UTC(2026, 9, 1) + n * 60_000).toISOString().replace(".000Z", "Z");
  let issues = 0;
  let pulls = 0;
  for (let n = 1; n <= counts.issues + counts.pulls; n++) {
    const pullDue = issues >= counts.issues || (pulls < counts.pulls && n % 3 === 0);
    if (pullDue) {
      pulls++;
      state.pulls.push(
        gitHubPull(fullName, n, {
          title: `Change ${n}`,
          body: `Implements change ${n}.`,
          state: pulls % 2 === 0 ? "closed" : "open",
          merged_at: pulls % 2 === 0 ? minute(n) : null,
          updated_at: minute(n),
        }),
      );
    } else {
      issues++;
      state.issues.push(
        gitHubIssue(fullName, n, {
          title: `Issue ${n}`,
          body: `Report ${n}.`,
          state: issues % 3 === 0 ? "closed" : "open",
          updated_at: minute(n),
        }),
      );
    }
  }
  state.commits = Array.from({ length: counts.commits }, (_, i) =>
    gitHubCommit(fullName, `busy-${i}`, { message: `Board row ${i}`, date: minute(i) }),
  ).reverse();
  return state;
}

/** Push `count` new commits on top of the repository, newest first, as a busy day does. */
export function pushCommits(state: FakeRepositoryState, count: number, label: string, startMinute: number): void {
  const minute = (n: number) => new Date(Date.UTC(2026, 9, 2) + n * 60_000).toISOString().replace(".000Z", "Z");
  const pushed = Array.from({ length: count }, (_, i) =>
    gitHubCommit(state.repo.full_name, `${label}-${i}`, { message: `${label} ${i}`, date: minute(startMinute + i) }),
  ).reverse();
  state.commits = [...pushed, ...state.commits];
}

/** Touch issues by number (a comment or label change), moving them to the top of `sort=updated`. */
export function touchIssues(state: FakeRepositoryState, numbers: number[], at: string): void {
  for (const issue of state.issues) if (numbers.includes(issue.number)) issue.updated_at = at;
}

/** Delete issues by number, as a repository admin can: gone from listings, 410 when read. */
export function deleteIssues(state: FakeRepositoryState, numbers: number[]): void {
  state.issues = state.issues.filter((issue) => !numbers.includes(issue.number));
  for (const n of numbers) state.deletedIssues.add(n);
}
