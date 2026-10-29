// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Connecting a source readable by fewer people than its scope. A connect that would let more
// people, or any agent holding a live capability token on the scope, read the
// source through Willder than can read it at the source, or whose
// connector cannot say who reads it, is refused until the person connecting
// acknowledges the exact widening. Every connect records the path it took on the
// source row, and an acknowledgement writes an audit row.
//
// Real: POST /api/sources under the real check(), the scope-reader query, the source
// row and the audit log. Faked: the Clerk session, the sync job, and, for Drive, the
// folder's sharing list (the provider call), set per test.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { SourceReaders } from "@/services/access";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qawiden";
const ROOT = `org_${ORG}`;
const SCOPE = `${ROOT}.team`;
const CONNECTOR = "u-widen-connector";
const SECOND = "u-widen-second";
const ALICE = "u-widen-alice";
const BOB = "u-widen-bob";
const NO_EMAIL = "u-widen-noemail";
const OUTSIDER = "u-widen-outsider";
const EXPIRED = "u-widen-expired";
const email = (id: string) => `${id}@widen.test`;
const FOLDER = "folder-widen-1";
// Agents that can read SCOPE: a live token on the org root, two live tokens on the
// scope itself (one agent, counted once), and a grant-governed agent whose grant is
// still live. Agents that cannot: a revoked token, an expired one, one on a child
// scope only, and a grant-governed agent whose grant is gone.
const AGENT_ROOT = "a-widen-root";
const AGENT_TEAM = "a-widen-team";
const AGENT_GOVERNED = "a-widen-governed";
const AGENT_REVOKED = "a-widen-revoked";
const AGENT_EXPIRED = "a-widen-expired";
const AGENT_CHILD = "a-widen-child";
const AGENT_UNBACKED = "a-widen-unbacked";
const AGENTS_OF_SCOPE = 3;

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: () => false, per: { hour: 3600 } }));
vi.mock("@/lib/inngest", () => ({
  SOURCE_SYNC_EVENT: "source/sync.requested",
  inngest: { send: vi.fn(async () => ({ ids: ["job_widen"] })) },
}));
// Drive's sharing list is a provider call; every other connector runs for real.
vi.mock("@/services/connectors/source-readers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/connectors/source-readers")>();
  return { readersAtSource: vi.fn(actual.readersAtSource) };
});

describe.skipIf(!QA_URL)("connecting a source that widens who reads it, real Postgres", () => {
  let db: PrismaClient;
  let POST: (typeof import("./route"))["POST"];
  let requireAccessContext: ReturnType<typeof vi.fn>;
  let readersAtSource: ReturnType<typeof vi.fn>;
  let inngestSend: ReturnType<typeof vi.fn>;

  async function wipe() {
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.sourceFile.deleteMany({ where: { source: { orgId: ORG } } });
    await db.source.deleteMany({ where: { orgId: ORG } });
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.user.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    delete process.env.GRAPHITI_SERVICE_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ POST } = await import("./route"));
    ({ requireAccessContext } = (await import("@/lib/access-context")) as never);
    ({ readersAtSource } = (await import("@/services/connectors/source-readers")) as never);
    inngestSend = ((await import("@/lib/inngest")) as never as { inngest: { send: ReturnType<typeof vi.fn> } }).inngest
      .send;

    await wipe();
    await db.org.create({ data: { id: ORG, name: "QA widening" } });
    const users: [string, "admin" | "member", string][] = [
      [CONNECTOR, "admin", email(CONNECTOR)],
      [SECOND, "admin", email(SECOND)],
      [ALICE, "admin", email(ALICE)],
      [BOB, "member", email(BOB)],
      // lib/tenant.ts's placeholder for a user Clerk gave no email: names no real account.
      [NO_EMAIL, "member", `${NO_EMAIL}@no-email.local`],
      [OUTSIDER, "admin", email(OUTSIDER)],
      [EXPIRED, "admin", email(EXPIRED)],
    ];
    for (const [id, role, address] of users) {
      // Clerk verified every real address; the placeholder names no account at all.
      const emailVerified = id !== NO_EMAIL;
      await db.user.create({
        data: { id, orgId: ORG, email: address, emailVerified, role, clerkId: `clerk-${id}`, name: id },
      });
    }
    const root = (await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } })).id;
    const team = (await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "team" } })).id;
    for (const id of [CONNECTOR, SECOND]) {
      await db.grant.create({
        data: { orgId: ORG, scopeId: root, granteeType: "user", granteeId: id, permission: "admin" },
      });
    }
    // Readers of SCOPE besides the two admins: Alice by her own grant, Bob and the
    // no-email user through the member role. The outsider has no grant, and the
    // expired grant reads nothing.
    await db.grant.create({
      data: { orgId: ORG, scopeId: team, granteeType: "user", granteeId: ALICE, permission: "read" },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: team, granteeType: "role", granteeId: "member", permission: "read" },
    });
    await db.grant.create({
      data: {
        orgId: ORG,
        scopeId: team,
        granteeType: "user",
        granteeId: EXPIRED,
        permission: "read",
        expiresAt: new Date(Date.now() - 86_400_000),
      },
    });

    const day = 86_400_000;
    const token = (agentId: string, scopePath: string, extra: Record<string, unknown> = {}) =>
      db.capability.create({
        data: {
          orgId: ORG,
          agentId,
          scopePath,
          permission: "read",
          tokenHash: `hash-${agentId}-${scopePath}-${Math.random()}`,
          expiresAt: new Date(Date.now() + day),
          ...extra,
        },
      });
    await token(AGENT_ROOT, ROOT, { permission: "write" });
    await token(AGENT_TEAM, SCOPE);
    await token(AGENT_TEAM, SCOPE);
    await token(AGENT_GOVERNED, SCOPE, { grantGoverned: true });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root, granteeType: "agent", granteeId: AGENT_GOVERNED, permission: "read" },
    });
    await token(AGENT_REVOKED, SCOPE, { revokedAt: new Date() });
    await token(AGENT_EXPIRED, SCOPE, { expiresAt: new Date(Date.now() - day) });
    await token(AGENT_CHILD, `${SCOPE}.child`);
    await token(AGENT_UNBACKED, SCOPE, { grantGoverned: true });
  }, 60_000);

  afterAll(async () => {
    await wipe();
    await db.$disconnect();
  });

  beforeEach(async () => {
    // A gdrive connect seals the client's token into its sync event.
    vi.stubEnv("APP_ENCRYPTION_KEY", "0".repeat(64));
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.source.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG, path: { notIn: [ROOT, SCOPE] } } });
    readersAtSource.mockClear();
    inngestSend.mockClear();
  });

  const as = (userId: string) =>
    requireAccessContext.mockResolvedValue({
      org: { id: ORG },
      user: { id: userId, name: userId },
      ctx: { orgId: ORG, actor: { type: "human", id: userId, role: "admin" } },
    });

  /** The next Drive connect reports this sharing list for the folder. */
  const driveShares = (readers: SourceReaders) => readersAtSource.mockResolvedValueOnce(readers);

  async function connect(userId: string, body: Record<string, unknown>) {
    as(userId);
    const res = await POST(
      new Request("http://t/api/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  const drive = (extra: Record<string, unknown> = {}) => ({
    type: "gdrive",
    folderId: FOLDER,
    folderName: "Team folder",
    token: "drive-token",
    scopePath: SCOPE,
    ...extra,
  });
  const sourceRow = () =>
    db.source.findFirst({
      where: { orgId: ORG, externalId: FOLDER },
      select: {
        connectWideningPath: true,
        connectWideningCount: true,
        connectWideningAgentCount: true,
        connectWideningById: true,
        connectWideningAt: true,
        connectWideningAuditId: true,
        connectAuthorizationId: true,
      },
    });
  const acknowledgements = () =>
    db.auditLog.findMany({ where: { orgId: ORG, action: "source.widening.acknowledged" }, orderBy: { at: "asc" } });

  /** Alice is shared directly; a group stands for Bob; the no-email user's placeholder is listed; so are both admins. */
  const SHARED_WITH_ALICE_AND_A_GROUP: SourceReaders = {
    kind: "known",
    readers: [
      { kind: "email", email: email(ALICE).toUpperCase() },
      { kind: "unmappable" },
      { kind: "email", email: `${NO_EMAIL}@no-email.local` },
      { kind: "email", email: email(CONNECTOR) },
      { kind: "email", email: email(SECOND) },
    ],
  };

  it("refuses a widening above zero without an acknowledgement, and writes nothing", async () => {
    driveShares(SHARED_WITH_ALICE_AND_A_GROUP);
    const res = await connect(CONNECTOR, drive());

    expect(res.status).toBe(409);
    // Bob (behind a group) and the no-email user; not Alice, the admins, the outsider or the expired grant.
    // And the three agents with a live token on the scope.
    expect(res.json.widening).toEqual({ status: "known", people: 2, agents: AGENTS_OF_SCOPE });
    expect(res.json.acknowledge).toEqual({ people: 2, agents: AGENTS_OF_SCOPE });
    expect(String(res.json.error)).toMatch(/2 more people and 3 agents/);
    expect(String(res.json.error)).toContain('acknowledgeWidening: {"people":2,"agents":3}');
    expect(await sourceRow()).toBeNull();
    expect(await acknowledgements()).toHaveLength(0);
    expect(inngestSend).not.toHaveBeenCalled();
  });

  it("an acknowledgement for a different count does not carry over", async () => {
    for (const given of [2, 5, { people: 2 }, { people: 2, agents: 2 }, { people: 1, agents: AGENTS_OF_SCOPE }]) {
      driveShares(SHARED_WITH_ALICE_AND_A_GROUP);
      const res = await connect(CONNECTOR, drive({ acknowledgeWidening: given }));
      expect(res.status, JSON.stringify(given)).toBe(409);
      expect(res.json.acknowledge).toEqual({ people: 2, agents: AGENTS_OF_SCOPE });
    }
    expect(await sourceRow()).toBeNull();
  });

  it("an agent holding a live token on the scope counts as gaining access, a person-only share or not", async () => {
    // Every person who can read the scope is listed at the source: only agents gain.
    const everyPerson: SourceReaders = {
      kind: "known",
      readers: [ALICE, BOB, CONNECTOR, SECOND].map((id) => ({ kind: "email" as const, email: email(id) })),
    };
    const noEmailUser = await db.user.findUniqueOrThrow({ where: { id: NO_EMAIL } });
    await db.user.update({ where: { id: NO_EMAIL }, data: { email: email(NO_EMAIL), emailVerified: true } });
    try {
      driveShares({ kind: "known", readers: [...everyPerson.readers, { kind: "email", email: email(NO_EMAIL) }] });
      const refused = await connect(CONNECTOR, drive());
      expect(refused.status).toBe(409);
      expect(refused.json.widening).toEqual({ status: "known", people: 0, agents: AGENTS_OF_SCOPE });
      expect(String(refused.json.error)).toMatch(/lets 3 agents read/);
      expect(String(refused.json.error)).not.toMatch(/more people/);

      // Revoking one agent's tokens takes it out of the count, and the old figure no longer confirms.
      await db.capability.updateMany({ where: { orgId: ORG, agentId: AGENT_TEAM }, data: { revokedAt: new Date() } });
      driveShares({ kind: "known", readers: [...everyPerson.readers, { kind: "email", email: email(NO_EMAIL) }] });
      const stale = await connect(CONNECTOR, drive({ acknowledgeWidening: { people: 0, agents: AGENTS_OF_SCOPE } }));
      expect(stale.status).toBe(409);
      expect(stale.json.acknowledge).toEqual({ people: 0, agents: AGENTS_OF_SCOPE - 1 });
      expect(await sourceRow()).toBeNull();
    } finally {
      await db.capability.updateMany({ where: { orgId: ORG, agentId: AGENT_TEAM }, data: { revokedAt: null } });
      await db.user.update({
        where: { id: NO_EMAIL },
        data: { email: noEmailUser.email, emailVerified: noEmailUser.emailVerified },
      });
    }
  });

  it("a refused connect that would mint a scope creates no scope", async () => {
    const before = await db.scope.count({ where: { orgId: ORG } });
    const res = await connect(CONNECTOR, { type: "slack", channelId: "C-widen-mint", channelName: "#mint" });
    expect(res.status).toBe(409);
    expect(await db.scope.count({ where: { orgId: ORG } })).toBe(before);
    expect(await db.source.count({ where: { orgId: ORG } })).toBe(0);
  });

  it("an unmappable reader counts as widening, never as a match", async () => {
    // Only the group and the no-email placeholder stand between Bob, the no-email
    // user and the source; both count. Listing Bob by email removes him.
    driveShares(SHARED_WITH_ALICE_AND_A_GROUP);
    expect((await connect(CONNECTOR, drive())).json.widening).toEqual({
      status: "known",
      people: 2,
      agents: AGENTS_OF_SCOPE,
    });
    driveShares({
      kind: "known",
      readers: [...SHARED_WITH_ALICE_AND_A_GROUP.readers, { kind: "email", email: email(BOB) }],
    });
    expect((await connect(CONNECTOR, drive())).json.widening).toEqual({
      status: "known",
      people: 1,
      agents: AGENTS_OF_SCOPE,
    });
  });

  it("an email Clerk has not verified, or not yet reported on, never matches a source reader", async () => {
    // Alice is listed by email at the source. Matching her is safe only while her
    // address is verified; otherwise she counts as gaining access, with Bob and the
    // no-email user.
    try {
      for (const emailVerified of [false, null]) {
        await db.user.update({ where: { id: ALICE }, data: { emailVerified } });
        driveShares(SHARED_WITH_ALICE_AND_A_GROUP);
        const res = await connect(CONNECTOR, drive());
        expect(res.status, `emailVerified ${emailVerified}`).toBe(409);
        expect(res.json.widening, `emailVerified ${emailVerified}`).toMatchObject({ status: "known", people: 3 });
      }
    } finally {
      await db.user.update({ where: { id: ALICE }, data: { emailVerified: true } });
    }
    driveShares(SHARED_WITH_ALICE_AND_A_GROUP);
    expect((await connect(CONNECTOR, drive())).json.widening).toMatchObject({ status: "known", people: 2 });
  });

  it("confirming connects, and records who, when, the counts and the path, with an audit row", async () => {
    driveShares(SHARED_WITH_ALICE_AND_A_GROUP);
    const before = Date.now();
    const res = await connect(CONNECTOR, drive({ acknowledgeWidening: { people: 2, agents: AGENTS_OF_SCOPE } }));
    expect(res.status).toBe(201);

    const row = await sourceRow();
    expect(row).toMatchObject({
      connectWideningPath: "acknowledged",
      connectWideningCount: 2,
      connectWideningAgentCount: AGENTS_OF_SCOPE,
      connectWideningById: CONNECTOR,
    });
    expect(row!.connectWideningAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row!.connectWideningAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    const [audit] = await acknowledgements();
    expect(audit).toMatchObject({
      id: row!.connectWideningAuditId,
      actorId: CONNECTOR,
      decision: "allow",
      target: `${SCOPE}/sources:connect`,
    });
    expect(audit.metadata).toMatchObject({
      type: "gdrive",
      path: "acknowledged",
      people: 2,
      agents: AGENTS_OF_SCOPE,
      connectAuthorizationId: row!.connectAuthorizationId,
    });
    expect(audit.reason).toMatch(/2 more people and 3 agents/);
    expect(inngestSend).toHaveBeenCalledTimes(1);
  });

  it("a connector that cannot report readers is unknown, never zero, and still needs confirming", async () => {
    const slack = { type: "slack", channelId: "C-widen", channelName: "#widen", scopePath: SCOPE };
    const refused = await connect(CONNECTOR, slack);
    expect(refused.status).toBe(409);
    // Unknown people, with the most it can be: everyone but the person connecting.
    // The agents are known exactly, since none reads Slack at the source.
    expect(refused.json.widening).toEqual({ status: "unknown", atMost: 4, agents: AGENTS_OF_SCOPE });
    expect(refused.json.acknowledge).toEqual({ people: "unknown", agents: AGENTS_OF_SCOPE });
    expect((await connect(CONNECTOR, { ...slack, acknowledgeWidening: "unknown" })).status).toBe(409);

    const confirmed = await connect(CONNECTOR, {
      ...slack,
      acknowledgeWidening: { people: "unknown", agents: AGENTS_OF_SCOPE },
    });
    expect(confirmed.status).toBe(201);
    const row = await db.source.findFirstOrThrow({ where: { orgId: ORG, externalId: "C-widen" } });
    expect(row).toMatchObject({
      connectWideningPath: "acknowledged_unknown",
      connectWideningCount: null,
      connectWideningAgentCount: AGENTS_OF_SCOPE,
      connectWideningById: CONNECTOR,
    });
    const [audit] = await acknowledgements();
    expect(audit.id).toBe(row.connectWideningAuditId);
    expect(audit.metadata).toMatchObject({ path: "acknowledged_unknown", people: "unknown", agents: AGENTS_OF_SCOPE });
  });

  it("a source anyone can read widens nothing and connects without confirming", async () => {
    const res = await connect(CONNECTOR, { type: "website", domain: "widen.example", scopePath: SCOPE });
    expect(res.status).toBe(201);
    const row = await db.source.findFirstOrThrow({ where: { orgId: ORG, externalId: "widen.example" } });
    expect(row).toMatchObject({
      connectWideningPath: "no_widening",
      connectWideningCount: 0,
      connectWideningAgentCount: 0,
      connectWideningById: CONNECTOR,
      connectWideningAuditId: null,
    });
    expect(await acknowledgements()).toHaveLength(0);
  });

  it("a reconnect is a fresh decision and re-records", async () => {
    driveShares(SHARED_WITH_ALICE_AND_A_GROUP);
    expect(
      (await connect(CONNECTOR, drive({ acknowledgeWidening: { people: 2, agents: AGENTS_OF_SCOPE } }))).status,
    ).toBe(201);
    const first = await sourceRow();

    // A second admin reconnects after Bob was shared directly. The first admin's own
    // credential no longer reads the source, so they count now; the no-email user still does.
    driveShares({
      kind: "known",
      readers: [
        { kind: "email", email: email(ALICE) },
        { kind: "email", email: email(BOB) },
        { kind: "email", email: email(SECOND) },
      ],
    });
    expect((await connect(SECOND, drive())).json.widening).toEqual({
      status: "known",
      people: 2,
      agents: AGENTS_OF_SCOPE,
    });
    driveShares({
      kind: "known",
      readers: [
        { kind: "email", email: email(ALICE) },
        { kind: "email", email: email(BOB) },
        { kind: "email", email: email(SECOND) },
      ],
    });
    expect((await connect(SECOND, drive({ acknowledgeWidening: { people: 2, agents: AGENTS_OF_SCOPE } }))).status).toBe(
      201,
    );
    const second = await sourceRow();
    expect(second).toMatchObject({
      connectWideningPath: "acknowledged",
      connectWideningCount: 2,
      connectWideningAgentCount: AGENTS_OF_SCOPE,
      connectWideningById: SECOND,
    });
    expect(second!.connectWideningAuditId).not.toBe(first!.connectWideningAuditId);
    expect(second!.connectWideningAt!.getTime()).toBeGreaterThanOrEqual(first!.connectWideningAt!.getTime());

    // Shared with everyone now: the next reconnect needs nothing and records that.
    driveShares({ kind: "known", readers: [{ kind: "everyone" }] });
    expect((await connect(CONNECTOR, drive())).status).toBe(201);
    expect(await sourceRow()).toMatchObject({
      connectWideningPath: "no_widening",
      connectWideningCount: 0,
      connectWideningAgentCount: 0,
      connectWideningById: CONNECTOR,
      connectWideningAuditId: null,
    });
    expect(await acknowledgements()).toHaveLength(2);
  });

  it("the refusal tells the person connecting the count and nothing else", async () => {
    driveShares(SHARED_WITH_ALICE_AND_A_GROUP);
    const res = await connect(CONNECTOR, drive());
    expect(Object.keys(res.json).sort()).toEqual(["acknowledge", "code", "error", "widening"]);
    const text = JSON.stringify(res.json);
    for (const leaked of [
      ALICE,
      BOB,
      NO_EMAIL,
      SECOND,
      OUTSIDER,
      AGENT_ROOT,
      AGENT_TEAM,
      AGENT_GOVERNED,
      "widen.test",
      "no-email.local",
      FOLDER,
      SCOPE,
      "member",
    ]) {
      expect(text, `refusal names ${leaked}`).not.toContain(leaked);
    }
  });

  it("a caller without write on the scope is refused by check() first and learns nothing about widening", async () => {
    driveShares(SHARED_WITH_ALICE_AND_A_GROUP);
    const res = await connect(OUTSIDER, drive());
    expect(res.status).toBe(403);
    expect(res.json).not.toHaveProperty("widening");
    expect(JSON.stringify(res.json)).not.toMatch(/more (people|person)|agents?\b/);
    expect(readersAtSource).not.toHaveBeenCalled();
    readersAtSource.mockReset();
    readersAtSource.mockImplementation(
      (
        await vi.importActual<typeof import("@/services/connectors/source-readers")>(
          "@/services/connectors/source-readers",
        )
      ).readersAtSource,
    );
  });
});
