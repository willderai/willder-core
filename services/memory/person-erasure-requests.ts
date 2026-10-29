/**
 * A person erasure asked for over HTTP: accepted at once, run by a background job, polled for.
 *
 * On a large org an erasure scans every chunk and change event several times
 * (services/memory/person-erasure.ts), which takes longer than a caller's connection stays
 * open. So POST /api/access/erasure checks the request and records it here, a job runs the
 * erasure, and GET /api/access/erasure/:requestId reads how it went.
 *
 * The rule this file enforces: a request's erasure finishes at most once. The request row
 * turns `done` in the transaction that writes the erasure's one `person.erased` audit row,
 * and only from `running`, so a job run again after a crash, or delivered twice, either finds
 * it done and stops, or rolls its own last transaction back. Every step before that one is
 * idempotent, so a run that dies part-way is completed by running it again.
 *
 * The person a request names is held in its row only while it runs, because the job needs it
 * to find them: the transaction that finishes the erasure clears it, and so does a failure.
 * The job's event carries the request id alone, so the person never reaches the job queue.
 *
 * A request never stays running: one whose job has not finished {@link STUCK_AFTER_MS} after it
 * was asked for is queued once more by a scheduled sweep, and one still running that long after
 * the retry is marked failed. Every failure writes one `person.erasure_failed` audit row and an
 * `[erasure]` error log line, naming the request and never the person.
 */
import { db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import type { UserRole } from "@/lib/generated/prisma/enums";
import { AccessDeniedError, check, orgRootPath, writeAuditRow, type AccessContext } from "@/services/access";
import type { AuditOrigin } from "@/services/access/origin";
import {
  authorizePersonErasure,
  PersonErasureError,
  runPersonErasure,
  type ParsedPersonIdentifier,
  type PersonErasureResult,
  type PersonIdentifier,
} from "./person-erasure";

/** A request context whose actor is a signed-in person: the job acts as them, without a credential. */
type PersonAccessContext = AccessContext & { actor: { type: "human"; id: string; role: UserRole } };

/** What a request reports while it runs, once it is done, or once it failed. */
type PersonErasureStatus =
  | { requestId: string; status: "running" }
  | ({ status: "done" } & PersonErasureResult)
  | { requestId: string; status: "failed"; error: string };

/** The job could not be queued. The request row is marked failed, and nothing was erased. */
export class ErasureNotQueuedError extends Error {
  constructor(cause: unknown) {
    super("The erasure could not be started, and nothing was erased. Send the same request again.", { cause });
    this.name = "ErasureNotQueuedError";
  }
}

/** A request id as POST returns it: a UUID. Anything else names no request. */
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Check an erasure request, record it, and queue its job with `queue`. Throws what
 * {@link authorizePersonErasure} throws, before anything is recorded; PersonErasureError when
 * the actor is not a signed-in person, since the job acts as the requester and holds no agent
 * credential; and ErasureNotQueuedError when the job could not be queued.
 */
export async function requestPersonErasure(
  ctx: AccessContext,
  identifier: PersonIdentifier,
  queue: (requestId: string) => Promise<void>,
): Promise<{ requestId: string; status: "running" }> {
  if (ctx.actor.type !== "human")
    throw new PersonErasureError("An erasure is requested by a signed-in person, not an agent.");
  const { requestId, identifier: parsed } = await authorizePersonErasure(ctx, identifier);
  const [identifierKind, identifierValue] = Object.entries(parsed)[0]!;
  await db.personErasureRequest.create({
    data: {
      id: requestId,
      orgId: ctx.orgId,
      requestedBy: ctx.actor.id,
      requesterRole: ctx.actor.role,
      origin: ctx.origin,
      identifierKind,
      identifierValue,
    },
  });
  try {
    await queue(requestId);
  } catch (e) {
    await failPersonErasureRequest(requestId, "The erasure could not be started. Send the same request again.");
    throw new ErasureNotQueuedError(e);
  }
  return { requestId, status: "running" };
}

/**
 * Run the erasure of a recorded request, as the person who asked. A request that is no
 * longer running (done, failed, or never recorded) is left as it is.
 */
export async function runPersonErasureRequest(requestId: string): Promise<PersonErasureStatus | null> {
  const row = await db.personErasureRequest.findUnique({ where: { id: requestId } });
  if (!row || row.status !== "running" || !row.identifierKind || row.identifierValue === null) return null;
  const ctx: PersonAccessContext = {
    orgId: row.orgId,
    actor: { type: "human", id: row.requestedBy, role: row.requesterRole },
    origin: row.origin as AuditOrigin,
  };
  const identifier = { [row.identifierKind]: row.identifierValue } as ParsedPersonIdentifier;
  const result = await runPersonErasure(ctx, { requestId, identifier, requestedAt: row.createdAt }, (tx, result) =>
    finishRequest(tx, requestId, result),
  );
  return { status: "done", ...result };
}

/** Mark the request done with its result and forget the person, or undo the erasure's last transaction if it is not running. */
async function finishRequest(
  tx: Prisma.TransactionClient,
  requestId: string,
  result: PersonErasureResult,
): Promise<void> {
  const { count } = await tx.personErasureRequest.updateMany({
    where: { id: requestId, status: "running" },
    data: {
      status: "done",
      result: result as unknown as Prisma.InputJsonValue,
      identifierKind: null,
      identifierValue: null,
      completedAt: new Date(),
    },
  });
  if (count !== 1) throw new Error(`person erasure ${requestId} is no longer running; this run's last step is undone`);
}

/**
 * Mark a running request failed with `error`, forget the person it names, and record the
 * failure: one `person.erasure_failed` audit row, as the requester, under the request's target,
 * and one error log line. `error` is a fixed sentence the requester can act on, never a store's
 * message, which can quote what it was removing. Returns whether this call failed it: a request
 * already done or failed is left as it is, and records nothing more.
 */
export async function failPersonErasureRequest(requestId: string, error: string): Promise<boolean> {
  const failed = await db.$transaction(async (tx) => {
    const row = await tx.personErasureRequest.findUnique({
      where: { id: requestId },
      select: { orgId: true, requestedBy: true, origin: true },
    });
    const { count } = await tx.personErasureRequest.updateMany({
      where: { id: requestId, status: "running" },
      data: { status: "failed", error, identifierKind: null, identifierValue: null, completedAt: new Date() },
    });
    if (count !== 1 || !row) return false;
    await writeAuditRow(
      {
        orgId: row.orgId,
        actorType: "human",
        actorId: row.requestedBy,
        action: "person.erasure_failed",
        target: `${orgRootPath(row.orgId)}/person_erasure:${requestId}`,
        decision: "allow",
        metadata: { requestId, error },
        origin: row.origin as AuditOrigin,
      },
      tx,
    );
    return true;
  });
  if (failed) console.error(`[erasure] ${requestId}: request failed: ${error}`);
  return failed;
}

/**
 * How long a request may run before the sweep acts on it: once to queue its job again, and once
 * more, after that retry, to mark it failed. The job took 18.8 s on a local org of 60k chunks and
 * 42 s on a large org in production;
 * 30 minutes holds all five of its attempts at that length with over 25 minutes for Inngest's
 * backoff between them, so a request still running then has a job that was lost, not a slow one.
 * The person's identifier is kept at most twice this plus two sweep intervals.
 */
export const STUCK_AFTER_MS = 30 * 60_000;

/** What a requester is told when the job never finished, even after the sweep queued it again. */
const NEVER_FINISHED =
  "The erasure did not finish in time, and the person may not be fully erased. Send the same request again to complete it.";

/** What one pass of the sweep did, by request id. */
interface ErasureSweepResult {
  retried: string[];
  failed: string[];
}

/**
 * One pass of the scheduled sweep: queue again, with `requeue`, the job of every request running
 * longer than {@link STUCK_AFTER_MS} that was never retried, and mark failed every request still
 * running that long after its retry, or whose retry could not be queued. A retry is recorded
 * only once it is queued; `requeue` must make a second call for the same request a no-op, as an
 * event id does, so a pass that dies between the two queues it once.
 */
export async function sweepStuckPersonErasures(
  requeue: (requestId: string) => Promise<void>,
  now: Date = new Date(),
): Promise<ErasureSweepResult> {
  const result: ErasureSweepResult = { retried: [], failed: [] };
  const before = new Date(now.getTime() - STUCK_AFTER_MS);
  const fail = async (id: string) => {
    if (await failPersonErasureRequest(id, NEVER_FINISHED)) result.failed.push(id);
  };

  const expired = await db.personErasureRequest.findMany({
    where: { status: "running", retriedAt: { lte: before } },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  for (const { id } of expired) await fail(id);

  const stuck = await db.personErasureRequest.findMany({
    where: { status: "running", retriedAt: null, createdAt: { lte: before } },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  for (const { id } of stuck) {
    try {
      await requeue(id);
    } catch (e) {
      console.error(`[erasure] ${id}: could not queue its retry`, { error: e });
      await fail(id);
      continue;
    }
    const { count } = await db.personErasureRequest.updateMany({
      where: { id, status: "running", retriedAt: null },
      data: { retriedAt: now },
    });
    if (count === 1) result.retried.push(id);
  }
  return result;
}

/**
 * How request `requestId` in `ctx.orgId` stands, or null when this org has no such request.
 * Requires `access.manage` on the org root, as the request did, and the decision is audited
 * under the request's target; an unknown id and another org's look the same.
 */
export async function personErasureStatus(ctx: AccessContext, requestId: string): Promise<PersonErasureStatus | null> {
  const known = REQUEST_ID.test(requestId);
  const decision = await check(ctx, {
    action: "access.manage",
    target: `person_erasure:${known ? requestId : "unknown"}`,
  });
  if (!decision.allowed) throw new AccessDeniedError(decision);
  if (!known) return null;
  const row = await db.personErasureRequest.findFirst({ where: { id: requestId, orgId: ctx.orgId } });
  if (!row) return null;
  if (row.status === "done") return { status: "done", ...(row.result as unknown as PersonErasureResult), requestId };
  if (row.status === "failed")
    return {
      requestId,
      status: "failed",
      error: row.error ?? "The erasure did not finish. Send the same request again.",
    };
  return { requestId, status: "running" };
}
