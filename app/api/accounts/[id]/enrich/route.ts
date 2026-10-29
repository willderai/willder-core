// POST /api/accounts/:id/enrich: queue an enrichment run for one account; gated by memory.write
// on the org and rate-limited per org, and the account must already have a domain.
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
  const decision = await check(rc.ctx, { action: "memory.write", target: `enrich:account:${id}` });
  if (!decision.allowed) return NextResponse.json({ error: decision.reason }, { status: 403 });

  const account = await db.account.findFirst({
    where: { id, orgId: rc.org.id },
    select: { id: true, name: true, domain: true },
  });
  if (!account) return NextResponse.json({ error: "account not found" }, { status: 404 });
  if (!account.domain) {
    return NextResponse.json({ error: "account needs a domain to enrich (set one first)" }, { status: 400 });
  }

  const data: EnrichmentJobInput = {
    orgId: rc.org.id,
    recordId: account.id,
    target: { kind: "account", name: account.name, domain: account.domain },
    actorId: rc.user.id,
    actorName: rc.user.name ?? undefined,
    origin: rc.ctx.origin,
  };

  if (process.env.INNGEST_BYPASS === "1") {
    after(async () => {
      await runEnrichment(data).catch((e) => console.error("[enrich] account pipeline failed:", e));
    });
    return NextResponse.json({ jobId: "direct" }, { status: 202 });
  }

  const { ids } = await inngest.send({ name: ENRICH_EVENT, data });
  return NextResponse.json({ jobId: ids[0] }, { status: 202 });
}
