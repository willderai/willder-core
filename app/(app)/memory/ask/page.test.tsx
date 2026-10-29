// @vitest-environment jsdom
//
// The memory chat name moved from Settings to Ask, below the chat it names, at the anchor
// Settings forwards to (#memory-chat). It mounts for every member of an organization, as it
// did on Settings (the route lets anyone read it and only an owner or admin save it), and
// not at all without an organization.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import MemoryAskPage from "./page";

const session = vi.hoisted(() => ({ hasOrg: true, canWrite: true, canManageScopes: true }));

vi.mock("../memory-page-access", () => ({
  loadMemoryPageAccess: async () =>
    session.hasOrg
      ? {
          initialScope: null,
          rootScope: "org_test",
          canWrite: session.canWrite,
          canManageScopes: session.canManageScopes,
        }
      : null,
}));
vi.mock("@/components/memory/memory-workbench", () => ({ MemoryWorkbench: () => <p>workbench</p> }));
vi.mock("@/components/onboarding/first-use-tips", () => ({ FirstUseTips: () => null }));
vi.mock("@/components/settings/memory-chat-panel", () => ({ MemoryChatPanel: () => <p>memory chat panel</p> }));

afterEach(() => {
  cleanup();
  Object.assign(session, { hasOrg: true, canWrite: true, canManageScopes: true });
});

const visit = async () => render(await MemoryAskPage({ searchParams: Promise.resolve({}) }));

describe("Ask page: the memory chat name", () => {
  it.each([
    ["an admin", true, true],
    ["a member", false, false],
  ])("is below the chat, at #memory-chat, for %s", async (_who, canWrite, canManageScopes) => {
    Object.assign(session, { canWrite, canManageScopes });
    await visit();
    const section = screen.getByRole("region", { name: "Memory chat name" });
    expect(section.id).toBe("memory-chat");
    expect(section.textContent).toContain("memory chat panel");
    const workbench = screen.getByText("workbench");
    expect(workbench.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("is absent without an organization", async () => {
    session.hasOrg = false;
    await visit();
    expect(screen.queryByText("memory chat panel")).toBeNull();
    expect(document.getElementById("memory-chat")).toBeNull();
  });
});
