// Derived writes: an agent that was shown content from scope A must not copy it into a
// scope B whose readers cannot all read A without saying so.
//
// An agent holding read on A and write on B can read A and write a summary of it into B,
// and every reader of B is then served A's content. Nothing in check() can see that: the
// read and the write are each allowed. So the server keeps its own record of where the
// content an agent was shown is stored (`session_scope_reads`), and a write into B is
// decided against it:
//
// - The record. Every time a version is served to an agent, whole or in part, the scope
//   it is stored in is recorded against the agent (services/memory/fact-reads.ts calls
//   {@link recordScopesOfVersions}); content served with no stored version behind it (a
//   brief, a graph summary, a contact, another agent's working note, a source link) records
//   the scope it was read from ({@link recordScopesRead}).
// - The rule. A write into B is refused while the agent's session holds a scope that is
//   neither B nor inside B, unless the write names that scope, or a scope the session read
//   that contains it, in `intentionalShareFrom`.
//   "Inside B" is the conservative reading of "every reader of B can read it": a grant on
//   B covers B's subtree and nothing above or beside it.
// - A declared share is allowed and made visible by the caller (mcp/tools/memory-ingest.ts):
//   a `memory.write.declassified` audit row and a change event in A, and a `derivedFrom`
//   edge from the stored version to A, written with the version (services/memory/pgvector-store.ts).
//   Readers of B who cannot read A see "shared from a restricted scope" and never A's
//   name ({@link derivedFromMarkers}).
//
// THE ONE RULE this file enforces: content never lands in B from outside B's subtree
// unless its writer declared it, and a declaration names only a scope the writer's
// session was shown. A declaration naming any other scope is refused with the same words
// whether that scope exists, is hidden from the writer, or was simply not read.
// Deterministic: no model takes part in the decision.
//
// Sessions. The record is keyed on (org, agent), never on the MCP connection: the hosted
// endpoint is stateless and its Mcp-Session-Id is a value the client sends back
// (mcp/connection-session.ts), so a client could open a fresh connection between the read
// and the write. Two tokens or connections of one agent share the record; two agents
// never do.
//
// The taint never expires. Until 2026-10-24 a session ended after 30 idle minutes and the
// next one started untainted, but the server cannot see when an agent's context window
// ends: an agent that read deals, paused 31 minutes and wrote the deal text into all-staff
// stored it undeclared, with no declassify row and no marker (found in review).
// A rule that lapses with time lapses toward the less safe state, so a scope an agent was
// shown counts against every later write of that agent id. An agent that must write into
// a wider scope after reading a narrower one declares the share; an untainted writer is a
// different agent id, which is an operator's visible choice, not a timer. The row's
// `lastReadAt` still says when the scope was last shown, for operators; no decision reads it.
//
// What this does not catch: two agents passing content between them outside Willder, and
// a person copying text by hand. The rule makes the in-Willder path visible; it cannot see
// the others.
import { Prisma } from "@/lib/generated/prisma/client";
import { sqlUtcNow } from "@/lib/sql-utc-now";
import { sqlIdentifier } from "@/lib/sql-identifier";
import { orgRootPath } from "./org-root";
import { isValidLtreePath, pathCovers, type AccessContext } from "./check";

/** Most scopes one write may declare. A write that needs more is a bulk copy, not a share. */
export const MAX_DECLARED_SCOPES = 20;

/** The slice of a Prisma client or transaction the record needs. */
export type ScopeReadsClient = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">;

/** Who was shown content, and where it was stored. */
export interface ScopesShown {
  orgId: string;
  agentId: string;
}

/**
 * Thrown when a write would carry content into a scope whose readers cannot all read where
 * it came from, without a declaration, or with a declaration the session cannot back.
 * Its message names the fix and nothing the writer was not already shown.
 */
export class DerivedWriteRefusedError extends Error {
  /** The operator's half of the reason, for the deny row. Names no scope but the target. */
  readonly auditReason: string;
  /** The scopes the write would have to declare, when that is why it was refused. */
  readonly toDeclare?: readonly string[];

  constructor(message: string, auditReason: string, toDeclare?: readonly string[]) {
    super(message);
    this.name = "DerivedWriteRefusedError";
    this.auditReason = auditReason;
    this.toDeclare = toDeclare;
  }
}

/**
 * Mark every scope the agent's record holds as shown again now, and return them all. A
 * scope is never dropped for age: the taint does not expire (see "Sessions" above).
 *
 * Only a write's decision calls this, since only it needs the whole record. Recording a read
 * does not: when the 30-minute idle rule stood, every read extended the session, which kept
 * the scopes still in it alive; with no expiry there is nothing to keep alive, and no decision
 * reads `lastReadAt`. A read upserts the rows of the scopes it showed and touches no other,
 * so its cost is the size of what it showed, not of everything the agent id was ever shown.
 * (Extending on every read rewrote and locked the whole record twice per task-start block,
 * which grows without bound once nothing expires: the task-start block's added latency on a long-lived
 * agent id doubled, 2026-10-27.)
 *
 * @returns the scopes the record holds.
 */
async function extendSession(client: ScopeReadsClient, who: ScopesShown): Promise<string[]> {
  // Rows are locked in scope order, the order the insert below writes them in, so two calls
  // of one agent at once wait for each other instead of deadlocking.
  const rows = await client.$queryRaw<{ scopePath: string }[]>`
    UPDATE "session_scope_reads" r SET "lastReadAt" = ${sqlUtcNow}
    FROM (
      SELECT "scopePath" FROM "session_scope_reads"
      WHERE "orgId" = ${who.orgId} AND "agentId" = ${who.agentId}
      ORDER BY "scopePath"
      FOR UPDATE
    ) live
    WHERE r."orgId" = ${who.orgId} AND r."agentId" = ${who.agentId} AND r."scopePath" = live."scopePath"
    RETURNING r."scopePath"
  `;
  return rows.map((row) => row.scopePath);
}

/**
 * Record that the agent was shown the stored versions `versionIds`, by the scope each is
 * stored in. A version stored without a scope is in the org's untagged partition, which
 * only org-root readers read, so it counts as the org root. Ids that are not stored
 * versions in the org are skipped.
 */
export async function recordScopesOfVersions(
  client: ScopeReadsClient,
  who: ScopesShown,
  versionIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(versionIds)];
  if (ids.length === 0) return;
  await client.$executeRaw`
    INSERT INTO "session_scope_reads" ("orgId", "agentId", "scopePath", "lastReadAt")
    SELECT DISTINCT c."orgId", ${who.agentId}, COALESCE(c."scopePath", ${orgRootPath(who.orgId)}) AS path, ${sqlUtcNow}
    FROM "memory_chunks" c
    WHERE c."orgId" = ${who.orgId} AND c."id" IN (${Prisma.join(ids)})
    ORDER BY path
    ON CONFLICT ("orgId", "agentId", "scopePath") DO UPDATE SET "lastReadAt" = EXCLUDED."lastReadAt"
  `;
}

/**
 * Record that the agent was shown content read from `scopePaths` that has no stored
 * version behind it. Each path is the scope the read was authorized on, already
 * resolved; a path that is not a valid scope is skipped.
 */
export async function recordScopesRead(
  client: ScopeReadsClient,
  who: ScopesShown,
  scopePaths: readonly string[],
): Promise<void> {
  const paths = [...new Set(scopePaths)].filter(isValidLtreePath);
  if (paths.length === 0) return;
  await client.$executeRaw`
    INSERT INTO "session_scope_reads" ("orgId", "agentId", "scopePath", "lastReadAt")
    SELECT ${who.orgId}, ${who.agentId}, path, ${sqlUtcNow} FROM unnest(${paths}::text[]) AS path
    ORDER BY path
    ON CONFLICT ("orgId", "agentId", "scopePath") DO UPDATE SET "lastReadAt" = EXCLUDED."lastReadAt"
  `;
}

/**
 * {@link recordScopesOfVersions} and {@link recordScopesRead} together, as one CTE named
 * `name` for a statement that records them alongside its own work: the task-start claim
 * (services/memory/task-start.ts), so a block's record costs no round trip of its own. It
 * inserts only while `gate` holds (the claim's own CTE returned a row), and records exactly
 * the rows the two functions would: the scope of each stored version among `versionIds`
 * (the org root for an untagged one), and each of `scopePaths` that is a valid scope. One
 * INSERT over the union, so a scope both name is upserted once, in scope order.
 *
 * @returns null when there is nothing to record.
 */
export function scopesShownCte(
  name: string,
  who: ScopesShown,
  versionIds: readonly string[],
  scopePaths: readonly string[],
  gate: Prisma.Sql,
): Prisma.Sql | null {
  const ids = [...new Set(versionIds)];
  const paths = [...new Set(scopePaths)].filter(isValidLtreePath);
  if (ids.length === 0 && paths.length === 0) return null;
  return Prisma.sql`${sqlIdentifier(name)} AS (
      INSERT INTO "session_scope_reads" ("orgId", "agentId", "scopePath", "lastReadAt")
      SELECT ${who.orgId}, ${who.agentId}, shown.path, ${sqlUtcNow}
      FROM (
        SELECT COALESCE(c."scopePath", ${orgRootPath(who.orgId)}) AS path
        FROM "memory_chunks" c
        WHERE c."orgId" = ${who.orgId} AND c."id" = ANY (${ids}::text[])
        UNION
        SELECT path FROM unnest(${paths}::text[]) AS path
      ) shown
      WHERE ${gate}
      ORDER BY shown.path
      ON CONFLICT ("orgId", "agentId", "scopePath") DO UPDATE SET "lastReadAt" = EXCLUDED."lastReadAt"
    )`;
}

/** A write into one scope, as the derived-write rule decides it. */
export interface DerivedWrite extends ScopesShown {
  /** The scope the write lands in, already resolved and validated. */
  target: string;
  /** The scopes the write says it shares from (`intentionalShareFrom`), as the caller sent them. */
  declared?: readonly string[];
}

/**
 * Decide one write into `target` against the agent's session, and extend the session.
 *
 * @returns the scopes the write shares from, as declared: each was read in this session,
 *   lies outside `target`'s subtree, and together they cover every such scope the session
 *   holds. Empty for an ordinary write.
 * @throws DerivedWriteRefusedError when the session holds such a scope the write does not
 *   declare, or the write declares a scope the session cannot back.
 */
export async function decideDerivedWrite(client: ScopeReadsClient, write: DerivedWrite): Promise<string[]> {
  const declared = [...new Set((write.declared ?? []).map((path) => path.trim()))];
  if (declared.length > MAX_DECLARED_SCOPES) {
    throw new DerivedWriteRefusedError(
      `intentionalShareFrom names ${declared.length} scopes; at most ${MAX_DECLARED_SCOPES} may be declared on one write.`,
      `derived write refused: ${declared.length} scopes declared, over the limit of ${MAX_DECLARED_SCOPES}`,
    );
  }
  const session = new Set(await extendSession(client, write));
  for (const path of declared) {
    // One answer for a scope that does not exist, one the writer may not read, and one it
    // simply did not read: the writer learns nothing it was not shown.
    if (!session.has(path)) {
      throw new DerivedWriteRefusedError(
        `intentionalShareFrom names "${path}", which this agent id has not read. Declare only the scopes whose content you were shown and are sharing into ${write.target}.`,
        "derived write refused: a declared scope was not read by this agent id",
      );
    }
    if (pathCovers(write.target, path)) {
      throw new DerivedWriteRefusedError(
        `intentionalShareFrom names "${path}", which is inside ${write.target}: everyone who reads ${write.target} already reads it. Remove it from intentionalShareFrom.`,
        "derived write refused: a declared scope is inside the target",
      );
    }
  }
  const outside = [...session].filter((path) => !pathCovers(write.target, path)).sort();
  // A declared scope covers what the session read inside it: its readers read that too.
  const undeclared = outside.filter((path) => !declared.some((scope) => pathCovers(scope, path)));
  if (undeclared.length > 0) {
    // Suggest the fewest scopes that cover the rest: an undeclared scope inside another
    // the session read is covered by declaring that one.
    const toDeclare = undeclared.filter(
      (path) => !undeclared.some((other) => other !== path && pathCovers(other, path)),
    );
    const named = toDeclare.map((path) => `"${path}"`).join(", ");
    throw new DerivedWriteRefusedError(
      `derived_write: this agent id was shown content stored in ${named}, which not every reader of ${write.target} can read. ` +
        `Writing into ${write.target} now could share that content with them, so nothing was stored. ` +
        `If the share is intended, send the write again with intentionalShareFrom: [${named}]; the share is then recorded, ` +
        `the fact is marked as shared from a restricted scope, and the readers of ${toDeclare.length === 1 ? "that scope" : "those scopes"} are notified. ` +
        `If this content does not come from there, write it from an agent that has not read ${toDeclare.length === 1 ? "it" : "them"}.`,
      `derived write refused: the agent id read ${undeclared.length} scope(s) outside the target's subtree without declaring them`,
      toDeclare,
    );
  }
  return declared;
}

/** One `derivedFrom` edge as a reader is shown it. */
interface DerivedFromEdge {
  fromId: string;
  /** The path of the scope the edge points at; its raw `toId` when no scope row matches. */
  path: string;
}

/**
 * The marker each of `versionIds` carries for the reader `ctx`, keyed by version id:
 * "shared from <scope>" for a source scope the reader may read, "shared from a restricted
 * scope" for one it may not. An edge names its scope by the scope row's id, or by the
 * path when the scope had no row; a scope whose row is gone reads as restricted, so a
 * reader cannot tell a hidden scope from a deleted one. Versions with no `derivedFrom`
 * edge are absent from the map.
 *
 * `canRead` decides readability without writing an audit row (check.ts `can`); it is
 * passed in so this module never builds the database client at import time.
 */
export async function derivedFromMarkers(
  client: Pick<Prisma.TransactionClient, "$queryRaw">,
  ctx: AccessContext,
  versionIds: readonly string[],
  canRead: (scopePath: string) => Promise<boolean>,
): Promise<Map<string, string>> {
  const ids = [...new Set(versionIds)];
  if (ids.length === 0) return new Map();
  const edges = await client.$queryRaw<DerivedFromEdge[]>`
    SELECT e."fromId", COALESCE(s."path", e."toId") AS "path"
    FROM "fact_edges" e
    LEFT JOIN "scopes" s ON s."id" = e."toId" AND s."orgId" = e."orgId"
    WHERE e."orgId" = ${ctx.orgId} AND e."kind" = 'derivedFrom' AND e."fromId" IN (${Prisma.join(ids)})
    ORDER BY e."fromId", 2
  `;
  const readable = new Map<string, boolean>();
  const sources = new Map<string, string[]>();
  for (const edge of edges) {
    if (!readable.has(edge.path)) readable.set(edge.path, isValidLtreePath(edge.path) && (await canRead(edge.path)));
    const label = readable.get(edge.path) ? edge.path : "a restricted scope";
    const labels = sources.get(edge.fromId) ?? [];
    if (!labels.includes(label)) labels.push(label);
    sources.set(edge.fromId, labels);
  }
  return new Map([...sources].map(([id, labels]) => [id, `shared from ${labels.join(", ")}`]));
}

/**
 * What a `derivedFrom` edge names for each declared scope, in order: the id of the
 * scope's row, or the path itself when the org has no row for it. An id keeps the
 * scope's name off the edge row; {@link derivedFromMarkers} resolves either back.
 */
export async function derivedFromTargets(
  client: Pick<Prisma.TransactionClient, "$queryRaw">,
  orgId: string,
  scopePaths: readonly string[],
): Promise<string[]> {
  if (scopePaths.length === 0) return [];
  const rows = await client.$queryRaw<{ id: string; path: string }[]>`
    SELECT "id", "path" FROM "scopes" WHERE "orgId" = ${orgId} AND "path" IN (${Prisma.join([...scopePaths])})
  `;
  const ids = new Map(rows.map((row) => [row.path, row.id]));
  return scopePaths.map((path) => ids.get(path) ?? path);
}
