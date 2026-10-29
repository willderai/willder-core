// GitHub connector — one repository per connect, read-only, into one scope.
//
// Stage 1 (the founder, 2026-09-22): the lowest-friction source for a builder running
// agents. The customer pastes a fine-grained personal access token with
// read-only Contents, Issues, Pull requests and Metadata on the one repository
// they connect. We seal it at rest on Source.encryptedTokens (lib/crypto, same
// primitive as posthog.ts), never in an env var, never in a prompt. Each sync
// reads the README whole, and the issues, issue comments, pull requests, their
// deciding reviews and commits changed since the previous sync, plus the file
// tree and the project's docs (ADRs, CONTRIBUTING, CHANGELOG, docs/), and
// ingests each as one text episode tagged with the source's scope. The README
// and each doc are split into heading sections with wrapped lines joined
// (markdown.ts), one episode each. A token missing one of those permissions
// syncs the rest and names on the source the parts GitHub refused it. A
// comment or review has no permission of its own: it follows the issue or pull
// request it is on, so a token refused that parent reads none of its comments.
//
// What is saved: the why, the what, who owns it and
// what changed. Source code bodies, diffs and CI logs are never read; the file
// tree is paths only. Every text passes the secret scan (secret-scan.ts) and
// loses its email addresses before it becomes an item, so a token pasted into
// a README or a Co-authored-by trailer's address never reaches memory.
//
// The one rule this file enforces: an item leaves memory only on evidence that
// it is gone upstream (GitHub answers 404 or 410 for it inside a repository the
// token can still read, or the token lost the permission to read its kind).
// Being absent from a listing is not that evidence, and neither is a 404 for the
// repository itself: GitHub answers 404, not 403, to a token that cannot see a
// private repository, so "deleted" and "this token has no access" look the same,
// and GitHub has no answer that tells them apart. A repository the token cannot
// read is reported as access lost (`SourceAccessError`), and its stored items stay. The listing is incremental and paged, so absence
// means "not changed lately"; retiring on it deleted every item older than the
// newest page on each scheduled sync, then re-ingested it whenever it came back,
// counting each re-ingest against the plan's episode cap.
// Stage 2 (issues and PRs as typed records with change events) waits for the
// change feed.
//
// No mock mode: a GitHub connect always carries a real token from the first
// call, like posthog.ts. Every call is a GET against api.github.com; nothing
// here can write to the repository even with a broader token.

import { createHash } from "node:crypto";
import { splitMarkdownSections, unwrapMarkdown } from "./markdown";
import { holdsSecretOrAddress, scanForSecrets } from "./secret-scan";
import { SourceAccessError } from "./source-access";
import type { SourceReaders } from "@/services/access";

export class GitHubConnectorError extends Error {
  /** GitHub's HTTP status, when the error is GitHub's answer. */
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const API = "https://api.github.com";
/** README sections kept, at most. */
const MAX_README_SECTIONS = 50;
/** GitHub's largest page. */
const PER_PAGE = 100;
/**
 * Items of one kind a sync reads before it stops asking for pages: two full
 * pages. It bounds a sync's Inngest steps (one per new or edited item); a longer
 * history is read over the syncs that follow, continuing where this one
 * stopped. A listing that also returns rows of another kind, as the issues
 * endpoint returns pull requests, reads on until this many of its own kind are
 * in, so the other kind takes none of them. Its last page can carry it past the
 * budget, to at most `ITEMS_PER_KIND + PER_PAGE` items (see `readChangedPages`).
 */
const ITEMS_PER_KIND = 2 * PER_PAGE;
/**
 * Pages of one kind a single sync requests, at most. Bounds a sync's API calls
 * when a listing's pages hold few rows of its own kind, such as a stretch of
 * the issues endpoint that is all pull requests.
 */
const MAX_PAGES_PER_KIND = 10;
/**
 * How far before the previous sync's start the next one reads again. GitHub's
 * listings are eventually consistent (an issue opened seconds before a sync can
 * be missing from it), and a commit's date is set by the committer's clock.
 * Items read again unchanged are skipped by checksum and write nothing.
 */
const OVERLAP_MS = 60 * 60 * 1000;
/** Stored items one sync asks GitHub about directly, to find the ones deleted upstream. */
const PROBES_PER_SYNC = 20;
const MAX_TEXT_CHARS = 8_000;
/** README and doc sections are packed up to this size, so extraction covers every sentence of each episode. */
const README_SECTION_CHARS = 1_500;
/** Sections kept of one doc, at most. */
const MAX_DOC_SECTIONS = 20;
/** Docs a repository may contribute, at most, taken in path order. */
const MAX_DOC_FILES = 200;
/** New or changed docs one sync reads; the rest are read by the syncs that follow. */
const DOC_READS_PER_SYNC = 25;
/** Pull requests whose reviews one sync reads; the rest wait in the cursor's queue. */
const REVIEW_READS_PER_SYNC = 30;
/** File tree items are packed up to this size, and there are at most `MAX_TREE_ITEMS` of them. */
const TREE_ITEM_CHARS = 1_500;
const MAX_TREE_ITEMS = 20;

/**
 * `owner/name`, the only repository identifier we accept. A name of `.` or `..`
 * is refused: GitHub allows neither, and in a request URL either one would walk
 * out of `/repos/owner/`.
 */
export function parseRepoFullName(value: string): { owner: string; name: string } {
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)$/.exec(value.trim());
  if (!m || m[2] === "." || m[2] === "..") throw new GitHubConnectorError("Repository must be given as owner/name.");
  return { owner: m[1], name: m[2] };
}

export interface GitHubSyncItem {
  /**
   * Stable per-source item id: `readme` (the README's first section),
   * `readme-<n>` (its n-th section, from 2), `issue-<n>`, `pr-<n>`,
   * `commit-<sha>`, `comment-<id>`, `review-<id>`, `tree` and `tree-<n>` (the
   * file tree's parts), `doc:<path>` (a doc's first section) and
   * `doc-<n>:<path>` (its n-th section).
   */
  id: string;
  text: string;
  author: string;
  /** ISO-8601 from GitHub (updated_at / commit date), used as referenceTime. */
  createdAt?: string;
  /** Hash of the text; a changed issue or PR re-ingests, an unchanged one is skipped. */
  checksum: string;
  /**
   * What names the item, which the memory service stores verbatim (see `itemHeading`).
   * Set on every item `listRepositoryItems` returns.
   */
  heading?: string;
}

/** Longest heading sent; the memory service refuses one over 1,000 characters. */
const MAX_HEADING_CHARS = 300;
/** Longest item id a heading carries whole; `itemHeading` shortens a longer one. */
const MAX_HEADING_ID_CHARS = 120;
/** Longest repository name a heading carries, GitHub's own limit; a longer one is left out. */
const MAX_REPO_CHARS = 140;

/**
 * What names a stored item, so it can be found by the line its change event is titled with.
 *
 * Extraction states what an item says and drops what it is called, so the memory service
 * stores this verbatim. It is the item's first line (what it is: "Document docs/setup.md in
 * acme/app (<link>)", "Comment on issue #7 by ana:"), the first line of what it says, and
 * the repository and item id. The id is there because items can share both lines (two
 * sections of a doc under the same sub-heading, two "LGTM" comments by one author), and two
 * headings with one text are served as one fact, keyed to only one of the items.
 *
 * Stored verbatim, so it is never scrubbed: when the heading as a whole may hold a secret or
 * an address in any encoding (`holdsSecretOrAddress`), the second line goes, then the first,
 * and only the id's digest is left. Over-dropping only makes an item harder to find; a scrub
 * that missed an encoding would leak. Kept within `MAX_HEADING_CHARS` by cutting the lines,
 * never the id.
 */
export function itemHeading(repoFullName: string, item: Pick<GitHubSyncItem, "id" | "text">): string {
  const digest = checksumOf(item.id).slice(0, 16);
  // Spaced as the change feed spaces its summary, so the first line reads as the title does.
  const [first = "", ...rest] = item.text.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim());
  const said = rest.find((line) => line !== "");
  // A long id is shortened to its start and its digest, which stays distinct.
  const ids = Array.from(item.id);
  const shortId = ids.length > MAX_HEADING_ID_CHARS ? `${ids.slice(0, 40).join("")}… ${digest}` : item.id;
  const repo = Array.from(repoFullName).length <= MAX_REPO_CHARS ? `${repoFullName} ` : "";
  // The fullest heading whose whole text, every part together and the id whole, holds no
  // secret or address in any encoding; the id's digest alone when none does. Checked whole
  // because an address can be split across parts, and before any cut, so a cut never shows
  // part of what the check refused.
  const candidates: [lines: string[], id: string][] = [
    [[first, said ?? ""], shortId],
    [[first], shortId],
  ];
  for (const [lines, id] of candidates) {
    const named = lines.filter(Boolean).join("\n");
    if (holdsSecretOrAddress(`${named}\n${repoFullName} ${item.id}`)) continue;
    const suffix = Array.from(`(${repo}${id})`);
    const room = Math.max(0, MAX_HEADING_CHARS - suffix.length - 1);
    const chars = Array.from(named);
    const cut = chars.length > room ? (room > 1 ? `${chars.slice(0, room - 1).join("")}…` : "") : named;
    return cut ? `${cut}\n${suffix.join("")}` : suffix.join("");
  }
  return `(${holdsSecretOrAddress(repoFullName) ? "" : repo}${digest})`;
}

function checksumOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function clip(text: string): string {
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text;
}

/** Text as it may be stored: secrets and email addresses removed, then clipped. */
function storable(text: string): string {
  return clip(scanForSecrets(text, { removeEmails: true }).text);
}

/** Markdown as heading sections with wrapped lines joined, each cleaned for storage. */
function storableSections(markdown: string, max: number): string[] {
  return splitMarkdownSections(unwrapMarkdown(markdown), README_SECTION_CHARS).slice(0, max).map(storable);
}

/**
 * One item per README section, each with its wrapped lines joined, so a
 * sentence reaches extraction whole and a long README is not one episode that
 * extraction only partly covers. The first section keeps the id `readme`, so
 * a one-section README is stored exactly as a whole-file item was.
 */
export function readmeItems(repoFullName: string, markdown: string, author: string): GitHubSyncItem[] {
  return storableSections(markdown, MAX_README_SECTIONS).map((text, i) => {
    return {
      id: i === 0 ? "readme" : `readme-${i + 1}`,
      text: `README of ${repoFullName}\n\n${text}`,
      author,
      checksum: checksumOf(text),
    };
  });
}

/**
 * GitHub's wording when a token lacks the permission an endpoint needs (a
 * fine-grained token without Issues read, for one). A rate-limited request is
 * also a 403, with different wording, and must keep failing the sync rather
 * than read as "this token may not see issues".
 */
const PERMISSION_DENIED = /resource not accessible by/i;

type GetResult<T> = { status: 200; body: T } | { status: "gone"; body: null } | { status: "forbidden"; body: null };

/** 404, and 410 for a deleted issue. */
const GONE_STATUSES = [404, 410];

/**
 * GitHub's wording when an organization's policy blocks the token from its
 * repositories: SAML single sign-on, an IP allow list, or a ban on classic or
 * long-lived tokens ("forbids access via a personal access token").
 */
const ORG_POLICY_BLOCKED = /SAML enforcement|single sign-on|IP allow list|forbids access via/i;

function request(path: string, token: string): Promise<Response> {
  return fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "willder-connector",
    },
  });
}

async function get<T>(path: string, token: string, goneStatuses = GONE_STATUSES): Promise<GetResult<T>> {
  const res = await request(path, token);
  if (goneStatuses.includes(res.status)) return { status: "gone", body: null };
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    if (res.status === 403 && PERMISSION_DENIED.test(err)) return { status: "forbidden", body: null };
    throw new GitHubConnectorError(`GitHub ${path} failed: ${res.status} ${err}`, res.status);
  }
  return { status: 200, body: (await res.json()) as T };
}

interface RawRepository {
  full_name: string;
  default_branch: string;
}

/** What the person who connected `repoFullName` reads when its token cannot read it. */
function noAccessMessage(repoFullName: string): string {
  return `This token can't read ${repoFullName}. GitHub gives that answer when the repository is private and the token was not granted it, and also when the repository was deleted. Grant the token access to ${repoFullName} and reconnect, or disconnect this source if the repository is gone.`;
}

/**
 * Read the repository itself. A 404 and a permission or organization-policy
 * 403 throw `SourceAccessError` naming the fix. A rejected token (401), a rate
 * limit, a 5xx or anything else throws `GitHubConnectorError`, which a later
 * attempt may get past: a 401 by a reconnect that stored a new token.
 */
async function readRepository(repoFullName: string, token: string): Promise<RawRepository> {
  const { owner, name } = parseRepoFullName(repoFullName);
  const path = `/repos/${owner}/${name}`;
  const res = await request(path, token);
  if (res.ok) return (await res.json()) as RawRepository;
  const err = await res.text().catch(() => res.statusText);
  const fullName = `${owner}/${name}`;
  if (res.status === 404 || (res.status === 403 && (PERMISSION_DENIED.test(err) || ORG_POLICY_BLOCKED.test(err)))) {
    throw new SourceAccessError(noAccessMessage(fullName));
  }
  throw new GitHubConnectorError(`GitHub ${path} failed: ${res.status} ${err}`, res.status);
}

/**
 * Confirm `token` can read `repoFullName` before a source is connected with it,
 * so a token without access is refused with the fix instead of connecting a
 * source that syncs nothing. Throws `SourceAccessError` for a token GitHub
 * rejects or one that cannot read the repository, and `GitHubConnectorError`
 * when GitHub did not say (a rate limit, a 5xx).
 */
export async function assertRepositoryReadable(repoFullName: string, token: string): Promise<void> {
  if (!token) throw new GitHubConnectorError("GitHub token is required.");
  try {
    await readRepository(repoFullName, token);
  } catch (e) {
    if (e instanceof GitHubConnectorError && e.status === 401) {
      throw new SourceAccessError(
        "GitHub rejected this token. It may have expired, been revoked or been copied incompletely. Create a new one and paste it again.",
      );
    }
    throw e;
  }
}

interface RawIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  updated_at: string;
  user?: { login?: string } | null;
  pull_request?: unknown;
  labels?: { name?: string }[];
}
interface RawPull extends RawIssue {
  merged_at: string | null;
  draft?: boolean;
  head?: { ref?: string };
  base?: { ref?: string };
}
interface RawCommit {
  sha: string;
  commit: { message: string; author?: { name?: string; date?: string } | null };
  author?: { login?: string } | null;
}
/** A comment from the repository-wide issue comments listing, which covers pull requests' conversations too. */
interface RawComment {
  id: number;
  body: string | null;
  updated_at: string;
  html_url: string;
  issue_url: string;
  user?: { login?: string } | null;
}
interface RawReview {
  id: number;
  body: string | null;
  state: string;
  submitted_at?: string | null;
  user?: { login?: string } | null;
}
interface RawTree {
  tree: { path: string; type: string; sha: string }[];
  truncated: boolean;
}
interface RawBlob {
  content?: string;
  encoding?: string;
}

/**
 * The parts of a repository a sync reads, each behind its own token permission.
 * `files` is the file tree and the docs read from it.
 */
type GitHubItemKind = "readme" | "issues" | "pulls" | "commits" | "comments" | "reviews" | "files";

/** The kinds read a page at a time, from a cursor. */
type PagedKind = "issues" | "pulls" | "commits" | "comments";

/** What an issue comment can be on: an issue, or a pull request's conversation. */
const COMMENT_PARENTS = ["issues", "pulls"] as const;
type CommentParent = (typeof COMMENT_PARENTS)[number];

/**
 * What a comment is on, read from its `html_url` path
 * (`/<owner>/<repo>/issues/<n>` or `/<owner>/<repo>/pull/<n>`), or null for
 * any other shape. Read by path segment, not substring: a repository named
 * `pull` puts `/pull/` into the URL of every issue it has.
 */
function commentParent(comment: Pick<RawComment, "html_url">): CommentParent | null {
  let segments: string[];
  try {
    segments = new URL(comment.html_url).pathname.split("/");
  } catch {
    return null;
  }
  if (segments.length !== 5 || !/^\d+$/.test(segments[4])) return null;
  if (segments[3] === "issues") return "issues";
  if (segments[3] === "pull") return "pulls";
  return null;
}

/** Which kind a stored item id belongs to, by the prefix `GitHubSyncItem.id` gives it. */
function kindOfId(id: string): GitHubItemKind | null {
  if (/^readme(-\d+)?$/.test(id)) return "readme";
  if (/^issue-\d+$/.test(id)) return "issues";
  if (/^pr-\d+$/.test(id)) return "pulls";
  if (/^commit-[0-9a-f]+$/.test(id)) return "commits";
  if (/^comment-\d+$/.test(id)) return "comments";
  if (/^review-\d+$/.test(id)) return "reviews";
  if (/^tree(-\d+)?$/.test(id) || /^doc(-\d+)?:./.test(id)) return "files";
  return null;
}

/** The path of a doc item id, or null for any other id. */
function docPathOfId(id: string): string | null {
  return /^doc(-\d+)?:./.test(id) ? id.slice(id.indexOf(":") + 1) : null;
}

/** Root-level or .github/ files that hold a project's rules, history or design. */
const PROJECT_DOC =
  /^(?:\.github\/|docs?\/)?(?:contributing|changelog|changes|history|architecture|governance|security)(?:\.(?:md|markdown|mdx|rst|txt))?$/i;
/** A text file under a docs or decision-record directory, at any depth. */
const DOCS_DIR_FILE = /(?:^|\/)(?:docs?|adrs?|decisions|rfcs?)\/(?:.+\/)?[^/]+\.(?:md|markdown|mdx|rst|txt)$/i;
/** A decision record by its directory or its conventional file name. */
const DECISION_RECORD = /(?:^|\/)(?:adrs?|decisions)\/|(?:^|\/)adr[-_]?\d+/i;

/** Directories holding someone else's code, whose docs are not this project's. */
const VENDORED = /(?:^|\/)(?:node_modules|vendor|third[_-]party|bower_components|\.venv|site-packages)\//i;

/**
 * Whether a path in the tree is a doc this connector saves. The root README is
 * read on its own, and vendored code's docs are not the project's.
 */
export function isDocPath(path: string): boolean {
  if (/^readme(?:\.[a-z]+)?$/i.test(path) || VENDORED.test(path)) return false;
  return PROJECT_DOC.test(path) || DOCS_DIR_FILE.test(path);
}

/** How a doc's text introduces it, so extraction knows a rule from a record of what changed. */
function docLabel(path: string): string {
  if (DECISION_RECORD.test(path)) return "Decision record";
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (name.startsWith("contributing")) return "Contribution rules";
  if (name.startsWith("changelog") || name.startsWith("changes") || name.startsWith("history")) return "Changelog";
  return "Document";
}

/**
 * Wording that marks a review or a pull request comment as a decision rather
 * than conversation: an approval or a block, a choice between options, an
 * agreement. Issue comments are kept whole; this filters only pull request
 * chatter, which the commit and the PR description already summarize.
 */
const DECIDES_SOMETHING =
  /\b(?:decided?|decision|agreed?|let'?s (?:go|use|keep|drop)|going with|we(?:'ll| will) (?:use|go|keep|drop)|instead of|lgtm|approved?|blocking|must not|won'?t (?:fix|merge)|rejected?|not merging)\b/i;

/** Issues a pull request description says it closes, by GitHub's closing keywords. */
function linkedIssues(body: string | null): number[] {
  const found = new Set<number>();
  for (const m of (body ?? "").matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)\b/gi))
    found.add(Number(m[1]));
  return [...found];
}

/**
 * Where a listing read newest first stands between syncs: pull requests and
 * commits. A listing longer than one sync's pages is finished by the syncs
 * after it.
 */
export type GitHubPass = {
  /**
   * Read nothing older than this: the start of the last finished pass, less
   * `OVERLAP_MS`. Absent until a pass finishes, so the first one reads the
   * whole history.
   */
  since?: string;
  /** Set while a pass is unfinished: when it started (it reads no commit newer) and the page it reads next. */
  startedAt?: string;
  page?: number;
};

/**
 * Where a listing read oldest change first stands between syncs: issues and
 * issue comments, the kinds GitHub lets anyone with the rights delete. Each
 * request asks for what changed at or after `since`, so a row deleted or
 * changed behind the read moves no row ahead of it. See `readChangedPages`.
 */
export type GitHubChangesPass = {
  /** The next request's `since`. Absent before the first page, so a first sync starts at the oldest change. */
  since?: string;
  /**
   * The page of `since` to read next, when above 1: only inside a run of more
   * than a page of rows that changed within one second.
   */
  page?: number;
};

/** What a GitHub source's next sync continues from. The sync job stores it on `Source.meta`. */
export type GitHubSyncCursor = {
  issues: GitHubChangesPass;
  pulls: GitHubPass;
  commits: GitHubPass;
  comments: GitHubChangesPass;
  /** Pull requests whose reviews are still to be read, oldest queued first. */
  reviewQueue: number[];
  /** Each doc path already read, with the blob sha it was read at; a doc whose sha moved is read again. */
  docs: Record<string, string>;
  /** Where the next deletion probe starts in the stored items, sorted by id. */
  probeOffset: number;
  /**
   * The parents GitHub refused at the last sync, whose comments that sync left
   * out. A change here restarts the comments pass: see `listRepositoryItems`.
   */
  refusedParents: CommentParent[];
};

/** A first sync's cursor: every kind reads its whole history. */
export function initialCursor(): GitHubSyncCursor {
  return {
    issues: {},
    pulls: {},
    commits: {},
    comments: {},
    reviewQueue: [],
    docs: {},
    probeOffset: 0,
    refusedParents: [],
  };
}

function isTime(value: unknown): boolean {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isPass(value: unknown): value is GitHubPass {
  if (!value || typeof value !== "object") return false;
  const { since, startedAt, page } = value as Record<string, unknown>;
  if (since !== undefined && !isTime(since)) return false;
  if (startedAt === undefined && page === undefined) return true;
  return isTime(startedAt) && Number.isInteger(page) && (page as number) >= 1;
}

/**
 * A stored `GitHubChangesPass`, or null when it is not one. A pass stored while
 * these listings were read newest first counted its page from the newest
 * change, which locates nothing oldest first, so it restarts from its `since`.
 */
function parseChangesPass(value: unknown): GitHubChangesPass | null {
  if (!value || typeof value !== "object") return null;
  const { since, startedAt, page } = value as Record<string, unknown>;
  if (since !== undefined && !isTime(since)) return null;
  const from: GitHubChangesPass = since === undefined ? {} : { since: since as string };
  if (startedAt !== undefined) return isPass(value) ? from : null;
  if (page === undefined) return from;
  return since !== undefined && Number.isInteger(page) && (page as number) >= 2
    ? { ...from, page: page as number }
    : null;
}

function isDocShas(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((sha) => typeof sha === "string")
  );
}

/**
 * A stored cursor, or null when there is none or it is not one this file wrote.
 * A cursor stored before comments, reviews and docs were read lacks those
 * fields; they start from the beginning while the other kinds carry on.
 */
export function parseCursor(value: unknown): GitHubSyncCursor | null {
  if (!value || typeof value !== "object") return null;
  const c = value as Record<string, unknown>;
  const issues = parseChangesPass(c.issues);
  if (!issues || !isPass(c.pulls) || !isPass(c.commits)) return null;
  if (!Number.isInteger(c.probeOffset) || (c.probeOffset as number) < 0) return null;
  const comments = parseChangesPass(c.comments ?? {});
  const reviewQueue = c.reviewQueue ?? [];
  const docs = c.docs ?? {};
  // A cursor stored before this field existed names no refused parent; the
  // next sync then retires any stored comment whose parent GitHub now refuses.
  const refusedParents = c.refusedParents ?? [];
  if (!comments || !isDocShas(docs)) return null;
  if (!Array.isArray(reviewQueue) || !reviewQueue.every((n) => Number.isInteger(n) && n > 0)) return null;
  if (
    !Array.isArray(refusedParents) ||
    !refusedParents.every((p) => (COMMENT_PARENTS as readonly unknown[]).includes(p))
  )
    return null;
  return {
    issues,
    pulls: c.pulls,
    commits: c.commits,
    comments,
    reviewQueue: reviewQueue as number[],
    docs,
    probeOffset: c.probeOffset as number,
    refusedParents: refusedParents as CommentParent[],
  };
}

/** ISO-8601 to the second, as GitHub writes and reads its timestamps. */
function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface GitHubListing {
  /** The README and file tree, and every issue, comment, pull request, review, commit and doc this sync read. */
  items: GitHubSyncItem[];
  /**
   * Parts GitHub refused the token, skipped rather than failing the whole
   * sync. Their stored items are in `gone`: content the token can no longer
   * read stops being retrievable, the same as a revoked grant. Comments and
   * reviews follow the issue or pull request they are on and are not named
   * when that parent is: they are named only when GitHub refuses them itself.
   */
  unreadable: GitHubItemKind[];
  /** Stored item ids GitHub shows are gone. The only ones a sync may retire. */
  gone: string[];
  /** Where the next sync continues from. */
  cursor: GitHubSyncCursor;
  /**
   * What to store instead when an item of this sync fails to write: every pass
   * where it started, so the failed item is listed again, except a kind the token
   * lost, which restarts as in `cursor`; and the deletion probe moved on, so a
   * source that keeps failing still reaches every stored item.
   */
  heldCursor: GitHubSyncCursor;
}

interface PagedRead<T> {
  rows: T[];
  next: GitHubPass;
}

/**
 * Read one kind's pages, newest first, from where `pass` stands, until at
 * least `ITEMS_PER_KIND` rows of the kind are in or `MAX_PAGES_PER_KIND` pages
 * are read. A page shorter than `PER_PAGE`, or one reaching past `since`, finishes
 * the pass, and the next one reads back to its start less the overlap.
 * Otherwise the next sync continues at the following page.
 *
 * `updatedAt` drops rows older than `since` for an endpoint that cannot filter
 * them itself; without it the endpoint's own `since` is trusted. `isOfKind`
 * picks the rows of the kind from a listing that returns others too; only those
 * count toward `ITEMS_PER_KIND`, and only those are returned. An item changed
 * while a pass is under way moves to the top of the listing, so the pages below
 * it shift down and repeat a row rather than skip one; the repeat is skipped by
 * checksum. A deleted row would shift them up and skip one, which is why the
 * kinds GitHub lets users delete are read by `readChangedPages` instead: a pull
 * request cannot be deleted, and the commits pass is bounded by `until`.
 */
async function readPages<T>(
  pass: GitHubPass,
  now: number,
  url: (page: number, startedAt: string) => string,
  token: string,
  { updatedAt, isOfKind }: { updatedAt?: (row: T) => string; isOfKind?: (row: T) => boolean } = {},
): Promise<PagedRead<T> | "forbidden"> {
  const startedAt = pass.startedAt ?? isoSeconds(now);
  const since = pass.since ? Date.parse(pass.since) : null;
  const finished: GitHubPass = { since: isoSeconds(Date.parse(startedAt) - OVERLAP_MS) };
  const rows: T[] = [];
  let page = pass.page ?? 1;
  for (let read = 0; read < MAX_PAGES_PER_KIND && rows.length < ITEMS_PER_KIND; read++, page++) {
    const res = await get<T[]>(url(page, startedAt), token);
    if (res.status === "forbidden") return "forbidden";
    const batch = Array.isArray(res.body) ? res.body : [];
    const recent = since === null || !updatedAt ? batch : batch.filter((row) => Date.parse(updatedAt(row)) >= since);
    rows.push(...(isOfKind ? recent.filter(isOfKind) : recent));
    if (batch.length < PER_PAGE || recent.length < batch.length) return { rows, next: finished };
  }
  return { rows, next: { ...(pass.since ? { since: pass.since } : {}), startedAt, page } };
}

/** Newest-first pages a pass with no `since` reads before its oldest-first read, so a first sync holds current work. */
const NEWEST_WINDOW_PAGES = 2;

/**
 * Read one kind's changes oldest first (`sort=updated&direction=asc`), from
 * `pass.since`, until at least `ITEMS_PER_KIND` rows of the kind are in or
 * `MAX_PAGES_PER_KIND` pages are read. Each next request asks again from the
 * last row read, rather than for the next page number, so a row deleted or
 * changed behind the read shifts nothing ahead of it: a changed row moves past
 * the read and is met again with its new content. GitHub's `since` has second
 * precision, and its docs say "after", so the next request starts one second
 * before the last row; once a page holds a row stamped exactly `since`, the
 * endpoint is shown to include that second and the next request starts at the
 * last row itself. Either way the boundary rows are read again, and `keyOf`
 * keeps one row per item, the last one read.
 *
 * Only when a whole page sits in one second does `since` stay where it is and
 * the read turn to its next page. The page where the run ends is not trusted:
 * a row deleted or changed behind the read may have shifted it, so the read
 * asks again from the second after the run, and no row after a run is
 * skipped. When the run's last page comes back short, the next sync reads the
 * run again from its start, so a run near the end of the listing is read again
 * each sync until newer changes fill the page that ends it. A run longer than
 * one page can still lose one of its own rows per row deleted or changed
 * behind the read, when newer rows fill the page that ends it.
 *
 * A pass with no `since` (a first sync, or a kind read again from the start)
 * first reads the newest `NEWEST_WINDOW_PAGES` pages newest first, so the
 * person who connected sees current work at once; they count toward the
 * budget, store no position, and the oldest-first read then reads at least one
 * page, so one sync can bring up to `ITEMS_PER_KIND + PER_PAGE` rows. A short
 * first window page holds the whole listing and ends the pass.
 *
 * A short oldest-first page on page 1 is the present, and the next sync reads
 * again from `OVERLAP_MS` before this one. Otherwise it continues from `since`.
 * `isOfKind` picks the kind's rows from a listing that returns others too;
 * only those count and are returned, though every row moves `since`.
 */
async function readChangedPages<T extends { updated_at: string }>(
  pass: GitHubChangesPass,
  now: number,
  url: (since: string | undefined, page: number, direction: "asc" | "desc") => string,
  token: string,
  { keyOf, isOfKind = () => true }: { keyOf: (row: T) => number; isOfKind?: (row: T) => boolean },
): Promise<{ rows: T[]; next: GitHubChangesPass } | "forbidden"> {
  const rows = new Map<number, T>();
  const keep = (batch: T[]) => {
    for (const row of batch) {
      if (!isOfKind(row)) continue;
      rows.delete(keyOf(row));
      rows.set(keyOf(row), row);
    }
  };
  const caughtUp = () => ({ rows: [...rows.values()], next: { since: isoSeconds(now - OVERLAP_MS) } });
  let read = 0;
  if (pass.since === undefined) {
    for (let page = 1; page <= NEWEST_WINDOW_PAGES; page++, read++) {
      const res = await get<T[]>(url(undefined, page, "desc"), token);
      if (res.status === "forbidden") return "forbidden";
      const batch = Array.isArray(res.body) ? res.body : [];
      keep(batch);
      // A short first page is the whole listing. A short later page may only
      // mean a row left the window behind the read, so the oldest-first read
      // below runs as usual.
      if (batch.length < PER_PAGE && page === 1) return caughtUp();
      if (batch.length < PER_PAGE) break;
    }
  }
  let since = pass.since;
  let page = pass.page ?? 1;
  for (
    let ascending = 0;
    read < MAX_PAGES_PER_KIND && (ascending === 0 || rows.size < ITEMS_PER_KIND);
    read++, ascending++
  ) {
    const res = await get<T[]>(url(since, page, "asc"), token);
    if (res.status === "forbidden") return "forbidden";
    const batch = Array.isArray(res.body) ? res.body : [];
    keep(batch);
    if (batch.length < PER_PAGE) {
      // Past page 1 of a same-second run, a short page may only mean rows left
      // the run behind the read, so the next sync reads the run again from its start.
      return page > 1 ? { rows: [...rows.values()], next: { since } } : caughtUp();
    }
    const stamp = batch[batch.length - 1].updated_at;
    const last = Date.parse(stamp);
    if (Number.isNaN(last))
      throw new GitHubConnectorError(`GitHub listed a row without a readable updated_at: ${stamp}`);
    if (page > 1) {
      // Inside a same-second run: at `since`, or the second after it when `since` excludes its own.
      const run = [Date.parse(since as string), Date.parse(since as string) + 1000];
      const first = Date.parse(batch[0].updated_at);
      if (first === last && run.includes(last)) {
        page++;
        continue;
      }
      // The run ended on this page. A row deleted or changed behind the read
      // shifted this page, so ask again for everything after the run from page 1.
      since = isoSeconds(run[1]);
      page = 1;
      continue;
    }
    const includesSince =
      since !== undefined && batch.some((row) => Date.parse(row.updated_at) === Date.parse(since as string));
    const resume = isoSeconds(includesSince ? last : last - 1000);
    if (since === undefined || Date.parse(resume) > Date.parse(since)) {
      since = resume;
      page = 1;
    } else {
      page++;
    }
  }
  return { rows: [...rows.values()], next: { since, ...(page > 1 ? { page } : {}) } };
}

function issueItem(issue: RawIssue, owner: string): GitHubSyncItem {
  const labels = (issue.labels ?? [])
    .map((l) => l.name)
    .filter(Boolean)
    .join(", ");
  const text = storable(
    `Issue #${issue.number} (${issue.state}${labels ? `; ${labels}` : ""}): ${issue.title}\n\n${issue.body ?? ""}`.trim(),
  );
  return {
    id: `issue-${issue.number}`,
    text,
    author: issue.user?.login ?? owner,
    createdAt: issue.updated_at,
    checksum: checksumOf(text),
  };
}

function pullItem(pr: RawPull, owner: string): GitHubSyncItem {
  const state = pr.merged_at ? "merged" : pr.draft ? "draft" : pr.state;
  const linked = linkedIssues(pr.body);
  const links = linked.length ? `\nLinked issues: ${linked.map((n) => `#${n}`).join(", ")}` : "";
  const text = storable(
    `Pull request #${pr.number} (${state}; ${pr.head?.ref ?? "?"} → ${pr.base?.ref ?? "?"}): ${pr.title}${links}\n\n${pr.body ?? ""}`.trim(),
  );
  return {
    id: `pr-${pr.number}`,
    text,
    author: pr.user?.login ?? owner,
    createdAt: pr.updated_at,
    checksum: checksumOf(text),
  };
}

/**
 * The author is the account login or the git author's name, never the git
 * author's email; a name that is itself an email address loses it too.
 */
function commitItem(c: RawCommit, owner: string): GitHubSyncItem {
  const text = storable(`Commit ${c.sha.slice(0, 7)}: ${c.commit.message}`);
  const author = c.author?.login ?? (c.commit.author?.name ? storable(c.commit.author.name) : owner);
  return { id: `commit-${c.sha}`, text, author, createdAt: c.commit.author?.date, checksum: checksumOf(text) };
}

/**
 * An issue comment, kept whole; a comment on a pull request's conversation
 * only when it decides something. Null for a comment that is not kept.
 */
function commentItem(comment: RawComment, owner: string): GitHubSyncItem | null {
  const number = /\/issues\/(\d+)$/.exec(comment.issue_url)?.[1];
  const body = (comment.body ?? "").trim();
  if (!number || !body) return null;
  const onPull = commentParent(comment) === "pulls";
  if (onPull && !DECIDES_SOMETHING.test(body)) return null;
  const author = comment.user?.login ?? owner;
  const text = storable(`Comment on ${onPull ? "pull request" : "issue"} #${number} by ${author}:\n\n${body}`);
  return { id: `comment-${comment.id}`, text, author, createdAt: comment.updated_at, checksum: checksumOf(text) };
}

const REVIEW_VERDICT: Record<string, string> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
};

/**
 * A review that decides something: every approval and every request for
 * changes, and a comment-only or dismissed review whose text decides
 * something. Null for any other review. The review's text is kept; the inline
 * diff comments under it never are.
 */
function reviewItem(review: RawReview, pull: number, owner: string): GitHubSyncItem | null {
  const verdict = REVIEW_VERDICT[review.state];
  const body = (review.body ?? "").trim();
  if (!verdict) return null;
  const decisive = review.state === "APPROVED" || review.state === "CHANGES_REQUESTED" || DECIDES_SOMETHING.test(body);
  if (!decisive) return null;
  const author = review.user?.login ?? owner;
  const text = storable(`Review of pull request #${pull} by ${author}: ${verdict}${body ? `\n\n${body}` : "."}`);
  return {
    id: `review-${review.id}`,
    text,
    author,
    createdAt: review.submitted_at ?? undefined,
    checksum: checksumOf(text),
  };
}

/** The repository's file paths, packed into at most `MAX_TREE_ITEMS` items. Paths only, never contents. */
function treeItems(repoFullName: string, paths: string[], truncated: boolean, owner: string): GitHubSyncItem[] {
  const parts: string[][] = [[]];
  let size = 0;
  for (const path of paths) {
    if (size + path.length + 1 > TREE_ITEM_CHARS && parts[parts.length - 1].length > 0) {
      if (parts.length === MAX_TREE_ITEMS) break;
      parts.push([]);
      size = 0;
    }
    parts[parts.length - 1].push(path);
    size += path.length + 1;
  }
  if (paths.length === 0) return [];
  const listed = parts.reduce((n, part) => n + part.length, 0);
  const partial = truncated || listed < paths.length ? `, first ${listed} paths` : "";
  return parts.map((part, i) => {
    const text = storable(
      `File tree of ${repoFullName} (paths only${partial}, part ${i + 1} of ${parts.length})\n\n${part.join("\n")}`,
    );
    return { id: i === 0 ? "tree" : `tree-${i + 1}`, text, author: owner, checksum: checksumOf(text) };
  });
}

/** One item per section of a doc, each with a link back to the file on GitHub. */
function docItems(
  repoFullName: string,
  branch: string,
  path: string,
  markdown: string,
  owner: string,
): GitHubSyncItem[] {
  // The path and the branch are the repository's to name, so each is cleaned before it is
  // encoded into the link, where a secret's characters would no longer read as one, and the
  // label line is cleaned again whole, like every other text the sync stores.
  const clean = (value: string) => scanForSecrets(value, { removeEmails: true }).text;
  const shownPath = clean(path);
  const link = `https://github.com/${repoFullName}/blob/${encodeURIComponent(clean(branch))}/${shownPath.split("/").map(encodeURIComponent).join("/")}`;
  const label = storable(`${docLabel(path)} ${shownPath} in ${repoFullName} (${link})`);
  return storableSections(markdown, MAX_DOC_SECTIONS).map((section, i) => {
    const text = `${label}\n\n${section}`;
    return { id: i === 0 ? `doc:${path}` : `doc-${i + 1}:${path}`, text, author: owner, checksum: checksumOf(text) };
  });
}

/** The one-item endpoint for a stored id, and the statuses that mean GitHub no longer has that item. */
function probeRequest(base: string, id: string): { path: string; goneStatuses: number[] } | null {
  const key = id.slice(id.indexOf("-") + 1);
  switch (kindOfId(id)) {
    case "issues":
      return { path: `${base}/issues/${key}`, goneStatuses: GONE_STATUSES };
    case "pulls":
      return { path: `${base}/pulls/${key}`, goneStatuses: GONE_STATUSES };
    // 422 is GitHub's "No commit found for SHA", its answer once a force-push
    // dropped the commit and it was collected.
    case "commits":
      return { path: `${base}/commits/${key}`, goneStatuses: [...GONE_STATUSES, 422] };
    case "comments":
      return { path: `${base}/issues/comments/${key}`, goneStatuses: GONE_STATUSES };
    // A submitted review cannot be deleted, only dismissed, and the tree and
    // docs are read whole each sync, so none of these needs a probe.
    default:
      return null;
  }
}

/**
 * Ask GitHub directly about up to `PROBES_PER_SYNC` of `candidates`, a
 * different slice each sync, and return the ones it no longer has. A deleted
 * issue never shows up in a listing again, so this is how its content leaves
 * memory. A probe the token is not permitted to make proves nothing.
 */
async function probeStoredItems(
  base: string,
  candidates: string[],
  offset: number,
  token: string,
): Promise<{ gone: string[]; nextOffset: number }> {
  if (candidates.length === 0) return { gone: [], nextOffset: 0 };
  const sorted = [...candidates].sort();
  const start = offset % sorted.length;
  const batch = [...sorted.slice(start), ...sorted.slice(0, start)].slice(0, PROBES_PER_SYNC);
  const gone: string[] = [];
  for (const id of batch) {
    const request = probeRequest(base, id);
    if (!request) continue;
    const res = await get<unknown>(request.path, token, request.goneStatuses);
    if (res.status === "gone") gone.push(id);
  }
  return { gone, nextOffset: (start + batch.length) % sorted.length };
}

/** What `readFiles` found: the tree and doc items, which docs exist, and the doc shas to store. */
interface FilesRead {
  items: GitHubSyncItem[];
  /** Every doc path the tree holds now; null when the tree was cut short and absence proves nothing. */
  docPaths: Set<string> | null;
  /** Docs read whole this sync: a stored section of one that is no longer listed is gone. */
  readDocs: Set<string>;
  docs: Record<string, string>;
}

/**
 * Read the default branch's file tree, keep its paths as tree items, and read
 * the docs in it that are new or changed since `known` (path to blob sha), at
 * most `DOC_READS_PER_SYNC` of them. An empty repository or a missing default
 * branch has no files, which is not an error.
 */
async function readFiles(
  base: string,
  repoFullName: string,
  branch: string,
  known: Record<string, string>,
  owner: string,
  token: string,
): Promise<FilesRead | "forbidden"> {
  // 409 is GitHub's "Git Repository is empty".
  const tree = await get<RawTree>(`${base}/git/trees/${encodeURIComponent(branch)}?recursive=1`, token, [
    ...GONE_STATUSES,
    409,
  ]);
  if (tree.status === "forbidden") return "forbidden";
  if (tree.status === "gone") return { items: [], docPaths: new Set(), readDocs: new Set(), docs: {} };

  const entries = Array.isArray(tree.body?.tree) ? tree.body.tree : [];
  const blobs = entries.filter((entry) => entry.type === "blob");
  const items = treeItems(
    repoFullName,
    blobs.map((entry) => entry.path),
    tree.body.truncated,
    owner,
  );
  const docBlobs = blobs.filter((entry) => isDocPath(entry.path)).slice(0, MAX_DOC_FILES);
  const docs: Record<string, string> = {};
  const readDocs = new Set<string>();
  for (const { path, sha } of docBlobs) {
    if (known[path] !== undefined) docs[path] = known[path];
    if (known[path] === sha || readDocs.size >= DOC_READS_PER_SYNC) continue;
    const blob = await get<RawBlob>(`${base}/git/blobs/${sha}`, token);
    if (blob.status === "forbidden") return "forbidden";
    readDocs.add(path);
    docs[path] = sha;
    if (blob.status === "gone" || blob.body.encoding !== "base64" || !blob.body.content) continue;
    items.push(
      ...docItems(repoFullName, branch, path, Buffer.from(blob.body.content, "base64").toString("utf8"), owner),
    );
  }
  return {
    items,
    docPaths: tree.body.truncated ? null : new Set(docBlobs.map((entry) => entry.path)),
    readDocs,
    docs,
  };
}

/**
 * Read the deciding reviews of up to `REVIEW_READS_PER_SYNC` pull requests from
 * `queue`, and return the ones still waiting. A pull request with more than
 * one page of reviews keeps its first `PER_PAGE`.
 */
async function readReviews(
  base: string,
  queue: number[],
  owner: string,
  token: string,
): Promise<{ items: GitHubSyncItem[]; remaining: number[] } | "forbidden"> {
  const items: GitHubSyncItem[] = [];
  for (const pull of queue.slice(0, REVIEW_READS_PER_SYNC)) {
    const res = await get<RawReview[]>(`${base}/pulls/${pull}/reviews?per_page=${PER_PAGE}`, token);
    if (res.status === "forbidden") return "forbidden";
    if (res.status === "gone" || !Array.isArray(res.body)) continue;
    for (const review of res.body) {
      const item = reviewItem(review, pull, owner);
      if (item) items.push(item);
    }
  }
  return { items, remaining: queue.slice(REVIEW_READS_PER_SYNC) };
}

/**
 * List one repository's README, file tree and docs, and the issues, issue
 * comments, pull requests, reviews and commits changed since `cursor`,
 * read-only, and name the `stored` item ids GitHub shows are gone.
 *
 * A kind the token lacks permission for is named in `unreadable` and its stored
 * ids are gone. A repository the token cannot read throws `SourceAccessError`,
 * also when it stops being readable part way through the sync: every 404 after
 * that point may be the lost access, and a listing page answering 404 reads as
 * an empty, finished pass. So the repository is read again at the end, before
 * any of it is reported. Any other failure (rate limit, 5xx) throws
 * `GitHubConnectorError`. Neither must ever be read as "the repository is empty".
 */
export async function listRepositoryItems(
  repoFullName: string,
  token: string,
  {
    cursor = null,
    stored = [],
    now = Date.now(),
  }: {
    cursor?: GitHubSyncCursor | null;
    stored?: readonly string[];
    now?: number;
  } = {},
): Promise<GitHubListing> {
  if (!token) throw new GitHubConnectorError("GitHub token is required.");
  const { owner, name } = parseRepoFullName(repoFullName);
  const base = `/repos/${owner}/${name}`;
  const from = cursor ?? initialCursor();

  const repo = { body: await readRepository(repoFullName, token) };

  const items: GitHubSyncItem[] = [];
  const unreadable: GitHubItemKind[] = [];
  const next: GitHubSyncCursor = { ...from };

  const readme = await get<{ content?: string; encoding?: string }>(`${base}/readme`, token);
  if (readme.status === "forbidden") unreadable.push("readme");
  if (readme.status === 200 && readme.body.content && readme.body.encoding === "base64") {
    items.push(...readmeItems(repo.body.full_name, Buffer.from(readme.body.content, "base64").toString("utf8"), owner));
  }

  // Comments and reviews follow the issue or pull request they are on, so the
  // parents are read first. GitHub serves issue comments to a token with either
  // permission and refuses them only without both, which is the parents'
  // refusal, not one of their own: the comments are then not asked for or named.
  // With one of the two, a comment on the refused kind is left out here even
  // when GitHub lists it, and one whose parent cannot be read from its URL is
  // left out whenever either is refused.
  const refusedParents = (): CommentParent[] => COMMENT_PARENTS.filter((parent) => unreadable.includes(parent));
  const isReadableAgain = () => from.refusedParents.some((parent) => !refusedParents().includes(parent));
  const isReadableParent = (parent: CommentParent | null): boolean =>
    parent === null ? refusedParents().length === 0 : !refusedParents().includes(parent);

  // Pull requests listed this sync, newest first, whose reviews join the queue.
  const listedPulls: number[] = [];
  // Each reader stores its own pass on `next` and returns its rows.
  const readKind: Record<PagedKind, () => Promise<GitHubSyncItem[] | "forbidden">> = {
    issues: async () => {
      // The issues endpoint also returns pull requests; those are read from their own.
      const res = await readChangedPages<RawIssue>(
        from.issues,
        now,
        (since, page, direction) =>
          `${base}/issues?state=all&sort=updated&direction=${direction}&per_page=${PER_PAGE}&page=${page}${since ? `&since=${since}` : ""}`,
        token,
        { keyOf: (issue) => issue.number, isOfKind: (issue) => !issue.pull_request },
      );
      if (res === "forbidden") return res;
      next.issues = res.next;
      return res.rows.map((issue) => issueItem(issue, owner));
    },
    comments: async () => {
      const res = await readChangedPages<RawComment>(
        from.comments,
        now,
        (since, page, direction) =>
          `${base}/issues/comments?sort=updated&direction=${direction}&per_page=${PER_PAGE}&page=${page}${since ? `&since=${since}` : ""}`,
        token,
        { keyOf: (comment) => comment.id },
      );
      if (res === "forbidden") return res;
      next.comments = res.next;
      const kept: GitHubSyncItem[] = [];
      for (const comment of res.rows) {
        const item = commentItem(comment, owner);
        if (item && isReadableParent(commentParent(comment))) kept.push(item);
      }
      return kept;
    },
    pulls: async () => {
      const res = await readPages<RawPull>(
        from.pulls,
        now,
        (page) => `${base}/pulls?state=all&sort=updated&direction=desc&per_page=${PER_PAGE}&page=${page}`,
        token,
        { updatedAt: (pr) => pr.updated_at },
      );
      if (res === "forbidden") return res;
      next.pulls = res.next;
      listedPulls.push(...res.rows.map((pr) => pr.number));
      return res.rows.map((pr) => pullItem(pr, owner));
    },
    commits: async () => {
      // A commit's own date is not when it reached the branch, so the endpoint's
      // `since` decides, and the pass's start bounds it above, so a history read
      // over several syncs pages through one unchanging list.
      const since = from.commits.since ? `&since=${from.commits.since}` : "";
      const res = await readPages<RawCommit>(
        from.commits,
        now,
        (page, startedAt) => `${base}/commits?per_page=${PER_PAGE}&page=${page}&until=${startedAt}${since}`,
        token,
      );
      if (res === "forbidden") return res;
      next.commits = res.next;
      return res.rows.map((c) => commitItem(c, owner));
    },
  };
  for (const kind of ["issues", "pulls", "comments", "commits"] as const) {
    // A parent readable again since the last sync also skips the comments this
    // sync, and only restarts their pass (below). A comment on it written now
    // would be stored under a cursor that may still name it refused, the held one
    // or the one an aborted sync leaves, and the next refusal would not read as
    // new, so nothing would retire it. Comments are written only by a sync whose
    // stored cursor names no parent this sync can read.
    if (kind === "comments" && (refusedParents().length === COMMENT_PARENTS.length || isReadableAgain())) {
      next.comments = {};
      continue;
    }
    const rows = await readKind[kind]();
    if (rows === "forbidden") {
      unreadable.push(kind);
      // Its stored items are retired below, so once the permission is back the
      // whole history is read again.
      next[kind] = {};
      continue;
    }
    items.push(...rows);
  }

  // A pull request already waiting keeps its place; one listed again is not queued twice.
  const queue = [...from.reviewQueue, ...listedPulls.filter((n) => !from.reviewQueue.includes(n))];
  // Reviews follow their pull request: a token refused pull requests reads none,
  // even when no pull request is waiting to be asked about.
  const reviews = unreadable.includes("pulls") ? null : await readReviews(base, queue, owner, token);
  if (reviews === "forbidden") unreadable.push("reviews");
  if (reviews === null || reviews === "forbidden") {
    next.reviewQueue = [];
  } else {
    items.push(...reviews.items);
    next.reviewQueue = reviews.remaining;
  }

  // A parent refused now that was readable at the last sync may have comments
  // stored from then, and a stored id does not say what it is on. So every
  // stored comment this sync did not list retires, and the comments pass
  // restarts, which lists again the ones on a readable parent. A parent readable
  // again restarts the pass too, to read the comments that were left out.
  const refused = refusedParents();
  const newlyRefused = refused.some((parent) => !from.refusedParents.includes(parent));
  const readableAgain = isReadableAgain();
  if (newlyRefused || readableAgain) next.comments = {};
  next.refusedParents = refused;

  const files = await readFiles(base, repo.body.full_name, repo.body.default_branch, from.docs, owner, token);
  if (files === "forbidden") {
    unreadable.push("files");
    next.docs = {};
  } else {
    items.push(...files.items);
    next.docs = files.docs;
  }

  const listed = new Set(items.map((item) => item.id));
  const gone = stored.filter((id) => {
    const kind = kindOfId(id);
    if (kind === null || unreadable.includes(kind)) return true;
    if (kind === "reviews" && refused.includes("pulls")) return true;
    if (kind === "comments" && (refused.length === COMMENT_PARENTS.length || (newlyRefused && !listed.has(id))))
      return true;
    // The README and the tree are read whole, so a part they no longer have is gone.
    if (kind === "readme" || /^tree(-\d+)?$/.test(id)) return !listed.has(id);
    const docPath = docPathOfId(id);
    if (docPath !== null && files !== "forbidden") {
      // A doc read whole this sync has lost any section it no longer lists; a doc
      // the tree no longer holds is gone, unless the tree was cut short.
      if (files.readDocs.has(docPath)) return !listed.has(id);
      return files.docPaths !== null && !files.docPaths.has(docPath);
    }
    return false;
  });
  const known = new Set([...listed, ...gone]);
  const probe = await probeStoredItems(
    base,
    stored.filter((id) => !known.has(id)),
    from.probeOffset,
    token,
  );
  next.probeOffset = probe.nextOffset;
  // A held sync still retires an unreadable kind's items, so it must restart that
  // kind's pass too, or its older history is never read again.
  const held: GitHubSyncCursor = { ...from, probeOffset: probe.nextOffset };
  for (const kind of ["issues", "comments", "pulls", "commits"] as const) {
    if (unreadable.includes(kind)) held[kind] = {};
  }
  if (unreadable.includes("reviews") || refused.includes("pulls")) held.reviewQueue = [];
  // `held` keeps the last sync's refused parents, so a parent refused or readable
  // again in a held sync is a change to the next one too, which retires again
  // what this one may have failed to.
  if (newlyRefused || readableAgain) held.comments = {};
  if (unreadable.includes("files")) held.docs = {};

  // Every 404 above means "gone", or an empty page, only while the repository
  // itself is readable. A token that lost access during this sync answers 404
  // to each of them, which would retire stored items and move the cursor past
  // history nothing read.
  await readRepository(repoFullName, token);
  const named = items.map((item) => ({ ...item, heading: itemHeading(repo.body.full_name, item) }));
  return { items: named, unreadable, gone: [...gone, ...probe.gone], cursor: next, heldCursor: held };
}

/**
 * Who can read a repository at the source. A public repository is readable by
 * anyone, so connecting it widens nothing. For a private or internal one, a
 * read-only token is not shown who the collaborators are (listing them needs
 * push access), so its readers are unknown rather than guessed. Any failure to
 * read the repository is unknown too, never "nobody".
 */
export async function repositoryReaders(repoFullName: string, token: string): Promise<SourceReaders> {
  const unknown: SourceReaders = {
    kind: "unknown",
    reason: "GitHub does not tell a read-only token who can read a private repository",
  };
  try {
    const { owner, name } = parseRepoFullName(repoFullName);
    const repo = await get<{ private?: boolean; visibility?: string }>(`/repos/${owner}/${name}`, token);
    if (repo.status !== 200) return { kind: "unknown", reason: "GitHub did not return this repository's visibility" };
    const isPublic = repo.body.private === false && (repo.body.visibility ?? "public") === "public";
    return isPublic ? { kind: "known", readers: [{ kind: "everyone" }] } : unknown;
  } catch {
    return { kind: "unknown", reason: "GitHub did not return this repository's visibility" };
  }
}
