// @vitest-environment jsdom
//
// The dashboard's first steps link to the panel that does each step. Connect your agent
// lives on Integrations since Settings was split, so the link goes there directly rather
// than through Settings' forward.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { WorkspaceOverview } from "./workspace-overview";

// An admin sees the checklist, which falls back to the same suggested path when it cannot load.
vi.mock("@/components/onboarding/first-run-checklist", () => ({
  FirstRunChecklist: ({ fallback }: { fallback: React.ReactNode }) => <>{fallback}</>,
}));

afterEach(cleanup);

describe("WorkspaceOverview first steps", () => {
  it.each([true, false])("link each step to where it is done (can manage access: %s)", (canManageAccess) => {
    render(<WorkspaceOverview canManageAccess={canManageAccess} />);
    const href = (name: RegExp) => screen.getByRole("link", { name }).getAttribute("href");
    expect(href(/Connect your agent/)).toBe("/integrations#connect-ai");
    expect(href(/Connect a source/)).toBe("/integrations#sources");
  });
});
