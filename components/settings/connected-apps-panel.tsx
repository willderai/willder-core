"use client";

// Integrations → Connected apps. The apps the signed-in person connected with OAuth
// (claude.ai, ChatGPT), what each can reach, and a Disconnect button that ends the
// app's access at once. Lists only the person's own connections; an admin ends
// anyone's from the Access page by revoking its capability.
import { useEffect, useState } from "react";
import { Button, Card } from "@/components/ui";
import { ListControls, ListNoMatch, ListPagination } from "@/components/list-controls/list-controls";
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

const ENDPOINT = "/api/access/oauth-connections";

/** One live connection, as GET /api/access/oauth-connections returns it. */
type Connection = {
  id: string;
  clientId: string;
  agentId: string;
  scopeName: string;
  permission: string;
  expiresAt: string;
  connectedAt: string;
};

const PERMISSION_LABELS: Record<string, string> = { read: "Read", write: "Read and write", admin: "Admin" };

/** How the connected apps list searches, filters and orders; its view lives under `apps.` in the URL. */
const APP_LIST: ListConfig<Connection> = {
  noun: { one: "connected app", many: "connected apps" },
  searchText: (c) => [c.agentId, c.clientId, c.scopeName],
  sorts: [
    {
      key: "connected",
      label: "Connected",
      compare: (a, b) => compareTime(a.connectedAt, b.connectedAt),
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
      key: "expires",
      label: "Expires",
      compare: (a, b) => compareTime(a.expiresAt, b.expiresAt),
      directionLabels: { asc: "Soonest first", desc: "Latest first" },
    },
  ],
  filters: [
    {
      key: "permission",
      label: "Access",
      options: Object.entries(PERMISSION_LABELS).map(([value, label]) => ({ value, label })),
      matches: (c, permission) => c.permission === permission,
    },
  ],
  paramPrefix: "apps.",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function ConnectedAppsPanel() {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listView = useListState(APP_LIST);
  const shown = connections ? applyListState(connections, APP_LIST, listView.state) : [];
  const appPage = useListPage(shown, { prefix: APP_LIST.paramPrefix!, viewKey: listViewKey(APP_LIST, listView.state) });

  useEffect(() => {
    fetch(ENDPOINT)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Could not load connected apps (HTTP ${res.status})`);
        return ((await res.json()) as { connections: Connection[] }).connections;
      })
      .then(setConnections)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not load connected apps"));
  }, []);

  async function disconnect(id: string) {
    setDisconnecting(id);
    setError(null);
    try {
      const res = await fetch(`${ENDPOINT}/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Could not disconnect (HTTP ${res.status}). Try again.`);
        return;
      }
      setConnections((current) => current?.filter((c) => c.id !== id) ?? null);
    } finally {
      setDisconnecting(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-base font-semibold text-fg">Connected apps</p>
        <p className="mt-0.5 text-sm text-fg-subtle">
          Apps you signed in to Willder with. Each reaches only the scope you chose, as you, until you disconnect it.
        </p>
      </div>

      <Card className="space-y-3 p-6">
        {connections === null && !error ? <p className="text-sm text-fg-subtle">Loading…</p> : null}
        {connections?.length === 0 ? <p className="text-sm text-fg-subtle">You have not connected any apps.</p> : null}
        {connections && showsListControls(connections.length, listView.state) ? (
          <ListControls config={APP_LIST} controls={listView} total={connections.length} shown={shown.length} />
        ) : null}
        {connections && connections.length > 0 && shown.length === 0 ? (
          <ListNoMatch config={APP_LIST} controls={listView} />
        ) : null}
        {shown.length > 0 ? (
          <ul className="divide-y divide-divider" aria-label="Connected apps">
            {appPage.rows.map((c) => (
              <li key={c.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-fg">{c.agentId}</p>
                  <p className="text-sm text-fg-subtle">
                    {PERMISSION_LABELS[c.permission] ?? c.permission} on {c.scopeName}, connected{" "}
                    {formatDate(c.connectedAt)}, until {formatDate(c.expiresAt)}
                  </p>
                  <p className="truncate text-sm text-fg-subtle">{c.clientId}</p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={disconnecting !== null}
                  onClick={() => disconnect(c.id)}
                  aria-label={`Disconnect ${c.agentId}`}
                >
                  {disconnecting === c.id ? "Disconnecting…" : "Disconnect"}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <ListPagination noun={APP_LIST.noun} paging={appPage} />
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </Card>
    </div>
  );
}
