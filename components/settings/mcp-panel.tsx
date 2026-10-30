"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Card, Button, Chip, Pill } from "@/components/ui";
import { ListControls, ListNoMatch, ListPagination, SortHeader } from "@/components/list-controls/list-controls";
import { listViewKey } from "@/components/list-controls/list-page";
import { useListPage } from "@/components/list-controls/use-list-page";
import {
  applyListState,
  compareText,
  compareTime,
  showsListControls,
  type ListConfig,
} from "@/components/list-controls/list-query";
import { useListState } from "@/components/list-controls/use-list-state";
import { AdminWindowCard } from "./admin-window";

// ── types ─────────────────────────────────────────────────────────────────────

type Capability = {
  id: string;
  agentId: string;
  scopePath: string;
  permission: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
};

// ── constants ─────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "memory_query",
    description: "Ask a question, get back known facts about people, companies, and deals",
    permission: "read",
  },
  { name: "memory_entity", description: "Fetch a single entity and all its known facts by id", permission: "read" },
  { name: "memory_ingest", description: "Write a new fact or note to business memory", permission: "write" },
];

const TTL_OPTIONS = [
  { label: "7 days", hours: 168 },
  { label: "30 days", hours: 720 },
  { label: "90 days", hours: 2160 },
];

// ── helpers ───────────────────────────────────────────────────────────────────

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function isExpired(iso: string) {
  return new Date(iso) < new Date();
}

function permissionPill(p: string) {
  if (p === "admin") return <Pill dot="brick">admin</Pill>;
  if (canWrite(p)) return <Pill dot="ember">read + write</Pill>;
  return <Pill dot="marble">read only</Pill>;
}

/** Whether a token can write, the line the access filter draws: "admin" includes write. */
function canWrite(permission: string): boolean {
  return permission === "write" || permission === "admin";
}

/** How the connected agents table searches, filters and orders; its view lives under `connections.` in the URL. */
const CONNECTION_LIST: ListConfig<Capability> = {
  noun: { one: "connected agent", many: "connected agents" },
  searchText: (c) => [c.agentId, c.scopePath, c.id],
  sorts: [
    {
      key: "created",
      label: "Issued",
      compare: (a, b) => compareTime(a.createdAt, b.createdAt),
      defaultDirection: "desc",
      directionLabels: { asc: "Oldest first", desc: "Newest first" },
    },
    {
      key: "name",
      label: "Name",
      compare: (a, b) => compareText(a.agentId, b.agentId),
      directionLabels: { asc: "A–Z", desc: "Z–A" },
    },
    {
      key: "scope",
      label: "Scope",
      compare: (a, b) => compareText(a.scopePath, b.scopePath),
      directionLabels: { asc: "A–Z", desc: "Z–A" },
    },
    {
      key: "expires",
      label: "Expires",
      compare: (a, b) => compareTime(a.expiresAt, b.expiresAt),
      directionLabels: { asc: "Soonest first", desc: "Latest first" },
    },
  ],
  filters: [
    {
      key: "access",
      label: "Access",
      options: [
        { value: "read", label: "Read only" },
        { value: "write", label: "Read + write" },
      ],
      matches: (c, access) => (access === "write") === canWrite(c.permission),
    },
  ],
  paramPrefix: "connections.",
};

/** When a token stopped working: its revocation, or else its expiry. */
function endedAt(c: Capability): string {
  return c.revokedAt ?? c.expiresAt;
}

/** How the expired-or-revoked list searches, filters and orders; its view lives under `disconnected.` in the URL. */
const INACTIVE_LIST: ListConfig<Capability> = {
  noun: { one: "disconnected agent", many: "disconnected agents" },
  searchText: (c) => [c.agentId, c.scopePath, c.id],
  sorts: [
    {
      key: "ended",
      label: "Ended",
      compare: (a, b) => compareTime(endedAt(a), endedAt(b)),
      defaultDirection: "desc",
      directionLabels: { asc: "Oldest first", desc: "Newest first" },
    },
    {
      key: "name",
      label: "Name",
      compare: (a, b) => compareText(a.agentId, b.agentId),
      directionLabels: { asc: "A–Z", desc: "Z–A" },
    },
  ],
  filters: [
    {
      key: "status",
      label: "Status",
      options: [
        { value: "revoked", label: "Revoked" },
        { value: "expired", label: "Expired" },
      ],
      matches: (c, status) => (status === "revoked") === Boolean(c.revokedAt),
    },
  ],
  paramPrefix: "disconnected.",
};

const TH = "px-4 py-3 text-left text-eyebrow font-semibold uppercase text-fg-subtle";

const inputCls =
  "min-h-11 min-w-0 w-full rounded-xl border border-[var(--field-border)] bg-[var(--field-background)] px-4 py-2.5 text-sm text-fg hover:border-[var(--field-border-hover)] focus-visible:border-[var(--field-border-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info placeholder:text-[var(--field-placeholder)]";
const selectCls =
  "min-h-11 min-w-0 w-full rounded-xl border border-[var(--field-border)] bg-[var(--field-background)] px-4 py-2.5 text-sm text-fg hover:border-[var(--field-border-hover)] focus-visible:border-[var(--field-border-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info";

// ── Config snippet ────────────────────────────────────────────────────────────

// Hosted URL — same endpoint external customers hit, no source/DB access
// needed. Keep in sync with app/api/mcp/route.ts's deployed path.
const HOSTED_MCP_URL = "https://willder.ai/api/mcp";

type SnippetTab = "hosted" | "custom" | "desktop" | "code";

// The local stdio server, launched from any working directory: --prefix points npm at
// the checkout (whose .env and tsconfig the server needs), and --silent keeps npm's
// script banner off stdout, which is the MCP protocol channel.
const LOCAL_STDIO_ARGS = ["--prefix", "/PATH/TO/willder", "run", "--silent", "mcp"];

function ConfigSnippet({ token }: { token: string }) {
  // Hosted is the recommended default — it's what an external customer should
  // reach for; the two local stdio options stay for dev/testing against local
  // data (mcp/README.md documents both, hosted first).
  const [open, setOpen] = useState<SnippetTab | null>("hosted");
  const [copied, setCopied] = useState<SnippetTab | null>(null);

  const hostedJson = JSON.stringify(
    {
      mcpServers: {
        willder: {
          type: "http",
          url: HOSTED_MCP_URL,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  );

  const desktopJson = JSON.stringify(
    {
      mcpServers: {
        willder: {
          command: "npm",
          args: LOCAL_STDIO_ARGS,
          env: { WILLDER_CAPABILITY_TOKEN: token },
        },
      },
    },
    null,
    2,
  );

  const codeJson = JSON.stringify(
    {
      mcpServers: {
        willder: {
          command: "npm",
          args: LOCAL_STDIO_ARGS,
          env: { WILLDER_CAPABILITY_TOKEN: token },
        },
      },
    },
    null,
    2,
  );

  // Not every MCP client reads mcpServers config JSON (OpenAI's Agents SDK,
  // LangChain, or a hand-rolled agent typically just point an HTTP client at
  // a URL + header) — this is the same request any of them send, over the
  // same hosted Streamable HTTP endpoint the "Hosted" tab above configures.
  // A one-shot `tools/list` works fine here without a prior `initialize`
  // handshake (app/api/mcp/route.snippet.test.ts drives the real route
  // handler with this exact body and confirms it) — app/api/mcp/route.ts
  // running stateless (sessionIdGenerator undefined, a fresh transport per
  // request) is why no handshake is NEEDED, not evidence one is required.
  // `tools/list` over `initialize` is the UX call: the response is the
  // product itself, willder's real tool set, rather than a bare handshake
  // acknowledgment — a stronger first thing for a prospective customer to
  // see when they paste this in.
  const customCurl = [
    `curl -s ${HOSTED_MCP_URL} \\`,
    `  -X POST \\`,
    `  -H "content-type: application/json" \\`,
    `  -H "Accept: application/json, text/event-stream" \\`,
    `  -H "Authorization: Bearer ${token}" \\`,
    `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'`,
  ].join("\n");

  function copy(which: SnippetTab, text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(which);
      setTimeout(() => setCopied(null), 2000);
    });
  }

  const tabs: { id: SnippetTab; label: string }[] = [
    { id: "hosted", label: "Hosted (recommended)" },
    { id: "custom", label: "OpenAI / custom agent" },
    { id: "desktop", label: "Claude Desktop (local dev)" },
    { id: "code", label: "Claude Code (local dev)" },
  ];

  return (
    <div className="mt-4 flex flex-col gap-2">
      <p className="text-eyebrow font-semibold uppercase text-fg-subtle">Paste into your AI client config</p>
      <div className="flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button
            type="button"
            key={t.id}
            aria-expanded={open === t.id}
            onClick={() => setOpen(open === t.id ? null : t.id)}
            className={`min-h-10 rounded-full border px-4 py-1.5 text-sm font-semibold transition-colors ${
              open === t.id
                ? "border-accent/40 bg-accent/10 text-fg dark:text-accent"
                : "border-divider text-fg-subtle hover:border-accent/35 hover:text-fg"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {open === "hosted" && (
        <div className="relative rounded-xl border border-divider bg-black/25">
          <pre className="overflow-x-auto p-4 text-xs leading-relaxed text-fg-muted">{hostedJson}</pre>
          <p className="border-t border-divider px-4 py-2 font-mono text-[0.65rem] text-fg-subtle">
            No source code or database access needed — this is the URL any customer&apos;s AI client (Claude Desktop,
            Claude Code, OpenAI&apos;s Agents SDK, or a custom agent) connects to directly. If your client doesn&apos;t
            yet support the <span className="font-mono text-fg-muted">type: &quot;http&quot;</span> shape, check its
            docs for the equivalent remote/streamable-HTTP MCP config. It holds your token, so keep it out of version
            control.
          </p>
          <button
            onClick={() => copy("hosted", hostedJson)}
            className="absolute right-3 top-3 rounded-lg border border-divider px-3 py-1 text-sm font-semibold capitalize text-fg-muted hover:border-gold/30 hover:text-gold transition-colors"
          >
            {copied === "hosted" ? "Copied!" : "Copy"}
          </button>
        </div>
      )}

      {open === "custom" && (
        <div className="relative rounded-xl border border-divider bg-black/25">
          <pre className="overflow-x-auto p-4 text-xs leading-relaxed text-fg-muted">{customCurl}</pre>
          <p className="border-t border-divider px-4 py-2 font-mono text-[0.65rem] text-fg-subtle">
            No Claude-specific config needed — this is the same hosted MCP endpoint above, called directly over HTTP.
            This lists willder&apos;s real tools in one call, so it doubles as proof the endpoint is reachable and the
            token is recognized. Point OpenAI&apos;s Agents SDK, LangChain, or any other MCP-speaking client library at{" "}
            <span className="font-mono text-fg-muted">{HOSTED_MCP_URL}</span> with this bearer header and it handles the
            rest of the protocol (tool calls, results) for you.
          </p>
          <button
            onClick={() => copy("custom", customCurl)}
            className="absolute right-3 top-3 rounded-lg border border-divider px-3 py-1 text-sm font-semibold capitalize text-fg-muted hover:border-gold/30 hover:text-gold transition-colors"
          >
            {copied === "custom" ? "Copied!" : "Copy"}
          </button>
        </div>
      )}

      {open === "desktop" && (
        <div className="relative rounded-xl border border-divider bg-black/25">
          <pre className="overflow-x-auto p-4 text-xs leading-relaxed text-fg-muted">{desktopJson}</pre>
          <p className="border-t border-divider px-4 py-2 font-mono text-[0.65rem] text-fg-subtle">
            Dev-only: runs against your local checkout and <span className="font-mono text-fg-muted">.env</span>{" "}
            database. Replace <span className="font-mono text-fg-muted">/PATH/TO/willder</span> with the absolute path
            to this project. Add to <span className="font-mono text-fg-muted">claude_desktop_config.json</span>.
          </p>
          <button
            onClick={() => copy("desktop", desktopJson)}
            className="absolute right-3 top-3 rounded-lg border border-divider px-3 py-1 text-sm font-semibold capitalize text-fg-muted hover:border-gold/30 hover:text-gold transition-colors"
          >
            {copied === "desktop" ? "Copied!" : "Copy"}
          </button>
        </div>
      )}

      {open === "code" && (
        <div className="relative rounded-xl border border-divider bg-black/25">
          <pre className="overflow-x-auto p-4 text-xs leading-relaxed text-fg-muted">{codeJson}</pre>
          <p className="border-t border-divider px-4 py-2 font-mono text-[0.65rem] text-fg-subtle">
            Dev-only: runs against your local checkout and <span className="font-mono text-fg-muted">.env</span>{" "}
            database. Replace <span className="font-mono text-fg-muted">/PATH/TO/willder</span> with the absolute path
            to this project. Save as <span className="font-mono text-fg-muted">.mcp.json</span> in your project root;
            Claude Code asks once to approve it. It holds your token, so keep it out of version control.
          </p>
          <button
            onClick={() => copy("code", codeJson)}
            className="absolute right-3 top-3 rounded-lg border border-divider px-3 py-1 text-sm font-semibold capitalize text-fg-muted hover:border-gold/30 hover:text-gold transition-colors"
          >
            {copied === "code" ? "Copied!" : "Copy"}
          </button>
        </div>
      )}
    </div>
  );
}

// ── McpPanel ──────────────────────────────────────────────────────────────────

export function McpPanel() {
  const [caps, setCaps] = useState<Capability[]>([]);
  const connectionView = useListState(CONNECTION_LIST);
  const inactiveView = useListState(INACTIVE_LIST);
  const [loading, setLoading] = useState(true);

  // issue form
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("mcp-claude");
  const [permission, setPermission] = useState<"read" | "write" | "admin">("read");
  const [ttlHours, setTtlHours] = useState(720);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // one-time reveal
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/access/capabilities");
    if (res.ok) {
      const d = await res.json();
      setCaps(d.capabilities ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  // Disconnecting has to actually cut the connection off, or a token pasted
  // into the wrong place stays live for its full TTL (720h by default here).
  //
  // The fetch must run inside try/catch, and `setConfirmRevokeId(null)` must
  // not run unconditionally before checking the response — otherwise a
  // network rejection is an unhandled promise and a rejected DELETE silently
  // resets the confirm prompt. The confirm state only clears on success (same
  // rule as app/(app)/access/access-view.tsx's TokensTab).
  async function revokeCap(id: string) {
    setErr(null);
    try {
      const res = await fetch(`/api/access/capabilities/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setErr(d.error ?? "could not disconnect that token");
        return;
      }
      setConfirmRevokeId(null);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not disconnect that token");
    }
  }

  async function issue(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setErr(null);
    try {
      const res = await fetch("/api/access/capabilities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Admin has one fixed window, held by the server: two hours from issue.
        body: JSON.stringify({ agentId: name.trim(), permission, ...(permission === "admin" ? {} : { ttlHours }) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "failed");
      setIssuedToken(data.token);
      setShowForm(false);
      setName("mcp-claude");
      setPermission("read");
      setTtlHours(720);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "error");
    } finally {
      setCreating(false);
    }
  }

  function copyToken() {
    if (!issuedToken) return;
    navigator.clipboard.writeText(issuedToken).then(() => {
      setTokenCopied(true);
      setTimeout(() => setTokenCopied(false), 2000);
    });
  }

  const activeConns = caps.filter((c) => !c.revokedAt && !isExpired(c.expiresAt));
  const adminWindows = activeConns.filter((c) => c.permission === "admin");
  const inactiveConns = caps.filter((c) => c.revokedAt || isExpired(c.expiresAt));
  const shownConns = applyListState(activeConns, CONNECTION_LIST, connectionView.state);
  const shownInactive = applyListState(inactiveConns, INACTIVE_LIST, inactiveView.state);
  const connectionPage = useListPage(shownConns, {
    prefix: CONNECTION_LIST.paramPrefix!,
    viewKey: listViewKey(CONNECTION_LIST, connectionView.state),
  });
  const inactivePage = useListPage(shownInactive, {
    prefix: INACTIVE_LIST.paramPrefix!,
    viewKey: listViewKey(INACTIVE_LIST, inactiveView.state),
  });

  return (
    <div>
      <h2 className="mb-1 text-lg font-semibold text-fg">Connect your AI</h2>
      <p className="mb-4 text-sm leading-relaxed text-fg-muted">
        Willder speaks the open MCP protocol, so it works with <span className="text-fg">Claude</span>,{" "}
        <span className="text-fg">OpenAI&apos;s API / Agents SDK</span>, or{" "}
        <span className="text-fg">your own custom agent</span> — not just one vendor&apos;s tools. Once connected, your
        AI reads and writes memory through the same access checks as everyone else.
      </p>
      <p className="mb-6 text-sm leading-relaxed text-fg-muted">
        Using Claude Code? Follow the{" "}
        <Link href="/docs/claude-code" className="font-semibold text-info underline-offset-2 hover:underline">
          Claude Code guide
        </Link>
        : one command to connect, and a hook that brings your memory into every new session. A token issued here covers
        the whole workspace; for one scope, issue it from Access, then Tokens.
      </p>

      {/* One-time token reveal */}
      {issuedToken && (
        <Card glow="gold" className="mb-6 p-6">
          <p className="text-eyebrow font-semibold uppercase text-accent">Connection token — copy now, shown once</p>
          <div className="mt-3 flex items-center gap-3 rounded-xl border border-divider bg-black/20 px-4 py-3">
            <code className="flex-1 break-all font-mono text-sm text-fg">{issuedToken}</code>
            <button
              onClick={copyToken}
              className="shrink-0 rounded-full border border-divider px-3 py-1 text-sm font-semibold capitalize text-fg-muted hover:border-gold/40 hover:text-gold transition-colors"
            >
              {tokenCopied ? "Copied!" : "Copy"}
            </button>
          </div>
          <ConfigSnippet token={issuedToken} />
          <button
            onClick={() => setIssuedToken(null)}
            className="mt-4 text-sm font-semibold capitalize text-fg-muted hover:text-fg transition-colors"
          >
            Dismiss
          </button>
        </Card>
      )}

      {/* Issue form */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-fg-subtle">
          {loading ? "Loading…" : `${activeConns.length} active connection${activeConns.length !== 1 ? "s" : ""}`}
        </p>
        <Button variant="primary" size="sm" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Cancel" : "+ New connection"}
        </Button>
      </div>

      {/* Shared between issuance and revoke: revoke controls live in the
          connections table below, which is visible whether or not the
          issuance form is open, so this banner cannot live inside
          `{showForm && (...)}` without going silent on a collapsed form. */}
      {err && <Chip tone="brick">{err}</Chip>}

      {showForm && (
        <Card glow="ember" className="mt-4 p-6">
          <form onSubmit={issue} className="flex flex-col gap-5">
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              {/* Name */}
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium text-fg-muted">Name</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  placeholder="e.g. mcp-claude"
                  className={inputCls}
                />
                <p className="text-sm text-fg-subtle">Identifies this connection in the audit log</p>
              </div>

              {/* TTL */}
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium text-fg-muted">Expires in</label>
                {permission === "admin" ? (
                  <p className="min-h-11 px-1 py-2.5 text-sm text-fg">2 hours, fixed</p>
                ) : (
                  <select value={ttlHours} onChange={(e) => setTtlHours(Number(e.target.value))} className={selectCls}>
                    {TTL_OPTIONS.map((o) => (
                      <option key={o.hours} value={o.hours}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>

            {/* Permission toggle */}
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium text-fg-muted">Access level</label>
              <div className="flex flex-col gap-3 sm:flex-row">
                <button
                  type="button"
                  onClick={() => setPermission("read")}
                  className={`flex-1 rounded-xl border px-4 py-3 text-left transition-colors ${
                    permission === "read"
                      ? "border-gold/40 bg-gold/[0.06]"
                      : "border-divider bg-fg/[0.02] hover:border-accent/35"
                  }`}
                >
                  <p className={`text-sm font-medium ${permission === "read" ? "text-gold" : "text-fg-subtle"}`}>
                    Read only
                  </p>
                  <p className="mt-0.5 text-sm text-fg-subtle">memory_query, memory_entity</p>
                </button>
                <button
                  type="button"
                  onClick={() => setPermission("write")}
                  className={`flex-1 rounded-xl border px-4 py-3 text-left transition-colors ${
                    permission === "write"
                      ? "border-ember/40 bg-ember/[0.06]"
                      : "border-divider bg-fg/[0.02] hover:border-accent/35"
                  }`}
                >
                  <p className={`text-sm font-medium ${permission === "write" ? "text-ember" : "text-fg-subtle"}`}>
                    Read + write
                  </p>
                  <p className="mt-0.5 text-sm text-fg-subtle">All tools including memory_ingest</p>
                </button>
                <button
                  type="button"
                  onClick={() => setPermission("admin")}
                  className={`flex-1 rounded-xl border px-4 py-3 text-left transition-colors ${
                    permission === "admin"
                      ? "border-brick/40 bg-brick/[0.06]"
                      : "border-divider bg-fg/[0.02] hover:border-accent/35"
                  }`}
                >
                  <p className={`text-sm font-medium ${permission === "admin" ? "text-brick" : "text-fg-subtle"}`}>
                    Admin, 2 hours max
                  </p>
                  <p className="mt-0.5 text-sm text-fg-subtle">
                    For setup only. Ends 2 hours after issue and cannot be extended.
                  </p>
                </button>
              </div>
            </div>

            <div className="flex justify-end">
              <Button type="submit" variant="primary" size="sm" disabled={creating}>
                {creating ? "Issuing…" : "Issue connection token"}
              </Button>
            </div>
          </form>
        </Card>
      )}

      <AdminWindowCard tokens={adminWindows} onRevoke={revokeCap} />

      {/* Active connections table */}
      {!loading && activeConns.length > 0 && (
        <div className="mt-6">
          {showsListControls(activeConns.length, connectionView.state) && (
            <ListControls
              config={CONNECTION_LIST}
              controls={connectionView}
              total={activeConns.length}
              shown={shownConns.length}
              className="mb-4"
            />
          )}
          {shownConns.length === 0 ? (
            <ListNoMatch config={CONNECTION_LIST} controls={connectionView} />
          ) : (
            <Card glow="gold" className="overflow-hidden">
              <div
                className="max-w-full overflow-x-auto overscroll-x-contain"
                role="region"
                aria-label="Connected agents"
                tabIndex={0}
              >
                <table className="w-full min-w-[36rem]">
                  <thead>
                    <tr className="border-b border-divider">
                      <SortHeader config={CONNECTION_LIST} controls={connectionView} sortKey="name" className={TH} />
                      <th scope="col" className={TH}>
                        Access
                      </th>
                      <SortHeader config={CONNECTION_LIST} controls={connectionView} sortKey="scope" className={TH} />
                      <SortHeader config={CONNECTION_LIST} controls={connectionView} sortKey="expires" className={TH} />
                      <th className="px-4 py-3 text-eyebrow font-semibold uppercase text-fg-subtle" />
                    </tr>
                  </thead>
                  <tbody>
                    {connectionPage.rows.map((c) => (
                      <tr key={c.id} className="border-b border-divider last:border-0 hover:bg-fg/[0.02]">
                        <td className="px-4 py-3 align-middle">
                          <span className="font-mono text-sm text-fg">{c.agentId}</span>
                        </td>
                        <td className="px-4 py-3 align-middle">{permissionPill(c.permission)}</td>
                        <td className="px-4 py-3 align-middle">
                          <span className="font-mono text-xs text-fg-subtle">{c.scopePath}</span>
                        </td>
                        <td className="px-4 py-3 align-middle text-sm text-fg-subtle">{fmt(c.expiresAt)}</td>
                        <td className="px-4 py-3 text-right align-middle">
                          {confirmRevokeId === c.id ? (
                            <span className="flex items-center justify-end gap-2">
                              <span className="text-sm text-fg-muted">Disconnect?</span>
                              <button
                                onClick={() => revokeCap(c.id)}
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
                            <span className="flex items-center justify-end gap-3">
                              <Pill dot="gold">active</Pill>
                              <button
                                onClick={() => setConfirmRevokeId(c.id)}
                                className="text-sm font-semibold capitalize text-fg-muted hover:text-danger transition-colors"
                              >
                                disconnect
                              </button>
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
          <ListPagination noun={CONNECTION_LIST.noun} paging={connectionPage} className="mt-3" />
        </div>
      )}

      {/* Inactive (collapsed by default) */}
      {!loading && inactiveConns.length > 0 && (
        <details className="mt-3 group">
          <summary className="cursor-pointer list-none text-sm font-semibold text-fg-subtle hover:text-fg transition-colors">
            {inactiveConns.length} expired or revoked
          </summary>
          {showsListControls(inactiveConns.length, inactiveView.state) && (
            <ListControls
              config={INACTIVE_LIST}
              controls={inactiveView}
              total={inactiveConns.length}
              shown={shownInactive.length}
              className="mt-2"
            />
          )}
          {shownInactive.length === 0 ? (
            <div className="mt-2">
              <ListNoMatch config={INACTIVE_LIST} controls={inactiveView} />
            </div>
          ) : (
            <Card className="mt-2 overflow-hidden">
              <div
                className="max-w-full overflow-x-auto overscroll-x-contain"
                role="region"
                aria-label="Disconnected agents"
                tabIndex={0}
              >
                <table className="w-full min-w-[36rem]">
                  <tbody>
                    {inactivePage.rows.map((c) => (
                      <tr key={c.id} className="border-b border-divider last:border-0">
                        <td className="px-4 py-3 text-sm text-fg-subtle">{c.agentId}</td>
                        <td className="px-4 py-3">{permissionPill(c.permission)}</td>
                        <td className="px-4 py-3 text-right">
                          {c.revokedAt ? <Pill dot="brick">revoked</Pill> : <Pill dot="marble">expired</Pill>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
          <ListPagination noun={INACTIVE_LIST.noun} paging={inactivePage} className="mt-3" />
        </details>
      )}

      {/* Available tools reference */}
      <div className="mt-10">
        <h3 className="mb-1 font-display text-xl font-semibold text-fg">Available tools</h3>
        <p className="mb-4 text-sm text-fg-subtle">
          Your AI gets these tools once connected. The access level of the token controls which ones work.
        </p>
        <Card glow={false} className="overflow-hidden">
          <div
            className="max-w-full overflow-x-auto overscroll-x-contain"
            role="region"
            aria-label="Available MCP tools"
            tabIndex={0}
          >
            <table className="w-full min-w-[36rem]">
              <thead>
                <tr className="border-b border-divider">
                  <th className="px-4 py-3 text-left text-eyebrow font-semibold uppercase text-fg-subtle">Tool</th>
                  <th className="px-4 py-3 text-left text-eyebrow font-semibold uppercase text-fg-subtle">
                    What it does
                  </th>
                  <th className="px-4 py-3 text-left text-eyebrow font-semibold uppercase text-fg-subtle">Needs</th>
                </tr>
              </thead>
              <tbody>
                {TOOLS.map((t) => (
                  <tr key={t.name} className="border-b border-divider last:border-0">
                    <td className="px-4 py-3 align-top">
                      <span className="font-mono text-xs text-fg">{t.name}</span>
                    </td>
                    <td className="px-4 py-3 align-top text-sm text-fg-subtle">{t.description}</td>
                    <td className="px-4 py-3 align-top">
                      {t.permission === "write" ? (
                        <Pill dot="ember">write</Pill>
                      ) : t.permission === "read" ? (
                        <Pill dot="marble">read</Pill>
                      ) : (
                        <Pill dot="gold">any</Pill>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
