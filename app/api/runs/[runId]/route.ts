import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAccessContext } from "@/lib/access-context";
import { canReadRun, publicRunMeta } from "@/services/agents/run-visibility";

// GET /api/runs/:runId — single run status (for polling async jobs).
//
// Access: the caller must be able to read the run's scope and its brief's scope
// (services/agents/run-visibility.ts); one who cannot gets the same 404 as an absent run.
export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { runId } = await params;

  const run = await db.agentRun.findFirst({
    where: { id: runId, orgId: rc.org.id },
    select: {
      id: true,
      status: true,
      triggeredBy: true,
      meta: true,
      briefId: true,
      startedAt: true,
      finishedAt: true,
      agent: { select: { id: true, agentKey: true, name: true, role: true } },
    },
  });

  if (!run || !(await canReadRun(rc.ctx, rc.org.id, run))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { briefId: _briefId, meta, ...rest } = run;
  return NextResponse.json({ run: { ...rest, meta: publicRunMeta(meta) } });
}
