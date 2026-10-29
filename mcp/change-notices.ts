// Change notices on every tool result: layer 1 of the change feed.
//
// A server cannot interrupt a model mid-task, and most MCP clients ignore server
// notifications. What a busy agent does do is call tools, so every Willder tool
// result carries a short block listing what other agents and people changed in
// the caller's scope since its last call. The feed itself, and the rule that
// nothing outside the caller's live capability is ever shown, live in
// services/memory/change-feed.ts; this file only decides how much to attach and
// how it reads. The post of a working note is shown only while the note is live
// (services/memory/working-notes.ts), and so is an overlap between two claims
// (services/memory/claim-overlap.ts): while the claim whose post made it is live.
//
// A burst is merged, never dropped: when more changes are new than a notice has lines for,
// it describes the longest run of them, in feed order, that fits one line per subject (a
// fact, meaning every version of one name in one scope, or any other record), and the
// feed's cursor moves past that run only. Everything after it stays unread for the
// next call or memory_changes, and the last line says how many wait. Every count covers
// only changes inside the caller's scope.
//
// The one rule this file enforces: a notice can never break the tool call it
// rides on. Any failure reading the feed returns the tool's own result untouched.
// And, as for the hook's route (app/api/changes/notice/route.ts), an agent that may
// not read its own scope learns nothing about the org's writes from its tool calls,
// and its denial is audited once when it starts, not on every call that repeats it.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AccessDeniedError, can, check } from "@/services/access";
import type { AccessContext, AccessRequest } from "@/services/access";
import {
  MAX_CHANGES_PER_READ,
  MAX_WAITING_COUNTED,
  captureVersionsOf,
  countWaitingChanges,
  endDeniedRead,
  factNamesOf,
  readChanges,
  recordDeniedRead,
  skipUnshownChanges,
  type Change,
  type FeedChange,
} from "@/services/memory/change-feed";
import { FACT_RECORD_TYPE } from "@/services/memory/change-events";
import { CLAIM_OVERLAP_RECORD_TYPE } from "@/services/memory/claim-overlap";
import { WORKING_NOTE_RECORD_TYPE, liveNoteIds } from "@/services/memory/working-notes";
import { taskStartNotice, type TaskStartRequest } from "./task-start-notice";
import { CONTEXT_DEFERRED } from "./context-policy";
import { CHANGE_NOTICES_HEADING } from "./task-start-headings";

/** Most change lines a single tool result carries. Past this many changes, they are
 * merged by subject ({@link noticeLines}), and what still does not fit waits unread. */
export const MAX_NOTICES_PER_CALL = 5;

/**
 * The notice to attach for `ctx`'s agent, or null when there is nothing to say.
 *
 * Reads through the agent's server-held cursor, so each change is attached to
 * exactly one tool result. Changes the agent made itself are dropped from the
 * text (it already knows) but still passed, so they are not shown later either.
 * So is the creation of a fact version in `shownInBlock`, the versions the task-start
 * block on the same result just showed: its line would only repeat the block's. A
 * supersede or a delete of one is still shown, since the block does not say it.
 * When no change by anyone else inside `scopePath` is new to this agent, returns
 * before `check()` runs: nothing is disclosed, so nothing is audited. The caller
 * must already have decided with can() that the agent may read `scopePath`.
 */
export async function changeNotice(
  ctx: AccessContext,
  scopePath: string,
  shownInBlock: ReadonlySet<string> = new Set(),
): Promise<string | null> {
  if (!(await skipUnshownChanges(ctx, scopePath))) return null;
  let names: FactNames = new Map();
  const toldAlready = (change: Pick<Change, "actorId" | "op" | "recordType" | "recordId">) =>
    change.actorId === ctx.actor.id ||
    (change.op === "create" && change.recordType === FACT_RECORD_TYPE && shownInBlock.has(change.recordId));
  let isShown: IsShown = (change) => !toldAlready(change);
  const { changes, hasMore } = await readChanges(ctx, scopePath, {
    limit: MAX_CHANGES_PER_READ,
    take: async (page) => {
      const [factNames, ended, repeats] = await Promise.all([
        factNamesFor(ctx.orgId, scopePath, page),
        endedNotePosts(ctx.orgId, page),
        captureRepeats(ctx.orgId, scopePath, page),
      ]);
      names = factNames;
      isShown = (change) => !toldAlready(change) && !ended.has(change.id) && !repeats.has(change.id);
      return noticeTake(page, isShown, names);
    },
    sightings: (served) => noticeGroups(served, isShown, names).map((group) => group[group.length - 1]!.recordId),
  });
  const lines = noticeLines(changes, isShown, names);
  // The cursor has moved past `changes`: a failure from here on must still describe them.
  const waiting = hasMore ? await waitingOrUnknown(ctx, scopePath) : 0;
  if (lines.length === 0 && waiting === 0) return null;

  if (waiting !== 0) lines.push(waitingLine(waiting));
  return [CHANGE_NOTICES_HEADING, ...lines].join("\n");
}

/** The fact name of each fact version on the page, by version id ({@link factNamesOf}). */
type FactNames = ReadonlyMap<string, string>;

/**
 * Whether a notice describes a change: not one the reader made, which it already knows,
 * and not the post of a working note that has since ended. A change it does not describe
 * is still consumed, and costs no line.
 */
type IsShown = (change: Pick<Change, "id" | "actorId" | "op" | "recordType" | "recordId">) => boolean;

/**
 * The ids of the changes on `page` that post or renew a working note that has since
 * expired or been released, or report an overlap made by such a claim: a notice says what
 * is in progress, and that note no longer is. A note's release is kept, so an agent told of
 * a claim earlier also hears that it ended. When liveness cannot be read, every note post is shown.
 */
async function endedNotePosts(orgId: string, page: readonly FeedChange[]): Promise<ReadonlySet<string>> {
  const posts = page.filter(
    (change) =>
      (change.recordType === WORKING_NOTE_RECORD_TYPE && change.op !== "delete") ||
      change.recordType === CLAIM_OVERLAP_RECORD_TYPE,
  );
  if (posts.length === 0) return new Set();
  const live = await liveNoteIds(
    orgId,
    posts.map((change) => change.recordId),
  ).catch((e: unknown) => {
    console.warn(
      "[change-notices] working-note liveness unread, showing every note post:",
      e instanceof Error ? e.message : e,
    );
    return null;
  });
  if (live === null) return new Set();
  return new Set(posts.filter((change) => !live.has(change.recordId)).map((change) => change.id));
}

/**
 * The ids of the changes on `page` that come from a later snapshot of a session's capture
 * ({@link captureVersionsOf}): the store of a version that replaced the session's earlier one,
 * and the supersede of the version it replaced. Another agent hears of each session's capture
 * once, at its first version; a deletion is
 * still heard. When the captures cannot be read, every capture change is shown.
 */
async function captureRepeats(
  orgId: string,
  scopePath: string,
  page: readonly FeedChange[],
): Promise<ReadonlySet<string>> {
  const facts = page.filter(
    (change) => change.recordType === FACT_RECORD_TYPE && (change.op === "create" || change.op === "supersede"),
  );
  const captures = await captureVersionsOf(
    orgId,
    scopePath,
    facts.map((change) => change.recordId),
  ).catch((e: unknown) => {
    console.warn("[change-notices] captures unread, each change to one is shown:", e instanceof Error ? e.message : e);
    return new Map<string, { replaced: boolean }>();
  });
  const repeats = facts.filter((change) => {
    const capture = captures.get(change.recordId);
    return capture !== undefined && (change.op === "supersede" || capture.replaced);
  });
  return new Set(repeats.map((change) => change.id));
}

/**
 * {@link factNamesOf} for the fact changes on `page`. Without them each version reads as a
 * record of its own, as it did before facts were merged, so a failed read only costs the
 * merging.
 */
async function factNamesFor(orgId: string, scopePath: string, page: readonly FeedChange[]): Promise<FactNames> {
  const versionIds = page.filter((change) => change.recordType === FACT_RECORD_TYPE).map((change) => change.recordId);
  return factNamesOf(orgId, scopePath, versionIds).catch((e: unknown) => {
    console.warn(
      "[change-notices] fact names unread, each version is its own line:",
      e instanceof Error ? e.message : e,
    );
    return new Map<string, string>();
  });
}

/** How many changes wait ({@link countWaitingChanges}), or "unknown" when the count fails. */
async function waitingOrUnknown(ctx: AccessContext, scopePath: string): Promise<number | "unknown"> {
  return countWaitingChanges(ctx, scopePath).catch((e: unknown) => {
    console.warn("[change-notices] waiting changes uncounted:", e instanceof Error ? e.message : e);
    return "unknown" as const;
  });
}

/**
 * What a change is a change to, for merging: the fact it is a version of, by name and
 * scope, when `names` knows it; otherwise its own record.
 */
function subjectOf(change: Pick<Change, "recordType" | "recordId" | "scopePath">, names: FactNames): string {
  const name = change.recordType === FACT_RECORD_TYPE ? names.get(change.recordId) : undefined;
  return name === undefined ? `${change.recordType} ${change.recordId}` : `fact "${name}" in ${change.scopePath}`;
}

/** How a merged line names its subject: a fact by its name, any other record by type and id. */
function labelOf(change: Pick<Change, "recordType" | "recordId">, names: FactNames): string {
  const name = change.recordType === FACT_RECORD_TYPE ? names.get(change.recordId) : undefined;
  return name === undefined ? `${change.recordType} ${change.recordId}` : `fact "${name}"`;
}

/**
 * How many of `page`'s changes, in feed order, one notice can describe in
 * {@link MAX_NOTICES_PER_CALL} lines: everything up to the first shown change to a subject
 * past that many. A subject is a fact (all versions of one name in one scope, by `names`)
 * or any other record. Changes the notice does not show cost no line, so they ride along.
 */
export function noticeTake(
  page: readonly Pick<Change, "id" | "actorId" | "op" | "recordType" | "recordId" | "scopePath">[],
  isShown: IsShown,
  names: FactNames,
): number {
  const subjects = new Set<string>();
  for (const [index, change] of page.entries()) {
    if (!isShown(change)) continue;
    const subject = subjectOf(change, names);
    if (!subjects.has(subject) && subjects.size === MAX_NOTICES_PER_CALL) return index;
    subjects.add(subject);
  }
  return page.length;
}

/**
 * The changes in `changes` the notice shows, oldest first, as the groups its lines
 * describe: one line each, so the last change of a group is the one its line names. Up
 * to {@link MAX_NOTICES_PER_CALL} changes get a group of their own each, as they always
 * have. More than that (which {@link noticeTake} allows only when they fall on that many
 * subjects or fewer) are grouped by subject, in the order the subjects were first changed.
 */
export function noticeGroups(changes: readonly Change[], isShown: IsShown, names: FactNames): Change[][] {
  const shown = changes.filter(isShown);
  if (shown.length <= MAX_NOTICES_PER_CALL) return shown.map((change) => [change]);

  const bySubject = new Map<string, Change[]>();
  for (const change of shown) {
    const subject = subjectOf(change, names);
    bySubject.set(subject, [...(bySubject.get(subject) ?? []), change]);
  }
  return [...bySubject.values()];
}

/** The notice's lines for `changes`: one per {@link noticeGroups} group. */
export function noticeLines(changes: readonly Change[], isShown: IsShown, names: FactNames): string[] {
  return noticeGroups(changes, isShown, names).map((group) =>
    group.length === 1 ? formatChange(group[0]!) : formatMerged(group, names),
  );
}

/**
 * One line for several changes to one subject: how many, by whom, and the latest change
 * in full, operation included, so a delete or a supersede at the end is never hidden.
 */
function formatMerged(group: Change[], names: FactNames): string {
  const actors = new Set(group.map((change) => change.actorId));
  const by = actors.size === 1 ? group[0]!.actorId : `${actors.size} actors`;
  const latest = group[group.length - 1]!;
  const line = `- ${group.length} changes to ${labelOf(latest, names)} by ${by}; latest: ${latest.op} ${latest.recordType} ${latest.recordId}`;
  return latest.summary ? `${line}: ${latest.summary}` : line;
}

/** The last line when changes the notice could not describe are still unread. */
function waitingLine(waiting: number | "unknown"): string {
  if (waiting === "unknown") return "More changes are waiting: call memory_changes.";
  if (waiting >= MAX_WAITING_COUNTED) return `${MAX_WAITING_COUNTED} or more changes are waiting: call memory_changes.`;
  return `${waiting} more ${waiting === 1 ? "change is" : "changes are"} waiting: call memory_changes.`;
}

/** What a tool call adds to the piggyback besides the decision itself. */
export interface ToolCallNoticeOptions {
  /** Serve the task-start block if this is the first call of a session. */
  taskStart?: Omit<TaskStartRequest, "scopePath">;
  /** Attach change notices. False for memory_changes, which is the feed itself. */
  changes?: boolean;
  /** Explain an opted-out feed after access is allowed; never replace task-start rules. */
  deferredChanges?: boolean;
  /**
   * Told how long the task-start block took, in milliseconds, each time it runs:
   * the session check alone on a served session, the whole block on a new one.
   * Not called for an agent that may not read its scope, which runs no block.
   */
  onTaskStartTimed?: (ms: number) => void;
}

/**
 * The piggyback for one of `ctx`'s tool results: the task-start block when asked for
 * and due, then {@link changeNotice}, behind a decision made first, on every call.
 *
 * Deciding before the feed is looked at is what keeps a denied agent's calls alike
 * whether or not anything was written; deciding with can() is what keeps an allowed
 * agent's calls unaudited. A denied agent's cursor is moved past everything written
 * so far and the denial is audited only on the call that starts it, so an agent
 * that keeps calling tools after a revoke writes one audit row, not one per call.
 * An allowed call ends the denial, so the next revoke is audited again.
 */
export async function toolCallNotice(
  ctx: AccessContext,
  scopePath: string,
  { taskStart, changes = true, deferredChanges = false, onTaskStartTimed }: ToolCallNoticeOptions = {},
): Promise<string | null> {
  const read: AccessRequest = { action: "memory.read", scope: scopePath };
  if (!(await can(ctx, read)).allowed) {
    if (await recordDeniedRead(ctx)) await check(ctx, read);
    return null;
  }
  await endDeniedRead(ctx);

  try {
    // The fact versions the block shows, so the notices after it do not announce them again.
    let shownInBlock: ReadonlySet<string> = new Set();
    const onShown = (ids: readonly string[]) => {
      shownInBlock = new Set(ids);
    };
    const block = taskStart
      ? await timedTaskStartNotice(ctx, { ...taskStart, scopePath, onShown }, onTaskStartTimed)
      : null;
    const parts = [
      block,
      changes ? await changeNotice(ctx, scopePath, shownInBlock) : deferredChanges ? CONTEXT_DEFERRED : null,
    ].filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join("\n\n") : null;
  } catch (e) {
    // Revoked between can() and a later check(), which already audited it.
    if (e instanceof AccessDeniedError) {
      await recordDeniedRead(ctx);
      return null;
    }
    throw e;
  }
}

/**
 * {@link taskStartNotice}, reporting its duration to `onTimed` however it ends. A failed
 * read costs the session its block, never its change notices; a revoke is rethrown.
 */
async function timedTaskStartNotice(
  ctx: AccessContext,
  request: TaskStartRequest,
  onTimed?: (ms: number) => void,
): Promise<string | null> {
  const started = performance.now();
  try {
    return await taskStartNotice(ctx, request);
  } catch (e) {
    if (e instanceof AccessDeniedError) throw e;
    console.warn("[change-notices] task-start block skipped:", e instanceof Error ? e.message : e);
    return null;
  } finally {
    onTimed?.(performance.now() - started);
  }
}

/** One notice line. A change with no summary (a deleted fact has no text left to
 * show) ends at its actor rather than on a dangling colon. */
export function formatChange(change: Change): string {
  const line = `- ${change.op} ${change.recordType} ${change.recordId} by ${change.actorId}`;
  return change.summary ? `${line}: ${change.summary}` : line;
}

/**
 * Wrap a tool handler so its result carries `notice(...args)` as an extra text block.
 *
 * The handler's own content is never altered or reordered; the notice is appended
 * after it. A notice that throws or returns null leaves the result as it was.
 *
 * The notice is read BEFORE the handler runs, so "since your last call" means the
 * changes that existed when this call arrived — never the ones this call itself
 * caused. Reading it afterwards instead makes a writing call consume its own
 * consequences: two agents writing one fact produce a `supersede` event on the
 * losing version inside the losing ingest's own transaction, and the loser's own
 * acknowledgement then swallowed the one line it needed, leaving nothing for the
 * call after it (mcp/conflict-notice.realdb.test.ts).
 *
 * The cost of reading first is that a change landing while the tool runs waits for
 * the next call, and that a handler which throws rather than returning an error
 * result loses the notice it was going to carry. Every Willder tool handler catches
 * its own errors and returns an error result rather than throwing, so the second case is the wrapper
 * being defensive about a handler shape no tool currently has.
 *
 * `readAlongside` starts the handler without waiting for the notice, so the read no
 * longer delays the handler's write. It is only for a handler whose every write is a
 * change by the caller itself (memory_note): a notice never shows an agent its own
 * changes, so reading alongside cannot swallow a line this agent still needs. A change
 * by someone else that commits while both run may then arrive one call earlier, and a
 * session's first call may list, in its task-start block, the note that same call posts.
 */
export function withChangeNotices<Args extends unknown[]>(
  handler: (...args: Args) => Promise<CallToolResult>,
  notice: (...args: Args) => Promise<string | null>,
  { readAlongside = false }: { readAlongside?: boolean } = {},
): (...args: Args) => Promise<CallToolResult> {
  return async (...args) => {
    const reading = notice(...args).catch((e: unknown) => {
      console.warn("[change-notices] notice skipped:", e instanceof Error ? e.message : e);
      return null;
    });
    if (!readAlongside) await reading;
    const result = await handler(...args);
    const text = await reading;
    if (text === null) return result;
    return { ...result, content: [...result.content, { type: "text", text }] };
  };
}
