// @vitest-environment jsdom
//
// UC6 pilot additions to the standalone /briefs/[id] view: the "decision
// changed after you started" staleness flag (GET /api/briefs/:id/staleness)
// and the "copy setup steps" affordance for an external handoff grantee.
// Pre-existing toolbar/print/download behavior is out of scope here (no
// prior test file existed for this component).
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { BriefDocument, type BriefDoc } from "./brief-document";

const clipboardWrite = vi.fn().mockResolvedValue(undefined);
Object.assign(navigator, { clipboard: { writeText: clipboardWrite } });

afterEach(() => {
  vi.unstubAllGlobals();
  clipboardWrite.mockClear();
});

const baseBrief: BriefDoc = {
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

function mockFetch(status: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(status), { status: 200 })),
  );
}

describe("BriefDocument — staleness flag (handoff only)", () => {
  it("shows no banner when nothing changed since generation", async () => {
    mockFetch({ stale: false, staleBasis: "scope", changed: false, changes: [] });
    render(<BriefDocument brief={baseBrief} />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith("/api/briefs/brief_1/staleness"));
    expect(screen.queryByText("Decision changed after you started")).toBeNull();
  });

  it("shows the flag and diff when memory changed under scope after createdAt", async () => {
    mockFetch({
      stale: true,
      staleBasis: "scope",
      changed: true,
      changes: [{ action: "memory.write", target: "org_1.engineering.backend/fact", at: "2026-09-16T00:00:00.000Z" }],
    });
    render(<BriefDocument brief={baseBrief} />);
    await waitFor(() => expect(screen.getByText("Decision changed after you started")).toBeTruthy());
    expect(screen.getByText("org_1.engineering.backend/fact")).toBeTruthy();
    // "Affected briefing" names this same brief.
    expect(screen.getAllByText(baseBrief.title).length).toBeGreaterThan(0);
  });

  it("never checks staleness for a non-handoff brief type", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(<BriefDocument brief={{ ...baseBrief, type: "architecture_plan" }} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // This component can re-render with a new `brief` prop instead of
  // remounting, so a warning about the PREVIOUS brief must not stay on
  // screen against a different document.
  it("clears a stale warning when the brief prop changes to a different handoff brief with nothing stale", async () => {
    mockFetch({
      stale: true,
      staleBasis: "scope",
      changed: true,
      changes: [{ action: "memory.write", target: "org_1.engineering.backend/fact", at: "2026-09-16T00:00:00.000Z" }],
    });
    const { rerender } = render(<BriefDocument brief={baseBrief} />);
    await waitFor(() => expect(screen.getByText("Decision changed after you started")).toBeTruthy());

    mockFetch({ stale: false, staleBasis: "scope", changed: false, changes: [] });
    const otherBrief: BriefDoc = { ...baseBrief, id: "brief_2", title: "A different briefing" };
    rerender(<BriefDocument brief={otherBrief} />);

    // The old brief's warning must not still be visible against the new one, even
    // transiently before the new fetch resolves.
    expect(screen.queryByText("Decision changed after you started")).toBeNull();
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith("/api/briefs/brief_2/staleness"));
    expect(screen.queryByText("Decision changed after you started")).toBeNull();
  });

  it("clears a stale warning when the brief prop changes to a non-handoff brief", async () => {
    mockFetch({
      stale: true,
      staleBasis: "scope",
      changed: true,
      changes: [{ action: "memory.write", target: "org_1.engineering.backend/fact", at: "2026-09-16T00:00:00.000Z" }],
    });
    const { rerender } = render(<BriefDocument brief={baseBrief} />);
    await waitFor(() => expect(screen.getByText("Decision changed after you started")).toBeTruthy());

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    rerender(<BriefDocument brief={{ ...baseBrief, id: "brief_3", type: "architecture_plan" }} />);

    expect(screen.queryByText("Decision changed after you started")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// The banner keys off the `stale` verdict (services/memory/brief-staleness.ts), not
// `changed`: a write elsewhere in the brief's scope must not flag a brief that never
// drew on it, and the reason line must match the basis the verdict rests on.
describe("BriefDocument — stale verdict drives the banner (handoff only)", () => {
  const unrelatedWrite = {
    action: "memory.write",
    target: "org_1.engineering.design/fact",
    at: "2026-09-16T00:00:00.000Z",
  };

  it("shows no banner when the scope saw writes but nothing the brief was derived from changed", async () => {
    mockFetch({ stale: false, staleBasis: "derivation", changed: true, changes: [unrelatedWrite], citations: [] });
    render(<BriefDocument brief={baseBrief} />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith("/api/briefs/brief_1/staleness"));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText("Decision changed after you started")).toBeNull();
    expect(screen.queryByText(unrelatedWrite.target)).toBeNull();
  });

  it("names the moved citations on the derivation basis and does not list unrelated scope writes", async () => {
    mockFetch({
      stale: true,
      staleBasis: "derivation",
      changed: true,
      changes: [unrelatedWrite],
      citations: [
        { sectionIndex: 0, factId: "f1", factText: "Deploys go out on Tuesdays", status: "superseded" },
        { sectionIndex: 0, factId: "f2", factText: "Sam owns billing", status: "current" },
      ],
    });
    render(<BriefDocument brief={baseBrief} />);
    await waitFor(() => expect(screen.getByText("Decision changed after you started")).toBeTruthy());
    expect(screen.getByText(/1 fact it cites has changed, been replaced or been removed/)).toBeTruthy();
    expect(screen.queryByText(unrelatedWrite.target)).toBeNull();
  });

  it("names a changed source on the derivation basis when no citation moved", async () => {
    mockFetch({ stale: true, staleBasis: "derivation", changed: false, changes: [], citations: [] });
    render(<BriefDocument brief={baseBrief} />);
    await waitFor(() => expect(screen.getByText("Decision changed after you started")).toBeTruthy());
    expect(screen.getByText(/A connected source this briefing read has replaced or removed an item/)).toBeTruthy();
  });

  it("says the scope fallback plainly and lists the scope writes when the brief recorded nothing it read", async () => {
    mockFetch({ stale: true, staleBasis: "scope", changed: true, changes: [unrelatedWrite], citations: [] });
    render(<BriefDocument brief={baseBrief} />);
    await waitFor(() => expect(screen.getByText("Decision changed after you started")).toBeTruthy());
    expect(screen.getByText(/has no record of what it was built from/)).toBeTruthy();
    expect(screen.getByText(unrelatedWrite.target)).toBeTruthy();
  });
});

// Gate C.2: the staleness banner alone must not render a correction and a
// genuine disagreement identically. These assert the distinguishing signal.
describe("BriefDocument — contradiction signal (Gate C.2, handoff only)", () => {
  const contradiction = {
    factA: "the deploy target is Vercel. Confirmed by the platform team.",
    factB: "the deploy target is AWS ECS. Confirmed by the platform team.",
    note: "same decision, incompatible targets",
  };

  it("shows the distinguishing headline and both conflicting facts when a contradiction is detected", async () => {
    mockFetch({
      stale: true,
      staleBasis: "scope",
      changed: true,
      changes: [{ action: "memory.write", target: "org_1.engineering/fact", at: "2026-09-16T00:00:00.000Z" }],
      contradictions: [contradiction],
    });
    render(<BriefDocument brief={baseBrief} />);
    await waitFor(() => expect(screen.getByText("Sources now disagree")).toBeTruthy());
    expect(screen.queryByText("Decision changed after you started")).toBeNull();
    expect(screen.getByText("Sources disagree about this decision")).toBeTruthy();
    expect(screen.getByText(contradiction.factA)).toBeTruthy();
    expect(screen.getByText(contradiction.factB)).toBeTruthy();
    expect(screen.getByText(contradiction.note)).toBeTruthy();
  });

  it("keeps the plain 'changed' headline and shows no contradiction block when nothing disagrees", async () => {
    mockFetch({
      stale: true,
      staleBasis: "scope",
      changed: true,
      changes: [{ action: "memory.write", target: "org_1.engineering/fact", at: "2026-09-16T00:00:00.000Z" }],
      contradictions: [],
    });
    render(<BriefDocument brief={baseBrief} />);
    await waitFor(() => expect(screen.getByText("Decision changed after you started")).toBeTruthy());
    expect(screen.queryByText("Sources now disagree")).toBeNull();
    expect(screen.queryByText("Sources disagree about this decision")).toBeNull();
  });

  it("does not render a contradiction block for a non-handoff brief", async () => {
    mockFetch({ stale: true, staleBasis: "scope", changed: true, changes: [], contradictions: [contradiction] });
    render(<BriefDocument brief={{ ...baseBrief, type: "architecture_plan" }} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText("Sources disagree about this decision")).toBeNull();
  });
});

describe("BriefDocument — source visibility (surfaces #1/#2, handoff only)", () => {
  it("shows the in/out-of-scope sentence when sources are mixed", async () => {
    mockFetch({
      stale: false,
      staleBasis: "scope",
      changed: false,
      changes: [],
      sources: { total: 5, inScope: 3, outOfScope: 2 },
    });
    render(<BriefDocument brief={baseBrief} />);
    await waitFor(() =>
      expect(screen.getByText("3 of 5 connected sources visible to this agent now; 2 out of scope.")).toBeTruthy(),
    );
  });

  it("omits the out-of-scope clause when everything connected was in scope", async () => {
    mockFetch({
      stale: false,
      staleBasis: "scope",
      changed: false,
      changes: [],
      sources: { total: 2, inScope: 2, outOfScope: 0 },
    });
    render(<BriefDocument brief={baseBrief} />);
    await waitFor(() => expect(screen.getByText("2 of 2 connected sources visible to this agent now.")).toBeTruthy());
  });

  it("renders independently of the staleness flag — shown even when nothing changed", async () => {
    mockFetch({
      stale: false,
      staleBasis: "scope",
      changed: false,
      changes: [],
      sources: { total: 1, inScope: 1, outOfScope: 0 },
    });
    render(<BriefDocument brief={baseBrief} />);
    await waitFor(() => expect(screen.getByText("1 of 1 connected source visible to this agent now.")).toBeTruthy());
    expect(screen.queryByText("Decision changed after you started")).toBeNull();
  });

  // The sources sentence must not claim historical provenance (what the agent
  // actually drew from), since the endpoint never records that — it only
  // counts sources currently connected and in scope, so connecting or
  // disconnecting a source after generation would otherwise retroactively
  // change what a past briefing claimed it was "answered from". State present
  // visibility instead.
  it("does not claim historical provenance ('answered from') the endpoint never recorded", async () => {
    mockFetch({
      stale: false,
      staleBasis: "scope",
      changed: false,
      changes: [],
      sources: { total: 4, inScope: 4, outOfScope: 0 },
    });
    render(<BriefDocument brief={baseBrief} />);
    await waitFor(() => expect(screen.getByText(/visible to this agent now/)).toBeTruthy());
    expect(screen.queryByText(/Answered from/)).toBeNull();
  });

  it("does not render the sentence for a non-handoff brief", async () => {
    mockFetch({
      stale: false,
      staleBasis: "scope",
      changed: false,
      changes: [],
      sources: { total: 3, inScope: 1, outOfScope: 2 },
    });
    render(<BriefDocument brief={{ ...baseBrief, type: "qa_review" }} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(/connected source/)).toBeNull();
  });
});

describe("BriefDocument — copyable setup steps (handoff only)", () => {
  it("copies real, actionable steps naming the grantee and this page's link", async () => {
    mockFetch({ stale: false, staleBasis: "scope", changed: false, changes: [] });
    render(<BriefDocument brief={baseBrief} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy setup steps" }));
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(1));
    const copied = clipboardWrite.mock.calls[0][0] as string;
    expect(copied).toContain("Jordan Rivera");
    expect(copied).toContain("Invite by email");
    expect(copied).toContain(window.location.href);
  });

  it("does not render the setup-steps button for a non-handoff brief", () => {
    mockFetch({ stale: false, staleBasis: "scope", changed: false, changes: [] });
    render(<BriefDocument brief={{ ...baseBrief, type: "qa_review" }} />);
    expect(screen.queryByRole("button", { name: "Copy setup steps" })).toBeNull();
  });
});

// A persisted completion receipt on the page the grantee actually opens
// (agents/page.tsx's CompletionReceipt is the generator's own, in-session-only view).
function mockRoutedFetch(staleness: unknown, ack?: unknown) {
  const fn = vi.fn(async (url: string) => {
    if (typeof url === "string" && url.endsWith("/staleness")) {
      return new Response(JSON.stringify(staleness), { status: 200 });
    }
    if (typeof url === "string" && url.endsWith("/acknowledge")) {
      return new Response(JSON.stringify(ack), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("BriefDocument — completion receipt (handoff only)", () => {
  it("shows Not yet acknowledged and the persisted backend before any acknowledgement", async () => {
    mockFetch({ stale: false, staleBasis: "scope", changed: false, changes: [] });
    render(<BriefDocument brief={{ ...baseBrief, backend: "manager" }} />);
    await waitFor(() => expect(screen.getByText("Completion receipt")).toBeTruthy());
    expect(screen.getByText("Not yet acknowledged")).toBeTruthy();
    expect(screen.getByText("Manager (fan-out)")).toBeTruthy();
  });

  it("shows a prior acknowledgement seeded from the server on first render, no click needed", () => {
    mockFetch({ stale: false, staleBasis: "scope", changed: false, changes: [] });
    render(
      <BriefDocument
        brief={{ ...baseBrief, backend: "single", acknowledgement: { at: "2026-09-19T02:00:00.000Z", stale: false } }}
      />,
    );
    expect(screen.getByText("Single agent")).toBeTruthy();
    expect(screen.queryByText("Not yet acknowledged")).toBeNull();
  });

  it("acknowledging posts to the real endpoint and only updates state on a real 200, not optimistically", async () => {
    const fetchSpy = mockRoutedFetch(
      { stale: false, staleBasis: "scope", changed: false, changes: [] },
      { acknowledgedAt: "2026-09-19T02:00:00.000Z", stale: false },
    );
    render(<BriefDocument brief={baseBrief} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Acknowledge receipt" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge receipt" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Re-acknowledge" })).toBeTruthy());
    expect(fetchSpy).toHaveBeenCalledWith("/api/briefs/brief_1/acknowledge", { method: "POST" });
    expect(screen.queryByText("Not yet acknowledged")).toBeNull();
  });

  it("labels a stale acknowledgement so a copied receipt can't read as a clean handoff", async () => {
    mockRoutedFetch(
      {
        stale: true,
        staleBasis: "scope",
        changed: true,
        changes: [{ action: "memory.write", target: "org_1.engineering.backend/fact", at: "2026-09-16T00:00:00.000Z" }],
      },
      { acknowledgedAt: "2026-09-19T02:00:00.000Z", stale: true },
    );
    render(<BriefDocument brief={baseBrief} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Acknowledge receipt" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge receipt" }));
    await waitFor(() =>
      expect(screen.getByText(/it attests receipt of this document, not that its content was current/)).toBeTruthy(),
    );
  });

  it("does not render the receipt or acknowledge button for a non-handoff brief", async () => {
    mockFetch({ stale: false, staleBasis: "scope", changed: false, changes: [] });
    render(<BriefDocument brief={{ ...baseBrief, type: "qa_review" }} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText("Completion receipt")).toBeNull();
    expect(screen.queryByRole("button", { name: "Acknowledge receipt" })).toBeNull();
  });
});

// Each section shows the facts it cited, re-checked now. A citation to a fact that
// has since changed must never read as confirmation of it.
describe("BriefDocument — cited facts per section (handoff only)", () => {
  const sectioned: BriefDoc = {
    ...baseBrief,
    sections: [
      { heading: "Deploys", content: "Deploys go out on Tuesdays." },
      { heading: "Owners", content: "Sam owns billing." },
    ],
  };

  function sectionOf(heading: string): HTMLElement {
    return screen.getByText(heading).parentElement as HTMLElement;
  }

  it("lists a section's citations with no warning when every cited fact is still current", async () => {
    mockFetch({
      stale: false,
      staleBasis: "scope",
      changed: false,
      changes: [],
      citations: [{ sectionIndex: 0, factId: "f1", factText: "Deploys go out on Tuesdays", status: "current" }],
    });
    render(<BriefDocument brief={sectioned} />);
    await waitFor(() => expect(screen.getByText("Sources: 1 cited fact: 1 still current")).toBeTruthy());

    const deploys = within(sectionOf("Deploys"));
    expect(deploys.getByText("Still current")).toBeTruthy();
    expect(deploys.getByText("Deploys go out on Tuesdays")).toBeTruthy();
    expect(deploys.queryByText(/no longer say what it quoted/)).toBeNull();
    // Sources stay under the section that cited them.
    expect(within(sectionOf("Owners")).queryByText(/^Sources:/)).toBeNull();
  });

  it("flags a section in the open when a cited fact changed, was replaced or is gone, and withholds a gone fact's text", async () => {
    mockFetch({
      stale: true,
      staleBasis: "scope",
      changed: true,
      changes: [{ action: "memory.write", target: "org_1.engineering/fact", at: "2026-09-16T00:00:00.000Z" }],
      citations: [
        { sectionIndex: 1, factId: "f2", factText: "Sam owns billing", status: "superseded" },
        { sectionIndex: 1, factId: "f3", factText: null, status: "gone" },
        { sectionIndex: 1, factId: "f4", factText: "Billing runs on Stripe", status: "unknown" },
        { sectionIndex: 1, factId: "f5", factText: "Invoices go out monthly", status: "current" },
      ],
    });
    render(<BriefDocument brief={sectioned} />);
    const owners = await waitFor(() => {
      const section = within(sectionOf("Owners"));
      expect(
        section.getByText(
          "2 of 4 cited facts behind this section no longer say what it quoted. Check the sources below before relying on it.",
        ),
      ).toBeTruthy();
      return section;
    });

    // Every citation is counted, and an unchecked one is never folded into "current".
    expect(
      owners.getByText("Sources: 4 cited facts: 1 replaced, 1 removed, 1 not checked, 1 still current"),
    ).toBeTruthy();
    expect(owners.getByText("Replaced by a newer fact")).toBeTruthy();
    expect(owners.getByText("As cited: Sam owns billing")).toBeTruthy();
    expect(owners.getByText("Removed, or no longer visible to you")).toBeTruthy();
    expect(owners.getByText("Could not be checked")).toBeTruthy();
    expect(owners.getByText("As cited: Billing runs on Stripe")).toBeTruthy();
    expect(within(sectionOf("Deploys")).queryByText(/no longer say what it quoted/)).toBeNull();
  });

  // The two claims above that the DOM-only assertions could not tell apart from
  // their opposites. jsdom keeps a closed <details> body in the document, so finding
  // the warning text does not prove it sits outside the collapsed list.
  it("keeps the divergence warning outside the collapsed sources list, and a gone row carries no text at all", async () => {
    mockFetch({
      stale: true,
      staleBasis: "scope",
      changed: true,
      changes: [],
      citations: [
        { sectionIndex: 1, factId: "f3", factText: null, status: "gone" },
        { sectionIndex: 1, factId: "f5", factText: "Invoices go out monthly", status: "current" },
      ],
    });
    render(<BriefDocument brief={sectioned} />);
    const warning = await waitFor(() => screen.getByText(/1 of 2 cited facts behind this section/));
    expect(warning.closest("details")).toBeNull();
    expect(
      within(sectionOf("Owners"))
        .getByText(/^Sources:/)
        .closest("details")?.open,
    ).toBe(false);

    const goneRow = screen.getByText("Removed, or no longer visible to you").closest("li") as HTMLElement;
    expect(goneRow.textContent).toBe("Removed, or no longer visible to you");
  });

  it("shows no sources for a brief generated before citations were recorded", async () => {
    mockFetch({ stale: false, staleBasis: "scope", changed: false, changes: [], citations: [] });
    render(<BriefDocument brief={sectioned} />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith("/api/briefs/brief_1/staleness"));
    expect(screen.queryByText(/^Sources:/)).toBeNull();
  });

  it("drops the previous brief's citations when the brief prop changes", async () => {
    mockFetch({
      stale: false,
      staleBasis: "scope",
      changed: false,
      changes: [],
      citations: [{ sectionIndex: 0, factId: "f1", factText: "Deploys go out on Tuesdays", status: "changed" }],
    });
    const { rerender } = render(<BriefDocument brief={sectioned} />);
    await waitFor(() => expect(screen.getByText("Changed since this briefing")).toBeTruthy());

    mockFetch({ stale: false, staleBasis: "scope", changed: false, changes: [], citations: [] });
    rerender(<BriefDocument brief={{ ...sectioned, id: "brief_2" }} />);
    expect(screen.queryByText("Changed since this briefing")).toBeNull();
    expect(screen.queryByText(/^Sources:/)).toBeNull();
  });
});
