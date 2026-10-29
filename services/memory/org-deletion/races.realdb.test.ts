// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Org deletion's edges, from the adversarial pass before review: writes the database must
// refuse while a deletion is open (a child table with no orgId, tables the first trigger
// list missed, an update rather than a new row), an export copy stored after a cancel,
// and the races: concurrent starts from both triggers, and a cancel against the job at
// the 7-day boundary. Who may cancel and download is in org-deletion.realdb.test.ts.
// Doubles as in that file: session, Blob (in-memory map), graph, Inngest send.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { seedMember } from "@/services/access/member.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const blobs = vi.hoisted(() => new Map<string, { pathname: string; body: string; uploadedAt: Date }>());
const graph = vi.hoisted(() => ({ nodes: new Map<string, number>() }));
const session = vi.hoisted(() => ({ clerkId: null as string | null, orgId: null as string | null }));
const queued = vi.hoisted(() => [] as string[]);

vi.mock("@/lib/blob-storage", () => {
  let n = 0;
  async function text(body: unknown): Promise<string> {
    if (body instanceof ReadableStream) return new Response(body).text();
    return String(body);
  }
  return {
    putPrivateBlob: async (pathname: string, body: unknown) => {
      const url = `https://blob.test/${pathname}-${(n += 1)}`;
      blobs.set(url, { pathname, body: await text(body), uploadedAt: new Date() });
      return { url };
    },
    deletePrivateBlob: async (url: string) => {
      blobs.delete(url);
    },
    readPrivateBlob: async (url: string) => {
      const blob = blobs.get(url);
      return blob ? new Response(blob.body).body : null;
    },
    listPrivateBlobs: async (prefix: string) =>
      [...blobs.entries()]
        .filter(([, b]) => b.pathname.startsWith(prefix))
        .map(([url, b]) => ({ url, pathname: b.pathname, size: b.body.length, uploadedAt: b.uploadedAt })),
  };
});

function inOrg(orgId: string, group: string): boolean {
  const root = `org_${orgId}`;
  return group === orgId || group === root || group.startsWith(`${root}-`);
}

vi.mock("@/services/memory/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/store")>()),
  graphitiStore: {
    purgeOrg: async (orgId: string) => {
      let nodes = 0;
      for (const [group, count] of graph.nodes) {
        if (inOrg(orgId, group)) {
          nodes += count;
          graph.nodes.delete(group);
        }
      }
      return { nodes, relationships: 0 };
    },
    orgResidue: async (orgId: string) => {
      let nodes = 0;
      for (const [group, count] of graph.nodes) if (inOrg(orgId, group)) nodes += count;
      return { nodes, relationships: 0 };
    },
  },
}));

// Day 7 deletes the Clerk organization; what that call does is proven in clerk-events.realdb.test.ts.
vi.mock("@/services/memory/org-deletion/clerk-org", () => ({ deleteClerkOrganization: async () => {} }));
vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: session.clerkId }) }));
vi.mock("@/lib/inngest/org-deletion", () => ({
  queueFinalExport: async (id: string) => {
    queued.push(id);
  },
}));
vi.mock("@/lib/access-context", () => ({
  requireAccessContext: async () => {
    const { db } = await import("@/lib/db");
    const { liveMembership } = await import("@/services/access");
    if (!session.clerkId || !session.orgId) return null;
    const org = await db.org.findUnique({ where: { id: session.orgId } });
    const user = await db.user.findUnique({ where: { clerkId: session.clerkId } });
    if (!org || !user) return null;
    const membership = await liveMembership(org.id, user.id);
    if (!membership) return null;
    return {
      org,
      user: { ...user, role: membership.role },
      ctx: { orgId: org.id, actor: { type: "human", id: user.id, role: membership.role }, origin: "app" },
    };
  },
}));

const A = "qadelrta";
const ROOT_A = `org_${A}`;
const ADMIN_A = "u-rt-admin-a";
const ADMIN_A2 = "u-rt-admin-a2";
const PEOPLE = [ADMIN_A, ADMIN_A2];
const clerk = (userId: string) => `clerk_${userId}`;
const DAY = 86_400_000;
const T0 = new Date("2026-11-02T10:00:00.000Z");
const at = (days: number, ms = 0) => new Date(T0.getTime() + days * DAY + ms);

describe.skipIf(!QA_URL)("org deletion edges and races, real Postgres", { timeout: 60_000 }, () => {
  let db: PrismaClient;
  let svc: typeof import("./request");
  let run: typeof import("./run");

  async function reset() {
    await db.org.deleteMany({ where: { id: A } });
    await db.user.deleteMany({ where: { id: { in: PEOPLE } } });
    await db.orgDeletion.deleteMany({ where: { orgId: A } });
    blobs.clear();
    graph.nodes.clear();
    queued.length = 0;
  }

  async function seed() {
    await db.org.create({ data: { id: A, name: `Org ${A}`, clerkOrgId: `clerk_org_${A}` } });
    await db.scope.create({ data: { orgId: A, path: ROOT_A, name: "root" } });
    await seedMember(db, { orgId: A, userId: ADMIN_A, role: "admin" });
    await db.$executeRaw`
      INSERT INTO memory_chunks (id, "orgId", content, source, "actorType", "actorId", "scopePath", "factVersion", "createdAt")
      VALUES (${`${A}-fact-0`}, ${A}, 'Renewal is in March.', 'text', 'agent', 'agent-1', ${ROOT_A}, true, ${at(-10)})`;
    const source = await db.source.create({
      data: {
        orgId: A,
        type: "gdrive",
        externalId: `folder-${A}`,
        name: "Folder",
        scopePath: ROOT_A,
        encryptedTokens: "x",
      },
    });
    const contact = await db.contact.create({ data: { orgId: A, name: "Jordan Example" } });
    return { sourceId: source.id, contactId: contact.id };
  }

  async function startOwner(now = T0) {
    const started = await svc.startOrgDeletion(
      { trigger: "owner", orgId: A, requestedBy: ADMIN_A, requesterClerkId: clerk(ADMIN_A) },
      now,
    );
    return started!.deletion.id;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    svc = await import("./request");
    run = await import("./run");
  });
  beforeEach(async () => {
    vi.useRealTimers();
    await reset();
  });
  afterAll(async () => {
    await reset();
    await db.$disconnect();
  });

  // --- Claim: "the database refuses writes to the org's content and access tables";
  //     DPA: "refuses new writes to the organization's memory, files, connected sources".

  it("a connector sync's new source_files row is refused while the deletion is pending", async () => {
    const { sourceId } = await seed();
    await startOwner();
    await expect(
      db.sourceFile.create({ data: { sourceId, externalFileId: "late-file", checksum: "c" } }),
    ).rejects.toThrow(/being deleted/);
  });

  it("a new fact_provenance row (memory) is refused while the deletion is pending", async () => {
    await seed();
    await startOwner();
    await expect(
      db.$executeRaw`
        INSERT INTO fact_provenance (id, "orgId", "scopePath", "graphitiFactUuid", "sourceType", "sourceRef", "ownerId", "updatedAt")
        VALUES ('rt-prov-1', ${A}, ${ROOT_A}, 'uuid-1', 'file'::"FactSourceType", 'ref', ${ADMIN_A}, now())`,
    ).rejects.toThrow(/being deleted/);
  });

  it("a new conversation (content) is refused while the deletion is pending", async () => {
    const { contactId } = await seed();
    await startOwner();
    await expect(
      db.$executeRaw`INSERT INTO conversations (id, "orgId", "contactId", "updatedAt") VALUES ('rt-conv-1', ${A}, ${contactId}, now())`,
    ).rejects.toThrow(/being deleted/);
  });

  it("overwriting an existing memory chunk's content is refused while the deletion is pending", async () => {
    await seed();
    await startOwner();
    await expect(
      db.$executeRaw`UPDATE memory_chunks SET content = 'rewritten during deletion' WHERE id = ${`${A}-fact-0`}`,
    ).rejects.toThrow(/being deleted/);
  });

  it("an export blob a run stored (and died before recording) after the cancel is removed by the sweep", async () => {
    await seed();
    const id = await startOwner();
    await svc.cancelOrgDeletion(id, clerk(ADMIN_A), at(1));
    // A produceFinalExport that was mid-upload at the cancel lands its blob, then dies.
    blobs.set(`https://blob.test/exports/${A}/${id}/final-export.jsonl-late`, {
      pathname: `exports/${A}/${id}/final-export.jsonl`,
      body: '{"type":"manifest"}',
      uploadedAt: at(1),
    });
    await run.sweepOrgDeletions(at(2));
    expect([...blobs.values()].filter((b) => b.pathname.startsWith(`exports/${A}/`))).toEqual([]);
  });

  // --- Races.

  it("concurrent owner and Clerk requests open exactly one deletion and none throws", async () => {
    await seed();
    const calls = [
      ...Array.from({ length: 4 }, () =>
        svc.startOrgDeletion(
          { trigger: "owner", orgId: A, requestedBy: ADMIN_A, requesterClerkId: clerk(ADMIN_A) },
          T0,
        ),
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        svc.startOrgDeletion({ trigger: "clerk", orgId: A, clerkEventId: `msg_rt10_${i}`, deletedAt: T0 }, T0),
      ),
      ...Array.from({ length: 3 }, () =>
        svc.startOrgDeletion({ trigger: "clerk", orgId: A, clerkEventId: "msg_rt10_dup", deletedAt: T0 }, T0),
      ),
    ];
    const results = await Promise.allSettled(calls);
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    expect(await db.orgDeletion.count({ where: { orgId: A } })).toBe(1);
    const started = results.filter((r) => r.status === "fulfilled" && r.value?.started);
    expect(started).toHaveLength(1);
    // Whichever won, Clerk's deletion is recorded on it, so no cancel can keep the data.
    const deletion = await db.orgDeletion.findFirstOrThrow({ where: { orgId: A } });
    expect(deletion.clerkEventId).toMatch(/^msg_rt10_/);
    expect(deletion.recipientsFixedAt).not.toBeNull();
  });

  it("cancel and run racing at the boundary: exactly one wins and the state is consistent", async () => {
    for (let i = 0; i < 5; i += 1) {
      await reset();
      await seed();
      const id = await startOwner();
      const [c, r] = await Promise.allSettled([
        svc.cancelOrgDeletion(id, clerk(ADMIN_A), at(7, -1)),
        run.runOrgDeletion(id, at(7)),
      ]);
      const final = await db.orgDeletion.findUniqueOrThrow({ where: { id } });
      const orgLeft = await db.org.count({ where: { id: A } });
      if (c.status === "fulfilled") {
        expect(final.status).toBe("cancelled");
        expect(orgLeft).toBe(1);
        expect(r.status === "fulfilled" && r.value).toBeFalsy();
      } else {
        expect(final.status).toBe("deleted");
        expect(orgLeft).toBe(0);
      }
    }
  });
});
