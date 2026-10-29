// POST /api/memory/entities/merge — bare-org partition.
//
// entities/merge never trusts a caller-supplied `scope`: it resolves fromName's
// real scope server-side (resolveEntityScope) and check()s + writes at exactly
// that scope (see route.eval.test.ts).
//
// resolveEntityScope's FIRST candidate is the BARE org id — the untagged
// Graphiti partition, which services/memory/entity-scope.ts's own comment calls
// "genuinely the most common location for older/seeded entities". If check()
// evaluated that bare id as its ltree targetPath, against `scopes.path` rows that
// are all `org_<orgId>[...]`, NO grant could ever cover it (`org_<orgId>` is NOT
// an ancestor-or-self of the bare `<orgId>` string), not even an org-root admin
// grant, the widest legitimate authority the product has, and every merge of a
// bare-org entity would 403 for everyone: fail-closed, but the route's most
// common real case broken.
//
// The convention for untagged content: guarded-store.ts gates bare-org/untagged
// content on `pathCovers(scope ?? orgRootPath(ctx.orgId), orgRootPath(ctx.orgId))`
// — the CHECKED scope is always a real ltree path, while the bare org id is only
// ever used as the WRITE partition (removeFact() checks at `scope ?? orgRoot` and
// writes at `input.groupId`). transferEntity() carries the same (checkScope,
// writeGroupId) pair: check at orgRootPath(orgId) when the resolved partition is
// the bare org id, write at the bare org id.
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

const ORG_ID = "clbareorgtest001";
const ROOT = orgRootPath(ORG_ID); // org_clbareorgtest001

/** ltree ancestor-or-self — the same relation Postgres `@>` gives check(). */
const covers = (granted: string, target: string): boolean => target === granted || target.startsWith(`${granted}.`);

// An ORG ADMIN: a real grant on the org ROOT scope. If any caller is allowed to
// merge an entity in this org, this one is.
const rc = {
  org: { id: ORG_ID },
  user: { id: "user_admin", name: "Org Admin" },
  ctx: { orgId: ORG_ID, actor: { type: "human" as const, id: "user_admin", role: "admin" as const } },
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
  vi.mocked(strictDescendantScopePaths).mockResolvedValue([]); // org root is the only registered scope
  vi.mocked(db.$queryRaw).mockImplementation(((_s: unknown, ...values: unknown[]) => {
    const targetPath = values[values.length - 1] as string;
    return Promise.resolve(covers(ROOT, targetPath) ? [{ permission: "admin" }] : []);
  }) as never);
});

describe("POST /api/memory/entities/merge — bare-org partition", () => {
  it("lets an org-root admin merge an entity that lives in the bare-org partition", async () => {
    // "Bob" was written by an ingest path that carried no scopePath at all, so he
    // lives in the bare-org partition: groupId === ORG_ID, not orgRootPath(ORG_ID).
    vi.mocked(graphitiStore.groupsHoldingEntity).mockImplementation(
      holding((groupId, name) => groupId === ORG_ID && name === "Bob"),
    );
    vi.mocked(memory.transferEntity).mockResolvedValue({ transferred: 2 });

    const res = await POST(post({ fromName: "Bob", toName: "Robert" }));

    // A 403 here ("no write grant for user user_admin as a member of this org on
    // clbareorgtest001") means the checked scope is the bare org id, which no
    // grant can cover.
    expect(res.status).toBe(200);
    // And the write must still land in the bare-org partition it resolved from,
    // not be silently widened to the org root scope.
    expect(memory.transferEntity).toHaveBeenCalledWith({
      groupId: ORG_ID,
      oldName: "Bob",
      newName: "Robert",
    });
  });

  it("control: the same admin can merge an entity at the org root scope", async () => {
    vi.mocked(graphitiStore.groupsHoldingEntity).mockImplementation(
      holding((groupId, name) => groupId === ROOT && name === "Marcus"),
    );
    vi.mocked(memory.transferEntity).mockResolvedValue({ transferred: 1 });

    const res = await POST(post({ fromName: "Marcus", toName: "Marcus Chen" }));

    expect(res.status).toBe(200);
  });

  it("a member with no org-root grant is still denied a bare-org merge", async () => {
    // The fail-closed direction must stay closed: checking at orgRootPath must
    // not become a blanket allow.
    vi.mocked(db.$queryRaw).mockImplementation((() => Promise.resolve([])) as never);
    vi.mocked(graphitiStore.groupsHoldingEntity).mockImplementation(
      holding((groupId, name) => groupId === ORG_ID && name === "Bob"),
    );

    const res = await POST(post({ fromName: "Bob", toName: "Robert" }));

    // 404, not 403 — see route.eval.test.ts's own comment on the same collapse.
    expect(res.status).toBe(404);
    expect(memory.transferEntity).not.toHaveBeenCalled();
  });
});

// Checking bare-org merges at orgRootPath(orgId) instead of the uncoverable bare
// id must not open a privilege escalation. The deny case above only proves a
// caller with NO grants at all is refused. The case that matters is a caller
// holding a REAL, narrower grant: dealA write, nothing at org root. Under the
// convention for untagged content (guarded-store.ts gates the bare-org leg on
// pathCovers(checked scope, orgRoot)), that caller must NOT be able to reach a
// bare-org entity — otherwise the bare-org check would trade a 403 for a
// privilege escalation into untagged org-wide content.
describe("bare-org merge is not reachable from a narrower real grant", () => {
  it("denies a dealA-write member merging a bare-org entity, and never calls the store", async () => {
    const DEAL_A = `${ROOT}.dealA`;
    // A real grant, implemented with real containment — dealA and below only.
    vi.mocked(strictDescendantScopePaths).mockResolvedValue([DEAL_A]);
    vi.mocked(db.$queryRaw).mockImplementation(((_s: unknown, ...values: unknown[]) => {
      const targetPath = values[values.length - 1] as string;
      return Promise.resolve(covers(DEAL_A, targetPath) ? [{ permission: "write" }] : []);
    }) as never);
    // "Bob" lives in the untagged bare-org partition, outside dealA entirely.
    vi.mocked(graphitiStore.groupsHoldingEntity).mockImplementation(
      holding((groupId, name) => groupId === ORG_ID && name === "Bob"),
    );

    const res = await POST(post({ fromName: "Bob", toName: "Robert" }));

    // 404, not 403.
    expect(res.status).toBe(404);
    expect(memory.transferEntity).not.toHaveBeenCalled();
  });

  it("control: that same dealA member CAN merge an entity that really lives in dealA", async () => {
    const DEAL_A = `${ROOT}.dealA`;
    vi.mocked(strictDescendantScopePaths).mockResolvedValue([DEAL_A]);
    vi.mocked(db.$queryRaw).mockImplementation(((_s: unknown, ...values: unknown[]) => {
      const targetPath = values[values.length - 1] as string;
      return Promise.resolve(covers(DEAL_A, targetPath) ? [{ permission: "write" }] : []);
    }) as never);
    vi.mocked(graphitiStore.groupsHoldingEntity).mockImplementation(
      holding((groupId, name) => groupId === DEAL_A && name === "Marcus"),
    );
    vi.mocked(memory.transferEntity).mockResolvedValue({ transferred: 1 });

    const res = await POST(post({ fromName: "Marcus", toName: "Marcus Chen" }));

    expect(res.status).toBe(200);
    expect(memory.transferEntity).toHaveBeenCalledWith({
      groupId: DEAL_A,
      oldName: "Marcus",
      newName: "Marcus Chen",
    });
  });
});
