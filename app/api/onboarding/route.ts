import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { bodyTypeRefusal } from "@/lib/json-type-name";
import { db } from "@/lib/db";
import { ingestMemory } from "@/lib/inngest";
import { sanitize, LIMITS } from "@/lib/sanitize";
import { check } from "@/services/access";

// POST /api/onboarding — complete first-time org onboarding.
// Ingests the 4 answers to memory and marks onboardingDone.
// Body: { companyDescription, icp, valueProp, tone, domain? }
//
// The answers are written to org-root memory and the org's preferences, so this is gated
// on memory.write at the org root like any other write there; a member who may only read
// is refused before anything is written.
export async function POST(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: {
    companyDescription?: string;
    icp?: string;
    valueProp?: string;
    tone?: string;
    domain?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }
  // Refused before check(), so a body sent with the wrong types leaves no audit row.
  const wrongType = bodyTypeRefusal(body, ["companyDescription", "icp", "valueProp", "tone", "domain"]);
  if (wrongType) return NextResponse.json({ error: wrongType }, { status: 400 });

  const decision = await check(rc.ctx, { action: "memory.write", target: "onboarding" });
  if (!decision.allowed) return NextResponse.json({ error: decision.reason }, { status: 403 });

  const companyDescription = sanitize(body.companyDescription, LIMITS.onboardingField);
  const icp = sanitize(body.icp, LIMITS.onboardingField);
  const valueProp = sanitize(body.valueProp, LIMITS.onboardingField);
  const tone = sanitize(body.tone, LIMITS.campaignField);
  const domain = sanitize(body.domain, LIMITS.contactField);

  // Build memory episodes from the answers.
  const episodes: string[] = [];
  if (companyDescription) episodes.push(`About our team/company: ${companyDescription}`);
  if (icp) episodes.push(`What we're building: ${icp}`);
  if (valueProp) episodes.push(`Key decisions and context for our memory: ${valueProp}`);

  // Ingest each answer as a separate episode for cleaner entity extraction.
  for (const content of episodes) {
    void ingestMemory({
      groupId: rc.org.id,
      content,
      source: "onboarding",
      name: rc.org.name,
      actorType: "human",
      origin: rc.ctx.origin,
      actorId: rc.user.id,
      actorName: rc.user.name ?? rc.user.email,
      authorizedById: decision.auditLogId,
    }).catch(() => {});
  }

  // Save tone override to preferences if provided.
  const prefUpdate: Record<string, unknown> = { onboardingDone: true };
  if (tone) prefUpdate.toneOverride = tone;

  await db.orgPreference.upsert({
    where: { orgId: rc.org.id },
    create: { orgId: rc.org.id, ...prefUpdate },
    update: prefUpdate,
  });

  // Trigger company enrichment if a domain was provided.
  if (domain?.trim()) {
    const account = await db.account.findFirst({
      where: { orgId: rc.org.id, domain: domain.trim() },
    });
    if (account) {
      // Fire enrichment in the background — non-blocking.
      fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/accounts/${account.id}/enrich`, {
        method: "POST",
        headers: { cookie: req.headers.get("cookie") ?? "" },
      }).catch(() => {});
    } else {
      // Create the account and enrich it.
      const newAccount = await db.account.create({
        data: { orgId: rc.org.id, name: rc.org.name, domain: domain.trim() },
      });
      fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/accounts/${newAccount.id}/enrich`, {
        method: "POST",
        headers: { cookie: req.headers.get("cookie") ?? "" },
      }).catch(() => {});
    }
  }

  return NextResponse.json({ ok: true });
}

// GET /api/onboarding — check if onboarding is done for the current org.
export async function GET() {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const pref = await db.orgPreference.findUnique({ where: { orgId: rc.org.id } });
  const done = (pref as Record<string, unknown> | null)?.onboardingDone ?? false;
  return NextResponse.json({ done });
}
