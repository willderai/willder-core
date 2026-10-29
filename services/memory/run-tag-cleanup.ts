// Removing what a measure run left in the demo scope, found by the run's tag.
//
// A measure run writes its facts into the demo org's demo scope, and every fact it
// writes carries the run's tag: the entity name is the tag or starts with `<tag>-`, and
// the text contains the tag. A run that is killed before it cleans up leaves those facts
// behind, and a later measure that samples the demo scope draws them instead of the
// product's own content. This module finds them and removes them.
//
// The rule it enforces: only a tagged fact in the configured demo scope of the configured
// demo org is ever removed, and only through the product's own fact delete
// (`GuardedMemoryStore.removeFact`, the path `DELETE /api/memory/facts/:id` takes), so each
// removal is authorized by `check()`, audited, and announced on the change feed exactly as
// a person's delete is. Any other org or scope, a malformed tag, or an untagged row is
// refused rather than narrowed. Listing them is a memory read like any other: `check()`
// authorizes it on the demo scope and the audit log records it.
//
// What a fact delete removes and keeps, and therefore what this does:
//  - removed: the `memory_chunks` row, its embedding (a column of that row), and its
//    `memory_chunk_passages` and `fact_version_reads` rows (cascade);
//  - appended: one `memory.delete` audit row pair and one `delete` change event per fact;
//  - kept: the fact's `create` change event (the feed is append-only), `fact_edges` rows
//    naming it, and audit rows (the audit log refuses UPDATE and DELETE).
// Graph episodes are not removed. The memory service stamps each episode with the chunk id
// it came from but offers no way to delete episodes by that stamp, and the product's own
// fact delete has the same limit. The report says so instead of counting them as removed.
import { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import {
  AccessDeniedError,
  check,
  flattenSql,
  isValidLtreePath,
  orgRootPath,
  scopeContainsSql,
  type AccessContext,
} from "@/services/access";
import { escapeLikePrefix } from "@/services/access/scope-containment";
import { FACT_RECORD_TYPE } from "./change-events";
import { RemovalNotRecordedError } from "./fact-change-event";
import { guardedMemory } from "./guarded-store";
import { RUN_TAG_PATTERN } from "./run-tag";

/** The one org and scope this command may ever remove from, read from the environment. */
export interface DemoTarget {
  orgId: string;
  scopePath: string;
}

/** What one invocation asks to clean. */
export interface CleanupRequest {
  orgId: string;
  scopePath: string;
  tag: string;
}

/** A request the command will not carry out. Nothing has been read or changed when it is thrown. */
export class CleanupRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CleanupRefusedError";
  }
}

/** One tagged fact, as the dry run lists it. */
export interface TaggedFact {
  id: string;
  scopePath: string;
  entityName: string;
  createdAt: string;
}

/** Everything a removal touches or leaves, counted per table, for the tagged facts found. */
export interface RunTagInventory {
  orgId: string;
  scopePath: string;
  tag: string;
  facts: TaggedFact[];
  removedWithFacts: {
    memoryChunks: number;
    embeddings: number;
    factVersionReads: number;
  };
  kept: {
    changeEvents: number;
    factEdges: number;
  };
  /** What happens to each fact's graph episode, which the counts leave out. */
  graph: string;
}

/** What an applied cleanup did. */
export interface RunTagRemoval {
  removed: string[];
  /** Listed facts that are not, or no longer, the run's tagged facts in the demo scope: left untouched. */
  skipped: string[];
  /** Tagged facts the store no longer held when their turn came, so nothing was removed for them. */
  alreadyGone: string[];
  /** Tagged facts still in the scope afterwards: those written since the list was made. */
  remaining: number;
  /** What the removed facts left in place, counted after the removal. */
  kept: { changeEvents: number; factEdges: number };
}

export const GRAPH_REMOVAL =
  "removed with each fact, not counted: the product's fact delete retires the graph episode and facts distilled from the chunk, at the chunk's own scope, before it deletes the chunk";

/**
 * The demo org and demo scope from `DEMO_ORG_ID` and `DEMO_SCOPE_PATH`. The scope must
 * be a valid path strictly inside the org's root: the root itself is never a demo scope.
 */
export function demoTargetFrom(env: Record<string, string | undefined>): DemoTarget {
  const orgId = env.DEMO_ORG_ID?.trim();
  const scopePath = env.DEMO_SCOPE_PATH?.trim();
  if (!orgId) throw new CleanupRefusedError("Set DEMO_ORG_ID to the demo org's id.");
  if (!scopePath) throw new CleanupRefusedError("Set DEMO_SCOPE_PATH to the demo scope's path.");
  const root = orgRootPath(orgId);
  if (!isValidLtreePath(scopePath) || !scopePath.startsWith(`${root}.`)) {
    throw new CleanupRefusedError(
      `DEMO_SCOPE_PATH must be a scope inside ${root}, not the org root or another org's scope.`,
    );
  }
  return { orgId, scopePath };
}

/**
 * Refuse a request for any org but the demo org, any scope but the demo scope, or a tag
 * that is not one run's tag. A child of the demo scope is refused too: name the demo
 * scope, and its children are cleaned with it.
 */
export function assertCleanupAllowed(request: CleanupRequest, demo: DemoTarget): void {
  if (request.orgId !== demo.orgId) {
    throw new CleanupRefusedError(
      `Org ${request.orgId} is not the demo org (DEMO_ORG_ID); this command only cleans the demo org.`,
    );
  }
  if (request.scopePath !== demo.scopePath) {
    throw new CleanupRefusedError(
      `Scope ${request.scopePath} is not the demo scope (DEMO_SCOPE_PATH); this command only cleans the demo scope.`,
    );
  }
  if (!RUN_TAG_PATTERN.test(request.tag)) {
    throw new CleanupRefusedError(
      `"${request.tag}" is not a run tag. A run tag is a lowercase prefix, a hyphen and a 12- or 14-digit timestamp, e.g. ltload-20261005213000.`,
    );
  }
}

/** `carriesRunTag` (run-tag.ts) as SQL, within the demo scope: the rows that are this run's facts. */
function taggedIn(request: CleanupRequest): Prisma.Sql {
  const within = scopeContainsSql(Prisma.raw('"scopePath"'), request.scopePath, { relation: "within", mode: "text" });
  const namedByTag = `${escapeLikePrefix(request.tag)}-%`;
  return Prisma.sql`"orgId" = ${request.orgId} AND ${within}
    AND ("entityName" = ${request.tag} OR "entityName" LIKE ${namedByTag} ESCAPE '\\')
    AND strpos("content", ${request.tag}) > 0`;
}

async function count(query: Prisma.Sql): Promise<number> {
  const rows = await db.$queryRaw<{ n: number }[]>(...flattenSql(query));
  return rows[0]?.n ?? 0;
}

/** The change events and fact edges that name `ids`: what a fact delete leaves in place. */
async function keptBy(orgId: string, ids: string[]): Promise<{ changeEvents: number; factEdges: number }> {
  if (ids.length === 0) return { changeEvents: 0, factEdges: 0 };
  const [changeEvents, factEdges] = await Promise.all([
    count(Prisma.sql`SELECT COUNT(*)::int AS n FROM "change_events"
      WHERE "orgId" = ${orgId} AND "recordType" = ${FACT_RECORD_TYPE} AND "recordId" IN (${Prisma.join(ids)})`),
    count(Prisma.sql`SELECT COUNT(*)::int AS n FROM "fact_edges"
      WHERE "orgId" = ${orgId} AND ("fromId" IN (${Prisma.join(ids)}) OR "toId" IN (${Prisma.join(ids)}))`),
  ]);
  return { changeEvents, factEdges };
}

/** Refuse an actor from another org, then authorize `action` on the demo scope as `ctx`. */
async function authorize(
  ctx: AccessContext,
  action: "memory.read",
  request: CleanupRequest,
  demo: DemoTarget,
): Promise<void> {
  assertCleanupAllowed(request, demo);
  if (ctx.orgId !== demo.orgId)
    throw new CleanupRefusedError(`The acting user belongs to ${ctx.orgId}, not the demo org.`);
  const decision = await check(ctx, { action, scope: request.scopePath, target: `run_tag:${request.tag}` });
  if (!decision.allowed)
    throw new CleanupRefusedError(
      `Listing run ${request.tag} was refused (${decision.reason}). Act as a user who can read the demo scope.`,
    );
}

/**
 * List the run's tagged facts in the demo scope and count what removing them touches, as
 * `ctx`. Changes no memory; the read is authorized and audited like any memory read.
 */
export async function inventoryRunTag(
  ctx: AccessContext,
  request: CleanupRequest,
  demo: DemoTarget,
): Promise<RunTagInventory> {
  await authorize(ctx, "memory.read", request, demo);
  const rows = await db.$queryRaw<
    { id: string; scopePath: string; entityName: string; createdAt: Date; embedded: boolean }[]
  >(
    ...flattenSql(Prisma.sql`SELECT "id", "scopePath", "entityName", "createdAt", ("embedding" IS NOT NULL) AS "embedded"
      FROM "memory_chunks" WHERE ${taggedIn(request)} ORDER BY "createdAt", "id"`),
  );
  const ids = rows.map((r) => r.id);
  const [factVersionReads, kept] = await Promise.all([
    ids.length === 0
      ? 0
      : count(Prisma.sql`SELECT COUNT(*)::int AS n FROM "fact_version_reads"
          WHERE "orgId" = ${request.orgId} AND "versionId" IN (${Prisma.join(ids)})`),
    keptBy(request.orgId, ids),
  ]);
  return {
    ...request,
    facts: rows.map((r) => ({
      id: r.id,
      scopePath: r.scopePath,
      entityName: r.entityName,
      createdAt: r.createdAt.toISOString(),
    })),
    removedWithFacts: {
      memoryChunks: rows.length,
      embeddings: rows.filter((r) => r.embedded).length,
      factVersionReads,
    },
    kept,
    graph: GRAPH_REMOVAL,
  };
}

/**
 * Remove the facts `reviewed` lists, one product fact delete each, as `ctx`. Only a listed
 * fact that is still one of the run's tagged facts in the demo scope is removed, so a list
 * that was edited, or has gone stale, can never reach anything else; every other listed id
 * is skipped. Each delete is authorized and executed at the fact's own scope, so its change
 * event lands where the fact's readers will see it. Stops at the first refusal, naming it;
 * a rerun continues from what is left.
 */
export async function removeRunTag(
  ctx: AccessContext,
  reviewed: RunTagInventory,
  demo: DemoTarget,
): Promise<RunTagRemoval> {
  const request = { orgId: reviewed.orgId, scopePath: reviewed.scopePath, tag: reviewed.tag };
  const current = new Map((await inventoryRunTag(ctx, request, demo)).facts.map((f) => [f.id, f.scopePath]));
  const removed: string[] = [];
  const skipped: string[] = [];
  const alreadyGone: string[] = [];
  for (const { id } of reviewed.facts) {
    const scopePath = current.get(id);
    if (scopePath === undefined) {
      skipped.push(id);
      continue;
    }
    try {
      const result = await guardedMemory.removeFact(ctx, { groupId: demo.orgId, factId: id }, scopePath);
      (result.removed ? removed : alreadyGone).push(id);
    } catch (e) {
      if (e instanceof RemovalNotRecordedError) {
        // Removed, though the change feed does not say so.
        console.error(`[run-tag-cleanup] ${e.message}`);
        removed.push(id);
        continue;
      }
      if (e instanceof AccessDeniedError) {
        throw new CleanupRefusedError(
          `Removing ${id} was refused (${e.decision.reason}); ${removed.length} removed before it. Act as a user with write on the demo scope.`,
        );
      }
      throw e;
    }
  }
  const remaining = (await inventoryRunTag(ctx, request, demo)).facts.length;
  return { removed, skipped, alreadyGone, remaining, kept: await keptBy(demo.orgId, removed) };
}
