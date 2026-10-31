// @vitest-environment jsdom
//
// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A visit to the Access, Settings or Integrations page, or a load of the memory chat name
// panel (rendered on its own here; on Ask it sits below the chat), writes a deny row only
// for something the person actually tried. Renders the real server pages and their client panels, and
// answers every request the browser side makes with the shipping route handler on
// real Postgres, so the audit rows counted are the ones a real visit writes. Only
// Clerk (sign-in and its widgets) and the page animation are stubbed.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { MemoryChatPanel } from "@/components/settings/memory-chat-panel";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
if (QA_URL) process.env.DATABASE_URL = QA_URL;

const ORG = "membervisit";
const ROOT = `org_${ORG}`;
const TEAM = `${ROOT}.team`;
const ADMIN = "u-mv-admin";
const MEMBER = "u-mv-member";
const RETIRED_AGENT = "mv-retired-agent";

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

describe.skipIf(!QA_URL)(
  "Access, Settings and Integrations visits audit only what the visitor tried, real Postgres",
  () => {
    let db: PrismaClient;
    let as: (who: "admin" | "member") => void;
    let routes: Record<string, Handler>;
    const requested: string[] = [];
    let pending = 0;

    beforeAll(async () => {
      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
      const { requireAccessContext } = (await import("@/lib/access-context")) as never as {
        requireAccessContext: ReturnType<typeof vi.fn>;
      };
      const { hashCapabilityToken } = await import("@/services/access/capabilities");

      const org = await db.org.create({ data: { id: ORG, name: "member visit" } });
      const admin = await db.user.create({
        data: { id: ADMIN, orgId: ORG, clerkId: `c-${ADMIN}`, email: "a@membervisit.invalid", role: "admin" },
      });
      const member = await db.user.create({
        data: { id: MEMBER, orgId: ORG, clerkId: `c-${MEMBER}`, email: "m@membervisit.invalid", role: "member" },
      });
      const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
      const team = await db.scope.create({ data: { orgId: ORG, path: TEAM, name: "team" } });
      // The tenant's default policy (lib/tenant.ts): owners and admins hold admin on the root.
      await db.grant.create({
        data: { orgId: ORG, scopeId: root.id, granteeType: "role", granteeId: "admin", permission: "admin" },
      });
      // A member who can read and write one team scope, as an admin would grant.
      await db.grant.create({
        data: { orgId: ORG, scopeId: team.id, granteeType: "user", granteeId: MEMBER, permission: "write" },
      });
      // A deactivated agent whose token has neither expired nor been revoked.
      await db.agent.create({
        data: { orgId: ORG, agentKey: RETIRED_AGENT, name: "Retired", role: "qa", active: false },
      });
      await db.capability.create({
        data: {
          orgId: ORG,
          agentId: RETIRED_AGENT,
          tokenHash: hashCapabilityToken("mv-plaintext"),
          scopePath: TEAM,
          permission: "read",
          expiresAt: new Date(Date.now() + 3_600_000),
          createdBy: ADMIN,
        },
      });

      as = (who) =>
        requireAccessContext.mockResolvedValue({
          org,
          user: who === "admin" ? admin : member,
          ctx: { orgId: ORG, actor: { type: "human", id: who === "admin" ? ADMIN : MEMBER, role: who }, origin: "app" },
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
      // Every request the pages make goes to its real route; one this table does not
      // know fails the visit, so a new call cannot slip past the count unseen.
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
        await db.auditLog.deleteMany({ where: { orgId: ORG } });
        await db.capability.deleteMany({ where: { orgId: ORG } });
        await db.agent.deleteMany({ where: { orgId: ORG } });
        await db.grant.deleteMany({ where: { orgId: ORG } });
        await db.scope.deleteMany({ where: { orgId: ORG } });
        await db.user.deleteMany({ where: { orgId: ORG } });
        await db.orgPreference.deleteMany({ where: { orgId: ORG } });
        await deleteOrgsWithRetry(db, { where: { id: ORG } });
        await db.$disconnect();
      }
    });

    /** Render a server page as the browser would receive it and let its requests finish. */
    async function visit(page: () => Promise<ReactElement>, query = "", anchor = ""): Promise<string[]> {
      cleanup();
      requested.length = 0;
      searchParams = new URLSearchParams(query);
      // Integrations shows one tab at a time, chosen by the anchor; only that tab's panel mounts.
      window.history.replaceState(null, "", `/${query ? `?${query}` : ""}${anchor ? `#${anchor}` : ""}`);
      render(await page());
      // Let effects start, then wait until no request is in flight for a moment.
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
      db.auditLog.findMany({
        where: { orgId: ORG, actorId, decision: "deny" },
        select: { action: true, target: true },
      });

    it("a member's visit to Access, on every tab, to Settings and to Integrations writes no deny row", async () => {
      const { default: AccessPage } = await import("./access/page");
      const { default: SettingsPage } = await import("./settings/page");
      const { default: IntegrationsPage } = await import("./integrations/page");
      as("member");

      for (const tab of ["", "tab=scopes", "tab=tokens", "tab=audit"]) await visit(AccessPage, tab);
      expect(screen.getByText(/Only an admin of this organization can see its grants/)).toBeTruthy();
      // Org roles and aliases are admin-only lists; the members list is Clerk's, stubbed here.
      expect(await visit(SettingsPage)).toEqual([]);
      await visit(IntegrationsPage, "", "sources");
      expect(screen.getByText("Knowledge sources and connectors")).toBeTruthy();
      await visit(IntegrationsPage, "", "connect-ai");
      expect(screen.getByRole("heading", { name: "Connect your AI" })).toBeTruthy();
      const integrationsCalls = await visitIntegrationsTabs();
      // The memory chat name, now on Ask: every member may read it.
      const memoryChatCalls = await visit(async () => createElement(MemoryChatPanel));

      expect(integrationsCalls.mailboxes).toContain("/api/integrations"); // the page did load what a member may read
      for (const [anchor, calls] of Object.entries(integrationsCalls)) {
        expect(calls, `#${anchor}`).not.toContain("/api/sources");
        expect(calls, `#${anchor}`).not.toContain("/api/access/capabilities");
      }
      expect(memoryChatCalls).toEqual(["/api/settings/memory-chat"]);
      expect(await denials(MEMBER)).toEqual([]);
    });

    it("an admin's visit still loads every admin list, and writes no deny row", async () => {
      const { default: AccessPage } = await import("./access/page");
      const { default: SettingsPage } = await import("./settings/page");
      as("admin");

      const calls = [
        ...(await visit(AccessPage)),
        ...(await visit(AccessPage, "tab=scopes")),
        ...(await visit(AccessPage, "tab=audit")),
      ];
      const settingsCalls = await visit(SettingsPage);
      const integrationsCalls = await visitIntegrationsTabs();
      for (const list of ["/api/access/grants", "/api/access/scopes", "/api/audit"]) expect(calls).toContain(list);
      for (const list of ["/api/settings/org-roles", "/api/settings/aliases"]) expect(settingsCalls).toContain(list);
      expect(integrationsCalls.sources).toContain("/api/sources");
      expect(integrationsCalls.mailboxes).toContain("/api/integrations");
      // Connect your AI lists the org's tokens, now from Integrations.
      expect(integrationsCalls["connect-ai"]).toContain("/api/access/capabilities");
      expect(await denials(ADMIN)).toEqual([]);
    });

    it("shows a deactivated agent's unexpired, unrevoked token as deactivated, not active", async () => {
      const { default: AccessPage } = await import("./access/page");
      as("admin");

      await visit(AccessPage, "tab=tokens");
      const row = screen.getByText(RETIRED_AGENT).closest("tr")!;
      expect(row.textContent).toContain("agent deactivated");
      expect(row.textContent).not.toMatch(/\bactive\b/);
    });
  },
);
