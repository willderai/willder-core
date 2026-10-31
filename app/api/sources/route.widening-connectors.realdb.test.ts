// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A Drive folder or GitHub repository readable by fewer people than the scope it
// is connected into is never connected silently, and the source row records which
// path the connect took.
//
// route.widening.realdb.test.ts covers the counting rules with the sharing list
// handed in directly. This file runs the connectors' own reader code instead, so
// what is proven is what a real connect does: the Drive permissions response and
// the GitHub repository response are the only things faked, at the HTTP boundary.
// Real: POST /api/sources, check(), services/connectors/source-readers.ts with
// gdrive.ts and github.ts, the scope-reader query, the source row and the audit log.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qawidenconn";
const ROOT = `org_${ORG}`;
const SCOPE = `${ROOT}.team`;
const CONNECTOR = "u-wconn-connector";
const ALICE = "u-wconn-alice";
const BOB = "u-wconn-bob";
const CAROL = "u-wconn-carol";
const email = (id: string) => `${id}@wconn.test`;
const FOLDER = "folder-wconn-1";
const PRIVATE_REPO = "wconn-org/private-repo";
const PUBLIC_REPO = "wconn-org/public-repo";
const MISSING_REPO = "wconn-org/not-visible";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: () => false, per: { hour: 3600 } }));
vi.mock("@/lib/inngest", () => ({
  SOURCE_SYNC_EVENT: "source/sync.requested",
  inngest: { send: vi.fn(async () => ({ ids: ["job_wconn"] })) },
}));

/** A Drive permissions API page, in the shape `files/{id}/permissions` returns. */
type DrivePermissions = { permissions: Record<string, unknown>[] };

describe.skipIf(!QA_URL)("connecting a narrower Drive folder or GitHub repository, real connector readers", () => {
  let db: PrismaClient;
  let POST: (typeof import("./route"))["POST"];
  let requireAccessContext: ReturnType<typeof vi.fn>;
  /** What the provider answers for the next connect, keyed by URL path. */
  let provider: Record<string, { status: number; body: unknown }>;
  let providerCalls: { url: string; authorization: string | null }[];

  async function wipe() {
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.sourceFile.deleteMany({ where: { source: { orgId: ORG } } });
    await db.source.deleteMany({ where: { orgId: ORG } });
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.user.deleteMany({ where: { orgId: ORG } });
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    // Real Drive API mode: fixture mode reports every folder's readers as unknown.
    vi.stubEnv("GDRIVE_MOCK", "false");
    // GitHub connects seal the repository token onto the source row.
    vi.stubEnv("APP_ENCRYPTION_KEY", "0".repeat(64));
    delete process.env.GRAPHITI_SERVICE_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });

    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const headers = new Headers(init?.headers);
      providerCalls.push({ url: url.href, authorization: headers.get("authorization") });
      const answer = provider[url.pathname];
      if (!answer) throw new Error(`unexpected provider call ${url.href}`);
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      });
    });

    ({ POST } = await import("./route"));
    ({ requireAccessContext } = (await import("@/lib/access-context")) as never);

    await wipe();
    await db.org.create({ data: { id: ORG, name: "QA widening connectors" } });
    for (const [id, role] of [
      [CONNECTOR, "admin"],
      [ALICE, "member"],
      [BOB, "member"],
      [CAROL, "member"],
    ] as const) {
      await db.user.create({
        data: { id, orgId: ORG, email: email(id), emailVerified: true, role, clerkId: `clerk-${id}`, name: id },
      });
    }
    const root = (await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } })).id;
    const team = (await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "team" } })).id;
    await db.grant.create({
      data: { orgId: ORG, scopeId: root, granteeType: "user", granteeId: CONNECTOR, permission: "admin" },
    });
    // Alice, Bob and Carol read the team scope through the member role.
    await db.grant.create({
      data: { orgId: ORG, scopeId: team, granteeType: "role", granteeId: "member", permission: "read" },
    });
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await wipe();
    await db.$disconnect();
  });

  beforeEach(async () => {
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.source.deleteMany({ where: { orgId: ORG } });
    provider = {};
    providerCalls = [];
  });

  async function connect(body: Record<string, unknown>) {
    requireAccessContext.mockResolvedValue({
      org: { id: ORG },
      user: { id: CONNECTOR, name: CONNECTOR },
      ctx: { orgId: ORG, actor: { type: "human", id: CONNECTOR, role: "admin" } },
    });
    const res = await POST(
      new Request("http://t/api/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  const recorded = (externalId: string) =>
    db.source.findFirst({
      where: { orgId: ORG, externalId },
      select: {
        connectWideningPath: true,
        connectWideningCount: true,
        connectWideningAgentCount: true,
        connectWideningById: true,
        connectWideningAt: true,
        connectWideningAuditId: true,
      },
    });
  const acknowledgements = () =>
    db.auditLog.findMany({ where: { orgId: ORG, action: "source.widening.acknowledged" } });

  const drive = (extra: Record<string, unknown> = {}) => ({
    type: "gdrive",
    folderId: FOLDER,
    folderName: "Team folder",
    token: "drive-token",
    scopePath: SCOPE,
    ...extra,
  });
  const drivePermissions = (status: number, body: DrivePermissions | { error: string }) => {
    provider[`/drive/v3/files/${FOLDER}/permissions`] = { status, body };
  };
  const github = (repo: string, extra: Record<string, unknown> = {}) => ({
    type: "github",
    repo,
    token: "github-token",
    scopePath: SCOPE,
    ...extra,
  });
  const githubRepo = (repo: string, status: number, body: unknown) => {
    provider[`/repos/${repo}`] = { status, body };
  };

  describe("Drive", () => {
    // Shared at the source with the person connecting and Alice; a Google group,
    // which no Willder person can be matched to; and a link-only share, which a
    // reader has to be sent. Bob and Carol read the scope and are not shown here.
    const SHARED_WITH_ALICE: DrivePermissions = {
      permissions: [
        { type: "user", emailAddress: email(CONNECTOR) },
        { type: "user", emailAddress: email(ALICE) },
        { type: "group", emailAddress: "team@wconn.test" },
        { type: "anyone", allowFileDiscovery: false },
      ],
    };

    it("a folder shared with fewer people than the scope is refused until the widening is confirmed", async () => {
      drivePermissions(200, SHARED_WITH_ALICE);
      const refused = await connect(drive());

      expect(refused.status).toBe(409);
      expect(refused.json.widening).toEqual({ status: "known", people: 2, agents: 0 });
      expect(await recorded(FOLDER)).toBeNull();
      // The folder's own sharing list was read, with the credential the connect carried.
      expect(providerCalls).toHaveLength(1);
      expect(providerCalls[0].url).toContain(`/drive/v3/files/${FOLDER}/permissions`);
      expect(providerCalls[0].authorization).toBe("Bearer drive-token");
    });

    it("confirming records the acknowledged path, the count, who and when, with an audit row", async () => {
      drivePermissions(200, SHARED_WITH_ALICE);
      const res = await connect(drive({ acknowledgeWidening: { people: 2, agents: 0 } }));
      expect(res.status).toBe(201);

      const row = await recorded(FOLDER);
      expect(row).toMatchObject({
        connectWideningPath: "acknowledged",
        connectWideningCount: 2,
        connectWideningAgentCount: 0,
        connectWideningById: CONNECTOR,
      });
      expect(row!.connectWideningAt).toBeInstanceOf(Date);
      const [audit] = await acknowledgements();
      expect(audit).toMatchObject({ id: row!.connectWideningAuditId, actorId: CONNECTOR });
      expect(audit.metadata).toMatchObject({ type: "gdrive", path: "acknowledged", people: 2, agents: 0 });
    });

    it("a folder every scope reader is shared on connects without confirming, and records no_widening", async () => {
      drivePermissions(200, {
        permissions: [CONNECTOR, ALICE, BOB, CAROL].map((id) => ({ type: "user", emailAddress: email(id) })),
      });
      expect((await connect(drive())).status).toBe(201);
      expect(await recorded(FOLDER)).toMatchObject({
        connectWideningPath: "no_widening",
        connectWideningCount: 0,
        connectWideningAuditId: null,
      });
      expect(await acknowledgements()).toHaveLength(0);
    });

    it("a sharing list Drive will not return is unknown, never empty, and the confirmation is recorded as such", async () => {
      drivePermissions(403, { error: "insufficientFilePermissions" });
      const refused = await connect(drive());
      expect(refused.status).toBe(409);
      expect(refused.json.widening).toEqual({ status: "unknown", atMost: 3, agents: 0 });

      drivePermissions(403, { error: "insufficientFilePermissions" });
      expect((await connect(drive({ acknowledgeWidening: { people: "unknown", agents: 0 } }))).status).toBe(201);
      expect(await recorded(FOLDER)).toMatchObject({
        connectWideningPath: "acknowledged_unknown",
        connectWideningCount: null,
      });
    });
  });

  describe("GitHub", () => {
    it("a private repository is unknown, refused until confirmed, and records acknowledged_unknown", async () => {
      githubRepo(PRIVATE_REPO, 200, { private: true, visibility: "private" });
      const refused = await connect(github(PRIVATE_REPO));
      expect(refused.status).toBe(409);
      expect(refused.json.widening).toEqual({ status: "unknown", atMost: 3, agents: 0 });
      expect(await recorded(PRIVATE_REPO)).toBeNull();
      expect(providerCalls[0].authorization).toBe("Bearer github-token");

      githubRepo(PRIVATE_REPO, 200, { private: true, visibility: "private" });
      expect(
        (await connect(github(PRIVATE_REPO, { acknowledgeWidening: { people: "unknown", agents: 0 } }))).status,
      ).toBe(201);
      const row = await recorded(PRIVATE_REPO);
      expect(row).toMatchObject({
        connectWideningPath: "acknowledged_unknown",
        connectWideningCount: null,
        connectWideningAgentCount: 0,
        connectWideningById: CONNECTOR,
      });
      const [audit] = await acknowledgements();
      expect(audit.id).toBe(row!.connectWideningAuditId);
      expect(audit.metadata).toMatchObject({ type: "github", path: "acknowledged_unknown", people: "unknown" });
    });

    it("an internal repository is not public, so it is treated like a private one", async () => {
      githubRepo(PRIVATE_REPO, 200, { private: false, visibility: "internal" });
      expect((await connect(github(PRIVATE_REPO))).json.widening).toEqual({ status: "unknown", atMost: 3, agents: 0 });
    });

    it("a repository the token cannot see is refused before the widening gate, never connected as no_widening", async () => {
      githubRepo(MISSING_REPO, 404, { message: "Not Found" });
      const refused = await connect(github(MISSING_REPO));
      expect(refused.status).toBe(400);
      expect(refused.json).toMatchObject({ code: "source_unreadable" });
      expect(await recorded(MISSING_REPO)).toBeNull();
    });

    it("a public repository widens nothing, connects without confirming, and records no_widening", async () => {
      githubRepo(PUBLIC_REPO, 200, { private: false, visibility: "public" });
      expect((await connect(github(PUBLIC_REPO))).status).toBe(201);
      expect(await recorded(PUBLIC_REPO)).toMatchObject({
        connectWideningPath: "no_widening",
        connectWideningCount: 0,
        connectWideningAgentCount: 0,
        connectWideningById: CONNECTOR,
        connectWideningAuditId: null,
      });
      expect(await acknowledgements()).toHaveLength(0);
    });
  });
});
