// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Two scope paths must never share a graph partition.
//
// The graph store keys every write, read and cleanup on toGid(scopePath). It used to turn
// dots into dashes, and an ltree label may itself hold a dash (isValidLtreePath), so
// `eng.secrets` and `eng-secrets` were one partition: a reader granted `org.eng` asking
// for `org.eng.secrets` (inside its grant, registered or not) was served what was written
// to `org.eng-secrets`, a sibling it cannot read. Graph search facts carry only their
// partition, so nothing after the store can tell two scopes apart.
//
// What runs for real: check() with a live capability, the scope registry, the audit
// write, GuardedMemoryStore, GraphitiMemoryStore (toGid included) and the scope deletion
// residue check. The memory service is a stand-in at the HTTP boundary that, like the
// real one, matches group ids exactly.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";

vi.mock("./store", async () => {
  const { GraphitiMemoryStore } = await import("./graphiti-store");
  return { memory: {}, graphitiStore: new GraphitiMemoryStore("http://memory.test", "k") };
});

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_gid_collision";
const ROOT = `org_${ORG}`;
const GRANTED = `${ROOT}.eng`;
/** A sibling of GRANTED whose label holds a dash: same partition as `${GRANTED}.secrets`. */
const SIBLING = `${ROOT}.eng-secrets`;
/** Inside the reader's grant; the same graph partition as SIBLING. */
const COLLIDING_CHILD = `${GRANTED}.secrets`;

describe.skipIf(!QA_URL)("a scope never reads another scope's graph partition", () => {
  let db: PrismaClient;
  let GuardedMemoryStore: (typeof import("./guarded-store"))["GuardedMemoryStore"];
  let GraphitiMemoryStore: (typeof import("./graphiti-store"))["GraphitiMemoryStore"];
  /** The stand-in memory service: facts by exact group id. */
  let partitions: Map<string, string[]>;

  function serviceFetch() {
    return vi.fn(async (url: string | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const route = new URL(String(url)).pathname;
      if (route === "/ingest") {
        const facts = partitions.get(body.group_id) ?? [];
        facts.push(body.content);
        partitions.set(body.group_id, facts);
        return Response.json({ episode_id: `ep-${facts.length}` });
      }
      if (route === "/groups/residue") {
        const held = partitions.get(body.group_id)?.length ?? 0;
        return Response.json({ facts: held, episodes: held });
      }
      if (route.startsWith("/groups/") && init?.method === "DELETE") {
        const gid = decodeURIComponent(route.slice("/groups/".length));
        const removed = partitions.get(gid)?.length ?? 0;
        partitions.delete(gid);
        return Response.json({ removed_count: removed });
      }
      if (route === "/search") {
        const groups = [...new Set<string>([body.group_id, ...(body.group_ids ?? [])])];
        const facts = groups.flatMap((gid) =>
          (partitions.get(gid) ?? []).map((fact, i) => ({ uuid: `${gid}:${i}`, fact, valid_at: null, group_id: gid })),
        );
        return Response.json({ facts, groups_searched: groups.length });
      }
      return new Response("not found", { status: 404 });
    });
  }

  const write = (scopePath: string, content: string) =>
    ({ groupId: ORG, scopePath, content, actorType: "human", actorId: "u-writer", origin: "app" }) as const;

  async function reader(scopePath: string): Promise<AccessContext> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: "eng-reader",
        tokenHash: hashCapabilityToken(token),
        scopePath,
        permission: "read",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return { orgId: ORG, actor: { type: "agent", id: "eng-reader", capabilityToken: token }, origin: "mcp" };
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GuardedMemoryStore } = await import("./guarded-store"));
    ({ GraphitiMemoryStore } = await import("./graphiti-store"));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await db.$disconnect();
  });

  beforeEach(async () => {
    partitions = new Map();
    vi.stubGlobal("fetch", serviceFetch());
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    await db.scope.createMany({ data: [ROOT, GRANTED, SIBLING].map((path) => ({ orgId: ORG, path, name: path })) });
  });

  it("the reader cannot read the dashed sibling directly", async () => {
    const graph = new GraphitiMemoryStore("http://memory.test", "k");
    const ctx = await reader(GRANTED);
    await expect(
      new GuardedMemoryStore(graph).retrieve(ctx, { groupId: ORG, query: "launch" }, SIBLING),
    ).rejects.toThrow();
  });

  it("asking for a child inside the grant does not serve the sibling's facts", async () => {
    const graph = new GraphitiMemoryStore("http://memory.test", "k");
    await graph.ingest(write(SIBLING, "eng-secrets: launch code is 7741"));
    const ctx = await reader(GRANTED);

    const read = await new GuardedMemoryStore(graph).retrieve(ctx, { groupId: ORG, query: "launch" }, COLLIDING_CHILD);

    expect(read.facts.map((f) => f.fact)).not.toContain("eng-secrets: launch code is 7741");
  });

  it("a registered child inside the grant does not serve the sibling's facts on a parent read", async () => {
    await db.scope.create({ data: { orgId: ORG, path: COLLIDING_CHILD, name: COLLIDING_CHILD } });
    const graph = new GraphitiMemoryStore("http://memory.test", "k");
    await graph.ingest(write(SIBLING, "eng-secrets: launch code is 7741"));
    const ctx = await reader(GRANTED);

    const read = await new GuardedMemoryStore(graph).retrieve(ctx, { groupId: ORG, query: "launch" }, GRANTED);

    expect(read.facts.map((f) => f.fact)).not.toContain("eng-secrets: launch code is 7741");
  });

  it("a write to each of the pair lands in its own partition, and each reads back only its own", async () => {
    await db.scope.create({ data: { orgId: ORG, path: COLLIDING_CHILD, name: COLLIDING_CHILD } });
    const graph = new GraphitiMemoryStore("http://memory.test", "k");
    await graph.ingest(write(SIBLING, "eng-secrets: launch code is 7741"));
    await graph.ingest(write(COLLIDING_CHILD, "eng.secrets: rotation is weekly"));

    const childRead = await graph.retrieve({ groupId: COLLIDING_CHILD, query: "launch" });
    const siblingRead = await graph.retrieve({ groupId: SIBLING, query: "launch" });

    expect(partitions.size).toBe(2);
    expect(childRead.facts.map((f) => f.fact)).toEqual(["eng.secrets: rotation is weekly"]);
    expect(siblingRead.facts.map((f) => f.fact)).toEqual(["eng-secrets: launch code is 7741"]);
  });

  it("deletion cleanup of one of the pair neither counts nor removes the other's facts", async () => {
    await db.scope.create({ data: { orgId: ORG, path: COLLIDING_CHILD, name: COLLIDING_CHILD } });
    const { graphitiStore } = await import("./store");
    const { findScopeResidue } = await import("./scope-deletion");
    await graphitiStore.ingest(write(SIBLING, "eng-secrets: launch code is 7741"));

    expect(await findScopeResidue(ORG, COLLIDING_CHILD)).toEqual({});
    expect(await findScopeResidue(ORG, SIBLING)).toEqual({ graphFacts: 1, graphEpisodes: 1 });

    await graphitiStore.ingest(write(COLLIDING_CHILD, "eng.secrets: rotation is weekly"));
    expect(await graphitiStore.removeGroupFacts({ groupId: COLLIDING_CHILD })).toEqual({ removedCount: 1 });
    expect(await findScopeResidue(ORG, SIBLING)).toEqual({ graphFacts: 1, graphEpisodes: 1 });
  });
});
