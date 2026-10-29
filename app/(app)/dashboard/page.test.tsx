// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import DashboardPage from "./page";

// The overview's first-run checklist reads a route that audits every refusal. These
// pin that the page asks for it only when the server-side can() probe says the person
// may manage access, so a member's visit leaves no deny row on the audit trail.
const session = vi.hoisted(() => ({ manageAccess: false }));

vi.mock("@/lib/access-context", () => ({
  requireAccessContext: async () => ({ org: { id: "org_1" }, ctx: {}, user: { role: "member" } }),
}));
vi.mock("@/lib/page-permissions", () => ({
  pagePermissions: async () => ({ manageAccess: session.manageAccess, writeMemory: true, orgAdmin: false }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubFetch() {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ fact: null, openedFact: false, subScopeToken: null, denied: false }), {
        status: 200,
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("overview page first-run checklist gate", () => {
  it("a member who cannot manage access gets the suggested path and makes no request", async () => {
    session.manageAccess = false;
    const fetchMock = stubFetch();
    render(await DashboardPage());

    expect(screen.getByRole("heading", { name: "Start with one source." })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "See your memory work." })).toBeNull();
    // Give any effect a chance to run before asserting nothing was fetched.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an access manager gets the checklist, loaded from the first-run route", async () => {
    session.manageAccess = true;
    const fetchMock = stubFetch();
    render(await DashboardPage());

    expect(screen.getByRole("heading", { name: "See your memory work." })).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/onboarding/first-run", expect.anything());
    expect(await screen.findByText("0 of 3 done")).toBeTruthy();
  });
});
