import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAccessContext } from "@/lib/access-context";
import { bodyTypeRefusal } from "@/lib/json-type-name";
import { scopeNameTooLong } from "@/services/access/scope-name";
import { authorizeRecord, check, orgRootPath } from "@/services/access";

// /api/access/scopes — the scope tree (ltree). Admin-only (access.manage).
// GET  → list this org's scopes (the tree).
// POST → create a child scope under a parent (default: the org root). The creator
//        becomes ADMIN of the new scope (Google-Docs-style ownership): an explicit
//        user→admin grant on it, transferable by granting admin to someone else.

/** Turn a human name into a safe single ltree label, with a random suffix for
 * uniqueness within its parent. ltree labels are [A-Za-z0-9_]. */
function toLabel(name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "scope";
  return `${slug}_${randomBytes(3).toString("hex")}`;
}

export async function GET() {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const decision = await check(rc.ctx, { action: "access.manage", target: "scopes:list" });
  if (!decision.allowed) {
    return NextResponse.json({ error: decision.reason }, { status: 403 });
  }

  const scopes = await db.scope.findMany({
    where: { orgId: rc.org.id },
    orderBy: { path: "asc" },
    select: { id: true, path: true, name: true, createdAt: true },
  });
  return NextResponse.json({ scopes });
}

export async function POST(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { name?: string; parentPath?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }
  const wrongType = bodyTypeRefusal(body, ["name", "parentPath"]);
  if (wrongType) return NextResponse.json({ error: wrongType }, { status: 400 });
  const name = body.name?.trim();
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const tooLong = scopeNameTooLong(name);
  if (tooLong) return NextResponse.json({ error: tooLong }, { status: 400 });

  const root = orgRootPath(rc.org.id);
  const parentPath = body.parentPath?.trim() || root;
  // The parent must exist in this org (also blocks cross-tenant path injection).
  // Scope-admin authority: you may add a child only where you administer the
  // parent. A parent the caller cannot read answers like one that does not exist.
  const access = await authorizeRecord(
    rc.ctx,
    () => db.scope.findUnique({ where: { orgId_path: { orgId: rc.org.id, path: parentPath } } }),
    { action: "access.manage", scopeOf: (s) => s.path, target: `scopes:create:${parentPath}` },
  );
  if (access.status === "absent") {
    return NextResponse.json({ error: "parent scope not found" }, { status: 404 });
  }
  if (access.status === "denied") {
    return NextResponse.json({ error: access.decision.reason }, { status: 403 });
  }

  const path = `${parentPath}.${toLabel(name)}`;
  // Atomically create the scope AND make the creator its admin (ownership). Both
  // succeed or neither does, so a scope never exists without an owner.
  const scope = await db.$transaction(async (tx) => {
    const s = await tx.scope.create({ data: { orgId: rc.org.id, path, name } });
    await tx.grant.create({
      data: {
        orgId: rc.org.id,
        scopeId: s.id,
        granteeType: "user",
        granteeId: rc.user.id,
        permission: "admin",
        createdBy: rc.user.id,
      },
    });
    return s;
  });
  return NextResponse.json(
    { scope: { id: scope.id, path: scope.path, name: scope.name, createdAt: scope.createdAt } },
    { status: 201 },
  );
}
