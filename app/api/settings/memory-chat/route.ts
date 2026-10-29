import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAccessContext } from "@/lib/access-context";
import { ORG_ADMIN_ROLES, requireOrgRole } from "@/lib/org-role";

// The org's memory chat name: the name memory chat uses for the person asking
// (app/api/memory/chat/route.ts reads it, falling back to the signed-in user's
// name when it is unset).
//
// GET   /api/settings/memory-chat — read it (any signed-in member).
// PATCH /api/settings/memory-chat — set or clear it (admin/owner only).

const SELECT = { memoryChatName: true } as const;

/** Longest name accepted; it is interpolated into the chat prompt. */
const MAX_NAME_LENGTH = 100;

export async function GET(_req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const row = await db.orgPreference.findUnique({
    where: { orgId: rc.org.id },
    select: SELECT,
  });

  return NextResponse.json({ memoryChatName: row?.memoryChatName ?? null });
}

export async function PATCH(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await requireOrgRole(rc, ORG_ADMIN_ROLES, "settings:memory-chat:update"))) {
    return NextResponse.json({ error: "admin or owner required" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || !("memoryChatName" in body)) {
    return NextResponse.json({ error: "memoryChatName is required" }, { status: 400 });
  }
  const raw = body.memoryChatName;
  if (raw !== null && typeof raw !== "string") {
    return NextResponse.json({ error: "memoryChatName must be a string or null" }, { status: 400 });
  }
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (trimmed.length > MAX_NAME_LENGTH) {
    return NextResponse.json(
      { error: `memoryChatName must be at most ${MAX_NAME_LENGTH} characters` },
      { status: 400 },
    );
  }
  const memoryChatName = trimmed === "" ? null : trimmed;

  const row = await db.orgPreference.upsert({
    where: { orgId: rc.org.id },
    create: { orgId: rc.org.id, memoryChatName },
    update: { memoryChatName },
    select: SELECT,
  });

  return NextResponse.json({ memoryChatName: row.memoryChatName });
}
