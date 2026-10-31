// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The minted token passes the real check() gate on a real Postgres, for its own
// org only. Set QA_DATABASE_URL to an ISOLATED test database, never the
// inherited DATABASE_URL. Skips cleanly without it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
const OTHER_ORG = "org-qa-local-dev-token-other";

describe.skipIf(!QA_URL)("mintLocalDevToken against a real database", () => {
  let db: PrismaClient;
  let mintLocalDevToken: (typeof import("./local-dev-token"))["mintLocalDevToken"];
  let LOCAL_DEV_ORG_KEY: string;
  let check: (typeof import("@/services/access"))["check"];
  let resolveCapability: (typeof import("@/services/access"))["resolveCapability"];

  async function clear() {
    const orgs = await db.org.findMany({ where: { OR: [{ clerkOrgId: LOCAL_DEV_ORG_KEY }, { id: OTHER_ORG }] } });
    const ids = orgs.map((o) => o.id);
    await db.capability.deleteMany({ where: { orgId: { in: ids } } });
    await db.scope.deleteMany({ where: { orgId: { in: ids } } });
    await deleteOrgsWithRetry(db, { where: { id: { in: ids } } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ mintLocalDevToken, LOCAL_DEV_ORG_KEY } = await import("./local-dev-token"));
    ({ check, resolveCapability } = await import("@/services/access"));
    await clear();
  });

  afterAll(async () => {
    if (!db) return;
    await clear();
    await db.$disconnect();
  });

  it("mints a token check() allows on its own org root, and reuses the org on a re-run", async () => {
    const first = await mintLocalDevToken(db, { agentId: "local-agent", permission: "write", ttlHours: 1 });
    const second = await mintLocalDevToken(db, { agentId: "local-agent", permission: "read", ttlHours: 1 });

    expect(second.orgId).toBe(first.orgId);
    expect(first.token).not.toBe(second.token);
    // What the MCP server does with WILLDER_CAPABILITY_TOKEN.
    expect(await resolveCapability(first.token, "mcp")).toMatchObject({ orgId: first.orgId, agentId: "local-agent" });
    const actor = { type: "agent" as const, id: "local-agent", capabilityToken: first.token };
    const ctx = { orgId: first.orgId, actor, origin: "mcp" as const };
    expect((await check(ctx, { action: "memory.write", scope: first.scopePath })).allowed).toBe(true);
    expect((await check(ctx, { action: "memory.read", scope: first.scopePath })).allowed).toBe(true);
    // Only the hash is stored.
    expect(await db.capability.count({ where: { tokenHash: first.token } })).toBe(0);
  });

  it("does not open another org, and a read token cannot write", async () => {
    await db.org.create({ data: { id: OTHER_ORG, name: OTHER_ORG } });
    const minted = await mintLocalDevToken(db, { agentId: "local-agent", permission: "read", ttlHours: 1 });
    const actor = { type: "agent" as const, id: "local-agent", capabilityToken: minted.token };

    const other = await check(
      { orgId: OTHER_ORG, actor, origin: "mcp" },
      { action: "memory.read", scope: `org_${OTHER_ORG}` },
    );
    expect(other.allowed).toBe(false);
    const write = await check(
      { orgId: minted.orgId, actor, origin: "mcp" },
      { action: "memory.write", scope: minted.scopePath },
    );
    expect(write.allowed).toBe(false);
  });
});
