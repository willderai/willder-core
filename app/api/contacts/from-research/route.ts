import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAccessContext } from "@/lib/access-context";
import { bodyTypeRefusal } from "@/lib/json-type-name";
import { check } from "@/services/access";
import { ingestMemory } from "@/lib/inngest";
import { unstorableText } from "@/lib/unstorable-text";
import { RESEARCH_AGENT_ID, RESEARCH_AGENT_NAME } from "@/services/access/system-actors";
import type { IngestInput } from "@/types/memory";

// POST /api/contacts/from-research — persist confirmed prospect research output.
// Body: { contact: {...}, account: {...}, findings: string[] }
// Upserts the account, creates the contact linked to it, and fires Inngest
// MEMORY_INGEST_EVENT for each finding. Returns { contactId, accountId }.
//
// Writes Contact and Account rows and ingests findings into org memory, so it is
// gated on memory.write at the org root before any of that happens.
export async function POST(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: {
    contact?: {
      name?: string;
      title?: string;
      email?: string;
      linkedin?: string;
    };
    account?: {
      name?: string;
      domain?: string;
      industry?: string;
      description?: string;
    };
    findings?: string[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }
  // Refused before check(), so a body sent with the wrong types leaves no audit row.
  const wrongType = bodyTypeRefusal(body, [
    "contact.name",
    "contact.title",
    "contact.email",
    "contact.linkedin",
    "account.name",
    "account.domain",
    "account.industry",
    "account.description",
    "findings[]",
  ]);
  if (wrongType) return NextResponse.json({ error: wrongType }, { status: 400 });

  const decision = await check(rc.ctx, { action: "memory.write", target: "contacts:from-research" });
  if (!decision.allowed) return NextResponse.json({ error: decision.reason }, { status: 403 });

  // Refused before anything is written: Postgres cannot store a NUL, so a NUL in a finding
  // made ingestMemory throw after the account and contact rows already existed.
  const findingFields = Object.fromEntries((body.findings ?? []).map((finding, i) => [`findings[${i}]`, finding]));
  const unstorable = unstorableText({
    "contact.name": body.contact?.name,
    "contact.email": body.contact?.email,
    "contact.title": body.contact?.title,
    "contact.linkedin": body.contact?.linkedin,
    "account.name": body.account?.name,
    "account.domain": body.account?.domain,
    "account.industry": body.account?.industry,
    "account.description": body.account?.description,
    ...findingFields,
  });
  if (unstorable) return NextResponse.json({ error: unstorable.message }, { status: 400 });

  const contactName = body.contact?.name?.trim();
  if (!contactName) {
    return NextResponse.json({ error: "contact.name is required" }, { status: 400 });
  }
  const accountName = body.account?.name?.trim() || null;
  const orgId = rc.org.id;

  // Upsert account only if a name was found — independent contacts (retired,
  // freelance, no current employer) have no account and that's valid.
  let accountId: string | null = null;

  if (accountName) {
    const domain = body.account?.domain?.trim() || null;
    let account: { id: string };

    const existing = domain
      ? await db.account.findFirst({ where: { orgId, domain }, select: { id: true } })
      : await db.account.findFirst({ where: { orgId, name: accountName }, select: { id: true } });

    if (existing) {
      account = await db.account.update({
        where: { id: existing.id },
        data: {
          name: accountName,
          industry: body.account?.industry?.trim() || undefined,
          description: body.account?.description?.trim() || undefined,
        },
        select: { id: true },
      });
    } else {
      account = await db.account.create({
        data: {
          orgId,
          name: accountName,
          domain,
          industry: body.account?.industry?.trim() || null,
          description: body.account?.description?.trim() || null,
        },
        select: { id: true },
      });
    }
    accountId = account.id;
  }

  // Create the contact, optionally linked to the account.
  const socialLinks: Record<string, string> = {};
  if (body.contact?.linkedin) socialLinks.linkedin = body.contact.linkedin;

  const contact = await db.contact.create({
    data: {
      orgId,
      accountId,
      name: contactName,
      email: body.contact?.email?.trim() || null,
      title: body.contact?.title?.trim() || null,
      type: "prospect",
      socialLinks,
    },
    select: { id: true },
  });

  // Fire MEMORY_INGEST_EVENT for each finding.
  const findings = (body.findings ?? []).filter((finding) => finding.length > 0);
  if (findings.length > 0) {
    await Promise.all(
      findings.map((finding) =>
        ingestMemory({
          groupId: orgId,
          content: finding,
          source: "text",
          name: contactName,
          actorType: "extraction",
          origin: rc.ctx.origin,
          actorId: RESEARCH_AGENT_ID,
          actorName: RESEARCH_AGENT_NAME,
          // The research agent wrote the findings; this person accepted them.
          authorizedById: decision.auditLogId,
        } satisfies IngestInput),
      ),
    );
  }

  return NextResponse.json({ contactId: contact.id, accountId }, { status: 201 });
}
