// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A dead capability token presented to /api/mcp, against a real database.
//
// The claim under test is "every read audited" on the one path where no tool
// ever runs: an agent keeps calling after its token was revoked or expired. The
// token is refused at bearer authentication, before check(), and that refusal
// must still leave exactly one deny row an admin can walk back to the token.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never an inherited
// DATABASE_URL that points at a live database. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// Leaf module, not the `@/services/access` barrel: the barrel builds the
// `@/lib/db` singleton at import time, before beforeAll can point DATABASE_URL
// at the QA database.
import { hashCapabilityToken } from "@/services/access/capabilities";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-mcp-dead-token";
const OTHER_ORG = "org-qa-mcp-dead-token-other";
const SCOPE = "org_1.sales";
const AGENT = "agent-dead-token";

const TOOLS_LIST = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}';
const MEMORY_QUERY =
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"memory_query","arguments":{"query":"anything"}}}';

describe.skipIf(!QA_URL)("a dead capability token on /api/mcp, against a real database", () => {
  let db: PrismaClient;
  let POST: (typeof import("./route"))["POST"];

  const call = (bearer: string, body: string) =>
    POST(
      new Request("https://willder.test/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${bearer}`,
        },
        body,
      }),
    );

  async function mint(orgId: string, expiresAt = new Date(Date.now() + 60 * 60 * 1000)) {
    const raw = `wcap_test_${Math.random().toString(36).slice(2)}`;
    const row = await db.capability.create({
      data: {
        orgId,
        agentId: AGENT,
        tokenHash: hashCapabilityToken(raw),
        scopePath: SCOPE,
        permission: "read",
        expiresAt,
      },
      select: { id: true },
    });
    return { raw, id: row.id };
  }

  const refusedRows = (orgId: string) => db.auditLog.findMany({ where: { orgId, action: "capability.refused" } });

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ POST } = await import("./route"));
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  beforeEach(async () => {
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
      await db.org.upsert({ where: { id: orgId }, update: {}, create: { id: orgId, name: orgId } });
    }
  });

  it("records one deny row per refused call after a revoke, attributed to the token and nowhere else", async () => {
    const token = await mint(ORG);
    const bystander = await mint(OTHER_ORG);
    expect((await call(token.raw, TOOLS_LIST)).status).toBe(200);
    expect(await refusedRows(ORG)).toHaveLength(0);

    await db.capability.update({ where: { id: token.id }, data: { revokedAt: new Date() } });

    expect((await call(token.raw, MEMORY_QUERY)).status).toBe(401);
    const rows = await refusedRows(ORG);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: "agent",
      actorId: AGENT,
      target: SCOPE,
      decision: "deny",
      metadata: { capabilityId: token.id },
    });
    expect(rows[0].reason).toMatch(/^capability revoked:/);

    // A second retry is a second read attempt, so a second row, not zero.
    expect((await call(token.raw, MEMORY_QUERY)).status).toBe(401);
    expect(await refusedRows(ORG)).toHaveLength(2);

    // The other org's live token is untouched, and nothing was written there.
    expect(await db.auditLog.count({ where: { orgId: OTHER_ORG } })).toBe(0);
    expect((await call(bystander.raw, TOOLS_LIST)).status).toBe(200);
  });

  it("names expiry, not revocation, for a token that ran out", async () => {
    const token = await mint(ORG, new Date(Date.now() - 1000));

    expect((await call(token.raw, MEMORY_QUERY)).status).toBe(401);
    const rows = await refusedRows(ORG);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toMatch(/^capability expired:/);
  });

  it("writes nothing for an unknown token, which names no org to record against", async () => {
    // Other realdb files share this database and run in parallel, and some of
    // them refuse revoked tokens too, so a global count races. Every legitimate
    // refusal names the capability it refused; a row for a token that was never
    // minted could not, so that is the row this looks for.
    const since = new Date(Date.now() - 1000); // tolerate app/database clock skew

    expect((await call("wcap_test_never_minted", MEMORY_QUERY)).status).toBe(401);
    const refusedSince = await db.auditLog.findMany({
      where: { action: "capability.refused", at: { gte: since } },
      select: { metadata: true },
    });
    const namesNoCapability = refusedSince.filter(
      (row) => typeof (row.metadata as { capabilityId?: unknown } | null)?.capabilityId !== "string",
    );
    expect(namesNoCapability).toHaveLength(0);
    expect(await db.auditLog.count({ where: { orgId: { in: [ORG, OTHER_ORG] } } })).toBe(0);
  });
});
