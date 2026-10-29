import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAccessContext } from "@/lib/access-context";
import { bodyTypeRefusal } from "@/lib/json-type-name";
import { check } from "@/services/access";
import type { AccountStatus } from "@/lib/generated/prisma/enums";
import { ingestMemory } from "@/lib/inngest";

// /api/accounts/:id — read/update a single account. Tenant-scoped: an id from
// another org reads as 404. GET → the account, PATCH → partial update, DELETE → remove.
// PATCH and DELETE need `memory.write` at the org root (an edit is re-ingested into the
// org-root memory graph), decided before the account is looked up, so a refused caller
// gets one answer whether or not the id exists.
const STATUSES: AccountStatus[] = ["active", "inactive", "archived"];

const SELECT = {
  id: true,
  orgId: true,
  name: true,
  domain: true,
  status: true,
  entityId: true,
  enrichStatus: true,
  description: true,
  socialLinks: true,
  industry: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const account = await db.account.findFirst({ where: { id, orgId: rc.org.id }, select: SELECT });
  if (!account) return NextResponse.json({ error: "account not found" }, { status: 404 });
  return NextResponse.json({ account });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  let body: {
    name?: string | null;
    domain?: string | null;
    status?: string;
    description?: string | null;
    industry?: string | null;
    socialLinks?: Record<string, string>;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }
  // Refused before check(), so a body sent with the wrong types leaves no audit row.
  const wrongType = bodyTypeRefusal(body, ["name", "domain", "status", "description", "industry", "socialLinks{}"]);
  if (wrongType) return NextResponse.json({ error: wrongType }, { status: 400 });
  // An account always has a name, so null cannot clear it the way it clears domain.
  if (body.name === null) return NextResponse.json({ error: "name must be a string, not null" }, { status: 400 });

  const decision = await check(rc.ctx, { action: "memory.write", target: `account:${id}:update` });
  if (!decision.allowed) return NextResponse.json({ error: decision.reason }, { status: 403 });

  if (body.status && !STATUSES.includes(body.status as AccountStatus)) {
    return NextResponse.json({ error: `status must be ${STATUSES.join("|")}` }, { status: 400 });
  }

  const { count } = await db.account.updateMany({
    where: { id, orgId: rc.org.id },
    data: {
      ...(body.name !== undefined ? { name: body.name.trim() } : {}),
      ...(body.domain !== undefined ? { domain: body.domain?.trim() || null } : {}),
      ...(body.status !== undefined ? { status: body.status as AccountStatus } : {}),
      ...(body.description !== undefined ? { description: body.description?.trim() || null } : {}),
      ...(body.industry !== undefined ? { industry: body.industry?.trim() || null } : {}),
      ...(body.socialLinks !== undefined ? { socialLinks: body.socialLinks } : {}),
    },
  });
  if (count === 0) return NextResponse.json({ error: "account not found" }, { status: 404 });

  const account = await db.account.findFirst({ where: { id, orgId: rc.org.id }, select: SELECT });

  // Sync updated state to memory graph (fire-and-forget).
  if (account) {
    const parts = [
      `${account.name} is a company`,
      account.domain ? `with domain ${account.domain}` : null,
      account.industry ? `in the ${account.industry} industry` : null,
      account.description ?? null,
    ].filter(Boolean);
    void ingestMemory({
      groupId: rc.org.id,
      content: parts.join(" ") + ".",
      source: "crm-update",
      name: account.name,
      actorType: "extraction",
      origin: rc.ctx.origin,
      actorId: rc.user.id,
      actorName: rc.user.name ?? rc.user.email,
      // The system composed the summary from this person's edit; the person accepted it.
      authorizedById: decision.auditLogId,
    }).catch(() => {});
  }

  return NextResponse.json({ account });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const decision = await check(rc.ctx, { action: "memory.write", target: `account:${id}:delete` });
  if (!decision.allowed) return NextResponse.json({ error: decision.reason }, { status: 403 });
  const { count } = await db.account.deleteMany({ where: { id, orgId: rc.org.id } });
  if (count === 0) return NextResponse.json({ error: "account not found" }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
