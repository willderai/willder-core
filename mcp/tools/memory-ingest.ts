// memory_ingest: write a fact, convention, or decision into business memory.
// The one rule: on a write, a malformed caller-supplied scope is refused, never
// widened to the token's own scope the way a read falls back. With an
// idempotencyKey, a retried call writes nothing and gets the first call's reply
// (services/memory/ingest-key.ts). A write back from a stale read is refused
// (services/memory/fact-reads.ts), so the version this tool replies with is recorded
// as served to the writing agent. The task the call names (`willder/task`, or the
// connection's X-Willder-Task header) is recorded with the write, so a later session of
// that task is served it at task start, deciding facts ahead of progress notes when the
// writer says which is which (`role`, services/memory/fact-roles.ts). A write may say
// when its content happened (`occurredAt`); a value that is not an ISO-8601 instant, or
// that lies in the future, is refused before anything is written
// (services/memory/occurred-at.ts), and a write without one is dated by when it was stored.
// A call the willder init hook marks as a session-state capture is stored without graph
// extraction (mcp/session-capture.ts). A write into a scope after this agent's session was
// shown content from a scope whose readers are not all that scope's readers is refused,
// unless it names those scopes in `intentionalShareFrom`; a declared share is stored,
// marked and announced (services/access/derived-writes.ts). A fact named as a session's handoff
// (`Handoff: <task>, session <id8>`, services/memory/session-handoff.ts) is refused, naming what
// is missing, unless it has every part; a complete one is stored as progress unless it says
// otherwise, and without graph extraction, like a capture: it says where one session stopped.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AccessDeniedError, check, normalizeScopePath, resolveCallerScopePath } from "@/services/access";
import type { IngestAck } from "@/lib/inngest";
import { changeTheRule } from "@/services/memory/person-rule-copy";
import { CONVENTION_KINDS, recordAuthorizedConvention } from "@/services/memory/conventions";
import { FACT_ROLES, type FactRole } from "@/services/memory/fact-roles";
import { ingestKeySchema, ingestRequestHash, withIngestKey } from "@/services/memory/ingest-key";
import { parseOccurredAt } from "@/services/memory/occurred-at";
import { handoffRefusal, isHandoffName } from "@/services/memory/session-handoff";
import { MAX_DECLARED_SCOPES } from "@/services/access/derived-writes";
import { invalidCallerScopePath, noCapability } from "@/services/access/deny-reason";
import { VersionNotStoredError } from "@/services/memory/pgvector-store";
import { isSessionStateCapture } from "../session-capture";
import { authorizeDerivedWrite, announceDerivedWrite, derivedMarkersFor, type DerivedShare } from "../derived-write";
import { StaleBaseVersionError } from "@/services/memory/fact-update";
import { readMemoryVersion } from "@/services/memory/versions";
import { describeVersion } from "./memory-version";
import { recordServedVersions, toolError, type ToolContext } from "./tool-context";
import { receivedNow } from "@/services/memory/received-at";

/** memory_ingest's arguments; their descriptions are the tool's documentation, as clients list it. */
const memoryIngestInput = {
  content: z.string().min(1).describe("The fact, in plain text."),
  name: z.string().min(1).describe("The entity it is about, e.g. 'Acme Corp' or 'Jane Doe'."),
  scopePath: z
    .string()
    .optional()
    .describe(
      "Optional; leave it out. Without it the write goes to your token's own scope, which is right for almost every write. Send one only when a person, a tool reply or your instructions gave you a scope path inside your token's scope; do not invent or guess one: a scope your token does not cover is refused.",
    ),
  kind: z
    .enum(CONVENTION_KINDS)
    .optional()
    .describe(
      "Optional; omit it for a fact or note, which is most writes. Set it only to record a rule of the scope, served at the start of every session in it: 'convention' (how this org does something) or 'decision' (a choice later work must follow; a proposal until a person confirms it at the link in the reply).",
    ),
  supersedes: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "With kind: the id of the rule this one replaces; the old rule stops being served. Refused if it was already replaced; memory_version on it names the replacement. A rule a person recorded or confirmed is never replaced by an agent: yours is stored beside it, replacing nothing, and the reply says so.",
    ),
  baseVersion: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Without kind: the id of the version of this fact (same name and scope) you read and are replacing, as a read or change notice gave it. Refused, naming the current version, if it was replaced since. An agent's write on the copy of a rule a person recorded or confirmed replaces nothing: it is kept beside it. Omit to replace nothing; that is still refused when there is a newer version you have not read.",
    ),
  role: z
    .enum(FACT_ROLES)
    .optional()
    .describe(
      "Without kind, set it when you know it: cause (why the task exists or what went wrong), constraint (a limit the work must stay inside), decision (a choice later work must follow), rejected (an option turned down) or progress (where the work stands). The task's next session is served the first four first, progress last.",
    ),
  occurredAt: z
    .string()
    .optional()
    .describe(
      "When the content happened, if not now: an ISO-8601 date (2026-03-11) or date-time with offset (2026-03-11T15:10:00Z). Not a due date: a future time is refused. Omit to date it when stored.",
    ),
  intentionalShareFrom: z
    .array(z.string())
    .max(MAX_DECLARED_SCOPES)
    .optional()
    .describe(
      "A write is refused, naming the scopes, when this agent id was ever shown content from a scope that not every reader of the target can read (the record never expires). Send those scopes here to share anyway: the write is audited, marked (readers who cannot read a source scope never see its name) and announced to the source's readers. Only scopes this agent id was shown are accepted.",
    ),
  idempotencyKey: ingestKeySchema
    .optional()
    .describe(
      "A key you generate, unique to this write. A retry with the same key and arguments writes nothing and returns the first reply; the same key with different arguments is refused.",
    ),
};

type MemoryIngestArgs = z.infer<z.ZodObject<typeof memoryIngestInput>>;

export function registerMemoryIngest(server: McpServer, toolContext: ToolContext): void {
  server.registerTool(
    "memory_ingest",
    {
      title: "Write to business memory",
      description:
        "Store a fact, note or decision in Willder's business memory (needs a token with memory.write). memory_query reads it, and other agents' memory_changes lists it, as soon as the call returns. Only content and name are needed; leave the other arguments out unless you need what one describes.",
      inputSchema: memoryIngestInput,
    },
    toolContext.notifying((args: MemoryIngestArgs, extra: unknown) => handleMemoryIngest(toolContext, args, extra)),
  );
}

/**
 * One memory_ingest call: refuse what cannot be written, resolve the target scope, and write the
 * note, once per idempotency key when the call sends one. Never throws: a refusal or a failure is
 * the tool error the client sees.
 */
async function handleMemoryIngest(
  toolContext: ToolContext,
  {
    content,
    name,
    scopePath,
    kind,
    supersedes,
    baseVersion,
    role,
    occurredAt,
    intentionalShareFrom,
    idempotencyKey,
  }: MemoryIngestArgs,
  extra: unknown,
): Promise<CallToolResult> {
  const { ctx, cap } = toolContext;
  // When this write was received, on the database's clock, before the authorization,
  // the cold import of the write pipeline and the embedding can delay it: the conflict
  // rule judges two writes of one fact by it (services/memory/received-at.ts). Asked
  // now, awaited once the write is known to go ahead; it never rejects.
  const receivedAt = receivedNow();
  try {
    if (supersedes !== undefined && kind === undefined) {
      return toolError(new Error("supersedes needs kind: only a convention or decision can replace one."));
    }
    if (role !== undefined && kind !== undefined) {
      return toolError(
        new Error("role is for a fact: a convention or decision is already a rule. Send role without kind."),
      );
    }
    // A handoff the next session cannot finish from is refused before anything is checked or
    // stored, so it leaves no row and no idempotency key, and the reply says what to add.
    const handoff = kind === undefined && isHandoffName(name);
    const refusal = handoff ? handoffRefusal(content) : null;
    if (refusal !== null) return toolError(new Error(refusal));
    const occurredAtUtc = occurredAt === undefined ? undefined : parseOccurredAt(occurredAt);
    // Same guard memory_query/memory_entity apply to a caller-supplied
    // scopePath — but unlike those read paths, a non-empty scopePath that
    // fails validation here must be REFUSED, not silently replaced by
    // cap.scopePath. Falling back is safe on a read (the token's own scope
    // can never return more than the token already covers), but on a write
    // the same fallback runs the other way, storing the caller's content at
    // the WIDER scope instead of the narrower one they asked for, while
    // they're told "Stored.".
    // Only an empty/whitespace scopePath ("no scope requested") still
    // falls back; a non-empty-but-malformed one ("an invalid scope
    // requested") is refused instead, audited directly by
    // resolveCallerScopePath since check()'s `::ltree` cast would throw
    // on the malformed value before recordAudit() runs.
    const target = await resolveCallerScopePath(ctx, scopePath, cap, {
      onInvalid: "refuse",
      action: "memory.write",
    });
    const note: NoteWrite = {
      content,
      name,
      kind,
      supersedes,
      baseVersion,
      role: role ?? (handoff ? "progress" : undefined),
      occurredAt: occurredAtUtc,
      target,
      task: toolContext.taskOf(extra),
      sessionKey: toolContext.sessionOf(extra) || undefined,
      skipGraphExtraction: handoff || isSessionStateCapture(extra),
      sessionStateCapture: isSessionStateCapture(extra),
      intentionalShareFrom,
      receivedAt: await receivedAt,
    };
    if (idempotencyKey === undefined) return textReply(await writeNote(toolContext, note));

    const { reply, replayed } = await withIngestKey(
      { orgId: ctx.orgId, actorType: "agent", actorId: cap.agentId },
      {
        key: idempotencyKey,
        label: "idempotencyKey",
        requestHash: ingestKeyRequestHash(note, role),
      },
      async () => ({ text: await writeNote(toolContext, note) }),
    );
    if (replayed) {
      // A replay writes nothing, but it is still this token's write call: one whose
      // write access was removed since the first call is refused, not answered.
      const decision = await check(ctx, { action: "memory.write", scope: target });
      if (!decision.allowed) throw new AccessDeniedError(decision);
    }
    return textReply(reply.text);
  } catch (e) {
    if (e instanceof StaleBaseVersionError) return staleRefusal(toolContext, e);
    return toolError(withOwnScopeHint(e, scopePath, cap.agentId));
  }
}

/** The line that opens the version a stale refusal carries. */
export const CURRENT_VERSION_HEADING = "The current version, whole, so you need no other read:";

/** The line that opens the version the refused write was based on, shown after the current one. */
export const BASE_VERSION_HEADING = "The version your write was based on, whole:";

/**
 * The version the refused write named as its base, described, or "" when it cannot be shown. It is
 * extra: without it the writer can still act on the current version, so a failure here never costs
 * the refusal that version.
 */
async function baseVersionSection(ctx: ToolContext["ctx"], baseVersionId: string): Promise<string> {
  try {
    const base = await readMemoryVersion(ctx, baseVersionId);
    if (!base) return "";
    const shared = (await derivedMarkersFor(ctx, [base.id])).get(base.id);
    return `\n\n${BASE_VERSION_HEADING}\n${describeVersion(base, shared)}`;
  } catch (e) {
    console.warn(`[mcp] stale refusal sent without base version ${baseVersionId}:`, e instanceof Error ? e.message : e);
    return "";
  }
}

/**
 * A stale refusal with the version that replaced the writer's base, served as memory_version
 * serves it: the same access decision, and recorded as read, so the agent has been shown it whole.
 * The base version follows, read the same way, because "keeping what it added" needs both texts:
 * the loser can then name the current version and its writer and settle its change from this one
 * reply. The base is not recorded as read: the writer read it before this reply, and nothing is
 * written back on it. A version it may not read, or one that cannot be read or recorded now,
 * leaves the bare refusal, which still tells it to read that version.
 */
async function staleRefusal({ ctx, cap }: ToolContext, refusal: StaleBaseVersionError): Promise<CallToolResult> {
  const refused = toolError(refusal);
  try {
    const version = await readMemoryVersion(ctx, refusal.currentVersionId);
    if (!version) return refused;
    const shared = (await derivedMarkersFor(ctx, [version.id])).get(version.id);
    const base = await baseVersionSection(ctx, refusal.baseVersionId);
    // Recorded last: a version recorded as read must be one this reply really shows.
    if (version.kind === "fact") await recordServedVersions(cap, [version.id]);
    return {
      ...refused,
      content: [
        {
          type: "text",
          text: `${refused.content[0]!.text}\n\n${CURRENT_VERSION_HEADING}\n${describeVersion(version, shared)}${base}`,
        },
      ],
    };
  } catch (e) {
    console.warn(
      `[mcp] stale refusal sent without version ${refusal.currentVersionId}:`,
      e instanceof Error ? e.message : e,
    );
    return refused;
  }
}

/**
 * The sentence a memory_ingest scope refusal ends with: how to write to the token's own scope.
 * It does not name that scope: a refusal names no registered scope path, the caller's own
 * included.
 */
const OWN_SCOPE_HINT =
  "If no one gave you that scope, omit scopePath to write to your own scope, the one your token defaults to.";

/**
 * A refusal of a write to a scopePath the caller chose, with the way to write anyway: leave
 * scopePath out and the write goes to the token's own scope. A model that invented a scope
 * path otherwise reads the bare refusal as having no permission at all and gives up (a local
 * qwen3:14b did on 2026-10-29, inventing one on 5 of its 7 saves).
 *
 * Only the two refusals that leaving scopePath out can change get the hint: the token's
 * capability does not cover the scope (`noCapability`), or the value is not a scope path
 * (`invalidCallerScopePath`). A whole-token refusal (agent deactivated, org being deleted, a
 * stale grant, ...) and a call that sent no scopePath are returned as they were. Whether the
 * scope sent was the token's own makes no difference, so the hint's presence says nothing
 * about which scope that is. The scope check itself is not touched: this only words the
 * reply to a write it already refused; the refused target stays in the audit half.
 */
function withOwnScopeHint(e: unknown, requested: string | undefined, agentId: string): unknown {
  if (!(e instanceof AccessDeniedError)) return e;
  const asked = normalizeScopePath(requested);
  if (asked === undefined || !scopeRefusal(e.decision.reason, asked, agentId)) return e;
  const refusal = e.decision.reason.endsWith(".") ? e.decision.reason : `${e.decision.reason}.`;
  return new AccessDeniedError({
    ...e.decision,
    reason: `${refusal} ${OWN_SCOPE_HINT}`,
  });
}

/** Whether `reason` refuses the scope a write named, not the token: see withOwnScopeHint. */
function scopeRefusal(reason: string, asked: string, agentId: string): boolean {
  if (reason === noCapability("write", agentId, asked).reason) return true;
  return [false, true].some((dashed) => reason === invalidCallerScopePath(asked, "scopePath", dashed).reason);
}

const textReply = (text: string) => ({ content: [{ type: "text" as const, text }] });

/** What one memory_ingest call writes, its scope already resolved. */
interface NoteWrite {
  content: string;
  name: string;
  kind?: (typeof CONVENTION_KINDS)[number];
  supersedes?: string;
  baseVersion?: string;
  role?: FactRole;
  /** When the content happened, validated and in UTC; undefined when the writer gave none. */
  occurredAt?: string;
  target: string;
  /** The task the session names, or undefined when it names none. */
  task?: string;
  /** The session the call belongs to, or undefined when neither the call nor its connection names one. */
  sessionKey?: string;
  /** Stored and announced, never extracted into the graph: a handoff or a session-state capture. */
  skipGraphExtraction: boolean;
  /** A session-state capture by the hook, whose replacements of itself are one episode. */
  sessionStateCapture: boolean;
  /** The scopes the writer declares it shares from, as sent. */
  intentionalShareFrom?: string[];
  /** When the call was received, on the database's clock; undefined when it could not be asked. */
  receivedAt?: string;
}

/**
 * The digest an idempotency key is claimed with: what the write stores, with `role` as the call
 * sent it (a handoff's default role is not part of it). baseVersion, role and occurredAt join it
 * only when sent, so a key claimed before any of them existed still matches its identical retry.
 */
function ingestKeyRequestHash(
  { content, name, target, kind, supersedes, baseVersion, occurredAt, intentionalShareFrom }: NoteWrite,
  role: FactRole | undefined,
): string {
  return ingestRequestHash([
    content,
    name,
    target,
    kind,
    supersedes,
    ...(baseVersion === undefined ? [] : [baseVersion]),
    ...(role === undefined ? [] : [`role:${role}`]),
    ...(occurredAt === undefined ? [] : [`occurredAt:${occurredAt}`]),
    ...(intentionalShareFrom === undefined
      ? []
      : [`intentionalShareFrom:${[...intentionalShareFrom].sort().join(",")}`]),
  ]);
}

/** Authorize and perform one memory_ingest write; returns the reply text. */
async function writeNote(
  { ctx, cap }: ToolContext,
  {
    content,
    name,
    kind,
    supersedes,
    baseVersion,
    role,
    occurredAt,
    target,
    task,
    sessionKey,
    skipGraphExtraction,
    sessionStateCapture,
    intentionalShareFrom,
    receivedAt,
  }: NoteWrite,
): Promise<string> {
  // Before anything is authorized or stored: a write carrying content from a scope its
  // readers cannot all read is refused here unless declared, and leaves only a deny row.
  const share: DerivedShare = await authorizeDerivedWrite(ctx, cap, target, intentionalShareFrom);
  // Enforce write permission through the same check() chokepoint. check()
  // only returns a decision + records the audit row — it does NOT throw on
  // deny (that's guardedMemory's job for reads). A read-only token must be
  // rejected here explicitly, or this write silently proceeds despite an
  // audited "deny" row.
  // A rule authorizes its own write (recordConvention runs check()), so the
  // ordinary check below would audit the same decision twice.
  const rule = kind
    ? await recordAuthorizedConvention(ctx, {
        kind,
        subject: name,
        text: content,
        scopePath: target,
        supersedes,
        task,
        sessionKey,
      })
    : null;
  // The visible allow row this write is authorized by, carried onto the change
  // event below so GET /api/audit can name the change it produced. A rule's text
  // is also stored as a fact, under the one decision that admitted the rule, so
  // that fact names the rule's row: a change with no authorization recorded would
  // leave "who allowed this?" unanswerable for it.
  let authorizedById = rule?.authorizedById;
  if (rule === null) {
    const decision = await check(ctx, { action: "memory.write", scope: target });
    if (!decision.allowed) {
      throw new AccessDeniedError(decision);
    }
    authorizedById = decision.auditLogId;
  }
  // The write pipeline is loaded here, not at the top of the file: the Inngest barrel
  // carries every background job and its clients, and agent naming carries the Unicode
  // confusables table. A cold /api/mcp instance should not pay for either on a call
  // that never writes (app/api/mcp/route.cold-start.test.ts).
  const [{ fallbackAgentName, resolveAgentNames }, { ingestMemory }] = await Promise.all([
    import("@/services/audit/actor-names"),
    import("@/lib/inngest"),
  ]);
  // The fact's citation names the agent the way the audit log and the
  // Timeline do, so all three answer "who wrote this" alike.
  const actorName = (await resolveAgentNames(ctx.orgId, [cap.agentId]))[cap.agentId] ?? fallbackAgentName(cap.agentId);
  // Same pipeline as memoryWriteTool (services/agents/tools.ts) — queued through
  // Inngest so entity resolution + distillation run, not a raw store write.
  const ingest = ingestMemory({
    groupId: ctx.orgId,
    content,
    name,
    actorType: "agent",
    origin: ctx.origin,
    actorId: cap.agentId,
    actorName,
    source: "mcp",
    scopePath: target,
    authorizedById,
    baseVersion,
    readsTracked: true,
    task,
    sessionKey,
    role,
    ...(occurredAt === undefined ? {} : { occurredAt }),
    ...(receivedAt === undefined ? {} : { receivedAt }),
    ...(skipGraphExtraction ? { skipGraphExtraction } : {}),
    ...(sessionStateCapture ? { sessionStateCapture } : {}),
    ...(share.edgeTargets.length > 0 ? { derivedFromTargets: share.edgeTargets } : {}),
  });
  // A rule is recorded in its own transaction before its fact copy is written. When the copy
  // then fails, however it fails, the reply says the rule is recorded and how to store the
  // copy alone: sending the same call again would record the rule twice. A plain fact's
  // failure is answered by toolError (not_stored: send it again).
  const ack = rule ? await ingest.catch((e: unknown) => new RuleCopyNotStored(e)) : await ingest;
  if (ack instanceof RuleCopyNotStored) {
    return `${ruleRecordedReply(kind!, rule!.id, target)}${rule!.kept ? ` ${keptRuleReply(kind!, rule!.kept, rule!.id)}` : ""} ${ruleCopyNotStoredReply(ack.cause, supersedes !== undefined)}`;
  }
  await announceDerivedWrite(ctx, cap, share, { target, versionId: ack?.versionId });
  // Usually the agent's own new version, which counts as seen anyway. But a write whose
  // text matches a version already stored, another writer's included, stores nothing and
  // is answered with that version: the agent has seen it whole, by sending it.
  if (ack?.versionId && !rule) await recordServedVersions(cap, [ack.versionId], { ownWrite: true });
  const stored = storedReply(ack, name);
  const beside = ack?.keptBeside ? ` ${keptBesideReply(ack.keptBeside, rule !== null)}` : "";
  const shared = share.from.length > 0 ? ` ${sharedReply(share.from)}` : "";
  if (rule)
    return `${ruleRecordedReply(kind!, rule.id, target)}${rule.kept ? ` ${keptRuleReply(kind!, rule.kept, rule.id)}` : ""} ${stored}${beside}${shared}`;
  const dateNote =
    ack?.storedDateKept && ack.versionId
      ? ` ${storedDateNote(ack.versionId, ack.storedDateKept.occurredAt, occurredAt !== undefined)}`
      : "";
  return ack?.versionId
    ? `${stored} Version: ${ack.versionId}.${dateNote}${beside}${shared}`
    : `${stored}${beside}${shared}`;
}

/** The failed write of a recorded rule's fact copy, kept apart from an ingest's reply. */
class RuleCopyNotStored {
  constructor(readonly cause: unknown) {}
}

/**
 * What a rule's reply says when the rule was recorded but the fact copy of its text, which
 * memory_query searches, was not stored: why, and how to store the copy without recording the
 * rule again. The rule is served either way. Until a copy is stored, a read can still serve the
 * copy of the rule this one `replaced`.
 */
function ruleCopyNotStoredReply(cause: unknown, replaced: boolean): string {
  if (cause instanceof StaleBaseVersionError) return staleRuleCopyReply(cause, replaced);
  const why = cause instanceof VersionNotStoredError ? cause.reason : toolError(cause).content[0]!.text;
  return (
    `The rule is recorded and served, but the fact copy of its text that memory_query searches was not stored (${why}). ` +
    "Do not send this call again: it would record the rule a second time. To store the copy, send memory_ingest with the same content, name and scopePath and without kind or supersedes." +
    (replaced ? " Until then memory_query can still serve the text of the rule this one replaced." : "")
  );
}

/**
 * The same reply when the copy named a stale base. A rule is already recorded and a person may be
 * asked to confirm it, so the plain refusal's words ("Nothing was stored", settling the change)
 * do not hold here: this says only what became of the copy.
 */
function staleRuleCopyReply(
  { baseVersionId, currentVersionId, storedVersionId, rule }: StaleBaseVersionError,
  replaced: boolean,
): string {
  const again = "Do not send this call again: it would record the rule a second time.";
  const person = rule
    ? ` ${currentVersionId} is the copy of ${rule.kind} ${rule.ruleId}, which a person recorded or confirmed.`
    : "";
  if (storedVersionId) {
    return `The rule is recorded and served, and its fact copy was stored as ${storedVersionId}, but ${currentVersionId} replaced it first, so memory_query serves ${currentVersionId}.${person} ${again}`;
  }
  return (
    `The rule is recorded and served, but the fact copy of its text that memory_query searches was not stored, because baseVersion ${baseVersionId} is out of date: ${currentVersionId} replaced it.${person} ${again} ` +
    (rule
      ? `To store the copy beside ${currentVersionId}, read it with memory_version, then send memory_ingest with the same content, name and scopePath, baseVersion ${currentVersionId}, and without kind or supersedes.`
      : `To store the copy on ${currentVersionId}, read it with memory_version, then send memory_ingest with the same content, name and scopePath, baseVersion ${currentVersionId}, and without kind or supersedes.`) +
    (replaced ? " Until then memory_query can still serve the text of the rule this one replaced." : "")
  );
}

/**
 * The page where a person confirms the rule `id` (app/(app)/memory/confirm/[id]/page.tsx), on
 * the public origin NEXT_PUBLIC_APP_URL names, or on localhost for a local install without it.
 */
function ruleConfirmUrl(id: string): string {
  const origin = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, "") || "http://localhost:3000";
  return `${origin}/memory/confirm/${encodeURIComponent(id)}`;
}

/**
 * What the reply adds when a write based on the copy of a person's rule was kept beside it
 * (services/memory/person-rule-copy.ts). Unless the write was itself a new rule, it names the way
 * to change the rule.
 */
function keptBesideReply({ versionId, ...rule }: NonNullable<IngestAck["keptBeside"]>, proposed: boolean): string {
  const { ruleId, kind } = rule;
  return (
    `It did not replace ${versionId}: that is the copy of ${kind} ${ruleId}, which a person recorded or confirmed, so memory_query serves it first and this beside it as a lead.` +
    (proposed ? "" : ` To change the ${kind} itself, ${changeTheRule(rule)}`)
  );
}

/**
 * What the reply says about a rule an agent just recorded. A rule an agent records is not
 * settled until a person confirms it (services/memory/claim-status.ts): a decision is served
 * as a lead to verify, and the reply says so and hands over the confirm link, so the agent
 * can ask its person instead of telling them their decision is now a standing rule. Every
 * reply opens `Recorded <kind> <id>;`, the shape measure scripts read the rule's id from.
 */
function ruleRecordedReply(kind: (typeof CONVENTION_KINDS)[number], id: string, target: string): string {
  const link = ruleConfirmUrl(id);
  if (kind === "decision") {
    return (
      `Recorded decision ${id}; it is proposed in ${target}, not yet a standing rule: until a person confirms it, every session there is served it as a lead to verify. ` +
      `Ask the person to open ${link} and choose Confirm decision.`
    );
  }
  return `Recorded convention ${id}; it is served at the start of every session in ${target}. A person can confirm it as theirs at ${link}.`;
}

/**
 * What the reply adds when the rule this write named in `supersedes` was recorded or confirmed
 * by a person: it was not replaced, and the new rule `id` is served beside it. An agent's
 * decision is served as a lead; an agent's convention is in force like any convention, tagged
 * as agent-recorded (mcp/task-start-notice.ts).
 */
function keptRuleReply(kind: (typeof CONVENTION_KINDS)[number], kept: string, id: string): string {
  const served =
    kind === "decision"
      ? `both are served, ${kept} as settled and ${id} beside it as a lead`
      : `both are served at the start of every session there, ${id} tagged as agent-recorded`;
  return (
    `It did not replace ${kept}: a person recorded or confirmed that rule, so only that person or an owner or admin ` +
    `of this organization can replace it, and ${served}. ` +
    `To have yours replace it, ask one of them to confirm ${id} at ${ruleConfirmUrl(id)} and retire ${kept}.`
  );
}

/** What the reply says about a declared share: what was recorded, so the writer is never surprised by it. */
function sharedReply(from: readonly string[]): string {
  return `Shared from ${from.join(", ")} as declared: recorded in the audit log, marked on the fact, and announced to the readers of ${from.length === 1 ? "that scope" : "those scopes"}.`;
}

/**
 * What the reply says when the same text was already stored with another date than this
 * write would have had. Nothing was written, so the stored version's date stands.
 */
function storedDateNote(versionId: string, storedOccurredAt: string | null, statedOne: boolean): string {
  const kept = storedOccurredAt ? `dated ${storedOccurredAt} as its writer stated` : "dated by when it was stored";
  return statedOne
    ? `occurredAt was not applied: this text was already stored as version ${versionId}, ${kept}.`
    : `This text was already stored as version ${versionId}, ${kept}; that date stands.`;
}

/**
 * What the reply says about the stored note: readable now, superseded as it was stored
 * (naming the version reads return instead), or queued. A mocked ingestMemory returns
 * nothing; that reads as the queued case.
 *
 * Readable now, it also says where graph extraction stands, and only what is true on this
 * path (`IngestAck.graphExtraction`). On the hosted server it continues after the reply
 * (`after()` or the Inngest job). The stdio server has no request scope for `after()`, so its
 * ingest ran before the reply and the reply says how it ended. A write that skips extraction
 * says nothing of it, and a write whose text was already stored says so instead.
 */
function storedReply(ack: IngestAck | undefined, name: string): string {
  if (ack?.supersededBy) {
    return `Stored, but superseded by ${ack.supersededBy}: another writer stored a version of "${name}" in this scope first, inside the conflict window, so memory_query returns that version. Read it with memory_version.`;
  }
  if (!ack?.readableNow) return "Stored. Queued for ingest — will appear in memory shortly.";
  switch (ack.graphExtraction) {
    case undefined:
      return "Stored and readable now; graph extraction continues in the background.";
    case "completed":
      return "Stored and readable now; graph extraction has completed.";
    case "kept":
      return "Stored and readable now; graph extraction failed and will be attempted again.";
    case "failed":
      return "Stored and readable now; graph extraction failed, so the fact is not in the graph.";
    case "none":
      return "Stored and readable now.";
    case "earlier":
      return "Already stored and readable now: an earlier write stored the same text, so nothing was written.";
  }
}
