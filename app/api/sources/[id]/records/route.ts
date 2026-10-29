import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAccessContext } from "@/lib/access-context";
import { isRateLimited, per } from "@/lib/rate-limit";
import { authorizeRecord, check } from "@/services/access";
import { MemoryServiceError } from "@/services/memory/graphiti-store";
import { type SourceRecordCounts, countSourceRecords, holdsRecords } from "@/services/memory/source-records";

// GET /api/sources/:id/records: how many records a connected or disconnected source
// still has in every store, scope by scope, so a person can check that a disconnect
// removed everything it brought in (services/memory/source-records.ts says what is
// counted). Counts only, never a record's text.
//
// The rule this route enforces: the caller must be able to read every scope the
// answer names. The source's own scope is decided as the source is loaded, so a
// caller who cannot read it gets the same 404 as for an id that was never issued.
// Records left under any other scope (a reconnect moved the source, and retirement
// missed what it left behind) are decided one scope at a time, each decision on the
// audit trail like the first; one the caller cannot read refuses the whole answer
// without naming the scope.
//
// A read scans the org's graph, so each org gets READS_PER_MINUTE of them.

const READS_PER_MINUTE = 120;

function sourceNotFound(): Response {
  return NextResponse.json({ error: "source not found" }, { status: 404 });
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (isRateLimited(`sources:records:${rc.org.id}`, READS_PER_MINUTE, per.minute)) {
    return NextResponse.json({ error: "rate limit exceeded" }, { status: 429 });
  }

  const { id } = await params;
  const target = `sources:records:${id}`;
  const access = await authorizeRecord(
    rc.ctx,
    () =>
      db.source.findFirst({
        where: { id, orgId: rc.org.id },
        select: { id: true, orgId: true, scopePath: true, status: true },
      }),
    { action: "memory.read", scopeOf: (s) => s.scopePath, target },
  );
  if (access.status !== "allowed") return sourceNotFound();
  const source = access.record;

  let scopes: SourceRecordCounts[];
  try {
    scopes = await countSourceRecords(source);
  } catch (e) {
    if (!(e instanceof MemoryServiceError)) throw e;
    return NextResponse.json(
      { error: `Could not count this source's records in the memory graph. ${e.message}` },
      { status: 502 },
    );
  }

  for (const row of scopes) {
    if (row.scopePath === source.scopePath || !holdsRecords(row)) continue;
    const decision = await check(rc.ctx, { action: "memory.read", scope: row.scopePath, target });
    if (!decision.allowed) {
      return NextResponse.json(
        { error: "access denied: this source still holds records in a scope you have no grant on" },
        { status: 403 },
      );
    }
  }

  return NextResponse.json({ sourceId: source.id, status: source.status, scopes });
}
