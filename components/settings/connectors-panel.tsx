"use client";

import { useEffect, useRef, useState } from "react";
import { Card, Button, Pill } from "@/components/ui";
import { ConnectorAccountCard } from "./connector-account-card";
import { sourceFailureMessage, sourceRequest, useUnmountSignal } from "./source-requests";
import { ConnectError, confirmedBody, connectSource, WideningConfirm, type PendingWidening } from "./widening-confirm";
import { DisconnectConfirm } from "./disconnect-confirm";
import { GitHubConnectForm } from "./github-connect-form";
import { removedSummary } from "./connector-data";
import { ConnectorLogo, hasConnectorLogo } from "@/components/connector-logo";
import { announceSourcesChanged, showsNotice, useSourcesChanged, type SourcesNotice } from "./sources-changed";
import { ListControls, ListNoMatch } from "@/components/list-controls/list-controls";
import { ServerListPagination } from "@/components/list-controls/server-list-pagination";
import { listViewKey } from "@/components/list-controls/list-page";
import {
  compareText,
  compareTime,
  isNarrowed,
  showsListControls,
  type ListConfig,
} from "@/components/list-controls/list-query";
import { useListState } from "@/components/list-controls/use-list-state";
import { listPageUrl, pageToShow, useServerPage } from "@/components/list-controls/use-server-page";
import { MAX_ACCESS_PAGE } from "@/lib/access-lists";
import { listSearchText } from "@/lib/list-search";
import { CONNECTOR_SOURCE_TYPES, SOURCE_TYPE_LABEL } from "@/lib/source-lists";

// Slack + Figma + PostHog connect/sync/disconnect UI.
//
// Targets the real /api/sources contract (type: "slack" | "figma", body
// { channelId, channelName } / { fileKey, fileName }) rather than a separate
// app/api/connectors/** surface with a consent step and a browsable "available
// sources" catalog: that catalog-browsing capability does not exist on the
// real backend — connecting means naming a channel/file directly, the same
// shape SourcesPanel already uses for gdrive/website. This panel targets that
// real contract 1:1: same /api/sources GET/POST, same /api/sources/:id/sync
// and DELETE /api/sources/:id disconnect SourcesPanel uses, its list paged on the
// server (`kind=connector`) and limited to type
// slack/figma/posthog. No separate fixture layer, no invented routes.
//
// The panel must stay hidden unless explicitly enabled — default OFF — since
// rendering it in production settings with no flag lets a user click
// "Connect" and see a claimed Slack/Figma sync that is actually process-local
// fixture state, not a real, durable backend integration, and a demo fixture
// is never evidence of a completed integration.
//
// PostHog is different from Slack/Figma in one important way: it isn't
// waiting on an OAuth owner, and it never runs fixture-backed. The customer
// pastes their OWN read-only personal API key here, which the server encrypts
// at rest (never logged, never echoed back by GET /api/sources) — so this
// form asks for that key up front instead of connecting tokenless.

const CONNECTORS_ENABLED = process.env.NEXT_PUBLIC_CONNECTORS_ENABLED === "true";

type ConnectorType = (typeof CONNECTOR_SOURCE_TYPES)[number];
const PANEL = "Connectors";

/** What a connect request names, as its row will show it. */
function connectedName(body: Record<string, unknown>): string {
  const name = body.repo ?? body.channelName ?? body.fileName ?? body.insightName;
  return typeof name === "string" ? name : "The source";
}

type Source = {
  id: string;
  type: string;
  externalId: string;
  name: string;
  scopePath: string;
  status: "active" | "syncing" | "error" | "disconnected";
  meta: Record<string, unknown> | null;
  createdAt: string;
  _count?: { files: number };
};

function statusPill(status: Source["status"]) {
  if (status === "active") return <Pill dot="gold">active</Pill>;
  if (status === "syncing") return <Pill dot="ember">syncing…</Pill>;
  if (status === "error") return <Pill dot="brick">error</Pill>;
  return <Pill dot="marble">disconnected</Pill>;
}

const STATUS_LABEL: Record<Source["status"], string> = {
  active: "Active",
  syncing: "Syncing",
  error: "Error",
  disconnected: "Disconnected",
};

/**
 * How the connected sources list searches, filters and orders; its view lives under
 * `connectors.` in the URL. The server does the work a page at a time
 * (GET /api/sources?kind=connector, lib/source-lists.ts).
 */
const CONNECTOR_LIST: ListConfig<Source> = {
  noun: { one: "connector", many: "connectors" },
  searchText: (s) => [s.name, s.scopePath, SOURCE_TYPE_LABEL[s.type as ConnectorType]],
  sorts: [
    {
      key: "created",
      label: "Date connected",
      compare: (a, b) => compareTime(a.createdAt, b.createdAt),
      defaultDirection: "desc",
      directionLabels: { asc: "Oldest first", desc: "Newest first" },
    },
    {
      key: "name",
      label: "Name",
      compare: (a, b) => compareText(a.name, b.name),
      directionLabels: { asc: "A–Z", desc: "Z–A" },
    },
  ],
  filters: [
    {
      key: "type",
      label: "Type",
      options: CONNECTOR_SOURCE_TYPES.map((t) => ({ value: t, label: SOURCE_TYPE_LABEL[t] })),
      matches: (s, type) => s.type === type,
    },
    {
      key: "status",
      label: "Status",
      options: (Object.keys(STATUS_LABEL) as Source["status"][]).map((st) => ({ value: st, label: STATUS_LABEL[st] })),
      matches: (s, status) => s.status === status,
    },
  ],
  paramPrefix: "connectors.",
};

/** The panel, mounted only while connectors are switched on, so it reads nothing otherwise. */
export function ConnectorsPanel() {
  return CONNECTORS_ENABLED ? <EnabledConnectorsPanel /> : null;
}

function EnabledConnectorsPanel() {
  const listView = useListState(CONNECTOR_LIST);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<SourcesNotice | null>(null);
  const [pendingWidening, setPendingWidening] = useState<PendingWidening | null>(null);
  /** Why the last connect was refused, shown with the form that sent it. */
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectType, setConnectType] = useState<ConnectorType | null>(null);
  const [idField, setIdField] = useState(""); // channelId / fileKey
  const [nameField, setNameField] = useState(""); // channelName / fileName
  const [tokenField, setTokenField] = useState(""); // slack/figma OAuth token
  const [phProjectId, setPhProjectId] = useState("");
  const [phInsightId, setPhInsightId] = useState("");
  const [phInsightName, setPhInsightName] = useState("");
  const [phApiKey, setPhApiKey] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState<Source | null>(null);

  // Bumped to read the current page again: Retry, a write here, or one in Knowledge sources.
  const [revision, setRevision] = useState(0);
  const reload = () => setRevision((r) => r + 1);
  const committed = listView.committed;
  const list = useServerPage<Source>({
    prefix: CONNECTOR_LIST.paramPrefix!,
    maxPage: MAX_ACCESS_PAGE,
    rowsKey: "sources",
    viewKey: `${listSearchText(committed.query)}|${listViewKey(CONNECTOR_LIST, { ...committed, query: "" })}`,
    urlFor: (page) => listPageUrl("/api/sources", committed, page, { kind: "connector" }),
    searching: listSearchText(committed.query) !== "",
    revision,
  });
  // A failed or refused load shows no rows: rows from before a revoked session or a
  // removed grant must not stay on screen as if they were current.
  const { fresh, shown } = pageToShow(list.state);
  const stale = shown !== null && fresh === null;

  /** After this panel wrote a source: reload, and tell the Knowledge sources panel to. */
  function reloadAfterWrite() {
    reload();
    announceSourcesChanged(PANEL);
  }

  useSourcesChanged(PANEL, (from) => {
    setNotice({ text: `Updated after a change in ${from}.`, kind: "changed-elsewhere" });
    reload();
  });

  function resetConnectFields() {
    setConnectType(null);
    setConnectError(null);
    setPendingWidening(null);
    setIdField("");
    setNameField("");
    setTokenField("");
    setPhProjectId("");
    setPhInsightId("");
    setPhInsightName("");
    setPhApiKey("");
  }

  /** Connect, or hold the request for confirmation when it widens who reads the source. */
  /**
   * Bumped by each connect and by Cancel. An answer to a connect the person cancelled
   * changes no form: a success is still reported (it did connect), a refusal or a
   * question is dropped.
   */
  const connectRun = useRef(0);
  const panelSignal = useUnmountSignal();

  async function connectOrAsk(body: Record<string, unknown>, run: number) {
    setPendingWidening(null);
    setNotice(null);
    const result = await connectSource(body, panelSignal());
    const cancelled = run !== connectRun.current;
    if (!result.connected) {
      if (!cancelled) setPendingWidening(result.pending);
      return;
    }
    if (!cancelled) resetConnectFields();
    reloadAfterWrite();
    const where = result.source ? ` into scope ${result.source.scopePath}` : "";
    setNotice({
      text: `${result.source?.name ?? connectedName(body)} connected${where}. The Knowledge sources tab shows its sync status.`,
      kind: "write",
    });
    reported();
  }

  function cancelConnect() {
    connectRun.current += 1;
    setConnecting(false);
    resetConnectFields();
  }

  /** A changed field makes the last connect's refusal or question about values no longer on screen. */
  function dropConnectAnswer() {
    setConnectError(null);
    setPendingWidening(null);
  }

  async function connect(type: Exclude<ConnectorType, "github">) {
    if (type === "posthog") {
      if (!phProjectId.trim() || !phInsightId.trim() || !phInsightName.trim() || !phApiKey.trim()) return;
    } else if (!idField.trim() || !nameField.trim()) {
      return;
    }
    const token = tokenField.trim() || undefined;
    await send(
      type === "slack"
        ? { type, channelId: idField.trim(), channelName: nameField.trim(), token }
        : type === "figma"
          ? { type, fileKey: idField.trim(), fileName: nameField.trim(), token }
          : {
              type,
              projectId: phProjectId.trim(),
              insightId: phInsightId.trim(),
              insightName: phInsightName.trim(),
              apiKey: phApiKey.trim(),
            },
    );
  }

  async function send(body: Record<string, unknown>) {
    const run = ++connectRun.current;
    setConnecting(true);
    setConnectError(null);
    try {
      await connectOrAsk(body, run);
    } catch (e) {
      if (run === connectRun.current)
        setConnectError(e instanceof Error ? e.message : "The connect failed. Try again.");
    } finally {
      if (run === connectRun.current) setConnecting(false);
    }
  }
  async function confirmWidening() {
    if (!pendingWidening) return;
    await send(confirmedBody(pendingWidening));
  }
  /** The widening question, shown with the form whose connect asked it. */
  const wideningQuestion = pendingWidening && (
    <WideningConfirm
      pending={pendingWidening}
      what={pendingWidening.body.type === "github" ? "this repository" : "this source"}
      busy={connecting}
      onConfirm={() => void confirmWidening()}
      onCancel={() => setPendingWidening(null)}
    />
  );

  // Focus has to land somewhere after an action ends, because the button pressed is
  // disabled or gone (the fields lock while a connect is in flight; a successful one closes
  // the form). A refused connect or a cancelled question gives it back to that form's
  // Connect; anything else gives it to the message that reports the result.
  const connectButton = useRef<HTMLButtonElement>(null);
  const errorLine = useRef<HTMLDivElement>(null);
  const noticeLine = useRef<HTMLParagraphElement>(null);
  const [reportCount, setReportCount] = useState(0);
  const reportFocused = useRef(0);
  const reported = () => setReportCount((n) => n + 1);
  const noticeShown = showsNotice(notice, list.state.status);
  const asking = pendingWidening !== null;
  const before = useRef({ connecting, asking });
  useEffect(() => {
    const ended = (before.current.connecting && !connecting) || (before.current.asking && !asking);
    before.current = { connecting, asking };
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (ended && lost && !asking && connectType !== null && connectType !== "github") connectButton.current?.focus();
  }, [connecting, asking, connectType]);
  useEffect(() => {
    if (reportCount === reportFocused.current) return;
    const target = errorLine.current ?? noticeLine.current;
    if (!target) return;
    reportFocused.current = reportCount;
    if (document.activeElement === null || document.activeElement === document.body) target.focus();
  }, [reportCount, error, noticeShown]);

  async function sync(source: Source) {
    setSyncing(source.id);
    setError(null);
    setNotice(null);
    try {
      const answer = await sourceRequest("sync", `/api/sources/${source.id}/sync`, {
        method: "POST",
        signal: panelSignal(),
      });
      if (!answer.ok) throw new Error(sourceFailureMessage("sync", answer));
      reloadAfterWrite();
      setNotice({
        text: `Sync requested for ${source.name}. The Knowledge sources tab shows its result.`,
        kind: "write",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "error");
    } finally {
      setSyncing(null);
      reported();
    }
  }

  async function disconnect(source: Source) {
    if (!fresh) return;
    setDisconnecting(source.id);
    setError(null);
    setNotice(null);
    try {
      const answer = await sourceRequest("disconnect", `/api/sources/${source.id}`, {
        method: "DELETE",
        signal: panelSignal(),
      });
      if (!answer.ok) throw new Error(sourceFailureMessage("disconnect", answer));
      setConfirmingDisconnect(null);
      reloadAfterWrite();
      setNotice({ text: `${source.name} disconnected. ${removedSummary(answer.body ?? {})}`, kind: "write" });
    } catch (e) {
      setConfirmingDisconnect(null);
      setError(e instanceof Error ? e.message : "error");
    } finally {
      setDisconnecting(null);
      reported();
    }
  }

  return (
    <Card glow="gold" className="p-6">
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-fg">Connectors</h2>
        <p className="mt-0.5 text-sm text-fg-subtle">
          Give an agent read-only access to a specific Slack channel, Figma file, or PostHog insight — you name what
          syncs, and can disconnect it any time. Slack channels and Figma files still take a token in production; the
          Slack sign-in below does not feed channel sync yet. PostHog needs your own read-only personal API key from the
          start, which we encrypt at rest and never show again.
        </p>
      </div>

      {error && (
        <div ref={errorLine} tabIndex={-1} className="mb-4 outline-none">
          <ConnectError message={error} />
        </div>
      )}
      {noticeShown && (
        <p ref={noticeLine} tabIndex={-1} role="status" className="mb-4 text-sm text-info outline-none">
          {notice.text}
        </p>
      )}

      {confirmingDisconnect && (
        <DisconnectConfirm
          kind={confirmingDisconnect.type as ConnectorType}
          name={confirmingDisconnect.name}
          busy={disconnecting === confirmingDisconnect.id}
          unavailable={fresh === null}
          onConfirm={() => void disconnect(confirmingDisconnect)}
          onCancel={() => setConfirmingDisconnect(null)}
        />
      )}

      <div className="mb-4">
        <ConnectorAccountCard provider="slack" />
      </div>

      {list.state.status === "forbidden" ? (
        <p role="alert" className="py-2 text-sm text-fg-subtle">
          Listing connectors needs write access to the whole organization.
        </p>
      ) : list.state.status === "failed" ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-brick/25 bg-brick/5 px-3 py-2.5 text-sm text-danger"
        >
          <p className="min-w-0">Connectors could not be loaded.</p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setNotice(null);
              reload();
            }}
          >
            Retry
          </Button>
        </div>
      ) : !shown ? (
        <div role="status" className="py-8 text-center text-sm text-fg-subtle">
          Loading…
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {fresh?.count === 0 && !isNarrowed(committed) && (
            <p className="py-2 text-sm text-fg-subtle">No Slack, Figma, PostHog or GitHub sources connected yet.</p>
          )}
          {showsListControls(shown.count, listView.state) && (
            <ListControls
              config={CONNECTOR_LIST}
              controls={listView}
              total={shown.count}
              shown={stale ? null : shown.total}
              className="mb-2"
            />
          )}
          {stale && shown.rows.length === 0 && (
            <div role="status" className="py-2 text-sm text-fg-subtle">
              Loading…
            </div>
          )}
          {fresh &&
            fresh.rows.length === 0 &&
            (fresh.count > 0 || isNarrowed(committed)) &&
            (list.page > 1 ? (
              <p className="py-2 text-sm text-fg-muted">
                This page is past the last connector.{" "}
                <button type="button" onClick={() => list.setPage(1)} className="underline underline-offset-2">
                  Go to page 1
                </button>
              </p>
            ) : (
              <ListNoMatch config={CONNECTOR_LIST} controls={listView} />
            ))}
          <div aria-busy={stale} className={`flex flex-col gap-2 transition-opacity ${stale ? "opacity-60" : ""}`}>
            {shown.rows.map((s) => (
              <article
                key={s.id}
                aria-labelledby={`connector-source-${s.id}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-divider bg-fg/[0.02] px-3 py-2.5"
              >
                {/* Below sm the name takes the whole first line and the status and
                    actions wrap under it, so a phone shows the name, not "#…". */}
                <div className="flex min-w-0 basis-full items-center gap-3 sm:basis-0 sm:flex-1">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-fg/[0.06] text-info">
                    {hasConnectorLogo(s.type) && <ConnectorLogo type={s.type} className="h-4 w-4" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-fg-subtle">
                      {SOURCE_TYPE_LABEL[s.type as ConnectorType] ?? s.type}
                    </p>
                    <p id={`connector-source-${s.id}`} className="truncate text-sm text-fg" title={s.name}>
                      {s.name}
                    </p>
                  </div>
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                  {statusPill(s.status)}
                  {s.status !== "disconnected" && (
                    <>
                      <button
                        onClick={() => sync(s)}
                        disabled={syncing === s.id}
                        className="shrink-0 text-sm font-semibold capitalize text-fg-muted transition-colors hover:text-gold disabled:opacity-40"
                      >
                        {syncing === s.id ? "Syncing…" : "Sync"}
                      </button>
                      <button
                        aria-disabled={stale}
                        onClick={() => {
                          if (!stale) setConfirmingDisconnect(s);
                        }}
                        disabled={disconnecting === s.id}
                        className="shrink-0 text-sm font-semibold capitalize text-fg-muted transition-colors hover:text-danger disabled:opacity-40"
                      >
                        {disconnecting === s.id ? "…" : "Disconnect"}
                      </button>
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>
          <ServerListPagination noun={CONNECTOR_LIST.noun} list={list} className="mt-2" />
        </div>
      )}

      <div className="mt-4 border-t border-divider pt-4">
        {connectType === "github" ? (
          <GitHubConnectForm
            busy={connecting}
            onConnect={(body) => void send(body)}
            onCancel={cancelConnect}
            error={connectError}
            confirmation={wideningQuestion}
            onEdit={dropConnectAnswer}
          />
        ) : connectType === "posthog" ? (
          <fieldset
            onChange={dropConnectAnswer}
            className="flex min-w-0 flex-col gap-2 rounded-lg border border-divider bg-fg/[0.02] p-3"
          >
            <p className="text-eyebrow font-semibold uppercase text-fg-subtle">Connect a PostHog insight</p>
            <p className="text-sm text-fg-subtle">
              Uses a read-only <span className="text-fg-muted">personal API key</span> from your own PostHog account
              (Settings → Personal API Keys). We store it encrypted and never display it again — this connector saves
              one insight&apos;s current result, never raw events.
            </p>
            <input
              // Locked while a connect is in flight, so its answer is about what is on screen; Cancel stays usable.
              disabled={connecting}
              value={phProjectId}
              onChange={(e) => setPhProjectId(e.target.value)}
              placeholder="Project ID (e.g. 12345)"
              className="min-h-11 w-full rounded-xl border border-[var(--field-border)] bg-[var(--field-background)] px-4 py-2.5 text-sm text-fg hover:border-[var(--field-border-hover)] focus-visible:border-[var(--field-border-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info placeholder:text-[var(--field-placeholder)]"
            />
            <input
              // Locked while a connect is in flight, so its answer is about what is on screen; Cancel stays usable.
              disabled={connecting}
              value={phInsightId}
              onChange={(e) => setPhInsightId(e.target.value)}
              placeholder="Insight ID (e.g. 67890)"
              className="min-h-11 w-full rounded-xl border border-[var(--field-border)] bg-[var(--field-background)] px-4 py-2.5 text-sm text-fg hover:border-[var(--field-border-hover)] focus-visible:border-[var(--field-border-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info placeholder:text-[var(--field-placeholder)]"
            />
            <input
              // Locked while a connect is in flight, so its answer is about what is on screen; Cancel stays usable.
              disabled={connecting}
              value={phInsightName}
              onChange={(e) => setPhInsightName(e.target.value)}
              placeholder="A name for this insight (e.g. Weekly signups)"
              className="min-h-11 w-full rounded-xl border border-[var(--field-border)] bg-[var(--field-background)] px-4 py-2.5 text-sm text-fg hover:border-[var(--field-border-hover)] focus-visible:border-[var(--field-border-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info placeholder:text-[var(--field-placeholder)]"
            />
            <input
              // Locked while a connect is in flight, so its answer is about what is on screen; Cancel stays usable.
              disabled={connecting}
              type="password"
              autoComplete="off"
              value={phApiKey}
              onChange={(e) => setPhApiKey(e.target.value)}
              placeholder="Personal API key (read-only)"
              className="min-h-11 w-full rounded-xl border border-[var(--field-border)] bg-[var(--field-background)] px-4 py-2.5 text-sm text-fg hover:border-[var(--field-border-hover)] focus-visible:border-[var(--field-border-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info placeholder:text-[var(--field-placeholder)]"
            />
            <div className="mt-1 flex items-center gap-2">
              <Button
                ref={connectButton}
                variant="secondary"
                size="sm"
                onClick={() => connect("posthog")}
                disabled={
                  connecting || !phProjectId.trim() || !phInsightId.trim() || !phInsightName.trim() || !phApiKey.trim()
                }
              >
                {connecting ? "Connecting…" : "Connect"}
              </Button>
              <button
                onClick={cancelConnect}
                className="px-3 py-1.5 text-sm text-fg-subtle hover:text-fg transition-colors"
              >
                Cancel
              </button>
            </div>
          </fieldset>
        ) : connectType ? (
          <fieldset
            onChange={dropConnectAnswer}
            className="flex min-w-0 flex-col gap-2 rounded-lg border border-divider bg-fg/[0.02] p-3"
          >
            <p className="text-eyebrow font-semibold uppercase text-fg-subtle">
              Connect a {SOURCE_TYPE_LABEL[connectType]} {connectType === "slack" ? "channel" : "file"}
            </p>
            <input
              // Locked while a connect is in flight, so its answer is about what is on screen; Cancel stays usable.
              disabled={connecting}
              value={idField}
              onChange={(e) => setIdField(e.target.value)}
              placeholder={connectType === "slack" ? "Channel ID (e.g. C0123456)" : "File key"}
              className="min-h-11 w-full rounded-xl border border-[var(--field-border)] bg-[var(--field-background)] px-4 py-2.5 text-sm text-fg hover:border-[var(--field-border-hover)] focus-visible:border-[var(--field-border-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info placeholder:text-[var(--field-placeholder)]"
            />
            <input
              // Locked while a connect is in flight, so its answer is about what is on screen; Cancel stays usable.
              disabled={connecting}
              value={nameField}
              onChange={(e) => setNameField(e.target.value)}
              placeholder={connectType === "slack" ? "Channel name (e.g. #general)" : "File name"}
              className="min-h-11 w-full rounded-xl border border-[var(--field-border)] bg-[var(--field-background)] px-4 py-2.5 text-sm text-fg hover:border-[var(--field-border-hover)] focus-visible:border-[var(--field-border-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info placeholder:text-[var(--field-placeholder)]"
            />
            <input
              // Locked while a connect is in flight, so its answer is about what is on screen; Cancel stays usable.
              disabled={connecting}
              type="password"
              autoComplete="off"
              value={tokenField}
              onChange={(e) => setTokenField(e.target.value)}
              placeholder={
                connectType === "slack"
                  ? "Bot token (not required in dev; required in production)"
                  : "Personal access token (not required in dev; required in production)"
              }
              className="min-h-11 w-full rounded-xl border border-[var(--field-border)] bg-[var(--field-background)] px-4 py-2.5 text-sm text-fg hover:border-[var(--field-border-hover)] focus-visible:border-[var(--field-border-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info placeholder:text-[var(--field-placeholder)]"
            />
            <div className="mt-1 flex items-center gap-2">
              <Button
                ref={connectButton}
                variant="secondary"
                size="sm"
                onClick={() => connect(connectType)}
                disabled={connecting || !idField.trim() || !nameField.trim()}
              >
                {connecting ? "Connecting…" : "Connect"}
              </Button>
              <button
                onClick={cancelConnect}
                className="px-3 py-1.5 text-sm text-fg-subtle hover:text-fg transition-colors"
              >
                Cancel
              </button>
            </div>
          </fieldset>
        ) : (
          <div className="flex flex-wrap gap-3">
            {CONNECTOR_SOURCE_TYPES.map((t) => (
              <Button key={t} variant="secondary" size="sm" onClick={() => setConnectType(t)}>
                <span className="inline-flex items-center gap-2">
                  <ConnectorLogo type={t} className="h-4 w-4 text-info" />+ Connect {SOURCE_TYPE_LABEL[t]}
                </span>
              </Button>
            ))}
          </div>
        )}
        {connectType !== null && connectType !== "github" && connectError && (
          <div className="mt-3">
            <ConnectError message={connectError} />
          </div>
        )}
        {connectType !== null && connectType !== "github" && wideningQuestion && (
          <div className="mt-3">{wideningQuestion}</div>
        )}
      </div>
    </Card>
  );
}
