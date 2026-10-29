// POST /api/contacts/:id/enrich: queue an enrichment run for one contact; gated by memory.write
// on the org and rate-limited per org.
import { NextResponse } from "next/server";
import { after } from "next/server";
import { db } from "@/lib/db";
import { requireAccessContext } from "@/lib/access-context";
import { inngest, ENRICH_EVENT, runEnrichment, type EnrichmentJobInput } from "@/lib/inngest";
import { check } from "@/services/access";
import { isRateLimited, per } from "@/lib/rate-limit";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (isRateLimited(`enrich:${rc.org.id}`, 30, per.hour)) {
    return NextResponse.json({ error: "rate limit exceeded" }, { status: 429 });
  }

  const { id } = await params;
  // Decided before the lookup: the decision does not depend on the record, and a
  // caller refused here must not learn whether the id exists.
  const decision = await check(rc.ctx, { action: "memory.write", target: `enrich:contact:${id}` });
  if (!decision.allowed) return NextResponse.json({ error: decision.reason }, { status: 403 });

  const contact = await db.contact.findFirst({
    where: { id, orgId: rc.org.id },
    select: { id: true, name: true, email: true, account: { select: { domain: true } } },
  });
  if (!contact) return NextResponse.json({ error: "contact not found" }, { status: 404 });

  const data: EnrichmentJobInput = {
    orgId: rc.org.id,
    recordId: contact.id,
    target: {
      kind: "contact",
      name: contact.name,
      email: contact.email ?? undefined,
      domain: contact.account?.domain ?? undefined,
    },
    actorId: rc.user.id,
    actorName: rc.user.name ?? undefined,
    origin: rc.ctx.origin,
  };

  // In dev mode the Inngest CLI (v1.31) is incompatible with SDK v4 step execution.
  // Use next/server `after()` to run the pipeline after the response is committed —
  // this is guaranteed to complete even in serverless, unlike fire-and-forget void.
  if (process.env.INNGEST_BYPASS === "1") {
    after(async () => {
      await runEnrichment(data).catch((e) => console.error("[enrich] pipeline failed:", e));
    });
    return NextResponse.json({ jobId: "direct" }, { status: 202 });
  }

  const { ids } = await inngest.send({ name: ENRICH_EVENT, data });
  return NextResponse.json({ jobId: ids[0] }, { status: 202 });
}
