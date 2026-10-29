// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Org deletion, end to end on a real database: an owner's request and Clerk's
// `organization.deleted` start the same 7-day deletion, and at day 7 the job clears
// every store. The questions each test answers:
//
// - Does deleting org A change anything else? The whole database is snapshotted with
//   only org B in it, A is seeded, deleted and must leave exactly that snapshot behind.
// - Is a cancel on day 6 a full undo? A's rows, its tokens included, read back as
//   they were before the request.
// - Is day 7 exact? One millisecond before, nothing runs and a cancel still works; at
//   the instant, the job runs and a cancel is refused.
// - Who may ask? A member may not request, cancel, read or download.
// - Does the Clerk webhook start the same deletion, once per event?
// - Does a job that dies part-way finish on the next run, with the same receipt?
// - Is the final export downloadable during the window, and gone after?
//
// Real: Postgres with every migration, check(), the routes, the services. Doubles: the
// signed-in session, Blob storage (an in-memory map behind lib/blob-storage.ts's own
// functions), the graph service (an in-memory count per partition) and Inngest's send.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never the sandbox's inherited
// DATABASE_URL, which points at live Neon.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Webhook } from "svix";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";
import { seedMember } from "@/services/access/member.testsupport";
import { listAsTheApp } from "@/services/memory/erasure-suppression.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

/** Blob storage: pathname and body per URL. */
const blobs = vi.hoisted(() => new Map<string, { pathname: string; body: string; uploadedAt: Date }>());
/** The graph: node count per partition (group id); `failPurge` makes the next purge throw. */
const graph = vi.hoisted(() => ({
  nodes: new Map<string, number>(),
  failPurge: 0,
  failResidueAfterPurge: 0,
  purged: false,
}));
/** The signed-in Clerk user, and the org they have open. */
const session = vi.hoisted(() => ({ clerkId: null as string | null, orgId: null as string | null }));
const queued = vi.hoisted(() => [] as string[]);
/** Runs inside a blob store, after the blob is written: a cancel landing mid-upload. */
const hooks = vi.hoisted(() => ({ onPut: null as null | (() => Promise<unknown>) }));

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
      if (hooks.onPut) await hooks.onPut();
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

/** The partitions of an org as the memory service reads them (`_in_org`). */
function inOrg(orgId: string, group: string): boolean {
  const root = `org_${orgId}`;
  return group === orgId || group === root || group.startsWith(`${root}-`);
}

vi.mock("@/services/memory/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/store")>()),
  graphitiStore: {
    purgeOrg: async (orgId: string) => {
      if (graph.failPurge > 0) {
        graph.failPurge -= 1;
        throw new Error("memory service /orgs/purge unreachable");
      }
      let nodes = 0;
      for (const [group, count] of graph.nodes) {
        if (inOrg(orgId, group)) {
          nodes += count;
          graph.nodes.delete(group);
        }
      }
      graph.purged = true;
      return { nodes, relationships: 0 };
    },
    orgResidue: async (orgId: string) => {
      if (graph.purged && graph.failResidueAfterPurge > 0) {
        graph.failResidueAfterPurge -= 1;
        throw new Error("memory service /orgs/residue unreachable");
      }
      let nodes = 0;
      for (const [group, count] of graph.nodes) if (inOrg(orgId, group)) nodes += count;
      return { nodes, relationships: 0 };
    },
  },
}));

// Day 7 deletes the Clerk organization; what that call does is proven in clerk-events.realdb.test.ts.
vi.mock("@/services/memory/org-deletion/clerk-org", () => ({ deleteClerkOrganization: async () => {} }));
vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({
    userId: session.clerkId,
    orgId: session.orgId ? `clerk_org_${session.orgId}` : null,
    orgRole: "org:admin",
    sessionClaims: { iat: Math.floor(Date.now() / 1000) },
  }),
}));
vi.mock("@/lib/inngest/org-deletion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/inngest/org-deletion")>()),
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

const A = "qadela";
const B = "qadelb";
const ROOT_A = `org_${A}`;
const ROOT_B = `org_${B}`;
const ADMIN_A = "u-del-admin-a";
const ADMIN_A2 = "u-del-admin-a2";
const MEMBER_A = "u-del-member-a";
const ADMIN_B = "u-del-admin-b";
const SHARED = "u-del-shared";
const MEMBER_B = "u-del-member-b";
const PEOPLE = [ADMIN_A, ADMIN_A2, MEMBER_A, ADMIN_B, MEMBER_B, SHARED];
const clerk = (userId: string) => `clerk_${userId}`;

const DAY = 86_400_000;
const T0 = new Date("2026-11-02T10:00:00.000Z");
const at = (days: number, ms = 0) => new Date(T0.getTime() + days * DAY + ms);

const SECRET = `whsec_${Buffer.from("willder-test-signing-key-0123456789").toString("base64")}`;

describe.skipIf(!QA_URL)("org deletion, real Postgres", { timeout: 60_000 }, () => {
  let db: PrismaClient;
  let svc: typeof import("./request");
  let run: typeof import("./run");
  let exp: typeof import("./final-export");
  let access: typeof import("@/services/access");
  let orgRoute: typeof import("@/app/api/org-deletion/route");
  let viewRoute: typeof import("@/app/api/org-deletion/[id]/route");
  let cancelRoute: typeof import("@/app/api/org-deletion/[id]/cancel/route");
  let exportRoute: typeof import("@/app/api/org-deletion/[id]/export/route");
  let webhook: typeof import("@/app/api/webhooks/clerk/route");

  const person = (orgId: string, id: string): AccessContext => ({
    orgId,
    actor: { type: "human", id, role: "admin" },
    origin: "app",
  });
  const agent = (orgId: string, token: string): AccessContext => ({
    orgId,
    actor: { type: "agent", id: "agent-1", capabilityToken: token },
    origin: "mcp",
  });
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const signIn = (userId: string | null, orgId: string | null = null) => {
    session.clerkId = userId ? clerk(userId) : null;
    session.orgId = orgId;
  };

  async function reset() {
    await db.org.deleteMany({ where: { id: { in: [A, B] } } });
    await db.user.deleteMany({ where: { id: { in: PEOPLE } } });
    await db.orgDeletion.deleteMany({ where: { orgId: { in: [A, B] } } });
    blobs.clear();
    graph.nodes.clear();
    graph.failPurge = 0;
    graph.failResidueAfterPurge = 0;
    graph.purged = false;
    queued.length = 0;
    hooks.onPut = null;
  }

  /** Every row of every table but the receipts, as sorted JSON text: the whole database. */
  async function snapshot(): Promise<Record<string, string[]>> {
    const tables = await db.$queryRaw<{ t: string }[]>`
      SELECT table_name::text AS t FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
        AND table_name NOT IN ('_prisma_migrations', 'org_deletions')
      ORDER BY 1`;
    const out: Record<string, string[]> = {};
    for (const { t } of tables) {
      const rows = await db.$queryRawUnsafe<{ r: string }[]>(`SELECT row_to_json(x)::text AS r FROM "${t}" x`);
      out[t] = rows.map((row) => row.r).sort();
    }
    return out;
  }

  /** One org with something in every kind of store: rows in most tables, blobs, graph. */
  async function seedOrg(orgId: string, admin: string, token: string) {
    const root = `org_${orgId}`;
    await db.org.create({ data: { id: orgId, name: `Org ${orgId}`, clerkOrgId: `clerk_org_${orgId}` } });
    const rootScope = await db.scope.create({ data: { orgId, path: root, name: "root" } });
    await db.scope.create({ data: { orgId, path: `${root}.sales`, name: "sales" } });
    await db.grant.create({
      data: { orgId, scopeId: rootScope.id, granteeType: "role", granteeId: "admin", permission: "admin" },
    });
    await seedMember(db, { orgId, userId: admin, role: "admin" });
    const agentRow = await db.agent.create({
      data: { orgId, agentKey: "agent-1", name: "Agent one", role: "handoff" },
    });
    const { hashCapabilityToken } = await import("@/services/access/capabilities");
    await db.capability.create({
      data: {
        orgId,
        agentId: "agent-1",
        tokenHash: hashCapabilityToken(token),
        scopePath: `${root}.sales`,
        permission: "write",
        expiresAt: at(90),
      },
    });
    for (const [i, content] of ["Renewal is in March.", "Deploys freeze on Fridays."].entries()) {
      await db.$executeRaw`
        INSERT INTO memory_chunks (id, "orgId", content, source, "actorType", "actorId", "scopePath", "factVersion", "createdAt")
        VALUES (${`${orgId}-fact-${i}`}, ${orgId}, ${content}, 'text', 'agent', 'agent-1', ${`${root}.sales`}, true, ${at(-10, i)})`;
    }
    await db.factEdge.create({
      data: {
        orgId,
        fromId: `${orgId}-fact-0`,
        toId: `${orgId}-fact-1`,
        kind: "dependsOn",
        scopePath: `${root}.sales`,
        actorType: "agent",
        actorId: "agent-1",
      },
    });
    await db.convention.create({
      data: {
        orgId,
        scopePath: `${root}.sales`,
        kind: "convention",
        subject: "Dedupe",
        text: "Dedupe on email.",
        actorId: admin,
      },
    });
    // An applied write and an applied delete: their audit rows fill scope_change_counts and
    // org_removal_epochs (migration 20261024120000_scope_cache_epoch), which go with the org.
    const { recordAppliedChange } = await import("@/services/access");
    for (const action of ["memory.write", "memory.delete"] as const) {
      await recordAppliedChange({
        orgId,
        actorType: "agent",
        actorId: "agent-1",
        action,
        scopePath: `${root}.sales`,
        tag: `fact:${orgId}-fact-0`,
        origin: "mcp",
      });
    }
    await db.workingNote.create({
      data: {
        orgId,
        scopePath: `${root}.sales`,
        agentId: "agent-1",
        task: "release",
        kind: "claim",
        body: "Cutting it.",
        expiresAt: at(-9),
      },
    });
    const source = await db.source.create({
      data: {
        orgId,
        type: "gdrive",
        externalId: `folder-${orgId}`,
        name: "Folder",
        scopePath: `${root}.sales`,
        encryptedTokens: "ciphertext",
        files: { create: [{ externalFileId: "file-1", checksum: "c1" }] },
      },
    });
    await db.brief.create({
      data: {
        orgId,
        type: "handoff",
        scopePath: `${root}.sales`,
        title: "Handoff",
        summary: "Where it stands.",
        sections: [{ heading: "Renewal", body: "March." }],
        citations: { create: [{ sectionIndex: 0, factId: `${orgId}-fact-0`, factText: "Renewal is in March." }] },
        provenance: { create: { sourceIds: [source.id] } },
      },
    });
    const run = await db.agentRun.create({ data: { orgId, agentId: agentRow.id } });
    await db.agentRunEvent.create({ data: { runId: run.id, seq: 1, type: "step", payload: { ok: true } } });
    await db.changeEvent.create({
      data: {
        orgId,
        seq: BigInt(1),
        scopePath: `${root}.sales`,
        recordType: "fact",
        recordId: `${orgId}-fact-0`,
        op: "create",
        actorId: "agent-1",
        summary: "added",
      },
    });
    await listAsTheApp(db, { data: { orgId, kind: "email", digest: `d-${orgId}`, requestId: "erasure-1" } });
    await db.contact.create({ data: { orgId, name: "Jordan Example" } });
    const upload = `https://blob.test/memory/${orgId}/notes.pdf-seed`;
    blobs.set(upload, { pathname: `memory/${orgId}/notes.pdf`, body: "pdf bytes", uploadedAt: at(-5) });
    blobs.set(`https://blob.test/sources/${orgId}/src/f-seed`, {
      pathname: `sources/${orgId}/src/file-1-a.pdf`,
      body: "drive bytes",
      uploadedAt: at(-5),
    });
    await db.uploadedFile.create({
      data: {
        orgId,
        scopePath: `${root}.sales`,
        filename: "notes.pdf",
        fileType: "pdf",
        blobUrl: upload,
        actorId: admin,
      },
    });
    // A read audited by check(): the org's audit chain has rows.
    await access.check(person(orgId, admin), { action: "memory.read", scope: `${root}.sales`, target: "seed read" });
    graph.nodes.set(orgId, 1);
    graph.nodes.set(root, 3);
    graph.nodes.set(`${root}-sales`, 5);
  }

  /** An owner's request through the route, as `admin` with the org open. */
  async function ownerRequest(orgId: string, admin: string, confirm = `Org ${orgId}`) {
    signIn(admin, orgId);
    vi.setSystemTime(T0);
    const res = await orgRoute.POST(
      new Request("http://localhost/api/org-deletion", { method: "POST", body: JSON.stringify({ confirm }) }),
    );
    vi.useRealTimers();
    return res;
  }

  async function startA() {
    const res = await ownerRequest(A, ADMIN_A);
    expect(res.status).toBe(202);
    return (await res.json()).deletion.id as string;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    svc = await import("./request");
    run = await import("./run");
    exp = await import("./final-export");
    access = await import("@/services/access");
    orgRoute = await import("@/app/api/org-deletion/route");
    viewRoute = await import("@/app/api/org-deletion/[id]/route");
    cancelRoute = await import("@/app/api/org-deletion/[id]/cancel/route");
    exportRoute = await import("@/app/api/org-deletion/[id]/export/route");
    webhook = await import("@/app/api/webhooks/clerk/route");
  });

  beforeEach(async () => {
    vi.useRealTimers();
    await reset();
  });

  afterAll(async () => {
    await reset();
    await db.$disconnect();
  });

  it("deleting A leaves every other row of the database byte-identical and nothing of A", async () => {
    await seedOrg(B, ADMIN_B, "wcap_b_token");
    await seedMember(db, { orgId: B, userId: MEMBER_B, role: "member" });
    const before = await snapshot();
    const blobsBefore = new Map(blobs);
    const graphBefore = new Map(graph.nodes);

    await seedOrg(A, ADMIN_A, "wcap_a_token");
    await seedMember(db, { orgId: A, userId: MEMBER_A, role: "member" });
    const id = await startA();
    await exp.produceFinalExport(id, at(0, 5));
    expect([...blobs.values()].some((b) => b.pathname.startsWith(`exports/${A}/${id}/`))).toBe(true);

    const done = await run.runOrgDeletion(id, at(7));
    expect(done?.status).toBe("deleted");

    expect(await snapshot()).toEqual(before);
    expect(blobs).toEqual(blobsBefore);
    expect(graph.nodes).toEqual(graphBefore);

    const receipt = done!.receipt as unknown as import("./run").DeletionReceipt;
    expect(receipt.org).toEqual({ id: A, name: `Org ${A}` });
    expect(receipt.removed.database).toMatchObject({
      orgs: 1,
      users: 2,
      org_memberships: 2,
      scopes: 2,
      grants: 1,
      capabilities: 1,
      memory_chunks: 2,
      fact_edges: 1,
      conventions: 1,
      working_notes: 1,
      sources: 1,
      source_files: 1,
      briefs: 1,
      brief_citations: 1,
      brief_provenance: 1,
      agent_runs: 1,
      agent_run_events: 1,
      change_events: 1,
      erasure_suppressions: 1,
      contacts: 1,
      uploaded_files: 1,
    });
    expect(receipt.removed.database.audit_log).toBeGreaterThan(0);
    expect(receipt.removed.graph).toEqual({ nodes: 9, relationships: 0 });
    expect(receipt.removed.files.count).toBe(3); // the upload, the Drive file, the final export
    expect(receipt.removed.finalExport).toBe(true);
    expect(receipt.completedAt).toBe(at(7).toISOString());
    expect(receipt.backupsAgeOutBy).toBe(at(7 + 30).toISOString());
    expect(done!.exportUrl).toBeNull();
  });

  it("a cancel on day 6 restores everything: tokens work again, writes are accepted, the export is gone", async () => {
    await seedOrg(A, ADMIN_A, "wcap_a_token");
    await seedOrg(B, ADMIN_B, "wcap_b_token");
    const { hashCapabilityToken } = await import("@/services/access/capabilities");
    const earlier = new Date("2026-10-01T00:00:00.000Z");
    await db.capability.create({
      data: {
        orgId: A,
        agentId: "agent-1",
        tokenHash: hashCapabilityToken("wcap_a_old"),
        scopePath: `${ROOT_A}.sales`,
        permission: "read",
        expiresAt: at(90),
        revokedAt: earlier,
      },
    });
    const writeAllowed = () => access.can(person(A, ADMIN_A), { action: "memory.write", scope: `${ROOT_A}.sales` });
    const agentRead = () => access.can(agent(A, "wcap_a_token"), { action: "memory.read", scope: `${ROOT_A}.sales` });
    expect((await writeAllowed()).allowed).toBe(true);
    expect((await agentRead()).allowed).toBe(true);
    const before = await snapshot();

    const id = await startA();
    // Inside the window: the token is revoked, writes and agents are refused, reads are not.
    const live = await db.capability.findUniqueOrThrow({ where: { tokenHash: hashCapabilityToken("wcap_a_token") } });
    expect(live.revokedAt).toEqual(T0);
    expect((await writeAllowed()).allowed).toBe(false);
    expect((await writeAllowed()).reason).toContain("scheduled for deletion");
    expect((await agentRead()).allowed).toBe(false);
    // A token the revocation missed (one committed alongside the request) is refused too.
    await db.capability.update({ where: { id: live.id }, data: { revokedAt: null } });
    expect(await agentRead()).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("agent tokens are refused"),
    });
    expect((await access.can(person(A, ADMIN_A), { action: "memory.read", scope: `${ROOT_A}.sales` })).allowed).toBe(
      true,
    );
    await expect(
      db.workingNote.create({
        data: {
          orgId: A,
          scopePath: ROOT_A,
          agentId: "agent-1",
          task: "t",
          kind: "claim",
          body: "late",
          expiresAt: at(8),
        },
      }),
    ).rejects.toThrow(/being deleted/);
    // Org B is not refused anything.
    expect((await access.can(person(B, ADMIN_B), { action: "memory.write", scope: ROOT_B })).allowed).toBe(true);
    await exp.produceFinalExport(id, at(0, 5));

    signIn(ADMIN_A);
    vi.setSystemTime(at(6));
    const res = await cancelRoute.POST(new Request("http://localhost", { method: "POST" }), params(id));
    vi.useRealTimers();
    expect(res.status).toBe(200);
    expect((await res.json()).deletion.status).toBe("cancelled");

    expect((await writeAllowed()).allowed).toBe(true);
    expect((await agentRead()).allowed).toBe(true);
    const old = await db.capability.findUniqueOrThrow({ where: { tokenHash: hashCapabilityToken("wcap_a_old") } });
    expect(old.revokedAt).toEqual(earlier);
    expect([...blobs.values()].filter((b) => b.pathname.startsWith(`exports/${A}/`))).toEqual([]);
    signIn(ADMIN_A);
    expect((await exportRoute.GET(new Request("http://localhost"), params(id))).status).toBe(404);

    // Every row reads back as it was; only the audit trail grew.
    const after = await snapshot();
    const withoutAudit = (rows: Record<string, string[]>) =>
      Object.fromEntries(
        Object.entries(rows).filter(([table]) => table !== "audit_log" && table !== "audit_chain_heads"),
      );
    expect(withoutAudit(after)).toEqual(withoutAudit(before));

    // A write lands again, and the job never deletes a cancelled org.
    await db.workingNote.create({
      data: {
        orgId: A,
        scopePath: ROOT_A,
        agentId: "agent-1",
        task: "t",
        kind: "claim",
        body: "back",
        expiresAt: at(8),
      },
    });
    expect(await run.runOrgDeletion(id, at(30))).toBeNull();
    expect(await db.org.count({ where: { id: A } })).toBe(1);
  });

  it("runs at exactly 7 days, not a millisecond before; a cancel works until then and not at it", async () => {
    await seedOrg(A, ADMIN_A, "wcap_a_token");
    const id = await startA();

    expect(await run.runOrgDeletion(id, at(7, -1))).toBeNull();
    const early = await run.sweepOrgDeletions(at(7, -1));
    expect(early.deleted).toEqual([]);
    expect((await db.orgDeletion.findUniqueOrThrow({ where: { id } })).status).toBe("pending");

    await expect(svc.cancelOrgDeletion(id, clerk(ADMIN_A), at(7))).rejects.toThrow(/can no longer be cancelled/);
    const swept = await run.sweepOrgDeletions(at(7));
    expect(swept.deleted).toEqual([id]);
    expect(await db.org.count({ where: { id: A } })).toBe(0);
    // Idempotent: another pass finds nothing to do.
    expect(await run.sweepOrgDeletions(at(8))).toEqual({
      deleted: [],
      failed: [],
      exportsMade: [],
      exportsDiscarded: [],
      lateFilesDeleted: [],
      departuresPruned: 0,
    });

    // A second org, cancelled one millisecond before its day 7.
    await seedOrg(B, ADMIN_B, "wcap_b_token");
    signIn(ADMIN_B, B);
    vi.setSystemTime(T0);
    const res = await orgRoute.POST(
      new Request("http://localhost", { method: "POST", body: JSON.stringify({ confirm: `Org ${B}` }) }),
    );
    vi.useRealTimers();
    const idB = (await res.json()).deletion.id as string;
    expect((await svc.cancelOrgDeletion(idB, clerk(ADMIN_B), at(7, -1))).status).toBe("cancelled");
  });

  it("a member cannot request, cancel, read or download; a wrong confirmation starts nothing", async () => {
    await seedOrg(A, ADMIN_A, "wcap_a_token");
    await seedMember(db, { orgId: A, userId: MEMBER_A, role: "member" });

    expect((await ownerRequest(A, MEMBER_A)).status).toBe(403);
    expect(await db.orgDeletion.count({ where: { orgId: A } })).toBe(0);
    const refused = await db.auditLog.findFirst({
      where: { orgId: A, actorId: MEMBER_A, decision: "deny", target: { contains: "org-deletion:request" } },
    });
    expect(refused).not.toBeNull();

    for (const confirm of [`org ${A}`, ` Org ${A}`, `Org ${A} `, "", `Org ${A}`]) {
      expect((await ownerRequest(A, ADMIN_A, confirm)).status).toBe(400);
    }
    expect(await db.orgDeletion.count({ where: { orgId: A } })).toBe(0);

    const id = await startA();
    await exp.produceFinalExport(id, at(0, 5));
    signIn(MEMBER_A);
    expect((await viewRoute.GET(new Request("http://localhost"), params(id))).status).toBe(404);
    expect((await cancelRoute.POST(new Request("http://localhost", { method: "POST" }), params(id))).status).toBe(404);
    expect((await exportRoute.GET(new Request("http://localhost"), params(id))).status).toBe(404);
    // The same 404 as an id that does not exist.
    expect(await (await viewRoute.GET(new Request("http://localhost"), params("no-such-id"))).json()).toEqual({
      error: "not found",
    });
    expect((await db.orgDeletion.findUniqueOrThrow({ where: { id } })).status).toBe("pending");

    // Another admin of A may see and cancel it, but the export is the requester's.
    await seedMember(db, { orgId: A, userId: ADMIN_A2, role: "admin" });
    signIn(ADMIN_A2);
    expect((await viewRoute.GET(new Request("http://localhost"), params(id))).status).toBe(200);
    expect((await exportRoute.GET(new Request("http://localhost"), params(id))).status).toBe(404);
  });

  it("Clerk's organization.deleted starts the same deletion, once per event, for the admins of the moment", async () => {
    await seedOrg(A, ADMIN_A, "wcap_a_token");
    await seedMember(db, { orgId: A, userId: ADMIN_A2, role: "admin" });
    await seedMember(db, { orgId: A, userId: MEMBER_A, role: "admin" });
    const deletedAt = at(0).getTime();
    // Clerk ended ADMIN_A2's membership as part of the deletion, 10 s before its event;
    // MEMBER_A stopped being an admin's peer two hours earlier.
    await db.orgMembership.update({
      where: { orgId_userId: { orgId: A, userId: ADMIN_A2 } },
      data: { removedAt: new Date(deletedAt - 10_000) },
    });
    await db.orgMembership.update({
      where: { orgId_userId: { orgId: A, userId: MEMBER_A } },
      data: { removedAt: new Date(deletedAt - 2 * 3_600_000) },
    });
    vi.stubEnv("CLERK_WEBHOOK_SECRET", SECRET);
    vi.stubEnv("CLERK_WEBHOOK_SECRET_2", "");
    const body = JSON.stringify({
      type: "organization.deleted",
      timestamp: deletedAt,
      data: { id: `clerk_org_${A}`, deleted: true },
    });
    const deliver = (svixId: string) => {
      const sent = new Date();
      return webhook.POST(
        new Request("http://localhost/api/webhooks/clerk", {
          method: "POST",
          headers: {
            "svix-id": svixId,
            "svix-timestamp": String(Math.floor(sent.getTime() / 1000)),
            "svix-signature": new Webhook(SECRET).sign(svixId, sent, body),
          },
          body,
        }),
      );
    };

    expect((await deliver("msg_org_deleted_1")).status).toBe(200);
    const deletion = await db.orgDeletion.findFirstOrThrow({ where: { orgId: A } });
    expect(deletion.trigger).toBe("clerk");
    expect(deletion.recipientClerkIds).toEqual([clerk(ADMIN_A), clerk(ADMIN_A2)].sort());
    expect(deletion.effectiveAt.getTime() - deletion.requestedAt.getTime()).toBe(7 * DAY);
    expect(deletion.revokedCapabilityIds).toHaveLength(1);
    expect(queued).toEqual([deletion.id]);

    // A redelivery starts nothing, and with the org gone at Clerk there is nothing a
    // cancel could restore: it is refused, and the deletion stays.
    expect((await deliver("msg_org_deleted_1")).status).toBe(200);
    expect(await db.orgDeletion.count({ where: { orgId: A } })).toBe(1);
    await expect(svc.cancelOrgDeletion(deletion.id, clerk(ADMIN_A))).rejects.toThrow(/deleted at the sign-in provider/);
    signIn(ADMIN_A);
    expect(
      (await cancelRoute.POST(new Request("http://localhost", { method: "POST" }), params(deletion.id))).status,
    ).toBe(409);
    expect((await db.orgDeletion.findUniqueOrThrow({ where: { id: deletion.id } })).status).toBe("pending");
    // Its admins of the moment can still download the export, though Clerk ended their memberships.
    await db.orgMembership.updateMany({ where: { orgId: A }, data: { removedAt: new Date(deletedAt) } });
    await exp.produceFinalExport(deletion.id);
    signIn(ADMIN_A2);
    expect((await exportRoute.GET(new Request("http://localhost"), params(deletion.id))).status).toBe(200);
    signIn(MEMBER_A);
    expect((await exportRoute.GET(new Request("http://localhost"), params(deletion.id))).status).toBe(404);

    // An org this database never synced: nothing to delete, still a 200.
    const unknown = JSON.stringify({
      type: "organization.deleted",
      timestamp: deletedAt,
      data: { id: "clerk_org_unknown" },
    });
    const sent = new Date();
    const res = await webhook.POST(
      new Request("http://localhost/api/webhooks/clerk", {
        method: "POST",
        headers: {
          "svix-id": "msg_2",
          "svix-timestamp": String(Math.floor(sent.getTime() / 1000)),
          "svix-signature": new Webhook(SECRET).sign("msg_2", sent, unknown),
        },
        body: unknown,
      }),
    );
    expect(res.status).toBe(200);
    vi.unstubAllEnvs();
  });

  it("an owner request while a Clerk deletion is open joins it instead of starting another", async () => {
    await seedOrg(A, ADMIN_A, "wcap_a_token");
    const started = await svc.startOrgDeletion(
      { trigger: "clerk", orgId: A, clerkEventId: "msg_x", deletedAt: T0 },
      T0,
    );
    const res = await ownerRequest(A, ADMIN_A);
    expect(res.status).toBe(200);
    expect((await res.json()).deletion.id).toBe(started!.deletion.id);
    expect(await db.orgDeletion.count({ where: { orgId: A } })).toBe(1);
  });

  it("Clerk deleting the org during an owner's deletion joins it: its admins can download, and no cancel can keep the data", async () => {
    await seedOrg(A, ADMIN_A, "wcap_a_token");
    await seedMember(db, { orgId: A, userId: ADMIN_A2, role: "admin" });
    const id = await startA();
    const joined = await svc.startOrgDeletion(
      { trigger: "clerk", orgId: A, clerkEventId: "msg_y", deletedAt: at(1) },
      at(1),
    );
    expect(joined).toMatchObject({ started: false, deletion: { id, trigger: "owner", clerkEventId: "msg_y" } });
    expect(joined!.deletion.recipientClerkIds).toEqual([clerk(ADMIN_A), clerk(ADMIN_A2)].sort());
    expect(joined!.deletion.effectiveAt).toEqual(at(7));
    // The same event again changes nothing.
    expect(
      (await svc.startOrgDeletion({ trigger: "clerk", orgId: A, clerkEventId: "msg_y", deletedAt: at(1) }, at(1)))!
        .deletion,
    ).toEqual(joined!.deletion);
    await expect(svc.cancelOrgDeletion(id, clerk(ADMIN_A), at(2))).rejects.toThrow(/deleted at the sign-in provider/);
    expect((await svc.openDeletion(A))?.id).toBe(id);
  });

  it("only a recipient who is still an owner or admin may cancel or download", async () => {
    await seedOrg(A, ADMIN_A, "wcap_a_token");
    await seedMember(db, { orgId: A, userId: ADMIN_A2, role: "admin" });
    const id = await startA();
    await exp.produceFinalExport(id, at(0, 5));
    const cancel = () => cancelRoute.POST(new Request("http://localhost", { method: "POST" }), params(id));
    const download = () => exportRoute.GET(new Request("http://localhost"), params(id));

    // Demoted: may read the deletion, not cancel it or take the export.
    await db.orgMembership.update({ where: { orgId_userId: { orgId: A, userId: ADMIN_A } }, data: { role: "member" } });
    signIn(ADMIN_A);
    expect((await viewRoute.GET(new Request("http://localhost"), params(id))).status).toBe(200);
    expect((await cancel()).status).toBe(403);
    expect(
      await db.auditLog.count({
        where: { orgId: A, actorId: ADMIN_A, decision: "deny", target: `${ROOT_A}/org-deletion:cancel` },
      }),
    ).toBe(1);
    expect((await download()).status).toBe(404);

    // Removed: the same.
    await db.orgMembership.update({
      where: { orgId_userId: { orgId: A, userId: ADMIN_A } },
      data: { role: "admin", removedAt: at(1) },
    });
    expect((await cancel()).status).toBe(403);
    expect((await download()).status).toBe(404);
    expect((await db.orgDeletion.findUniqueOrThrow({ where: { id } })).status).toBe("pending");

    // Another admin may cancel, though the export was never theirs.
    signIn(ADMIN_A2);
    expect((await download()).status).toBe(404);
    expect((await cancel()).status).toBe(200);
  });

  it("resumes after a crash before the rows go, and after one after they went, with the same receipt", async () => {
    await seedOrg(A, ADMIN_A, "wcap_a_token");
    const id = await startA();
    await exp.produceFinalExport(id, at(0, 5));

    // Dies at the graph: the counts are kept, nothing is deleted yet, the export is no
    // longer downloadable because the deletion has started.
    graph.failPurge = 1;
    await expect(run.runOrgDeletion(id, at(7))).rejects.toThrow(/unreachable/);
    let row = await db.orgDeletion.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("deleting");
    expect(row.lastError).toMatch(/unreachable/);
    const counts = (row.progress as { counts: unknown }).counts;
    expect(counts).toMatchObject({ database: { memory_chunks: 2 }, graph: { nodes: 9 } });
    expect(await db.org.count({ where: { id: A } })).toBe(1);
    signIn(ADMIN_A);
    expect((await exportRoute.GET(new Request("http://localhost"), params(id))).status).toBe(404);

    // Dies after the rows are gone, at the final count.
    graph.failResidueAfterPurge = 1;
    await expect(run.runOrgDeletion(id, at(7, 60_000))).rejects.toThrow(/unreachable/);
    row = await db.orgDeletion.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("deleting");
    expect(await db.org.count({ where: { id: A } })).toBe(0);

    const done = await run.runOrgDeletion(id, at(7, 120_000));
    expect(done?.status).toBe("deleted");
    expect(done?.attempts).toBe(3);
    expect((done!.receipt as { removed: unknown }).removed).toEqual(counts);
    expect(done?.lastError).toBeNull();
  });

  it("does not finish while a store still holds something of the org", async () => {
    await seedOrg(A, ADMIN_A, "wcap_a_token");
    const id = await startA();
    // A late graph write the purge did not see: the residue count finds it.
    const purge = vi.fn();
    graph.failPurge = 0;
    const realPurge = (await import("@/services/memory/store")).graphitiStore.purgeOrg;
    const store = (await import("@/services/memory/store")).graphitiStore as unknown as { purgeOrg: typeof realPurge };
    store.purgeOrg = async (orgId: string) => {
      purge();
      const result = await realPurge(orgId);
      if (purge.mock.calls.length === 1) graph.nodes.set(`${ROOT_A}-late`, 1);
      return result;
    };
    try {
      await expect(run.runOrgDeletion(id, at(7))).rejects.toThrow(/still holds graph: 1 nodes/);
      expect((await run.runOrgDeletion(id, at(7, 1)))?.status).toBe("deleted");
    } finally {
      store.purgeOrg = realPurge;
    }
  });

  it("the final export is downloadable by its owner during the window and gone after", async () => {
    await seedOrg(A, ADMIN_A, "wcap_a_token");
    const id = await startA();
    expect(queued).toEqual([id]);
    signIn(ADMIN_A);
    expect((await exportRoute.GET(new Request("http://localhost"), params(id))).status).toBe(404); // not made yet

    await exp.produceFinalExport(id, at(0, 5));
    await exp.produceFinalExport(id, at(0, 6)); // once only
    expect([...blobs.values()].filter((b) => b.pathname.startsWith(`exports/${A}/`))).toHaveLength(1);

    const res = await exportRoute.GET(new Request("http://localhost"), params(id));
    expect(res.status).toBe(200);
    const lines = (await res.text())
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ type: "manifest", coverage: "org" });
    expect(lines.at(-1)).toMatchObject({ type: "end", counts: { fact: 2, convention: 1, working_note: 1, brief: 1 } });
    const view = await (await viewRoute.GET(new Request("http://localhost"), params(id))).json();
    expect(view.deletion.finalExport).toMatchObject({ ready: true, failed: false });
    expect(JSON.stringify(view)).not.toContain("blob.test");

    await run.runOrgDeletion(id, at(7));
    expect((await exportRoute.GET(new Request("http://localhost"), params(id))).status).toBe(404);
    expect([...blobs.values()].filter((b) => b.pathname.startsWith(`exports/${A}/`))).toEqual([]);
    // The receipt stays readable by its owner, with no org left to sign in to.
    const receipt = await (await viewRoute.GET(new Request("http://localhost"), params(id))).json();
    expect(receipt.deletion.status).toBe("deleted");
    expect(receipt.deletion.receipt.removed.finalExport).toBe(true);
  });

  it("an export whose upload a cancel overtakes is deleted by the run that stored it", async () => {
    await seedOrg(A, ADMIN_A, "wcap_a_token");
    const id = await startA();
    hooks.onPut = () => svc.cancelOrgDeletion(id, clerk(ADMIN_A), at(1));
    await exp.produceFinalExport(id, at(0, 5));
    expect([...blobs.values()].filter((b) => b.pathname.startsWith(`exports/${A}/`))).toEqual([]);
    expect(await db.orgDeletion.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: "cancelled",
      exportUrl: null,
    });
  });

  it("a token revoked for another reason during the window stays revoked after a cancel", async () => {
    await seedOrg(A, ADMIN_A, "wcap_a_token");
    const { hashCapabilityToken } = await import("@/services/access/capabilities");
    const id = await startA();
    // Secret scanning finds the token leaked on day 3 and revokes it again.
    await db.capability.updateMany({
      where: { tokenHash: hashCapabilityToken("wcap_a_token") },
      data: { revokedAt: at(3) },
    });
    await svc.cancelOrgDeletion(id, clerk(ADMIN_A), at(4));
    expect(
      (await db.capability.findUniqueOrThrow({ where: { tokenHash: hashCapabilityToken("wcap_a_token") } })).revokedAt,
    ).toEqual(at(3));
  });

  it("a person opening the org during the window still gets in: the tenant sync seeds nothing", async () => {
    await seedOrg(A, ADMIN_A, "wcap_a_token");
    await startA();
    signIn(ADMIN_A, A);
    const { ensureTenant } = await import("@/lib/tenant");
    expect((await ensureTenant())?.id).toBe(A);
    // The built-in agents it would have added are not added while the org is being deleted.
    expect(await db.agent.count({ where: { orgId: A } })).toBe(1);
  });

  it("an export finished after a cancel is not kept", async () => {
    await seedOrg(A, ADMIN_A, "wcap_a_token");
    const id = await startA();
    await svc.cancelOrgDeletion(id, clerk(ADMIN_A), at(1));
    await exp.produceFinalExport(id, at(1, 5));
    expect([...blobs.values()].filter((b) => b.pathname.startsWith(`exports/${A}/`))).toEqual([]);
    expect((await db.orgDeletion.findUniqueOrThrow({ where: { id } })).exportUrl).toBeNull();
  });

  it("moves a person who also belongs to B there, keeping their place in B", async () => {
    await seedOrg(B, ADMIN_B, "wcap_b_token");
    await seedOrg(A, ADMIN_A, "wcap_a_token");
    await seedMember(db, { orgId: A, userId: SHARED, role: "admin" });
    await seedMember(db, { orgId: B, userId: SHARED, role: "member" });
    await db.orgRole.create({ data: { orgId: B, role: "Head of Sales", userId: SHARED, aliases: [] } });
    const inB = async () => ({
      membership: await db.orgMembership.findUnique({ where: { orgId_userId: { orgId: B, userId: SHARED } } }),
      roles: await db.orgRole.findMany({ where: { orgId: B, userId: SHARED } }),
    });
    const before = await inB();
    expect((await db.user.findUniqueOrThrow({ where: { id: SHARED } })).orgId).toBe(A);

    const id = await startA();
    expect((await run.runOrgDeletion(id, at(7)))?.status).toBe("deleted");

    expect(await inB()).toEqual(before);
    const moved = await db.user.findUniqueOrThrow({ where: { id: SHARED } });
    expect(moved).toMatchObject({ orgId: B, role: "member" });
    expect(await db.user.count({ where: { id: ADMIN_A } })).toBe(0);
  });

  it("refuses to delete through a row of another org that references this one", async () => {
    await seedOrg(B, ADMIN_B, "wcap_b_token");
    await seedOrg(A, ADMIN_A, "wcap_a_token");
    // A defect elsewhere left B a grant on one of A's scopes.
    const scopeOfA = await db.scope.findFirstOrThrow({ where: { orgId: A, path: `${ROOT_A}.sales` } });
    const stray = await db.grant.create({
      data: { orgId: B, scopeId: scopeOfA.id, granteeType: "role", granteeId: "member", permission: "read" },
    });

    const id = await startA();
    await expect(run.runOrgDeletion(id, at(7))).rejects.toThrow(/grants in another org reference scopes/);
    expect(await db.org.count({ where: { id: A } })).toBe(1);
    expect(await db.grant.count({ where: { id: stray.id } })).toBe(1);
    expect((await db.orgDeletion.findUniqueOrThrow({ where: { id } })).status).toBe("deleting");
  });

  it("the database refuses writes to each content and access table while a deletion is open", async () => {
    const tables = await db.$queryRaw<{ t: string }[]>`
      SELECT c.relname::text AS t FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
      WHERE g.tgname = 'org_deletion_refuse_write' ORDER BY 1`;
    expect(tables.map((r) => r.t)).toEqual([
      "accounts",
      "agent_run_events",
      "agent_runs",
      "agents",
      "brief_citations",
      "brief_provenance",
      "brief_retirement_waivers",
      "brief_retirements",
      "briefs",
      "capabilities",
      "contact_idempotency_keys",
      "contacts",
      "conventions",
      "conversations",
      "entity_aliases",
      "fact_disputes",
      "fact_edges",
      "fact_provenance",
      "feedback_events",
      "grants",
      "graph_extraction_retries",
      "integrations",
      "memory_chunk_passages",
      "memory_chunks",
      "memory_ingest_keys",
      "messages",
      "oauth_authorization_codes",
      "oauth_connections",
      "oauth_tokens",
      "org_preferences",
      "org_roles",
      "org_workflow_controls",
      "product_feedback",
      "scopes",
      "source_files",
      "sources",
      "uploaded_files",
      "workflow_approvals",
      "workflow_run_steps",
      "workflow_runs",
      "working_notes",
    ]);
    // Every table with an orgId is either refused or written by reads, Clerk or the audit trail.
    // org_removal_epochs and scope_change_counts hold counters only, written by triggers on
    // audit_log, change_events and memory_chunks (a removal must still move them).
    const writable = [
      "agent_cursors",
      "artifact_usage",
      "audit_chain_heads",
      "audit_log",
      "change_events",
      "erasure_reapply_due",
      "erasure_suppressions",
      "erasure_suppressions_applied",
      "fact_version_reads",
      "mcp_client_requests",
      "org_admin_departures",
      "org_deletions",
      "org_memberships",
      "org_removal_epochs",
      "person_erasure_requests",
      "scope_change_counts",
      "session_scope_reads",
      "task_start_deliveries",
      "task_start_item_uses",
      "task_start_served",
      "users",
    ];
    const withOrg = await db.$queryRaw<{ t: string }[]>`
      SELECT c.table_name::text AS t FROM information_schema.columns c
      JOIN information_schema.tables x USING (table_schema, table_name)
      WHERE c.table_schema = current_schema() AND c.column_name = 'orgId' AND x.table_type = 'BASE TABLE' ORDER BY 1`;
    expect(withOrg.map((r) => r.t).filter((t) => !writable.includes(t))).toEqual(
      tables.map((r) => r.t).filter((t) => withOrg.some((w) => w.t === t)),
    );
    // And every table with no orgId of its own that hangs off a refused table is refused too.
    const children = await db.$queryRaw<{ t: string }[]>`
      SELECT DISTINCT child.relname::text AS t FROM pg_constraint con
      JOIN pg_class child ON child.oid = con.conrelid
      WHERE con.contype = 'f' AND child.relnamespace = to_regnamespace(current_schema())
        AND con.confrelid IN (SELECT tgrelid FROM pg_trigger WHERE tgname = 'org_deletion_refuse_write')
        AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = child.oid AND a.attname = 'orgId' AND NOT a.attisdropped)
      ORDER BY 1`;
    expect(children.length).toBeGreaterThan(0);
    expect(children.map((r) => r.t).filter((t) => !tables.some((r) => r.t === t))).toEqual([]);
    await seedOrg(A, ADMIN_A, "wcap_a_token");
    await seedOrg(B, ADMIN_B, "wcap_b_token");
    await startA();
    const { hashCapabilityToken } = await import("@/services/access/capabilities");
    const mint = (orgId: string, token: string) =>
      db.capability.create({
        data: {
          orgId,
          agentId: "agent-1",
          tokenHash: hashCapabilityToken(token),
          scopePath: `org_${orgId}`,
          permission: "read",
          expiresAt: at(30),
          createdBy: "system:cron",
        },
      });
    await expect(mint(A, "wcap_a_new")).rejects.toThrow(/being deleted/);
    await expect(db.scope.create({ data: { orgId: A, path: `${ROOT_A}.new`, name: "new" } })).rejects.toThrow(
      /being deleted/,
    );
    await expect(
      db.$executeRaw`INSERT INTO memory_chunks (id, "orgId", content, source, "actorType", "actorId") VALUES ('late', ${A}, 'late', 'text', 'agent', 'agent-1')`,
    ).rejects.toThrow(/being deleted/);
    // Changes to existing rows, in a table with orgId and in one reached through its parent.
    await expect(db.$executeRaw`UPDATE memory_chunks SET content = 'rewritten' WHERE "orgId" = ${A}`).rejects.toThrow(
      /UPDATE on memory_chunks is refused/,
    );
    const sourceOfA = await db.source.findFirstOrThrow({ where: { orgId: A } });
    await expect(
      db.sourceFile.create({ data: { sourceId: sourceOfA.id, externalFileId: "late", checksum: "c" } }),
    ).rejects.toThrow(/INSERT on source_files is refused/);
    await expect(
      db.sourceFile.updateMany({ where: { sourceId: sourceOfA.id }, data: { checksum: "c2" } }),
    ).rejects.toThrow(/being deleted/);
    // Revoking a token is still possible: capabilities refuse new rows only.
    await db.capability.updateMany({ where: { orgId: A }, data: { revokedAt: at(1) } });
    // Org B is untouched by A's deletion.
    await mint(B, "wcap_b_new");
    await db.scope.create({ data: { orgId: B, path: `${ROOT_B}.new`, name: "new" } });
    await db.$executeRaw`UPDATE memory_chunks SET content = 'rewritten' WHERE "orgId" = ${B}`;
  });
});
