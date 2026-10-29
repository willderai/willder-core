// The smallest contact search/read/upsert surface for agent capability
// tokens (a sales agent's workflow). Gated the same way every other
// agent-facing surface is: check() (services/access/check.ts) is the single
// enforcement chokepoint, same as mcp/tools.ts and guarded-store.ts.
//
// Contact rows are NOT ltree-scope-partitioned (Contact has only orgId, no
// scopePath column) — unlike memory/fact/entity rows there is no narrower
// target within an org to gate against. Rather than accept a caller-supplied
// scope that would look like real sub-org scoping but enforce nothing (a
// check() call present but not actually narrowing anything), every contact
// action here targets a FIXED scope of orgRootPath(ctx.orgId): only a
// capability whose grant covers the org root at all may search, read, or
// upsert a contact.
//
// Out of scope: no enrichment, no campaign start, no prospect sends, no raw
// customer-data transfer, no admin credential/token issuance. Suppression can
// only be SET by the human-facing contact UI — this surface can read it but
// never write it.
import { createHash, randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { check, AccessDeniedError, orgRootPath, type AccessContext } from "@/services/access";
import type { Contact, Prisma } from "@/lib/generated/prisma/client";
import { CONTACT_TYPES, type ContactType } from "@/lib/contact-types";

const MAX_SEARCH_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 10;

export interface AgentContactSummary {
  id: string;
  name: string;
  email: string | null;
  title: string | null;
  type: string;
  status: string;
  suppressed: boolean;
  revision: number;
  description: string | null;
}

function toSummary(c: Contact): AgentContactSummary {
  return {
    id: c.id,
    name: c.name,
    email: c.email,
    title: c.title,
    type: c.type,
    status: c.status,
    suppressed: c.suppressed,
    revision: c.revision,
    description: c.description,
  };
}

/** Every contact action targets the same fixed scope: see file header for why
 * (no per-contact ltree partition exists to check a narrower target against). */
async function requireContactAccess(ctx: AccessContext, action: "memory.read" | "memory.write"): Promise<void> {
  const decision = await check(ctx, { action, scope: orgRootPath(ctx.orgId), target: "contact" });
  if (!decision.allowed) {
    throw new AccessDeniedError(decision);
  }
}

export interface SearchContactsInput {
  query?: string;
  limit?: number;
}

/** Search contacts by name/email substring (case-insensitive), tenant-scoped
 * to ctx.orgId. Suppressed contacts are still returned (flagged
 * `suppressed: true`) — a sales agent needs to know a match IS suppressed to
 * avoid contacting them or creating a duplicate, not have it silently vanish
 * from search. */
export async function searchContacts(ctx: AccessContext, input: SearchContactsInput): Promise<AgentContactSummary[]> {
  await requireContactAccess(ctx, "memory.read");
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? DEFAULT_SEARCH_LIMIT), 1), MAX_SEARCH_LIMIT);
  const query = input.query?.trim();

  const contacts = await db.contact.findMany({
    where: {
      orgId: ctx.orgId,
      ...(query
        ? {
            OR: [
              { name: { contains: query, mode: "insensitive" as const } },
              { email: { contains: query, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: limit,
  });
  return contacts.map(toSummary);
}

/** Fetch one contact by id, tenant-scoped. A cross-tenant id resolves to
 * null, indistinguishable from "doesn't exist". */
export async function getContact(ctx: AccessContext, contactId: string): Promise<AgentContactSummary | null> {
  await requireContactAccess(ctx, "memory.read");
  const contact = await db.contact.findFirst({ where: { id: contactId, orgId: ctx.orgId } });
  return contact ? toSummary(contact) : null;
}

export type ContactUpsertErrorCode =
  | "invalid_input"
  | "not_found"
  | "revision_required"
  | "stale_revision"
  | "idempotency_conflict";

export class ContactUpsertError extends Error {
  constructor(
    readonly code: ContactUpsertErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ContactUpsertError";
  }
}

/** Internal-only signal: this transaction lost a race to record its
 * idempotency key (see upsertContact). Never surfaced to a caller directly —
 * always resolved into a real ContactUpsertResult or ContactUpsertError. */
class IdempotencyKeyRace extends Error {}

export interface UpsertContactInput {
  /** Required. A repeat call with the same key returns the first call's
   * recorded outcome verbatim instead of writing again — the safe-retry
   * guarantee. Reusing the same key for a genuinely different request body
   * is a caller bug, rejected as idempotency_conflict, never silently
   * replayed. */
  idempotencyKey: string;
  /** Update an existing contact by id. Omit to match/create by email. */
  contactId?: string;
  /** Required when an existing contact is matched (by contactId or by
   * email) — must equal that contact's current revision, or the write is
   * rejected as stale (optimistic concurrency) instead of blindly applied.
   * Must be omitted when no existing contact matches (a fresh create). */
  baseRevision?: number;
  name?: string;
  email?: string;
  title?: string;
  /** Must be one of CONTACT_TYPES (lib/contact-types.ts) — the same
   * vocabulary the human-facing contact routes gate on. Validated here too,
   * not just by the MCP tool's zod schema, so a non-MCP caller of this
   * function can't bypass it. */
  type?: ContactType;
  description?: string;
}

export interface UpsertContactResult {
  action: "created" | "updated";
  contact: AgentContactSummary;
}

/** Deterministic fingerprint of everything but the idempotency key itself —
 * lets a repeat submission under the same key be told apart from the same
 * key genuinely reused for a different request. */
function requestFingerprint(input: Omit<UpsertContactInput, "idempotencyKey">): string {
  const normalized = {
    contactId: input.contactId ?? null,
    baseRevision: input.baseRevision ?? null,
    name: input.name ?? null,
    email: input.email ?? null,
    title: input.title ?? null,
    type: input.type ?? null,
    description: input.description ?? null,
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/**
 * How long a claimed-but-undelivered row stays claimed before a later
 * dispatch attempt may reclaim it. A lease, not a permanent one-shot claim:
 * the queued Inngest delivery path has no failure handler (see
 * `lib/inngest.ts`'s `memoryIngest`), so a delivery that dies async (retries
 * exhausted, nothing releases the claim) would otherwise stay claimed forever
 * and no future retry could repair it. Ten minutes comfortably exceeds
 * `memoryIngest`'s own `retries: 3` backoff window (the realistic worst case
 * for a delivery that's still genuinely working), while staying far short of
 * "effectively permanent" for the case that has actually died.
 */
const DELIVERY_CLAIM_LEASE_MS = 10 * 60 * 1000;

/**
 * Atomically claim the right to dispatch this ledger row's delivery, so two
 * concurrent same-key retries cannot both ingest a duplicate episode. A
 * compare-and-set `updateMany`, not a plain `update`: it only succeeds while
 * `ingestedAt` is still null (nothing to claim once delivery genuinely
 * landed) AND `deliveryClaimedAt` is either null or past its lease (nobody
 * else is currently — or still plausibly — working the same delivery).
 *
 * Returns a fresh, opaque `randomUUID()` token identifying THIS attempt's
 * claim on success, or `null` if the claim was lost — a caller that loses
 * must not dispatch, since some other attempt (the original fresh write, or
 * an earlier repair) already owns it and is trusted to finish. The caller
 * must hold onto the returned token and present it back to
 * `releaseDeliveryClaim` if its own dispatch fails: see `deliveryClaimToken`'s
 * doc comment in schema.prisma for why a token, not the claim timestamp
 * itself, is what a release must fence on.
 */
async function claimDeliveryAttempt(orgId: string, key: string): Promise<string | null> {
  const token = randomUUID();
  const leaseExpiresBefore = new Date(Date.now() - DELIVERY_CLAIM_LEASE_MS);
  const { count } = await db.contactIdempotencyKey.updateMany({
    where: {
      orgId,
      key,
      ingestedAt: null,
      OR: [{ deliveryClaimedAt: null }, { deliveryClaimedAt: { lt: leaseExpiresBefore } }],
    },
    data: { deliveryClaimedAt: new Date(), deliveryClaimToken: token },
  });
  return count === 1 ? token : null;
}

/**
 * Release a claim taken by `claimDeliveryAttempt` (or baked into
 * `upsertContact`'s own create, which claims for itself) after the dispatch
 * attempt it guarded actually failed. This is what keeps the lease above from
 * adding latency to the repair path: a synchronous enqueue failure is
 * detected immediately, so the claim comes back off immediately too, instead
 * of making a genuinely-failed dispatch's own retry wait out the full lease.
 *
 * Fenced on `deliveryClaimToken: token` — the caller's OWN claim token, not a
 * timestamp. A release that checked only `ingestedAt: null` would let a stale
 * attempt whose dispatch outlived its own lease clear a DIFFERENT, live claim
 * that a reclaiming attempt had since taken (three `ingestMemory` calls for
 * one accepted write). Fencing on `deliveryClaimedAt` equality does not work
 * either: `new Date()` has millisecond resolution, so a reclaim landing in
 * the same millisecond as the stale claim produces an equal timestamp and the
 * fence silently degrades to unfenced (agent-contacts.stale-release.test.ts's
 * same-millisecond case). A `randomUUID()` per attempt has no such collision:
 * a stale caller's release matches zero rows once its own token is no longer
 * the one on the row, leaving whichever attempt currently holds the claim
 * untouched. Also guarded on `ingestedAt: null` so a release racing a real,
 * just-landed delivery can't clobber it back to reclaimable.
 */
async function releaseDeliveryClaim(orgId: string, key: string, token: string): Promise<void> {
  await db.contactIdempotencyKey.updateMany({
    where: { orgId, key, ingestedAt: null, deliveryClaimToken: token },
    data: { deliveryClaimedAt: null, deliveryClaimToken: null },
  });
}

/**
 * Replay a previously-recorded upsert outcome verbatim: this reads
 * `resultSnapshot`, the AgentContactSummary frozen at the moment the original
 * write was accepted, instead of re-fetching the live contact row. A live
 * re-fetch would return whatever the contact looks like NOW — including edits
 * made by someone else since the original call — silently breaking the
 * documented "returns the first call's recorded outcome verbatim" guarantee.
 * It also means a replay never needs `contactId` to resolve to anything: the
 * contact can since have been hard-deleted (services/memory/person-erasure.ts)
 * and this still returns the exact result the original caller got.
 *
 * A null `ingestedAt` means the write and its ledger row committed but the
 * memory-graph sync has not been confirmed delivered (the enqueue threw after
 * `db.$transaction` resolved, or delivery is still in flight — see
 * `ingestContactWrite`'s doc comment on why that failure isn't swallowed).
 * Returning the recorded success without repairing a failed sync would leave
 * an agent-written contact silently missing from the graph, with the retry
 * that should have caught it reporting success too. So a null `ingestedAt`
 * re-attempts the sync first; `ingestContactWrite` only marks the row
 * ingested once the write actually lands, and a repeat failure propagates the
 * same way a first-attempt failure does, so the caller's retry keeps trying.
 *
 * `key.contactId` is nulled by Contact's `onDelete: SetNull` the moment a
 * human hard-deletes the contact (services/memory/person-erasure.ts).
 * Repairing the sync at that point would re-ingest the frozen
 * `resultSnapshot` and reseed a person the delete was supposed to remove —
 * the graph has no way to know the row underneath is gone. Only repair while
 * the contact this key points to is still live; a null `contactId` skips the
 * repair (still returns the recorded outcome).
 *
 * The repair attributes the fact to `key.actorId`, the ORIGINAL write's actor
 * recorded at create time — never `ctx.actor.id`, which here is whoever
 * happens to be retrying and would otherwise silently reassign authorship for
 * provenance ranking.
 *
 * A null `ingestedAt` includes a delivery that is still genuinely in flight,
 * not just one that has failed. An ordinary client retry-on-timeout landing
 * while the ORIGINAL dispatch is still working would otherwise walk straight
 * into this branch and fire a second, redundant
 * `ingestContactWrite`/`ingestMemory` call, burning org episode-cap quota on a
 * duplicate episode. `claimDeliveryAttempt` closes that: only the caller that
 * wins the atomic claim dispatches; a caller that loses trusts whichever
 * attempt already holds the claim (the original dispatch, or an earlier
 * repair) to finish, rather than racing it.
 */
async function replayIdempotentResult(
  ctx: AccessContext,
  key: {
    orgId: string;
    key: string;
    requestHash: string;
    resultAction: string;
    resultSnapshot: Prisma.JsonValue;
    ingestedAt: Date | null;
    contactId: string | null;
    actorId: string;
  },
  fingerprint: string,
): Promise<UpsertContactResult> {
  if (key.requestHash !== fingerprint) {
    throw new ContactUpsertError("idempotency_conflict", "idempotencyKey was already used for a different request");
  }
  const contact = key.resultSnapshot as unknown as AgentContactSummary;
  if (!key.ingestedAt && key.contactId) {
    const claimToken = await claimDeliveryAttempt(key.orgId, key.key);
    if (claimToken) {
      try {
        await ingestContactWrite(ctx, contact, key.key, key.actorId);
      } catch (e) {
        await releaseDeliveryClaim(key.orgId, key.key, claimToken);
        throw e;
      }
    }
    // Claim lost: some other attempt already owns this delivery and is
    // still within its lease — trust it, don't redispatch alongside it.
  }
  return {
    action: key.resultAction as "created" | "updated",
    contact,
  };
}

/**
 * Upsert a contact. Enforces, in order:
 *  1. memory.write covers org root (requireContactAccess) — the same
 *     default-deny chokepoint as every other write in this codebase.
 *  2. Idempotency: a repeat call with the same idempotencyKey returns the
 *     original outcome without writing again.
 *  3. Revision precondition: updating an existing contact requires
 *     baseRevision to equal its current revision, or the write is rejected
 *     as stale rather than blindly overwritten.
 *  4. Suppression preservation: `suppressed` is never part of the write this
 *     function issues — an existing suppressed contact stays suppressed no
 *     matter what the caller sends, and this input type has no field that
 *     could set it at all.
 *  5. Memory-graph visibility: an accepted create/update is synced into
 *     Willder's memory graph before this function returns (see the
 *     `ingestMemory` call below) — an agent-created contact invisible in the
 *     graph would defeat the point of the surface.
 *
 * Concurrent same-key retries: two truly concurrent retries under the SAME
 * idempotencyKey can still race
 * each other to the revision precondition before either has recorded the
 * key — the loser's `updateMany` legitimately matches 0 rows once the winner
 * has already advanced `revision`, indistinguishable at that point from a
 * genuinely stale caller-supplied revision. Rather than let that loser see a
 * raw stale_revision error, the catch block below re-checks for a key
 * recorded under this exact idempotencyKey before propagating: if the
 * winner already committed one (it always has, by the time the loser's
 * WHERE clause can even fail against the winner's write), the loser replays
 * that recorded result instead of erroring. A stale_revision from a
 * genuinely different idempotencyKey (an unrelated caller bug, not a safe
 * retry) still propagates as before.
 */
export async function upsertContact(ctx: AccessContext, input: UpsertContactInput): Promise<UpsertContactResult> {
  await requireContactAccess(ctx, "memory.write");

  const idempotencyKey = input.idempotencyKey?.trim();
  if (!idempotencyKey) {
    throw new ContactUpsertError("invalid_input", "idempotencyKey is required");
  }
  const name = input.name?.trim() || undefined;
  const email = input.email?.trim() || undefined;
  if (!input.contactId && !name && !email) {
    throw new ContactUpsertError(
      "invalid_input",
      "at least one of contactId, name, or email is required to match/create a contact",
    );
  }
  if (input.type !== undefined && !CONTACT_TYPES.includes(input.type)) {
    // Defense in depth, not the only gate: the MCP tool's zod schema
    // (mcp/tools.ts) is the normal enforcement point, but this function is
    // the actual public boundary and must not rely solely on one caller
    // validating first.
    throw new ContactUpsertError("invalid_input", `type must be one of ${CONTACT_TYPES.join("|")}`);
  }

  const fingerprint = requestFingerprint(input);

  // Idempotency check FIRST, before touching contacts at all — a replayed
  // call must never re-derive or re-apply the write logic below.
  const existingKey = await db.contactIdempotencyKey.findUnique({
    where: { orgId_key: { orgId: ctx.orgId, key: idempotencyKey } },
  });
  if (existingKey) {
    return replayIdempotentResult(ctx, existingKey, fingerprint);
  }

  // Generated up front, outside the transaction, so both the create() below
  // and this function's own catch block (if dispatch fails right after)
  // reference the exact same token — see releaseDeliveryClaim's doc comment
  // for why a token, not a timestamp, is what a release fences on.
  const freshDeliveryClaimToken = randomUUID();

  try {
    const result = await db.$transaction(async (tx) => {
      let existing: Contact | null = null;
      if (input.contactId) {
        existing = await tx.contact.findFirst({ where: { id: input.contactId, orgId: ctx.orgId } });
        if (!existing) {
          throw new ContactUpsertError("not_found", `contact ${input.contactId} not found`);
        }
      } else if (email) {
        // Case-insensitive, matching searchContacts one function above —
        // otherwise this and that function disagree about whether two
        // spellings are the same address, and an agent that searches (finds
        // the existing row) then upserts (misses it) forks a second,
        // unsuppressed row for the same person. See
        // agent-contacts.suppression.test.ts.
        //
        // Deliberately NOT `email: { equals: email, mode: "insensitive" }`:
        // Prisma 7.8 compiles that to `"email" ILIKE $2` with the caller's
        // raw email as the LIKE pattern, and email has no format validation
        // anywhere on this path (mcp/tools.ts: z.string().optional()). An
        // ordinary address like jane_doe@acme.com then matches a different
        // contact's stored janeXdoe@acme.com (`_` is a single-char LIKE
        // wildcard, `%` matches indiscriminately), and the updateMany below
        // overwrites that unrelated row. If the clobbered row was suppressed,
        // that person's address is gone from the table, so nothing matches
        // them again and the next upsert forks a fresh, sendable row — the
        // same suppression bypass, reached via a new route. LOWER()-equality
        // on both sides gets the same case-insensitivity without ever
        // handing the caller's email to the DB as a pattern, so it closes
        // every LIKE metacharacter (`%`, `_`, the escape char itself), not
        // just underscore. See agent-contacts.match-pattern.test.ts.
        const matches = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM "public"."contacts"
          WHERE "orgId" = ${ctx.orgId} AND LOWER("email") = LOWER(${email})
          LIMIT 1
        `;
        existing = matches[0] ? await tx.contact.findUnique({ where: { id: matches[0].id } }) : null;
      }

      let action: "created" | "updated";
      let contact: Contact;

      if (existing) {
        if (input.baseRevision === undefined) {
          throw new ContactUpsertError(
            "revision_required",
            "baseRevision is required when updating an existing contact",
          );
        }
        // revision still in the WHERE (same concurrency shape as
        // services/memory/fact-provenance.ts's checkFactStaleness updateMany): two
        // concurrent upserts both reading revision N must not both "win" —
        // only the write that actually advances the counter counts.
        const { count } = await tx.contact.updateMany({
          where: { id: existing.id, orgId: ctx.orgId, revision: input.baseRevision },
          data: {
            name,
            email,
            title: input.title,
            description: input.description,
            type: input.type,
            revision: { increment: 1 },
            // suppressed is deliberately absent from this data object —
            // never written by this function, at all, ever.
          },
        });
        if (count === 0) {
          throw new ContactUpsertError(
            "stale_revision",
            `baseRevision ${input.baseRevision} does not match contact ${existing.id}'s current revision`,
          );
        }
        contact = await tx.contact.findUniqueOrThrow({ where: { id: existing.id } });
        action = "updated";
      } else {
        if (input.baseRevision !== undefined) {
          throw new ContactUpsertError("invalid_input", "baseRevision must be omitted when creating a new contact");
        }
        if (!name) {
          throw new ContactUpsertError("invalid_input", "name is required to create a new contact");
        }
        contact = await tx.contact.create({
          data: {
            orgId: ctx.orgId,
            name,
            email: email ?? null,
            title: input.title ?? null,
            description: input.description ?? null,
            type: input.type ?? "prospect",
            // suppressed and revision both take their schema defaults
            // (false, 0) — never set explicitly here.
          },
        });
        action = "created";
      }

      const summary = toSummary(contact);

      try {
        await tx.contactIdempotencyKey.create({
          data: {
            orgId: ctx.orgId,
            key: idempotencyKey,
            requestHash: fingerprint,
            contactId: contact.id,
            resultAction: action,
            resultRevision: contact.revision,
            resultSnapshot: summary as unknown as Prisma.InputJsonValue,
            // The original write's actor — a later repair via
            // replayIdempotentResult attributes the graph fact to this
            // actor, never to whoever retries.
            actorId: ctx.actor.id,
            // Claimed at creation, not via claimDeliveryAttempt — this row
            // is brand new, so there is no existing claim to race; baking
            // the claim straight into the same create() call this
            // transaction already does closes the window a separate claim
            // step would otherwise leave open between "row visible" and
            // "row claimed", during which a same-key replay could see an
            // unclaimed null ingestedAt and dispatch its own redundant
            // delivery.
            deliveryClaimedAt: new Date(),
            // This create()'s own claim token (see releaseDeliveryClaim's
            // doc comment) — generated once, outside this transaction, and
            // reused by this function's outer catch block below if dispatch
            // fails.
            deliveryClaimToken: freshDeliveryClaimToken,
          },
        });
      } catch (e: unknown) {
        if (e && typeof e === "object" && (e as { code?: string }).code === "P2002") {
          // A concurrent call recorded this key first — this transaction's
          // own write must not stand as the winner. Abort by throwing;
          // Prisma rolls back everything this transaction did (including the
          // create/update above), and the outer catch re-reads the
          // now-committed key row for the real outcome.
          throw new IdempotencyKeyRace();
        }
        throw e;
      }

      return { action, contact: summary };
    });
    // Only a real accepted write reaches here — every replay path below
    // returns before this line, so a retry never re-does the write itself
    // (it may still repair a missing graph sync, see replayIdempotentResult).
    // ingestContactWrite marks the ledger row ingested itself, only once the
    // write actually lands — never here, since this line only proves the
    // sync was dispatched, not delivered.
    try {
      await ingestContactWrite(ctx, result.contact, idempotencyKey);
    } catch (e) {
      // Release the claim this create() just took: a stuck claim would make
      // the caller's safe retry wait out the full lease before
      // replayIdempotentResult would even attempt the repair this failure
      // is supposed to trigger.
      await releaseDeliveryClaim(ctx.orgId, idempotencyKey, freshDeliveryClaimToken);
      throw e;
    }
    return result;
  } catch (e) {
    if (e instanceof IdempotencyKeyRace) {
      const raced = await db.contactIdempotencyKey.findUnique({
        where: { orgId_key: { orgId: ctx.orgId, key: idempotencyKey } },
      });
      if (!raced) {
        throw new ContactUpsertError("idempotency_conflict", "concurrent idempotency key write could not be resolved");
      }
      return replayIdempotentResult(ctx, raced, fingerprint);
    }
    if (e instanceof ContactUpsertError && e.code === "stale_revision") {
      // See upsertContact's doc comment: this loser may have
      // lost the race to a concurrent retry under the SAME idempotencyKey,
      // not to a genuinely stale caller-supplied revision. Only replay when
      // a key is actually recorded under this exact key — anything else
      // propagates the real stale_revision as before.
      const raced = await db.contactIdempotencyKey.findUnique({
        where: { orgId_key: { orgId: ctx.orgId, key: idempotencyKey } },
      });
      if (raced) {
        return replayIdempotentResult(ctx, raced, fingerprint);
      }
    }
    throw e;
  }
}

/** Sync an accepted agent-API contact write into Willder's memory graph.
 * Awaited, unlike the two human-facing contact routes' fire-and-forget
 * `void ...ingest(...).catch(() => {})` — matching mcp/tools.ts's own
 * memory_ingest tool instead, the closer precedent for an agent-driven write
 * through a capability token. `ingestMemory` doesn't block on the memory
 * graph actually finishing the write (it enqueues via Inngest, or defers via
 * `after()` in dev bypass mode) — awaiting it only guarantees that
 * enqueue/defer actually happens before this function returns, instead of
 * racing the response. A write this surface exists for must be reliably
 * scheduled, not possibly dropped if the request tears down first (the
 * failure mode `ingestMemory`'s own `after()` comment documents) — worth the
 * small added latency on the agent's response. Deliberately NOT swallowed
 * (`.catch(() => {})` like the human routes do): silently dropping an
 * ingestion failure here would leave agent writes invisible in the graph
 * with no signal at all.
 *
 * Not swallowed means a failure here throws AFTER the contact + ledger row
 * already committed — the caller sees an error for a write that really
 * happened. That's on purpose: `replayIdempotentResult`'s `ingestedAt` check
 * is what actually closes the gap, by re-attempting this same call on the
 * caller's next safe retry instead of the ledger silently recording success
 * with the graph never told. This function itself doesn't need to know about
 * retries at all.
 *
 * `idempotencyKey` is passed through as `IngestInput.confirmDelivery` so the
 * ledger row is marked ingested only once `ingestMemory`'s actual work
 * finishes — never here, since awaiting `ingestMemory` only proves
 * enqueue/dispatch, not delivery (see that field's doc comment in
 * types/memory.ts).
 *
 * `actorId` defaults to the current caller (`ctx.actor.id`) for a fresh
 * write, but `replayIdempotentResult` passes the ORIGINAL write's actor
 * explicitly for a repair — the retrying caller must never be attributed as
 * the fact's author. */
async function ingestContactWrite(
  ctx: AccessContext,
  contact: AgentContactSummary,
  idempotencyKey: string,
  actorId: string = ctx.actor.id,
): Promise<void> {
  const parts = [
    `${contact.name} is a ${contact.type}`,
    contact.title ? `(${contact.title})` : null,
    contact.status !== "active" ? `status: ${contact.status}` : null,
    // description is accepted and persisted by this surface's upsert, so it
    // must reach the graph too.
    contact.description ?? null,
  ].filter(Boolean);
  // Loaded on first use: the Inngest barrel carries every background job, and this
  // module is in /api/mcp's cold-start graph (app/api/mcp/route.cold-start.test.ts).
  const { ingestMemory } = await import("@/lib/inngest");
  await ingestMemory({
    groupId: ctx.orgId,
    content: parts.join(" ") + ".",
    source: "agent-contacts",
    name: contact.name,
    actorType: "agent",
    origin: ctx.origin,
    actorId,
    actorName: `agent:${actorId}`,
    confirmDelivery: { kind: "contact-idempotency-key", orgId: ctx.orgId, key: idempotencyKey },
  });
}
