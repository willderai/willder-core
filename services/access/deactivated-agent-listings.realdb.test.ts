// The places that say which agents can read a scope leave out a deactivated agent.
//
// check() refuses a deactivated agent's tokens. Two listings describe those same
// tokens to people: who can read a scope (scopeAgentReaders, shown when a source is
// connected) and the Tokens search. Before this, both still counted a deactivated
// agent's live token as one that reads, so the listing named an agent that
// enforcement refused. This pins both against a real database, with the token
// stored under the agent's key and, for an older token, under its database id.
//
// Set QA_DATABASE_URL to an isolated test database (never the inherited
// DATABASE_URL); the suite skips without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// Leaf modules, not the `@/services/access` barrel, so `@/lib/db` is built only
// after beforeAll points DATABASE_URL at the QA database.
import { hashCapabilityToken } from "./capabilities";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "deactivatedlistings";
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.sales`;

describe.skipIf(!QA_URL)("listings of who reads a scope, with a deactivated agent", () => {
  let db: PrismaClient;
  let scopeAgentReaders: (typeof import("./source-widening"))["scopeAgentReaders"];
  let searchTokens: (typeof import("@/services/search/access-search"))["searchTokens"];

  async function clearTenant() {
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.agent.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
  }

  /** A live read token on SALES, stored under `agentId`. */
  async function mint(agentId: string) {
    return db.capability.create({
      data: {
        orgId: ORG,
        agentId,
        tokenHash: hashCapabilityToken(`wcap_test_${Math.random().toString(36).slice(2)}`),
        scopePath: SALES,
        permission: "read",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
  }

  const createAgent = (agentKey: string, active: boolean) =>
    db.agent.create({ data: { orgId: ORG, agentKey, name: agentKey, role: "custom", active } });

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ scopeAgentReaders } = await import("./source-widening"));
    ({ searchTokens } = await import("@/services/search/access-search"));
  });

  beforeEach(async () => {
    await clearTenant();
    await db.org.create({ data: { id: ORG, name: ORG } });
  });

  afterAll(async () => {
    await clearTenant();
    await db.$disconnect();
  });

  it("lists an active agent's token as a reader and leaves out a deactivated agent's", async () => {
    await createAgent("still-on", true);
    await createAgent("switched-off", false);
    await mint("still-on");
    await mint("switched-off");

    expect(await scopeAgentReaders(ORG, SALES)).toEqual(["still-on"]);
  });

  it("leaves out a deactivated agent whose older token names it by database id", async () => {
    const agent = await createAgent("switched-off", false);
    await mint(agent.id);

    expect(await scopeAgentReaders(ORG, SALES)).toEqual([]);
  });

  it("still lists a token whose agent has no Agent row, such as an external MCP client", async () => {
    await mint("mcp-client-unregistered");

    expect(await scopeAgentReaders(ORG, SALES)).toEqual(["mcp-client-unregistered"]);
  });

  it("shows a deactivated agent's live token as deactivated in the Tokens search", async () => {
    await createAgent("still-on", true);
    const off = await createAgent("switched-off", false);
    await mint("still-on");
    await mint("switched-off");
    await mint(off.id);

    const { items } = await searchTokens(ORG, "sales", 10);

    const statusByAgent = Object.fromEntries(items.map((t) => [t.agentId, t.status]));
    expect(statusByAgent).toEqual({ "still-on": "active", "switched-off": "deactivated", [off.id]: "deactivated" });
  });

  it("names revocation first when a deactivated agent's token is also revoked", async () => {
    await createAgent("switched-off", false);
    const token = await mint("switched-off");
    await db.capability.update({ where: { id: token.id }, data: { revokedAt: new Date() } });

    const { items } = await searchTokens(ORG, "sales", 10);

    expect(items.map((t) => t.status)).toEqual(["revoked"]);
  });
});
