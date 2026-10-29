import { beforeEach, describe, expect, it, vi } from "vitest";

// The two Architecture PLAN routes (`/plan-interactive`, `/plan-manager`) must
// never let an unguarded caller-supplied scopePath reach check()'s `::ltree`
// cast raw.
//
// Both take a REQUIRED, caller-supplied `scopePath` and hand it to
// `check(rc.ctx, { action: "memory.read", scope: scopePath })`. `check()` calls
// `evaluate()`, which casts `${targetPath}::ltree` (services/access/check.ts,
// the `s."path"::ltree @>` query), and `recordAudit()` only runs AFTER
// `evaluate()` returns. So a malformed value handed over raw throws inside
// `evaluate()` before any audit row is written: an unaudited failed access
// attempt plus a raw Postgres error surfaced to the caller.
//
// WRITE direction, so the remedy is REFUSE, not fall back. Both routes persist
// `scopePath` onto the run and both reach
// `provisionArchitectureAgentCapability(run.orgId, meta.scopePath, ...)` in
// run-loop.ts — which is called UNCONDITIONALLY on the arch path, unlike the
// qa/run-interactive/run-manager read path where the capability is minted only
// inside `if (meta.scopePath)`. There is therefore no "no scope at all" floor to
// fall back to here: discarding the value would authorize the plan at the org
// root, a widening. These assertions deliberately admit ONLY the refuse remedy:
// a remedy-agnostic malformed-input test lets a fail-open through, and a
// behavioral assertion is only safe if every behavior it admits is safe.
//
// Exemplar is a SPACE (`org_1.deal A`), which Postgres rejects (42601). A hyphen is legal
// ltree, but these routes persist briefs at the path, so they refuse it too (route.test.ts).
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
// The real scope helpers, so a malformed scopePath is refused the way the route refuses
// it; only the grant decision is stubbed.
vi.mock("@/services/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/access")>()),
  check: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    agent: { findFirst: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_test" }) },
  },
}));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => fn() }));
vi.mock("@/services/agents/run-loop", () => ({
  createArchInteractiveRun: vi.fn(),
  driveRun: vi.fn(),
  normalizeRunAttachments: vi.fn(() => undefined),
}));
vi.mock("@/services/agents/manager", () => ({
  archManagerEnabled: vi.fn(),
  createArchManagerRun: vi.fn(),
  driveManager: vi.fn(),
}));

import { requireAccessContext } from "@/lib/access-context";
import { check } from "@/services/access";
import { db } from "@/lib/db";
import { createArchInteractiveRun } from "@/services/agents/run-loop";
import { archManagerEnabled, createArchManagerRun } from "@/services/agents/manager";

import { POST as planInteractivePOST } from "./[id]/plan-interactive/route";
import { POST as planManagerPOST } from "./[id]/plan-manager/route";

const member = {
  org: { id: "org_1" },
  user: { id: "user_42", role: "member" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "member" } },
};

/** A space is invalid ltree syntax (42601). */
const MALFORMED = "org_1.deal A";

const req = (path: string, body: unknown) =>
  new Request(`http://t/api/agents/agent_arch/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(member as never);
  vi.mocked(check).mockResolvedValue({ allowed: true, reason: "ok" } as never);
  vi.mocked(db.agent.findFirst).mockResolvedValue({ id: "agent_arch", active: true } as never);
  vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test" } as never);
  vi.mocked(createArchInteractiveRun).mockResolvedValue("run_1" as never);
  vi.mocked(createArchManagerRun).mockResolvedValue("run_1" as never);
  vi.mocked(archManagerEnabled).mockReturnValue(true);
});

describe("POST /api/agents/:id/plan-interactive — malformed scopePath must not reach check()'s ltree cast", () => {
  it("refuses with 403 and never hands the malformed scopePath to check() verbatim", async () => {
    const res = await planInteractivePOST(
      req("plan-interactive", { scopePath: MALFORMED, prompt: "plan the billing rearchitecture" }),
      params({ id: "agent_arch" }),
    );

    // Handed the raw value, evaluate()'s `::ltree` cast would throw before
    // recordAudit() ever runs.
    expect(check).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ scope: MALFORMED }));
    // Write direction: refuse. Never fall back to a wider scope, never 201.
    expect(res.status).toBe(403);
    expect(createArchInteractiveRun).not.toHaveBeenCalled();
  });

  it("records the refused attempt on the audit trail — a refused access attempt is always audited", async () => {
    await planInteractivePOST(
      req("plan-interactive", { scopePath: MALFORMED, prompt: "plan the billing rearchitecture" }),
      params({ id: "agent_arch" }),
    );

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

  it("control: a legal scopePath is still accepted and still reaches check()", async () => {
    const legal = "org_1.deal_A";
    const res = await planInteractivePOST(
      req("plan-interactive", { scopePath: legal, prompt: "plan the billing rearchitecture" }),
      params({ id: "agent_arch" }),
    );

    expect(check).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ scope: legal }));
    expect(res.status).toBe(201);
  });
});

describe("POST /api/agents/:id/plan-manager — malformed scopePath must not reach check()'s ltree cast", () => {
  it("refuses with 403 and never hands the malformed scopePath to check() verbatim", async () => {
    const res = await planManagerPOST(
      req("plan-manager", { scopePath: MALFORMED, prompt: "plan the billing rearchitecture" }),
      params({ id: "agent_arch" }),
    );

    expect(check).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ scope: MALFORMED }));
    expect(res.status).toBe(403);
    expect(createArchManagerRun).not.toHaveBeenCalled();
  });

  it("records the refused attempt on the audit trail — a refused access attempt is always audited", async () => {
    await planManagerPOST(
      req("plan-manager", { scopePath: MALFORMED, prompt: "plan the billing rearchitecture" }),
      params({ id: "agent_arch" }),
    );

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

  it("control: a legal scopePath is still accepted and still reaches check()", async () => {
    const legal = "org_1.deal_A";
    const res = await planManagerPOST(
      req("plan-manager", { scopePath: legal, prompt: "plan the billing rearchitecture" }),
      params({ id: "agent_arch" }),
    );

    expect(check).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ scope: legal }));
    expect(res.status).toBe(201);
  });
});
