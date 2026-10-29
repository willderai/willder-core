// What every Willder MCP tool module is handed when it registers itself: the
// caller's access context, the capability it runs as, and the handler
// wrappers that append the session's change/task-start notices, and the one
// mapping from a thrown error to the reply a client sees. One rule: a tool module
// gets its identity from here and resolves nothing itself.
import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AccessDeniedError, type AccessContext } from "@/services/access";
import { MemoryServiceError } from "@/services/memory";
import { ContactUpsertError } from "@/services/contacts/agent-contacts";
import { StaleBaseVersionError, UnknownBaseVersionError } from "@/services/memory/fact-update";
import { UnreadVersionError, recordVersionsRead, recordVersionsSighted } from "@/services/memory/fact-reads";
import { UnstorableTextError } from "@/lib/unstorable-text";
import {
  ClaimOverlapOffError,
  ClaimReleasedError,
  InvalidWorkingNoteError,
  WorkingNoteGoneError,
} from "@/services/memory/working-notes";
import { InvalidOccurredAtError } from "@/services/memory/occurred-at";
import { VersionNotStoredError } from "@/services/memory/pgvector-store";
import { recordItemUses } from "@/services/memory/task-start-served";
import { DerivedWriteRefusedError, recordScopesRead } from "@/services/access/derived-writes";
import { db } from "@/lib/db";
import type { MemoryFact } from "@/types/memory";
import { Prisma } from "@/lib/generated/prisma/client";
import { toolCallNotice, withChangeNotices, type ToolCallNoticeOptions } from "../change-notices";
import { storedVersionsBehind } from "../fact-citation";
import { isHookCapture } from "../session-capture";
import { sessionKeyOf, taskKeyOf, taskTextOf } from "../task-start-notice";
import { callContextMode, type ContextMode } from "../context-policy";
import type { ToolSet } from "../tool-set";

/** The resolved capability identity a tool call runs as. Mirrors the shape
 * returned by services/access.resolveCapability. */
export interface ResolvedCapability {
  orgId: string;
  agentId: string;
  scopePath: string;
  /** The person who provisioned the token, named on a refusal's audit row. Absent
   * where a caller built the capability without it. */
  createdBy?: string | null;
}

/** Wraps a tool handler so its reply carries the notices owed to this session. */
export type HandlerWrapper = <Args extends unknown[]>(
  handler: (...args: Args) => Promise<CallToolResult>,
) => (...args: Args) => Promise<CallToolResult>;

/** What a transport knows about the connection its tool calls arrive on, and wants to hear back. */
export interface ConnectionOptions {
  /** Read tools may defer supplementary context; writes always keep their notices. */
  context?: ContextMode;
  /** The task the connection names for every call (connectionTaskOf in mcp/task-start-notice.ts); a call's own `_meta` task wins. */
  task?: string;
  /** The connection's session key (mcp/connection-session.ts), or absent for none; a call's own `_meta` session wins. */
  session?: string;
  /** Aborted when the request's caller hangs up; a block is then left for the session's next call. */
  abandoned?: AbortSignal;
  /** How long a call's task-start block took, in milliseconds; see ToolCallNoticeOptions. */
  taskStartTimed?: (ms: number) => void;
  /** Which tools the connection is listed (mcp/tool-set.ts); every tool when absent. */
  tools?: ToolSet;
  /**
   * The one tool this request calls, when it is a single `tools/call` (calledToolOf in
   * mcp/tool-set.ts). Only that tool is registered when the connection lists it; otherwise
   * every listed tool is, so the SDK's own replies are unchanged.
   */
  calls?: string;
}

/** Everything a tool module needs to register itself. */
export interface ToolContext {
  ctx: AccessContext;
  cap: ResolvedCapability;
  /** Appends both what changed in the token's scope since this agent's last
   * call and, on the first call of a session, the task-start block. */
  notifying: HandlerWrapper;
  /** Read-only counterpart: honors compact context without consuming deferred notices. */
  notifyingRead: HandlerWrapper;
  /** As {@link notifying}, but the notices are read while the handler runs instead
   * of before it — for memory_note, whose only write is the caller's own note, so
   * its post is not held back by its own notice read (withChangeNotices). */
  notifyingAlongside: HandlerWrapper;
  /** Appends only the task-start block — for memory_changes, which is itself
   * the change feed. */
  taskStartOnly: HandlerWrapper;
  /** The task a call names, given the request's extra ({@link taskKeyOf} with this connection's task). */
  taskOf: (extra: unknown) => string | undefined;
  /** The session a call belongs to, given the request's extra ({@link sessionKeyOf} with this connection's session); "" for none. */
  sessionOf: (extra: unknown) => string;
}

/** Render a thrown error as the tool reply the client sees. Every handler's
 * catch block funnels through here so the error shapes never drift. */
export function toolError(e: unknown) {
  return { content: [{ type: "text" as const, text: toolErrorText(e) }], isError: true };
}

/** The client-safe text for a thrown error: a tool reply's, and a prompt's error message (mcp/prompts.ts). */
export function toolErrorText(e: unknown): string {
  // decision.reason is the client-safe half by construction; the resolved
  // target scope stays in decision.auditReason and the audit row.
  if (e instanceof AccessDeniedError) return `Access denied: ${e.decision.reason}`;
  if (e instanceof MemoryServiceError) return `Memory service error: ${e.message}`;
  if (e instanceof ContactUpsertError) return `${e.code}: ${e.message}`;
  if (e instanceof StaleBaseVersionError || e instanceof UnreadVersionError) return `stale_version: ${e.message}`;
  if (e instanceof UnknownBaseVersionError) return `unknown_version: ${e.message}`;
  if (e instanceof DerivedWriteRefusedError) return e.message;
  if (e instanceof UnstorableTextError || e instanceof InvalidWorkingNoteError || e instanceof InvalidOccurredAtError) {
    return `invalid_input: ${e.message}`;
  }
  if (e instanceof WorkingNoteGoneError) return `note_gone: ${e.message}`;
  if (e instanceof ClaimOverlapOffError) return `claim_overlap_off: ${e.message}`;
  if (e instanceof ClaimReleasedError) return `claim_released: ${e.message}`;
  if (e instanceof VersionNotStoredError) return notStoredText(e);
  if (isStorageError(e)) return storageErrorText(e);
  return e instanceof Error ? e.message : String(e);
}

/** SQLSTATE 22021: a character the database encoding cannot hold. From a client,
 * that is a NUL byte, the one character valid JSON can carry and Postgres text cannot. */
const UNSTORABLE_CHARACTER = "22021";

/** SQLSTATE class 22, "data exception": the database refused a value the caller sent. */
const DATA_EXCEPTION_CLASS = "22";

/** The shape of the error Prisma's pg driver adapter throws when a query fails. */
interface DriverAdapterFailure {
  name: "DriverAdapterError";
  cause: { originalCode?: string; code?: string };
}

/**
 * Whether `e` came from the database or its driver. Prisma does not export
 * DriverAdapterError, so it is recognised by name and cause, exactly as Prisma's
 * own isDriverAdapterError does.
 */
function isStorageError(e: unknown): e is Error {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError ||
    e instanceof Prisma.PrismaClientUnknownRequestError ||
    e instanceof Prisma.PrismaClientRustPanicError ||
    e instanceof Prisma.PrismaClientInitializationError ||
    e instanceof Prisma.PrismaClientValidationError ||
    (e instanceof Error && isDriverAdapterFailure(e))
  );
}

function isDriverAdapterFailure(e: unknown): e is DriverAdapterFailure {
  if (typeof e !== "object" || e === null) return false;
  const { name, cause } = e as { name?: unknown; cause?: unknown };
  return name === "DriverAdapterError" && typeof cause === "object" && cause !== null;
}

/** The Postgres SQLSTATE behind a storage error, when it carries one. The adapter's
 * error arrives either thrown as is or wrapped by Prisma in `meta.driverAdapterError`. */
function sqlStateOf(e: Error): string | undefined {
  const adapterError = e instanceof Prisma.PrismaClientKnownRequestError ? e.meta?.driverAdapterError : e;
  if (!isDriverAdapterFailure(adapterError)) return undefined;
  return adapterError.cause.originalCode ?? adapterError.cause.code;
}

/**
 * The reply for a storage error: what the caller can do, never the database's own
 * text, which names tables, queries and driver internals. The original is logged
 * server-side under a short reference the reply quotes, so a report can be traced.
 */
function storageErrorText(e: Error): string {
  const reference = randomUUID().slice(0, 8);
  console.error(`MCP tool storage error, reference ${reference}:`, e);
  const sqlState = sqlStateOf(e);
  if (sqlState === UNSTORABLE_CHARACTER) {
    return `invalid_input: a text value in this call contains a NUL (\\u0000) character, which cannot be stored. Remove it and retry. (reference ${reference})`;
  }
  if (sqlState?.startsWith(DATA_EXCEPTION_CLASS)) {
    return `invalid_input: a value in this call is malformed, too long or out of range for storage. Correct it and retry. (reference ${reference})`;
  }
  return `storage_error: Willder could not complete this call. Nothing in the request needs to change; retry, and if it keeps failing, report reference ${reference} to the people who run this Willder server (send_feedback reaches them where it is listed).`;
}

/**
 * The reply for a write whose transaction failed: it says the write was not stored and why,
 * and that the same call can be sent again (an identical retry stores it once). The
 * database's own error is logged server-side under the reference the reply quotes.
 */
function notStoredText(e: VersionNotStoredError): string {
  const reference = randomUUID().slice(0, 8);
  console.error(`MCP tool write not stored, reference ${reference}:`, e.cause);
  return `not_stored: ${e.message} Send the same call again to store it. (reference ${reference})`;
}

/**
 * Record that a tool reply served these stored versions to the calling agent, so its
 * later writes are checked against what it read (services/memory/fact-reads.ts).
 *
 * Call it before the reply is returned, and let a failure fail the call. A read served
 * without its record is the one case the stale-read check cannot see: when it was the
 * agent's only read of the fact, a later write without baseVersion is accepted unchecked
 * beside a newer version. Failing the call costs the agent a retry instead.
 */
export async function recordServedVersions(
  cap: ResolvedCapability,
  versionIds: readonly string[],
  { ownWrite = false }: { ownWrite?: boolean } = {},
): Promise<void> {
  await recordVersionsRead(db, { orgId: cap.orgId, agentId: cap.agentId, versionIds, ownWrite });
}

/**
 * Record that a tool reply showed the calling agent content read from `scopePaths` with no
 * stored version behind it (a brief, a graph summary, a contact), for the derived-write
 * rule (services/access/derived-writes.ts). Like {@link recordServedVersions}, call it
 * before the reply is returned and let a failure fail the call: content served without its
 * record is content the agent could write elsewhere unchecked.
 */
export async function recordServedScopes(cap: ResolvedCapability, scopePaths: readonly string[]): Promise<void> {
  await recordScopesRead(db, { orgId: cap.orgId, agentId: cap.agentId }, scopePaths);
}

/**
 * Record what a page of served facts, read under `readScope`, showed the calling agent. A fact served whole is a
 * read of every stored version behind it. A fact served as an excerpt (`excerptOfChars`,
 * services/memory/query-excerpt.ts) showed only part of its version, so each version
 * behind it is a sighting (services/memory/fact-reads.ts): the agent must read it whole
 * before it can write past it without a base.
 *
 * A version behind an excerpt stays a sighting even when another fact on the same page
 * derives from it, since no fact on the page showed that version's whole text. Recording
 * too little costs the agent one memory_version call; recording too much lets it
 * overwrite text it never saw.
 */
export async function recordServedFacts(
  cap: ResolvedCapability,
  facts: readonly MemoryFact[],
  readScope: string,
): Promise<void> {
  // A fact with no stored version behind it (a graph fact its ingest never stored as a
  // chunk) cannot say which scope it is stored in, so the scope the read was authorized
  // on stands for it: wider than the truth, never narrower.
  if (facts.some((f) => storedVersionsBehind(f).length === 0)) await recordServedScopes(cap, [readScope]);
  const excerpted = new Set(facts.filter((f) => f.excerptOfChars).flatMap(storedVersionsBehind));
  const whole = facts
    .filter((f) => !f.excerptOfChars)
    .flatMap(storedVersionsBehind)
    .filter((id) => !excerpted.has(id));
  await recordVersionsSighted(db, { orgId: cap.orgId, agentId: cap.agentId, versionIds: [...excerpted] });
  await recordServedVersions(cap, whole);
}

/**
 * Build the per-request tool context: the notice wrappers bound to this
 * caller's identity, alongside the identity itself.
 */
export function createToolContext(
  ctx: AccessContext,
  cap: ResolvedCapability,
  connection: ConnectionOptions = {},
): ToolContext {
  // A handler's first argument is the tool's input and its second the request's
  // extra, which carries the client's `_meta`.
  // A hook's capture call carries no notices: the hook forwards none of what rides on its
  // reply, so anything there would be marked told and never reach the agent
  // (mcp/session-capture.ts).
  const piggyback =
    ({
      changes,
      readAlongside = false,
      readOnly = false,
    }: Pick<ToolCallNoticeOptions, "changes"> & { readAlongside?: boolean; readOnly?: boolean }): HandlerWrapper =>
    <Args extends unknown[]>(handler: (...args: Args) => Promise<CallToolResult>) => {
      const notice = (...args: Args) => {
        const compact = readOnly && callContextMode(args[1], connection.context) === "compact";
        // Compact defers only the feed: scope rules and denial bookkeeping remain
        // the same on every read, including an unnamed session's first call.
        return toolCallNotice(ctx, cap.scopePath, {
          changes: changes && !compact,
          deferredChanges: compact && changes,
          onTaskStartTimed: connection.taskStartTimed,
          taskStart: {
            sessionKey: sessionKeyOf(args[1], connection.session),
            taskText: taskTextOf(args[0], args[1], connection.task),
            taskKey: taskKeyOf(args[1], connection.task),
            abandoned: connection.abandoned,
          },
        });
      };
      return (...args: Args) => {
        if (isHookCapture(args[1])) return handler(...args);
        // Timed from before the notices are read: an item the block on this very call serves
        // was served after the call began, so this call never counts as using it.
        const started = performance.now();
        const observed = async (...callArgs: Args): Promise<CallToolResult> => {
          const result = await handler(...callArgs);
          await recordUses(sessionKeyOf(callArgs[1], connection.session), callArgs[0], result, started);
          return result;
        };
        return withChangeNotices(observed, notice, { readAlongside })(...args);
      };
    };
  /**
   * The served-vs-used log's use side: which items this session's task-start block served that
   * this call named or got back (services/memory/task-start-served.ts). Read from the tool's own
   * reply, before the notices are appended. A failure to record is a gap in a measurement, never
   * a reason to fail the agent's call, so it is logged and the reply goes out.
   */
  const recordUses = async (sessionKey: string, args: unknown, result: CallToolResult, startedAt: number) => {
    try {
      await recordItemUses({ orgId: cap.orgId, agentId: cap.agentId, sessionKey }, { args, result, startedAt });
    } catch (e) {
      console.warn("[task-start-served] use not recorded:", e instanceof Error ? e.message : e);
    }
  };
  return {
    ctx,
    cap,
    notifying: piggyback({ changes: true }),
    notifyingRead: piggyback({ changes: true, readOnly: true }),
    notifyingAlongside: piggyback({ changes: true, readAlongside: true }),
    taskStartOnly: piggyback({ changes: false }),
    taskOf: (extra) => taskKeyOf(extra, connection.task),
    sessionOf: (extra) => sessionKeyOf(extra, connection.session),
  };
}
