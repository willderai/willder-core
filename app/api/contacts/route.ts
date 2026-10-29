import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAccessContext } from "@/lib/access-context";
import { bodyTypeRefusal } from "@/lib/json-type-name";
import { check } from "@/services/access";
import { memory } from "@/services/memory";
import type { ContactStatus } from "@/lib/generated/prisma/enums";
import { CONTACT_TYPES, type ContactType } from "@/lib/contact-types";
import { pickPage, readPickQuery } from "@/lib/pick-query";
import { escapeLikePrefix } from "@/services/access/scope-containment";

// /api/contacts — people/prospects (structured CRM half; memory lives in Neo4j,
// linked by `entityId`). The list joins the parent account (the common
// Contacts-list shape). GET → list, POST → create.
//
// Both handlers go through check() before touching a Contact row. Tenant scoping
// alone is not authorization: it keeps one org out of another's data but lets any
// member of an org read or create every contact in it. The list returns email and
// title for the whole org, so it asks at the org root — the strictest question
// check() can be asked, since grants match ancestor-or-self and a grant on a child
// scope is not an ancestor of the root.
//
// GET with `?limit=N&q=text` answers a picker instead (lib/pick-query.ts): the first N
// contacts whose name, email or title holds the text, by name, and whether more match.
const STATUSES: ContactStatus[] = ["active", "unsubscribed", "bounced", "archived"];

const SELECT = {
  id: true,
  orgId: true,
  accountId: true,
  name: true,
  email: true,
  title: true,
  type: true,
  description: true,
  socialLinks: true,
  status: true,
  entityId: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function GET(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Refused before check(), so a malformed picker request leaves no audit row.
  const pick = readPickQuery(new URL(req.url).searchParams);
  if (pick && "error" in pick) return NextResponse.json({ error: pick.error }, { status: 400 });

  const decision = await check(rc.ctx, { action: "memory.read", target: "contacts:list" });
  if (!decision.allowed) return NextResponse.json({ error: decision.reason }, { status: 403 });

  if (pick) {
    const text = { contains: escapeLikePrefix(pick.search), mode: "insensitive" as const };
    const rows = await db.contact.findMany({
      where: { orgId: rc.org.id, ...(pick.search ? { OR: [{ name: text }, { email: text }, { title: text }] } : {}) },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: pick.limit + 1,
      select: { id: true, name: true, email: true, title: true },
    });
    const page = pickPage(rows, pick.limit);
    return NextResponse.json({ contacts: page.rows, more: page.more });
  }

  const contacts = await db.contact.findMany({
    where: { orgId: rc.org.id },
    orderBy: { createdAt: "desc" },
    select: { ...SELECT, account: { select: { id: true, name: true, domain: true, industry: true } } },
  });
  return NextResponse.json({ contacts });
}

export async function POST(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: {
    name?: string;
    email?: string;
    title?: string;
    type?: string;
    description?: string;
    socialLinks?: Record<string, string>;
    accountId?: string;
    status?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }
  // Refused before check(), so a body sent with the wrong types leaves no audit row.
  const wrongType = bodyTypeRefusal(body, [
    "name",
    "email",
    "title",
    "type",
    "description",
    "accountId",
    "status",
    "socialLinks{}",
  ]);
  if (wrongType) return NextResponse.json({ error: wrongType }, { status: 400 });

  const decision = await check(rc.ctx, { action: "memory.write", target: "contacts:create" });
  if (!decision.allowed) return NextResponse.json({ error: decision.reason }, { status: 403 });

  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (body.status && !STATUSES.includes(body.status as ContactStatus)) {
    return NextResponse.json({ error: `status must be ${STATUSES.join("|")}` }, { status: 400 });
  }
  if (body.type && !CONTACT_TYPES.includes(body.type as ContactType)) {
    return NextResponse.json({ error: `type must be ${CONTACT_TYPES.join("|")}` }, { status: 400 });
  }

  // If an account is given, it must belong to this org (no cross-tenant linking).
  let accountName: string | null = null;
  if (body.accountId) {
    const account = await db.account.findFirst({
      where: { id: body.accountId, orgId: rc.org.id },
      select: { id: true, name: true },
    });
    if (!account) return NextResponse.json({ error: "account not found" }, { status: 400 });
    accountName = account.name;
  }

  const contact = await db.contact.create({
    data: {
      orgId: rc.org.id,
      name,
      email: body.email?.trim() || null,
      title: body.title?.trim() || null,
      type: (body.type as ContactType) ?? "prospect",
      description: body.description?.trim() || null,
      socialLinks: body.socialLinks ?? {},
      accountId: body.accountId || null,
      status: (body.status as ContactStatus) ?? undefined,
    },
    select: SELECT,
  });

  // Seed a memory entity for this contact so they appear in the graph immediately.
  const titlePart = contact.title ? `, ${contact.title}` : "";
  const accountPart = accountName ? ` at ${accountName}` : "";
  const descPart = contact.description ? ` ${contact.description}` : "";
  void memory
    .ingest({
      groupId: rc.org.id,
      content: `${name} is a ${contact.type ?? "contact"}${titlePart}${accountPart}.${descPart}`,
      source: "text",
      name,
      actorType: "extraction",
      origin: rc.ctx.origin,
      actorId: rc.org.id,
      actorName: "system",
    })
    .catch(() => {});

  return NextResponse.json({ contact }, { status: 201 });
}
