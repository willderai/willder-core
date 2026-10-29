// Conventions and decisions: the write side of the task-start block.
//
// A convention is how an org does something ("dedupe accounts by domain"); a decision
// is a choice later work must follow. Both are served unasked at the start of every
// session in their scope (services/memory/task-start.ts), so an agent that never
// thought to ask still starts from them.
//
// The one rule this file enforces: a rule is never edited, only superseded, and only
// by someone allowed to write where the old rule lives. A person confirms an agent's
// rule the same way, by superseding it with their own version of it. A rule a person recorded,
// confirmed ones included, is replaced only by that person or an owner or admin of the org:
// an agent's replacement is stored beside it as a lead and never demotes it, and a peer
// member's is refused. The replacement and its change events commit in one transaction, so a reader never sees both the old rule
// and its replacement as active, or a replacement the feed did not announce.
//
// Two writers can race to replace the same rule. The unique index on `supersedesId`
// lets exactly one through, which is the same winner rule the fact path applies
// (services/memory/conflict.ts: of two writes to one record, the one stored first
// wins). The loser's version is stored anyway, marked `supersededById` so it is never
// served, so the refusal it is given names a version a reader can actually open.
import { db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import type { ConventionKind } from "@/lib/generated/prisma/enums";
import { ORG_ADMIN_ROLES } from "@/lib/org-role";
import {
  AccessDeniedError,
  authorizeRecord,
  check,
  liveMembership,
  recordRefusal,
  type AccessContext,
} from "@/services/access";
import { recordChangeEvent } from "./change-events";
import { recordSupersedes } from "./edges";
import { loadErasedContentFilter, type ErasedContentFilter } from "./erasure-suppression";
import { recordRemoval } from "./record-removal";

export type { ConventionKind };

/** Every kind, for input validation. */
export const CONVENTION_KINDS = ["convention", "decision"] as const satisfies readonly ConventionKind[];

/** The change feed's `recordType` for a convention or decision. */
export const CONVENTION_RECORD_TYPE = "convention";

export interface RecordConventionInput {
  kind: ConventionKind;
  /** What the rule is about, e.g. "Account dedupe". */
  subject: string;
  text: string;
  /** The scope the rule applies to. The caller must already hold memory.write on it. */
  scopePath: string;
  /** Id of an active rule this one replaces. */
  supersedes?: string;
  /** The task the writer's session named, recorded on the rule's change event. */
  task?: string;
  /** The session the writer's call was made in, recorded on the rule's change event. */
  sessionKey?: string;
}

/**
 * Thrown when `supersedes` names no rule this caller may replace: unknown, another
 * org's, in a scope the caller cannot write, or already replaced. One error for all
 * of them, so the id cannot be used to probe what exists.
 */
export class ConventionNotReplaceableError extends Error {
  /** The version this writer's own text was stored as, when it lost a race rather than
   * naming an unreplaceable rule. Readable with `readMemoryVersion`. */
  readonly storedVersionId?: string;
  /** The version that won the race, when there was one. */
  readonly supersededById?: string;

  constructor(lost?: { storedVersionId: string; supersededById: string }) {
    super(
      lost
        ? `supersedes: another writer replaced that rule first. Your version was stored as ` +
            `${lost.storedVersionId} and is superseded by ${lost.supersededById}; both are readable by id.`
        : "supersedes: no active convention with that id in a scope you can write. " +
            "Pass the id of the rule's current version: memory_version on the id you passed names " +
            "the version that replaced it, when you may read it. Nothing was stored.",
    );
    this.name = "ConventionNotReplaceableError";
    this.storedVersionId = lost?.storedVersionId;
    this.supersededById = lost?.supersededById;
  }
}

/**
 * Thrown when a person who may write a rule's scope asks to replace a rule another person
 * recorded, and is neither that person nor an owner or admin of the org. Nothing is stored.
 */
export class ConfirmedRuleNotReplaceableError extends Error {
  constructor(readonly ruleId: string) {
    super(
      `supersedes: ${ruleId} was recorded or confirmed by a person, so only that person or an owner or ` +
        "admin of this organization can replace it. Nothing was stored. To keep yours beside it, " +
        "record it again without supersedes; to replace it, ask that person or an org owner or admin.",
    );
    this.name = "ConfirmedRuleNotReplaceableError";
  }
}

/**
 * Record a convention or decision as `ctx`'s actor, optionally replacing an active one.
 *
 * Authorizes the new rule's scope first. A replaced rule's own scope is authorized
 * too, since replacing a rule removes it from every session served in that scope.
 * A replacement also records its `supersedes` edge (services/memory/edges.ts), in the
 * same transaction, so the dependency graph settles the two versions as the feed does.
 *
 * A rule a person recorded is replaced only by that person or an org owner or admin
 * ({@link personsRuleRefusal}). An agent naming one in `supersedes` still has its rule
 * stored, beside the person's and replacing nothing; {@link recordAuthorizedConvention}
 * reports that as `kept`.
 *
 * @throws AccessDeniedError when the actor may not write `input.scopePath`.
 * @throws ConventionNotReplaceableError when `input.supersedes` is not a rule this
 * actor may replace.
 * @throws ConfirmedRuleNotReplaceableError when a person names another person's rule.
 * @returns the new rule's id.
 */
export async function recordConvention(ctx: AccessContext, input: RecordConventionInput): Promise<string> {
  return (await recordAuthorizedConvention(ctx, input)).id;
}

/** A rule just recorded, and the decision that let it be written. */
export interface RecordedConvention {
  /** The new rule's id. */
  id: string;
  /**
   * The visible `memory.write` allow row that authorized the rule
   * (`AccessDecision.auditLogId`). A caller that stores anything else under the same
   * request -- `memory_ingest` also stores the rule's text as a fact -- carries this id
   * onto that write, so every change the request produced names the one decision that
   * allowed it.
   */
  authorizedById?: string;
  /**
   * Set when an agent named a rule a person recorded in `supersedes`: that rule's id. It
   * stays in force, and the new rule was stored beside it, replacing nothing.
   */
  kept?: string;
}

/**
 * {@link recordConvention}, also returning the audit row of the decision that authorized
 * the rule, for a caller that writes something else under that same decision.
 */
export async function recordAuthorizedConvention(
  ctx: AccessContext,
  input: RecordConventionInput,
): Promise<RecordedConvention> {
  const decision = await check(ctx, { action: "memory.write", scope: input.scopePath });
  if (!decision.allowed) throw new AccessDeniedError(decision);

  let replaced: ReplacedRule | null = null;
  let kept: string | undefined;
  if (input.supersedes !== undefined) {
    const named = await replaceableRule(ctx, input.supersedes);
    if (!(await personsRuleRefusal(ctx, named))) replaced = named;
    else if (ctx.actor.type === "agent") kept = named.id;
    else throw new ConfirmedRuleNotReplaceableError(named.id);
  }

  try {
    return await db.$transaction(async (tx) => {
      const id = await storeConvention(tx, ctx, input, decision.auditLogId, replaced);
      return { id, authorizedById: decision.auditLogId, ...(kept === undefined ? {} : { kept }) };
    });
  } catch (e) {
    // Another writer replaced the same rule between our lookup and our insert: the
    // unique index on supersedesId let exactly one of us through. Keep this version
    // anyway, so the id this caller is handed back resolves to something real.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002" && replaced) {
      throw await storeRaceLoser(ctx, input, replaced.id);
    }
    throw e;
  }
}

/** A rule a new version replaces: its id, its scope, and the audit row that allowed replacing it. */
interface ReplacedRule {
  id: string;
  scopePath: string;
  authorizedById?: string;
}

/**
 * Insert a rule version as `ctx`'s actor, with its `create` change event and, when it
 * replaces `replaced`, that rule's `supersede` event and the `supersedes` edge, all in
 * `tx`. The caller has already authorized both scopes; `authorizedById` is the audit row
 * of the decision that allowed the new version.
 *
 * @returns the new version's id.
 * @throws Prisma's P2002 when another version already replaced `replaced`.
 */
async function storeConvention(
  tx: Prisma.TransactionClient,
  ctx: AccessContext,
  input: RecordConventionInput,
  authorizedById: string | undefined,
  replaced: ReplacedRule | null,
): Promise<string> {
  const created = await tx.convention.create({
    data: {
      orgId: ctx.orgId,
      scopePath: input.scopePath,
      kind: input.kind,
      subject: input.subject,
      text: input.text,
      actorId: ctx.actor.id,
      supersedesId: replaced?.id ?? null,
    },
  });
  await recordChangeEvent(tx, {
    orgId: ctx.orgId,
    scopePath: created.scopePath,
    recordType: CONVENTION_RECORD_TYPE,
    recordId: created.id,
    op: "create",
    actorId: ctx.actor.id,
    actorType: ctx.actor.type,
    origin: ctx.origin,
    title: `${input.kind}: ${input.subject}: ${input.text}`,
    authorizedById,
    task: input.task,
    sessionKey: input.sessionKey,
  });
  if (replaced) {
    await recordChangeEvent(tx, {
      orgId: ctx.orgId,
      scopePath: replaced.scopePath,
      recordType: CONVENTION_RECORD_TYPE,
      recordId: replaced.id,
      op: "supersede",
      actorId: ctx.actor.id,
      actorType: ctx.actor.type,
      origin: ctx.origin,
      title: `replaced by ${created.id}: ${input.subject}`,
      authorizedById: replaced.authorizedById,
    });
    await recordSupersedes(tx, {
      orgId: ctx.orgId,
      replacementId: created.id,
      replacedId: replaced.id,
      scopePath: created.scopePath,
      actor: ctx.actor,
    });
  }
  return created.id;
}

/**
 * Store the version that lost a race to replace `replacedId`, and record the outcome:
 * the winner's `supersedes` edge over it, and a `supersede` change event on it
 * attributed to the winner's writer, so the losing writer hears about it on its next
 * tool call the way any other agent would.
 *
 * @returns the refusal to throw, naming the stored version and the winner.
 */
async function storeRaceLoser(
  ctx: AccessContext,
  input: RecordConventionInput,
  replacedId: string,
): Promise<ConventionNotReplaceableError> {
  const winner = await db.convention.findFirst({
    where: { orgId: ctx.orgId, supersedesId: replacedId },
    select: { id: true, actorId: true },
  });
  // The row that beat us was itself rolled back or replaced in the meantime: there is
  // no winner to point at, so say only what the caller already knew.
  if (!winner) return new ConventionNotReplaceableError();

  const stored = await db.$transaction(async (tx) => {
    const loser = await tx.convention.create({
      data: {
        orgId: ctx.orgId,
        scopePath: input.scopePath,
        kind: input.kind,
        subject: input.subject,
        text: input.text,
        actorId: ctx.actor.id,
        supersedesId: null,
        supersededById: winner.id,
      },
    });
    await recordSupersedes(tx, {
      orgId: ctx.orgId,
      replacementId: winner.id,
      replacedId: loser.id,
      scopePath: loser.scopePath,
      actor: ctx.actor,
    });
    await recordChangeEvent(tx, {
      orgId: ctx.orgId,
      scopePath: loser.scopePath,
      recordType: CONVENTION_RECORD_TYPE,
      recordId: loser.id,
      op: "supersede",
      // The winner's writer, not this one: an agent's own writes are filtered out of
      // its change notices, so attributing it here would hide it from the only reader
      // who needs it.
      actorId: winner.actorId,
      // A rule records only its writer's id, so whether that writer is a person is
      // read from the users table rather than assumed.
      actorType: (await tx.user.count({ where: { id: winner.actorId } })) > 0 ? "human" : "agent",
      // The supersede is this request's consequence, so it carries this request's origin.
      origin: ctx.origin,
      title: `superseded by ${winner.id}: ${input.subject}`,
    });
    return loser.id;
  });

  return new ConventionNotReplaceableError({ storedVersionId: stored, supersededById: winner.id });
}

/**
 * Retire the rule `id` names: it stops being served at the start of sessions in its
 * scope, without being replaced by anything. The row stays, and stays readable by id.
 *
 * Retiring is the only way a rule leaves service without a successor. A rule in a
 * scope that no longer exists has no other way out, which is how ten rules came to
 * survive a deleted scope with nothing serving them.
 *
 * @throws AccessDeniedError when the actor can read the rule's scope but may not write it.
 * @returns whether a rule was retired. False when this org has no active rule with that
 * id, or the actor cannot read the scope it is in: the two are answered alike, so a
 * refusal cannot be used to learn that a rule exists.
 */
export async function retireConvention(ctx: AccessContext, id: string): Promise<boolean> {
  const access = await authorizeRecord(
    ctx,
    () =>
      db.convention.findFirst({
        where: { id, orgId: ctx.orgId, retiredAt: null },
        select: { id: true, scopePath: true, subject: true },
      }),
    { action: "memory.write", scopeOf: (r) => r.scopePath },
  );
  if (access.status === "absent") return false;
  if (access.status === "denied") throw new AccessDeniedError(access.decision);
  const rule = access.record;

  await db.$transaction(async (tx) => {
    // Guarded on `retiredAt: null`, so two callers retiring at once record one event.
    const { count } = await tx.convention.updateMany({
      where: { id: rule.id, orgId: ctx.orgId, retiredAt: null },
      data: { retiredAt: new Date(), retiredBy: ctx.actor.id },
    });
    if (count === 0) return;
    await recordChangeEvent(tx, {
      orgId: ctx.orgId,
      scopePath: rule.scopePath,
      recordType: CONVENTION_RECORD_TYPE,
      recordId: rule.id,
      op: "delete",
      actorId: ctx.actor.id,
      actorType: ctx.actor.type,
      origin: ctx.origin,
      title: `retired: ${rule.subject}`,
      authorizedById: access.decision.auditLogId,
    });
  });
  return true;
}

/**
 * What {@link confirmConvention} did.
 *
 * - `confirmed`: the person's own version `id` now replaces the rule `replaced`.
 * - `alreadyConfirmed`: the rule in force was recorded by a person; nothing was written.
 * - `notInForce`: the rule was replaced or retired, by now or while this ran; nothing was written.
 * - `missing`: no such rule, one the caller may not read, or one naming an erased person.
 */
export type ConventionConfirmation =
  | { status: "confirmed"; id: string; replaced: string }
  | { status: "alreadyConfirmed"; id: string }
  | { status: "notInForce" }
  | { status: "missing" };

/** Thrown when anyone but a signed-in person asks to confirm a rule. */
export class ConfirmationNeedsPersonError extends Error {
  constructor() {
    super("Only a person can confirm a rule; an agent's own confirmation would let it make standing rules by itself.");
    this.name = "ConfirmationNeedsPersonError";
  }
}

/**
 * Confirm a rule an agent recorded, as the signed-in person in `ctx`: store the same kind,
 * subject and text in the same scope as the person's own version, replacing the agent's.
 *
 * The task-start block settles only what a person recorded (services/memory/claim-status.ts):
 * an agent's decision is served as a lead to verify however its writer worded it. Confirming
 * is how a person makes it theirs without retyping it. The agent's version stays readable
 * by id and in the history, replaced by the person's, so who proposed it and who confirmed
 * it are both on record.
 *
 * Decided once, `memory.write` on the rule's own scope, which is where the new version is
 * stored too. A rule naming a person erased since it was written is answered as missing,
 * so a confirmation never stores an erased person's name again as new text.
 *
 * @throws ConfirmationNeedsPersonError when `ctx` is not a person.
 * @throws AccessDeniedError when the person can read the rule's scope but may not write it.
 */
export async function confirmConvention(ctx: AccessContext, id: string): Promise<ConventionConfirmation> {
  if (ctx.actor.type !== "human") throw new ConfirmationNeedsPersonError();
  const access = await authorizeRecord(
    ctx,
    () =>
      db.convention.findFirst({
        where: { id, orgId: ctx.orgId },
        select: { id: true, subject: true, text: true, scopePath: true, createdAt: true },
      }),
    { action: "memory.write", scopeOf: (r) => r.scopePath },
  );
  if (access.status === "absent") return { status: "missing" };
  // Before a refusal too, so a reader is told the same about an erased rule as about none.
  if (namesErasedPerson(await loadErasedContentFilter(ctx.orgId), access.record)) return { status: "missing" };
  if (access.status === "denied") throw new AccessDeniedError(access.decision);
  try {
    return await db.$transaction(async (tx) =>
      storeConfirmation(tx, ctx, access.record.id, access.decision.auditLogId),
    );
  } catch (e) {
    // The lock in storeConfirmation keeps out every writer that locks the row; one that
    // only inserts a replacement can still get there first, and the unique index on
    // `supersedesId` then refuses this one, rolling back everything it wrote. Any other
    // unique violation is a fault, not a lost race, and is thrown.
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002" &&
      (await db.convention.count({ where: { orgId: ctx.orgId, supersedesId: id } })) > 0
    ) {
      return { status: "notInForce" };
    }
    throw e;
  }
}

/** Whether a rule's text, subject or id names a person erased from the org since it was written. */
function namesErasedPerson(
  erased: ErasedContentFilter,
  rule: { id: string; subject: string; text: string; createdAt: Date },
): boolean {
  return (
    erased(`${rule.subject}\n${rule.text}`, rule.createdAt, rule.subject) || erased.byRuleId(rule.id, rule.createdAt)
  );
}

/**
 * {@link confirmConvention}'s writes, in one transaction. The rule is read again under a row
 * lock, so a retirement, an erasure's redaction or another confirmation of it waits for this
 * one, and this one judges the row as it is now: still in force, naming no erased person,
 * and not already a person's.
 */
async function storeConfirmation(
  tx: Prisma.TransactionClient,
  ctx: AccessContext,
  id: string,
  authorizedById: string | undefined,
): Promise<ConventionConfirmation> {
  const [rule] = await tx.$queryRaw<
    {
      id: string;
      kind: ConventionKind;
      subject: string;
      text: string;
      scopePath: string;
      createdAt: Date;
      inForce: boolean;
    }[]
  >`
    SELECT c."id", c."kind", c."subject", c."text", c."scopePath", c."createdAt",
           (c."retiredAt" IS NULL AND c."supersededById" IS NULL
             AND NOT EXISTS (SELECT 1 FROM "conventions" n WHERE n."orgId" = c."orgId" AND n."supersedesId" = c."id")) AS "inForce"
    FROM "conventions" c
    WHERE c."id" = ${id} AND c."orgId" = ${ctx.orgId}
    FOR UPDATE`;
  if (rule === undefined) return { status: "missing" };

  if (namesErasedPerson(await loadErasedContentFilter(ctx.orgId, tx), rule)) return { status: "missing" };
  if (!rule.inForce) return { status: "notInForce" };

  if ((await ruleWriter(tx, ctx.orgId, rule.id))?.actorType === "human")
    return { status: "alreadyConfirmed", id: rule.id };

  const replaced: ReplacedRule = { id: rule.id, scopePath: rule.scopePath, authorizedById };
  const confirmed = { kind: rule.kind, subject: rule.subject, text: rule.text, scopePath: rule.scopePath };
  const newId = await storeConvention(tx, ctx, confirmed, authorizedById, replaced);
  return { status: "confirmed", id: newId, replaced: rule.id };
}

/** A rule as the confirm page shows it: what it says, where, and who recorded it. */
export interface RuleForConfirmation {
  id: string;
  kind: ConventionKind;
  subject: string;
  text: string;
  scopePath: string;
  createdAt: Date;
  /** Who its create event says recorded it; "unknown" when no event names a person or an agent. */
  recordedBy: "person" | "agent" | "unknown";
  /** The id its create event names: a user id or an agent key. Null with no create event. */
  recordedById: string | null;
  /** Whether it is still served: not retired, not replaced, not a version that lost a race. */
  inForce: boolean;
}

/**
 * The rule `id` names, for a person deciding whether to confirm it, read under `memory.read`
 * on its own scope (audited like any disclosure). Null for an id that matches nothing, a rule
 * the caller may not read, and a rule naming a person erased since it was written: the three
 * are answered alike, so the page cannot be used to learn that a rule exists.
 */
export async function readRuleForConfirmation(ctx: AccessContext, id: string): Promise<RuleForConfirmation | null> {
  const access = await authorizeRecord(
    ctx,
    () =>
      db.convention.findFirst({
        where: { id, orgId: ctx.orgId },
        select: {
          id: true,
          kind: true,
          subject: true,
          text: true,
          scopePath: true,
          createdAt: true,
          retiredAt: true,
          supersededById: true,
          replacedBy: { select: { id: true } },
        },
      }),
    { action: "memory.read", scopeOf: (r) => r.scopePath },
  );
  if (access.status !== "allowed") return null;
  const rule = access.record;
  if (namesErasedPerson(await loadErasedContentFilter(ctx.orgId), rule)) return null;

  const created = await ruleWriter(db, ctx.orgId, rule.id);
  return {
    id: rule.id,
    kind: rule.kind,
    subject: rule.subject,
    text: rule.text,
    scopePath: rule.scopePath,
    createdAt: rule.createdAt,
    recordedBy: created?.actorType === "human" ? "person" : created?.actorType === "agent" ? "agent" : "unknown",
    recordedById: created?.actorId ?? null,
    inForce: rule.retiredAt === null && rule.supersededById === null && rule.replacedBy === null,
  };
}

/**
 * What {@link deleteRetiredConvention} did. Every outcome but `deleted` leaves the row.
 *
 * - `missing`: no rule with this id in the org.
 * - `active`: the rule is not retired (in force, or a version that lost the race to
 *   replace another); it has to be retired first.
 * - `namedBy`: newer versions point at this one (they replaced it, or lost a race to);
 *   they have to be removed first, newest first.
 * - `wouldRestore`: this rule replaced one that was never retired. That one is out of
 *   service only because this one replaced it, so removing this would serve it again.
 */
export type ConventionDeletion =
  | { status: "deleted" }
  | { status: "missing" }
  | { status: "active" }
  | { status: "namedBy"; ids: string[] }
  | { status: "wouldRestore"; id: string };

/**
 * Permanently remove a retired rule from the caller's org.
 *
 * Only a retired rule is removed, and only one whose removal changes nothing a reader
 * is served: see {@link ConventionDeletion} for the refusals. Retiring already
 * announced the rule's removal on the change feed, so this adds no event.
 *
 * The `supersedes` edges that name the rule are kept, as a fact's are when it is
 * deleted: they are its history, and `memory_version` on the version it replaced still
 * names it as the replacement. Its `record.removed` audit row (./record-removal.ts)
 * records the same lineage, so a reader following that id can tell why it is gone.
 *
 * The caller must already have decided the removal with check(). This does not authorize.
 */
export async function deleteRetiredConvention(ctx: AccessContext, id: string): Promise<ConventionDeletion> {
  const orgId = ctx.orgId;
  return db.$transaction(async (tx) => {
    const rule = await tx.convention.findFirst({
      where: { id, orgId },
      select: { scopePath: true, retiredAt: true, supersedesId: true },
    });
    if (!rule) return { status: "missing" };
    if (!rule.retiredAt) return { status: "active" };

    const newer = await tx.convention.findMany({
      where: { orgId, OR: [{ supersedesId: id }, { supersededById: id }] },
      select: { id: true },
    });
    if (newer.length > 0) return { status: "namedBy", ids: newer.map((r) => r.id) };

    if (rule.supersedesId) {
      const replaced = await tx.convention.findFirst({
        where: { id: rule.supersedesId, orgId, retiredAt: null },
        select: { id: true },
      });
      if (replaced) return { status: "wouldRestore", id: replaced.id };
    }

    // A retired rule is never put back in service, so the checks above still hold here.
    // A second removal racing this one finds nothing to delete and records nothing.
    const { count } = await tx.convention.deleteMany({ where: { id, orgId } });
    if (count === 0) return { status: "missing" };

    const edges = await tx.factEdge.findMany({
      where: { orgId, kind: "supersedes", OR: [{ fromId: id }, { toId: id }] },
      select: { fromId: true, toId: true },
    });
    const supersedes = new Set(edges.filter((e) => e.fromId === id).map((e) => e.toId));
    if (rule.supersedesId) supersedes.add(rule.supersedesId);
    await recordRemoval(tx, ctx, {
      kind: "convention",
      id,
      scopePath: rule.scopePath,
      supersedes: [...supersedes],
      supersededBy: edges.filter((e) => e.toId === id).map((e) => e.fromId),
    });
    return { status: "deleted" };
  });
}

/**
 * The active rule `id` names, if `ctx` may write its scope; otherwise the one error.
 * `authorizedById` is the audit row of that write decision, which the rule's `supersede`
 * event names as its authorization.
 */
async function replaceableRule(ctx: AccessContext, id: string): Promise<ReplacedRule> {
  const rule = await db.convention.findFirst({
    where: { id, orgId: ctx.orgId, replacedBy: null, supersededById: null, retiredAt: null },
    select: { id: true, scopePath: true },
  });
  if (!rule) throw new ConventionNotReplaceableError();
  // Audited like any write decision; the caller still only learns "not replaceable".
  const decision = await check(ctx, { action: "memory.write", scope: rule.scopePath });
  if (!decision.allowed) throw new ConventionNotReplaceableError();
  return { ...rule, authorizedById: decision.auditLogId };
}

/**
 * Who recorded the rule `id`, as its first `create` change event says: the one record of
 * whether a person or an agent wrote it, which the task-start block reads too
 * (services/memory/claim-status.ts). Null for a rule with no create event.
 */
async function ruleWriter(
  client: Prisma.TransactionClient,
  orgId: string,
  id: string,
): Promise<{ actorType: string | null; actorId: string } | null> {
  return client.changeEvent.findFirst({
    where: { orgId, recordType: CONVENTION_RECORD_TYPE, recordId: id, op: "create" },
    orderBy: { seq: "asc" },
    select: { actorType: true, actorId: true },
  });
}

/**
 * The person who recorded the rule `id`, or null when an agent or the extraction pipeline did.
 * Its create event says so; a rule whose event is missing (an imported org's rules) or names
 * no actor type (events from before the type was recorded) is judged by its own `actorId`,
 * a person when that id is a user's, as {@link storeRaceLoser} does.
 */
async function recordingPerson(orgId: string, id: string): Promise<string | null> {
  const writer = await ruleWriter(db, orgId, id);
  if (writer?.actorType) return writer.actorType === "human" ? writer.actorId : null;
  const rule = await db.convention.findFirst({ where: { id, orgId }, select: { actorId: true } });
  if (!rule) return null;
  return (await db.user.count({ where: { id: rule.actorId } })) > 0 ? rule.actorId : null;
}

/**
 * Whether `ctx` is refused replacing `rule` because a person recorded it, which a person's
 * confirmation does too. Such a rule is replaced only by that person or by an owner or admin
 * of the org, whose role is read from their live membership, never from the request. An
 * agent is always refused, a peer member too. A refusal leaves one deny row naming who
 * recorded the rule.
 *
 * It runs after the scope check, so only a caller who may write the rule's scope learns
 * that a person recorded it. Who recorded a rule never changes, so nothing can race it.
 * No route lets a person supersede a rule today (`memory_ingest` is agents' only); the
 * person cases hold for any route that calls {@link recordAuthorizedConvention} later.
 */
async function personsRuleRefusal(ctx: AccessContext, rule: ReplacedRule): Promise<boolean> {
  const recordedBy = await recordingPerson(ctx.orgId, rule.id);
  if (recordedBy === null) return false;
  if (ctx.actor.type === "human") {
    if (ctx.actor.id === recordedBy) return false;
    const membership = await liveMembership(ctx.orgId, ctx.actor.id);
    if (membership && ORG_ADMIN_ROLES.includes(membership.role)) return false;
  }
  const caller =
    ctx.actor.type === "agent" ? `agent ${ctx.actor.id}` : `person ${ctx.actor.id}, not an org owner or admin,`;
  await recordRefusal(ctx, {
    action: "memory.write",
    target: `${rule.scopePath}/${rule.id}`,
    auditReason: `${caller} may not replace rule ${rule.id}: person ${recordedBy} recorded it, so only they or an org owner or admin may`,
  });
  return true;
}
