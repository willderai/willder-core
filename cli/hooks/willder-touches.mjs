// Claim touches: the files an agent edits, recorded on its claim from its own tool calls.
//
// Two agents on different tasks that edit the same file are told of each other through their
// claims (services/memory/claim-overlap.ts), but only if each claim says which files it edits,
// and an agent asked to write that down forgets or guesses. So this module writes it down for
// the agent: after each Edit, Write, MultiEdit or NotebookEdit call it adds the file to the
// session's list, and at most once a minute it sends the list as the `touches` of the agent's
// claim on its task (`memory_note`, kind claim, with the session's own WILLDER_TOKEN, so the
// write is checked and audited like any other). When the reply names another agent's claim
// that shares one of the files, that part of the reply is handed to the model.
//
// What is sent: each file's path from the repository root, as `file:<owner>/<name>/<path>`,
// with `<owner>/<name>` read from the `origin` remote in the repository's git config (so two
// worktrees or clones of one repository name a file the same way), or the root directory's name
// without one. Never a file's contents. A
// path outside the repository is left out, and so is any path redaction would change
// (willder-redact.mjs): a path with a secret in it is not sent at all, rather than sent scrubbed.
//
// It is off unless WILLDER_CLAIM_TOUCHES is "on" and the session names its task in
// WILLDER_TASK. The server records touches only for an org with claim overlap turned on; when
// it says it is off, or the token may not write, the session stops sending.
//
// Its state is one small file per session and task beside capture's, readable by its owner
// only: the files edited (at most MAX_TOUCHES, most recent last), each repository's name keyed
// by a digest of its root, and when the list was last sent. The server adds what each send
// names to the claim's files, so a send lost to two hooks running at once costs nothing.
//
// The one rule this file enforces: like the rest of the hook, it never gets in the agent's
// way. Every failure ends silently with nothing sent and nothing printed.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import {
  EDIT_TOOL_FIELDS,
  pathInRoot,
  printable,
  readState,
  redact,
  removeStaleState,
  repositoryRoot,
  saveState,
  stateDirUsable,
} from "./willder-capture.mjs";

/** The WILLDER_CLAIM_TOUCHES value that turns this on. */
export const TOUCHES_ENV_VALUE = "on";

/** The capture mark on the hook's memory_note calls (mcp/session-capture.ts, TOUCHES_CAPTURE). */
const TOUCHES_CAPTURE = "touches";

/** Most files sent; the server refuses more (services/memory/claim-overlap.ts, MAX_TOUCHES). */
export const MAX_TOUCHES = 64;

/** The least time between two sends. */
export const SEND_INTERVAL_MS = 60 * 1000;

/** How often an unchanged list is sent again, so the claim stays live while the agent keeps editing. */
export const RENEW_INTERVAL_MS = 10 * 60 * 1000;

/** How long one send may take: the same bound as the notice request it runs beside. */
const SEND_TIMEOUT_MS = 2000;

/** How the server's reply starts its overlap section (mcp/tools/memory-note.ts, OVERLAP_HEADING_START). */
const OVERLAP_HEADING = "Overlapping files detected with";

/** Whether the user turned claim touches on. */
export function touchesEnabled(env) {
  return env.WILLDER_CLAIM_TOUCHES?.trim() === TOUCHES_ENV_VALUE;
}

/**
 * The absolute path of the file a PostToolUse event's tool edited, or null when the tool does
 * not edit a file or names none.
 * @param {Record<string, any>} input
 * @param {string} cwd
 */
export function editedPath(input, cwd) {
  if (input?.hook_event_name !== "PostToolUse") return null;
  const field = Object.hasOwn(EDIT_TOOL_FIELDS, input.tool_name) ? EDIT_TOOL_FIELDS[input.tool_name] : undefined;
  const path = field ? input.tool_input?.[field] : undefined;
  if (typeof path !== "string" || path.trim() === "") return null;
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/**
 * `<owner>/<name>` from a git remote URL (`git@host:owner/name.git`, `https://host/owner/name`),
 * lowercased, or null when it does not end in two plain segments.
 * @param {string} url
 */
export function repositoryName(url) {
  const match = /[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

/**
 * The `origin` remote's URL from the repository's git config, or null without one. Read from
 * the file rather than by running git: no process on the agent's edit path. A worktree's `.git`
 * is a file naming its git directory, whose `commondir` leads to the shared config.
 * @param {string} root
 */
export function originUrl(root) {
  try {
    const dotGit = join(root, ".git");
    let gitDir = dotGit;
    if (!statSync(dotGit).isDirectory()) {
      const named = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"))?.[1];
      if (!named) return null;
      gitDir = resolve(root, named);
      const common = readOptional(join(gitDir, "commondir"))?.trim();
      if (common) gitDir = resolve(gitDir, common);
    }
    return remoteUrlIn(readFileSync(join(gitDir, "config"), "utf8"), "origin");
  } catch {
    return null;
  }
}

/**
 * The url of remote `name` in a git config file's text, read as git reads it: section and key
 * names in any case, a value in double quotes or bare, and a `;` or `#` comment after it
 * (outside quotes). Null when the remote or its url is not there.
 * @param {string} config
 * @param {string} name
 */
export function remoteUrlIn(config, name) {
  let inRemote = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    const section = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
    if (section) {
      inRemote = section[1].toLowerCase() === "remote" && section[2] === name;
      continue;
    }
    const entry = inRemote ? /^url\s*=\s*(.*)$/i.exec(line) : null;
    if (!entry) continue;
    let value = "";
    let quoted = false;
    for (const ch of entry[1]) {
      if (ch === '"') quoted = !quoted;
      else if (!quoted && (ch === ";" || ch === "#")) break;
      else value += ch;
    }
    return value.trim() || null;
  }
  return null;
}

function readOptional(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * The node id the server stores for `file` (a path from the repository root), or null when
 * redaction would change it or it has a "." or ".." segment.
 * @param {string} repo
 * @param {string} file
 * @param {Record<string, string | undefined>} env
 */
export function fileNode(repo, file, env) {
  const path = file.split(sep).join("/");
  const segments = path.split("/");
  if (path === "" || segments.some((s) => s === "" || s === "." || s === "..")) return null;
  const node = `file:${repo}/${path}`;
  return redact(node, env) === node ? node : null;
}

/**
 * Whether the list is sent on this edit: never more than once per SEND_INTERVAL_MS; then when
 * it changed since the last send, or the last send is RENEW_INTERVAL_MS old.
 * @param {{ sentAt?: number, sentDigest?: string }} state
 * @param {string} listDigest
 * @param {number} now
 */
export function sendDue(state, listDigest, now) {
  if (typeof state.sentAt !== "number") return true;
  if (now - state.sentAt < SEND_INTERVAL_MS) return false;
  return listDigest !== state.sentDigest || now - state.sentAt >= RENEW_INTERVAL_MS;
}

/** The overlap section of a memory_note reply, or null when it has none. */
export function overlapSection(text) {
  const at = text.indexOf(OVERLAP_HEADING);
  return at === -1 ? null : text.slice(at).trim();
}

const digest = (text) => createHash("sha256").update(text).digest("hex");

/**
 * Send `touches` as the session's claim on `task`. The reply's text; that the server will not
 * record them for this session (claim overlap off, or the token may not write); that it did
 * not record them this time because the agent released its claim; null on any other outcome.
 * @returns {Promise<{ text: string } | { stop: true } | { released: true } | null>}
 */
async function sendTouches(fetchImpl, mcpUrl, token, { task, sessionId, touches }) {
  try {
    const res = await fetchImpl(mcpUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-willder-task": task,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "memory_note",
          arguments: { kind: "claim", task, touches },
          _meta: { "willder/capture": TOUCHES_CAPTURE, "willder/session": sessionId, "willder/task": task },
        },
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const result = (await res.json())?.result;
    const text = result?.content?.[0]?.text;
    if (typeof text !== "string") return null;
    if (result.isError) {
      if (text.startsWith("claim_overlap_off") || text.startsWith("Access denied")) return { stop: true };
      return text.startsWith("claim_released") ? { released: true } : null;
    }
    return { text };
  } catch {
    return null;
  }
}

/**
 * Record the file this event edited and send the session's list when due. Returns the reply's
 * overlap section to hand the model, or null. Never throws.
 * @param {Record<string, any>} input the hook input Claude Code sent on stdin
 * @param {Record<string, string | undefined>} env
 * @param {{ fetchImpl?: typeof fetch, mcpUrl: URL | null, now?: number, stateDir: string }} deps
 */
export async function captureTouches(input, env, { fetchImpl = fetch, mcpUrl, now = Date.now(), stateDir }) {
  try {
    const token = env.WILLDER_TOKEN?.trim();
    const task = printable(env.WILLDER_TASK);
    const sessionId = printable(input?.session_id);
    if (!touchesEnabled(env) || !mcpUrl || !token || !task || !sessionId) return null;
    const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
    const edited = editedPath(input, cwd);
    if (edited === null || !stateDirUsable(stateDir)) return null;
    const root = repositoryRoot(cwd);
    const file = pathInRoot(root, edited);
    if (file === null || file === "") return null;

    // One state per claim, which the session's task names, not per repository: a session that
    // edits in two repositories sends both repositories' files to its one claim.
    const statePath = join(stateDir, `${digest(`touches\0${sessionId}\0${task}`).slice(0, 32)}.json`);
    const known = readState(statePath);
    if (!known) removeStaleState(stateDir, now);
    const state = known ?? {};
    if (state.stopped) return null;
    const repos = state.repos && typeof state.repos === "object" ? state.repos : {};
    const rootKey = digest(root).slice(0, 16);
    repos[rootKey] ??= repositoryName(originUrl(root) ?? "") ?? basename(root).toLowerCase();
    state.repos = repos;
    const node = fileNode(repos[rootKey], file, env);
    const listed = Array.isArray(state.files) ? state.files.filter((f) => typeof f === "string" && f !== node) : [];
    state.files = node === null ? listed : [...listed, node].slice(-MAX_TOUCHES);
    const listDigest = digest(JSON.stringify([...state.files].sort()));
    if (state.files.length === 0 || !sendDue(state, listDigest, now)) {
      saveState(statePath, state);
      return null;
    }

    const outcome = await sendTouches(fetchImpl, mcpUrl, token, { task, sessionId, touches: state.files });
    if (outcome && "stop" in outcome) state.stopped = true;
    // A released claim is asked about again no sooner than the next send, in case the agent claims it again.
    if (outcome && ("text" in outcome || "released" in outcome)) {
      state.sentAt = now;
      state.sentDigest = listDigest;
    }
    saveState(statePath, state);
    return outcome && "text" in outcome ? overlapSection(outcome.text) : null;
  } catch {
    return null;
  }
}
