// readMemoryVersion makes its one memory.read decision for an id that names nothing too.
//
// A version the caller may not read and an id that was never issued both answer null. Before,
// only the first cost a decision and left an audit row, so a refusal could be provoked only by
// naming a real version. An absent id is now decided at the org root, the rule
// services/access/authorize-record.ts states for records looked up by id.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: vi.fn(),
    convention: { findFirst: vi.fn() },
    factEdge: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock("./erasure-suppression", () => ({ loadErasedContentFilter: vi.fn(async () => () => false) }));
vi.mock("@/services/access", async (original) => ({
  ...(await original<object>()),
  check: vi.fn(async () => ({ allowed: false, reason: "no read grant", auditLogId: "audit_1" })),
}));

import { db } from "@/lib/db";
import { check, orgRootPath, type AccessContext } from "@/services/access";
import { readMemoryVersion } from "./versions";

const ORG = "org_versions_test";
const HIDDEN_SCOPE = `${orgRootPath(ORG)}.other_dept`;
const ctx: AccessContext = {
  orgId: ORG,
  actor: { type: "agent", id: "probe-reader", capabilityId: "cap_1" },
} as AccessContext;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.convention.findFirst).mockResolvedValue(null as never);
});

describe("readMemoryVersion — an id that names nothing is decided like one the caller may not read", () => {
  it("decides a hidden version at its own scope and answers null", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValue([
      {
        id: "v_hidden",
        content: "The other department owns the renewal.",
        entityName: null,
        scopePath: HIDDEN_SCOPE,
        actorId: null,
        createdAt: new Date(),
      },
    ] as never);
    expect(await readMemoryVersion(ctx, "v_hidden")).toBeNull();
    expect(vi.mocked(check).mock.calls).toEqual([[ctx, { action: "memory.read", scope: HIDDEN_SCOPE }]]);
  });

  it("decides a never-issued id at the org root and answers null", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValue([] as never);
    expect(await readMemoryVersion(ctx, "v_never_issued")).toBeNull();
    expect(vi.mocked(check).mock.calls).toEqual([[ctx, { action: "memory.read", scope: orgRootPath(ORG) }]]);
  });

  it("answers null for a never-issued id even when the org-root decision allows it", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValue([] as never);
    vi.mocked(check).mockResolvedValueOnce({ allowed: true, reason: "org admin", auditLogId: "audit_2" } as never);
    expect(await readMemoryVersion(ctx, "v_never_issued")).toBeNull();
    expect(db.factEdge.findMany).not.toHaveBeenCalled();
  });
});
