// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A capability token's agentId becomes the actor id of every write made with it,
// so neither a token nor an agent grant may be issued under an id the product
// itself writes as: a connector sync, a workflow step, the system, secret
// scanning, the "unknown" stand-in, the org (whose own extraction writes carry its
// id) or a person. Otherwise a scope admin could file an agent's writes under one
// of those authors in change_events and the audit log.
//
// Each reserved id is built with the function that produces it in the product, so
// a change to one of those shapes is tested here without editing this file. Each
// case drives the real POST against Postgres and asserts both the refusal and that
// no capability or grant row exists afterwards.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { SourceType } from "@/lib/generated/prisma/enums";
import {
  BUILT_IN_AGENT_IDS,
  connectorActorId,
  SECRET_SCANNING_ACTOR_ID,
  SYSTEM_ACTOR_ID,
  UNKNOWN_ACTOR_ID,
  workflowActorId,
  workflowCapabilityAgentId,
} from "@/services/access/system-actors";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "org-reserved-actors";
const SCOPE = "org_ra.sales";
const ADMIN = "u-admin-reserved-actors";
const MEMBER = "u-member-reserved-actors";
const SOURCE_ID = "src-reserved-actors";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

const reserved: Array<[label: string, agentId: string]> = [
  ...Object.values(SourceType).map((type): [string, string] => [
    `${type} connector sync`,
    connectorActorId({ id: SOURCE_ID, type }),
  ]),
  ["connector sync, other casing", connectorActorId({ id: SOURCE_ID, type: "GitHub" })],
  ["workflow step", workflowActorId("drafter")],
  ["workflow role capability", workflowCapabilityAgentId("handoff", "reviewer")],
  ["system", SYSTEM_ACTOR_ID],
  ["unknown author", UNKNOWN_ACTOR_ID],
  ["secret scanning", SECRET_SCANNING_ACTOR_ID],
  ["the org's own id", ORG],
  ["the minting admin's user id", ADMIN],
  ["another member's user id", MEMBER],
  // The org has no Agent rows here, so each built-in agent id is free text and
  // would otherwise file writes under that agent.
  ...BUILT_IN_AGENT_IDS.map((id): [string, string] => [`built-in agent ${id} with no Agent row`, id]),
];

describe.skipIf(!QA_URL)("no token or agent grant under an id the product writes as, real Postgres", () => {
  let db: PrismaClient;
  let capabilitiesPOST: (typeof import("./route"))["POST"];
  let grantsPOST: (typeof import("../grants/route"))["POST"];

  async function wipe() {
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.agent.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.user.deleteMany({ where: { orgId: ORG } });
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
  }

  beforeEach(async () => {
    process.env.DATABASE_URL = QA_URL;
    db ??= new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ POST: capabilitiesPOST } = await import("./route"));
    ({ POST: grantsPOST } = await import("../grants/route"));
    const { requireAccessContext } = (await import("@/lib/access-context")) as never as {
      requireAccessContext: ReturnType<typeof vi.fn>;
    };

    await wipe();
    await db.org.create({ data: { id: ORG, name: "reserved actors" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: "a@reserved-actors.test", role: "admin", clerkId: "clerk-ra-admin" },
    });
    await db.user.create({
      data: { id: MEMBER, orgId: ORG, email: "m@reserved-actors.test", role: "member", clerkId: "clerk-ra-member" },
    });
    const scope = await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "sales" } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: scope.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });

    requireAccessContext.mockResolvedValue({
      org: { id: ORG },
      user: { id: ADMIN },
      ctx: { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" } },
    });
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  function post(body: unknown): Request {
    return new Request("http://t", { method: "POST", body: JSON.stringify(body) });
  }

  it.each(reserved)("refuses a token minted as %s and stores nothing", async (_label, agentId) => {
    const res = await capabilitiesPOST(post({ agentId, scopePath: SCOPE, permission: "write" }));

    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toContain("reserved");
    expect(error).toContain("agentKey");
    expect(await db.capability.count({ where: { orgId: ORG } })).toBe(0);
  });

  it.each(reserved)("refuses an agent grant to %s and stores nothing", async (_label, granteeId) => {
    const res = await grantsPOST(post({ scopePath: SCOPE, granteeType: "agent", granteeId, permission: "write" }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("reserved");
    expect(await db.grant.count({ where: { orgId: ORG, granteeType: "agent" } })).toBe(0);
  });

  it("still mints for a free-text client name and for an agent whose display name is a reserved word", async () => {
    await db.agent.create({ data: { orgId: ORG, agentKey: "custom-system", name: SYSTEM_ACTOR_ID, role: "research" } });

    const client = await capabilitiesPOST(post({ agentId: "mcp-client", scopePath: SCOPE, permission: "read" }));
    expect(client.status).toBe(201);
    expect((await client.json()).agentId).toBe("mcp-client");

    // A name resolves to the Agent row's key before any reserved check, so the token
    // is stored under "custom-system", never under "system".
    const named = await capabilitiesPOST(post({ agentId: SYSTEM_ACTOR_ID, scopePath: SCOPE, permission: "read" }));
    expect(named.status).toBe(201);
    expect((await named.json()).agentId).toBe("custom-system");
  });

  it("still mints for a built-in agent the org has an Agent row for", async () => {
    const [agentKey] = BUILT_IN_AGENT_IDS;
    await db.agent.create({ data: { orgId: ORG, agentKey, name: "Built-in agent", role: "qa" } });

    const res = await capabilitiesPOST(post({ agentId: agentKey, scopePath: SCOPE, permission: "read" }));
    expect(res.status).toBe(201);
    expect((await res.json()).agentId).toBe(agentKey);
  });
});
