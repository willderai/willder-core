// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The source an audit row names (`metadata.origin`, NIST AU-3) is the entry point the
// request really came in through, set where the request is authenticated. The AU-3
// export test passes an origin into check() by hand, so it cannot see an entry point
// that labels itself wrongly; this one goes through the real routes and reads the rows
// they leave. The same agent and the same token reach the REST change feed and the MCP
// endpoint, so only the route can tell the two rows apart.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// Leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the QA database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-audit-origin";
const ROOT = "org_qa_audit_origin";
const AGENT = "agent-qa-audit-origin";
const HOUR = 60 * 60 * 1000;

describe.skipIf(!QA_URL)("each entry point records itself as the audit row's origin, real Postgres", () => {
  let db: PrismaClient;
  let mcpPost: (typeof import("./mcp/route"))["POST"];
  let changesGet: (typeof import("./changes/route"))["GET"];

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  async function mint(expiresAt: Date) {
    const raw = `wcap_qa_origin_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: AGENT,
        tokenHash: hashCapabilityToken(raw),
        scopePath: ROOT,
        permission: "read",
        expiresAt,
      },
    });
    return raw;
  }

  const origins = async (where: { action?: string; decision?: "allow" | "deny" }) =>
    (await db.auditLog.findMany({ where: { orgId: ORG, ...where }, orderBy: { at: "asc" } })).map(
      (row) => (row.metadata as { origin?: unknown } | null)?.origin,
    );

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ POST: mcpPost } = await import("./mcp/route"));
    ({ GET: changesGet } = await import("./changes/route"));
  });

  beforeEach(async () => {
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
  });

  afterAll(async () => {
    if (!db) return;
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.$disconnect();
  });

  it("a read through the REST change feed is recorded as api", async () => {
    const token = await mint(new Date(Date.now() + HOUR));
    const res = await changesGet(new Request("https://willder.test/api/changes", { headers: bearer(token) }));
    expect(res.status).toBe(200);

    const recorded = await origins({ decision: "allow" });
    expect(recorded.length).toBeGreaterThan(0);
    expect(new Set(recorded)).toEqual(new Set(["api"]));
  });

  it("an expired token refused at the REST change feed is recorded as api", async () => {
    const token = await mint(new Date(Date.now() - HOUR));
    const res = await changesGet(new Request("https://willder.test/api/changes", { headers: bearer(token) }));
    expect(res.status).toBe(401);

    expect(await origins({ action: "capability.refused" })).toEqual(["api"]);
  });

  it("the same expired token refused at the MCP endpoint is recorded as mcp", async () => {
    const token = await mint(new Date(Date.now() - HOUR));
    const res = await mcpPost(
      new Request("https://willder.test/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...bearer(token),
        },
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
      }),
    );
    expect(res.status).toBe(401);

    expect(await origins({ action: "capability.refused" })).toEqual(["mcp"]);
  });
});
