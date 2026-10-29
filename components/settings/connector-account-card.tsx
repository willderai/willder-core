"use client";

import { useEffect, useState } from "react";
import { Button, Chip, Pill } from "@/components/ui";
import { ConnectorLogo } from "@/components/connector-logo";
import { ListControls, ListNoMatch } from "@/components/list-controls/list-controls";
import { ServerListPagination } from "@/components/list-controls/server-list-pagination";
import { listViewKey } from "@/components/list-controls/list-page";
import { compareText, compareTime, showsListControls, type ListConfig } from "@/components/list-controls/list-query";
import { useListState } from "@/components/list-controls/use-list-state";
import { listPageUrl, pageToShow, useServerPage, type ServerPage } from "@/components/list-controls/use-server-page";
import { MAX_ACCESS_PAGE } from "@/lib/access-lists";
import { listSearchText } from "@/lib/list-search";

// Connects an org's Slack workspace (Figma takes the same card next) through the
// provider's own OAuth sign-in. Connect calls POST /api/integrations/:provider/connect
// and follows the authorize URL it returns; the callback sends the browser back to
// /integrations?integration=:provider&connected=0|1. The card reads that flag once,
// removes it from the URL, and reports the outcome only as far as the stored
// integration row confirms it: `connected=1` alone never shows as success.
//
// Disconnect calls DELETE /api/integrations/:id, which clears the stored token and
// revokes it upstream where the provider supports that.
//
// The connected workspaces are read a page at a time (GET /api/integrations?provider=),
// with the provider's newest errored attempt alongside, which tells a declined sign-in
// from a failed one.

export type OAuthConnectorProvider = "slack" | "figma";

const LABEL: Record<OAuthConnectorProvider, string> = { slack: "Slack", figma: "Figma" };

type Integration = {
  id: string;
  provider: string;
  externalAccountId: string | null;
  status: "pending" | "connected" | "disconnected" | "error";
  meta: Record<string, unknown> | null;
  createdAt: string;
};

/** What the OAuth round trip that just returned to Integrations actually achieved. */
export type ConnectOutcome = "connected" | "unconfirmed" | "declined" | "failed";

/**
 * Reads `?integration=<provider>&connected=0|1` for this provider. Returns null
 * when the URL carries no redirect result for it.
 */
export function readRedirectResult(search: string, provider: OAuthConnectorProvider): boolean | null {
  const params = new URLSearchParams(search);
  if (params.get("integration") !== provider) return null;
  const connected = params.get("connected");
  if (connected === "1") return true;
  if (connected === "0") return false;
  return null;
}

/** What the server says about a provider: how many accounts are connected, and its newest errored attempt. */
export type ProviderRecord = { connectedCount: number; latestError: Integration | null };

/**
 * Matches the redirect flag against what the server recorded. A success flag counts
 * only when a connected account exists; a failure is a decline when the provider
 * reported `access_denied` on the newest errored attempt.
 */
export function connectOutcome(redirectConnected: boolean, record: ProviderRecord): ConnectOutcome {
  if (redirectConnected) return record.connectedCount > 0 ? "connected" : "unconfirmed";
  return record.latestError?.meta?.error === "access_denied" ? "declined" : "failed";
}

function accountName(row: Integration, provider: OAuthConnectorProvider): string {
  const teamName = row.meta?.teamName;
  if (typeof teamName === "string" && teamName) return teamName;
  return row.externalAccountId ?? `${LABEL[provider]} account`;
}

/** `newest` is the newest connected account, named in the success message when known. */
function outcomeMessage(outcome: ConnectOutcome, provider: OAuthConnectorProvider, newest: Integration | undefined) {
  const label = LABEL[provider];
  if (outcome === "connected") {
    return { tone: "gold" as const, text: `${label} connected${newest ? `: ${accountName(newest, provider)}` : ""}.` };
  }
  if (outcome === "unconfirmed") {
    return {
      tone: "ember" as const,
      text: `${label} sent you back, but Willder has no connected account on record. Try connecting again.`,
    };
  }
  if (outcome === "declined") {
    return { tone: "muted" as const, text: `You cancelled the ${label} sign-in. Nothing was connected.` };
  }
  return { tone: "brick" as const, text: `${label} connection failed. Nothing was connected; try again.` };
}

/**
 * How a provider's connected workspaces search and order; the view lives under
 * `workspaces.<provider>.` in the URL. The server does the work a page at a time
 * (GET /api/integrations, lib/integration-lists.ts).
 */
function workspaceList(provider: OAuthConnectorProvider): ListConfig<Integration> {
  return {
    noun: { one: "workspace", many: "workspaces" },
    searchText: (row) => [accountName(row, provider), row.externalAccountId],
    sorts: [
      {
        key: "created",
        label: "Date connected",
        compare: (a, b) => compareTime(a.createdAt, b.createdAt),
        defaultDirection: "desc",
        directionLabels: { asc: "Oldest first", desc: "Newest first" },
      },
      {
        key: "account",
        label: "Name",
        compare: (a, b) => compareText(accountName(a, provider), accountName(b, provider)),
        directionLabels: { asc: "A–Z", desc: "Z–A" },
      },
    ],
    paramPrefix: `workspaces.${provider}.`,
  };
}

const WORKSPACE_LISTS: Record<OAuthConnectorProvider, ListConfig<Integration>> = {
  slack: workspaceList("slack"),
  figma: workspaceList("figma"),
};

type Attempts = { attempts: { error: Integration | null } };

/** The newest connected account, when the page shown is the newest-first first page. */
function newestConnected(page: ServerPage<Integration, Attempts>, view: { sort: string; direction: string }) {
  return page.page === 1 && view.sort === "created" && view.direction === "desc" ? page.rows[0] : undefined;
}

export function ConnectorAccountCard({ provider }: { provider: OAuthConnectorProvider }) {
  const label = LABEL[provider];
  const config = WORKSPACE_LISTS[provider];
  const view = useListState(config);
  const committed = view.committed;
  // Bumped to read the current page again after a disconnect.
  const [revision, setRevision] = useState(0);
  const list = useServerPage<Integration, Attempts>({
    prefix: config.paramPrefix!,
    maxPage: MAX_ACCESS_PAGE,
    rowsKey: "integrations",
    viewKey: `${provider}|${listSearchText(committed.query)}|${listViewKey(config, { ...committed, query: "" })}`,
    urlFor: (page) => listPageUrl("/api/integrations", committed, page, { provider }),
    searching: listSearchText(committed.query) !== "",
    revision,
  });
  const [redirectConnected, setRedirectConnected] = useState<boolean | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const result = readRedirectResult(window.location.search, provider);
    if (result !== null) {
      // Consume the flag so a refresh doesn't replay the outcome.
      const url = new URL(window.location.href);
      url.searchParams.delete("integration");
      url.searchParams.delete("connected");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time read of the OAuth redirect
    setRedirectConnected(result);
  }, [provider]);

  async function connect() {
    setConnecting(true);
    setError(null);
    setNotice(null);
    setRedirectConnected(null);
    try {
      const res = await fetch(`/api/integrations/${provider}/connect`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.status === 503) {
        throw new Error(`${label} isn't set up on this server yet: its OAuth app credentials are missing.`);
      }
      if (!res.ok || typeof data.authUrl !== "string") {
        throw new Error(data.error ?? `Couldn't start the ${label} sign-in (HTTP ${res.status}).`);
      }
      window.location.assign(data.authUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : `Couldn't start the ${label} sign-in.`);
      setConnecting(false);
    }
  }

  async function disconnect(id: string) {
    setDisconnecting(id);
    setError(null);
    setNotice(null);
    setRedirectConnected(null);
    try {
      const res = await fetch(`/api/integrations/${id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Disconnect failed (HTTP ${res.status}).`);
      if (data.providerRevoked === false) {
        setNotice(
          `Disconnected in Willder and the token is deleted, but ${label} didn't confirm the revoke. Remove the app from your ${label} workspace settings to be sure.`,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Disconnect failed.");
    } finally {
      setDisconnecting(null);
      setRevision((r) => r + 1);
    }
  }

  const { fresh: ready, shown, settled } = pageToShow(list.state);
  const stale = shown !== null && ready === null;
  const loadFailed = list.state.status === "failed" || list.state.status === "forbidden";
  // The redirect flag is judged only against an answer to the current request.
  const outcome =
    redirectConnected !== null && ready
      ? connectOutcome(redirectConnected, { connectedCount: ready.count, latestError: ready.attempts.error })
      : null;
  const outcomeText = outcome && ready ? outcomeMessage(outcome, provider, newestConnected(ready, committed)) : null;
  const connectedCount = shown?.count ?? 0;
  // "Connect another" says one is connected, so after a disconnect it waits for the reload.
  const connectLabel = settled !== null && settled.count > 0 ? "Connect another" : `Connect ${label}`;

  return (
    <div className="rounded-lg border border-divider bg-fg/[0.02] p-3" data-testid={`connector-account-${provider}`}>
      <div className="flex items-center gap-3">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-fg/[0.06] text-info">
          <ConnectorLogo type={provider} className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-fg">{label} workspace</p>
          <p className="text-sm text-fg-subtle">Sign in with {label} to connect your workspace, read-only.</p>
        </div>
        {(shown || loadFailed) && (
          <Button variant="secondary" size="sm" onClick={connect} disabled={connecting}>
            {connecting ? "Redirecting…" : connectLabel}
          </Button>
        )}
      </div>

      {outcomeText && (
        <p role="status" className="mt-3">
          <Chip tone={outcomeText.tone}>{outcomeText.text}</Chip>
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3">
          <Chip tone="brick">{error}</Chip>
        </p>
      )}
      {notice && (
        <p role="status" className="mt-3">
          <Chip tone="ember">{notice}</Chip>
        </p>
      )}

      {!shown && !loadFailed && <p className="mt-3 text-sm text-fg-subtle">Loading…</p>}
      {loadFailed && (
        <p className="mt-3 text-sm text-danger">Couldn&apos;t load {label} connections. Refresh to try again.</p>
      )}

      {shown && connectedCount > 0 && (
        <div className="mt-3 flex flex-col gap-2">
          {showsListControls(connectedCount, view.state) && (
            <ListControls config={config} controls={view} total={connectedCount} shown={stale ? null : shown.total} />
          )}
          {stale && shown.rows.length === 0 && (
            <p role="status" className="text-sm text-fg-subtle">
              Loading…
            </p>
          )}
          {ready &&
            ready.rows.length === 0 &&
            (list.page > 1 ? (
              <p className="text-sm text-fg-muted">
                This page is past the last workspace.{" "}
                <button type="button" onClick={() => list.setPage(1)} className="underline underline-offset-2">
                  Go to page 1
                </button>
              </p>
            ) : (
              <ListNoMatch config={config} controls={view} />
            ))}
          {shown.rows.length > 0 && (
            <ul aria-busy={stale} className={`flex flex-col gap-2 transition-opacity ${stale ? "opacity-60" : ""}`}>
              {shown.rows.map((row) => (
                <li key={row.id} className="flex items-center gap-3 text-sm">
                  <span className="min-w-0 flex-1 truncate text-fg">{accountName(row, provider)}</span>
                  {row.meta?.mock === true ? <Pill dot="ember">test mode</Pill> : <Pill dot="gold">connected</Pill>}
                  <button
                    aria-disabled={stale}
                    onClick={() => {
                      if (!stale) void disconnect(row.id);
                    }}
                    disabled={disconnecting === row.id}
                    className="shrink-0 text-sm font-semibold capitalize text-fg-muted transition-colors hover:text-danger disabled:opacity-40"
                  >
                    {disconnecting === row.id ? "…" : "Disconnect"}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <ServerListPagination noun={config.noun} list={list} />
        </div>
      )}
    </div>
  );
}
