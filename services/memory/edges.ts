// The dependency graph's write side: a generic edge writer, plus a named function for each edge kind a product
// path records today. `FactEdgeKind` carries the kinds the graph can hold; a kind with
// no caller yet gets its named function when the path that writes it arrives.
//
// The one rule this file enforces: an edge is recorded at most once, and inside the
// caller's own transaction when the record it describes is being written. A retried
// write lands on the unique key and is skipped, so a count of dependents counts
// records, never attempts; and an edge can never name a replacement or a brief whose
// own insert rolled back.
//
// Edges carry no authorization of their own. The caller has already been allowed to
// write the record the edge hangs off.
//
// A `supersedes` edge between two fact versions is read without a scope check of its
// own: a reader allowed to see one end is handed the other end's id
// (services/memory/versions.ts, services/memory/superseded-facts.ts). That is safe only
// because both ends are stored in one scope, so whoever can read one can read the other.
// The conflict rule keeps them there by construction (services/memory/conflict.ts), and
// `recordReplacements` below refuses any replacement whose two versions are not.
import type { Prisma } from "@/lib/generated/prisma/client";
import type { ActorType, FactEdgeKind } from "@/lib/generated/prisma/enums";

export type { FactEdgeKind };

/** The slice of a Prisma client or transaction an edge write needs. */
export type FactEdgeWriter = Pick<Prisma.TransactionClient, "factEdge">;

/** Who recorded an edge: a user id or an agent id, never a capability token. */
export interface EdgeActor {
  type: ActorType;
  id: string;
}

export interface EdgeInput {
  orgId: string;
  /** The newer or dependent record: the brief, the replacement, the effect. */
  fromId: string;
  /** The record it rests on: the source, the replaced version, the cause. */
  toId: string;
  kind: FactEdgeKind;
  /** ltree scope of the `from` record; readers filter on it. */
  scopePath: string;
  actor: EdgeActor;
}

/**
 * Record one edge. Already-recorded edges (same org, ends and kind) are left as they
 * are, so a retry is safe.
 *
 * @returns whether a row was written.
 */
export async function recordEdge(writer: FactEdgeWriter, input: EdgeInput): Promise<boolean> {
  const written = await recordEdges(writer, [input]);
  return written === 1;
}

/**
 * Record several edges in one statement, skipping any already recorded.
 *
 * @returns how many rows were written.
 */
export async function recordEdges(writer: FactEdgeWriter, inputs: EdgeInput[]): Promise<number> {
  if (inputs.length === 0) return 0;
  const { count } = await writer.factEdge.createMany({
    data: inputs.map((input) => ({
      orgId: input.orgId,
      fromId: input.fromId,
      toId: input.toId,
      kind: input.kind,
      scopePath: input.scopePath,
      actorType: input.actor.type,
      actorId: input.actor.id,
    })),
    skipDuplicates: true,
  });
  return count;
}

export interface SupersedesInput {
  orgId: string;
  /** The version that is current now. */
  replacementId: string;
  /** The version it replaced. */
  replacedId: string;
  /** Scope of the replacement. */
  scopePath: string;
  actor: EdgeActor;
}

/**
 * Record that one version of a fact replaced another: a `supersedes` edge from the
 * replacement to the replaced version. Called where a fact is replaced, in the same
 * transaction as the replacement's own write.
 */
export function recordSupersedes(writer: FactEdgeWriter, input: SupersedesInput): Promise<boolean> {
  return recordEdge(writer, {
    orgId: input.orgId,
    fromId: input.replacementId,
    toId: input.replacedId,
    kind: "supersedes",
    scopePath: input.scopePath,
    actor: input.actor,
  });
}

/** One version of an item that a newer version of the same item took the place of. */
export interface Replacement {
  orgId: string;
  /** The version that took its place. */
  replacementId: string;
  /** The scope the replacement is stored and read in. */
  replacementScopePath: string;
  /** The version it took the place of, which the caller has already retired. */
  replacedId: string;
  /** The scope the replaced version was stored and read in. */
  replacedScopePath: string;
  actor: EdgeActor;
}

/**
 * Record the lineage of versions a newer version of the same item retired: a connector
 * item edited upstream, a fact a person corrected. Called in the transaction that
 * records the replacement's own write, under the per-org change-feed lock that write
 * took, so lineage never names a version whose write rolled back.
 *
 * A replacement is recorded only when both versions are stored in the same scope. A
 * replacement written to another scope (a source reconnected elsewhere, a correction
 * made at a broader scope than the fact was stored in) records nothing: the readers of
 * one version may not be allowed to read the other, so the lineage answers, as it does
 * for a version nothing replaced, that there is none.
 *
 * Nor is a version recorded as replacing itself, and both ends must be versions nothing
 * has replaced yet. A replacement that is itself replaced is not current: a correction can
 * land on an identical earlier correction that a later update has since replaced. A
 * replaced version that already has a replacement keeps that one: a version is replaced
 * once, as the conflict rule (services/memory/conflict.ts) and a rule's unique
 * `supersedesId` keep it, so "what replaced it" has one answer and the lineage never
 * forks. Every edge then runs between two current versions, so the `supersedes` graph
 * also holds no cycle, the rule services/memory/fact-update.ts keeps for updates.
 *
 * @returns how many edges were written; an edge already recorded is not counted again.
 */
export async function recordReplacements(
  writer: FactEdgeWriter,
  replacements: readonly Replacement[],
): Promise<number> {
  const sameScope = replacements.filter(
    (r) => r.replacementScopePath === r.replacedScopePath && r.replacementId !== r.replacedId,
  );
  if (sameScope.length === 0) return 0;
  const key = (orgId: string, id: string) => `${orgId}\u0000${id}`;
  const replaced = await writer.factEdge.findMany({
    where: {
      kind: "supersedes",
      OR: sameScope.flatMap((r) => [
        { orgId: r.orgId, toId: r.replacementId },
        { orgId: r.orgId, toId: r.replacedId },
      ]),
    },
    select: { orgId: true, toId: true },
  });
  const notCurrent = new Set(replaced.map((edge) => key(edge.orgId, edge.toId)));
  const recordable = sameScope.filter(
    (r) => !notCurrent.has(key(r.orgId, r.replacementId)) && !notCurrent.has(key(r.orgId, r.replacedId)),
  );
  return recordEdges(
    writer,
    recordable.map((r) => ({
      orgId: r.orgId,
      fromId: r.replacementId,
      toId: r.replacedId,
      kind: "supersedes",
      scopePath: r.replacementScopePath,
      actor: r.actor,
    })),
  );
}
