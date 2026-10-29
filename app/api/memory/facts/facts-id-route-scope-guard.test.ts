// PATCH and DELETE /api/memory/facts/:id both take a caller-supplied scope
// (`body.scope` / `?scope=`). A malformed value must never reach check()'s
// `::ltree` cast raw, which throws before recordAudit() runs: the same
// "unguarded caller-supplied scopePath" rule every other write door enforces.
// facts/[id]/provenance/route.ts routes through the shared
// resolveCallerScopePath(..., onInvalid: "refuse") helper; this file pins the
// same rule and the same test shape on facts/[id]/route.ts's own two verbs.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_test" }) },
    // The episode cap checked before the removal: no org row here, so nothing is capped.
    org: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));
vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/services/memory", () => ({
  guardedMemory: { removeFact: vi.fn().mockResolvedValue({ removed: true }) },
  MemoryServiceError: class MemoryServiceError extends Error {},
}));
// Real resolveCallerScopePath/orgRootPath/isValidLtreePath/normalizeScopePath/
// AccessDeniedError (the actual write-direction contract under test) — only
// check() itself is stubbed, same boundary provenance-route-scope-guard.test.ts draws.
vi.mock("@/services/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/access")>();
  return { ...actual, check: vi.fn() };
});

import { requireAccessContext } from "@/lib/access-context";
import { db } from "@/lib/db";
import { ingestMemory } from "@/lib/inngest";
import { guardedMemory } from "@/services/memory";
import { check, orgRootPath } from "@/services/access";
import { DELETE, PATCH } from "./[id]/route";

const rc = {
  org: { id: "org_1" },
  user: { id: "user_42", name: "Alex", email: "alex@example.com" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "member" } },
};

/** A space is invalid ltree syntax (42601). */
const MALFORMED = "org_1.deal A";

const params = (id: string) => ({ params: Promise.resolve({ id }) });

const patchReq = (id: string, body: Record<string, unknown>) =>
  new Request(`http://t/api/memory/facts/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const deleteReq = (id: string, scope?: string) =>
  new Request(`http://t/api/memory/facts/${id}${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`, {
    method: "DELETE",
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
  vi.mocked(check).mockResolvedValue({ allowed: true, reason: "ok" } as never);
  vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test" } as never);
  vi.mocked(guardedMemory.removeFact).mockResolvedValue({ removed: true });
});

describe("PATCH /api/memory/facts/:id — scope guard", () => {
  it("a selected scope reaches removeFact (which gates it) and the re-ingest at that same scope", async () => {
    await PATCH(patchReq("fact_1", { fact: "corrected", scope: "org_1.dealA" }), params("fact_1"));

    expect(guardedMemory.removeFact).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ factId: "fact_1" }),
      "org_1.dealA",
      "corrected",
    );
    expect(ingestMemory).toHaveBeenCalledWith(expect.objectContaining({ scopePath: "org_1.dealA" }));
  });

  it("no scope selected falls back to the org root", async () => {
    await PATCH(patchReq("fact_1", { fact: "corrected" }), params("fact_1"));

    expect(ingestMemory).toHaveBeenCalledWith(expect.objectContaining({ scopePath: orgRootPath("org_1") }));
  });

  it("an explicit, malformed scope is refused (403) and audited — never an unaudited throw, never silently widened, never written or re-ingested", async () => {
    const res = await PATCH(patchReq("fact_1", { fact: "corrected", scope: MALFORMED }), params("fact_1"));

    expect(res.status).toBe(403);
    expect(check).not.toHaveBeenCalled();
    expect(guardedMemory.removeFact).not.toHaveBeenCalled();
    expect(ingestMemory).not.toHaveBeenCalled();
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orgId: "org_1",
          actorId: "user_42",
          decision: "deny",
          target: MALFORMED,
        }),
      }),
    );
  });
});

describe("DELETE /api/memory/facts/:id — scope guard", () => {
  it("a selected scope reaches removeFact at that same scope", async () => {
    await DELETE(deleteReq("fact_1", "org_1.dealA"), params("fact_1"));

    expect(guardedMemory.removeFact).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ factId: "fact_1" }),
      "org_1.dealA",
    );
  });

  it("no scope selected falls back to the org root", async () => {
    await DELETE(deleteReq("fact_1"), params("fact_1"));

    expect(guardedMemory.removeFact).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ factId: "fact_1" }),
      orgRootPath("org_1"),
    );
  });

  it("an explicit, malformed scope is refused (403) and audited — never an unaudited throw, never silently deleted", async () => {
    const res = await DELETE(deleteReq("fact_1", MALFORMED), params("fact_1"));

    expect(res.status).toBe(403);
    expect(guardedMemory.removeFact).not.toHaveBeenCalled();
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orgId: "org_1",
          actorId: "user_42",
          decision: "deny",
          target: MALFORMED,
        }),
      }),
    );
  });
});
