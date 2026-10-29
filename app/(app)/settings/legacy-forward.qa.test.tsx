// @vitest-environment jsdom
//
// The forwarding rule itself is tested in components/settings/legacy-settings-redirect.test.tsx.
// This proves the Settings page actually runs it: links made before the split
// (`/settings#sources`, `#connect-ai`, `#connected-apps`, `#memory-chat`, a moved list's
// view, the OAuth callback's `?integration=`) must leave Settings for the page that now
// holds the panel, and an ordinary Settings visit must not.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import SettingsPage from "./page";

const session = vi.hoisted(() => ({ admin: false }));

vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ orgId: "org_test" }) }));
vi.mock("@clerk/nextjs", () => ({ CreateOrganization: () => null }));
vi.mock("@/lib/access-context", () => ({ requireAccessContext: async () => ({ org: { id: "testorg" }, ctx: {} }) }));
vi.mock("@/lib/page-permissions", () => ({
  pagePermissions: async () => ({ manageAccess: session.admin, writeMemory: session.admin, orgAdmin: session.admin }),
}));
vi.mock("@/components/settings/org-panel", () => ({ OrgPanel: () => null }));
vi.mock("@/components/settings/aliases-panel", () => ({ AliasesPanel: () => null }));
vi.mock("@/components/settings/org-roles-panel", () => ({ OrgRolesPanel: () => null }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.admin = false;
});

async function visitSettingsAt(url: string) {
  const replace = vi.fn();
  const { search, hash } = new URL(url, "http://localhost");
  vi.stubGlobal("location", { ...window.location, search, hash, replace });
  render(await SettingsPage());
  return replace;
}

describe.each([false, true])("Settings forwards links made before the split (admin: %s)", (admin) => {
  beforeEach(() => {
    session.admin = admin;
  });

  it.each([
    ["/settings#sources", "/integrations#sources"],
    ["/settings#connectors", "/integrations#connectors"],
    ["/settings#source-src_1", "/integrations#source-src_1"],
    ["/settings#mailboxes", "/integrations#mailboxes"],
    ["/settings#connect-ai", "/integrations#connect-ai"],
    ["/settings#connected-apps", "/integrations#connected-apps"],
    ["/settings?connections.q=ci#connect-ai", "/integrations?connections.q=ci#connect-ai"],
    ["/settings?apps.sort=name", "/integrations?apps.sort=name"],
    ["/settings#memory-chat", "/memory/ask#memory-chat"],
    ["/settings#memory-chat-name", "/memory/ask#memory-chat-name"],
    ["/settings?integration=slack&connected=1", "/integrations?integration=slack&connected=1"],
  ])("%s goes to %s", async (from, to) => {
    expect(await visitSettingsAt(from)).toHaveBeenCalledWith(to);
  });

  it.each([
    "/settings",
    "/settings#org-roles",
    "/settings#aliases",
    "/settings?members.q=ada",
    "/settings#/organization-members",
  ])("stays put on a link to what is still on Settings: %s", async (url) => {
    expect(await visitSettingsAt(url)).not.toHaveBeenCalled();
  });
});
