import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAccessContext } from "@/lib/access-context";
import { check, issueCapability } from "@/services/access";
import { TOKEN_LIST_SPEC, parseAccessListQuery } from "@/lib/access-lists";
import { readTokenPage } from "@/services/access/access-list-pages";

// /api/access/capabilities — issue/list agent capability tokens. Admin-only.
// POST → mint a scoped, expiring token for an agent (services/access/issue-capability.ts
//        holds the rules). The RAW TOKEN IS RETURNED ONCE here and never again
//        (only its hash is stored).
// GET  → list tokens (metadata only; never the token), each with `agentDeactivated`:
//        whether its agent is switched off, which refuses the token however live it
//        looks (the rule services/access/check.ts applies on every call). With
//        `page`, one page searched (q), filtered (status, permission) and ordered
//        (sort, order) in the query, as the Access page's Tokens tab reads it;
//        without, every token.

export async function GET(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const decision = await check(rc.ctx, { action: "access.manage", target: "capabilities:list" });
  if (!decision.allowed) {
    return NextResponse.json({ error: decision.reason }, { status: 403 });
  }

  const paged = parseAccessListQuery(new URL(req.url).searchParams, TOKEN_LIST_SPEC);
  if (paged !== null) {
    if ("error" in paged) return NextResponse.json({ error: paged.error }, { status: 400 });
    const { rows, ...page } = await readTokenPage(rc.org.id, paged);
    return NextResponse.json({ capabilities: rows, ...page });
  }

  const capabilities = await db.capability.findMany({
    where: { orgId: rc.org.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      agentId: true,
      scopePath: true,
      permission: true,
      expiresAt: true,
      revokedAt: true,
      createdAt: true,
    },
  });
  // A token names its agent by key, or by id for one minted before keys were
  // canonical; a client with no Agent row is never deactivated.
  const deactivated = await db.agent.findMany({
    where: { orgId: rc.org.id, active: false },
    select: { id: true, agentKey: true },
  });
  const off = new Set(deactivated.flatMap((a) => [a.id, a.agentKey]));
  return NextResponse.json({
    capabilities: capabilities.map((c) => ({ ...c, agentDeactivated: off.has(c.agentId) })),
  });
}

export async function POST(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: {
    agentId?: string;
    scopePath?: string;
    permission?: string;
    ttlHours?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }

  const issued = await issueCapability(rc.ctx, {
    agentRef: body.agentId,
    scopePath: body.scopePath,
    permission: body.permission,
    ttlHours: body.ttlHours,
  });
  if (!issued.ok) return NextResponse.json({ error: issued.error }, { status: issued.status });

  // `token` is returned exactly once — the caller must store it now.
  return NextResponse.json(issued.capability, { status: 201 });
}
