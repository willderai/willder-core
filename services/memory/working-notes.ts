// Working notes: what an agent is doing right now, posted so other agents can see it.
//
// A fact is what an agent finished; a working note is what it has started. "I am fixing
// the retry dedupe", "trying the advisory-lock approach", "is Thursday still the cut?".
// Agents duplicate each other's work when they can only see results, so a note is posted
// at the start, renewed while the work goes on, and released at the end.
//
// A note reaches other agents through paths they already use: each post, renewal and
// release appends a change event in the same transaction as the note itself, so the
// change feed's cursor, access filter and notices carry it (services/memory/change-feed.ts,
// mcp/change-notices.ts), and the task-start block lists the notes live in the scope
// (services/memory/task-start.ts). A note is never ingested, embedded or extracted, and
// never becomes a fact on its own.
//
// The one rule this file enforces: a note is live only until it expires or is released,
// and that is decided when it is read (`expiresAt > now()`), never by a job. Expired and
// released rows are kept.
//
// Two agents claiming the same task is detected and reported, never resolved: both
// claims are stored, and the later poster is told about the earlier one. Each post holds
// the org's change-feed lock from its first read to its commit, so posts in one org run
// one at a time: of two agents claiming at the same moment the second always sees the
// first, and one agent posting the same note twice at once renews it rather than holding
// two.
//
// A claim can also carry the files its agent edits, and two claims sharing a file are told
// of each other the same way, detected and never resolved (services/memory/claim-overlap.ts).
import { db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import type { WorkingNoteKind } from "@/lib/generated/prisma/enums";
import { AccessDeniedError, can, check, type AccessContext } from "@/services/access";
import { lockOrgChangeFeed, recordChangeEvent, recordChangeEvents } from "./change-events";
import { unstorableText } from "@/lib/unstorable-text";
import {
  CLAIM_OVERLAP_RECORD_TYPE,
  MAX_TOUCHES,
  addedTouches,
  checkTouches,
  loadClaimOverlap,
  lowestCommonScope,
  overlapTitle,
  sharedTouches,
} from "./claim-overlap";

export type { WorkingNoteKind };

/** Every kind, for input validation. */
export const WORKING_NOTE_KINDS = [
  "claim",
  "intent",
  "status",
  "question",
] as const satisfies readonly WorkingNoteKind[];

/** The change feed's `recordType` for a working note. */
export const WORKING_NOTE_RECORD_TYPE = "note";

/** Longest note body, in characters (code points). */
export const NOTE_BODY_MAX_CHARS = 280;
/**
 * Longest task name a note can be about, in characters (code points). As long as the task a
 * session may name (`willder/task`, mcp/task-start-notice.ts), so a note that takes its task
 * from the session is never refused for a length the agent did not choose.
 */
const NOTE_TASK_MAX_CHARS = 512;
/** How long a note lives when the poster does not say. */
export const NOTE_DEFAULT_MINUTES = 30;
/** The longest a note can live before it must be renewed. */
export const NOTE_MAX_MINUTES = 240;

/** Most earlier claims one post reports. */
const MAX_EARLIER_CLAIMS = 5;
/**
 * Most other claims one post tells of an overlap. Past it the rest are not told; at about 50
 * live claims in an org, every claim fits.
 */
const MAX_OVERLAPPING_CLAIMS = 50;
/** The body of a claim a post makes from touches alone, when the agent wrote none. */
const TOUCHES_ONLY_BODY = "Editing files for this task; the list is recorded from its edits.";

/** A note refused for its own content, with a message that says how to fix it. */
export class InvalidWorkingNoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWorkingNoteError";
  }
}

/**
 * The note a post was renewing was deleted after the post read it and before it could be
 * updated, by something that removes notes without the agent's note lock. Nothing was
 * written; posting again starts a new note.
 */
export class WorkingNoteGoneError extends Error {
  constructor(task: string) {
    super(
      `Your note on "${task}" no longer exists: it was removed while this post was renewing it, and nothing was written. Post it again to start a new note.`,
    );
    this.name = "WorkingNoteGoneError";
  }
}

/**
 * A post that carried only touches, for a task whose claim its agent released: touches record
 * what a claim edits, and never claim the task again on their own. Nothing was written.
 */
export class ClaimReleasedError extends Error {
  constructor(task: string) {
    super(
      `You released your claim on "${task}", so touches alone do not claim it again and nothing was written. Post a body to claim it.`,
    );
    this.name = "ClaimReleasedError";
  }
}

/**
 * A post that carried only touches, in an org with claim overlap off: there was nothing else
 * to write, so nothing was written. The hook stops sending touches for the session.
 */
export class ClaimOverlapOffError extends Error {
  constructor() {
    super(
      "Claim overlap is off for this org, so touches are not recorded and nothing was written. Post a body to claim the task.",
    );
    this.name = "ClaimOverlapOffError";
  }
}

/** A working note as a caller sees it. */
export interface WorkingNoteView {
  id: string;
  scopePath: string;
  agentId: string;
  task: string;
  kind: WorkingNoteKind;
  body: string;
  expiresAt: Date;
  createdAt: Date;
  /** The files a claim's agent edits, as node ids; empty for every other note. */
  touches: string[];
}

/** What one post asks for. The scope is already resolved; the poster is `ctx`'s actor. */
export interface PostWorkingNoteInput {
  scopePath: string;
  task: string;
  kind: WorkingNoteKind;
  /**
   * The note's line. May be omitted only on a claim that carries `touches`: a renewal then
   * keeps the body it had, and a new claim gets {@link TOUCHES_ONLY_BODY}.
   */
  body?: string;
  /** Defaults to {@link NOTE_DEFAULT_MINUTES}; at most {@link NOTE_MAX_MINUTES}. */
  expiresInMinutes?: number;
  /**
   * For a claim, files its agent edits, as `file:<repo>/<path>` node ids. With a body they
   * replace the claim's earlier set; without one (the hook's post) they are added to it.
   * Omitted keeps the set the claim has. Stored and compared only when the org has claim overlap on.
   */
  touches?: readonly string[];
}

/** Another agent's live claim that shares files with the poster's. */
export interface ClaimOverlap {
  claim: WorkingNoteView;
  /** The files this post added that the other claim already touches. */
  shared: string[];
}

/** What a post did. */
export interface PostedWorkingNote {
  note: WorkingNoteView;
  /** True when the poster already had this note live and the post renewed it. */
  renewed: boolean;
  /**
   * For a claim: other agents' live claims on the same task that the poster may read,
   * oldest first. Empty for every other kind.
   */
  earlierClaims: WorkingNoteView[];
  /**
   * What happened to the touches the post carried: `off` when the org has claim overlap off
   * and they were dropped, else how many were withheld as possibly secret. Null when the post
   * carried none.
   */
  touches: { recorded: false; reason: "off" } | { recorded: true; withheld: number; refused: number } | null;
  /**
   * Other agents' live claims, on other tasks and in scopes the poster may read, that already
   * touch a file this post added, oldest first. Empty unless the post added files.
   */
  overlaps: ClaimOverlap[];
}

/** Which of the poster's notes a release ends: the one live of this kind, on this task, in this scope. */
export interface ReleaseWorkingNoteInput {
  scopePath: string;
  task: string;
  kind: WorkingNoteKind;
}

/**
 * A task name as notes store and compare it: control characters and runs of whitespace
 * become one space, trimmed. Two names that differ only in spacing name one task.
 */
export function noteTaskKey(task: string): string {
  return task.replace(/[\p{Cc}\s]+/gu, " ").trim();
}

function normalizeTask(task: string): string {
  const cleaned = noteTaskKey(task);
  if (cleaned === "") throw new InvalidWorkingNoteError("task is empty: name what the note is about.");
  const length = Array.from(cleaned).length;
  if (length > NOTE_TASK_MAX_CHARS) {
    throw new InvalidWorkingNoteError(
      `task is ${length} characters; at most ${NOTE_TASK_MAX_CHARS}. Name the task, not the work: put the detail in body.`,
    );
  }
  return cleaned;
}

function validBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed === "") throw new InvalidWorkingNoteError("a post needs a body: one line saying what you are doing.");
  const length = Array.from(trimmed).length;
  if (length > NOTE_BODY_MAX_CHARS) {
    throw new InvalidWorkingNoteError(
      `body is ${length} characters; a working note holds at most ${NOTE_BODY_MAX_CHARS}. Shorten it, or keep the detail as a fact with memory_ingest.`,
    );
  }
  const unstorable = unstorableText({ body: trimmed });
  if (unstorable) throw new InvalidWorkingNoteError(unstorable.message);
  return trimmed;
}

function validMinutes(minutes: number | undefined): number {
  if (minutes === undefined) return NOTE_DEFAULT_MINUTES;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > NOTE_MAX_MINUTES) {
    throw new InvalidWorkingNoteError(
      `expiresInMinutes is ${minutes}; a working note lives from 1 to ${NOTE_MAX_MINUTES} minutes. Post it again before it expires to keep it live.`,
    );
  }
  return minutes;
}

/** An instant to the second, as notes are shown: `2026-10-07T15:30:00Z`. */
export function noteTime(at: Date): string {
  return `${at.toISOString().slice(0, 19)}Z`;
}

/** The change event's title for a post or renewal; summarizeChange cuts it to one line. */
const postedTitle = (note: WorkingNoteView): string =>
  `${note.kind} on ${note.task} until ${noteTime(note.expiresAt).slice(0, 16)}Z: ${note.body}`;

const NOTE_COLUMNS = {
  id: true,
  scopePath: true,
  agentId: true,
  task: true,
  kind: true,
  body: true,
  expiresAt: true,
  createdAt: true,
  touches: true,
} as const;

/**
 * Advisory-lock namespace for one agent's note writes. Postgres advisory locks share one
 * server-wide space; the two-key form keeps this apart from every other lock
 * (services/memory/change-events.ts uses 8_241_001): the first key names the purpose,
 * the second the agent.
 */
const AGENT_NOTES_LOCK_NAMESPACE = 8_241_004;

/**
 * Take `agentId`'s note lock in `orgId` for the rest of the transaction. A post reads the
 * agent's live note of a kind on a task and renews it, a release reads it and ends it, so
 * two calls by the same agent must not interleave, or a burst could store two live notes
 * where one should be renewed. Other agents never wait on it. Anything else that deletes an
 * agent's notes takes it first too (person erasure), so a renewal never updates a note
 * deleted after it was read.
 */
export async function lockAgentNotes(tx: Prisma.TransactionClient, orgId: string, agentId: string): Promise<void> {
  // `hashtext` narrows (org, agent) to int4, so two agents can collide; a collision only
  // makes them wait for each other. Called in FROM because the function returns void,
  // which the Prisma pg adapter cannot read back as a column.
  await tx.$queryRaw`
    SELECT true AS locked
    FROM pg_advisory_xact_lock(${AGENT_NOTES_LOCK_NAMESPACE}::int4, hashtext(${orgId} || '/' || ${agentId})::int4)
  `;
}

/**
 * Update the note `id` that this transaction read, and return it; null when it was deleted
 * since. Person erasure takes the agent's note lock before deleting notes, so it never
 * deletes one here, but a deleter that does not would otherwise surface as Prisma's
 * "record to update not found" (P2025). Once updated, the row stays locked to commit.
 */
async function updateReadNote(
  tx: Prisma.TransactionClient,
  id: string,
  data: Prisma.WorkingNoteUpdateManyMutationInput,
): Promise<WorkingNoteView | null> {
  const { count } = await tx.workingNote.updateMany({ where: { id }, data });
  return count === 0 ? null : tx.workingNote.findUniqueOrThrow({ where: { id }, select: NOTE_COLUMNS });
}

/** Advisory-lock namespace for deleting notes in one org; the second key names the org. */
const NOTE_DELETIONS_LOCK_NAMESPACE = 8_241_005;

/**
 * Take `orgId`'s note-deletion lock for the rest of the transaction. Anything that deletes
 * notes takes it before any agent's note lock (person-erasure.ts, deleteWorkingNotes), so
 * deletions in one org take turns and only one transaction there ever holds several agents'
 * locks: two that each held an agent the other waits on would deadlock (two erasures whose
 * notes were posted by crossing agents, or two agents whose lock keys collide). A post or
 * release takes only its own agent's lock, never this one.
 */
export async function lockNoteDeletions(tx: Prisma.TransactionClient, orgId: string): Promise<void> {
  await tx.$queryRaw`
    SELECT true AS locked
    FROM pg_advisory_xact_lock(${NOTE_DELETIONS_LOCK_NAMESPACE}::int4, hashtext(${orgId})::int4)
  `;
}

/**
 * A Prisma filter matching `task` by name, ignoring case. Prisma renders a
 * case-insensitive `equals` as Postgres `ILIKE`, where `%`, `_` and `\` are
 * pattern syntax, so they are escaped here: a task named `fix_auth` must not
 * also match `fixXauth`.
 */
function sameTaskName(task: string) {
  return { equals: task.replace(/[\\%_]/g, "\\$&"), mode: "insensitive" as const };
}

/**
 * Post a working note as `ctx`'s actor, or renew the one it already has live of the same
 * kind on the same task in the same scope.
 *
 * Needs memory.write on the scope, decided by the audited check(). A renewal replaces
 * the body and sets the expiry afresh from now. The note and its change event (`create`,
 * or `update` for a renewal) commit together. A claim also reads other agents' live
 * claims on the same task, matched without regard to case, and returns the ones the
 * poster may read.
 *
 * A claim may carry `touches` (services/memory/claim-overlap.ts). With the org's claim
 * overlap on, they replace the claim's set, and other agents' live claims on other tasks that
 * touch a file this post added are each told through one change event, and those in scopes
 * the poster may read are returned. A post
 * with touches and no body keeps the claim's body and never shortens its life; it records no
 * change event for the note itself when it renews one, because the note's text did not change.
 *
 * @throws AccessDeniedError when the actor may not write the scope.
 * @throws InvalidWorkingNoteError when the task, body, expiry or touches are out of bounds.
 * @throws ClaimOverlapOffError when the post carried touches and no body, and the org has claim overlap off.
 * @throws ClaimReleasedError when the post carried touches and no body for a claim its agent released.
 */
export async function postWorkingNote(ctx: AccessContext, input: PostWorkingNoteInput): Promise<PostedWorkingNote> {
  const task = normalizeTask(input.task);
  const touchesOnly = input.body === undefined;
  if (touchesOnly && (input.kind !== "claim" || input.touches === undefined)) {
    throw new InvalidWorkingNoteError("a post needs a body: one line saying what you are doing.");
  }
  const body = touchesOnly ? null : validBody(input.body!);
  const minutes = validMinutes(input.expiresInMinutes);
  const checked = input.touches === undefined ? null : validTouches(input.kind, input.touches);

  const decision = await check(ctx, { action: "memory.write", scope: input.scopePath });
  if (!decision.allowed) throw new AccessDeniedError(decision);
  const touching = checked !== null && (await loadClaimOverlap(ctx.orgId));
  if (touchesOnly && !touching) throw new ClaimOverlapOffError();

  const { note, renewed, candidates, overlapping } = await db.$transaction(async (tx) => {
    // Only this agent's own note writes wait here. The org's change-feed lock comes later,
    // with the change event, so every other writer in the org waits only for the event and
    // the claim read, not for this note's own row work.
    await lockAgentNotes(tx, ctx.orgId, ctx.actor.id);
    const now = new Date();
    const fresh = new Date(now.getTime() + minutes * 60 * 1000);
    const live = { releasedAt: null, expiresAt: { gt: now } };
    const sameTask = sameTaskName(task);

    const own = touchesOnly
      ? await ownClaimForTouches(tx, ctx, input.scopePath, sameTask, now, task, checked!.touches)
      : await tx.workingNote.findFirst({
          where: {
            orgId: ctx.orgId,
            agentId: ctx.actor.id,
            scopePath: input.scopePath,
            kind: input.kind,
            task: sameTask,
            ...live,
          },
          select: { id: true, expiresAt: true, touches: true },
        });
    // Touches alone only add to what the claim says: they keep its body, add to its files
    // rather than replace them (two hooks of one session can send at once, each with its
    // own list), and keep its life when the agent asked for a longer one than the hook's default.
    const expiresAt = touchesOnly && own && own.expiresAt > fresh ? own.expiresAt : fresh;
    const touches = touching
      ? { touches: touchesOnly && own ? mergedTouches(own.touches, checked.touches) : checked.touches }
      : {};
    const note = own
      ? await updateReadNote(tx, own.id, { ...(body === null ? {} : { body }), expiresAt, ...touches })
      : await tx.workingNote.create({
          data: {
            orgId: ctx.orgId,
            scopePath: input.scopePath,
            agentId: ctx.actor.id,
            task,
            kind: input.kind,
            body: body ?? TOUCHES_ONLY_BODY,
            expiresAt,
            ...touches,
          },
          select: NOTE_COLUMNS,
        });
    if (!note) throw new WorkingNoteGoneError(task);
    const added = touching ? addedTouches(own?.touches ?? [], note.touches) : [];
    const event = {
      orgId: ctx.orgId,
      actorId: ctx.actor.id,
      actorType: ctx.actor.type,
      origin: ctx.origin,
      authorizedById: decision.auditLogId,
    };
    if (!(touchesOnly && own)) {
      await recordChangeEvent(tx, {
        ...event,
        scopePath: note.scopePath,
        recordType: WORKING_NOTE_RECORD_TYPE,
        recordId: note.id,
        op: own ? "update" : "create",
        title: postedTitle(note),
      });
    } else if (added.length > 0) {
      // A renewal that records no event of its own still reads the claims below under the
      // org's change-feed lock, so of two posts adding the same file at once the later sees the earlier.
      await lockOrgChangeFeed(tx, ctx.orgId);
    }

    // recordChangeEvent holds the org's change-feed lock from here to commit, and every note
    // write records its event under that lock, so the claims visible now are exactly those
    // committed before this post: of two concurrent claims, the later one always sees the
    // earlier. For a renewal, earlier also means made before the poster's own claim, so a
    // claim that came after it is never reported as the earlier one. A renewal from touches
    // alone was told of these when its claim was made, so it is not told again.
    const candidates =
      input.kind === "claim" && !(touchesOnly && own)
        ? await readableClaims(
            tx,
            ctx,
            {
              orgId: ctx.orgId,
              kind: "claim",
              agentId: { not: ctx.actor.id },
              task: sameTask,
              ...live,
              ...(own ? { createdAt: { lt: note.createdAt } } : {}),
            },
            MAX_EARLIER_CLAIMS,
          )
        : [];

    // Claims on the same task were just reported as a collision; an overlap is about other work.
    // The poster is shown the overlapping claims it may read, filtered before the limit so
    // claims it cannot read never take a place. Every overlapping claim's agent is told, read
    // or not, by one batched insert of change events, each filed where only readers of both
    // claims see it; a claim with no common scope is told nothing (its reply is the only notice).
    const overlapsWhere: Prisma.WorkingNoteWhereInput = {
      orgId: ctx.orgId,
      kind: "claim",
      agentId: { not: ctx.actor.id },
      NOT: { task: sameTask },
      touches: { hasSome: added },
      ...live,
    };
    const readable = added.length === 0 ? [] : await readableClaims(tx, ctx, overlapsWhere, MAX_OVERLAPPING_CLAIMS);
    const unread =
      added.length === 0
        ? []
        : await tx.workingNote.findMany({
            where: {
              ...overlapsWhere,
              id: { notIn: readable.map((c) => c.id) },
              scopePath: { notIn: [...new Set(readable.map((c) => c.scopePath))] },
            },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: MAX_OVERLAPPING_CLAIMS,
            select: { id: true, scopePath: true, agentId: true, createdAt: true, touches: true },
          });
    await recordChangeEvents(
      tx,
      [...readable, ...unread].flatMap((other) => {
        const scopePath = lowestCommonScope(note.scopePath, other.scopePath);
        if (scopePath === null) return [];
        const title = overlapTitle({ task: note.task, other, shared: sharedTouches(added, other.touches) });
        return [
          {
            ...event,
            scopePath,
            recordType: CLAIM_OVERLAP_RECORD_TYPE,
            recordId: note.id,
            op: "create" as const,
            title,
          },
        ];
      }),
    );
    return {
      note,
      renewed: own !== null,
      candidates,
      overlapping: readable.map((claim) => ({ claim, shared: sharedTouches(added, claim.touches) })),
    };
  });

  const disclosed = await authorizedForDisclosure(ctx, [...candidates, ...overlapping.map((o) => o.claim)]);
  const shown = new Set(disclosed.map((claim) => claim.id));
  return {
    note,
    renewed,
    earlierClaims: candidates.filter((claim) => shown.has(claim.id)),
    touches:
      checked === null
        ? null
        : touching
          ? { recorded: true, withheld: checked.withheld, refused: checked.refused }
          : { recorded: false, reason: "off" },
    overlaps: overlapping.filter((o) => shown.has(o.claim.id)),
  };
}

/** `touches` as a claim stores them ({@link checkTouches}); refused on any other kind of note. */
function validTouches(
  kind: WorkingNoteKind,
  touches: readonly string[],
): { touches: string[]; withheld: number; refused: number } {
  if (kind !== "claim")
    throw new InvalidWorkingNoteError(`touches belong to a claim, not a ${kind}: post them with kind "claim".`);
  const checked = checkTouches(touches);
  if ("problem" in checked) throw new InvalidWorkingNoteError(checked.problem);
  return checked;
}

/**
 * The oldest `limit` claims matching `where` in scopes `ctx` may read.
 * Readability is decided per scope with can(), which writes no audit row, and the claims
 * are then read from the readable scopes only, so claims the actor cannot see never take
 * a place in the limit.
 */
async function readableClaims(
  tx: Prisma.TransactionClient,
  ctx: AccessContext,
  where: Prisma.WorkingNoteWhereInput,
  limit: number,
): Promise<WorkingNoteView[]> {
  const scopes = await tx.workingNote.findMany({ where, distinct: ["scopePath"], select: { scopePath: true } });
  const readable: string[] = [];
  for (const { scopePath } of scopes) {
    if ((await can(ctx, { action: "memory.read", scope: scopePath })).allowed) readable.push(scopePath);
  }
  if (readable.length === 0) return [];
  return tx.workingNote.findMany({
    where: { ...where, scopePath: { in: readable } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit,
    select: NOTE_COLUMNS,
  });
}

/**
 * The poster's claim on `task` that a post of touches alone renews: its newest one on the task
 * in `scopePath` or a scope below it, since the hook names no scope and the agent may have
 * claimed in a narrower one. Null when it has none live and may make one. Touches alone never
 * undo a release, and never make a claim from an empty list.
 *
 * @throws ClaimReleasedError when the newest such claim was released.
 * @throws InvalidWorkingNoteError when there is none live and `touches` is empty.
 */
async function ownClaimForTouches(
  tx: Prisma.TransactionClient,
  ctx: AccessContext,
  scopePath: string,
  sameTask: ReturnType<typeof sameTaskName>,
  now: Date,
  task: string,
  touches: readonly string[],
): Promise<{ id: string; expiresAt: Date; touches: string[] } | null> {
  const claims = await tx.workingNote.findMany({
    where: { orgId: ctx.orgId, agentId: ctx.actor.id, kind: "claim", task: sameTask },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 50,
    select: { id: true, scopePath: true, expiresAt: true, releasedAt: true, touches: true },
  });
  const within = claims.filter((c) => c.scopePath === scopePath || c.scopePath.startsWith(`${scopePath}.`));
  const live = within.find((c) => c.releasedAt === null && c.expiresAt > now);
  if (live) return live;
  if (within[0]?.releasedAt) throw new ClaimReleasedError(task);
  if (touches.length === 0)
    throw new InvalidWorkingNoteError("touches is empty: a claim from touches alone needs at least one file.");
  return null;
}

/** `sent` added to `stored`, at most {@link MAX_TOUCHES}: the files just sent first, then the earlier ones that still fit. */
function mergedTouches(stored: readonly string[], sent: readonly string[]): string[] {
  const merged = [...new Set([...sent, ...stored])].slice(0, MAX_TOUCHES);
  return merged.sort();
}

/**
 * `notes`, each scope they come from authorized with the audited check() before it is
 * shown, so every disclosure leaves an audit row. A scope revoked since can() said yes
 * is dropped.
 */
async function authorizedForDisclosure(ctx: AccessContext, notes: WorkingNoteView[]): Promise<WorkingNoteView[]> {
  const allowed = new Set<string>();
  for (const scope of new Set(notes.map((note) => note.scopePath))) {
    if ((await check(ctx, { action: "memory.read", scope })).allowed) allowed.add(scope);
  }
  return notes.filter((note) => allowed.has(note.scopePath));
}

/**
 * End `ctx`'s actor's live note of `kind` on `task` in the scope. The release and its
 * `delete` change event commit together.
 *
 * Needs memory.write on the scope, like a post. Returns the released note, or null when
 * the actor had no such note live: releasing twice is not an error.
 *
 * @throws AccessDeniedError when the actor may not write the scope.
 */
export async function releaseWorkingNote(
  ctx: AccessContext,
  input: ReleaseWorkingNoteInput,
): Promise<WorkingNoteView | null> {
  const task = normalizeTask(input.task);
  const decision = await check(ctx, { action: "memory.write", scope: input.scopePath });
  if (!decision.allowed) throw new AccessDeniedError(decision);

  return db.$transaction(async (tx) => {
    // The agent's lock first, as a post takes it: a release and a renewal of the same note
    // each lock the note's row and then the org lock recordChangeEvent takes, so without
    // it they could deadlock. Only the note's own agent can do either.
    await lockAgentNotes(tx, ctx.orgId, ctx.actor.id);
    const now = new Date();
    const own = await tx.workingNote.findFirst({
      where: {
        orgId: ctx.orgId,
        agentId: ctx.actor.id,
        scopePath: input.scopePath,
        kind: input.kind,
        task: sameTaskName(task),
        releasedAt: null,
        expiresAt: { gt: now },
      },
      select: { id: true },
    });
    if (!own) return null;
    // Deleted since it was read: there is nothing left to release, as when it was never there.
    const note = await updateReadNote(tx, own.id, { releasedAt: now });
    if (!note) return null;
    await recordChangeEvent(tx, {
      orgId: ctx.orgId,
      scopePath: note.scopePath,
      recordType: WORKING_NOTE_RECORD_TYPE,
      recordId: note.id,
      op: "delete",
      actorId: ctx.actor.id,
      actorType: ctx.actor.type,
      origin: ctx.origin,
      title: `released ${note.kind} on ${note.task}`,
      authorizedById: decision.auditLogId,
    });
    return note;
  });
}

/**
 * Which of the notes `noteIds` are still live in `orgId`.
 *
 * Decides nothing about access: the caller passes ids from change events it has already
 * been authorized to read, and learns only which of those notes have not ended.
 */
export async function liveNoteIds(orgId: string, noteIds: readonly string[]): Promise<Set<string>> {
  if (noteIds.length === 0) return new Set();
  const rows = await db.workingNote.findMany({
    where: { orgId, id: { in: [...noteIds] }, releasedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  return new Set(rows.map((row) => row.id));
}
