// GET /api/changes is the HTTP half of the same seam mcp/tools.test.ts covers: a
// capability token at the door, a target scope the SERVER resolves from that
// token, and a 403 built from the decision. A refusal there must not name the
// resolved scope path — its ltree labels are entity names, so naming it tells a
// caller who was just refused which subjects live in their org.
//
// Driven through the real resolveCapability/check()/readChanges chain with only
// @/lib/db mocked (the boundary services/access/check.test.ts uses), so this
// asserts the behaviour of the response and of the persisted audit row, not the
// text of any source file.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    capability: { findUnique: vi.fn() },
    // resolveCapability asks whether the token's agent is deactivated; no Agent row means it is not.
    agent: { count: vi.fn().mockResolvedValue(0) },
    $queryRaw: vi.fn(),
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_test" }), update: vi.fn() },
  },
}));

import { db } from "@/lib/db";
import { GET } from "./changes/route";

const ORG = "org_changes_test";
/** The label the refusal must not disclose. It reaches check() only from the
 * capability row the server looked up, never from anything the caller sent. */
const SUBJECT_LABEL = "Northwind_Holdings";
const RESOLVED_SCOPE = `${ORG}.${SUBJECT_LABEL}.detail`;

const get = (url = "http://t/api/changes") =>
  new Request(url, { headers: { authorization: "Bearer wcap_live_token" } });

describe("GET /api/changes — a refusal does not disclose the scope it refused", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test" } as never);
    // A live token whose own scope is the deep, server-held path.
    vi.mocked(db.capability.findUnique).mockResolvedValue({
      id: "cap_1",
      orgId: ORG,
      agentId: "agent_1",
      scopePath: RESOLVED_SCOPE,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000),
    } as never);
    // No capability row covers the read: the ordinary default deny.
    vi.mocked(db.$queryRaw).mockResolvedValue([] as never);
  });

  it("answers 403 without the resolved scope label, and still says what is missing", async () => {
    const res = await GET(get());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };

    expect(body.error).not.toContain(SUBJECT_LABEL);
    expect(body.error).toMatch(/no valid capability/i);
    expect(body.error).toMatch(/read/);
    expect(body.error).toMatch(/ask an org admin/i);
  });

  it("leaves the audit row able to answer what was refused", async () => {
    await GET(get());

    const row = vi.mocked(db.auditLog.create).mock.calls.at(-1)?.[0] as {
      data: { decision: string; actorId: string; action: string; target: string; reason: string };
    };
    expect(row.data.decision).toBe("deny");
    expect(row.data.actorId).toBe("agent_1");
    expect(row.data.action).toBe("memory.read");
    // A reviewer reading only this row can tell exactly which scope was refused.
    expect(row.data.target).toBe(RESOLVED_SCOPE);
    expect(row.data.reason).toContain(RESOLVED_SCOPE);
  });
});
