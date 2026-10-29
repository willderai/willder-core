// @vitest-environment jsdom
//
// A test named "acknowledging posts to the real endpoint and only updates
// state on a real 200, not optimistically" that only ever exercises the
// success path (click, stubbed fetch resolves 200, receipt flips) does not
// actually cover that claim: an implementation that set the acknowledgement
// state BEFORE awaiting the response would pass it unchanged.
//
// This receipt exists to be a grantee's durable attestation; a receipt that
// reads "Acknowledged" because a click happened, rather than because a row
// was written, defeats its purpose. These are the cases that make the claim
// real: a rejected call, a thrown call, and the window while the call is
// still in flight. All three must leave the receipt saying "Not yet
// acknowledged".
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { BriefDocument, type BriefDoc } from "./brief-document";

afterEach(() => {
  vi.unstubAllGlobals();
});

const brief: BriefDoc = {
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
  backend: "single",
  acknowledgement: null,
};

/** Staleness always resolves clean; `acknowledge` behaves however the test says. */
function stubFetch(onAcknowledge: () => Promise<Response>) {
  const fn = vi.fn(async (url: string) => {
    if (typeof url === "string" && url.endsWith("/staleness")) {
      return new Response(JSON.stringify({ changed: false, changes: [] }), { status: 200 });
    }
    if (typeof url === "string" && url.endsWith("/acknowledge")) {
      return onAcknowledge();
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

async function clickAcknowledge() {
  render(<BriefDocument brief={brief} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Acknowledge receipt" })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Acknowledge receipt" }));
}

describe("BriefDocument acknowledge — the receipt follows the server, not the click", () => {
  it("leaves the receipt unacknowledged when the server rejects the call", async () => {
    stubFetch(async () => new Response(JSON.stringify({ error: "access denied" }), { status: 403 }));
    await clickAcknowledge();

    // The button returns to its idle label; the receipt must not claim an
    // acknowledgement the server refused to record.
    await waitFor(() => expect(screen.getByRole("button", { name: "Acknowledge receipt" })).toBeTruthy());
    expect(screen.getByText("Not yet acknowledged")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Re-acknowledge" })).toBeNull();
  });

  it("leaves the receipt unacknowledged when the call throws", async () => {
    stubFetch(async () => {
      throw new Error("network down");
    });
    await clickAcknowledge();

    await waitFor(() => expect(screen.getByRole("button", { name: "Acknowledge receipt" })).toBeTruthy());
    expect(screen.getByText("Not yet acknowledged")).toBeTruthy();
  });

  it("does not show an acknowledgement while the call is still in flight", async () => {
    let settle: (res: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      settle = resolve;
    });
    stubFetch(() => pending);
    await clickAcknowledge();

    // In flight: the button reports progress and the receipt still says no.
    await waitFor(() => expect(screen.getByRole("button", { name: "Recording…" })).toBeTruthy());
    expect(screen.getByText("Not yet acknowledged")).toBeTruthy();

    settle(new Response(JSON.stringify({ acknowledgedAt: "2026-09-19T02:00:00.000Z", stale: false }), { status: 200 }));

    // Only once the real 200 lands does the receipt change.
    await waitFor(() => expect(screen.queryByText("Not yet acknowledged")).toBeNull());
    expect(screen.getByRole("button", { name: "Re-acknowledge" })).toBeTruthy();
  });
});
