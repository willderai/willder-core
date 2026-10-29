// Cross-scope entity-name existence oracle — POST /api/memory/entities/merge.
//
// The route resolves fromName across EVERY candidate partition BEFORE check() runs:
//
//   const scope = await resolveEntityScope(rc.org.id, fromName);   // probes dealB too
//   if (!scope) return 404;                                        // absent everywhere
//   ... guardedMemory.transferEntity() -> check()                  // exists, not yours
//
// If the second branch answered 403, a dealA-only contractor would learn, for any
// name they like, whether it exists somewhere in the org they cannot read: 404
// "no such name anywhere", 403 "it exists in a scope you have no grant on". Two
// different answers to a question this caller should not be able to ask at all.
// Enumerating client/person names out of a deal you were never added to is an
// intra-tenant leak, so an unauthorized hit must be indistinguishable from a miss.
//
// Both halves are also asserted in route.eval.test.ts (the hidden dealB case and
// the absent-everywhere case, same dealA-only caller from its beforeEach). This
// file puts them in one place so the difference is the assertion instead of an
// accident of two separate tests.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    orgDeletion: { findFirst: async () => null },
    $queryRaw: vi.fn(),
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_test" }), update: vi.fn() },
  },
}));
vi.mock("@/services/access/scope-registry", () => ({ strictDescendantScopePaths: vi.fn(async () => []) }));
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/memory/store", () => ({
  memory: { transferEntity: vi.fn() },
  graphitiStore: { groupsHoldingEntity: vi.fn() },
}));
vi.mock("@/services/memory/entity-aliases", async (importActual) => ({
  ...(await importActual<typeof import("@/services/memory/entity-aliases")>()),
  recordMergeAlias: vi.fn().mockResolvedValue(undefined),
}));

import { strictDescendantScopePaths } from "@/services/access/scope-registry";
import { db } from "@/lib/db";
import { requireAccessContext } from "@/lib/access-context";
import { memory, graphitiStore } from "@/services/memory/store";
import { orgRootPath } from "@/services/access";
import { POST } from "./route";
import { holding } from "./graph-holding.testsupport";

const ORG_ID = "org_oracle_test";
const ROOT = orgRootPath(ORG_ID);
const DEAL_A = `${ROOT}.dealA`;
const DEAL_B = `${ROOT}.dealB`;

const covers = (granted: string, target: string): boolean => target === granted || target.startsWith(`${granted}.`);

// dealA-only contractor. No grant on dealB, none at org root.
const rc = {
  org: { id: ORG_ID },
  user: { id: "user_1", name: "Contractor A" },
  ctx: { orgId: ORG_ID, actor: { type: "human" as const, id: "user_1", role: "member" as const } },
};

const post = (body: unknown) =>
  new Request("http://t/api/memory/entities/merge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
  vi.mocked(strictDescendantScopePaths).mockResolvedValue([DEAL_A, DEAL_B]);
  vi.mocked(db.$queryRaw).mockImplementation(((_s: unknown, ...values: unknown[]) => {
    const targetPath = values[values.length - 1] as string;
    return Promise.resolve(covers(DEAL_A, targetPath) ? [{ permission: "write" }] : []);
  }) as never);
});

describe("POST /api/memory/entities/merge — cross-scope existence oracle", () => {
  it("gives the same answer for a name hidden in dealB as for a name that exists nowhere", async () => {
    // (a) "Acme Corp" exists, but only in dealB — a scope this caller cannot read.
    vi.mocked(graphitiStore.groupsHoldingEntity).mockImplementation(
      holding((groupId, name) => groupId === DEAL_B && name === "Acme Corp"),
    );
    const hidden = await POST(post({ fromName: "Acme Corp", toName: "Acme Corporation" }));

    // (b) "Zzzz Nonexistent" exists in no partition at all.
    vi.mocked(graphitiStore.groupsHoldingEntity).mockResolvedValue([]);
    const absent = await POST(post({ fromName: "Zzzz Nonexistent", toName: "Somebody" }));

    // Neither may be merged — that much already holds.
    expect(memory.transferEntity).not.toHaveBeenCalled();

    // These two must not be distinguishable by this caller: hidden === 403 and
    // absent === 404 would answer "does this name exist somewhere in the org?"
    // for anyone with write on any single scope.
    expect(hidden.status).toBe(absent.status);
  });
});

describe("POST /api/memory/entities/merge — a name that resolves nowhere is still decided", () => {
  const denyRows = () =>
    vi
      .mocked(db.auditLog.create)
      .mock.calls.map(([arg]) => (arg as { data: { action: string; target: string; decision: string } }).data)
      .filter((row) => row.decision === "deny");

  it("refuses a never-issued name at the org root, with one deny row, as a hidden name is refused at its own scope", async () => {
    vi.mocked(graphitiStore.groupsHoldingEntity).mockImplementation(
      holding((groupId, name) => groupId === DEAL_B && name === "Acme Corp"),
    );
    const hidden = await POST(post({ fromName: "Acme Corp", toName: "Acme Corporation" }));
    const hiddenRows = denyRows();

    vi.mocked(db.auditLog.create).mockClear();
    vi.mocked(graphitiStore.groupsHoldingEntity).mockResolvedValue([]);
    const absent = await POST(post({ fromName: "Zzzz Nonexistent", toName: "Somebody" }));
    const absentRows = denyRows();

    expect(memory.transferEntity).not.toHaveBeenCalled();
    expect([hidden.status, absent.status]).toEqual([404, 404]);
    expect(await absent.json()).toEqual(await hidden.json());
    expect(hiddenRows).toHaveLength(1);
    expect(absentRows).toHaveLength(1);
    expect(absentRows[0]).toMatchObject({ action: "memory.write" });
    expect(absentRows[0]!.target.startsWith(`${ROOT}/merge:Zzzz Nonexistent`)).toBe(true);
  });

  it("adds no org-root decision for a duplicate name already refused at each of its scopes", async () => {
    const DEAL_C = `${ROOT}.dealC`;
    vi.mocked(strictDescendantScopePaths).mockResolvedValue([DEAL_A, DEAL_B, DEAL_C]);
    vi.mocked(graphitiStore.groupsHoldingEntity).mockImplementation(
      holding((groupId, name) => (groupId === DEAL_B || groupId === DEAL_C) && name === "Acme Corp"),
    );
    const refused = await POST(post({ fromName: "Acme Corp", toName: "Acme Corporation" }));
    expect(refused.status).toBe(404);
    expect(denyRows().map((row) => row.target.split("/")[0])).toEqual([DEAL_B, DEAL_C]);
  });

  it("answers an org-root writer 404 for a never-issued name, though the decision allowed it", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValue([{ permission: "write" }] as never);
    vi.mocked(graphitiStore.groupsHoldingEntity).mockResolvedValue([]);
    const absent = await POST(post({ fromName: "Zzzz Nonexistent", toName: "Somebody" }));
    expect(absent.status).toBe(404);
    expect(memory.transferEntity).not.toHaveBeenCalled();
  });
});
