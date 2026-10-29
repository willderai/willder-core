// @vitest-environment jsdom
//
// Settings is the organization itself: members and invitations (Clerk), org roles and
// entity aliases. Everything that connects to Willder is on Integrations, and the memory
// chat name is on Ask. Who sees what did not change: org roles and aliases mount only for
// an org owner or admin, because their lists are admin-only routes, and a member sees
// neither, nor any card in their place.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import SettingsPage from "./page";

const session = vi.hoisted(() => ({
  orgId: "org_test" as string | null,
  admin: true,
  oauth: true,
  override: null as null | { manageAccess: boolean; writeMemory: boolean; orgAdmin: boolean },
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ orgId: session.orgId }) }));
vi.mock("@clerk/nextjs", () => ({ CreateOrganization: () => <p>create organization</p> }));
vi.mock("@/lib/access-context", () => ({ requireAccessContext: async () => ({ org: { id: "testorg" }, ctx: {} }) }));
vi.mock("@/lib/page-permissions", () => ({
  pagePermissions: async () =>
    session.override ?? { manageAccess: session.admin, writeMemory: session.admin, orgAdmin: session.admin },
}));
vi.mock("@/mcp/oauth-discovery", () => ({ mcpOAuthEnabled: () => session.oauth }));
vi.mock("@/components/settings/org-panel", () => ({ OrgPanel: () => <p>org panel</p> }));
vi.mock("@/components/settings/org-roles-panel", () => ({ OrgRolesPanel: () => <p>org roles panel</p> }));
vi.mock("@/components/settings/aliases-panel", () => ({ AliasesPanel: () => <p>aliases panel</p> }));
// The panels that moved. Settings must not import them; if it did, these would show.
vi.mock("@/components/settings/mcp-panel", () => ({ McpPanel: () => <p>mcp panel</p> }));
vi.mock("@/components/settings/connected-apps-panel", () => ({
  ConnectedAppsPanel: () => <p>connected apps panel</p>,
}));
vi.mock("@/components/settings/memory-chat-panel", () => ({ MemoryChatPanel: () => <p>memory chat panel</p> }));
vi.mock("@/components/settings/sources-panel", () => ({ SourcesPanel: () => <p>sources panel</p> }));
vi.mock("@/components/settings/connectors-panel", () => ({ ConnectorsPanel: () => <p>connectors panel</p> }));
vi.mock("@/components/settings/integrations-panel", () => ({ IntegrationsPanel: () => <p>mailbox panel</p> }));

const MOVED = [
  "mcp panel",
  "connected apps panel",
  "memory chat panel",
  "sources panel",
  "connectors panel",
  "mailbox panel",
  "Connect your AI",
  "Knowledge sources and connectors",
];

afterEach(() => {
  cleanup();
  Object.assign(session, { orgId: "org_test", admin: true, oauth: true, override: null });
});

describe("Settings page", () => {
  it("gives an admin the organization, org roles and aliases, at their own anchors", async () => {
    render(await SettingsPage());
    expect(screen.getByText("org panel")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Org roles" }).id).toBe("org-roles");
    expect(screen.getByRole("region", { name: "Entity aliases" }).id).toBe("aliases");
    expect(screen.getByText("org roles panel")).toBeTruthy();
    expect(screen.getByText("aliases panel")).toBeTruthy();
  });

  it("gives a member the organization only: no org roles or aliases, and nothing standing in for them", async () => {
    session.admin = false;
    render(await SettingsPage());
    expect(screen.getByText("org panel")).toBeTruthy();
    expect(screen.queryByText("org roles panel")).toBeNull();
    expect(screen.queryByText("aliases panel")).toBeNull();
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("decides org roles and aliases on org owner or admin alone, not on access or memory grants", async () => {
    session.override = { manageAccess: true, writeMemory: true, orgAdmin: false };
    render(await SettingsPage());
    expect(screen.queryByText("org roles panel")).toBeNull();
    expect(screen.queryByText("aliases panel")).toBeNull();
    cleanup();

    session.override = { manageAccess: false, writeMemory: false, orgAdmin: true };
    render(await SettingsPage());
    expect(screen.getByText("org roles panel")).toBeTruthy();
    expect(screen.getByText("aliases panel")).toBeTruthy();
  });

  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])("holds none of the panels that moved (admin: %s, MCP OAuth on: %s)", async (admin, oauth) => {
    Object.assign(session, { admin, oauth });
    render(await SettingsPage());
    for (const moved of MOVED) expect(screen.queryByText(moved), moved).toBeNull();
    expect(document.getElementById("connect-ai")).toBeNull();
    expect(document.getElementById("connected-apps")).toBeNull();
    expect(document.getElementById("memory-chat")).toBeNull();
  });

  it("says where the moved panels went, with links that land on them", async () => {
    render(await SettingsPage());
    expect(screen.getByRole("link", { name: "Integrations" }).getAttribute("href")).toBe("/integrations");
    expect(screen.getByRole("link", { name: "Ask" }).getAttribute("href")).toBe("/memory/ask#memory-chat");
  });

  it("offers to create a workspace to a person without one, and mounts no panel", async () => {
    session.orgId = null;
    render(await SettingsPage());
    expect(screen.getByText("create organization")).toBeTruthy();
    expect(screen.queryByText("org panel")).toBeNull();
    expect(screen.queryByText("org roles panel")).toBeNull();
  });
});
