// @vitest-environment jsdom
//
// Walked as a script: someone outside the team is handed a fact an agent
// acted on and must name its writer, its source and what it replaced from the screen alone.
//
// The walk: an agent's write in the access log -> its "See the change it made" link ->
// the change's detail, opened from that link with no window, click or selection of the
// reader's own -> the version it replaced, followed by its link. Each step asserts only
// what is on screen, in the words the reader reads.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { Timeline } from "@/services/audit/timeline";
import { AuditLog } from "./audit-log";
import { AuditTimeline } from "./timeline";

const SCOPE = "org_c1.crew_1c5b79";
const NEW_CHANGE = "chg-new";
const OLD_CHANGE = "chg-old";

/** The write the reader is handed: an agent's, on a token a person issued, from GitHub. */
const NEW_DETAIL = {
  id: NEW_CHANGE,
  op: "create",
  recordType: "fact",
  recordId: "v2",
  scopePath: SCOPE,
  summary: "The launch moved to October 11",
  writer: "Release Agent",
  actingFor: "Jane Doe",
  source: { id: "src-gh", name: "acme/launch-plan", type: "github" },
  replacedById: null,
  replacesIds: ["v1"],
  replacedBy: null,
  replaces: [{ id: "v1", change: { id: OLD_CHANGE, summary: "The launch is October 4" } }],
  at: "2026-10-01T09:00:00.000Z",
};

/** The version it replaced, as the reader finds it by following the link. */
const OLD_DETAIL = {
  ...NEW_DETAIL,
  id: OLD_CHANGE,
  recordId: "v1",
  summary: "The launch is October 4",
  replacedById: "v2",
  replacesIds: [],
  replaces: [],
  replacedBy: { id: "v2", change: { id: NEW_CHANGE, summary: "The launch moved to October 11" } },
  at: "2026-09-28T09:00:00.000Z",
};

/** The window on screen holds nothing: the change is older than the default 24 hours. */
const EMPTY: Timeline = { lanes: [], writes: [], sightings: [], denials: [], latency: null, unseenWriteIds: [] };

const ACCESS_ROW = {
  id: "row1",
  actorType: "agent",
  actorName: "Release Agent",
  triggeredBy: "Jane Doe",
  action: "memory.write",
  target: `${SCOPE}/fact`,
  decision: "allow",
  reason: "ok",
  changeIds: [NEW_CHANGE],
  at: NEW_DETAIL.at,
};

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (input.startsWith(`/api/audit/timeline/${NEW_CHANGE}`)) return json(NEW_DETAIL);
      if (input.startsWith(`/api/audit/timeline/${OLD_CHANGE}`)) return json(OLD_DETAIL);
      if (input.startsWith("/api/audit/timeline")) {
        return json({
          scope: SCOPE,
          from: "2026-10-07T07:00:00.000Z",
          to: "2026-10-08T07:00:00.000Z",
          timeline: EMPTY,
          truncated: { writes: false, reads: false },
        });
      }
      if (input.startsWith("/api/audit/actors")) return json({ actors: [] });
      return json({
        entries: [ACCESS_ROW],
        total: 1,
        counts: { allowed: 1, denied: 0 },
        page: 1,
        pageSize: 50,
        totalPages: 1,
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The change the audit page's address names, as `/audit?...&change=<id>` opens it. */
function openFromLink(href: string) {
  const change = new URL(href, "http://t").searchParams.get("change");
  render(<AuditTimeline scope={SCOPE} selected={change} onSelect={() => {}} />);
}

describe("an outsider handed a fact an agent acted on", () => {
  it("reaches it from the access log, and reads its writer, source and replaced version from the page alone", async () => {
    // 1. The agent's write in the access log links to the change it made.
    render(<AuditLog scope={SCOPE} />);
    const handed = (await screen.findByRole("link", { name: "See the change it made" })).getAttribute("href")!;
    expect(handed).toBe(`/audit?view=timeline&scope=${SCOPE}&change=${NEW_CHANGE}`);
    cleanup();

    // 2. The link opens the change by itself, though it is outside the window on screen.
    openFromLink(handed);
    const page = await screen.findByRole("region", { name: "Selected change" });
    await within(page).findByText("The launch moved to October 11");
    const answer = (label: string) => within(page).getByText(label, { selector: "dt" }).nextElementSibling!;

    // Writer: the agent and the person it acts for, in words.
    expect(answer("Written by").textContent).toBe("Release Agent, acting for Jane Doe");
    // Source: named, and a link to it.
    const source = within(answer("Source") as HTMLElement).getByRole("link");
    expect(source.textContent).toBe("acme/launch-plan (github)");
    expect(source.getAttribute("href")).toBe("/integrations#source-src-gh");
    // Replaced: the old version by its own text, and a link to it.
    const replaced = within(answer("Replaced") as HTMLElement).getByRole("link");
    expect(answer("Replaced").textContent).toBe("Replaces “The launch is October 4”");
    expect(replaced.getAttribute("href")).toBe(`/audit?view=timeline&scope=${SCOPE}&change=${OLD_CHANGE}`);
    // And it says why no reader is listed, rather than implying none read it.
    expect(within(page).getByText(/outside the window on screen/)).toBeTruthy();
    // A link to hand on again.
    expect(within(page).getByRole("link", { name: "Link to this change" }).getAttribute("href")).toBe(handed);
    cleanup();

    // 3. Following the replaced link opens the old version, which links back.
    openFromLink(replaced.getAttribute("href")!);
    const old = await screen.findByRole("region", { name: "Selected change" });
    await within(old).findByText("The launch is October 4");
    const back = within(old).getByText("Replaced", { selector: "dt" }).nextElementSibling!;
    expect(back.textContent).toBe("Replaced by “The launch moved to October 11”");
    expect(
      within(back as HTMLElement)
        .getByRole("link")
        .getAttribute("href"),
    ).toBe(handed);
  });
});
