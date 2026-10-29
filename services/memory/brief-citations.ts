// The facts a brief quoted, and whether each one is still what the brief says.
//
// A brief is a point-in-time copy of what an agent retrieved at the brief's scope.
// Showing a reader which fact backs which section is only half the job: a citation to
// a fact that has since been replaced reads as confirmation of something no longer true,
// which is worse than no citation at all. So every citation is stored with the text the
// agent saw, and re-checked on read against what the store holds now.
//
// The one rule this file enforces: a citation is re-checked at the brief's own scope,
// under one audited `memory.read` decision, and a fact that is no longer readable there
// is reported `gone` without its text, exactly like a fact that no longer exists.
import { db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";
import { guardedMemory } from "./guarded-store";

/** Most citations stored for one brief; each is one store lookup when the brief is checked. */
export const MAX_CITATIONS_PER_BRIEF = 25;

/** One fact a section of a brief rests on, as the agent retrieved it. */
export interface BriefCitationInput {
  /** Index into the brief's sections. */
  sectionIndex: number;
  /** The fact's uuid as the store returned it. */
  factId: string;
  /** The fact's text when the brief was generated. */
  factText: string;
}

/**
 * What a cited fact is now, compared with what the brief quoted.
 *
 * - `current`: the same fact, same text, still in force.
 * - `changed`: the same fact id now holds different text.
 * - `superseded`: a newer version replaced it.
 * - `gone`: deleted, retired, or no longer readable at the brief's scope.
 * - `unknown`: the store could not answer, or cannot say whether the fact was replaced.
 */
export type CitationStatus = "current" | "changed" | "superseded" | "gone" | "unknown";

/** One citation as a reader of the brief sees it. */
export interface CitationCheck {
  sectionIndex: number;
  factId: string;
  /** The text the brief quoted; null when the fact is `gone`, so a removed fact is not served from the copy. */
  factText: string | null;
  status: CitationStatus;
}

/**
 * The citations worth storing: one per (section, fact), sections that exist, at most
 * MAX_CITATIONS_PER_BRIEF, in the order given.
 */
export function boundCitations(citations: BriefCitationInput[], sectionCount: number): BriefCitationInput[] {
  const seen = new Set<string>();
  const kept: BriefCitationInput[] = [];
  for (const citation of citations) {
    if (kept.length === MAX_CITATIONS_PER_BRIEF) break;
    if (!Number.isInteger(citation.sectionIndex) || citation.sectionIndex < 0 || citation.sectionIndex >= sectionCount)
      continue;
    const key = `${citation.sectionIndex}\u0000${citation.factId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(citation);
  }
  return kept;
}

/** Store a brief's citations inside the transaction that creates the brief. */
export async function recordBriefCitations(
  tx: Prisma.TransactionClient,
  briefId: string,
  citations: BriefCitationInput[],
): Promise<void> {
  if (citations.length === 0) return;
  await tx.briefCitation.createMany({
    data: citations.map((c) => ({ briefId, sectionIndex: c.sectionIndex, factId: c.factId, factText: c.factText })),
  });
}

/**
 * Re-check every fact `brief` cited against the store, at the brief's own scope.
 *
 * @throws AccessDeniedError when the caller may not read the brief's scope.
 */
export async function checkBriefCitations(
  ctx: AccessContext,
  brief: { id: string; orgId: string; scopePath: string },
): Promise<CitationCheck[]> {
  const citations = await db.briefCitation.findMany({
    where: { briefId: brief.id },
    select: { sectionIndex: true, factId: true, factText: true },
    orderBy: [{ sectionIndex: "asc" }, { createdAt: "asc" }],
  });
  if (citations.length === 0) return [];

  const factIds = [...new Set(citations.map((c) => c.factId))];
  const [resolved, supersededIds] = await Promise.all([
    guardedMemory.resolveFacts(
      ctx,
      { groupId: brief.orgId, factIds, target: `brief:${brief.id}/citations` },
      brief.scopePath,
    ),
    supersededFactIds(brief.orgId, factIds),
  ]);

  return citations.map((citation) => {
    const status = citationStatus(citation.factText, resolved.get(citation.factId), supersededIds.has(citation.factId));
    return { ...citation, factText: status === "gone" ? null : citation.factText, status };
  });
}

/** The status of one citation, from its store answer and the dependency graph. */
function citationStatus(
  quoted: string,
  now: { fact: string; invalidAt?: string | null } | null | Error | undefined,
  replacedInGraph: boolean,
): CitationStatus {
  if (now === undefined || now instanceof Error) return "unknown";
  if (now === null) return "gone";
  if (now.invalidAt || replacedInGraph) return "superseded";
  if (now.fact !== quoted) return "changed";
  // An older memory service cannot report graph invalidation; the text matching is not enough.
  return now.invalidAt === undefined ? "unknown" : "current";
}

/** The ids among `factIds` that a `supersedes` edge in the dependency graph replaced. */
async function supersededFactIds(orgId: string, factIds: string[]): Promise<Set<string>> {
  const edges = await db.factEdge.findMany({
    where: { orgId, kind: "supersedes", toId: { in: factIds } },
    select: { toId: true },
  });
  return new Set(edges.map((edge) => edge.toId));
}
