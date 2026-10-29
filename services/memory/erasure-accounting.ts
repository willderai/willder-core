/**
 * How a person erasure accounts for what it removed, across steps that commit on their own.
 *
 * The rule this file enforces: the one `person.erased` audit row an erasure ends with
 * carries every record removed for that person, including those an earlier attempt removed
 * before it failed and was sent again. Counts and ids only, never a value.
 *
 * An erasure commits in steps (services/memory/person-erasure.ts): the graph, then the
 * chunks, the change-feed summaries, the rules, the versions written in place of what those removed,
 * and the briefs, then one last transaction that removes the working notes and the contacts. Each step before the last writes a hidden `person.erasure_step` row with
 * its counts, in the same transaction as its removals wherever the store is Postgres. The
 * last transaction sums the step rows of its own request and of every earlier request for
 * the same contacts that never reached a `person.erased` row, writes the one
 * `person.erased` row from those totals, and names the earlier requests on it, so a later
 * sum leaves them out.
 *
 * A request for a person with no contact row cannot be linked to an earlier attempt: its
 * row carries its own counts only.
 */

import { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import { orgRootPath, writeAuditRow, type AccessContext, type DerivedAuditAction } from "@/services/access";
import { erasureCountsOf } from "@/services/audit/erasure-counts";
import type { GraphPersonErasureResult } from "./graphiti-store";

/**
 * How many records one erasure removed from each store. Counts only, never a value. A
 * graph count the memory service reported as anything but a non-negative integer is left
 * out, never written as a number it did not report.
 */
export interface ErasureStoreCounts {
  graph: Partial<GraphPersonErasureResult>;
  vector: { chunks: number };
  contacts: { contacts: number; ledgerSnapshots: number };
  changeFeed: { summariesBlanked: number };
  briefs: { briefs: number };
  /**
   * Stored versions removed for what they are rather than for naming the person: those
   * written in place of a removed version (`replacements`), and those whose announcement on
   * the change feed named the person (`announced`), such as a Drive file named after them
   * (services/memory/erasure-lineage.ts). Their rows also count in the stores above.
   */
  lineage: { replacements: number; announced: number };
  /** Rule versions redacted and retired (services/memory/erasure-rules.ts). */
  rules: { rules: number };
  /** Working notes whose task or body named the person (services/memory/working-notes.ts). */
  notes: { notes: number };
}

/** One request, as its step rows name it: its id, and the contact rows it erases. */
export interface ErasureRequest {
  requestId: string;
  contactIds: string[];
}

const ERASED: DerivedAuditAction = "person.erased";
const STEP: DerivedAuditAction = "person.erasure_step";

/** The counts of a graph step that removed nothing. */
export const NO_GRAPH_COUNTS: GraphPersonErasureResult = { episodes: 0, nodes: 0, edges: 0, summaries: 0 };

/** Each kind of record a store counts. */
const KINDS: Record<keyof ErasureStoreCounts, readonly string[]> = {
  graph: ["episodes", "nodes", "edges", "summaries"],
  vector: ["chunks"],
  contacts: ["contacts", "ledgerSnapshots"],
  changeFeed: ["summariesBlanked"],
  briefs: ["briefs"],
  lineage: ["replacements", "announced"],
  rules: ["rules"],
  notes: ["notes"],
};

/** Nothing counted yet: every Postgres count at zero, and no graph count until a step reports one. */
export function noCounts(): ErasureStoreCounts {
  return {
    graph: {},
    vector: { chunks: 0 },
    contacts: { contacts: 0, ledgerSnapshots: 0 },
    changeFeed: { summariesBlanked: 0 },
    briefs: { briefs: 0 },
    lineage: { replacements: 0, announced: 0 },
    rules: { rules: 0 },
    notes: { notes: 0 },
  };
}

/**
 * `total` with `part` added, store by store and kind by kind. Only the kinds in
 * {@link KINDS} are added, and only non-negative integers, so a step row cannot put
 * anything else into the audit row.
 */
export function addCounts(total: ErasureStoreCounts, part: Partial<ErasureStoreCounts>): ErasureStoreCounts {
  const sum = structuredClone(total);
  const into = sum as unknown as Record<string, Record<string, number>>;
  for (const [store, kinds] of Object.entries(erasureCountsOf({ stores: part }) ?? {})) {
    if (!(store in KINDS)) continue;
    for (const [kind, count] of Object.entries(kinds)) {
      if (KINDS[store as keyof ErasureStoreCounts].includes(kind)) into[store][kind] = (into[store][kind] ?? 0) + count;
    }
  }
  return sum;
}

/**
 * The graph's counts as an audit row stores them. They arrive as JSON from the memory
 * service, so each is kept only if it is a non-negative integer.
 */
function graphCountsForAudit(graph: Partial<GraphPersonErasureResult>): Partial<GraphPersonErasureResult> {
  const counts: Partial<GraphPersonErasureResult> = {};
  for (const key of ["episodes", "nodes", "edges", "summaries"] as const) {
    const value: unknown = graph[key];
    if (Number.isInteger(value) && (value as number) >= 0) counts[key] = value as number;
  }
  return counts;
}

/** `stores` as audit metadata, built field by field so nothing but a count can reach it. */
function countsForAudit(stores: Partial<ErasureStoreCounts>): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  if (stores.graph) out.graph = graphCountsForAudit(stores.graph);
  if (stores.vector) out.vector = { chunks: stores.vector.chunks };
  if (stores.contacts)
    out.contacts = { contacts: stores.contacts.contacts, ledgerSnapshots: stores.contacts.ledgerSnapshots };
  if (stores.changeFeed) out.changeFeed = { summariesBlanked: stores.changeFeed.summariesBlanked };
  if (stores.briefs) out.briefs = { briefs: stores.briefs.briefs };
  if (stores.lineage) out.lineage = { replacements: stores.lineage.replacements, announced: stores.lineage.announced };
  if (stores.rules) out.rules = { rules: stores.rules.rules };
  if (stores.notes) out.notes = { notes: stores.notes.notes };
  return out;
}

const targetOf = (ctx: AccessContext, requestId: string) => `${orgRootPath(ctx.orgId)}/person_erasure:${requestId}`;

/**
 * Record what one committed step of `request` removed. Pass the step's own transaction
 * as `client`, so the counts commit exactly when the removals do.
 */
export async function recordErasureStep(
  client: Pick<Prisma.TransactionClient, "auditLog">,
  ctx: AccessContext,
  request: ErasureRequest,
  stores: Partial<ErasureStoreCounts>,
): Promise<void> {
  await writeAuditRow(
    {
      orgId: ctx.orgId,
      actorType: ctx.actor.type,
      actorId: ctx.actor.id,
      action: STEP,
      target: targetOf(ctx, request.requestId),
      decision: "allow",
      metadata: { requestId: request.requestId, contactIds: request.contactIds, stores: countsForAudit(stores) },
      runId: ctx.runId,
      origin: ctx.origin,
    },
    client,
  );
}

/**
 * The counts of every step `request` committed, and of every step an earlier request for
 * one of the same contacts committed without ever reaching a `person.erased` row, with
 * those earlier requests' ids. Step rows are read from `since` on: no attempt at erasing
 * these contacts started before then.
 */
export async function unreportedSteps(
  orgId: string,
  request: ErasureRequest,
  since: Date,
): Promise<{ stores: ErasureStoreCounts; earlierRequestIds: string[] }> {
  const from = Prisma.sql`(${since.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
  const rows = await db.$queryRaw<{ requestId: string; metadata: unknown }[]>`
    SELECT s.metadata->>'requestId' AS "requestId", s.metadata
    FROM audit_log s
    WHERE s."orgId" = ${orgId} AND s.at >= ${from} AND s.action = ${STEP}
      AND (s.metadata->>'requestId' = ${request.requestId}
           OR jsonb_exists_any(s.metadata->'contactIds', ${request.contactIds}::text[]))
      AND NOT EXISTS (
        SELECT 1 FROM audit_log e
        WHERE e."orgId" = ${orgId} AND e.at >= ${from} AND e.action = ${ERASED}
          AND (e.metadata->>'requestId' = s.metadata->>'requestId'
               OR jsonb_exists(coalesce(e.metadata->'earlierRequestIds', '[]'::jsonb), s.metadata->>'requestId'))
      )
  `;
  let stores = noCounts();
  for (const row of rows) {
    const metadata = row.metadata as { stores?: unknown } | null;
    stores = addCounts(stores, (erasureCountsOf(metadata) ?? {}) as Partial<ErasureStoreCounts>);
  }
  const earlierRequestIds = [...new Set(rows.map((r) => r.requestId))].filter((id) => id !== request.requestId).sort();
  return { stores, earlierRequestIds };
}

/**
 * Write the erasure's one `person.erased` row. Its target is the decision row's
 * (`<org root>/person_erasure:<requestId>`), so the two read as one request; its metadata
 * is the request id, the per-store totals, and the earlier requests whose counts those
 * totals include.
 */
export async function recordErasureCounts(
  tx: Prisma.TransactionClient,
  ctx: AccessContext,
  requestId: string,
  stores: ErasureStoreCounts,
  earlierRequestIds: string[],
): Promise<void> {
  await writeAuditRow(
    {
      orgId: ctx.orgId,
      actorType: ctx.actor.type,
      actorId: ctx.actor.id,
      action: ERASED,
      target: targetOf(ctx, requestId),
      decision: "allow",
      metadata: {
        requestId,
        stores: countsForAudit(stores),
        ...(earlierRequestIds.length > 0 ? { earlierRequestIds } : {}),
      },
      runId: ctx.runId,
      origin: ctx.origin,
    },
    tx,
  );
}
