// @vitest-environment jsdom
//
// The visible completion receipt's <dl> and its "Copy receipt" clipboard text
// must agree on what the receipt attests: a field copyReceipt() writes (such
// as Grantee) must also render in the <dl>, or a viewer sees one artifact
// on-screen and copies a different one.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CompletionReceipt } from "@/components/agents/completion-receipt";
import type { Brief } from "@/lib/agents/brief-types";

const clipboardWrite = vi.fn().mockResolvedValue(undefined);
Object.assign(navigator, { clipboard: { writeText: clipboardWrite } });

afterEach(() => {
  clipboardWrite.mockClear();
});

const baseBrief: Brief = {
  id: "brief_1",
  orgId: "org_1",
  type: "handoff",
  granteeName: "Jordan Rivera",
  granteeRole: "Contract designer",
  scopePath: "org_1.engineering",
  scopeLabel: null,
  title: "Onboarding briefing for Jordan Rivera",
  summary: "Summary text.",
  sections: [],
  diagram: null,
  diagramUrl: null,
  googleDocUrl: null,
  milestones: null,
  charts: null,
  createdAt: "2026-09-19T00:00:00.000Z",
};

describe("CompletionReceipt — grantee (handoff pilot)", () => {
  it("shows the grantee (name + role) in the visible receipt, matching what copyReceipt already writes", () => {
    render(<CompletionReceipt brief={baseBrief} backend="single" onCopy={() => {}} />);
    expect(screen.getByText("Grantee")).toBeTruthy();
    expect(screen.getByText("Jordan Rivera (Contract designer)")).toBeTruthy();
  });

  it("falls back to an em dash when there is no grantee name, same as copyReceipt's own fallback", () => {
    render(
      <CompletionReceipt
        brief={{ ...baseBrief, granteeName: null, granteeRole: null }}
        backend="single"
        onCopy={() => {}}
      />,
    );
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("copied text and the visible receipt agree on the grantee", async () => {
    render(<CompletionReceipt brief={baseBrief} backend="manager" onCopy={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy receipt" }));
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(1));
    const copied = clipboardWrite.mock.calls[0][0] as string;
    expect(copied).toContain("Grantee: Jordan Rivera (Contract designer)");
    expect(screen.getByText("Jordan Rivera (Contract designer)")).toBeTruthy();
  });
});
