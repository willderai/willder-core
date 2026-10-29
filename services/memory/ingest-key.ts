// Caller-supplied idempotency keys on memory writes.
//
// A client that loses a response (a dropped connection, a timeout, an agent loop that
// re-sends) cannot tell whether its write landed, so it retries. Without a key every
// retry is a new write. The rule this file enforces: one key, one write. The first call
// to claim a key does the write and records its reply; every later call with the same
// request gets that reply and writes nothing; a call that reuses the key for a
// different request is refused.
//
// A key belongs to one principal (an agent or a person) in one org. The claim is an
// INSERT under a unique index, never a read followed by an insert, so calls that arrive
// together cannot both win. A call that finds the key claimed but its write unfinished
// is refused as in progress and told to retry, the way Stripe and the IETF
// Idempotency-Key draft answer it (409), rather than told a write succeeded before it has.
//
// Retention: a key lives as long as its org and does not expire. The row holds a SHA-256
// digest of the request and the reply, never the written content.
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";

/** The longest key accepted, in characters. */
const MAX_INGEST_KEY_LENGTH = 255;

const KEY_RULE = `An idempotency key is 1 to ${MAX_INGEST_KEY_LENGTH} characters, unique to the write; send one or leave it out.`;

/**
 * A caller-supplied idempotency key, trimmed. The memory_ingest input schema and the
 * Idempotency-Key header of POST /api/memory/ingest both validate with this one schema.
 */
export const ingestKeySchema = z.string().trim().min(1, KEY_RULE).max(MAX_INGEST_KEY_LENGTH, KEY_RULE);

/**
 * The `maxDuration`, in seconds, of the hosted routes that take a key: app/api/mcp/route.ts
 * and app/api/memory/ingest/route.ts. Next.js reads `maxDuration` from each route as a
 * literal, so the routes repeat this number and ingest-key.test.ts holds them equal.
 */
export const KEYED_ROUTE_MAX_DURATION_SECONDS = 60;

/**
 * How long a claimed key waits for its write before another call may take it over: the
 * keyed routes' maxDuration, plus a margin for clock skew between servers. The lease
 * assumes a write has stopped once its request's maxDuration has passed. That holds only
 * where the platform enforces maxDuration: the stdio server in mcp/server.ts and a
 * self-hosted `next start` enforce none, so a write there can outlive its lease. The claim
 * token keeps such a late finisher from recording a reply for, or freeing, a key a retry
 * has taken over; its own write still lands, so that case writes twice.
 */
const INGEST_KEY_LEASE_SECONDS = KEYED_ROUTE_MAX_DURATION_SECONDS + 30;

/** The principal a key belongs to. */
export interface IngestKeyOwner {
  orgId: string;
  actorType: "agent" | "human";
  actorId: string;
}

/** One keyed request: the key, the name the caller knows it by, and a digest of the write. */
export interface IngestKeyRequest {
  key: string;
  /** The field or header the key arrived in, used to name it in errors. */
  label: string;
  /** From {@link ingestRequestHash}. */
  requestHash: string;
}

/** The key was already used, by this principal, for a different write. */
export class IngestKeyReusedError extends Error {
  constructor(label: string) {
    super(
      `This ${label} was already used for a different write. Send a new ${label} for a new write; ` +
        `reuse a key only to retry the identical call.`,
    );
    this.name = "IngestKeyReusedError";
  }
}

/** Another call holding the same key has not finished its write yet. */
export class IngestKeyInProgressError extends Error {
  constructor(label: string) {
    super(
      `A write with this ${label} is still in progress. Retry the same call in a few seconds to get its result; ` +
        `a write that stopped without finishing frees its key within ${INGEST_KEY_LEASE_SECONDS} seconds.`,
    );
    this.name = "IngestKeyInProgressError";
  }
}

/**
 * The digest that decides whether two keyed calls are the same write: SHA-256 of the
 * fields in order, with an absent field distinct from an empty one. Callers pass every
 * field that changes what is written, after resolving defaults (the scope a write lands
 * in, not the scope it named).
 */
export function ingestRequestHash(fields: readonly (string | null | undefined)[]): string {
  return createHash("sha256")
    .update(JSON.stringify(fields.map((field) => field ?? null)))
    .digest("hex");
}

/**
 * Run `write` at most once per key. The first call claims the key, runs `write` and
 * records its reply; a later call with the same request returns that reply with
 * `replayed: true` and does not run `write`. A failed `write` frees the key, so the
 * caller's retry runs it again.
 *
 * Throws {@link IngestKeyReusedError} when the key was used for a different request and
 * {@link IngestKeyInProgressError} while another call holding it is still writing.
 */
export async function withIngestKey<Reply extends Prisma.InputJsonValue>(
  owner: IngestKeyOwner,
  request: IngestKeyRequest,
  write: () => Promise<Reply>,
): Promise<{ reply: Reply; replayed: boolean }> {
  const claim = await claimKey(owner, request);
  // A stored reply is the one recordReply wrote for this key's write, so it has its type.
  if (claim.kind === "replay") return { reply: claim.reply as Reply, replayed: true };

  let reply: Reply;
  try {
    reply = await write();
  } catch (e) {
    // The write's own error is the one the caller needs, so it is the one rethrown. A key
    // that cannot be freed is not lost: it frees itself when its lease ends.
    await releaseKey(claim).catch((releaseError: unknown) =>
      console.warn("[memory] could not free an idempotency key after a failed write:", releaseError),
    );
    throw e;
  }
  await recordReply(claim, reply);
  return { reply, replayed: false };
}

type Claim = { kind: "claimed"; id: string; token: string } | { kind: "replay"; reply: Prisma.JsonValue };

/** Claim the key for this call, or find the finished write it already names. */
async function claimKey(owner: IngestKeyOwner, request: IngestKeyRequest): Promise<Claim> {
  // Two passes cover the one benign race: the holder frees the key between this call's
  // failed INSERT and its read. A third collision means the key is busy.
  for (let pass = 0; pass < 2; pass++) {
    const token = randomUUID();
    const now = new Date();
    try {
      const row = await db.memoryIngestKey.create({
        data: { ...owner, key: request.key, requestHash: request.requestHash, claimToken: token, claimedAt: now },
        select: { id: true },
      });
      return { kind: "claimed", id: row.id, token };
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
    }

    const held = await db.memoryIngestKey.findUnique({
      where: { orgId_actorType_actorId_key: { ...owner, key: request.key } },
    });
    if (held === null) continue;
    if (held.requestHash !== request.requestHash) throw new IngestKeyReusedError(request.label);
    if (held.completedAt !== null) return { kind: "replay", reply: held.reply };
    if (now.getTime() - held.claimedAt.getTime() < INGEST_KEY_LEASE_SECONDS * 1000) {
      throw new IngestKeyInProgressError(request.label);
    }
    // The holder's lease ran out with no reply. Take the key over, fenced on the holder's
    // token so two callers cannot both take it.
    const { count } = await db.memoryIngestKey.updateMany({
      where: { id: held.id, claimToken: held.claimToken, completedAt: null },
      data: { claimToken: token, claimedAt: now },
    });
    if (count === 1) return { kind: "claimed", id: held.id, token };
  }
  throw new IngestKeyInProgressError(request.label);
}

/** Record the write's reply, if this call still holds the key. */
async function recordReply(claim: Extract<Claim, { kind: "claimed" }>, reply: Prisma.InputJsonValue): Promise<void> {
  await db.memoryIngestKey.updateMany({
    where: { id: claim.id, claimToken: claim.token, completedAt: null },
    data: { reply, completedAt: new Date() },
  });
}

/** Free the key after a failed write, if this call still holds it. */
async function releaseKey(claim: Extract<Claim, { kind: "claimed" }>): Promise<void> {
  await db.memoryIngestKey.deleteMany({ where: { id: claim.id, claimToken: claim.token, completedAt: null } });
}
