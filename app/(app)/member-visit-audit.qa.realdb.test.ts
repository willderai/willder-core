// @vitest-environment jsdom
//
// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Beside member-visit-audit.realdb.test.ts, which covers an admin and
// a member who holds write on one team scope. This one covers the cases between and
// beside them:
// - a member with read on the org root, and one with write on the org root: each page
//   loads exactly what that member's grant allows and writes no deny row, so the page
//   probe must be the same permission the route checks, not a nearby one;
// - the Tokens tab's deactivated flag is scoped to the token's own org, and also
//   recognises a token that names its agent by id rather than by key.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
if (QA_URL) process.env.DATABASE_URL = QA_URL;

const ORG = "mvqa";
const OTHER_ORG = "mvqaother";
const ROOT = `org_${ORG}`;
const ADMIN = "u-mvqa-admin";
const READER = "u-mvqa-root-reader";
const WRITER = "u-mvqa-root-writer";
const SHARED_KEY = "mvqa-shared-key";

let searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {} }),
  useSearchParams: () => searchParams,
}));
vi.mock("@/components/reveal", () => ({ Reveal: ({ children }: { children: unknown }) => children }));
vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: "clerk-user", orgId: ORG }) }));
vi.mock("@clerk/nextjs", () => ({ CreateOrganization: () => null }));
vi.mock("@/components/settings/org-panel", () => ({ OrgPanel: () => null }));
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

type Handler = (req: Request) => Promise<Response>;

/** Every tab Integrations can show, by the anchor that opens it (app/(app)/integrations/page.tsx). */
const INTEGRATIONS_ANCHORS = ["sources", "connectors", "mailboxes", "connect-ai", "connected-apps"];
type Who = "admin" | "reader" | "writer";

describe.skipIf(!QA_URL)("Access, Settings and Integrations page probes match their routes, real Postgres", () => {
  let db: PrismaClient;
  let as: (who: Who) => void;
  let routes: Record<string, Handler>;
  let legacyAgentId = "";
  const requested: string[] = [];
  let pending = 0;

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
    const { requireAccessContext } = (await import("@/lib/access-context")) as never as {
      requireAccessContext: ReturnType<typeof vi.fn>;
    };
    const { hashCapabilityToken } = await import("@/services/access/capabilities");

    const org = await db.org.create({ data: { id: ORG, name: "member visit qa" } });
    await db.org.create({ data: { id: OTHER_ORG, name: "member visit qa other" } });
    const users = {
      admin: await db.user.create({
        data: { id: ADMIN, orgId: ORG, clerkId: `c-${ADMIN}`, email: "a@mvqa.invalid", role: "admin" },
      }),
      reader: await db.user.create({
        data: { id: READER, orgId: ORG, clerkId: `c-${READER}`, email: "r@mvqa.invalid", role: "member" },
      }),
      writer: await db.user.create({
        data: { id: WRITER, orgId: ORG, clerkId: `c-${WRITER}`, email: "w@mvqa.invalid", role: "member" },
      }),
    };
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.grant.createMany({
      data: [
        { orgId: ORG, scopeId: root.id, granteeType: "role", granteeId: "admin", permission: "admin" },
        { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: READER, permission: "read" },
        { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: WRITER, permission: "write" },
      ],
    });

    // Same agent key in two orgs: active here, deactivated in the other org.
    await db.agent.create({ data: { orgId: ORG, agentKey: SHARED_KEY, name: "Live", role: "qa", active: true } });
    await db.agent.create({
      data: { orgId: OTHER_ORG, agentKey: SHARED_KEY, name: "Off elsewhere", role: "qa", active: false },
    });
    // A deactivated agent whose token names it by row id, as tokens minted before keys were canonical do.
    const legacy = await db.agent.create({
      data: { orgId: ORG, agentKey: "mvqa-legacy-key", name: "Legacy", role: "qa", active: false },
    });
    legacyAgentId = legacy.id;
    const live = {
      scopePath: ROOT,
      permission: "read" as const,
      expiresAt: new Date(Date.now() + 3_600_000),
      createdBy: ADMIN,
    };
    await db.capability.createMany({
      data: [
        { orgId: ORG, agentId: SHARED_KEY, tokenHash: hashCapabilityToken("mvqa-shared"), ...live },
        { orgId: ORG, agentId: legacy.id, tokenHash: hashCapabilityToken("mvqa-legacy"), ...live },
      ],
    });

    as = (who) =>
      requireAccessContext.mockResolvedValue({
        org,
        user: users[who],
        ctx: { orgId: ORG, actor: { type: "human", id: users[who].id, role: users[who].role }, origin: "app" },
      });

    routes = {
      "/api/access/grants": (await import("@/app/api/access/grants/route")).GET,
      "/api/access/scopes": (await import("@/app/api/access/scopes/route")).GET,
      "/api/access/capabilities": (await import("@/app/api/access/capabilities/route")).GET,
      "/api/audit": (await import("@/app/api/audit/route")).GET,
      "/api/agents": (await import("@/app/api/agents/route")).GET,
      "/api/settings/members": (await import("@/app/api/settings/members/route")).GET,
      "/api/settings/org-roles": (await import("@/app/api/settings/org-roles/route")).GET,
      "/api/settings/aliases": (await import("@/app/api/settings/aliases/route")).GET,
      "/api/settings/memory-chat": (await import("@/app/api/settings/memory-chat/route")).GET,
      "/api/sources": (await import("@/app/api/sources/route")).GET,
      "/api/integrations": (await import("@/app/api/integrations/route")).GET,
      "/api/contacts": (await import("@/app/api/contacts/route")).GET,
      "/api/accounts": (await import("@/app/api/accounts/route")).GET,
    };
    vi.stubGlobal("fetch", async (input: string) => {
      const url = new URL(input, "http://localhost");
      const handler = routes[url.pathname];
      if (!handler) throw new Error(`the page requested ${url.pathname}, which this test does not serve`);
      requested.push(url.pathname);
      pending += 1;
      try {
        return await handler(new Request(url));
      } finally {
        pending -= 1;
      }
    });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (db) {
      const orgs = { in: [ORG, OTHER_ORG] };
      await db.auditLog.deleteMany({ where: { orgId: orgs } });
      await db.capability.deleteMany({ where: { orgId: orgs } });
      await db.agent.deleteMany({ where: { orgId: orgs } });
      await db.grant.deleteMany({ where: { orgId: orgs } });
      await db.scope.deleteMany({ where: { orgId: orgs } });
      await db.user.deleteMany({ where: { orgId: orgs } });
      await db.orgPreference.deleteMany({ where: { orgId: orgs } });
      await db.org.deleteMany({ where: { id: orgs } });
      await db.$disconnect();
    }
  });

  async function visit(page: () => Promise<ReactElement>, query = "", anchor = ""): Promise<string[]> {
    cleanup();
    requested.length = 0;
    searchParams = new URLSearchParams(query);
    // Integrations shows one tab at a time, chosen by the anchor; only that tab's panel mounts.
    window.history.replaceState(null, "", `/${query ? `?${query}` : ""}${anchor ? `#${anchor}` : ""}`);
    render(await page());
    await vi.waitFor(
      async () => {
        expect(pending).toBe(0);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(pending).toBe(0);
      },
      { timeout: 10_000, interval: 100 },
    );
    return [...requested];
  }

  /**
   * Visit Integrations once per tab, by its anchor, since only the open tab's panel
   * loads anything. An anchor the visitor has no tab for opens the first tab.
   */
  async function visitIntegrationsTabs(): Promise<Record<string, string[]>> {
    const { default: IntegrationsPage } = await import("./integrations/page");
    const calls: Record<string, string[]> = {};
    for (const anchor of INTEGRATIONS_ANCHORS) calls[anchor] = await visit(IntegrationsPage, "", anchor);
    return calls;
  }

  const denials = (actorId: string) =>
    db.auditLog.findMany({ where: { orgId: ORG, actorId, decision: "deny" }, select: { action: true, target: true } });

  it("a member with read on the org root: no source, token or admin list is requested, no deny row", async () => {
    const { default: AccessPage } = await import("./access/page");
    const { default: SettingsPage } = await import("./settings/page");
    as("reader");

    const calls = {
      access: await visit(AccessPage),
      "access tokens": await visit(AccessPage, "tab=tokens"),
      "access audit": await visit(AccessPage, "tab=audit"),
      settings: await visit(SettingsPage),
      ...Object.fromEntries(
        Object.entries(await visitIntegrationsTabs()).map(([anchor, tabCalls]) => [
          `integrations #${anchor}`,
          tabCalls,
        ]),
      ),
    };
    for (const [visited, visitCalls] of Object.entries(calls)) {
      for (const list of ["/api/sources", "/api/access/capabilities", "/api/audit", "/api/settings/org-roles"]) {
        expect(visitCalls, visited).not.toContain(list);
      }
    }
    expect(await denials(READER)).toEqual([]);
  });

  it("a member with write on the org root: Integrations loads sources, still no admin list, no deny row", async () => {
    const { default: SettingsPage } = await import("./settings/page");
    as("writer");

    const settingsCalls = await visit(SettingsPage);
    const integrationsCalls = await visitIntegrationsTabs();
    expect(integrationsCalls.sources).toContain("/api/sources");
    for (const [visited, calls] of [["settings", settingsCalls], ...Object.entries(integrationsCalls)] as const) {
      for (const list of ["/api/access/capabilities", "/api/settings/org-roles", "/api/settings/aliases"]) {
        expect(calls, visited).not.toContain(list);
      }
    }
    expect(await denials(WRITER)).toEqual([]);
  });

  it("Integrations asks for connected apps only once MCP_OAUTH_ENABLED is on, and Settings never does", async () => {
    const { default: SettingsPage } = await import("./settings/page");
    const { default: IntegrationsPage } = await import("./integrations/page");
    as("reader");
    routes["/api/access/oauth-connections"] = (await import("@/app/api/access/oauth-connections/route")).GET;

    vi.stubEnv("MCP_OAUTH_ENABLED", "false");
    for (const [anchor, calls] of Object.entries(await visitIntegrationsTabs())) {
      expect(calls, `#${anchor}`).not.toContain("/api/access/oauth-connections");
    }

    vi.stubEnv("MCP_OAUTH_ENABLED", "true");
    expect(await visit(IntegrationsPage, "", "connected-apps")).toContain("/api/access/oauth-connections");
    expect(await visit(SettingsPage)).not.toContain("/api/access/oauth-connections");
    vi.unstubAllEnvs();
    expect(await denials(READER)).toEqual([]);
  });

  it("flags a token deactivated only by its own org's agents, by key or by id", async () => {
    const { GET } = await import("@/app/api/access/capabilities/route");
    as("admin");

    const body = (await (await GET(new Request("http://localhost/api/access/capabilities"))).json()) as {
      capabilities: { agentId: string; agentDeactivated: boolean }[];
    };
    const byAgent = Object.fromEntries(body.capabilities.map((c) => [c.agentId, c.agentDeactivated]));
    expect(byAgent[SHARED_KEY]).toBe(false); // the other org's deactivated namesake does not count
    expect(byAgent[legacyAgentId]).toBe(true); // named by id, still recognised as switched off
  });
});
