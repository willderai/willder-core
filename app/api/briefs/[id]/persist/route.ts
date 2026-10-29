// UC9a — persist an accepted brief into governed memory.
// A human accepts an agent-generated brief; its summary and each section are written
// back to memory as AGENT-authored episodes (the brief is the agent's output), scoped
// to the brief's scopePath. Agent-tier facts are the lowest write provenance, so any
// human correction later outranks them, and downstream contradiction detection dedups
// against what's already there — which is why re-persisting the same brief is safe.
// FUTURE: a `persistedAt` guard column on Brief would let us hard-block re-persist; MVV,
// no schema change now.
import { db } from "@/lib/db";
import { requireAccessContext } from "@/lib/access-context";
import { briefWriteDenied } from "@/lib/brief-access";
import { ingestMemory } from "@/lib/inngest";
import type { IngestInput } from "@/types/memory";
import { authorizeBrief } from "@/services/memory/briefs";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;

  // Persisting a brief is a memory write; gate once on memory.write over the brief's scope.
  const access = await authorizeBrief(rc.ctx, id, { action: "memory.write", target: `brief:${id}` });
  if (access.status !== "allowed") return briefWriteDenied(rc.ctx, access);
  const { brief } = access;
  const scopePath = brief.scopePath;

  // Attribute the persisted facts to the agent that originated the brief when we can find
  // its run; otherwise fall back to the brief id so provenance is still traceable.
  const originatingRun = await db.agentRun.findFirst({
    where: { briefId: brief.id },
    select: { agentId: true },
  });
  const actorId = originatingRun?.agentId ?? brief.id;

  // Collect the brief's content: summary first, then each section as "heading\n\ncontent".
  const pieces: string[] = [];
  const summary = brief.summary?.trim();
  if (summary) pieces.push(summary);

  const sections = Array.isArray(brief.sections)
    ? (brief.sections as unknown as Array<{ heading?: unknown; content?: unknown }>)
    : [];
  for (const section of sections) {
    if (!section || typeof section !== "object") continue;
    const heading = typeof section.heading === "string" ? section.heading.trim() : "";
    const content = typeof section.content === "string" ? section.content.trim() : "";
    if (!content && !heading) continue;
    pieces.push(heading ? `${heading}\n\n${content}` : content);
  }

  let persisted = 0;
  for (const content of pieces) {
    if (!content.trim()) continue;
    const ingest: IngestInput = {
      groupId: rc.org.id,
      content,
      source: "text",
      name: `Brief: ${brief.title}`,
      actorType: "agent",
      origin: rc.ctx.origin,
      actorId,
      actorName: "Agent",
      scopePath,
      // The person's decision to persist, not the agent's: the agent wrote the brief and
      // the person accepted it, which the audit trail reads as `authorizationKind:
      // "accepted"` (services/audit/actor-names.ts).
      authorizedById: access.decision.auditLogId,
      // Matches the `brief:${id}` tag the check() call above just gated this
      // write with, so its confirmed-applied audit row keeps the exact target
      // string GET /api/briefs/:id/staleness excludes as a self-write (item
      // handoff-staleness-flag-ordering-20260919).
      auditTag: `brief:${id}`,
    };
    await ingestMemory(ingest);
    persisted += 1;
  }

  return Response.json({ persisted }, { status: 200 });
}
