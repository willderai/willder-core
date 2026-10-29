"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Globe, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { Card, Button, Pill } from "@/components/ui";
import { ConnectorLogo } from "@/components/connector-logo";
import { SOURCE_REQUEST_TIMEOUT_MS, sourceFailureMessage, sourceRequest, useUnmountSignal } from "./source-requests";
import {
  ConnectError,
  confirmedBody,
  connectSource,
  WideningConfirm,
  type ConnectedSource,
  type PendingWidening,
} from "./widening-confirm";
import { DisconnectConfirm } from "./disconnect-confirm";
import { GitHubConnectForm } from "./github-connect-form";
import { RemainingRecords } from "./remaining-records";
import { removedSummary, WHAT_WE_STORE } from "./connector-data";
import { announceSourcesChanged, showsNotice, useSourcesChanged, type SourcesNotice } from "./sources-changed";
import { ListControls, ListNoMatch } from "@/components/list-controls/list-controls";
import { listViewKey } from "@/components/list-controls/list-page";
import {
  compareText,
  compareTime,
  defaultListState,
  isNarrowed,
  showsListControls,
  type ListConfig,
} from "@/components/list-controls/list-query";
import { useListState } from "@/components/list-controls/use-list-state";
import { listPageUrl, pageToShow, useServerPage } from "@/components/list-controls/use-server-page";
import { ServerListPagination } from "@/components/list-controls/server-list-pagination";
import { MAX_ACCESS_PAGE } from "@/lib/access-lists";
import { listSearchText } from "@/lib/list-search";
import { SOURCE_TYPE_LABEL as TYPE_LABEL, type SourceType } from "@/lib/source-lists";

const PANEL = "Knowledge sources";

// Google API / Picker types (loaded via script tag, not npm).
declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(config: {
            client_id: string;
            scope: string;
            callback: (resp: { access_token?: string; error?: string; error_description?: string }) => void;
            // Called instead of `callback` when the popup is blocked or closed.
            error_callback?: (err: { type: string; message?: string }) => void;
          }): { requestAccessToken(): void };
        };
      };
    };
    gapi?: {
      load(
        lib: string,
        config:
          | (() => void)
          | {
              callback: () => void;
              onerror: () => void;
              timeout: number;
              ontimeout: () => void;
            },
      ): void;
      picker: {
        PickerBuilder: new () => PickerBuilder;
        Feature: { MULTISELECT_ENABLED: string };
        ViewId: { FOLDERS: string };
        DocsView: new (viewId: string) => DocsView;
        Action: { PICKED: string; CANCEL: string; LOADED?: string; ERROR?: string };
      };
    };
  }
  interface PickerBuilder {
    addView(v: DocsView): PickerBuilder;
    setOAuthToken(t: string): PickerBuilder;
    setDeveloperKey(k: string): PickerBuilder;
    setAppId(id: string): PickerBuilder;
    setCallback(cb: (data: PickerResponse) => void): PickerBuilder;
    enableFeature(f: string): PickerBuilder;
    build(): { setVisible(v: boolean): void };
  }
  interface DocsView {
    setSelectFolderEnabled(v: boolean): DocsView;
    setIncludeFolders(v: boolean): DocsView;
    setMimeTypes(m: string): DocsView;
  }
  interface PickerResponse {
    action: string;
    docs?: { id: string; name: string }[];
  }
}

type Source = {
  id: string;
  type: SourceType;
  name: string;
  scopePath: string;
  status: "active" | "syncing" | "error" | "disconnected";
  meta: Record<string, unknown> | null;
  createdAt: string;
  /** When the row last changed; GET /api/sources sends it. */
  updatedAt?: string;
  _count: { files: number };
};

/**
 * The list's row, or the just-connected card's read of the same source when that read
 * is at least as recent, so the list card follows a sync the card is watching and a
 * failed or older read never covers a fresher list.
 */
function newerRow(listed: Source, followed: Source | null): Source {
  if (followed === null || followed.id !== listed.id) return listed;
  return metaTime(followed.updatedAt) >= metaTime(listed.updatedAt) ? followed : listed;
}

const GDRIVE_MOCK = process.env.NEXT_PUBLIC_GDRIVE_MOCK !== "false";
const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";
const API_KEY = process.env.NEXT_PUBLIC_GOOGLE_API_KEY ?? "";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

/**
 * The Google Cloud project number, which the Picker needs as its app ID: under
 * the `drive.file` scope, Google grants the app a picked item through the
 * Picker's app ID, so a Picker without one may grant nothing. An OAuth client
 * ID starts with that number
 * (`<project number>-<suffix>.apps.googleusercontent.com`). Null when it does not.
 */
function projectNumberFromClientId(clientId: string): string | null {
  return /^(\d+)-/.exec(clientId)?.[1] ?? null;
}

/**
 * How long a Drive connect may wait for Google before the button gives up.
 * Sign-in can involve a password and a second factor, so the bound is generous;
 * it stops when the folder picker opens, because from then the person decides.
 */
const CONNECT_TIMEOUT_MS = 5 * 60_000;

/** The connectors this panel connects. Each keeps its own widening question. */
type Connector = "github" | "gdrive";
const connectorOf = (body: Record<string, unknown>): Connector => (body.type === "github" ? "github" : "gdrive");

/** A readable reason for a Google sign-in popup that ended without a token. */
function popupErrorMessage(err: { type: string; message?: string }): string {
  if (err.type === "popup_failed_to_open") {
    return "Your browser blocked the Google sign-in popup. Allow popups for this site, then try again.";
  }
  if (err.type === "popup_closed") return "Google sign-in was closed before it finished, so nothing was connected.";
  return `Google sign-in failed (${err.message ?? err.type}).`;
}

/** A readable reason for a token response that carries an error instead of a token. */
function tokenErrorMessage(resp: { error?: string; error_description?: string }): string {
  if (resp.error === "access_denied") return "Google Drive access was not granted, so nothing was connected.";
  return `Google sign-in failed: ${resp.error_description ?? resp.error ?? "no access token was returned"}.`;
}

/** Google libraries throw Errors, strings, or `{ error, details }` objects; say what each one says. */
function describeGoogleError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

let pickerLibrary: Promise<void> | null = null;

/** Loads Google's Picker library once, and rejects with a reason rather than never settling. */
function loadPickerLibrary(): Promise<void> {
  pickerLibrary ??= new Promise<void>((resolve, reject) => {
    const gapi = window.gapi;
    if (!gapi) {
      reject(new Error("The Google API script (apis.google.com/js/api.js) has not loaded. Reload the page."));
      return;
    }
    gapi.load("picker", {
      callback: () =>
        window.gapi?.picker
          ? resolve()
          : reject(new Error("Google's Picker library loaded, but the picker API is missing.")),
      onerror: () =>
        reject(new Error("Google's Picker library failed to load. Check the network and the Content-Security-Policy.")),
      timeout: 20_000,
      ontimeout: () => reject(new Error("Google's Picker library did not load within 20 seconds.")),
    });
  }).catch((e: unknown) => {
    pickerLibrary = null; // let the next attempt retry instead of replaying the failure
    throw e;
  });
  return pickerLibrary;
}

/** Milliseconds since the epoch of an ISO time in `meta`, or NaN. */
function metaTime(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : NaN;
}

/**
 * True when a connect or reconnect asked for a sync and none has finished
 * since. The source still reads `active` then, and its last result is the one before,
 * so without this a reconnected source showed "Connected" and the old counts while
 * its memory was not there yet.
 */
function syncQueued(source: Source): boolean {
  if (source.status !== "active") return false;
  const requested = metaTime(source.meta?.syncRequestedAt);
  if (Number.isNaN(requested)) return false;
  const last = metaTime(source.meta?.lastSyncAt);
  return Number.isNaN(last) || requested > last;
}

/** True when the last sync could not read the source at all (`endAccessLost` in lib/inngest/connector-sync.ts). */
function lostAccess(source: Source): boolean {
  return source.status === "error" && source.meta?.accessLost === true;
}

function statusPill(source: Source) {
  if (source.status === "disconnected") return <Pill dot="marble">Disconnected</Pill>;
  if (source.status === "syncing") return <Pill dot="ember">Syncing</Pill>;
  if (syncQueued(source)) return <Pill dot="ember">Sync queued</Pill>;
  if (lostAccess(source)) return <Pill dot="brick">Access lost</Pill>;
  if (source.status === "error") return <Pill dot="brick">Needs attention</Pill>;
  if (typeof source.meta?.failed === "number" && source.meta.failed > 0) return <Pill dot="brick">Partial sync</Pill>;
  if (driveSyncFoundNothing(source)) return <Pill dot="brick">No files synced</Pill>;
  return <Pill dot="gold">Connected</Pill>;
}

/**
 * Parts of a GitHub repository a sync reads, with the token permission each
 * needs. `meta.unreadable` names the parts GitHub refused the last sync. A
 * comment or review follows the issue or pull request it is on, so a refused
 * parent's label says they were skipped with it; comments and reviews are
 * named on their own only when GitHub refused them while their parent was read.
 */
const GITHUB_PART: Record<string, { label: string; permission: string }> = {
  readme: { label: "README", permission: "Contents" },
  issues: { label: "issues with their comments", permission: "Issues" },
  pulls: { label: "pull requests with their comments and reviews", permission: "Pull requests" },
  commits: { label: "commits", permission: "Contents" },
  comments: { label: "issue comments", permission: "Issues" },
  reviews: { label: "pull request reviews", permission: "Pull requests" },
  files: { label: "docs and file tree", permission: "Contents" },
};

/**
 * What the last sync skipped because the token may not read it, and the
 * permission that fixes it. Null when nothing was skipped.
 */
function unreadableNotice(unreadable: unknown): { parts: string; fix: string } | null {
  if (!Array.isArray(unreadable)) return null;
  const kinds = unreadable.filter((k): k is string => typeof k === "string");
  if (kinds.length === 0) return null;
  const parts = kinds.map((k) => GITHUB_PART[k]?.label ?? k).join(", ");
  const permissions = [...new Set(kinds.map((k) => GITHUB_PART[k]?.permission).filter(Boolean))];
  const fix =
    permissions.length > 0
      ? `Give the token ${permissions.join(" and ")} read access, then sync.`
      : "Give the token read access to them, then sync.";
  return { parts, fix };
}

/**
 * True when the last Drive sync finished and listed no file it could read.
 * Under the `drive.file` scope a picked folder may not grant the files inside
 * it, and Google answers that with an empty listing rather than an error, so
 * an empty folder, a folder of unsupported types and an ungranted folder all
 * look the same here. Each must be said, never shown as a clean "0 synced".
 */
function driveSyncFoundNothing(source: Source): boolean {
  const meta = source.meta;
  return (
    source.type === "gdrive" &&
    source.status === "active" &&
    typeof meta?.lastSyncAt === "string" &&
    meta.fileCount === 0
  );
}

const STATUS_LABEL: Record<Source["status"], string> = {
  active: "Active",
  syncing: "Syncing",
  error: "Needs attention",
  disconnected: "Disconnected",
};

/**
 * How the sources list searches, filters and orders; its view lives under `sources.` in
 * the URL. The server does the work a page at a time (GET /api/sources,
 * lib/source-lists.ts), so the sorts and filters name what that route accepts.
 */
const SOURCE_LIST: ListConfig<Source> = {
  noun: { one: "source", many: "sources" },
  searchText: (s) => [s.name, s.scopePath, TYPE_LABEL[s.type]],
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
    {
      key: "scope",
      label: "Destination scope",
      compare: (a, b) => compareText(a.scopePath, b.scopePath),
      directionLabels: { asc: "A–Z", desc: "Z–A" },
    },
  ],
  filters: [
    {
      key: "type",
      label: "Type",
      options: (Object.keys(TYPE_LABEL) as SourceType[]).map((t) => ({ value: t, label: TYPE_LABEL[t] })),
      matches: (s, type) => s.type === type,
    },
    {
      key: "status",
      label: "Status",
      options: (Object.keys(STATUS_LABEL) as Source["status"][]).map((st) => ({ value: st, label: STATUS_LABEL[st] })),
      matches: (s, status) => s.status === status,
    },
  ],
  paramPrefix: "sources.",
};

function syncDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

/** What the just-connected card says when it takes focus: the source, its scope and its status. */
function justConnectedLabel({ row, answered }: JustConnected): string {
  const name = row?.name ?? answered?.name;
  const scope = row?.scopePath ?? answered?.scopePath;
  if (!name || !scope) return "The source just connected";
  const status =
    row === null
      ? "status loading"
      : row.status === "disconnected"
        ? "disconnected"
        : row.status === "syncing"
          ? "syncing"
          : syncQueued(row)
            ? "sync queued"
            : row.status === "error"
              ? "needs attention"
              : "connected";
  return `${name}, scope ${scope}, ${status}`;
}

/** How often a just-connected source's card reads its status while a sync is queued or running. */
const FOLLOW_SYNC_MS = 10_000;
/** How many of those reads, about 15 minutes; after that, Refresh status reads it. */
const FOLLOW_SYNC_READS = 90;

/** The source this panel just connected: what the connect answered, then its full row once read. */
type JustConnected = {
  id: string;
  answered: ConnectedSource | null;
  row: Source | null;
  /** Why the last read of its row failed, naming the fix; null once a read succeeds. */
  readError: string | null;
};

export function SourcesPanel() {
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState<Source | null>(null);
  const [githubFormOpen, setGithubFormOpen] = useState(false);
  /** A GitHub connect is in flight. Kept apart from Drive's `connecting`, so closing the form ends only its own wait. */
  const [githubBusy, setGithubBusy] = useState(false);
  /**
   * Bumped by each GitHub connect and by closing its form. An answer to a connect the
   * person walked away from changes no form: a success still pins the source (it did
   * connect), a refusal or a question is dropped.
   */
  const githubRun = useRef(0);
  const driveButton = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string | null>(null);
  /** Why the last GitHub connect was refused, shown inside its form. */
  const [githubError, setGithubError] = useState<string | null>(null);
  const [justConnected, setJustConnected] = useState<JustConnected | null>(null);
  /**
   * The widening question each connector's last connect asked, kept apart so starting a
   * GitHub connect does not drop a Drive question still waiting for an answer, or the reverse.
   */
  const [pending, setPending] = useState<Partial<Record<Connector, PendingWidening>>>({});
  const setPendingFor = (connector: Connector, question: PendingWidening | null) =>
    setPending((p) => ({ ...p, [connector]: question ?? undefined }));
  const panelSignal = useUnmountSignal();
  const [notice, setNotice] = useState<SourcesNotice | null>(null);
  // Each Drive connect attempt gets a number; callbacks from an attempt that
  // already ended (timed out or failed) are ignored.
  const connectAttempt = useRef(0);
  const connectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The same for a Drive sync's Google sign-in: each attempt has a number, and one
  // that gave up ignores a token that arrives later.
  const syncAttempt = useRef(0);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Bumped to read the current page again: Refresh status, a write here, or one in Connectors.
  const [revision, setRevision] = useState(0);
  const reload = () => setRevision((r) => r + 1);
  const listView = useListState(SOURCE_LIST);
  const committed = listView.committed;
  const list = useServerPage<Source>({
    prefix: SOURCE_LIST.paramPrefix!,
    maxPage: MAX_ACCESS_PAGE,
    rowsKey: "sources",
    viewKey: `${listSearchText(committed.query)}|${listViewKey(SOURCE_LIST, { ...committed, query: "" })}`,
    urlFor: (page) => listPageUrl("/api/sources", committed, page),
    searching: listSearchText(committed.query) !== "",
    revision,
  });
  const { fresh, shown } = pageToShow(list.state);
  const stale = shown !== null && fresh === null;
  const loadingList = (
    <div role="status" className="py-8 text-center text-sm text-fg-subtle">
      Loading sources…
    </div>
  );

  // When a sync or disconnect finishes, the button pressed is disabled or gone, so focus
  // would fall to the page: its message takes focus instead, once it is on screen.
  const [reportCount, setReportCount] = useState(0);
  const reportFocused = useRef(0);
  const reported = () => setReportCount((n) => n + 1);
  const errorLine = useRef<HTMLDivElement>(null);
  const noticeLine = useRef<HTMLParagraphElement>(null);
  const noticeShown = showsNotice(notice, list.state.status);
  useEffect(() => {
    if (reportCount === reportFocused.current) return;
    const target = errorLine.current ?? noticeLine.current;
    if (!target) return;
    reportFocused.current = reportCount;
    if (document.activeElement === null || document.activeElement === document.body) target.focus();
  }, [reportCount, error, noticeShown]);

  /** After this panel wrote a source: reload, and tell the Connectors panel to. */
  function reloadAfterWrite() {
    reload();
    announceSourcesChanged(PANEL);
  }

  useSourcesChanged(PANEL, (from) => {
    setNotice({ text: `Updated after a change in ${from}.`, kind: "changed-elsewhere" });
    reload();
  });

  // A link to one source (`/integrations#source-<id>`, from a fact's detail on the audit
  // page) names a card that may sit on any page. The server says which page holds it in
  // this view; that page opens, and the card is brought into view once it has rendered.
  // This happens once, so paging away afterwards is not pulled back to the linked card.
  const [linked, setLinked] = useState<{ id: string; shown: boolean } | null>(null);
  const { setPage } = list;
  const firstPageUrl = listPageUrl("/api/sources", committed, 1);
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.startsWith("#source-")) return;
    const id = decodeURIComponent(hash.slice("#source-".length));
    const controller = new AbortController();
    fetch(`${firstPageUrl}&at=${encodeURIComponent(id)}`, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { page?: number; found?: boolean } | null) => {
        if (!body?.found || typeof body.page !== "number") return;
        setLinked({ id, shown: false });
        setPage(body.page);
      })
      .catch(() => {});
    return () => controller.abort();
    // Read once, for the view the page opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!linked || linked.shown || list.state.status !== "ready") return;
    if (!list.state.data.rows.some((s) => s.id === linked.id)) return;
    document.getElementById(`source-${linked.id}`)?.closest("article")?.scrollIntoView({ block: "center" });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- marks the one-time scroll done
    setLinked({ ...linked, shown: true });
  }, [linked, list.state]);

  // The source just connected, read by id from the unfiltered list, whatever page,
  // search or sort is showing: a reconnect keeps its first connect date, so in the
  // default order it can sit pages down. Read again on every reload, and every
  // FOLLOW_SYNC_MS while its sync is queued or running, so its card says when
  // its memory is there.
  const [followRead, setFollowRead] = useState(0);
  const justConnectedId = justConnected?.id ?? null;
  useEffect(() => {
    if (justConnectedId === null) return;
    const controller = new AbortController();
    const url = `${listPageUrl("/api/sources", defaultListState(SOURCE_LIST), 1)}&at=${encodeURIComponent(justConnectedId)}`;
    const settle = (update: Pick<JustConnected, "row" | "readError"> | { readError: string }) =>
      setJustConnected((j) => (j?.id === justConnectedId ? { ...j, ...update } : j));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, SOURCE_REQUEST_TIMEOUT_MS);
    fetch(url, { signal: controller.signal })
      .then(async (res) => {
        if (res.status === 403) {
          return settle({
            readError:
              "Its sync status cannot be shown here: that needs write access to the whole organization. You can still ask its scope below.",
          });
        }
        if (!res.ok)
          return settle({
            readError: `Could not read its sync status (HTTP ${res.status}). Use Refresh status to try again.`,
          });
        const body = (await res.json()) as { sources?: Source[] };
        const row = body.sources?.find((s) => s.id === justConnectedId);
        if (!row)
          return settle({
            readError:
              "It is no longer in the sources list: it may have been disconnected or removed. Use Refresh status to check.",
          });
        settle({ row, readError: null });
      })
      .catch(() => {
        if (timedOut)
          settle({
            readError: `Its sync status did not load within ${SOURCE_REQUEST_TIMEOUT_MS / 1000} seconds. Use Refresh status to try again.`,
          });
        else if (!controller.signal.aborted)
          settle({ readError: "Could not reach Willder to read its sync status. Use Refresh status to try again." });
      })
      .finally(() => clearTimeout(timer));
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [justConnectedId, revision, followRead]);
  // The form the person clicked in closes on success, so the page moves under them; bring
  // the new card to where they are looking.
  // Focus moves to it too: the button that was clicked is gone, and a screen reader then
  // reads the source's name, scope and status.
  const justConnectedCard = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (justConnectedId === null) return;
    // Only when focus was lost with the closed form: a person already working elsewhere
    // (a form reopened after walking away from this connect) keeps their place.
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    justConnectedCard.current?.focus({ preventScroll: true });
    justConnectedCard.current?.scrollIntoView?.({ block: "start" });
  }, [justConnectedId]);
  const followRow = justConnected?.row ?? null;
  const following =
    followRow !== null && (followRow.status === "syncing" || syncQueued(followRow)) && followRead < FOLLOW_SYNC_READS;
  useEffect(() => {
    if (!following) return;
    const timer = setTimeout(() => setFollowRead((n) => n + 1), FOLLOW_SYNC_MS);
    return () => clearTimeout(timer);
    // `followRead` too: a read that fails leaves the row unchanged, and the next read must still come.
  }, [following, followRow, followRead]);

  useEffect(
    () => () => {
      if (connectTimer.current) clearTimeout(connectTimer.current);
      if (syncTimer.current) clearTimeout(syncTimer.current);
    },
    [],
  );

  function stopConnectTimer() {
    if (connectTimer.current) clearTimeout(connectTimer.current);
    connectTimer.current = null;
  }

  /** Ends the Drive connect attempt in progress and shows why. */
  function failConnect(message: string) {
    connectAttempt.current += 1;
    stopConnectTimer();
    setError(message);
    setConnecting(false);
    reported();
  }

  // Load Google API scripts lazily when the panel mounts.
  useEffect(() => {
    if (GDRIVE_MOCK || typeof window === "undefined") return;
    const loadScript = (src: string) =>
      new Promise<void>((res, rej) => {
        if (document.querySelector(`script[src="${src}"]`)) {
          res();
          return;
        }
        const s = document.createElement("script");
        s.src = src;
        s.async = true;
        s.onload = () => res();
        s.onerror = () =>
          rej(new Error(`Could not load ${src}. Check the Content-Security-Policy script-src allows it.`));
        document.head.appendChild(s);
      });
    Promise.all([loadScript("https://accounts.google.com/gsi/client"), loadScript("https://apis.google.com/js/api.js")])
      .then(() => {
        // Preload only; a failure here is reported by the connect attempt that needs it.
        loadPickerLibrary().catch(() => {});
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "Google scripts failed to load");
      });
  }, []);

  /** Connect, or hold the request for confirmation when it widens who reads the source. */
  async function connectOrAsk(body: Record<string, unknown>, run?: number) {
    const connector = connectorOf(body);
    setPendingFor(connector, null);
    const result = await connectSource(body, panelSignal());
    const walkedAway = run !== undefined && run !== githubRun.current;
    if (!result.connected) {
      if (!walkedAway) setPendingFor(connector, result.pending);
      return;
    }
    if (body.type === "github" && !walkedAway) setGithubFormOpen(false);
    const name =
      result.source?.name ?? (body.type === "github" ? String(body.repo) : String(body.folderName ?? "The source"));
    setNotice({
      text: `${name} connected. Its card under Just connected shows its scope and its sync status.`,
      kind: "write",
    });
    if (result.sourceId !== null) {
      setFollowRead(0);
      setJustConnected({ id: result.sourceId, answered: result.source, row: null, readError: null });
    }
    reloadAfterWrite();
  }

  /** Sends a GitHub connect (or its confirmation) for the form; see `githubRun`. */
  async function sendGitHub(body: Record<string, unknown>) {
    const run = ++githubRun.current;
    setGithubBusy(true);
    setError(null);
    setGithubError(null);
    setNotice(null);
    try {
      await connectOrAsk(body, run);
    } catch (e) {
      if (run === githubRun.current) setGithubError(e instanceof Error ? e.message : "The connect failed. Try again.");
    } finally {
      if (run === githubRun.current) setGithubBusy(false);
    }
  }

  function closeGitHubForm() {
    githubRun.current += 1;
    setGithubBusy(false);
    setGithubFormOpen(false);
    setGithubError(null);
    setPendingFor("github", null);
  }

  async function confirmWidening(question: PendingWidening) {
    if (connectorOf(question.body) === "github") return sendGitHub(confirmedBody(question));
    setConnecting(true);
    setError(null);
    try {
      await connectOrAsk(confirmedBody(question));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The connect failed. Try again.");
      reported();
    } finally {
      setConnecting(false);
    }
  }

  /** One connector's widening question, shown where its connect was clicked. */
  const questionFor = (connector: Connector, question: PendingWidening) => (
    <WideningConfirm
      pending={question}
      what={connector === "github" ? "this repository" : "these files"}
      busy={connector === "github" ? githubBusy : connecting}
      onConfirm={() => void confirmWidening(question)}
      onCancel={() => {
        setPendingFor(connector, null);
        // The question held focus; a Drive question gives it back to the Drive button.
        if (connector === "gdrive") driveButton.current?.focus();
      }}
    />
  );
  const githubQuestion = pending.github ? questionFor("github", pending.github) : null;
  const driveQuestion = pending.gdrive ? questionFor("gdrive", pending.gdrive) : null;

  async function openPicker() {
    setConnecting(true);
    setError(null);

    // MOCK: skip real Picker, use a fake folder.
    if (GDRIVE_MOCK) {
      try {
        await connectOrAsk({
          type: "gdrive",
          folderId: `mock_folder_${Date.now()}`,
          folderName: "Mock Sales Collateral",
          token: "mock_token",
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "The connect failed. Try again.");
        reported();
      } finally {
        setConnecting(false);
      }
      return;
    }

    if (!CLIENT_ID || !API_KEY) {
      setError("NEXT_PUBLIC_GOOGLE_CLIENT_ID and NEXT_PUBLIC_GOOGLE_API_KEY are required");
      setConnecting(false);
      return;
    }

    // Real: get a GIS token then open the Drive Picker.
    if (!window.google?.accounts?.oauth2 || !window.gapi) {
      setError(
        "Google sign-in scripts have not loaded. Reload the page; if it persists, the site's Content-Security-Policy is blocking accounts.google.com or apis.google.com.",
      );
      setConnecting(false);
      return;
    }
    const projectNumber = projectNumberFromClientId(CLIENT_ID);
    if (!projectNumber) {
      setError(
        "NEXT_PUBLIC_GOOGLE_CLIENT_ID is not a Google OAuth client ID (<project number>-<suffix>.apps.googleusercontent.com), so the Drive picker cannot grant Willder the folder.",
      );
      setConnecting(false);
      return;
    }
    const attempt = ++connectAttempt.current;
    stopConnectTimer();
    connectTimer.current = setTimeout(
      () => failConnect("Google did not respond within 5 minutes, so the connection attempt was stopped. Try again."),
      CONNECT_TIMEOUT_MS,
    );
    const tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: DRIVE_SCOPE,
      error_callback: (err) => {
        if (attempt === connectAttempt.current) failConnect(popupErrorMessage(err));
      },
      callback: (resp) =>
        void (async () => {
          if (attempt !== connectAttempt.current) return;
          if (resp.error || !resp.access_token) {
            failConnect(tokenErrorMessage(resp));
            return;
          }
          const token = resp.access_token;
          // The Picker takes the token itself (setOAuthToken below). gapi.client is
          // never loaded on this page, so touching it threw and hung the button.
          await loadPickerLibrary();
          if (attempt !== connectAttempt.current) return;

          const picker = new window.gapi!.picker.PickerBuilder()
            .addView(
              new window.gapi!.picker.DocsView(window.gapi!.picker.ViewId.FOLDERS)
                .setSelectFolderEnabled(true)
                .setIncludeFolders(true),
            )
            .setOAuthToken(token)
            .setDeveloperKey(API_KEY)
            .setAppId(projectNumber)
            .setCallback(async (data) => {
              const actions = window.gapi!.picker.Action;
              // The picker is open: from here the person, not a timer, ends the attempt.
              if (data.action === (actions.LOADED ?? "loaded")) {
                stopConnectTimer();
                return;
              }
              if (data.action === (actions.ERROR ?? "error")) {
                failConnect(
                  "The Google Drive picker reported an error. Check that the Picker API is enabled for this site's Google API key.",
                );
                return;
              }
              if (data.action === actions.CANCEL) {
                stopConnectTimer();
                setConnecting(false);
                return;
              }
              if (data.action !== actions.PICKED) return;
              stopConnectTimer();
              const folder = data.docs?.[0];
              if (!folder) {
                setConnecting(false);
                return;
              }
              try {
                await connectOrAsk({ type: "gdrive", folderId: folder.id, folderName: folder.name, token });
              } catch (e) {
                setError(e instanceof Error ? e.message : "The connect failed. Try again.");
                reported();
              } finally {
                setConnecting(false);
              }
            })
            .build();
          picker.setVisible(true);
        })().catch((e: unknown) => {
          if (attempt === connectAttempt.current) {
            failConnect(`Could not open the Google Drive picker: ${describeGoogleError(e)}`);
          }
        }),
    });
    tokenClient.requestAccessToken();
  }

  async function resync(source: Source) {
    setSyncing(source.id);
    setError(null);
    setNotice(null);

    // Slack/figma/posthog have no OAuth flow yet, so there is no client-side
    // token to collect here — the request carries none, and the sync route
    // falls back to the token stored at connect time (slack/figma) or reads
    // its own stored key directly (posthog). Only gdrive's short-lived OAuth
    // token has to be re-issued client-side on every sync.
    if (source.type !== "gdrive") {
      try {
        const answer = await sourceRequest("sync", `/api/sources/${source.id}/sync`, {
          method: "POST",
          signal: panelSignal(),
        });
        if (!answer.ok) throw new Error(sourceFailureMessage("sync", answer));
        setNotice({ text: `Sync requested for ${source.name}. Refresh status to check the result.`, kind: "write" });
        reloadAfterWrite();
      } catch (e) {
        setError(e instanceof Error ? e.message : "error");
      } finally {
        setSyncing(null);
        reported();
      }
      return;
    }

    if (GDRIVE_MOCK) {
      try {
        const answer = await sourceRequest("sync", `/api/sources/${source.id}/sync`, {
          signal: panelSignal(),
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: "mock_token" }),
        });
        if (!answer.ok) throw new Error(sourceFailureMessage("sync", answer));
        setNotice({ text: `Sync requested for ${source.name}. Refresh status to check the result.`, kind: "write" });
        reloadAfterWrite();
      } catch (e) {
        setError(e instanceof Error ? e.message : "error");
      } finally {
        setSyncing(null);
        reported();
      }
      return;
    }

    // Real: re-issue a GIS token then POST to sync.
    if (!CLIENT_ID || !window.google?.accounts?.oauth2) {
      setError("Google sign-in is not ready. Reload this page before syncing your Drive folder.");
      setSyncing(null);
      return;
    }
    // Google may never call back (a popup left open, a lost window); every Sync button
    // stays disabled while one is in flight, so this attempt gives up on the same bound
    // as a Drive connect.
    const attempt = ++syncAttempt.current;
    const endAttempt = () => {
      if (attempt !== syncAttempt.current) return false;
      syncAttempt.current += 1;
      if (syncTimer.current) clearTimeout(syncTimer.current);
      syncTimer.current = null;
      return true;
    };
    syncTimer.current = setTimeout(() => {
      if (!endAttempt()) return;
      setError("Google did not respond within 5 minutes, so no sync was requested. Try again.");
      setSyncing(null);
      reported();
    }, CONNECT_TIMEOUT_MS);
    const tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: DRIVE_SCOPE,
      error_callback: (err) => {
        if (!endAttempt()) return;
        setError(popupErrorMessage(err));
        setSyncing(null);
        reported();
      },
      callback: async (resp) => {
        if (!endAttempt()) return;
        if (resp.error || !resp.access_token) {
          setError(tokenErrorMessage(resp));
          setSyncing(null);
          reported();
          return;
        }
        try {
          const answer = await sourceRequest("sync", `/api/sources/${source.id}/sync`, {
            signal: panelSignal(),
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token: resp.access_token }),
          });
          if (!answer.ok) throw new Error(sourceFailureMessage("sync", answer));
          setNotice({ text: `Sync requested for ${source.name}. Refresh status to check the result.`, kind: "write" });
          reloadAfterWrite();
        } catch (e) {
          setError(e instanceof Error ? e.message : "error");
        } finally {
          setSyncing(null);
          reported();
        }
      },
    });
    tokenClient.requestAccessToken();
  }

  /** Disconnect a source, or remove again what a disconnected one still holds; both are the same DELETE. */
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
      setError(e instanceof Error ? e.message : "disconnect failed");
    } finally {
      setDisconnecting(null);
      reported();
    }
  }

  /**
   * One source's card. `idPrefix` keeps the ids of a second copy (Just connected)
   * apart from the list's, which `/integrations#source-<id>` links scroll to.
   */
  function sourceCard(s: Source, idPrefix = "") {
    const meta = s.meta ?? {};
    // lastSyncAt is written for failed runs too. Never present it as
    // successful sync time, or substitute the source row's updatedAt.
    const lastSync = syncDate(meta.lastSyncAt);
    // A run that lost access read nothing: any counts or skipped parts still on
    // the row are an earlier run's, so they are not shown as its result.
    const accessLost = lostAccess(s);
    const counts = accessLost
      ? ""
      : [
          typeof meta.synced === "number" ? `${meta.synced} synced` : null,
          typeof meta.skipped === "number" ? `${meta.skipped} unchanged` : null,
          typeof meta.failed === "number" && meta.failed > 0 ? `${meta.failed} failed` : null,
        ]
          .filter(Boolean)
          .join(" · ");
    // A disconnected source syncs nothing, so what it once skipped is not news.
    const skippedParts = s.status === "disconnected" || accessLost ? null : unreadableNotice(meta.unreadable);
    // While a sync is queued or running, the counts above belong to the one before it.
    const pendingSync = s.status === "syncing" || syncQueued(s);
    const requestedAt = syncDate(meta.syncRequestedAt);
    return (
      <article
        key={s.id}
        aria-labelledby={`${idPrefix}source-${s.id}`}
        className="min-w-0 rounded-xl border border-divider bg-fg/[0.02] px-3 py-3 sm:px-5 sm:py-4"
      >
        <div className="grid min-w-0 gap-3 sm:gap-5 lg:grid-cols-[1fr_1fr_1fr]">
          <div className="flex min-w-0 items-start gap-2 sm:gap-3">
            <div
              aria-hidden="true"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-info/15 bg-info/10 text-info sm:h-9 sm:w-9"
            >
              {s.type === "website" ? (
                <Globe className="h-4 w-4" />
              ) : (
                <ConnectorLogo type={s.type} className="h-4 w-4" />
              )}
            </div>
            <div className="min-w-0">
              <p className="text-sm text-fg-subtle">{TYPE_LABEL[s.type]}</p>
              <h3 id={`${idPrefix}source-${s.id}`} className="mt-1 break-words font-medium text-fg">
                {s.name}
              </h3>
              <p className="mt-1 text-sm text-fg-subtle">
                {s._count.files} tracked file{s._count.files !== 1 ? "s" : ""}
              </p>
              <p className="mt-1.5 text-sm leading-relaxed text-fg-subtle">{WHAT_WE_STORE[s.type]}</p>
            </div>
          </div>
          <div className="min-w-0">
            <p className="text-sm text-fg-subtle">Destination scope</p>
            <p className="mt-1.5 break-all font-mono text-xs leading-relaxed text-fg">{s.scopePath}</p>
            <p className="mt-1.5 text-sm text-fg-subtle">Access follows this scope&apos;s permissions.</p>
          </div>
          <div className="min-w-0">
            {statusPill(s)}
            {pendingSync && (
              <p className="mt-2 text-sm text-fg">
                {s.status === "syncing" ? "Syncing now." : `Sync requested${requestedAt ? ` · ${requestedAt}` : ""}.`}{" "}
                Ask this scope after it finishes.
              </p>
            )}
            <p className="mt-2 text-sm text-fg-muted">
              {lastSync
                ? pendingSync
                  ? `Previous sync attempt · ${lastSync}`
                  : `Last sync attempt · ${lastSync}`
                : pendingSync
                  ? "No earlier sync result"
                  : "No sync result recorded"}
            </p>
            {lastSync && counts && <p className="mt-1 text-sm text-fg-muted">{counts}</p>}
            {s.type === "website" && (
              <p className="mt-1 text-sm text-fg-subtle">Website re-sync is not available here.</p>
            )}
            {s.status === "error" && typeof meta.error === "string" && (
              <p className="mt-2 break-words text-sm leading-relaxed text-danger">{meta.error}</p>
            )}
            {driveSyncFoundNothing(s) && (
              <p className="mt-2 flex items-start gap-1.5 break-words text-sm leading-relaxed text-warning">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>
                  Nothing from this folder is in memory. Google Drive returned no file Willder can read: it reads PDF,
                  Word, Google Docs, Slides, Sheets and image files, and only files Google has granted it, which may not
                  include the files inside a picked folder.
                </span>
              </p>
            )}
            {s.status === "disconnected" && s.type !== "website" && (
              <RemainingRecords sourceId={s.id} removing={disconnecting === s.id} onRemoveAgain={() => disconnect(s)} />
            )}
            {skippedParts && (
              <p className="mt-2 flex items-start gap-1.5 break-words text-sm leading-relaxed text-warning">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>
                  Not synced: {skippedParts.parts}. The token cannot read them. {skippedParts.fix}
                </span>
              </p>
            )}
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-divider pt-3 text-sm">
          <Link
            href={`/memory?scope=${encodeURIComponent(s.scopePath)}`}
            className="inline-flex min-h-9 items-center gap-1.5 font-medium text-info"
          >
            Ask this scope <ArrowUpRight size={13} aria-hidden="true" />
          </Link>
          <Link
            href={`/audit?view=timeline&scope=${encodeURIComponent(s.scopePath)}`}
            className="inline-flex min-h-9 items-center gap-1.5 text-fg-muted hover:text-fg"
          >
            View scope changes <ArrowUpRight size={13} aria-hidden="true" />
          </Link>
          {s.type !== "website" && s.status !== "disconnected" && (
            <button
              onClick={() => resync(s)}
              disabled={syncing !== null || s.status === "syncing"}
              className="min-h-9 font-medium text-fg-muted transition-colors hover:text-info disabled:opacity-40 sm:ml-auto"
            >
              {syncing === s.id ? "Requesting…" : "Sync"}
            </button>
          )}
          {s.status !== "disconnected" && (
            <button
              aria-disabled={stale}
              onClick={() => {
                if (!stale) setConfirmingDisconnect(s);
              }}
              disabled={disconnecting === s.id}
              className="min-h-9 text-fg-subtle transition-colors hover:text-danger disabled:opacity-40"
            >
              {disconnecting === s.id ? "Disconnecting…" : "Disconnect"}
            </button>
          )}
        </div>
      </article>
    );
  }

  return (
    <Card className="p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3 sm:mb-5 sm:gap-4">
        <div className="max-w-xl">
          <h2 className="text-base font-semibold text-fg sm:text-lg">Knowledge sources</h2>
          <p className="mt-1 text-sm leading-relaxed text-fg-muted">
            <span className="sm:hidden">Follow sources into scoped memory.</span>
            <span className="hidden sm:inline">
              See where each source lands, check its sync result, and follow its changes into memory.
            </span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            aria-label={stale ? "Refreshing…" : "Refresh status"}
            title="Refresh status"
            className="max-sm:w-9 max-sm:p-0"
            onClick={() => {
              if (list.state.status === "loading") return;
              setNotice(null);
              reload();
            }}
            aria-disabled={list.state.status === "loading"}
          >
            <RefreshCw
              size={14}
              aria-hidden="true"
              className={`sm:mr-2 ${stale ? "animate-spin motion-reduce:animate-none" : ""}`}
            />
            <span className="hidden sm:inline">{stale ? "Refreshing…" : "Refresh status"}</span>
          </Button>
          <Button
            variant="secondary"
            size="sm"
            aria-label="+ Connect GitHub repository"
            className="max-sm:px-3"
            onClick={() => setGithubFormOpen(true)}
            disabled={githubFormOpen}
          >
            <span className="sm:hidden">GitHub</span>
            <span className="hidden sm:inline">+ Connect GitHub repository</span>
          </Button>
          <Button
            ref={driveButton}
            variant="primary"
            size="sm"
            aria-label={connecting ? "Connecting…" : "+ Connect Drive folder"}
            className="max-sm:px-3"
            onClick={openPicker}
            disabled={connecting}
          >
            <span className="sm:hidden">{connecting ? "Connecting…" : "Connect Drive"}</span>
            <span className="hidden sm:inline">{connecting ? "Connecting…" : "+ Connect Drive folder"}</span>
          </Button>
        </div>
      </div>

      <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-info/20 bg-info/5 px-3 py-2.5 text-sm leading-relaxed text-fg-muted sm:mb-5 sm:px-4 sm:py-3">
        <ShieldCheck size={17} aria-hidden="true" className="mt-0.5 hidden shrink-0 text-info sm:block" />
        <p>
          Only people and agents with access to the destination scope can read this memory.{" "}
          <Link href="/access" className="font-medium text-info underline underline-offset-4">
            Review access
          </Link>
        </p>
      </div>

      {githubFormOpen && (
        <div className="mb-4">
          <GitHubConnectForm
            busy={githubBusy}
            onConnect={(body) => void sendGitHub(body)}
            onCancel={closeGitHubForm}
            error={githubError}
            confirmation={githubQuestion}
            onEdit={() => {
              setGithubError(null);
              setPendingFor("github", null);
            }}
          />
        </div>
      )}
      {confirmingDisconnect && (
        <DisconnectConfirm
          kind={confirmingDisconnect.type}
          name={confirmingDisconnect.name}
          busy={disconnecting === confirmingDisconnect.id}
          unavailable={fresh === null}
          onConfirm={() => void disconnect(confirmingDisconnect)}
          onCancel={() => setConfirmingDisconnect(null)}
        />
      )}
      {error && (
        <div ref={errorLine} tabIndex={-1} className="mb-4 outline-none">
          <ConnectError message={error} />
        </div>
      )}
      {driveQuestion && <div className="mb-4">{driveQuestion}</div>}
      {noticeShown && (
        <p ref={noticeLine} tabIndex={-1} role="status" className="mb-4 text-sm text-info outline-none">
          {notice.text}
        </p>
      )}
      {justConnected && (
        <section aria-label="Just connected" className="mb-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="text-eyebrow font-semibold uppercase text-fg-subtle">Just connected</p>
            <button
              type="button"
              onClick={() => setJustConnected(null)}
              className="min-h-9 text-sm text-fg-subtle transition-colors hover:text-fg"
            >
              Hide
            </button>
          </div>
          {justConnected.readError && (
            <p role="alert" className="mb-2 text-sm text-warning">
              {justConnected.readError}
            </p>
          )}
          <div
            ref={justConnectedCard}
            tabIndex={-1}
            role="group"
            aria-label={justConnectedLabel(justConnected)}
            className="scroll-mt-4 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info"
          >
            {justConnected.row
              ? sourceCard(justConnected.row, "just-connected-")
              : justConnected.answered && (
                  <article
                    aria-labelledby="just-connected-pending"
                    className="min-w-0 rounded-xl border border-divider bg-fg/[0.02] px-3 py-3 sm:px-5 sm:py-4"
                  >
                    <h3 id="just-connected-pending" className="break-words font-medium text-fg">
                      {justConnected.answered.name}
                    </h3>
                    <p className="mt-2 text-sm text-fg-subtle">Destination scope</p>
                    <p className="mt-1.5 break-all font-mono text-xs leading-relaxed text-fg">
                      {justConnected.answered.scopePath}
                    </p>
                    {!justConnected.readError && (
                      <p role="status" className="mt-2 text-sm text-fg-muted">
                        Reading its sync status…
                      </p>
                    )}
                    <Link
                      href={`/memory?scope=${encodeURIComponent(justConnected.answered.scopePath)}`}
                      className="mt-2 inline-flex min-h-9 items-center gap-1.5 text-sm font-medium text-info"
                    >
                      Ask this scope <ArrowUpRight size={13} aria-hidden="true" />
                    </Link>
                  </article>
                )}
          </div>
        </section>
      )}
      {list.state.status === "forbidden" ? (
        <p role="alert" className="py-8 text-center text-sm text-fg-subtle">
          Listing sources needs write access to the whole organization.
        </p>
      ) : list.state.status === "failed" ? (
        <div role="alert" className="mb-4 rounded-xl border border-danger/25 bg-danger/5 px-4 py-3 text-sm text-danger">
          <p>Could not load sources.</p>
          <p className="mt-1 text-fg-muted">Use Refresh status to try again.</p>
        </div>
      ) : !shown ? (
        loadingList
      ) : fresh?.count === 0 && !isNarrowed(committed) ? (
        <div className="rounded-xl border border-dashed border-divider bg-fg/[0.02] px-3 py-5 sm:px-5 sm:py-8">
          <p className="font-medium text-fg">Start with one source your agents need.</p>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-fg-muted">
            Connect a Drive folder, check its destination scope here, then ask a question in memory. Review access
            before inviting people or connecting agents.
          </p>
          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm">
            <Link href="/memory" className="inline-flex min-h-9 items-center gap-1.5 font-medium text-info">
              Open memory <ArrowUpRight size={14} aria-hidden="true" />
            </Link>
            <Link href="/docs/connect" className="inline-flex min-h-9 items-center gap-1.5 text-fg-muted hover:text-fg">
              Connection guide <ArrowUpRight size={14} aria-hidden="true" />
            </Link>
          </div>
          {GDRIVE_MOCK && (
            <p className="mt-4 text-sm text-fg-subtle">
              Demo mode: connecting Drive adds a sample folder, not your Google Drive data.
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {showsListControls(shown.count, listView.state) && (
            <ListControls
              config={SOURCE_LIST}
              controls={listView}
              total={shown.count}
              shown={stale ? null : shown.total}
            />
          )}
          {shown.rows.length === 0 &&
            (!fresh ? (
              loadingList
            ) : list.page > 1 ? (
              <p className="py-6 text-center text-sm text-fg-muted">
                This page is past the last source.{" "}
                <button type="button" onClick={() => list.setPage(1)} className="underline underline-offset-2">
                  Go to page 1
                </button>
              </p>
            ) : (
              <ListNoMatch config={SOURCE_LIST} controls={listView} />
            ))}
          <div aria-busy={stale} className={`flex flex-col gap-3 transition-opacity ${stale ? "opacity-60" : ""}`}>
            {shown.rows.map((s) => sourceCard(newerRow(s, followRow)))}
          </div>
          <ServerListPagination noun={SOURCE_LIST.noun} list={list} className="mt-1" />
        </div>
      )}
    </Card>
  );
}
