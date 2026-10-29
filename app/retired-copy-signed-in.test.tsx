// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import DashboardPage from "./(app)/dashboard/page";
import HowToUsePage from "./(app)/how-to-use/page";
import SettingsPage from "./(app)/settings/page";
import IntegrationsPage from "./(app)/integrations/page";
import { MemoryWorkbench } from "@/components/memory/memory-workbench";
import { OnboardingModal } from "@/components/onboarding/onboarding-modal";

/**
 * Guards the signed-in app pages against the copy retired in
 * the 2026-09-30 landing copy spec: the team is no longer
 * named as the buyer. The public pages are covered by retired-copy.test.tsx.
 */
const session = vi.hoisted(() => ({ hasContext: true, orgId: "org_test" as string | null, admin: true }));

vi.mock("@/lib/access-context", () => ({
  requireAccessContext: async () => (session.hasContext ? { org: { id: "testorg" }, ctx: {} } : null),
}));
vi.mock("@/lib/page-permissions", () => ({
  pagePermissions: async () => ({ manageAccess: session.admin, writeMemory: session.admin, orgAdmin: session.admin }),
}));
vi.mock("@/components/dashboard/workspace-overview", () => ({ WorkspaceOverview: () => null }));
vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ orgId: session.orgId }) }));
vi.mock("@clerk/nextjs", () => ({ CreateOrganization: () => null }));
vi.mock("@/lib/tenant", () => ({ ensureTenant: async () => undefined }));
vi.mock("@/components/settings/org-panel", () => ({ OrgPanel: () => null }));
vi.mock("@/components/settings/integrations-panel", () => ({ IntegrationsPanel: () => null }));
vi.mock("@/components/settings/mcp-panel", () => ({ McpPanel: () => null }));
vi.mock("@/components/settings/memory-chat-panel", () => ({ MemoryChatPanel: () => null }));
vi.mock("@/components/settings/sources-panel", () => ({ SourcesPanel: () => null }));
vi.mock("@/components/settings/connectors-panel", () => ({ ConnectorsPanel: () => null }));
vi.mock("@/components/settings/aliases-panel", () => ({ AliasesPanel: () => null }));
vi.mock("@/components/settings/org-roles-panel", () => ({ OrgRolesPanel: () => null }));
vi.mock("@/components/reveal", () => ({ Reveal: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/help", () => ({ HelpTip: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/components/memory/graph-explorer", () => ({ GraphExplorer: () => null }));
vi.mock("@/components/memory/scope-picker", () => ({ ScopePicker: () => null }));
vi.mock("@/components/onboarding/first-use-tips", () => ({ FirstUseTips: () => null }));

const RETIRED = /your team|product.?teams?|shared intelligence|\bbrain\b/i;

beforeEach(() => {
  session.hasContext = true;
  session.orgId = "org_test";
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function visibleText(): string {
  return document.body.textContent ?? "";
}

describe("signed-in pages do not name the team as the buyer", () => {
  it.each([true, false])("dashboard (access context: %s)", async (hasContext) => {
    session.hasContext = hasContext;
    render(await DashboardPage());
    expect(visibleText()).not.toMatch(RETIRED);
  });

  it.each([
    ["org_test", true],
    ["org_test", false],
    [null, false],
  ])("settings (organization: %s, admin: %s)", async (orgId, admin) => {
    session.orgId = orgId;
    session.admin = admin;
    render(await SettingsPage());
    expect(visibleText()).not.toMatch(RETIRED);
  });

  it.each([
    ["org_test", true],
    ["org_test", false],
    [null, false],
  ])("integrations (organization: %s, admin: %s)", async (orgId, admin) => {
    session.orgId = orgId;
    session.admin = admin;
    render(await IntegrationsPage());
    expect(visibleText()).not.toMatch(RETIRED);
  });

  it("memory workbench, in every mode", () => {
    render(<MemoryWorkbench canDelete={false} canWrite canManageScopes={false} />);
    for (const mode of ["ask", "write", "chat"]) {
      fireEvent.click(screen.getByRole("button", { name: mode }));
      expect(visibleText()).not.toMatch(RETIRED);
    }
  });

  it("onboarding, on every step", () => {
    render(<OnboardingModal onDone={vi.fn()} />);
    for (;;) {
      expect(visibleText()).not.toMatch(RETIRED);
      const next = screen.queryByRole("button", { name: "Next" });
      if (!next) break;
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "An answer" } });
      fireEvent.click(next);
    }
    expect(screen.getByRole("button", { name: "Finish" })).toBeTruthy();
  });

  it("how to use, on every card", () => {
    vi.useFakeTimers();
    render(<HowToUsePage />);
    const total = Number(/1 \/ (\d+)/.exec(visibleText())?.[1]);
    expect(total).toBeGreaterThan(1);
    for (let card = 1; card <= total; card++) {
      expect(visibleText()).toContain(`${card} / ${total}`);
      expect(visibleText()).not.toMatch(RETIRED);
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      act(() => vi.advanceTimersByTime(300));
    }
  });
});
