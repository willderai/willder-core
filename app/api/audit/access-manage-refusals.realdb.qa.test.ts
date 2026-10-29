// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Every access.manage refusal reaches the audit list. check() records a member
// refused at an admin gate as an access.manage deny row whose target names the
// operation (`scopes:create:<path>`, `capabilities:revoke:<id>`, ...). Most of
// those targets are not visibility markers, because their ALLOW rows are
// high-volume admin probes the audit list hides on purpose. A deny row is shown
// whatever its target (services/audit/audit-actions.ts, `denyAlways`), so the
// admin reading GET /api/audit sees each refusal and the page's denied count
// includes it. The allow probes stay hidden.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "amdeny1";
const ROOT = `org_${ORG}`;
const PROBE = `${ROOT}.probe`;
const ADMIN = "u-amdeny-admin";
const MEMBER = "u-amdeny-member";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

type AuditBody = {
  entries: Array<{ action: string; target: string | null; decision: string }>;
  counts: { allowed: number; denied: number };
};

describe.skipIf(!QA_URL)("access.manage refusals are visible in the audit list, real Postgres", () => {
  let db: PrismaClient;
  let as: (who: "admin" | "member") => void;
  let childId: string;
  let capabilityId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    const { requireAccessContext } = (await import("@/lib/access-context")) as never as {
      requireAccessContext: ReturnType<typeof vi.fn>;
    };
    const { hashCapabilityToken } = await import("@/services/access/capabilities");

    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.user.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });

    const org = await db.org.create({ data: { id: ORG, name: "access.manage refusals" } });
    const admin = await db.user.create({
      data: { id: ADMIN, orgId: ORG, clerkId: `c-${ADMIN}`, email: "a@amdeny.invalid", role: "admin" },
    });
    const member = await db.user.create({
      data: { id: MEMBER, orgId: ORG, clerkId: `c-${MEMBER}`, email: "m@amdeny.invalid", role: "member" },
    });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    const probe = await db.scope.create({ data: { orgId: ORG, path: PROBE, name: "probe" } });
    childId = (await db.scope.create({ data: { orgId: ORG, path: `${PROBE}.child`, name: "child" } })).id;
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    // A real grant below admin: a permission-level refusal, not an ungranted one.
    await db.grant.create({
      data: { orgId: ORG, scopeId: probe.id, granteeType: "user", granteeId: MEMBER, permission: "read" },
    });
    capabilityId = (
      await db.capability.create({
        data: {
          orgId: ORG,
          agentId: "amdeny-agent",
          tokenHash: hashCapabilityToken("amdeny-plaintext"),
          scopePath: PROBE,
          permission: "read",
          expiresAt: new Date(Date.now() + 3_600_000),
          createdBy: ADMIN,
        },
      })
    ).id;

    as = (who) =>
      requireAccessContext.mockResolvedValue({
        org,
        user: who === "admin" ? admin : member,
        ctx: { orgId: ORG, actor: { type: "human", id: who === "admin" ? ADMIN : MEMBER, role: who } },
      });
  });

  afterAll(async () => {
    if (db) {
      await db.auditLog.deleteMany({ where: { orgId: ORG } });
      await db.capability.deleteMany({ where: { orgId: ORG } });
      await db.grant.deleteMany({ where: { orgId: ORG } });
      await db.scope.deleteMany({ where: { orgId: ORG } });
      await db.user.deleteMany({ where: { orgId: ORG } });
      await db.org.deleteMany({ where: { id: ORG } });
      await db.$disconnect();
    }
  });

  const json = (method: string, body: unknown) =>
    new Request("http://t/x", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const get = () => new Request("http://t/x");
  const params = <K extends string>(key: K, value: string) => ({
    params: Promise.resolve({ [key]: value } as Record<K, string>),
  });

  async function readAudit(query: string): Promise<AuditBody> {
    as("admin");
    const { GET } = await import("@/app/api/audit/route");
    const res = await GET(new Request(`http://t/api/audit${query}`));
    expect(res.status).toBe(200);
    return (await res.json()) as AuditBody;
  }

  it("a member refused at five admin gates: every refusal is in the list and in the denied count", async () => {
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    as("member");
    const scopes = await import("@/app/api/access/scopes/route");
    const scope = await import("@/app/api/access/scopes/[id]/route");
    const capabilities = await import("@/app/api/access/capabilities/route");
    const capability = await import("@/app/api/access/capabilities/[id]/route");
    const change = await import("@/app/api/audit/timeline/[changeId]/route");
    const statuses = [
      (await scopes.POST(json("POST", { name: "amdeny-new", parentPath: PROBE }))).status,
      (await scope.DELETE(new Request("http://t/x", { method: "DELETE" }), params("id", childId))).status,
      (await capabilities.POST(json("POST", { agentId: "amdeny-mint", scopePath: PROBE, permission: "read" }))).status,
      (await capability.DELETE(new Request("http://t/x", { method: "DELETE" }), params("id", capabilityId))).status,
      (await change.GET(get(), params("changeId", "change-amdeny"))).status,
    ];
    expect(
      statuses.every((s) => s === 403 || s === 404),
      String(statuses),
    ).toBe(true);

    const recorded = await db.auditLog.findMany({
      where: { orgId: ORG, actorId: MEMBER, action: "access.manage", decision: "deny" },
      select: { target: true },
    });
    expect(recorded).toHaveLength(5);

    const listed = await readAudit(`?actorId=${MEMBER}&actorType=human&page=1`);
    const deniedTargets = listed.entries
      .filter((e) => e.action === "access.manage" && e.decision === "deny")
      .map((e) => e.target ?? "");
    for (const marker of [
      "scopes:create:",
      "scopes:delete:",
      "capabilities:issue:",
      "capabilities:revoke:",
      "audit:timeline:change",
    ]) {
      expect(
        deniedTargets.filter((t) => t.includes(marker)),
        marker,
      ).toHaveLength(1);
    }
    expect(listed.counts.denied).toBe(5);

    // The page's unfiltered summary counts them too. The admin's own audit:list
    // allow rows, written by these reads, stay out of the allowed count.
    const page = await readAudit("");
    expect(page.counts.denied).toBe(5);
    expect(page.counts.allowed).toBe(0);
  });

  it("an admin's access.manage allow probes stay hidden", async () => {
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    as("admin");
    const grants = await import("@/app/api/access/grants/route");
    expect((await grants.GET(new Request("http://localhost/api/access/grants"))).status).toBe(200);
    await readAudit("");

    const probes = await db.auditLog.findMany({
      where: { orgId: ORG, actorId: ADMIN, action: "access.manage", decision: "allow" },
      select: { target: true },
    });
    const probeTargets = probes.map((p) => p.target ?? "");
    expect(probeTargets.some((t) => t.endsWith("/grants:list"))).toBe(true);
    expect(probeTargets.some((t) => t.endsWith("/audit:list"))).toBe(true);

    const listed = await readAudit(`?actorId=${ADMIN}&actorType=human&page=1`);
    expect(listed.entries.filter((e) => e.action === "access.manage")).toEqual([]);
    expect(listed.counts).toEqual({ allowed: 0, denied: 0 });
  });

  // What a member calling the Access page's default-tab lists directly writes:
  // grants, scopes, members and agents (GrantsTab in app/(app)/access/access-view.tsx).
  // The page itself no longer calls them for a member (app/(app)/member-visit-audit.realdb.test.ts).
  it("a member calling the Access page's lists directly: its refusals are written and all visible", async () => {
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    as("member");
    const grants = await import("@/app/api/access/grants/route");
    const scopes = await import("@/app/api/access/scopes/route");
    const members = await import("@/app/api/settings/members/route");
    const agents = await import("@/app/api/agents/route");
    await grants.GET(new Request("http://localhost/api/access/grants"));
    await scopes.GET();
    await members.GET(new Request("http://t/api/settings/members"));
    await agents.GET();

    const recorded = await db.auditLog.count({ where: { orgId: ORG, actorId: MEMBER, decision: "deny" } });
    const listed = await readAudit(`?actorId=${MEMBER}&actorType=human&page=1`);
    expect(listed.counts.denied).toBe(recorded);
    expect(recorded).toBe(2);
  });
});
