import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAccessContext } from "@/lib/access-context";
import { bodyTypeRefusal } from "@/lib/json-type-name";
import { check } from "@/services/access";
import { memory } from "@/services/memory";
import type { AccountStatus } from "@/lib/generated/prisma/enums";
import { pickPage, readPickQuery } from "@/lib/pick-query";
import { escapeLikePrefix } from "@/services/access/scope-containment";

// /api/accounts — companies/accounts (the structured CRM half; memory lives in
// Neo4j, linked by `entityId`). Tenant-scoped to the caller's org. GET → list, POST →
// create. Creating writes the account into the org-root memory graph, so it needs
// `memory.write` at the org root, as creating a contact does.
//
// GET with `?limit=N&q=text` answers a picker instead (lib/pick-query.ts): the first N
// accounts whose name or domain holds the text, by name, and whether more match.
const STATUSES: AccountStatus[] = ["active", "inactive", "archived"];

const SELECT = {
  id: true,
  orgId: true,
  name: true,
  domain: true,
  status: true,
  entityId: true,
  description: true,
  socialLinks: true,
  industry: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function GET(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const pick = readPickQuery(new URL(req.url).searchParams);
  if (pick && "error" in pick) return NextResponse.json({ error: pick.error }, { status: 400 });
  if (pick) {
    const text = { contains: escapeLikePrefix(pick.search), mode: "insensitive" as const };
    const rows = await db.account.findMany({
      where: { orgId: rc.org.id, ...(pick.search ? { OR: [{ name: text }, { domain: text }] } : {}) },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: pick.limit + 1,
      select: { id: true, name: true, domain: true },
    });
    const page = pickPage(rows, pick.limit);
    return NextResponse.json({ accounts: page.rows, more: page.more });
  }

  const accounts = await db.account.findMany({
    where: { orgId: rc.org.id },
    orderBy: { createdAt: "desc" },
    select: SELECT,
  });
  return NextResponse.json({ accounts });
}

export async function POST(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: {
    name?: string;
    domain?: string;
    status?: string;
    description?: string;
    industry?: string;
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

  const decision = await check(rc.ctx, { action: "memory.write", target: "accounts:create" });
  if (!decision.allowed) return NextResponse.json({ error: decision.reason }, { status: 403 });

  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (body.status && !STATUSES.includes(body.status as AccountStatus)) {
    return NextResponse.json({ error: `status must be ${STATUSES.join("|")}` }, { status: 400 });
  }

  const account = await db.account.create({
    data: {
      orgId: rc.org.id,
      name,
      domain: body.domain?.trim() || null,
      status: (body.status as AccountStatus) ?? undefined,
      description: body.description?.trim() || null,
      industry: body.industry?.trim() || null,
      socialLinks: body.socialLinks ?? {},
    },
    select: SELECT,
  });

  // Seed a memory entity for this account so it appears in the graph immediately.
  const domainPart = account.domain ? ` with domain ${account.domain}` : "";
  const industryPart = account.industry ? ` in the ${account.industry} industry` : "";
  void memory
    .ingest({
      groupId: rc.org.id,
      content: `${name} is a company${domainPart}${industryPart}.`,
      source: "text",
      name,
      actorType: "extraction",
      origin: rc.ctx.origin,
      actorId: rc.org.id,
      actorName: "system",
    })
    .catch(() => {});

  return NextResponse.json({ account }, { status: 201 });
}
