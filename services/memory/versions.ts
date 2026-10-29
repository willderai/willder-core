// Read one stored version of a fact or a rule by its id.
//
// Every change notice hands a reader an id: the version an ingest stored, the rule a
// replacement superseded, the version that lost a race. Before this file none of those
// ids resolved anywhere — no tool and no route read a version by id — so a notice
// pointed at nothing, which is worse than issuing no id at all.
//
// The one rule this file enforces: a version is served only to a caller allowed to
// read the scope the version itself is stored in, and an unreadable version is
// indistinguishable from a missing one. The caller never names the scope; the version
// carries it, so an id from a notice is enough to follow.
//
// A version's lineage (what replaced it, what it replaced) names other versions by id
// without a check of its own. Every `supersedes` edge between fact versions joins two
// versions stored in one scope (services/memory/edges.ts), so a reader of one end can
// read the other. A version that reads as erased is never named, the same rule that
// makes it read as missing here.
import { db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { check, orgRootPath, type AccessContext } from "@/services/access";
import { loadErasedContentFilter, type ErasedContentFilter } from "./erasure-suppression";

/** Which store a version came from. */
export type VersionKind = "fact" | "convention";

/** Whether a version is the one in force, and why not when it is not. */
export type VersionStatus = "current" | "superseded" | "retired";

/** One stored version, as a reader following an id from a change notice sees it. */
export interface MemoryVersion {
  id: string;
  kind: VersionKind;
  /** The scope the version is stored in, which is also the scope it is read under. */
  scopePath: string;
  /** The version's own text. For a rule, its subject and text. */
  content: string;
  /** The entity the fact is about, or the rule's subject. Null when none was given. */
  subject: string | null;
  /** User id or agent id that wrote it. Null for rows written before it was recorded. */
  actorId: string | null;
  createdAt: Date;
  status: VersionStatus;
  /** The version that replaced this one, when it was superseded. Null when the version
   * that replaced it reads as erased; `status` still says it was superseded. */
  supersededById: string | null;
  /** The versions this one replaced, leaving out any that reads as erased. */
  supersedesIds: string[];
}

/**
 * The version `id` names, or null when this org has no such version or the caller may
 * not read the scope it lives in.
 *
 * One `memory.read` decision is made and audited, against the version's own scope. An
 * id that names nothing is decided at the org root and still answers null, so it costs
 * the same decision and leaves the same one row as a version the caller may not read
 * (the rule services/access/authorize-record.ts states for records looked up by id).
 * Facts are looked up first, then rules; the two id spaces are disjoint cuids, so the
 * order only decides which query answers.
 */
export async function readMemoryVersion(ctx: AccessContext, id: string): Promise<MemoryVersion | null> {
  const found = (await readFactVersion(ctx.orgId, id)) ?? (await readConventionVersion(ctx.orgId, id));
  const decision = await check(ctx, { action: "memory.read", scope: found?.scopePath ?? orgRootPath(ctx.orgId) });
  if (!found || !decision.allowed) return null;

  const lineage = mergeLineage(found, await supersessionEdges(ctx.orgId, id));
  return {
    ...found,
    ...(await withoutErasedVersions(ctx.orgId, lineage)),
    // From the lineage as recorded: a version an erased one replaced stays superseded,
    // as every read path still treats it.
    status: found.status === "retired" ? "retired" : lineage.supersededById ? "superseded" : "current",
  };
}

/** Which version replaced this one and which it replaced: the answer `readMemoryVersion` gives. */
export type VersionLineage = Pick<MemoryVersion, "supersededById" | "supersedesIds">;

/**
 * The lineage of version `id`, for a caller that has already made its own audited
 * `memory.read` decision on the scope the version sits in (the audit Timeline's detail
 * route). Makes no access decision of its own. A version whose row is gone, such as a
 * corrected fact, still answers from the dependency graph.
 */
export async function readVersionLineage(orgId: string, id: string): Promise<VersionLineage> {
  const found = (await readFactVersion(orgId, id)) ?? (await readConventionVersion(orgId, id));
  return withoutErasedVersions(orgId, mergeLineage(found, await supersessionEdges(orgId, id)));
}

/** Who wrote a stored fact version, as its row records it. */
export interface VersionWriter {
  actorType: string;
  actorName: string;
}

/** What a citation reads from one stored fact version's row. */
export interface VersionStamp {
  /** Who wrote it, when the row names its writer and came from no connected source. */
  writer: VersionWriter | null;
  /**
   * When its content happened, as ISO-8601: its writer's `occurredAt`, or when the row was
   * stored. The date a read serves the version itself with (pgvector-store.ts).
   */
  datedAt: string;
}

/**
 * The writer and date of each fact version in `ids`, by version id, for a caller citing
 * facts that a read it has already authorized and audited served (mcp/fact-citation.ts).
 * Makes no access decision of its own. Only this org's rows answer; any other id is
 * absent from the map.
 */
export async function readVersionStamps(orgId: string, ids: string[]): Promise<Map<string, VersionStamp>> {
  if (ids.length === 0) return new Map();
  const rows = await db.memoryChunk.findMany({
    where: { orgId, id: { in: ids } },
    select: { id: true, actorType: true, actorName: true, sourceId: true, occurredAt: true, createdAt: true },
  });
  return new Map(
    rows.map((r) => [
      r.id,
      {
        writer: r.actorName && r.sourceId === null ? { actorType: r.actorType, actorName: r.actorName } : null,
        datedAt: (r.occurredAt ?? r.createdAt).toISOString(),
      },
    ]),
  );
}

/** A store row's own lineage joined with the graph's; the row wins on the replacement. */
function mergeLineage(found: VersionLineage | null, edges: VersionLineage): VersionLineage {
  return {
    supersededById: found?.supersededById ?? edges.supersededById,
    supersedesIds: [...new Set([...(found?.supersedesIds ?? []), ...edges.supersedesIds])],
  };
}

/**
 * `lineage` without the versions that read as erased: those whose stored row, or the
 * change that announced them, names a person erased from the org and was written at or
 * before that erasure, or whose id an erasure removed, as it removes a version written in
 * place of an erased one (services/memory/erasure-suppression.ts). The erasure itself
 * deletes such rows and blanks such summaries; this keeps a copy a restored backup put
 * back from returning through another version's lineage, where the audit Timeline would
 * link to it and show its text. Reads nothing when the lineage names no version.
 */
async function withoutErasedVersions(orgId: string, lineage: VersionLineage): Promise<VersionLineage> {
  const named = [...lineage.supersedesIds, ...(lineage.supersededById ? [lineage.supersededById] : [])];
  if (named.length === 0) return lineage;
  const gone = await versionsReadingAsErased(orgId, named);
  if (gone.size === 0) return lineage;
  return {
    supersededById: lineage.supersededById && !gone.has(lineage.supersededById) ? lineage.supersededById : null,
    supersedesIds: lineage.supersedesIds.filter((id) => !gone.has(id)),
  };
}

/**
 * Which of `ids` read as erased: a stored fact row, a rule, or a change that announced the
 * id, that names a person erased from the org and was written at or before that erasure,
 * or an id an erasure removed or redacted (services/memory/erasure-suppression.ts). Any
 * reader that names a version by id without serving it, such as a lineage or the
 * dependency graph (services/memory/dependencies.ts), leaves these out. Reads nothing
 * when `ids` is empty. A caller that asks several times in one read passes the org's
 * `filter`, loaded once, instead of reading the suppression list on every call.
 */
export async function versionsReadingAsErased(
  orgId: string,
  ids: readonly string[],
  filter?: Promise<ErasedContentFilter>,
): Promise<Set<string>> {
  const named = [...new Set(ids)];
  if (named.length === 0) return new Set();
  const [erased, rows, rules, announcements] = await Promise.all([
    filter ?? loadErasedContentFilter(orgId),
    db.memoryChunk.findMany({
      where: { orgId, id: { in: named } },
      select: { id: true, content: true, entityName: true, createdAt: true },
    }),
    db.convention.findMany({
      where: { orgId, id: { in: named } },
      select: { id: true, subject: true, text: true, createdAt: true },
    }),
    db.changeEvent.findMany({
      where: { orgId, recordId: { in: named }, op: { in: ["create", "update"] } },
      select: { recordId: true, summary: true, createdAt: true },
    }),
  ]);
  return new Set([
    ...rows.filter((r) => erased(r.content, r.createdAt, r.entityName, r.id)).map((r) => r.id),
    ...rules
      .filter((r) => erased(`${r.subject}\n${r.text}`, r.createdAt, r.subject) || erased.byRuleId(r.id, r.createdAt))
      .map((r) => r.id),
    ...announcements.filter((e) => erased(e.summary, e.createdAt, null, e.recordId)).map((e) => e.recordId),
    // Judged by the id alone as well: an erasure removes a version's row and blanks its
    // announcement, and redacts a rule in place, so the id is how either is still known.
    ...named.filter((id) => erased("", null, null, id) || erased.byRuleId(id, null)),
  ]);
}

/** What a store lookup knows on its own, before the dependency graph is consulted. */
type StoredVersion = Omit<MemoryVersion, "status"> & { status: "current" | "retired" };

/** One row of `memory_chunks`, the store the request path writes a fact version to. */
async function readFactVersion(orgId: string, id: string): Promise<StoredVersion | null> {
  const rows = await db.$queryRaw<
    {
      id: string;
      content: string;
      entityName: string | null;
      scopePath: string | null;
      actorId: string | null;
      createdAt: Date;
    }[]
  >(Prisma.sql`
    SELECT "id", "content", "entityName", "scopePath", "actorId", "createdAt"
    FROM "memory_chunks"
    WHERE "id" = ${id} AND "orgId" = ${orgId}
    LIMIT 1
  `);
  const row = rows[0];
  if (!row) return null;
  // A version naming a person erased from the org, written at or before that erasure, is
  // a copy a restored backup put back; it reads as missing, the same as on the vector read
  // (services/memory/erasure-suppression.ts).
  const erased = await loadErasedContentFilter(orgId);
  if (erased(row.content, new Date(row.createdAt), row.entityName, row.id)) return null;
  return {
    id: row.id,
    kind: "fact",
    // An ingest that named no scope is stored with none; it is read under the org root,
    // the same default its change event was written under.
    scopePath: row.scopePath ?? orgRootPath(orgId),
    content: row.content,
    subject: row.entityName,
    actorId: row.actorId,
    createdAt: new Date(row.createdAt),
    status: "current",
    supersededById: null,
    supersedesIds: [],
  };
}

/** One row of `conventions`, the store a rule version lives in. */
async function readConventionVersion(orgId: string, id: string): Promise<StoredVersion | null> {
  const rule = await db.convention.findFirst({
    where: { id, orgId },
    select: {
      id: true,
      scopePath: true,
      kind: true,
      subject: true,
      text: true,
      actorId: true,
      createdAt: true,
      supersedesId: true,
      supersededById: true,
      retiredAt: true,
      replacedBy: { select: { id: true } },
    },
  });
  if (!rule) return null;
  // A rule an erasure redacted, or one naming an erased person written at or before the
  // erasure, reads as missing, as it does on every rule read (services/memory/conventions.ts).
  const erased = await loadErasedContentFilter(orgId);
  if (erased(`${rule.subject}\n${rule.text}`, rule.createdAt, rule.subject) || erased.byRuleId(rule.id, rule.createdAt))
    return null;
  return {
    id: rule.id,
    kind: "convention",
    scopePath: rule.scopePath,
    content: `${rule.kind}: ${rule.subject}: ${rule.text}`,
    subject: rule.subject,
    actorId: rule.actorId,
    createdAt: rule.createdAt,
    status: rule.retiredAt ? "retired" : "current",
    // A rule knows its own replacement two ways: the replacement that named it, and the
    // winner of a race this version lost.
    supersededById: rule.supersededById ?? rule.replacedBy?.id ?? null,
    supersedesIds: rule.supersedesId ? [rule.supersedesId] : [],
  };
}

/** What the dependency graph records about this version being replaced. */
async function supersessionEdges(
  orgId: string,
  id: string,
): Promise<{ supersededById: string | null; supersedesIds: string[] }> {
  const edges = await db.factEdge.findMany({
    where: { orgId, kind: "supersedes", OR: [{ fromId: id }, { toId: id }] },
    select: { fromId: true, toId: true },
    // Edges written in one statement can share a millisecond; the id orders them the way
    // supersedingVersions (services/memory/superseded-facts.ts) does, so both name the
    // same replacement.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const replacement = edges.find((edge) => edge.toId === id);
  return {
    supersededById: replacement?.fromId ?? null,
    supersedesIds: edges.filter((edge) => edge.fromId === id).map((edge) => edge.toId),
  };
}
