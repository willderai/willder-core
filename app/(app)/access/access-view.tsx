"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PageHeader, Button, Card, Tabs, Pill, Chip } from "@/components/ui";
import { Reveal } from "@/components/reveal";
import { Disclosure } from "@heroui/react/disclosure";
import { WRITER_SLOT_CHARS, displayWriterLabel, tokenShortId } from "@/components/audit/format";
import { WriterLabel } from "@/components/audit/writer-label";
import { SearchField } from "@/components/access-search/search-field";
import { listSearchText, MAX_LIST_SEARCH_LENGTH } from "@/lib/list-search";
import { MAX_AUDIT_PAGE } from "@/lib/page-limits";
import { auditPageSummary, countOf, tabMatchCount } from "@/components/access-search/count-copy";
import { matchesQuery } from "@/components/access-search/match";
import { ScopeSelect } from "@/components/access/scope-select";
import { SearchPicker, type PickOption } from "@/components/search-picker/search-picker";
import { searchAgents, searchMembers } from "@/components/search-picker/pick-sources";
import { ListControls, ListNoMatch, ListPagination, SortHeader } from "@/components/list-controls/list-controls";
import {
  compareText,
  compareTime,
  isNarrowed,
  showsListControls,
  type ListConfig,
  type ListState,
} from "@/components/list-controls/list-query";
import { listViewKey } from "@/components/list-controls/list-page";
import { useListState, withPageQuery, type ListStateControls } from "@/components/list-controls/use-list-state";
import {
  accessListParams,
  GRANT_LIST_SPEC,
  MAX_ACCESS_PAGE,
  TOKEN_LIST_SPEC,
  type AccessListQuery,
} from "@/lib/access-lists";
import type { GrantRow, TokenRow } from "@/services/access/access-list-pages";
import { serverListPage, useUrlPage } from "@/components/list-controls/use-url-page";
import { clearListPages, useUrlParam } from "@/components/memory/store-list-tab";
import { useServerPage } from "@/components/list-controls/use-server-page";
import { ServerListPagination } from "@/components/list-controls/server-list-pagination";

// ── types ─────────────────────────────────────────────────────────────────────

type Scope = { id: string; path: string; name: string; createdAt: string };

type Grant = GrantRow;

// Token form sentinel: the token is for a client that is not an Agent row.
const OTHER_CLIENT = "__other_client__";
const OTHER_CLIENT_TOGGLE = "self-start text-sm text-fg-subtle underline underline-offset-2 hover:text-fg";

// The shape GET /api/audit returns: actors arrive as display names, never ids.
type AuditEntry = {
  id: string;
  actorType: string;
  actorName: string;
  action: string;
  target: string;
  decision: "allow" | "deny";
  reason: string | null;
  capabilityId?: string;
  at: string;
};

// One page of GET /api/audit: the rows, how many match in all, and the allowed and
// denied counts across every page (the decision filter aside).
type AuditPage = {
  entries: AuditEntry[];
  total: number;
  counts: { allowed: number; denied: number };
  page: number;
  pageSize: number;
  totalPages: number;
};

// ── helpers ───────────────────────────────────────────────────────────────────

function fmt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "Organization / Sales": the names of a scope's ancestors, root first. */
function scopeAncestry(scope: Scope, all: Scope[]): string {
  const parts = scope.path.split(".");
  return (
    parts
      .slice(0, -1)
      .map((_, i) => all.find((s) => s.path === parts.slice(0, i + 1).join("."))?.name ?? parts[i])
      .join(" / ") || "Top level"
  );
}

/**
 * The one status word the Tokens table's filter matches, in the order the sidebar
 * search reports it (services/search/access-search.ts). A token of a deactivated
 * agent is refused on every call, so it is never "active".
 */
function tokenStatus(c: TokenRow): "revoked" | "expired" | "deactivated" | "active" {
  if (c.revokedAt) return "revoked";
  if (new Date(c.expiresAt) < new Date()) return "expired";
  return c.agentDeactivated ? "deactivated" : "active";
}

/** Ascending by expiry with "never expires" last, so "soonest first" leads with what lapses next. */
function compareExpiry(a: string | null, b: string | null): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return compareTime(a, b);
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Where a grant stands on expiry, the values of the Grants filter. */
function grantExpiry(g: Grant): "permanent" | "expired" | "soon" | "later" {
  if (g.expiresAt === null) return "permanent";
  const left = new Date(g.expiresAt).getTime() - Date.now();
  if (left <= 0) return "expired";
  return left <= WEEK_MS ? "soon" : "later";
}

const PERMISSION_OPTIONS = [
  { value: "read", label: "Read" },
  { value: "write", label: "Write" },
  { value: "admin", label: "Admin" },
];

const NEWEST_FIRST = { asc: "Oldest first", desc: "Newest first" } as const;
const A_TO_Z = { asc: "A–Z", desc: "Z–A" } as const;
const SOONEST_FIRST = { asc: "Soonest first", desc: "Latest first" } as const;

/**
 * How the Grants tab sorts and filters; its view lives under `grants.` in the URL.
 * The search is the page's own box (`q`), so sidebar search links keep working.
 * The server does the work (lib/access-lists.ts names what it accepts); these
 * entries mirror what it matches, so the toolbar and the URL describe the request.
 */
const GRANT_LIST: ListConfig<Grant> = {
  noun: { one: "grant", many: "grants" },
  searchText: (g) => [g.scope.name, g.scope.path, g.granteeName, g.granteeId, g.granteeType, g.permission],
  sorts: [
    {
      key: "created",
      label: "Created",
      compare: (a, b) => compareTime(a.createdAt, b.createdAt),
      defaultDirection: "desc",
      directionLabels: NEWEST_FIRST,
    },
    {
      key: "scope",
      label: "Scope",
      compare: (a, b) => compareText(a.scope.path, b.scope.path),
      directionLabels: A_TO_Z,
    },
    {
      key: "grantee",
      label: "Grantee",
      compare: (a, b) => compareText(a.granteeName ?? a.granteeId, b.granteeName ?? b.granteeId),
      directionLabels: A_TO_Z,
    },
    {
      key: "expires",
      label: "Expires",
      compare: (a, b) => compareExpiry(a.expiresAt, b.expiresAt),
      directionLabels: SOONEST_FIRST,
    },
  ],
  filters: [
    { key: "permission", label: "Permission", options: PERMISSION_OPTIONS, matches: (g, v) => g.permission === v },
    {
      key: "grantee",
      label: "Grantee type",
      options: [
        { value: "user", label: "User" },
        { value: "role", label: "Role" },
        { value: "agent", label: "Agent" },
        { value: "everyone", label: "Everyone" },
      ],
      matches: (g, v) => g.granteeType === v,
    },
    {
      key: "expiry",
      label: "Expiry",
      options: [
        { value: "soon", label: "Within 7 days" },
        { value: "expired", label: "Expired" },
        { value: "permanent", label: "Never" },
      ],
      matches: (g, v) => grantExpiry(g) === v,
    },
  ],
  paramPrefix: "grants.",
};

/** How the Tokens tab sorts and filters; its view lives under `tokens.` in the URL. */
const TOKEN_LIST: ListConfig<TokenRow> = {
  noun: { one: "token", many: "tokens" },
  searchText: (c) => [c.agentId, c.id, c.scopePath, c.scopeName, c.permission, tokenStatus(c)],
  sorts: [
    {
      key: "created",
      label: "Created",
      compare: (a, b) => compareTime(a.createdAt, b.createdAt),
      defaultDirection: "desc",
      directionLabels: NEWEST_FIRST,
    },
    { key: "agent", label: "Agent", compare: (a, b) => compareText(a.agentId, b.agentId), directionLabels: A_TO_Z },
    {
      key: "expires",
      label: "Expires",
      compare: (a, b) => compareTime(a.expiresAt, b.expiresAt),
      directionLabels: SOONEST_FIRST,
    },
  ],
  filters: [
    {
      key: "status",
      label: "Status",
      options: [
        { value: "active", label: "Active" },
        { value: "expired", label: "Expired" },
        { value: "revoked", label: "Revoked" },
        { value: "deactivated", label: "Agent deactivated" },
      ],
      matches: (c, v) => tokenStatus(c) === v,
    },
    { key: "permission", label: "Permission", options: PERMISSION_OPTIONS, matches: (c, v) => c.permission === v },
  ],
  paramPrefix: "tokens.",
};

function permissionPill(p: string) {
  if (p === "admin") return <Pill dot="brick">admin</Pill>;
  if (p === "write") return <Pill dot="ember">write</Pill>;
  return <Pill dot="marble">read</Pill>;
}

/** The tabs whose page is kept in the URL (`grants.page`). */
const PAGED_TABS = ["grants", "tokens", "audit"];

const TABS = [
  { key: "grants", label: "Grants" },
  { key: "scopes", label: "Scopes" },
  { key: "tokens", label: "Tokens" },
  { key: "audit", label: "Audit log" },
];

const TH = "px-4 py-3 text-eyebrow font-semibold uppercase text-fg-subtle";
const TD = "px-4 py-3 text-sm text-fg align-middle";

/** The request for one page of a server list, from the view its toolbar holds. */
function accessListUrl(
  path: string,
  spec: typeof GRANT_LIST_SPEC | typeof TOKEN_LIST_SPEC,
  state: ListState,
  page: number,
): string {
  const query = {
    search: listSearchText(state.query),
    sort: state.sort,
    order: state.direction,
    filters: state.filters,
    page,
  } as AccessListQuery<typeof spec>;
  return `${path}?${accessListParams(query)}`;
}

/** The server list a tab shows, its view and its page, read through `useServerPage`. */
function useServerList<R>(
  path: string,
  rowsKey: string,
  spec: typeof GRANT_LIST_SPEC | typeof TOKEN_LIST_SPEC,
  config: ListConfig<R>,
  view: ListStateControls,
  revision: number,
) {
  const committed = view.committed;
  return useServerPage<R>({
    prefix: config.paramPrefix ?? "",
    maxPage: MAX_ACCESS_PAGE,
    rowsKey,
    viewKey: `${listSearchText(committed.query)}|${listViewKey(config, { ...committed, query: "" })}`,
    urlFor: (page) => accessListUrl(path, spec, committed, page),
    searching: listSearchText(committed.query) !== "",
    revision,
  });
}

/** Every scope, for the scope field on the Access forms; null when the read fails. */
async function readScopes(signal: AbortSignal): Promise<Scope[] | null> {
  const res = await fetch("/api/access/scopes", { signal }).catch(() => null);
  if (!res?.ok) return null;
  const data = (await res.json().catch(() => null)) as { scopes?: Scope[] } | null;
  return data ? (data.scopes ?? []) : null;
}

// ── Grants tab ────────────────────────────────────────────────────────────────

/** The page's search box, shared by every tab: its text and the way to change it. */
type PageSearch = { query: string; onQueryChange: (query: string) => void };

function GrantsTab({ query, onQueryChange }: PageSearch) {
  const view = withPageQuery(useListState(GRANT_LIST), query, onQueryChange);
  const [revision, setRevision] = useState(0);
  const list = useServerList<Grant>("/api/access/grants", "grants", GRANT_LIST_SPEC, GRANT_LIST, view, revision);
  const [scopes, setScopes] = useState<Scope[]>([]);
  // The member or agent picked for the grant, label included; `form.granteeId` is its value.
  const [grantee, setGrantee] = useState<PickOption | null>(null);
  const [form, setForm] = useState({
    scopeId: "",
    granteeType: "user",
    granteeId: "",
    permission: "read",
    permanent: true,
    ttlValue: "7",
    ttlUnit: "days" as "hours" | "days" | "weeks",
  });
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);

  // The scopes the new-grant form picks from. Members and agents are searched on the
  // server as the person types; the grants themselves come a page at a time.
  useEffect(() => {
    const controller = new AbortController();
    void readScopes(controller.signal).then((rows) => rows && setScopes(rows));
    return () => controller.abort();
  }, []);

  function pickGrantee(option: PickOption) {
    setGrantee(option);
    setForm((f) => ({ ...f, granteeId: option.value }));
  }

  const reload = () => setRevision((r) => r + 1);

  async function createGrant(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!form.scopeId) {
      setErr("Choose a scope for the grant.");
      return;
    }
    if (form.granteeType !== "everyone" && !form.granteeId) {
      setErr(`Choose the ${form.granteeType} to grant.`);
      return;
    }
    setCreating(true);
    setErr(null);
    try {
      const unitMultiplier = form.ttlUnit === "hours" ? 1 : form.ttlUnit === "days" ? 24 : 168;
      const body: Record<string, unknown> = {
        scopeId: form.scopeId,
        granteeType: form.granteeType,
        granteeId: form.granteeType === "everyone" ? undefined : form.granteeId,
        permission: form.permission,
        ...(form.permanent ? {} : { ttlHours: Number(form.ttlValue) * unitMultiplier }),
      };
      const res = await fetch("/api/access/grants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "failed");
      setShowForm(false);
      setForm({
        scopeId: "",
        granteeType: "user",
        granteeId: "",
        permission: "read",
        permanent: true,
        ttlValue: "1",
        ttlUnit: "days",
      });
      setGrantee(null);
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "error");
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    await fetch(`/api/access/grants/${id}`, { method: "DELETE" });
    setConfirmRevokeId(null);
    reload();
  }

  if (list.state.status === "forbidden") return <Forbidden />;
  const data = list.state.status === "ready" ? list.state.data : null;
  // While a new page loads, the last one stays on screen, dimmed, and claims no count;
  // a last page with no rows shows "Loading…", not its no-match message or an empty table.
  const stale = list.state.status === "loading" ? list.state.previous : null;
  const shownPage = data ?? stale;
  const shownGrants = shownPage?.rows ?? [];
  const orgCount = shownPage?.count ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-fg-subtle">{data ? countOf(data.count, "grant", "grants") : "\u00a0"}</p>
        <Button variant="primary" size="sm" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Cancel" : "+ New grant"}
        </Button>
      </div>

      {showForm && (
        <Card glow="ember" className="p-6">
          <form onSubmit={createGrant} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Scope">
                <ScopeSelect
                  label="Scope"
                  scopes={scopes}
                  value={scopes.find((s) => s.id === form.scopeId)?.path ?? ""}
                  onChange={(path) =>
                    setForm((f) => ({ ...f, scopeId: scopes.find((s) => s.path === path)?.id ?? "" }))
                  }
                />
              </Field>
              <Field label="Permission">
                <select
                  value={form.permission}
                  onChange={(e) => setForm((f) => ({ ...f, permission: e.target.value }))}
                  className={selectCls}
                >
                  <option value="read">read</option>
                  <option value="write">write</option>
                  <option value="admin">admin (ends 2 hours after issue)</option>
                </select>
              </Field>
              <Field label="Grantee type">
                <select
                  value={form.granteeType}
                  onChange={(e) => {
                    setGrantee(null);
                    setForm((f) => ({ ...f, granteeType: e.target.value, granteeId: "" }));
                  }}
                  className={selectCls}
                >
                  <option value="user">user</option>
                  <option value="role">role</option>
                  <option value="agent">agent</option>
                  <option value="everyone">everyone (scope baseline)</option>
                </select>
              </Field>
              {form.granteeType === "user" && (
                <Field label="Member">
                  <SearchPicker
                    label="Member"
                    placeholder="Choose a member"
                    searchPlaceholder="Search by name or email"
                    selected={grantee}
                    onChange={pickGrantee}
                    search={searchMembers}
                  />
                </Field>
              )}
              {form.granteeType === "role" && (
                <Field label="Role">
                  <select
                    value={form.granteeId}
                    onChange={(e) => setForm((f) => ({ ...f, granteeId: e.target.value }))}
                    required
                    className={selectCls}
                  >
                    <option value="">— select role —</option>
                    <option value="admin">admin</option>
                    <option value="member">member</option>
                  </select>
                </Field>
              )}
              {form.granteeType === "agent" && (
                <Field label="Agent">
                  <SearchPicker
                    label="Agent"
                    placeholder="Choose an agent"
                    searchPlaceholder="Search by name or key"
                    selected={grantee}
                    onChange={pickGrantee}
                    search={searchAgents}
                  />
                </Field>
              )}
              <Field label="Duration">
                <div className="flex flex-col gap-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.permanent}
                      onChange={(e) => setForm((f) => ({ ...f, permanent: e.target.checked }))}
                      className="h-4 w-4 rounded accent-gold"
                    />
                    <span className="text-sm text-fg-muted">Permanent (no expiry)</span>
                  </label>
                  {!form.permanent && (
                    <div className="flex gap-2">
                      <input
                        type="number"
                        value={form.ttlValue}
                        onChange={(e) => setForm((f) => ({ ...f, ttlValue: e.target.value }))}
                        min={1}
                        className={inputCls + " flex-1"}
                      />
                      <select
                        value={form.ttlUnit}
                        onChange={(e) =>
                          setForm((f) => ({ ...f, ttlUnit: e.target.value as "hours" | "days" | "weeks" }))
                        }
                        className={selectCls + " w-28"}
                      >
                        <option value="hours">hours</option>
                        <option value="days">days</option>
                        <option value="weeks">weeks</option>
                      </select>
                    </div>
                  )}
                </div>
              </Field>
            </div>
            {err && <Chip tone="brick">{err}</Chip>}
            <div className="flex justify-end gap-2">
              <Button type="submit" variant="primary" size="sm" disabled={creating}>
                {creating ? "Creating…" : "Create grant"}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {data?.count === 0 && !isNarrowed(view.committed) ? (
        <Empty>No grants yet. Create one above.</Empty>
      ) : (
        <>
          {showsListControls(orgCount, view.state) && (
            <ListControls
              config={GRANT_LIST}
              controls={view}
              total={orgCount}
              shown={data?.total ?? null}
              search={false}
            />
          )}
          {list.state.status === "loading" && !stale?.rows.length ? (
            <Loading />
          ) : list.state.status === "failed" ? (
            <LoadFailed noun="grants" onRetry={reload} />
          ) : shownGrants.length === 0 && stale === null ? (
            list.page > 1 ? (
              <PastLastPage onFirstPage={() => list.setPage(1)} />
            ) : (
              <ListNoMatch config={GRANT_LIST} controls={view} />
            )
          ) : (
            <Card glow="gold" className={`overflow-hidden transition-opacity ${stale ? "opacity-60" : ""}`}>
              <div
                className="max-w-full overflow-x-auto overscroll-x-contain"
                role="region"
                aria-label="Access grants"
                aria-busy={stale !== null}
                tabIndex={0}
              >
                <table className="w-full min-w-[36rem]">
                  <thead>
                    <tr className="border-b border-divider">
                      <SortHeader config={GRANT_LIST} controls={view} sortKey="scope" className={TH + " text-left"} />
                      <SortHeader config={GRANT_LIST} controls={view} sortKey="grantee" className={TH + " text-left"} />
                      <th scope="col" className={TH + " text-left"}>
                        Permission
                      </th>
                      <SortHeader config={GRANT_LIST} controls={view} sortKey="expires" className={TH + " text-left"} />
                      <th className={TH} />
                    </tr>
                  </thead>
                  <tbody>
                    {shownGrants.map((g) => (
                      <tr key={g.id} className="border-b border-divider last:border-0 hover:bg-fg/[0.02]">
                        <td className={TD}>
                          <span className="font-medium text-fg">{g.scope.name}</span>
                        </td>
                        <td className={TD}>
                          <div className="flex flex-col gap-0.5">
                            <div className="flex items-center gap-1.5">
                              <Pill dot="marble">{g.granteeType}</Pill>
                              {g.granteeName && (
                                <span className="text-sm font-medium text-fg">{displayWriterLabel(g.granteeName)}</span>
                              )}
                            </div>
                            <span className="font-mono text-xs text-fg-subtle truncate max-w-[220px]">
                              {g.granteeType === "everyone" ? "all members" : g.granteeId}
                            </span>
                          </div>
                        </td>
                        <td className={TD}>{permissionPill(g.permission)}</td>
                        <td className={TD}>
                          {g.expiresAt ? (
                            <span className={new Date(g.expiresAt) < new Date() ? "text-danger" : ""}>
                              {fmt(g.expiresAt)}
                            </span>
                          ) : (
                            <span className="text-fg-subtle">permanent</span>
                          )}
                        </td>
                        <td className={TD + " text-right"}>
                          {confirmRevokeId === g.id ? (
                            <span className="flex items-center justify-end gap-2">
                              <span className="text-sm text-fg-muted">Sure?</span>
                              <button
                                aria-disabled={stale !== null}
                                onClick={() => {
                                  if (!stale) void revoke(g.id);
                                }}
                                className="text-sm font-semibold capitalize text-danger underline-offset-4 hover:underline"
                              >
                                yes
                              </button>
                              <button
                                onClick={() => setConfirmRevokeId(null)}
                                className="text-sm font-semibold capitalize text-fg-muted hover:text-fg transition-colors"
                              >
                                no
                              </button>
                            </span>
                          ) : (
                            <button
                              aria-disabled={stale !== null}
                              onClick={() => {
                                if (!stale) setConfirmRevokeId(g.id);
                              }}
                              className="text-sm font-semibold capitalize text-fg-muted hover:text-danger transition-colors"
                            >
                              revoke
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
          <ServerListPagination noun={GRANT_LIST.noun} list={list} />
        </>
      )}
    </div>
  );
}

// ── Scopes tab ────────────────────────────────────────────────────────────────

function ScopesTab({ query }: { query: string }) {
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [form, setForm] = useState({ name: "", parentPath: "" });
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [parentName, setParentName] = useState<string | null>(null);

  // Create a child in-context: prefill the parent, open the form, focus the name.
  // Avoids hunting for the parent in a flat dropdown that doesn't scale.
  function addSubScope(parentPath: string, parentDisplay: string) {
    setForm({ name: "", parentPath });
    setParentName(parentDisplay);
    setShowForm(true);
    setErr(null);
    requestAnimationFrame(() => nameRef.current?.focus());
  }
  function renderScope(s: Scope, depth: number): React.ReactNode {
    const children = scopes.filter((p) => {
      const pParts = p.path.split(".");
      const sParts = s.path.split(".");
      return pParts.length === sParts.length + 1 && p.path.startsWith(s.path + ".");
    });
    const hasChildren = children.length > 0;
    const indent = 20 + depth * 28;

    if (!hasChildren) {
      return (
        <div
          key={s.path}
          className="group flex items-center justify-between py-4 border-b border-divider last:border-0"
          style={{ paddingLeft: `${indent}px`, paddingRight: "20px" }}
        >
          <div className="flex items-center gap-3">
            {depth > 0 && <div className="w-4 h-px bg-fg/15 shrink-0" />}
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <span className="font-medium text-fg">{s.name}</span>
                {depth === 0 && <Chip tone="gold">root</Chip>}
                {depth > 0 && <span className="text-sm text-fg-subtle">also covered by grants on parent</span>}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => addSubScope(s.path, s.name)}
              className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-sm text-fg-subtle hover:text-gold transition-opacity"
            >
              + sub-scope
            </button>
            <span className="font-mono text-xs text-fg-subtle">{fmt(s.createdAt)}</span>
          </div>
        </div>
      );
    }

    return (
      <Disclosure key={s.path} className="border-b border-divider last:border-0">
        <Disclosure.Heading>
          <Disclosure.Trigger
            className="group w-full flex items-center justify-between py-4 hover:bg-fg/[0.02] transition-colors outline-none cursor-pointer"
            style={{ paddingLeft: `${indent}px`, paddingRight: "20px" }}
          >
            <div className="flex items-center gap-3">
              {depth > 0 && <div className="w-4 h-px bg-fg/15 shrink-0" />}
              <div className="flex flex-col gap-0.5 text-left">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-fg">{s.name}</span>
                  {depth === 0 && <Chip tone="gold">root</Chip>}
                  {depth > 0 && <span className="text-sm text-fg-subtle">also covered by grants on parent</span>}
                </div>
                <span className="text-sm text-fg-subtle">
                  Grants here apply to all {children.length} nested scope{children.length !== 1 ? "s" : ""} below
                </span>
              </div>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <span className="font-mono text-xs text-fg-subtle">{fmt(s.createdAt)}</span>
              <Disclosure.Indicator className="text-fg-subtle group-data-[expanded]:text-gold transition-colors" />
            </div>
          </Disclosure.Trigger>
        </Disclosure.Heading>
        <Disclosure.Content>
          <Disclosure.Body className="border-l border-divider" style={{ marginLeft: `${indent + 12}px` }}>
            <button
              type="button"
              onClick={() => addSubScope(s.path, s.name)}
              className="flex w-full items-center gap-2 py-3 text-sm text-fg-subtle hover:text-gold transition-colors"
              style={{ paddingLeft: "20px" }}
            >
              + Add sub-scope under {s.name}
            </button>
            {children.map((c) => renderScope(c, depth + 1))}
          </Disclosure.Body>
        </Disclosure.Content>
      </Disclosure>
    );
  }

  const load = useCallback(async () => {
    const res = await fetch("/api/access/scopes");
    if (res.status === 403) {
      setForbidden(true);
      setLoading(false);
      return;
    }
    if (res.ok) {
      const d = await res.json();
      setScopes(d.scopes ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function createScope(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setCreating(true);
    setErr(null);
    try {
      const res = await fetch("/api/access/scopes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: form.name, parentPath: form.parentPath || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "failed");
      setShowForm(false);
      setForm({ name: "", parentPath: "" });
      setParentName(null);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "error");
    } finally {
      setCreating(false);
    }
  }

  const shownScopes = scopes.filter((sc) => matchesQuery(query, [sc.name, sc.path]));

  if (forbidden) return <Forbidden />;
  if (loading) return <Loading />;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-fg-subtle">
          {scopes.length} scope{scopes.length !== 1 ? "s" : ""}
        </p>
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            const next = !showForm;
            setShowForm(next);
            if (next) {
              setForm({ name: "", parentPath: "" });
              setParentName(null);
              setErr(null);
            }
          }}
        >
          {showForm ? "Cancel" : "+ New scope"}
        </Button>
      </div>

      {showForm && (
        <Card glow="ember" className="p-6">
          <form onSubmit={createScope} className="flex flex-col gap-4">
            {parentName ? (
              <p className="text-sm text-fg-subtle">
                New sub-scope under <span className="text-gold">{parentName}</span>
              </p>
            ) : (
              <p className="text-sm text-fg-subtle">New top-level scope (under org root)</p>
            )}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Scope name">
                <input
                  ref={nameRef}
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  required
                  placeholder="e.g. Sales Team"
                  className={inputCls}
                />
              </Field>
              <Field label="Parent scope (blank = org root)">
                <ScopeSelect
                  label="Parent scope"
                  scopes={scopes}
                  emptyLabel="Org root"
                  value={form.parentPath}
                  onChange={(path) => setForm((f) => ({ ...f, parentPath: path }))}
                />
              </Field>
            </div>
            {err && <Chip tone="brick">{err}</Chip>}
            <div className="flex justify-end">
              <Button type="submit" variant="primary" size="sm" disabled={creating}>
                {creating ? "Creating…" : "Create scope"}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {scopes.length === 0 ? (
        <Empty>No custom scopes yet. The org root scope is created automatically.</Empty>
      ) : query.trim() !== "" ? (
        // A filtered tree would hide a match under a collapsed parent, so a
        // search shows matches flat, each with the path of names above it.
        shownScopes.length === 0 ? (
          <Empty>No scopes match &ldquo;{query}&rdquo;.</Empty>
        ) : (
          <div className="flex flex-col gap-2">
            <MatchCount shown={shownScopes.length} total={scopes.length} noun="scope" query={query} />
            <Card glow="gold" className="divide-y divide-divider overflow-hidden">
              {shownScopes.map((s) => (
                <div key={s.path} className="group flex items-center justify-between gap-3 px-5 py-4">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-medium text-fg">{s.name}</span>
                    <span className="truncate text-sm text-fg-subtle">{scopeAncestry(s, scopes)}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <button
                      type="button"
                      onClick={() => addSubScope(s.path, s.name)}
                      className="text-sm text-fg-subtle hover:text-gold transition-colors"
                    >
                      + sub-scope
                    </button>
                    <span className="font-mono text-xs text-fg-subtle">{fmt(s.createdAt)}</span>
                  </div>
                </div>
              ))}
            </Card>
          </div>
        )
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-fg-subtle px-1">
            Grants on a scope automatically cover all nested scopes beneath it. Expand to see sub-scopes.
          </p>
          <Card glow="gold" className="divide-y divide-divider overflow-hidden">
            {scopes.filter((s) => s.path.split(".").length === 1).map((s) => renderScope(s, 0))}
          </Card>
        </div>
      )}
    </div>
  );
}

// ── Tokens tab ────────────────────────────────────────────────────────────────

function TokensTab({ query, onQueryChange }: PageSearch) {
  const view = withPageQuery(useListState(TOKEN_LIST), query, onQueryChange);
  const [revision, setRevision] = useState(0);
  const list = useServerList<TokenRow>(
    "/api/access/capabilities",
    "capabilities",
    TOKEN_LIST_SPEC,
    TOKEN_LIST,
    view,
    revision,
  );
  const [scopes, setScopes] = useState<Scope[]>([]);
  // The agent picked for the token, label included; `form.agentId` is its key.
  const [agent, setAgent] = useState<PickOption | null>(null);
  // `agentId` holds the picked agent's key, or OTHER_CLIENT while the person
  // types a client that is not an agent in this org into `otherClient`.
  const [form, setForm] = useState({
    agentId: "",
    otherClient: "",
    scopePath: "",
    permission: "read",
    ttlHours: "168",
  });
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [confirmRevokeCapId, setConfirmRevokeCapId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // The scopes the issue form picks from. Agents are searched on the server as the
  // person types; the tokens themselves come a page at a time.
  useEffect(() => {
    const controller = new AbortController();
    void readScopes(controller.signal).then((rows) => rows && setScopes(rows));
    return () => controller.abort();
  }, []);

  const reload = () => setRevision((r) => r + 1);

  // The revoke call must surface both failure modes instead of silently
  // resetting: a DELETE rejected by the server (403/404) with the issuance
  // form collapsed has nowhere else to render its error, and a network-level
  // rejection is an unhandled promise that never reaches `setErr`. The
  // confirm state clears only on success, so a failed revoke leaves the
  // yes/no prompt up rather than resetting to the plain "revoke" button as if
  // nothing had been attempted -- an admin must never be able to conclude a
  // token is gone (via the "revoked" badge) when it is still live.
  async function revokeCap(id: string) {
    setErr(null);
    try {
      const res = await fetch(`/api/access/capabilities/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setErr(d.error ?? "could not revoke that token");
        return;
      }
      setConfirmRevokeCapId(null);
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not revoke that token");
    }
  }

  async function issue(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!form.agentId) {
      setErr("Choose the agent the token is for.");
      return;
    }
    setCreating(true);
    setErr(null);
    try {
      const res = await fetch("/api/access/capabilities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: form.agentId === OTHER_CLIENT ? form.otherClient : form.agentId,
          scopePath: form.scopePath || undefined,
          permission: form.permission,
          ttlHours: form.ttlHours ? Number(form.ttlHours) : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "failed");
      setIssuedToken(data.token);
      setShowForm(false);
      setForm({ agentId: "", otherClient: "", scopePath: "", permission: "read", ttlHours: "168" });
      setAgent(null);
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "error");
    } finally {
      setCreating(false);
    }
  }

  function copy() {
    if (!issuedToken) return;
    navigator.clipboard.writeText(issuedToken).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  if (list.state.status === "forbidden") return <Forbidden />;
  const data = list.state.status === "ready" ? list.state.data : null;
  // While a new page loads, the last one stays on screen, dimmed, and claims no count;
  // a last page with no rows shows "Loading…", not its no-match message or an empty table.
  const stale = list.state.status === "loading" ? list.state.previous : null;
  const shownPage = data ?? stale;
  const shownCaps = shownPage?.rows ?? [];
  const orgCount = shownPage?.count ?? 0;

  return (
    <div className="flex flex-col gap-6">
      {/* One-time token reveal */}
      {issuedToken && (
        <Card glow="gold" className="p-6">
          <p className="mb-1 text-eyebrow font-semibold uppercase text-gold">Token issued — copy now, shown once</p>
          <div className="mt-3 flex items-center gap-3 rounded-xl border border-divider bg-black/20 px-4 py-3">
            <code className="flex-1 break-all font-mono text-sm text-fg">{issuedToken}</code>
            <button
              onClick={copy}
              className="min-h-10 shrink-0 rounded-full border border-divider px-4 py-1.5 text-sm font-semibold text-fg-muted hover:border-accent/35 hover:text-fg transition-colors"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <button
            onClick={() => setIssuedToken(null)}
            className="mt-3 text-sm font-semibold text-fg-muted hover:text-fg"
          >
            Dismiss
          </button>
        </Card>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-fg-subtle">{data ? countOf(data.count, "token", "tokens") : "\u00a0"}</p>
        <Button variant="primary" size="sm" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Cancel" : "+ Issue token"}
        </Button>
      </div>

      {/* Shared between issuance and revoke: revoke controls live in the table
          below, which is visible whether or not the issuance form is open, so
          this banner cannot live inside `{showForm && (...)}` without going
          silent on a collapsed form. */}
      {err && <Chip tone="brick">{err}</Chip>}

      {showForm && (
        <Card glow="ember" className="p-6">
          <form onSubmit={issue} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {/* The same search, keyed the same way, as the grant form's agent
                  picker, so a token and a grant for one agent always name it alike
                  and revoking the grant reaches the token. */}
              <Field label="Agent">
                {form.agentId === OTHER_CLIENT ? (
                  <button
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, agentId: agent?.value ?? "" }))}
                    className={OTHER_CLIENT_TOGGLE}
                  >
                    Pick an agent in this org instead
                  </button>
                ) : (
                  <>
                    <SearchPicker
                      label="Agent"
                      placeholder="Choose an agent"
                      searchPlaceholder="Search by name or key"
                      selected={agent}
                      onChange={(option) => {
                        setAgent(option);
                        setForm((f) => ({ ...f, agentId: option.value }));
                      }}
                      search={searchAgents}
                    />
                    <button
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, agentId: OTHER_CLIENT }))}
                      className={OTHER_CLIENT_TOGGLE}
                    >
                      Other client (not an agent here)
                    </button>
                  </>
                )}
              </Field>
              {form.agentId === OTHER_CLIENT && (
                <Field label="Client ID">
                  <input
                    value={form.otherClient}
                    onChange={(e) => setForm((f) => ({ ...f, otherClient: e.target.value }))}
                    required
                    placeholder="e.g. mcp-client"
                    className={inputCls}
                  />
                </Field>
              )}
              <Field label="Scope (blank = org root)">
                <ScopeSelect
                  label="Scope"
                  scopes={scopes}
                  emptyLabel="Org root"
                  value={form.scopePath}
                  onChange={(path) => setForm((f) => ({ ...f, scopePath: path }))}
                />
              </Field>
              <Field label="Permission">
                <select
                  value={form.permission}
                  onChange={(e) => setForm((f) => ({ ...f, permission: e.target.value }))}
                  className={selectCls}
                >
                  <option value="read">read</option>
                  <option value="write">write</option>
                  <option value="admin">admin (ends 2 hours after issue)</option>
                </select>
              </Field>
              <Field label="TTL hours (default 168 = 7 days)">
                <input
                  type="number"
                  value={form.ttlHours}
                  onChange={(e) => setForm((f) => ({ ...f, ttlHours: e.target.value }))}
                  min={1}
                  className={inputCls}
                />
              </Field>
            </div>
            <div className="flex justify-end">
              <Button type="submit" variant="primary" size="sm" disabled={creating}>
                {creating ? "Issuing…" : "Issue token"}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {data?.count === 0 && !isNarrowed(view.committed) ? (
        <Empty>No capability tokens yet. Issue one above to grant an agent scoped access.</Empty>
      ) : (
        <>
          {showsListControls(orgCount, view.state) && (
            <ListControls
              config={TOKEN_LIST}
              controls={view}
              total={orgCount}
              shown={data?.total ?? null}
              search={false}
            />
          )}
          {list.state.status === "loading" && !stale?.rows.length ? (
            <Loading />
          ) : list.state.status === "failed" ? (
            <LoadFailed noun="tokens" onRetry={reload} />
          ) : shownCaps.length === 0 && stale === null ? (
            list.page > 1 ? (
              <PastLastPage onFirstPage={() => list.setPage(1)} />
            ) : (
              <ListNoMatch config={TOKEN_LIST} controls={view} />
            )
          ) : (
            <Card glow="gold" className={`overflow-hidden transition-opacity ${stale ? "opacity-60" : ""}`}>
              <div
                className="max-w-full overflow-x-auto overscroll-x-contain"
                role="region"
                aria-label="Agent tokens"
                aria-busy={stale !== null}
                tabIndex={0}
              >
                <table className="w-full min-w-[48rem]">
                  <thead>
                    <tr className="border-b border-divider">
                      <SortHeader config={TOKEN_LIST} controls={view} sortKey="agent" className={TH + " text-left"} />
                      <th scope="col" className={TH + " text-left"}>
                        Token ID
                      </th>
                      <th scope="col" className={TH + " text-left"}>
                        Scope
                      </th>
                      <th scope="col" className={TH + " text-left"}>
                        Permission
                      </th>
                      <SortHeader config={TOKEN_LIST} controls={view} sortKey="created" className={TH + " text-left"} />
                      <SortHeader config={TOKEN_LIST} controls={view} sortKey="expires" className={TH + " text-left"} />
                      <th scope="col" className={TH + " text-left"}>
                        Status
                      </th>
                      <th className={TH + " text-right"}>
                        <span className="sr-only">Revoke</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownCaps.map((c) => {
                      const expired = new Date(c.expiresAt) < new Date();
                      const status = tokenStatus(c);
                      return (
                        <tr key={c.id} className="border-b border-divider last:border-0 hover:bg-fg/[0.02]">
                          <td className={TD}>
                            <span className="font-mono text-xs text-fg">{c.agentId}</span>
                          </td>
                          <td className={TD}>
                            <span title={c.id} className="font-mono text-xs text-fg-subtle">
                              {tokenShortId(c.id)}
                            </span>
                          </td>
                          <td className={TD}>
                            {c.scopeName ? (
                              <span title={c.scopePath} className="text-sm text-fg-muted">
                                {c.scopeName}
                              </span>
                            ) : (
                              <span className="text-sm text-fg-subtle">Org root</span>
                            )}
                          </td>
                          <td className={TD}>{permissionPill(c.permission)}</td>
                          <td className={TD}>{fmt(c.createdAt)}</td>
                          <td className={TD + (expired ? " text-fg-subtle" : "")}>{fmt(c.expiresAt)}</td>
                          <td className={TD}>
                            {status === "revoked" ? (
                              <Pill dot="brick">revoked</Pill>
                            ) : status === "expired" ? (
                              <Pill dot="marble">expired</Pill>
                            ) : status === "deactivated" ? (
                              <Pill dot="ember">agent deactivated</Pill>
                            ) : (
                              <Pill dot="gold">active</Pill>
                            )}
                          </td>
                          <td className={TD + " text-right"}>
                            {/* Already-revoked and already-expired tokens have nothing left
                            to revoke; offering the action would imply otherwise. */}
                            {c.revokedAt || expired ? null : confirmRevokeCapId === c.id ? (
                              <span className="flex items-center justify-end gap-2">
                                <span className="text-sm text-fg-muted">Sure?</span>
                                <button
                                  aria-disabled={stale !== null}
                                  onClick={() => {
                                    if (!stale) void revokeCap(c.id);
                                  }}
                                  className="text-sm font-semibold capitalize text-danger underline-offset-4 hover:underline"
                                >
                                  yes
                                </button>
                                <button
                                  onClick={() => setConfirmRevokeCapId(null)}
                                  className="text-sm font-semibold capitalize text-fg-muted hover:text-fg transition-colors"
                                >
                                  no
                                </button>
                              </span>
                            ) : (
                              <button
                                aria-disabled={stale !== null}
                                onClick={() => {
                                  if (!stale) setConfirmRevokeCapId(c.id);
                                }}
                                className="text-sm font-semibold capitalize text-fg-muted hover:text-danger transition-colors"
                              >
                                revoke
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
          <ServerListPagination noun={TOKEN_LIST.noun} list={list} />
        </>
      )}
    </div>
  );
}

// ── Audit tab ─────────────────────────────────────────────────────────────────

/**
 * The audit trail, newest first, a page at a time. The page's search box and the
 * decision buttons narrow it on the server (GET /api/audit `q` and `decision`), so
 * a search covers the whole log, not just one page, and the counts it shows are
 * exact. The route leaves out rows the log hides before it pages or counts.
 */
function AuditTab({ query }: { query: string }) {
  const [forbidden, setForbidden] = useState(false);
  const [filterParam, setFilterParam] = useUrlParam("audit.decision", "replace");
  const filter = filterParam === "allow" || filterParam === "deny" ? filterParam : "all";
  // What the route accepts: a link's longer or NUL-bearing text is trimmed, never refused.
  const searchText = listSearchText(query);
  // The page is in the URL; a new search or decision starts again at page 1.
  const viewKey = `${filter}|${searchText}`;
  const [page, setPage] = useUrlPage("audit.page", viewKey, MAX_AUDIT_PAGE);
  // The page on screen and the request it answers; while that is not the
  // current request the table shows its loading skeleton.
  const [loaded, setLoaded] = useState<{ key: string; data: AuditPage | null } | null>(null);

  const requestKey = `${viewKey}|${page}`;
  const loading = loaded?.key !== requestKey;
  const data = loaded?.data ?? null;
  const entries = data?.entries ?? [];

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page) });
    if (filter !== "all") params.set("decision", filter);
    if (searchText !== "") params.set("q", searchText);
    const controller = new AbortController();
    // Debounced while typing; the abort drops a slower answer to an older request.
    const timer = setTimeout(
      async () => {
        try {
          const res = await fetch(`/api/audit?${params}`, { signal: controller.signal });
          if (res.status === 403) {
            setForbidden(true);
            return;
          }
          const body = res.ok ? ((await res.json()) as AuditPage) : null;
          if (controller.signal.aborted) return;
          setLoaded({ key: requestKey, data: body?.counts ? body : null });
        } catch {
          if (!controller.signal.aborted) setLoaded({ key: requestKey, data: null });
        }
      },
      searchText !== "" ? 250 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [filter, searchText, page, requestKey]);

  if (forbidden) return <Forbidden />;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        {(["all", "allow", "deny"] as const).map((f) => (
          <button
            type="button"
            key={f}
            aria-pressed={filter === f}
            onClick={() => setFilterParam(f === "all" ? null : f)}
            className={`min-h-10 rounded-full border px-4 py-1.5 text-sm font-semibold capitalize transition-colors ${
              filter === f
                ? "border-accent/40 bg-accent/10 text-fg dark:text-accent"
                : "border-divider text-fg-subtle hover:border-accent/35 hover:text-fg"
            }`}
          >
            {f}
          </button>
        ))}
        <span aria-live="polite" className="w-full text-sm text-fg-subtle sm:ml-auto sm:w-auto">
          {loading
            ? "Loading…"
            : !data
              ? ""
              : auditPageSummary({
                  first: (data.page - 1) * data.pageSize + 1,
                  shown: entries.length,
                  total: data.total,
                  ...data.counts,
                  searching: searchText !== "",
                })}
        </span>
      </div>

      {!loading && !data ? (
        <p role="alert" className="rounded-2xl border border-danger/30 py-16 text-center text-sm text-danger">
          Could not load the audit log. Reload the page to try again.
        </p>
      ) : !loading && entries.length === 0 && page > 1 ? (
        <Empty>
          No audit rows on this page.{" "}
          <button type="button" onClick={() => setPage(1)} className="underline underline-offset-4">
            Back to the first page
          </button>
        </Empty>
      ) : !loading && entries.length === 0 ? (
        <Empty>
          {searchText !== "" ? <>No audit rows match &ldquo;{searchText}&rdquo;</> : "No audit entries"}
          {filter !== "all" ? ` for filter "${filter}"` : ""}.
        </Empty>
      ) : (
        <Card glow="gold" className="overflow-hidden">
          <div
            className="max-w-full overflow-x-auto overscroll-x-contain"
            role="region"
            aria-label="Access audit"
            tabIndex={0}
          >
            <table className="w-full min-w-[36rem]">
              <thead>
                <tr className="border-b border-divider">
                  <th className={TH + " text-left"}>Time</th>
                  <th className={TH + " text-left"}>Actor</th>
                  <th className={TH + " text-left"}>Action</th>
                  <th className={TH + " text-left"}>Target</th>
                  <th className={TH + " text-left"}>Decision</th>
                </tr>
              </thead>
              <tbody>
                {loading
                  ? Array.from({ length: 5 }).map((_, i) => (
                      <tr key={i} className="border-b border-divider">
                        {Array.from({ length: 5 }).map((_, j) => (
                          <td key={j} className={TD}>
                            <div className="h-3 w-24 animate-pulse rounded bg-fg/[0.05]" />
                          </td>
                        ))}
                      </tr>
                    ))
                  : entries.map((e) => (
                      <tr key={e.id} className="border-b border-divider last:border-0 hover:bg-fg/[0.02]">
                        <td className={TD + " whitespace-nowrap text-fg-subtle"}>{fmt(e.at)}</td>
                        <td className={TD}>
                          <div className="flex flex-col gap-0.5">
                            <Pill dot="marble">{e.actorType}</Pill>
                            <WriterLabel
                              label={e.actorName}
                              maxChars={WRITER_SLOT_CHARS.accessAuditColumn}
                              className="font-mono text-xs text-fg-subtle"
                            />
                            {e.capabilityId && (
                              <span title={e.capabilityId} className="font-mono text-xs text-fg-subtle">
                                token {tokenShortId(e.capabilityId)}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className={TD}>
                          <span className="font-mono text-xs text-fg-muted">{e.action}</span>
                        </td>
                        <td className={TD}>
                          <span className="font-mono text-xs text-fg-subtle max-w-[160px] truncate block">
                            {e.target}
                          </span>
                        </td>
                        <td className={TD}>
                          {e.decision === "allow" ? <Pill dot="gold">allow</Pill> : <Pill dot="brick">deny</Pill>}
                          {e.reason && (
                            <p className="mt-0.5 font-mono text-xs text-fg-subtle max-w-[200px] truncate">{e.reason}</p>
                          )}
                        </td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
          {data && entries.length > 0 && (
            <ListPagination
              className="border-t border-divider px-4 py-3"
              noun={{ one: "audit row", many: "audit rows" }}
              paging={serverListPage({ ...data, rows: entries, page: loading ? page : data.page }, setPage)}
              loading={loading}
            />
          )}
        </Card>
      )}
    </div>
  );
}

// ── Shared micro-components ───────────────────────────────────────────────────

const inputCls =
  "min-h-11 min-w-0 w-full rounded-xl border border-[var(--field-border)] bg-[var(--field-background)] px-4 py-2.5 text-sm text-fg hover:border-[var(--field-border-hover)] focus-visible:border-[var(--field-border-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info placeholder:text-[var(--field-placeholder)]";
const selectCls =
  "min-h-11 min-w-0 w-full rounded-xl border border-[var(--field-border)] bg-[var(--field-background)] px-4 py-2.5 text-sm text-fg hover:border-[var(--field-border-hover)] focus-visible:border-[var(--field-border-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-medium text-fg-muted">{label}</label>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-divider bg-fg/[0.02] py-16 text-center text-sm text-fg-subtle">
      {children}
    </div>
  );
}

/** A server page that did not load, with a way to ask again. */
function LoadFailed({ noun, onRetry }: { noun: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 py-16 text-center text-sm text-fg-muted">
      <p>Could not load the {noun}.</p>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

/** A page past the last one, from an old link or a list that shrank. */
function PastLastPage({ onFirstPage }: { onFirstPage: () => void }) {
  return (
    <Empty>
      Nothing on this page.{" "}
      <button type="button" className="underline" onClick={onFirstPage}>
        Back to the first page
      </button>
    </Empty>
  );
}

function Loading() {
  return <div className="py-16 text-center text-sm text-fg-subtle">Loading…</div>;
}

function Forbidden() {
  return (
    <div className="rounded-2xl border border-brick/20 bg-brick/[0.06] py-16 text-center text-sm text-fg-subtle">
      Admin access required to view this section.
    </div>
  );
}

/** "3 of 12 grants match" while a filter is on; nothing otherwise. `noun` is singular. */
function MatchCount({ shown, total, noun, query }: { shown: number; total: number; noun: string; query: string }) {
  if (query.trim() === "") return null;
  return <p className="px-1 text-sm text-fg-subtle">{tabMatchCount(shown, total, noun, query)}</p>;
}

// ── Page ──────────────────────────────────────────────────────────────────────

const TAB_KEYS = new Set(TABS.map((t) => t.key));

const SEARCH_LABELS: Record<string, string> = {
  grants: "Search grants by scope, grantee or permission",
  scopes: "Search scopes by name or path",
  tokens: "Search tokens by agent, token ID, scope or status",
  audit: "Search audit rows by actor, action, target, reason or token ID",
};

const SEARCH_PLACEHOLDERS: Record<string, string> = {
  grants: "Search grants",
  scopes: "Search scopes",
  tokens: "Search tokens",
  audit: "Search audit log",
};

/**
 * The Access page. `canManage` is the server's answer to whether this person may
 * manage access; without it no tab mounts, so no tab requests a list it would be
 * refused. The tab and the filter arrive in the URL (?tab=tokens&q=efhqcfh3), so
 * the sidebar search can link straight to a filtered tab.
 */
export function AccessView({ canManage }: { canManage: boolean }) {
  return (
    <Suspense fallback={<Loading />}>
      <AccessPageContent canManage={canManage} />
    </Suspense>
  );
}

function AccessPageContent({ canManage }: { canManage: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  const tabParam = params.get("tab") ?? "";
  const urlTab = TAB_KEYS.has(tabParam) ? tabParam : "grants";
  const urlQuery = params.get("q") ?? "";
  // Tab and filter are local state seeded from the URL. Typing never rewrites
  // the URL (doing so per keystroke races the input); a sidebar link that
  // changes the URL while this page is open replaces both.
  const [tab, setTab] = useState(urlTab);
  const [query, setQuery] = useState(urlQuery);
  const [adoptedUrl, setAdoptedUrl] = useState(`${urlTab}|${urlQuery}`);
  if (`${urlTab}|${urlQuery}` !== adoptedUrl) {
    setAdoptedUrl(`${urlTab}|${urlQuery}`);
    setTab(urlTab);
    setQuery(urlQuery);
  }

  /** Switching tabs keeps the filter and records both, so reload and back keep the view. */
  function selectTab(nextTab: string) {
    setTab(nextTab);
    // Each tab's sort and filters (grants.*, tokens.*) survive the switch.
    const next = new URLSearchParams(params.toString());
    if (nextTab !== "grants") next.set("tab", nextTab);
    else next.delete("tab");
    if (query !== "") next.set("q", query);
    else next.delete("q");
    // Every paged tab's page belongs to the search it was paged under; a new search starts
    // each at page 1. They leave the address bar now: the tab mounts before the router
    // catches up.
    if (query !== urlQuery) {
      clearListPages(PAGED_TABS);
      for (const list of PAGED_TABS) next.delete(`${list}.page`);
    }
    const qs = next.toString();
    router.replace(`/access${qs ? `?${qs}` : ""}`, { scroll: false });
  }

  return (
    <div className="mx-auto max-w-6xl px-5 py-8 sm:px-8 sm:py-12">
      <Reveal>
        <PageHeader eyebrow="Access" title="The permission layer">
          Scopes, grants, agent tokens, and a full audit trail, made visible.
        </PageHeader>
      </Reveal>

      {canManage ? (
        <>
          <Reveal delay={0.08}>
            <div className="mt-6 flex flex-col gap-4 sm:mt-8 sm:flex-row sm:items-center sm:justify-between">
              <Tabs items={TABS} value={tab} onChange={selectTab} />
              <SearchField
                value={query}
                onChange={setQuery}
                label={SEARCH_LABELS[tab]}
                placeholder={SEARCH_PLACEHOLDERS[tab]}
                maxLength={MAX_LIST_SEARCH_LENGTH}
                className="sm:w-72"
              />
            </div>
          </Reveal>

          <Reveal delay={0.14}>
            <div className="mt-6 sm:mt-8">
              {tab === "grants" && <GrantsTab query={query} onQueryChange={setQuery} />}
              {tab === "scopes" && <ScopesTab query={query} />}
              {tab === "tokens" && <TokensTab query={query} onQueryChange={setQuery} />}
              {tab === "audit" && <AuditTab query={query} />}
            </div>
          </Reveal>
        </>
      ) : (
        <Reveal delay={0.08}>
          <p className="mt-6 rounded-2xl border border-divider bg-fg/[0.02] px-6 py-16 text-center text-sm text-fg-subtle">
            Only an admin of this organization can see its grants, scopes, tokens and audit log. Ask one to grant you
            admin if you need them.
          </p>
        </Reveal>
      )}
    </div>
  );
}
