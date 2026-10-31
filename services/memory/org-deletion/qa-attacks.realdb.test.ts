// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// QA attacks on the org deletion, on the same harness as org-deletion.realdb.test.ts:
// real Postgres with every migration, real check(), the routes and the signed Clerk
// webhook; doubles for the session, Blob storage, the graph service and Inngest's send.
// Each test names the claim it attacks.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Webhook } from "svix";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";
import { seedMember } from "@/services/access/member.testsupport";
import { listAsTheApp } from "@/services/memory/erasure-suppression.testsupport";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

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

describe.skipIf(!QA_URL)("org deletion, QA attacks", { timeout: 60_000 }, () => {
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
    await deleteOrgsWithRetry(db, { where: { id: { in: [A, B] } } });
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

  /** Deliver one signed Clerk event, as Svix would: `sentAt` is the delivery attempt's time. */
  async function deliverClerk(svixId: string, payload: unknown, opts: { secret?: string; sentAt?: Date } = {}) {
    vi.stubEnv("CLERK_WEBHOOK_SECRET", SECRET);
    vi.stubEnv("CLERK_WEBHOOK_SECRET_2", "");
    const body = JSON.stringify(payload);
    const sent = opts.sentAt ?? new Date();
    const res = await webhook.POST(
      new Request("http://localhost/api/webhooks/clerk", {
        method: "POST",
        headers: {
          "svix-id": svixId,
          "svix-timestamp": String(Math.floor(sent.getTime() / 1000)),
          "svix-signature": new Webhook(opts.secret ?? SECRET).sign(svixId, sent, body),
        },
        body,
      }),
    );
    vi.unstubAllEnvs();
    return res;
  }
  const orgDeleted = (orgId: string, timestamp = Date.now()) => ({
    type: "organization.deleted",
    timestamp,
    data: { id: `clerk_org_${orgId}`, deleted: true },
  });
  const membershipDeleted = (orgId: string, userId: string, timestamp = Date.now()) => ({
    type: "organizationMembership.deleted",
    timestamp,
    data: {
      id: `orgmem_${orgId}_${userId}`,
      role: "org:admin",
      organization: { id: `clerk_org_${orgId}`, name: `Org ${orgId}` },
      public_user_data: { user_id: clerk(userId), identifier: `${userId}@member.test` },
    },
  });
  const download = (id: string) => exportRoute.GET(new Request("http://localhost"), params(id));

  it("claim: someone who has since stopped being an admin cannot download (requester removed, then Clerk deletes the org)", async () => {
    await seedOrg(A, ADMIN_A, "wcap_a_token");
    await seedMember(db, { orgId: A, userId: ADMIN_A2, role: "admin" });
    // ADMIN_A also belongs to B, so removing them from A keeps their users row.
    await seedOrg(B, ADMIN_B, "wcap_b_token");
    await db.$executeRaw`INSERT INTO org_memberships ("orgId", "userId", role, "assertedAt", "createdAt", "updatedAt")
      VALUES (${B}, ${ADMIN_A}, 'member', TIMESTAMP '1970-01-01', now(), now())`;
    const id = await startA();
    await exp.produceFinalExport(id, at(0, 5));

    // Day 2: ADMIN_A2 removes the requester from A, through Clerk.
    expect((await deliverClerk("msg_rm_1", membershipDeleted(A, ADMIN_A, Date.now() - 60 * 60_000))).status).toBe(200);
    signIn(ADMIN_A);
    expect((await download(id)).status).toBe(404);

    // Day 3: ADMIN_A2 deletes the org at Clerk; the event joins the owner's deletion.
    expect((await deliverClerk("msg_orgdel_1", orgDeleted(A))).status).toBe(200);
    expect((await db.orgDeletion.findUniqueOrThrow({ where: { id } })).clerkEventId).toBe("msg_orgdel_1");
    signIn(ADMIN_A);
    // The removed requester must not regain the whole-org export.
    expect((await download(id)).status).toBe(404);
  });

  it("claim: after a Clerk deletion its admins of the moment can download, through Clerk's own membership events", async () => {
    await seedOrg(A, ADMIN_A, "wcap_a_token"); // ADMIN_A's only org is A
    const deletedAt = Date.now();
    expect((await deliverClerk("msg_orgdel_2", orgDeleted(A, deletedAt))).status).toBe(200);
    const deletion = await db.orgDeletion.findFirstOrThrow({ where: { orgId: A } });
    expect(deletion.recipientClerkIds).toEqual([clerk(ADMIN_A)]);
    await exp.produceFinalExport(deletion.id);

    // Clerk ends the deleted org's memberships, as the deletion code expects it to.
    const removed = await deliverClerk("msg_rm_2", membershipDeleted(A, ADMIN_A, deletedAt + 1_000));
    expect(removed.status).toBe(200);
    signIn(ADMIN_A);
    expect((await download(deletion.id)).status).toBe(200);
  });

  it("claim: Clerk's membership events arriving before organization.deleted still leave the admins as recipients", async () => {
    await seedOrg(A, ADMIN_A, "wcap_a_token");
    const deletedAt = Date.now();
    expect((await deliverClerk("msg_rm_3", membershipDeleted(A, ADMIN_A, deletedAt - 1_000))).status).toBe(200);
    expect((await deliverClerk("msg_orgdel_3", orgDeleted(A, deletedAt))).status).toBe(200);
    const deletion = await db.orgDeletion.findFirstOrThrow({ where: { orgId: A } });
    expect(deletion.recipientClerkIds).toEqual([clerk(ADMIN_A)]);
  });

  it("claim: membership changes stay writable during the window (a person who owns an account leaves)", async () => {
    await seedOrg(A, ADMIN_A, "wcap_a_token");
    await seedMember(db, { orgId: A, userId: MEMBER_A, role: "member" });
    await db.account.create({ data: { orgId: A, name: "Acme", ownerId: MEMBER_A } });
    await startA();
    const res = await deliverClerk("msg_rm_4", membershipDeleted(A, MEMBER_A));
    expect(res.status).toBe(200);
    expect(await db.orgMembership.count({ where: { orgId: A, userId: MEMBER_A, removedAt: null } })).toBe(0);
  });

  it("forged, re-signed and stale Clerk events start nothing; a replay of a real one starts one deletion", async () => {
    await seedOrg(A, ADMIN_A, "wcap_a_token");
    const forged = `whsec_${Buffer.from("not-the-willder-signing-key-000000").toString("base64")}`;
    expect((await deliverClerk("msg_forged", orgDeleted(A), { secret: forged })).status).toBe(401);
    // A real event captured and replayed an hour later, outside Svix's tolerance.
    expect(
      (await deliverClerk("msg_stale", orgDeleted(A), { sentAt: new Date(Date.now() - 60 * 60_000) })).status,
    ).toBe(401);
    // A tampered body under a real signature.
    vi.stubEnv("CLERK_WEBHOOK_SECRET", SECRET);
    vi.stubEnv("CLERK_WEBHOOK_SECRET_2", "");
    const sent = new Date();
    const signedFor = JSON.stringify({ type: "user.updated", data: { id: "u" } });
    const tampered = await webhook.POST(
      new Request("http://localhost/api/webhooks/clerk", {
        method: "POST",
        headers: {
          "svix-id": "msg_t",
          "svix-timestamp": String(Math.floor(sent.getTime() / 1000)),
          "svix-signature": new Webhook(SECRET).sign("msg_t", sent, signedFor),
        },
        body: JSON.stringify(orgDeleted(A)),
      }),
    );
    vi.unstubAllEnvs();
    expect(tampered.status).toBe(401);
    expect(await db.orgDeletion.count({ where: { orgId: A } })).toBe(0);
    expect(await db.capability.count({ where: { orgId: A, revokedAt: null } })).toBe(1);

    // The real one, delivered three times (Svix retries) and once under a new id.
    for (const svixId of ["msg_real", "msg_real", "msg_real", "msg_real_resent"]) {
      expect((await deliverClerk(svixId, orgDeleted(A))).status).toBe(200);
    }
    const all = await db.orgDeletion.findMany({ where: { orgId: A } });
    expect(all).toHaveLength(1);
    expect(all[0].clerkEventId).toBe("msg_real");
  });

  it("an agent token is refused for read and write during the window, even one un-revoked behind the app's back", async () => {
    await seedOrg(A, ADMIN_A, "wcap_a_token");
    await seedOrg(B, ADMIN_B, "wcap_b_token");
    const id = await startA();
    // capabilities stay updatable during a deletion: a stray writer clears revokedAt.
    await db.capability.updateMany({ where: { orgId: A }, data: { revokedAt: null } });
    for (const action of ["memory.read", "memory.write"] as const) {
      const d = await access.check(agent(A, "wcap_a_token"), { action, scope: `${ROOT_A}.sales`, target: "qa" });
      expect(d.allowed).toBe(false);
    }
    // B's agent is untouched.
    expect(
      (await access.check(agent(B, "wcap_b_token"), { action: "memory.read", scope: `${ROOT_B}.sales`, target: "qa" }))
        .allowed,
    ).toBe(true);
    // A human of A may read, not write.
    expect(
      (await access.check(person(A, ADMIN_A), { action: "memory.read", scope: `${ROOT_A}.sales`, target: "qa" }))
        .allowed,
    ).toBe(true);
    expect(
      (await access.check(person(A, ADMIN_A), { action: "memory.write", scope: `${ROOT_A}.sales`, target: "qa" }))
        .allowed,
    ).toBe(false);
    await db.capability.updateMany({ where: { orgId: A }, data: { revokedAt: T0 } });
    await svc.cancelOrgDeletion(id, clerk(ADMIN_A), at(6));
    expect(
      (await access.check(agent(A, "wcap_a_token"), { action: "memory.read", scope: `${ROOT_A}.sales`, target: "qa" }))
        .allowed,
    ).toBe(true);
  });

  it("day 7 to the second: nothing runs at 7 d minus 1 s, the sweep runs at 7 d plus 1 s; cancel by route both sides", async () => {
    await seedOrg(A, ADMIN_A, "wcap_a_token");
    await seedOrg(B, ADMIN_B, "wcap_b_token");
    const id = await startA();
    expect((await run.sweepOrgDeletions(at(7, -1000))).deleted).toEqual([]);
    expect(await db.org.count({ where: { id: A } })).toBe(1);
    signIn(ADMIN_A);
    vi.setSystemTime(at(7, 1000));
    const late = await cancelRoute.POST(new Request("http://localhost", { method: "POST" }), params(id));
    vi.useRealTimers();
    expect(late.status).toBe(409);
    expect((await run.sweepOrgDeletions(at(7, 1000))).deleted).toEqual([id]);
    expect(await db.org.count({ where: { id: A } })).toBe(0);

    signIn(ADMIN_B, B);
    vi.setSystemTime(T0);
    const idB = (
      await (
        await orgRoute.POST(
          new Request("http://localhost", { method: "POST", body: JSON.stringify({ confirm: `Org ${B}` }) }),
        )
      ).json()
    ).deletion.id as string;
    vi.setSystemTime(at(7, -1000));
    const inTime = await cancelRoute.POST(new Request("http://localhost", { method: "POST" }), params(idB));
    vi.useRealTimers();
    expect(inTime.status).toBe(200);
    expect(await db.capability.count({ where: { orgId: B, revokedAt: null } })).toBe(1);
  });

  it("a person homed in B who is an admin of A: deleting A leaves B byte-identical, their row included", async () => {
    await seedOrg(B, ADMIN_B, "wcap_b_token");
    await seedMember(db, { orgId: B, userId: SHARED, role: "member" });
    await db.account.create({ data: { orgId: B, name: "B's account", ownerId: SHARED } });
    const before = await snapshot();
    await seedOrg(A, ADMIN_A, "wcap_a_token");
    // SHARED keeps their row in B; seedMember's user insert does nothing on conflict.
    await seedMember(db, { orgId: A, userId: SHARED, role: "admin" });
    await db.account.create({ data: { orgId: A, name: "A's account", ownerId: SHARED } });
    await db.orgRole.create({ data: { orgId: A, role: "Lead", userId: SHARED, aliases: [] } });
    const id = await startA();
    expect((await run.runOrgDeletion(id, at(7)))?.status).toBe("deleted");
    expect(await snapshot()).toEqual(before);
  });

  it("a cross-org reference through a token (B's OAuth connection on A's capability) stops the job", async () => {
    await seedOrg(B, ADMIN_B, "wcap_b_token");
    await seedOrg(A, ADMIN_A, "wcap_a_token");
    const capA = await db.capability.findFirstOrThrow({ where: { orgId: A } });
    const id = await startA();
    // Planted after the request: oauth_connections is refused for A, not for B.
    await db.oAuthConnection.create({
      data: { orgId: B, userId: ADMIN_B, capabilityId: capA.id, clientId: "qa-client" },
    });
    await expect(run.runOrgDeletion(id, at(7))).rejects.toThrow(
      /oauth_connections in another org reference capabilities/,
    );
    expect(await db.org.count({ where: { id: A } })).toBe(1);
    expect(await db.oAuthConnection.count({ where: { orgId: B } })).toBe(1);
  });

  it("a cross-org reference planted on a fact (B's read of A's version) stops the job instead of cascading", async () => {
    await seedOrg(B, ADMIN_B, "wcap_b_token");
    await seedOrg(A, ADMIN_A, "wcap_a_token");
    const id = await startA();
    const cols = await db.$queryRaw<{ c: string }[]>`
      SELECT column_name::text AS c FROM information_schema.columns WHERE table_name = 'fact_version_reads' AND is_nullable = 'NO' AND column_default IS NULL ORDER BY 1`;
    expect(cols.map((r) => r.c)).toContain("versionId");
    await db.$executeRawUnsafe(
      `INSERT INTO fact_version_reads (${cols.map((r) => `"${r.c}"`).join(", ")}) VALUES (${cols
        .map((r) => (r.c === "orgId" ? `'${B}'` : r.c === "versionId" ? `'${A}-fact-0'` : `'qa-${r.c}'`))
        .join(", ")})`,
    );
    await expect(run.runOrgDeletion(id, at(7))).rejects.toThrow(
      /fact_version_reads in another org reference memory_chunks/,
    );
    expect(await db.org.count({ where: { id: A } })).toBe(1);
    expect(
      await db.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM fact_version_reads WHERE "orgId" = ${B}`,
    ).toEqual([{ n: BigInt(1) }]);
  });

  it("another org's admin cannot see, cancel or download A's deletion; the 404 matches an unknown id", async () => {
    await seedOrg(A, ADMIN_A, "wcap_a_token");
    await seedOrg(B, ADMIN_B, "wcap_b_token");
    const id = await startA();
    await exp.produceFinalExport(id, at(0, 5));
    signIn(ADMIN_B, B);
    const unknown = await (await viewRoute.GET(new Request("http://localhost"), params("nope"))).json();
    expect(await (await viewRoute.GET(new Request("http://localhost"), params(id))).json()).toEqual(unknown);
    expect((await cancelRoute.POST(new Request("http://localhost", { method: "POST" }), params(id))).status).toBe(404);
    expect((await download(id)).status).toBe(404);
    // A removed requester cannot request again, and the receipt stays readable after the org is gone.
    expect((await run.runOrgDeletion(id, at(7)))?.status).toBe("deleted");
    signIn(ADMIN_A);
    const receipt = await viewRoute.GET(new Request("http://localhost"), params(id));
    expect(receipt.status).toBe(200);
    expect((await receipt.json()).deletion.receipt.org.id).toBe(A);
    expect((await download(id)).status).toBe(404);
  });
});
