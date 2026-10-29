// @vitest-environment jsdom
//
// Integrations holds everything that connects to Willder, one tab each: knowledge
// sources, connectors, mailboxes, Connect your AI and Connected apps. Who sees what did
// not change when the page became tabs, and each gate is its own:
// - memory.write on the org root mounts the source panels; anyone else gets "ask an admin";
// - access.manage on the org root mounts Connect your AI; anyone else gets "ask an admin";
// - mailboxes mount for every member;
// - Connectors has a tab only while connectors are switched on;
// - Connected apps has a tab once MCP_OAUTH_ENABLED is on, and never before.
// Only the open tab's panel mounts, and each tab opens on the anchor its panel had on Settings.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import IntegrationsPage from "./page";

const session = vi.hoisted(() => ({
  orgId: "org_test" as string | null,
  manageAccess: true,
  writeMemory: true,
  orgAdmin: true,
  oauth: false,
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ orgId: session.orgId }) }));
vi.mock("@/lib/access-context", () => ({ requireAccessContext: async () => ({ org: { id: "testorg" }, ctx: {} }) }));
vi.mock("@/lib/page-permissions", () => ({
  pagePermissions: async () => ({
    manageAccess: session.manageAccess,
    writeMemory: session.writeMemory,
    orgAdmin: session.orgAdmin,
  }),
}));
vi.mock("@/mcp/oauth-discovery", () => ({ mcpOAuthEnabled: () => session.oauth }));
vi.mock("@/components/settings/integrations-panel", () => ({ IntegrationsPanel: () => <p>mailbox panel</p> }));
vi.mock("@/components/settings/sources-panel", () => ({ SourcesPanel: () => <p>sources panel</p> }));
vi.mock("@/components/settings/connectors-panel", () => ({ ConnectorsPanel: () => <p>connectors panel</p> }));
vi.mock("@/components/settings/mcp-panel", () => ({ McpPanel: () => <p>mcp panel</p> }));
vi.mock("@/components/settings/connected-apps-panel", () => ({
  ConnectedAppsPanel: () => <p>connected apps panel</p>,
}));

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_CONNECTORS_ENABLED", "true");
  window.history.replaceState(null, "", "/integrations");
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  Object.assign(session, { orgId: "org_test", manageAccess: true, writeMemory: true, orgAdmin: true, oauth: false });
});

function as(role: "admin" | "member" | "root writer" | "access manager only") {
  Object.assign(
    session,
    {
      admin: { manageAccess: true, writeMemory: true, orgAdmin: true },
      member: { manageAccess: false, writeMemory: false, orgAdmin: false },
      "root writer": { manageAccess: false, writeMemory: true, orgAdmin: false },
      "access manager only": { manageAccess: true, writeMemory: false, orgAdmin: false },
    }[role],
  );
}

/** The tab labels, in order. */
function tabLabels(): string[] {
  return within(screen.getByRole("tablist", { name: "Integrations" }))
    .getAllByRole("tab")
    .map((tab) => tab.textContent ?? "");
}

/** Opens the page at `hash` and returns the open tab's panel. */
async function openAt(hash: string) {
  window.history.replaceState(null, "", `/integrations${hash}`);
  render(await IntegrationsPage());
  return screen.getByRole("tabpanel");
}

function openTab(label: string) {
  act(() => fireEvent.click(screen.getByRole("tab", { name: label })));
  return screen.getByRole("tabpanel");
}

const PANELS = ["sources panel", "connectors panel", "mailbox panel", "mcp panel", "connected apps panel"];

/** The one panel that is mounted: no other panel's component is in the page. */
function expectOnlyMounted(panel: string) {
  for (const other of PANELS) {
    if (other === panel) expect(screen.getByText(other)).toBeTruthy();
    else expect(screen.queryByText(other), other).toBeNull();
  }
}

describe("Integrations page", () => {
  it("gives an admin a tab per panel and mounts only the open one", async () => {
    session.oauth = true;
    const panel = await openAt("");
    expect(tabLabels()).toEqual(["Knowledge sources", "Connectors", "Mailboxes", "Connect your AI", "Connected apps"]);
    expect(within(panel).getByText("sources panel")).toBeTruthy();
    expectOnlyMounted("sources panel");
    expect(window.location.hash).toBe("#sources");

    const tabs: [string, string, string][] = [
      ["Connectors", "connectors panel", "#connectors"],
      ["Mailboxes", "mailbox panel", "#mailboxes"],
      ["Connect your AI", "mcp panel", "#connect-ai"],
      ["Connected apps", "connected apps panel", "#connected-apps"],
    ];
    for (const [label, content, hash] of tabs) {
      expect(within(openTab(label)).getByText(content)).toBeTruthy();
      expectOnlyMounted(content);
      expect(window.location.hash).toBe(hash);
    }
  });

  it.each([
    ["#sources", "sources panel"],
    ["#connectors", "connectors panel"],
    ["#mailboxes", "mailbox panel"],
    ["#connect-ai", "mcp panel"],
    ["#connected-apps", "connected apps panel"],
  ])("opens the tab a link made for the long page named (%s)", async (hash, content) => {
    session.oauth = true;
    expect(within(await openAt(hash)).getByText(content)).toBeTruthy();
    expectOnlyMounted(content);
  });

  it("shows a member who to ask instead of the source and token panels, and mounts neither", async () => {
    as("member");
    session.oauth = true;
    const panel = await openAt("");
    expect(tabLabels()).toEqual(["Sources and connectors", "Mailboxes", "Connect your AI", "Connected apps"]);
    expect(within(panel).getByText("Knowledge sources and connectors")).toBeTruthy();
    expect(within(openTab("Connect your AI")).getByText(/only an admin of this organization can issue/)).toBeTruthy();
    for (const content of ["sources panel", "connectors panel", "mcp panel"])
      expect(screen.queryByText(content)).toBeNull();
    expect(within(openTab("Mailboxes")).getByText("mailbox panel")).toBeTruthy();
    expect(within(openTab("Connected apps")).getByText("connected apps panel")).toBeTruthy();
  });

  it("opens an old #connectors link on the card that says who to ask, for a member", async () => {
    as("member");
    const panel = await openAt("#connectors");
    expect(within(panel).getByText("Knowledge sources and connectors")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Sources and connectors" }).getAttribute("aria-selected")).toBe("true");
  });

  it("gives connectors no tab while they are switched off, and opens a #connectors link on sources", async () => {
    vi.stubEnv("NEXT_PUBLIC_CONNECTORS_ENABLED", "false");
    const panel = await openAt("#connectors");
    expect(tabLabels()).toEqual(["Knowledge sources", "Mailboxes", "Connect your AI"]);
    expect(within(panel).getByText("sources panel")).toBeTruthy();
    expect(screen.queryByText("connectors panel")).toBeNull();
  });

  it("gates sources on memory.write and tokens on access.manage, each on its own", async () => {
    as("root writer");
    expect(within(await openAt("#sources")).getByText("sources panel")).toBeTruthy();
    expect(within(openTab("Connect your AI")).getByText(/only an admin of this organization can issue/)).toBeTruthy();
    expect(screen.queryByText("mcp panel")).toBeNull();
    cleanup();

    as("access manager only");
    expect(within(await openAt("#connect-ai")).getByText("mcp panel")).toBeTruthy();
    expect(within(openTab("Sources and connectors")).getByText("Knowledge sources and connectors")).toBeTruthy();
    expect(screen.queryByText("sources panel")).toBeNull();
  });

  it.each(["admin", "member"] as const)(
    "leaves out the Connected apps tab while MCP OAuth is off (%s)",
    async (role) => {
      as(role);
      const panel = await openAt("#connected-apps");
      expect(tabLabels()).not.toContain("Connected apps");
      expect(screen.queryByText("connected apps panel")).toBeNull();
      // The link falls back to the first tab rather than an empty page.
      expect(panel.id).toBe("tabpanel-sources");
    },
  );

  it("sends a person with no workspace to Settings to create one, and mounts nothing", async () => {
    session.orgId = null;
    render(await IntegrationsPage());
    expect(screen.getByRole("link", { name: /Create your workspace/ }).getAttribute("href")).toBe("/settings");
    expect(screen.queryByRole("tablist")).toBeNull();
    for (const panel of PANELS) expect(screen.queryByText(panel)).toBeNull();
  });
});
