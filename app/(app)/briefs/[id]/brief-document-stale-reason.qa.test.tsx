// @vitest-environment jsdom
//
// The handoff staleness banner's reason line counts the cited facts that moved, and
// the banner is gated on the brief being a handoff. These cases pin what the
// component tests in brief-document.test.tsx leave open: every moved status is
// counted (changed, superseded and gone, not one of them), the count is the real
// number with the plural form, and a stale verdict never shows the handoff banner
// on a brief that is not a handoff, even when the brief id is unchanged.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { BriefDocument, type BriefDoc } from "./brief-document";

afterEach(() => {
  vi.unstubAllGlobals();
});

const handoffBrief: BriefDoc = {
  id: "brief_1",
  type: "handoff",
  scopePath: "org_1.engineering",
  scopeLabel: null,
  title: "Onboarding briefing for Jordan Rivera",
  summary: "Summary text.",
  granteeName: "Jordan Rivera",
  granteeRole: "Contract designer",
  sections: [],
  milestones: null,
  diagram: null,
  diagramUrl: null,
  charts: null,
  decisions: null,
  createdAt: "2026-09-15T00:00:00.000Z",
};

function respondWith(staleness: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(staleness), { status: 200 })),
  );
}

function citation(factId: string, status: string) {
  return { sectionIndex: 0, factId, factText: `Fact ${factId}`, status };
}

describe("BriefDocument stale reason: moved citations", () => {
  it("counts changed, superseded and gone citations, and only those, in the plural", async () => {
    respondWith({
      stale: true,
      staleBasis: "derivation",
      changed: false,
      changes: [],
      citations: [
        citation("f1", "changed"),
        citation("f2", "superseded"),
        citation("f3", "gone"),
        citation("f4", "current"),
        citation("f5", "unknown"),
      ],
    });
    render(<BriefDocument brief={handoffBrief} />);
    await waitFor(() => expect(screen.getByText("Decision changed after you started")).toBeTruthy());
    expect(screen.getByText(/3 facts it cites have changed, been replaced or been removed/)).toBeTruthy();
  });

  it("counts a citation whose fact is gone even when nothing else moved", async () => {
    respondWith({
      stale: true,
      staleBasis: "derivation",
      changed: false,
      changes: [],
      citations: [citation("f1", "gone"), citation("f2", "current")],
    });
    render(<BriefDocument brief={handoffBrief} />);
    await waitFor(() => expect(screen.getByText("Decision changed after you started")).toBeTruthy());
    expect(screen.getByText(/1 fact it cites has changed, been replaced or been removed/)).toBeTruthy();
  });
});

describe("BriefDocument stale banner: handoff only", () => {
  it("hides the banner when the same brief id re-renders as a non-handoff brief", async () => {
    respondWith({
      stale: true,
      staleBasis: "scope",
      changed: true,
      changes: [{ action: "memory.write", target: "org_1.engineering/fact", at: "2026-09-16T00:00:00.000Z" }],
    });
    const { rerender } = render(<BriefDocument brief={handoffBrief} />);
    await waitFor(() => expect(screen.getByText("Decision changed after you started")).toBeTruthy());

    rerender(<BriefDocument brief={{ ...handoffBrief, type: "architecture_plan" }} />);

    expect(screen.queryByText("Decision changed after you started")).toBeNull();
  });
});
