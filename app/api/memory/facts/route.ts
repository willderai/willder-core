// POST /api/memory/facts: ingest one human-asserted fact; check() gates memory.write on the scope first.
import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { ingestMemory } from "@/lib/inngest";
import { AccessDeniedError, check, orgRootPath, resolveCallerScopePath } from "@/services/access";
import { bodyTypeRefusal } from "@/lib/json-type-name";
import { unstorableText } from "@/lib/unstorable-text";
import type { IngestInput } from "@/types/memory";

// POST /api/memory/facts — directly inject a human-asserted fact into memory.
// Gated on memory.write (same as /ingest). The fact text is ingested as an episode;
// Graphiti extracts it into the graph. Async via Inngest — returns jobId immediately.
// Used by the Ask chatbot's "Add fact" and "Edit fact" (delete old + this route).
export async function POST(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }
  // Valid JSON need not be an object, and a fact need not be a string: each is refused
  // by name here rather than throwing on `.fact` or `.trim()` as a 500 that names
  // nothing. A null or missing fact is no fact, refused as missing below.
  const wrongType = bodyTypeRefusal(parsed, ["fact"]);
  if (wrongType) return NextResponse.json({ error: wrongType }, { status: 400 });
  const body = parsed as { fact?: string | null; scope?: unknown };
  // Refused before check() writes its allow row: Postgres cannot store a NUL, and
  // ingestMemory's refusal of one would otherwise surface as a 500 that names nothing.
  // A NUL in the scope is the resolver's to refuse below, with the deny row every
  // other scope refusal leaves.
  const unstorable = unstorableText({ fact: body.fact });
  if (unstorable) return NextResponse.json({ error: unstorable.message }, { status: 400 });
  const fact = body.fact?.trim();
  if (!fact) return NextResponse.json({ error: "fact is required" }, { status: 400 });
  // A malformed scope is refused by name, with one deny row, rather than reaching
  // check()'s `::ltree` cast raw or being stored at a path no read accepts. An absent
  // scope writes at the org root.
  let scope: string;
  try {
    scope = await resolveCallerScopePath(
      rc.ctx,
      body.scope,
      { scopePath: orgRootPath(rc.org.id) },
      { onInvalid: "refuse", action: "memory.write", field: "scope" },
    );
  } catch (e) {
    if (e instanceof AccessDeniedError) return NextResponse.json({ error: e.decision.reason }, { status: 403 });
    throw e;
  }

  const decision = await check(rc.ctx, { action: "memory.write", scope, target: "fact" });
  if (!decision.allowed) {
    return NextResponse.json({ error: decision.reason }, { status: 403 });
  }

  const data: IngestInput = {
    groupId: rc.org.id,
    content: fact,
    source: "text",
    name: `Human fact — ${new Date().toISOString()}`,
    actorType: "human",
    origin: rc.ctx.origin,
    actorId: rc.user.id,
    actorName: rc.user.name ?? undefined,
    scopePath: scope,
    authorizedById: decision.auditLogId,
  };

  await ingestMemory(data);
  return NextResponse.json({ jobId: "queued" }, { status: 202 });
}
