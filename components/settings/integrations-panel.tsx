"use client";

import { useState } from "react";
import { Card, Button, Chip, Pill } from "@/components/ui";
import { ListControls, ListNoMatch } from "@/components/list-controls/list-controls";
import { ServerListPagination } from "@/components/list-controls/server-list-pagination";
import { listViewKey } from "@/components/list-controls/list-page";
import { compareText, compareTime, showsListControls, type ListConfig } from "@/components/list-controls/list-query";
import { useListState } from "@/components/list-controls/use-list-state";
import { listPageUrl, pageToShow, useServerPage } from "@/components/list-controls/use-server-page";
import { MAX_ACCESS_PAGE } from "@/lib/access-lists";
import { listSearchText } from "@/lib/list-search";

type MailboxProvider = "gmail" | "outlook";

type Integration = {
  id: string;
  provider: MailboxProvider;
  externalAccountId: string | null;
  status: "pending" | "connected" | "disconnected" | "error";
  meta: Record<string, string> | null;
  createdAt: string;
};

/** The newest attempt in each state but connected, as GET /api/integrations answers them. */
type Attempts = Record<"pending" | "error" | "disconnected", Integration | null>;

const PROVIDERS: { key: MailboxProvider; label: string; icon: string }[] = [
  { key: "gmail", label: "Gmail", icon: "G" },
  { key: "outlook", label: "Outlook", icon: "O" },
];

function accountName(row: Integration): string {
  return row.meta?.email ?? row.externalAccountId ?? "Unnamed account";
}

/**
 * How a provider's connected accounts search and order; each card's view lives under
 * `mailboxes.<provider>.` in the URL. The server does the work a page at a time
 * (GET /api/integrations, lib/integration-lists.ts).
 */
function accountList(provider: MailboxProvider): ListConfig<Integration> {
  return {
    noun: { one: "account", many: "accounts" },
    searchText: (row) => [accountName(row), row.externalAccountId],
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
        label: "Address",
        compare: (a, b) => compareText(accountName(a), accountName(b)),
        directionLabels: { asc: "A–Z", desc: "Z–A" },
      },
    ],
    paramPrefix: `mailboxes.${provider}.`,
  };
}

const ACCOUNT_LISTS: Record<MailboxProvider, ListConfig<Integration>> = {
  gmail: accountList("gmail"),
  outlook: accountList("outlook"),
};

function statusPill(status: Integration["status"]) {
  if (status === "connected") return <Pill dot="gold">connected</Pill>;
  if (status === "pending") return <Pill dot="ember">pending…</Pill>;
  if (status === "error") return <Pill dot="brick">error</Pill>;
  return <Pill dot="marble">disconnected</Pill>;
}

export function IntegrationsPanel() {
  const [connecting, setConnecting] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set when a disconnect deleted our token but the provider did not confirm the
  // revoke, so the person knows to remove Willder at the provider themselves.
  const [notice, setNotice] = useState<string | null>(null);
  // Bumped to read every card's current page again, after a disconnect or a retry.
  const [revision, setRevision] = useState(0);
  const reload = () => setRevision((r) => r + 1);

  async function connect(provider: "gmail" | "outlook") {
    setConnecting(provider);
    setError(null);
    try {
      const res = await fetch(`/api/integrations/${provider}/connect`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "connect failed");
      // Redirect to the provider's OAuth page (mock mode: goes directly to callback)
      window.location.assign(body.authUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : "connect failed");
      setConnecting(null);
    }
  }

  async function disconnect(id: string) {
    setDisconnecting(id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/integrations/${id}`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "disconnect failed");
      if (body.providerRevoked === false) {
        setNotice(
          `Disconnected and the token is deleted, but the provider did not confirm the revoke: ${body.providerRevokeError ?? "no reason given"}.`,
        );
      }
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "disconnect failed");
    } finally {
      setDisconnecting(null);
    }
  }

  return (
    <div>
      <h2 className="mb-1 text-lg font-semibold text-fg">Mailbox connections</h2>
      <p className="mb-6 text-sm leading-relaxed text-fg-muted">
        Connecting a mailbox links its address to your org. Willder does not read, send or watch your mail.
      </p>

      {error && (
        <div className="mb-4">
          <Chip tone="brick">{error}</Chip>
        </div>
      )}

      {notice && (
        <div role="status" className="mb-4">
          <Chip tone="ember">{notice}</Chip>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {PROVIDERS.map(({ key, label, icon }) => (
          <ProviderCard
            key={key}
            provider={key}
            label={label}
            icon={icon}
            revision={revision}
            connecting={connecting === key}
            disconnecting={disconnecting}
            onConnect={() => connect(key)}
            onDisconnect={disconnect}
            onRetry={reload}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One provider's card: its connected accounts, a page at a time, or the state of its
 * latest attempt when none is connected (pending > error > disconnected). Every
 * connected mailbox is its own row, so an org with two Gmail accounts sees (and can
 * disconnect) both.
 */
function ProviderCard({
  provider,
  label,
  icon,
  revision,
  connecting,
  disconnecting,
  onConnect,
  onDisconnect,
  onRetry,
}: {
  provider: MailboxProvider;
  label: string;
  icon: string;
  revision: number;
  connecting: boolean;
  disconnecting: string | null;
  onConnect: () => void;
  onDisconnect: (id: string) => void;
  onRetry: () => void;
}) {
  const config = ACCOUNT_LISTS[provider];
  const view = useListState(config);
  const committed = view.committed;
  const list = useServerPage<Integration, { attempts: Attempts }>({
    prefix: config.paramPrefix!,
    maxPage: MAX_ACCESS_PAGE,
    rowsKey: "integrations",
    viewKey: `${listSearchText(committed.query)}|${listViewKey(config, { ...committed, query: "" })}`,
    urlFor: (page) => listPageUrl("/api/integrations", committed, page, { provider }),
    searching: listSearchText(committed.query) !== "",
    revision,
  });

  // A failed load says so, never "Not connected" for an org whose connections it could not read.
  if (list.state.status === "failed" || list.state.status === "forbidden") {
    return (
      <Card className="flex flex-col gap-3 px-5 py-5">
        <span className="text-base font-medium text-fg">{label}</span>
        <div role="alert" className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <span className="text-sm text-danger">Couldn&apos;t load {label} connections.</span>
          <Button variant="ghost" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      </Card>
    );
  }
  const { fresh, shown, settled } = pageToShow(list.state);
  if (!shown) {
    return <Card className="px-5 py-5 text-base text-fg-subtle">Loading…</Card>;
  }
  const stale = fresh === null;
  // The card's status (connected, pending, the latest failed attempt) and its Connect
  // button describe the whole org, so after a disconnect they wait for the reload: the
  // page from before it would still say "connected". The rows below may show dimmed.
  const listed = shown.count > 0;
  const hasConnected = settled !== null && settled.count > 0;
  const { pending, error, disconnected } = settled?.attempts ?? { pending: null, error: null, disconnected: null };
  const latest = pending ?? error ?? disconnected;
  const isPending = !hasConnected && latest?.status === "pending";
  // The action beside the status stays where it was while the card checks, inert, so a
  // keyboard user who pressed it keeps focus; which action it is was decided by the page
  // shown before, and it does nothing until the fresh page says what holds now.
  const checking = settled === null;
  const offered = settled ?? shown;
  const offeredLatest = offered.attempts.pending ?? offered.attempts.error ?? offered.attempts.disconnected;
  const offersDisconnect = offeredLatest?.status === "pending" ? offeredLatest : null;

  return (
    <Card glow={hasConnected ? "gold" : isPending ? "ember" : false} className="flex flex-col gap-4 px-5 py-5">
      {/* flex-auto (not flex-1) sizes the label column by its content, so on a
          narrow card the button wraps below the status pill instead of covering it. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        {/* Provider icon */}
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-divider bg-fg/[0.04] font-mono text-base font-bold text-fg-subtle">
          {icon}
        </div>

        <div className="flex min-w-0 flex-auto flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-medium text-fg">{label}</span>
            {hasConnected ? statusPill("connected") : latest && statusPill(latest.status)}
          </div>
          {!settled ? (
            <span role="status" className="text-sm text-fg-subtle">
              Checking…
            </span>
          ) : (
            !hasConnected && !latest && <span className="text-sm text-fg-subtle">Not connected</span>
          )}
        </div>

        {offered.count === 0 && (
          <div className="shrink-0">
            {offersDisconnect ? (
              <Button
                variant="ghost"
                size="sm"
                aria-disabled={checking}
                disabled={disconnecting === offersDisconnect.id}
                onClick={() => {
                  if (!checking) onDisconnect(offersDisconnect.id);
                }}
              >
                {disconnecting === offersDisconnect.id ? "Disconnecting…" : "Disconnect"}
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                aria-disabled={checking}
                disabled={connecting}
                onClick={() => {
                  if (!checking) onConnect();
                }}
              >
                {connecting ? "Connecting…" : "Connect"}
              </Button>
            )}
          </div>
        )}
      </div>

      {listed && showsListControls(shown.count, view.state) && (
        <ListControls config={config} controls={view} total={shown.count} shown={stale ? null : shown.total} />
      )}
      {listed && stale && shown.rows.length === 0 && (
        <p role="status" className="text-sm text-fg-subtle">
          Loading…
        </p>
      )}
      {fresh &&
        fresh.count > 0 &&
        fresh.rows.length === 0 &&
        (list.page > 1 ? (
          <p className="text-sm text-fg-muted">
            This page is past the last account.{" "}
            <button type="button" onClick={() => list.setPage(1)} className="underline underline-offset-2">
              Go to page 1
            </button>
          </p>
        ) : (
          <ListNoMatch config={config} controls={view} />
        ))}
      {shown.rows.length > 0 && (
        <ul
          aria-busy={stale}
          className={`flex flex-col gap-2 transition-opacity ${stale ? "opacity-60" : ""}`}
          aria-label={`Connected ${label} accounts`}
        >
          {shown.rows.map((row) => {
            const account = accountName(row);
            return (
              <li
                key={row.id}
                className="flex items-center gap-3 rounded-lg border border-divider bg-fg/[0.02] px-3 py-2"
              >
                <span className="flex-1 truncate text-sm text-fg-muted">{account}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Disconnect ${account}`}
                  disabled={disconnecting === row.id}
                  aria-disabled={stale}
                  onClick={() => {
                    if (!stale) onDisconnect(row.id);
                  }}
                >
                  {disconnecting === row.id ? "Disconnecting…" : "Disconnect"}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {listed && <ServerListPagination noun={config.noun} list={list} />}
    </Card>
  );
}
