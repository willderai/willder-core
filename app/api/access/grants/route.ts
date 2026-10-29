import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAccessContext } from "@/lib/access-context";
import { bodyTypeRefusal } from "@/lib/json-type-name";
import { authorizeRecord, canonicalAgentId, check, orgRootPath } from "@/services/access";
import type { GranteeType, Permission } from "@/lib/generated/prisma/enums";
import { GRANT_LIST_SPEC, parseAccessListQuery } from "@/lib/access-lists";
import { readGrantPage } from "@/services/access/access-list-pages";

// /api/access/grants — grant/revoke access on a scope.
// GET  → list this org's grants (org-admin). With `page`, one page searched (q),
//        filtered (permission, grantee, expiry) and ordered (sort, order) in the
//        query, as the Grants tab reads it; without, every grant.
// POST → create a grant: { scopeId | scopePath, granteeType, granteeId,
//        permission, ttlHours? }. Authorized by access.manage ON THE TARGET SCOPE,
//        so a *scope admin* (admin on that scope or an ancestor) can manage access
//        within their subtree — not only org-root admins.
//
// `granteeType: "everyone"` sets the scope's common baseline (e.g. all members get
// read), the "default ACL" a scope admin applies to the whole scope. `ttlHours`
// makes a grant time-bounded (temporary collaboration); omit for permanent.

const GRANTEE_TYPES: GranteeType[] = ["user", "role", "agent", "everyone"];
const PERMISSIONS: Permission[] = ["read", "write", "admin"];
const EVERYONE_ID = "*"; // sentinel granteeId for the scope-common baseline
const MAX_TTL_HOURS = 24 * 365; // 1 year ceiling on a single grant

export async function GET(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const decision = await check(rc.ctx, { action: "access.manage", target: "grants:list" });
  if (!decision.allowed) {
    return NextResponse.json({ error: decision.reason }, { status: 403 });
  }

  const paged = parseAccessListQuery(new URL(req.url).searchParams, GRANT_LIST_SPEC);
  if (paged !== null) {
    if ("error" in paged) return NextResponse.json({ error: paged.error }, { status: 400 });
    const { rows, ...page } = await readGrantPage(rc.org.id, paged);
    return NextResponse.json({ grants: rows, ...page });
  }

  const grants = await db.grant.findMany({
    where: { orgId: rc.org.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      granteeType: true,
      granteeId: true,
      permission: true,
      expiresAt: true,
      createdAt: true,
      scope: { select: { id: true, path: true, name: true } },
    },
  });

  // Resolve display names for user/agent grantees.
  const userIds = grants.filter((g) => g.granteeType === "user").map((g) => g.granteeId);
  const agentKeys = grants.filter((g) => g.granteeType === "agent").map((g) => g.granteeId);

  const [users, agents] = await Promise.all([
    userIds.length
      ? db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } })
      : [],
    agentKeys.length
      ? db.agent.findMany({
          where: { orgId: rc.org.id, agentKey: { in: agentKeys } },
          select: { agentKey: true, name: true },
        })
      : [],
  ]);

  const userMap = new Map(users.map((u) => [u.id, u.name ?? u.email]));
  const agentMap = new Map(agents.map((a) => [a.agentKey, a.name]));

  const enriched = grants.map((g) => ({
    ...g,
    granteeName:
      g.granteeType === "user"
        ? (userMap.get(g.granteeId) ?? g.granteeId)
        : g.granteeType === "agent"
          ? (agentMap.get(g.granteeId) ?? g.granteeId)
          : undefined,
  }));

  return NextResponse.json({ grants: enriched });
}

export async function POST(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: {
    scopeId?: string;
    scopePath?: string;
    granteeType?: string;
    granteeId?: string;
    permission?: string;
    /** Optional time-bound: hours until the grant expires (temporary collab). */
    ttlHours?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }
  // scopeId is checked with the fields that are trimmed: a non-string id reaches the
  // scope lookup below and fails there as a 500 that names nothing.
  const wrongType = bodyTypeRefusal(body, ["scopeId", "scopePath", "granteeId"]);
  if (wrongType) return NextResponse.json({ error: wrongType }, { status: 400 });

  const granteeType = body.granteeType as GranteeType;
  const permission = body.permission as Permission;
  if (!GRANTEE_TYPES.includes(granteeType)) {
    return NextResponse.json({ error: "granteeType must be user|role|agent|everyone" }, { status: 400 });
  }
  if (!PERMISSIONS.includes(permission)) {
    return NextResponse.json({ error: "permission must be read|write|admin" }, { status: 400 });
  }
  // "everyone" needs no id (it's the scope-common baseline); others require one.
  const granteeRef = granteeType === "everyone" ? EVERYONE_ID : body.granteeId?.trim();
  if (!granteeRef) {
    return NextResponse.json({ error: "granteeId is required" }, { status: 400 });
  }

  // Resolve the target scope by id or path; default to the org root. Always
  // tenant-scoped so a grant can't reference another org's scope.
  //
  // Scope-admin authority: you may manage access on this scope only if you hold
  // admin on it or an ancestor (ltree containment in check()). Org-root admins
  // pass for any scope; a dept-level admin passes only within their subtree. A
  // scope the caller cannot read answers like one that does not exist.
  const { scopeId } = body;
  const access = await authorizeRecord(
    rc.ctx,
    () =>
      scopeId
        ? db.scope.findFirst({ where: { id: scopeId, orgId: rc.org.id } })
        : db.scope.findUnique({
            where: {
              orgId_path: { orgId: rc.org.id, path: body.scopePath?.trim() || orgRootPath(rc.org.id) },
            },
          }),
    { action: "access.manage", scopeOf: (s) => s.path, target: (s) => `grants:create:${s.path}` },
  );
  if (access.status === "absent") {
    return NextResponse.json({ error: "scope not found" }, { status: 404 });
  }
  if (access.status === "denied") {
    return NextResponse.json({ error: access.decision.reason }, { status: 403 });
  }
  const scope = access.record;

  // An agent grant stores the same identifier its capability tokens store, or
  // revoking this grant cannot find them (see services/access/agent-identity.ts).
  let granteeId = granteeRef;
  if (granteeType === "agent") {
    const resolved = await canonicalAgentId(rc.org.id, granteeRef);
    if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });
    granteeId = resolved.agentId;
  }

  const expiresAt =
    typeof body.ttlHours === "number" && body.ttlHours > 0
      ? new Date(Date.now() + Math.min(body.ttlHours, MAX_TTL_HOURS) * 60 * 60 * 1000)
      : null;

  // Idempotent on (scope, grantee, permission); re-granting refreshes the expiry.
  const grant = await db.grant.upsert({
    where: {
      scopeId_granteeType_granteeId_permission: {
        scopeId: scope.id,
        granteeType,
        granteeId,
        permission,
      },
    },
    create: {
      orgId: rc.org.id,
      scopeId: scope.id,
      granteeType,
      granteeId,
      permission,
      expiresAt,
      createdBy: rc.user.id,
    },
    update: { expiresAt },
    select: {
      id: true,
      granteeType: true,
      granteeId: true,
      permission: true,
      expiresAt: true,
      createdAt: true,
      scope: { select: { id: true, path: true, name: true } },
    },
  });

  // agent-scope-full-removal-provenance-gap-20260918: this agentId's FIRST
  // grant establishes governance retroactively for any capability already
  // minted for it before this grant existed (deriveGrantGovernance() only
  // stamps governance at mint time, from whatever grants existed then). The
  // `grantGoverned: false` filter makes this a no-op on every later grant for
  // the same agentId — once ratcheted true, check.ts's own re-derivation
  // takes over and this never needs to run again for that capability.
  if (granteeType === "agent") {
    await db.capability.updateMany({
      where: { orgId: rc.org.id, agentId: granteeId, grantGoverned: false },
      data: { grantGoverned: true, derivedFromGrantId: grant.id },
    });
  }

  return NextResponse.json({ grant }, { status: 201 });
}
