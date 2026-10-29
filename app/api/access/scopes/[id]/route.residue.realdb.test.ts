// DELETE /api/access/scopes/:id refuses while anything readable remains at the
// scope's path, and clears change-event summaries when it does delete, so a
// scope recreated at the same path starts empty.
//
// Drives the real route and services/memory/scope-deletion.ts against Postgres.
// Only the memory service (Graphiti) is stubbed: its answer for the scope's
// group is set per case. The service's own count is tested against real Neo4j
// in memory-service/tests/test_group_residue_integration.py.
//
// Set QA_DATABASE_URL to an isolated test database. Skips cleanly without it.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "org-scope-residue";
const OTHER_ORG = "org-scope-residue-other";
const ROOT = "org_sr";
const SCOPE = "org_sr.dept_a";
const ADMIN = "u-admin-scope-residue";

const groupResidue = vi.hoisted(() => vi.fn());
// A paged graph read sees no edge when the fact's source entity is outside the
// page; the residue check must not rely on it.
const graph = vi.hoisted(() => vi.fn());
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/memory/store", () => ({ graphitiStore: { graph, groupResidue }, memory: {} }));

describe.skipIf(!QA_URL)("scope delete refuses residue and clears the feed, real Postgres", () => {
  let db: PrismaClient;
  let scopeDELETE: (typeof import("./route"))["DELETE"];
  let MemoryServiceError: (typeof import("@/services/memory/graphiti-store"))["MemoryServiceError"];
  let scopeId: string;
  let seq = BigInt(0);

  async function wipe() {
    const orgs = { in: [ORG, OTHER_ORG] };
    for (const model of [
      db.auditLog,
      db.changeEvent,
      db.capability,
      db.memoryChunk,
      db.convention,
      db.brief,
      db.source,
      db.grant,
      db.scope,
      db.user,
    ] as unknown as { deleteMany(args: unknown): Promise<unknown> }[]) {
      await model.deleteMany({ where: { orgId: orgs } });
    }
    await db.org.deleteMany({ where: { id: orgs } });
  }

  beforeEach(async () => {
    process.env.DATABASE_URL = QA_URL;
    db ??= new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ DELETE: scopeDELETE } = await import("./route"));
    ({ MemoryServiceError } = await import("@/services/memory/graphiti-store"));
    const { requireAccessContext } = (await import("@/lib/access-context")) as never as {
      requireAccessContext: ReturnType<typeof vi.fn>;
    };

    await wipe();
    seq = BigInt(0);
    await db.org.create({ data: { id: ORG, name: "scope residue" } });
    await db.org.create({ data: { id: OTHER_ORG, name: "scope residue other" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: "a@scope-residue.test", role: "admin", clerkId: "clerk-scope-residue" },
    });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    scopeId = (await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "dept a" } })).id;

    graph.mockReset();
    graph.mockResolvedValue({ nodes: [], edges: [] });
    groupResidue.mockReset();
    groupResidue.mockResolvedValue({ facts: 0, episodes: 0 });
    requireAccessContext.mockResolvedValue({
      org: { id: ORG },
      user: { id: ADMIN },
      ctx: { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" } },
    });
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  function deleteScope(id = scopeId) {
    return scopeDELETE(new Request("http://t", { method: "DELETE" }), { params: Promise.resolve({ id }) });
  }

  const day = 24 * 60 * 60 * 1000;
  const seeds = {
    source: (scopePath: string, orgId = ORG) =>
      db.source.create({
        data: { orgId, type: "website", externalId: `ext-${scopePath}-${orgId}`, name: "site", scopePath },
      }),
    brief: (scopePath: string) =>
      db.brief.create({
        data: { orgId: ORG, type: "handoff", scopePath, title: "Q3 pricing", summary: "s", sections: [] },
      }),
    convention: (scopePath: string) =>
      db.convention.create({
        data: { orgId: ORG, scopePath, kind: "convention", subject: "dedupe", text: "t", actorId: ADMIN },
      }),
    chunk: (scopePath: string) => db.memoryChunk.create({ data: { orgId: ORG, content: "pricing notes", scopePath } }),
    capability: (scopePath: string, extra: { expiresAt?: Date; revokedAt?: Date } = {}) =>
      db.capability.create({
        data: {
          orgId: ORG,
          agentId: "agent-residue",
          tokenHash: `hash-${Math.random()}`,
          scopePath,
          expiresAt: extra.expiresAt ?? new Date(Date.now() + day),
          revokedAt: extra.revokedAt,
        },
      }),
    changeEvent: (scopePath: string, summary: string, orgId = ORG) =>
      db.changeEvent.create({
        data: {
          orgId,
          seq: (seq += BigInt(1)),
          scopePath,
          recordType: "brief",
          recordId: `rec-${seq}`,
          op: "create",
          actorId: ADMIN,
          summary,
        },
      }),
  };

  async function scopeStillExists() {
    return (await db.scope.count({ where: { id: scopeId } })) === 1;
  }

  it("deletes an empty scope and its grants", async () => {
    await db.grant.create({
      data: { orgId: ORG, scopeId, granteeType: "role", granteeId: "member", permission: "read" },
    });

    const res = await deleteScope();

    expect(res.status).toBe(204);
    expect(await scopeStillExists()).toBe(false);
    expect(await db.grant.count({ where: { scopeId } })).toBe(0);
    expect(groupResidue).toHaveBeenCalledWith({ groupId: SCOPE });
  });

  it.each([
    ["sources", () => seeds.source(SCOPE), "1 source"],
    ["briefs", () => seeds.brief(SCOPE), "1 brief"],
    ["conventions", () => seeds.convention(SCOPE), "1 convention"],
    ["memoryChunks", () => seeds.chunk(SCOPE), "1 memory chunk"],
    ["liveCapabilities", () => seeds.capability(SCOPE), "1 unrevoked agent token"],
  ] as const)("refuses while %s remain at the path", async (kind, seed, phrase) => {
    await seed();

    const res = await deleteScope();

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.remaining).toEqual({ [kind]: 1 });
    expect(body.error).toContain(phrase);
    expect(await scopeStillExists()).toBe(true);
  });

  it("refuses while the scope's graph group still holds a fact a paged graph read does not show", async () => {
    groupResidue.mockResolvedValue({ facts: 1, episodes: 0 });

    const res = await deleteScope();

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.remaining).toEqual({ graphFacts: 1 });
    expect(body.error).toContain("1 fact;");
    expect(await scopeStillExists()).toBe(true);
  });

  it("refuses while the scope's graph group still holds ingested episodes", async () => {
    groupResidue.mockResolvedValue({ facts: 0, episodes: 2 });

    const res = await deleteScope();

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.remaining).toEqual({ graphEpisodes: 2 });
    expect(body.error).toContain("2 ingested episodes");
    expect(await scopeStillExists()).toBe(true);
  });

  it("names every kind that remains, and counts rows below the path that have no scope row", async () => {
    await seeds.source(`${SCOPE}.deep.er`);
    await seeds.chunk(SCOPE);
    await seeds.chunk(`${SCOPE}.deep`);

    const res = await deleteScope();

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.remaining).toEqual({ sources: 1, memoryChunks: 2 });
    expect(body.error).toBe(
      "this scope still holds 1 source and 2 memory chunks; remove or move them before deleting it",
    );
  });

  it("ignores revoked and expired tokens, another org's rows, and a sibling an unescaped '_' would match", async () => {
    await seeds.capability(SCOPE, { revokedAt: new Date() });
    await seeds.capability(SCOPE, { expiresAt: new Date(Date.now() - day) });
    await seeds.source(SCOPE, OTHER_ORG);
    // `dept_a` as an unescaped LIKE pattern matches `deptXa`.
    await seeds.source("org_sr.deptXa.child");
    await seeds.brief("org_sr.deptXa");
    await seeds.chunk("org_sr.dept_ab");

    const res = await deleteScope();

    expect(res.status).toBe(204);
    expect(await scopeStillExists()).toBe(false);
  });

  it("returns 503 and keeps the scope when the memory service cannot answer", async () => {
    groupResidue.mockRejectedValue(new MemoryServiceError("memory service /groups/residue failed: down", 502));

    const res = await deleteScope();

    expect(res.status).toBe(503);
    expect(await scopeStillExists()).toBe(true);
  });

  it("returns 503, not a crash, for an empty scope when the connection to the memory service fails", async () => {
    // The real client this time: the failure is fetch's own TypeError, which the
    // route must see as the memory service being unavailable.
    const { GraphitiMemoryStore } = await import("@/services/memory/graphiti-store");
    const reset = new TypeError("fetch failed", { cause: new Error("read ECONNRESET") });
    const fetchMock = vi.fn().mockRejectedValue(reset);
    vi.stubGlobal("fetch", fetchMock);
    groupResidue.mockImplementation((input: { groupId: string }) =>
      new GraphitiMemoryStore("http://memory.test", "key").groupResidue(input),
    );

    try {
      const res = await deleteScope();

      expect(res.status).toBe(503);
      expect((await res.json()).error).toContain("memory service unavailable");
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(await scopeStillExists()).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns 503 and keeps the scope when the residue answer breaks off mid-body", async () => {
    // The service answered 200, then the socket closed before the JSON finished.
    const { GraphitiMemoryStore } = await import("@/services/memory/graphiti-store");
    const closed = new TypeError("terminated", { cause: new Error("other side closed") });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.reject(closed) }));
    groupResidue.mockImplementation((input: { groupId: string }) =>
      new GraphitiMemoryStore("http://memory.test", "key").groupResidue(input),
    );

    try {
      const res = await deleteScope();

      expect(res.status).toBe(503);
      expect((await res.json()).error).toContain("memory service unavailable");
      expect(await scopeStillExists()).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("clears change-event summaries at and under the path, keeps the rows, and leaves others alone", async () => {
    const atPath = await seeds.changeEvent(SCOPE, "Q3 pricing brief");
    const below = await seeds.changeEvent(`${SCOPE}.deep`, "deep note");
    const sibling = await seeds.changeEvent("org_sr.deptXa", "sibling note");
    const otherOrg = await seeds.changeEvent(SCOPE, "other org note", OTHER_ORG);

    const res = await deleteScope();
    expect(res.status).toBe(204);

    const summaries = Object.fromEntries(
      (
        await db.changeEvent.findMany({
          select: { id: true, summary: true },
          where: { orgId: { in: [ORG, OTHER_ORG] } },
        })
      ).map((e) => [e.id, e.summary]),
    );
    expect(summaries).toEqual({
      [atPath.id]: "",
      [below.id]: "",
      [sibling.id]: "sibling note",
      [otherOrg.id]: "other org note",
    });
  });

  it("a refused delete clears no summaries", async () => {
    const event = await seeds.changeEvent(SCOPE, "Q3 pricing brief");
    await seeds.brief(SCOPE);

    expect((await deleteScope()).status).toBe(409);

    expect((await db.changeEvent.findUniqueOrThrow({ where: { id: event.id } })).summary).toBe("Q3 pricing brief");
  });

  it("a scope recreated at the same path inherits nothing", async () => {
    await seeds.changeEvent(SCOPE, "Q3 pricing brief");
    expect((await deleteScope()).status).toBe(204);

    const recreated = await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "dept a again" } });
    const { findScopeResidue } = await import("@/services/memory/scope-deletion");

    expect(await findScopeResidue(ORG, SCOPE)).toEqual({});
    expect(await db.grant.count({ where: { scopeId: recreated.id } })).toBe(0);
    const summaries = await db.changeEvent.findMany({
      where: { orgId: ORG, scopePath: SCOPE },
      select: { summary: true },
    });
    expect(summaries).toEqual([{ summary: "" }]);
  });
});
