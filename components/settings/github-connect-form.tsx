"use client";

// The form that connects one GitHub repository as a knowledge source.
//
// A person pastes a token and asks what it can reach. The server reads that from
// GitHub (POST /api/sources/github/repositories; the browser's CSP does not allow
// api.github.com) and answers one page of the repositories the token can read, with
// how far the token reaches: its kind, whether GitHub says it can write, and how many
// repositories it lists. The person picks one from a searchable, paged list, sees
// which parts of it the token cannot read (POST /api/sources/github/reach), and
// connects it with POST /api/sources `{ type: "github", repo, token }`, which the
// panel sends. What that connect answers, a refusal or the question of who may read
// the repository, shows inside the form where Connect was, never only elsewhere on
// the page.
//
// The rule this form keeps: what is on screen always belongs to the token in the
// field. Editing the token clears the list and the pick, and an answer for an
// earlier token, search, page or pick is never shown. The list's search and page
// stay out of the URL: they belong to a token that never goes there, and a token
// pasted into the search box must not land in history. Breadth is warned about,
// never refused. A count GitHub filtered for an organization's SAML single sign-on
// is shown with the line that says so, so it never reads as every repository.

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, Globe, Lock, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui";
import { ConnectorLogo } from "@/components/connector-logo";
import { ListControls, ListNoMatch, ListPagination } from "@/components/list-controls/list-controls";
import { isNarrowed, type ListState } from "@/components/list-controls/list-query";
import { listViewKey } from "@/components/list-controls/list-page";
import { useListState } from "@/components/list-controls/use-list-state";
import { useServerListPage } from "@/components/list-controls/use-list-page";
import { listSearchText } from "@/lib/list-search";
import type {
  GitHubRepositorySummary,
  GitHubTokenBreadth,
  RepositoryPart,
} from "@/services/connectors/github-token-probe";
import { WHAT_WE_STORE } from "./connector-data";
import { ConnectError } from "./widening-confirm";
import { SOURCE_REQUEST_TIMEOUT_MS } from "./source-requests";
import { GITHUB_REPO_LIST, GITHUB_REPO_PAGE_SIZE } from "./github-repo-list";

/** The repository permissions a sync reads with, all read-only. */
const PERMISSIONS = ["Contents", "Issues", "Pull requests", "Metadata"];

const FIELD =
  "min-h-11 w-full rounded-xl border border-[var(--field-border)] bg-[var(--field-background)] px-4 py-2.5 text-sm text-fg hover:border-[var(--field-border-hover)] focus-visible:border-[var(--field-border-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info placeholder:text-[var(--field-placeholder)]";

/** One page of the token's repositories, as POST /api/sources/github/repositories answers it. */
export type RepositoryPage = {
  token: GitHubTokenBreadth;
  reached: number;
  truncated: boolean;
  /** True when GitHub left out the repositories of organizations whose SAML single sign-on has not authorized the token. */
  ssoPartialResults: boolean;
  /** How many organizations GitHub named as withheld; 0 when it named none. */
  ssoWithheldOrganizations: number;
  ssoWithheldOrganizationIds: string[];
  rows: GitHubRepositorySummary[];
  total: number;
  page: number;
  pageSize: number;
};

/**
 * `owner/name` from what a person pastes: the name itself, or the repository's
 * github.com address with or without `.git`. Anything else is returned trimmed.
 */
export function repoFullName(value: string): string {
  const trimmed = value.trim();
  const fromUrl = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s?#]+?)(?:\.git)?\/?(?:[?#].*)?$/i.exec(
    trimmed,
  );
  return fromUrl ? `${fromUrl[1]}/${fromUrl[2]}` : trimmed;
}

const KIND_LABEL: Record<GitHubTokenBreadth["kind"], string> = {
  "fine-grained": "Fine-grained token",
  classic: "Classic token",
  "oauth-app": "OAuth app token",
  "github-app": "GitHub App token",
  unknown: "Token of an unknown kind",
};

/** One line the form says about a token: a warning, or plain information. */
export type BreadthLine = { tone: "warning" | "info"; text: string };

function repositories(n: number): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? "repository" : "repositories"}`;
}

const DAY = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

/** The line under the count when GitHub withheld organizations' repositories for SSO. */
function ssoLine(organizations: number): BreadthLine {
  const who =
    organizations === 0
      ? "At least one organization withheld its"
      : organizations === 1
        ? "1 organization withheld its"
        : `${organizations.toLocaleString("en-US")} organizations withheld their`;
  return { tone: "warning", text: `${who} repositories: authorize this token for SSO at GitHub to include them.` };
}

/** What the form says about a token's breadth, from the listing's own answer. */
export function breadthLines({
  token,
  reached,
  truncated,
  ssoPartialResults,
  ssoWithheldOrganizations,
}: Pick<
  RepositoryPage,
  "token" | "reached" | "truncated" | "ssoPartialResults" | "ssoWithheldOrganizations"
>): BreadthLine[] {
  const reach = truncated ? `more than ${repositories(reached)}` : repositories(reached);
  const lines: BreadthLine[] = [
    {
      tone: "info",
      text: `${KIND_LABEL[token.kind]} · lists ${reach}${token.expiresAt ? ` · expires ${DAY(token.expiresAt)}` : ""}`,
    },
  ];
  // Right under the count, so the count is never read as every repository the token reaches.
  if (ssoPartialResults) lines.push(ssoLine(ssoWithheldOrganizations));

  if (token.canWrite === "yes") {
    lines.push({
      tone: "warning",
      text: `It can change things at GitHub (${token.writeScopes.length === 1 ? "scope" : "scopes"} ${token.writeScopes.join(", ")}). Willder only reads, but stores the token as it is. A fine-grained, read-only token is safer.`,
    });
  } else if (token.canWrite === "no") {
    lines.push({
      tone: "info",
      text:
        token.scopes && token.scopes.length > 0
          ? `Read-only scopes: ${token.scopes.join(", ")}.`
          : "No scopes: it reads public repositories only.",
    });
  } else if (token.kind === "fine-grained") {
    lines.push({
      tone: "info",
      text: "GitHub does not show a fine-grained token's permissions. Willder only reads; check that each permission on the token is Read-only.",
    });
  } else {
    lines.push({
      tone: "warning",
      text: "This is not a personal access token, and GitHub does not show what it may change. A fine-grained personal access token is safer.",
    });
  }

  // Repositories SSO withheld are still the token's: it reaches more than it lists.
  if (reached > 1 || ssoPartialResults) {
    lines.push({
      tone: "warning",
      text: `It lists ${reach}${ssoPartialResults ? ", and more once SSO allows it" : ""}. Willder reads only the one you pick, but stores a token that reaches them all. A token limited to that repository is safer.`,
    });
  }
  if (truncated) {
    lines.push({
      tone: "info",
      text: `The list holds the first ${repositories(reached)} by name. Search owner/name to find any other.`,
    });
  }
  return lines;
}

// What a sync reads behind each probed part: the README probe stands for everything Contents
// covers except commits, so a token refused it also skips the docs and the file tree.
const PART_LABELS: Record<RepositoryPart, string[]> = {
  readme: ["the README", "docs", "the file tree"],
  issues: ["issues with their comments"],
  pulls: ["pull requests with their reviews"],
  commits: ["commits"],
};
const PART_PERMISSION: Record<RepositoryPart, string> = {
  readme: "Contents",
  issues: "Issues",
  pulls: "Pull requests",
  commits: "Contents",
};

function listOf(words: string[]): string {
  if (words.length <= 2) return words.join(" and ");
  return `${words.slice(0, -1).join(", ")}, and ${words[words.length - 1]}`;
}

/** What the form says about the parts of the picked repository the token may not read. */
export function reachLine(fullName: string, unreadable: RepositoryPart[]): BreadthLine {
  if (unreadable.length === 0) {
    return {
      tone: "info",
      text: `It can read the README, docs, the file tree (paths only), issues with their comments, pull requests with their reviews, and commits of ${fullName}.`,
    };
  }
  const permissions = [...new Set(unreadable.map((p) => PART_PERMISSION[p]))];
  return {
    tone: "warning",
    text: `It cannot read ${listOf(unreadable.flatMap((p) => PART_LABELS[p]))} of ${fullName}, so a sync skips them. Give the token read access to ${listOf(permissions)} to include them.`,
  };
}

/** The body the listing route takes for a view and page. The token goes in the body, never in a URL. */
function listingRequest(token: string, view: ListState, page: number) {
  const q = repoFullName(listSearchText(view.query));
  return {
    token,
    ...(q !== "" ? { q } : {}),
    sort: view.sort,
    order: view.direction,
    ...(view.filters.visibility ? { visibility: view.filters.visibility } : {}),
    page,
  };
}

/** A refused answer's message, with when GitHub allows more for a rate limit. */
async function failureOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown; retryAt?: unknown } | null;
  const error = typeof body?.error === "string" ? body.error : `The GitHub lookup failed (HTTP ${res.status}).`;
  if (typeof body?.retryAt !== "string") return error;
  const at = new Date(body.retryAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${error} GitHub allows more after ${at}.`;
}

/** A lookup the form sends. It gives up after SOURCE_REQUEST_TIMEOUT_MS, and the caller then shows its "try again" line. */
function postJson(url: string, body: unknown, signal: AbortSignal): Promise<Response> {
  const bounded = new AbortController();
  const stop = () => bounded.abort();
  signal.addEventListener("abort", stop);
  const timer = setTimeout(stop, SOURCE_REQUEST_TIMEOUT_MS);
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: bounded.signal,
  }).finally(() => {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  });
}

/** Identity changes on each key transition, including a return to an earlier key. */
type RequestKey = { key: string | null };
type Answer<T> = { request: RequestKey; value: T } | { request: RequestKey; error: string };

function Line({ line }: { line: BreadthLine }) {
  const warning = line.tone === "warning";
  const Icon = warning ? TriangleAlert : CheckCircle2;
  return (
    <p className={`flex items-start gap-1.5 text-sm leading-relaxed ${warning ? "text-warning" : "text-fg-muted"}`}>
      <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${warning ? "" : "text-info"}`} aria-hidden="true" />
      <span>{line.text}</span>
    </p>
  );
}

const VISIBILITY_WORD: Record<GitHubRepositorySummary["visibility"], string> = {
  public: "Public",
  private: "Private",
  internal: "Internal",
};

function RepositoryRow({
  repo,
  name,
  checked,
  onPick,
}: {
  repo: GitHubRepositorySummary;
  name: string;
  checked: boolean;
  onPick: () => void;
}) {
  const metaId = useId();
  const slash = repo.fullName.indexOf("/");
  const Icon = repo.visibility === "public" ? Globe : Lock;
  const meta = [
    VISIBILITY_WORD[repo.visibility],
    repo.pushedAt ? `pushed ${DAY(repo.pushedAt)}` : null,
    repo.archived ? "archived" : null,
    repo.fork ? "fork" : null,
    repo.description,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="border-b border-divider last:border-0">
      <label
        className={`flex h-16 cursor-pointer items-center gap-3 px-3 transition-colors hover:bg-fg/[0.03] ${checked ? "bg-info/[0.08]" : ""}`}
      >
        <input
          type="radio"
          name={name}
          value={repo.fullName}
          checked={checked}
          onChange={onPick}
          aria-label={repo.fullName}
          aria-describedby={metaId}
          className="h-4 w-4 shrink-0 accent-[var(--color-info)]"
        />
        <Icon size={15} strokeWidth={1.8} aria-hidden className="shrink-0 text-fg-subtle" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-fg" title={repo.fullName}>
            <span className="text-fg-subtle">{repo.fullName.slice(0, slash + 1)}</span>
            <span className="font-semibold">{repo.fullName.slice(slash + 1)}</span>
          </span>
          <span id={metaId} className="block truncate text-xs text-fg-subtle" title={meta}>
            {meta}
          </span>
        </span>
      </label>
    </li>
  );
}

export function GitHubConnectForm({
  busy,
  onConnect,
  onCancel,
  error = null,
  confirmation = null,
  onEdit,
}: {
  busy: boolean;
  /** Sends the connect; the panel owns the request, its errors and the widening question. */
  onConnect: (body: { type: "github"; repo: string; token: string }) => void;
  onCancel: () => void;
  /** Why the last connect was refused, shown above Connect. */
  error?: string | null;
  /** The question the last connect asked, shown in place of Connect until it is answered. */
  confirmation?: ReactNode;
  /** Called when the token or the pick changes, so an answer about the old ones is dropped. */
  onEdit?: () => void;
}) {
  // Knowledge sources and Connectors can both show this form at once, so its ids are per instance.
  const id = useId();
  const [token, setToken] = useState("");
  /** The token whose repositories are showing; null until the person asks. */
  const [probed, setProbed] = useState<string | null>(null);
  const [picked, setPicked] = useState<GitHubRepositorySummary | null>(null);
  const [listing, setListing] = useState<Answer<RepositoryPage> | null>(null);
  /** The last page that loaded for the probed token: its breadth stays on screen while another page loads. */
  const [lastPage, setLastPage] = useState<{ token: string; attempt: number; page: RepositoryPage } | null>(null);
  const [reach, setReach] = useState<Answer<RepositoryPart[]> | null>(null);
  /** Bumped by "Try again" and "Check again", so a request is sent again. */
  const [attempt, setAttempt] = useState(0);
  /** The one listing request "Check again" sends with `refresh`, so GitHub is read afresh for it and not for the pages after it. */
  const refreshKey = useRef<string | null>(null);
  /** Bumped by "Check again" under a pick whose check was refused. */
  const [reachAttempt, setReachAttempt] = useState(0);

  // When a connect's wait ends or its question closes, the control that had focus (the
  // disabled Connect, the question's buttons) is gone, and focus would fall to the page.
  // It goes back to Connect, the next thing to press. Focus a person moved elsewhere stays.
  const connectButton = useRef<HTMLButtonElement>(null);
  const asking = confirmation !== null;
  const before = useRef({ busy, asking });
  useEffect(() => {
    const ended = (before.current.busy && !busy) || (before.current.asking && !asking);
    before.current = { busy, asking };
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (ended && lost && !asking) connectButton.current?.focus();
  }, [busy, asking]);

  const view = useListState(GITHUB_REPO_LIST, { inUrl: false });
  const server = useServerListPage<GitHubRepositorySummary>({
    prefix: GITHUB_REPO_LIST.paramPrefix ?? "",
    viewKey: JSON.stringify([probed, listViewKey(GITHUB_REPO_LIST, view.committed)]),
    pageSize: GITHUB_REPO_PAGE_SIZE,
    inUrl: false,
  });
  const listingKey =
    probed === null ? null : JSON.stringify([attempt, listingRequest(probed, view.committed, server.page)]);

  const listingRequestKey = useMemo(() => ({ key: listingKey }), [listingKey]);

  useEffect(() => {
    // `refresh` belongs to the one request "Check again" sends. Any other request,
    // or clearing the token, drops it, so coming back to the checked page reads
    // the minute-old listing.
    if (listingKey !== refreshKey.current) refreshKey.current = null;
    if (listingKey === null) return;
    const [requestAttempt, request] = JSON.parse(listingKey) as [number, ReturnType<typeof listingRequest>];
    const controller = new AbortController();
    const body = listingKey === refreshKey.current ? { ...request, refresh: true } : request;
    postJson("/api/sources/github/repositories", body, controller.signal)
      .then(async (res) => {
        const answer: Answer<RepositoryPage> = res.ok
          ? { request: listingRequestKey, value: (await res.json()) as RepositoryPage }
          : { request: listingRequestKey, error: await failureOf(res) };
        // A newer request owns the screen; this answer arrived for one it replaced.
        if (controller.signal.aborted) return;
        if ("error" in answer) return setListing(answer);
        const page = answer.value;
        if (!Array.isArray(page?.rows)) throw new Error("the listing answer holds no rows");
        setListing(answer);
        setLastPage({ token: request.token, attempt: requestAttempt, page });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setListing({ request: listingRequestKey, error: "Could not look the token up. Try again." });
      });
    return () => controller.abort();
  }, [listingKey, listingRequestKey]);

  const reachKey =
    probed !== null && picked !== null
      ? JSON.stringify([reachAttempt, { token: probed, repo: picked.fullName }])
      : null;
  const reachRequestKey = useMemo(() => ({ key: reachKey }), [reachKey]);
  useEffect(() => {
    if (reachKey === null) return;
    const [, request] = JSON.parse(reachKey) as [number, { token: string; repo: string }];
    const controller = new AbortController();
    postJson("/api/sources/github/reach", request, controller.signal)
      .then(async (res) => {
        const error = res.ok ? null : await failureOf(res);
        const body = res.ok ? ((await res.json()) as { unreadable?: RepositoryPart[] }) : null;
        if (controller.signal.aborted) return;
        if (error !== null) return setReach({ request: reachRequestKey, error });
        if (!Array.isArray(body?.unreadable)) throw new Error("the reach answer names no parts");
        setReach({ request: reachRequestKey, value: body.unreadable });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setReach({ request: reachRequestKey, error: "Could not check what the token can read in it." });
      });
    return () => controller.abort();
  }, [reachKey, reachRequestKey]);

  // Request identity changes even when a token, search or pick returns to an earlier key.
  const current = listing !== null && listing.request === listingRequestKey ? listing : null;
  const failed = current !== null && "error" in current ? current.error : null;
  const page = current !== null && "value" in current ? current.value : null;
  const breadth = lastPage !== null && lastPage.token === probed ? lastPage.page : null;
  const currentReach = reach !== null && reach.request === reachRequestKey ? reach : null;

  const trimmed = token.trim();
  // Editing the token clears the pick, so a pick always belongs to the token in the field.
  const ready = picked !== null && !busy;
  const paging = server.paging(page?.rows ?? [], page?.total ?? breadth?.total ?? 0);
  const narrowed = isNarrowed(view.committed);

  // A listing SSO filtered can change once the person authorizes the token at GitHub.
  const offersCheckAgain = trimmed === probed && failed === null && breadth?.ssoPartialResults === true;
  // Pressed again before its answer arrives, it would send a second refresh.
  const canCheckAgain = offersCheckAgain && current !== null;

  /** Asks what the token in the field reaches, or asks again after a refusal or an SSO-filtered listing. */
  function find() {
    if (trimmed === "") return;
    if (trimmed === probed) {
      const next = JSON.stringify([attempt + 1, listingRequest(probed, view.committed, server.page)]);
      // Trying a failed Check again again is still that check: it reads GitHub afresh too.
      if (failed !== null) {
        if (listingKey === refreshKey.current) refreshKey.current = next;
        setAttempt(attempt + 1);
      } else if (canCheckAgain) {
        refreshKey.current = next;
        setAttempt(attempt + 1);
      }
      return;
    }
    setPicked(null);
    setProbed(trimmed);
  }

  return (
    <form
      aria-label="Connect a GitHub repository"
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-divider bg-fg/[0.02] p-3 sm:p-4"
      onSubmit={(e) => {
        e.preventDefault();
        // While a question is open, Enter in a field must not send the connect again unanswered.
        if (ready && confirmation === null) onConnect({ type: "github", repo: picked.fullName, token: trimmed });
      }}
    >
      <p className="flex items-center gap-2 text-eyebrow font-semibold uppercase text-fg-subtle">
        <ConnectorLogo type="github" className="h-4 w-4 text-fg-muted" />
        Connect a GitHub repository
      </p>
      <p className="text-sm text-fg-subtle">
        Paste a <span className="text-fg-muted">fine-grained personal access token</span> with read-only access to{" "}
        {PERMISSIONS.join(", ")}. You see what it can reach before anything is saved; we then store it encrypted and
        never show it again.
      </p>
      <p className="text-sm text-fg-subtle">{WHAT_WE_STORE.github}</p>

      <div className="flex flex-col gap-1.5">
        <label className="text-sm text-fg-muted" htmlFor={`${id}-token`}>
          Token
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id={`${id}-token`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              setProbed(null);
              setPicked(null);
              setListing(null);
              setLastPage(null);
              onEdit?.();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                find();
              }
            }}
            // While a connect is in flight its answer belongs to this token and pick, so neither changes.
            disabled={busy}
            placeholder="github_pat_…"
            className={FIELD}
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="shrink-0 sm:min-h-11"
            disabled={trimmed === "" || (trimmed === probed && failed === null && !canCheckAgain)}
            onClick={find}
          >
            {trimmed === probed && failed !== null
              ? "Try again"
              : offersCheckAgain
                ? "Check again"
                : "Find repositories"}
          </Button>
        </div>
      </div>

      {probed !== null &&
        (failed !== null ? (
          <p role="alert" className="flex items-start gap-1.5 text-sm text-danger">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{failed}</span>
          </p>
        ) : breadth === null ? (
          <p role="status" className="text-sm text-fg-muted">
            Checking what this token can reach…
          </p>
        ) : (
          <>
            <div role="group" aria-label="What this token reaches" className="flex flex-col gap-1">
              {lastPage?.attempt === attempt ? (
                breadthLines(breadth).map((line) => <Line key={line.text} line={line} />)
              ) : (
                <p role="status" className="text-sm text-fg-muted">
                  Checking what this token can reach…
                </p>
              )}
            </div>
            <fieldset disabled={busy} className="flex min-w-0 flex-col gap-2">
              <legend className="mb-2 text-sm text-fg-muted">Repository</legend>
              {/* Enter in the search box searches; it never submits the connect. */}
              <div
                onKeyDown={(e) => {
                  if (e.key === "Enter" && e.target instanceof HTMLInputElement) e.preventDefault();
                }}
              >
                <ListControls
                  config={GITHUB_REPO_LIST}
                  controls={view}
                  total={null}
                  shown={narrowed && page ? page.total : null}
                />
              </div>
              <div className="overflow-hidden rounded-lg border border-divider">
                {page === null ? (
                  <p role="status" className="px-3 py-6 text-center text-sm text-fg-muted">
                    Loading repositories…
                  </p>
                ) : page.rows.length === 0 ? (
                  narrowed ? (
                    <div className="p-3">
                      <ListNoMatch config={GITHUB_REPO_LIST} controls={view} />
                    </div>
                  ) : (
                    <p className="px-3 py-6 text-center text-sm text-fg-muted">
                      {server.page > 1
                        ? "This page is past the end of the list."
                        : page.ssoPartialResults
                          ? "Nothing to pick until the token is authorized for SSO at GitHub. Search owner/name for a public repository."
                          : "This token lists no repositories. Search owner/name for a public one, or give the token access to a repository."}
                    </p>
                  )
                ) : (
                  <ul role="radiogroup" aria-label="Repositories this token can read">
                    {page.rows.map((repo) => (
                      <RepositoryRow
                        key={repo.fullName}
                        repo={repo}
                        name={`${id}-repo`}
                        checked={picked?.fullName === repo.fullName}
                        onPick={() => {
                          setPicked(repo);
                          onEdit?.();
                        }}
                      />
                    ))}
                  </ul>
                )}
              </div>
            </fieldset>
          </>
        ))}

      {breadth && (
        <ListPagination
          noun={GITHUB_REPO_LIST.noun}
          paging={paging}
          loading={current === null}
          unavailable={failed !== null}
          keepVisible
          empty={page?.rows.length === 0}
        />
      )}

      {picked !== null && (
        <div className="flex min-w-0 flex-col gap-1" aria-live="polite">
          <p className="truncate text-sm text-fg" title={picked.fullName}>
            <span className="text-fg-subtle">Picked </span>
            <span className="font-semibold">{picked.fullName}</span>
          </p>
          {currentReach === null ? (
            <p role="status" className="text-sm text-fg-muted">
              Checking what it can read in {picked.fullName}…
            </p>
          ) : "error" in currentReach ? (
            <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
              <Line line={{ tone: "warning", text: currentReach.error }} />
              <button
                type="button"
                onClick={() => setReachAttempt((n) => n + 1)}
                className="text-sm font-semibold text-fg-muted underline-offset-4 hover:text-fg hover:underline"
              >
                Check again
              </button>
            </div>
          ) : (
            <Line line={reachLine(picked.fullName, currentReach.value)} />
          )}
        </div>
      )}

      {error !== null && <ConnectError message={error} />}
      {confirmation ?? (
        <div className="mt-1 flex items-center gap-2">
          <Button ref={connectButton} type="submit" variant="secondary" size="sm" disabled={!ready}>
            {busy ? "Connecting…" : "Connect"}
          </Button>
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-sm text-fg-subtle transition-colors hover:text-fg"
          >
            Cancel
          </button>
        </div>
      )}
    </form>
  );
}
