import { beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/briefs/:id/acknowledge — gap 4, item
// handoff-staleness-receipt-integrity-gap-20260919. A grantee attests they've
// read the brief; the attestation carries the staleness verdict at that
// moment (computed fresh here, not trusted from the client). The verdict itself is
// services/memory/brief-staleness.realdb.test.ts's subject; this file asserts the
// route records the verdict it was given.
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/memory/brief-staleness", () => ({ checkBriefStaleness: vi.fn() }));
vi.mock("@/services/access", async () => ({
  AccessDeniedError: (await vi.importActual<typeof import("@/services/access/check")>("@/services/access/check"))
    .AccessDeniedError,
  check: vi.fn(),
  recordBriefAcknowledgement: vi.fn(),
  isValidLtreePath: (await vi.importActual<typeof import("@/services/access/check")>("@/services/access/check"))
    .isValidLtreePath,
  orgRootPath: (orgId: string) => `org_${orgId}`,
}));
vi.mock("@/lib/db", () => ({
  db: { brief: { findFirst: vi.fn() } },
}));

import { requireAccessContext } from "@/lib/access-context";
import { db } from "@/lib/db";
import { AccessDeniedError, check, recordBriefAcknowledgement } from "@/services/access";
import { checkBriefStaleness } from "@/services/memory/brief-staleness";
import { POST } from "./route";

const rc = {
  org: { id: "org_1" },
  user: { id: "user_1" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_1", role: "member" } },
};
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
  vi.mocked(check).mockResolvedValue({ allowed: true, reason: "ok" } as never);
});

describe("POST /api/briefs/:id/acknowledge", () => {
  it("401s when unauthenticated", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null);
    const res = await POST(new Request("http://t"), params("brief_1"));
    expect(res.status).toBe(401);
  });

  it("404s when the brief doesn't exist in this org", async () => {
    vi.mocked(db.brief.findFirst).mockResolvedValue(null as never);
    const res = await POST(new Request("http://t"), params("brief_1"));
    expect(res.status).toBe(404);
  });

  it("404s, same as an absent id, when check() denies the reader on the brief's own scope (an ungranted/revoked reader must not still be able to acknowledge)", async () => {
    vi.mocked(db.brief.findFirst).mockResolvedValue({
      type: "handoff",
      scopePath: "org_1.engineering",
      createdAt: new Date("2026-09-15T00:00:00Z"),
    } as never);
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "no read grant" } as never);

    const res = await POST(new Request("http://t"), params("brief_1"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "brief not found" });
    expect(check).toHaveBeenCalledWith(rc.ctx, { action: "memory.read", scope: "org_1.engineering" });
    expect(checkBriefStaleness).not.toHaveBeenCalled();
    expect(recordBriefAcknowledgement).not.toHaveBeenCalled();
  });

  it("400s for a non-handoff brief type", async () => {
    vi.mocked(db.brief.findFirst).mockResolvedValue({
      type: "architecture_plan",
      scopePath: "org_1.engineering",
      createdAt: new Date("2026-09-15T00:00:00Z"),
    } as never);
    const res = await POST(new Request("http://t"), params("brief_1"));
    expect(res.status).toBe(400);
    expect(checkBriefStaleness).not.toHaveBeenCalled();
  });

  it("records stale=false and returns it when the brief is not stale", async () => {
    vi.mocked(db.brief.findFirst).mockResolvedValue({
      type: "handoff",
      scopePath: "org_1.engineering",
      createdAt: new Date("2026-09-15T00:00:00Z"),
    } as never);
    vi.mocked(checkBriefStaleness).mockResolvedValue({ stale: false, basis: "derivation", citations: [], changes: [] });
    vi.mocked(recordBriefAcknowledgement).mockResolvedValue({
      id: "audit_1",
      at: new Date("2026-09-19T02:00:00Z"),
    });

    const res = await POST(new Request("http://t"), params("brief_1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ acknowledgedAt: "2026-09-19T02:00:00.000Z", stale: false });

    expect(vi.mocked(checkBriefStaleness).mock.calls[0]).toEqual([
      rc.ctx,
      { id: "brief_1", orgId: "org_1", scopePath: "org_1.engineering", createdAt: new Date("2026-09-15T00:00:00Z") },
    ]);
    expect(vi.mocked(recordBriefAcknowledgement).mock.calls[0][0]).toMatchObject({
      orgId: "org_1",
      scopePath: "org_1.engineering",
      briefId: "brief_1",
      actorType: "human",
      actorId: "user_1",
      stale: false,
    });
  });

  it("records stale=true when the brief is stale", async () => {
    vi.mocked(db.brief.findFirst).mockResolvedValue({
      type: "handoff",
      scopePath: "org_1.engineering",
      createdAt: new Date("2026-09-15T00:00:00Z"),
    } as never);
    vi.mocked(checkBriefStaleness).mockResolvedValue({ stale: true, basis: "derivation", citations: [], changes: [] });
    vi.mocked(recordBriefAcknowledgement).mockResolvedValue({
      id: "audit_2",
      at: new Date("2026-09-19T02:00:00Z"),
    });

    const res = await POST(new Request("http://t"), params("brief_1"));
    const body = await res.json();
    expect(body.stale).toBe(true);
    expect(vi.mocked(recordBriefAcknowledgement).mock.calls[0][0]).toMatchObject({ stale: true });
  });

  it("404s, recording nothing, when the staleness check is denied after the brief check passed", async () => {
    vi.mocked(db.brief.findFirst).mockResolvedValue({
      type: "handoff",
      scopePath: "org_1.engineering",
      createdAt: new Date("2026-09-15T00:00:00Z"),
    } as never);
    vi.mocked(checkBriefStaleness).mockRejectedValue(
      new AccessDeniedError({ allowed: false, reason: "grant revoked" } as never),
    );

    const res = await POST(new Request("http://t"), params("brief_1"));
    expect(res.status).toBe(404);
    expect(recordBriefAcknowledgement).not.toHaveBeenCalled();
  });
});
