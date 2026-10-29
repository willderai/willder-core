// @vitest-environment jsdom
//
// Settings › Members lists every member a page at a time from GET
// /api/settings/members, never only the first page Clerk's client returns, and
// searches, filters and orders there. These tests check what the panel asks for
// and how it shows each answer; the route's rule is proven against a real database
// in app/api/settings/members/members-list.realdb.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

let urlParams = new URLSearchParams();
vi.mock("next/navigation", () => ({ useSearchParams: () => urlParams }));

const removeMember = vi.fn(async () => ({}));
let clerkRole = "org:admin";
let clerkMembersCount = 57;
vi.mock("@clerk/nextjs", () => ({
  useOrganization: () => ({
    isLoaded: true,
    organization: { membersCount: clerkMembersCount, removeMember, inviteMembers: vi.fn() },
    membership: { role: clerkRole },
  }),
  useUser: () => ({ user: { id: "clerk_self" } }),
}));

import { OrgPanel } from "./org-panel";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** The polite live region of the toolbar: the count a screen reader hears. */
const liveCount = () => document.querySelector("[role='search'] [aria-live='polite']")?.textContent ?? "";

function member(n: number, role = "member") {
  return {
    id: `u${n}`,
    clerkId: n === 0 ? "clerk_self" : `clerk_${n}`,
    name: `Person ${n}`,
    email: `p${n}@acme.test`,
    role,
    joinedAt: "2026-10-01T00:00:00.000Z",
  };
}

let answer: (url: URL) => Response;
const memberRequests = () =>
  vi
    .mocked(fetch)
    .mock.calls.map(([url]) => new URL(String(url), "https://w.test"))
    .filter((u) => u.pathname === "/api/settings/members");

beforeEach(() => {
  urlParams = new URLSearchParams();
  window.history.replaceState(null, "", "/settings");
  clerkRole = "org:admin";
  clerkMembersCount = 57;
  removeMember.mockClear();
  answer = (url) => {
    const page = Number(url.searchParams.get("page"));
    const members = Array.from({ length: page < 3 ? 25 : 7 }, (_, i) => member((page - 1) * 25 + i));
    return json({ members, total: 57, memberCount: 57, page, pageSize: 25 });
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => answer(new URL(url, "https://w.test"))),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Members list", () => {
  it("lists every member a page at a time, not only the first 50", async () => {
    render(<OrgPanel />);
    expect(await screen.findByText("Person 1")).toBeTruthy();
    expect(screen.getByText("57 members")).toBeTruthy();
    expect(Object.fromEntries(memberRequests()[0]!.searchParams)).toEqual({ sort: "name", order: "asc", page: "1" });
    expect(screen.getByText("Page 1 of 3")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
    expect(await screen.findByText("Person 56")).toBeTruthy();
    expect(screen.getByText("51–57 of 57 members")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next page" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps the page in the URL, so a reload or link reopens it", async () => {
    const first = render(<OrgPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
    expect(await screen.findByText("Person 26")).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("members.page")).toBe("2");

    first.unmount();
    vi.mocked(fetch).mockClear();
    render(<OrgPanel />);
    expect(await screen.findByText("Person 26")).toBeTruthy();
    expect(memberRequests().map((u) => u.searchParams.get("page"))).toEqual(["2"]);
  });

  it("searches and filters by role on the server, from page 1, with the count of matches", async () => {
    answer = (url) =>
      url.searchParams.get("q") || url.searchParams.get("role")
        ? json({ members: [member(3, "admin")], total: 1, memberCount: 57, page: 1, pageSize: 25 })
        : json({
            members: [member(1)],
            total: 57,
            memberCount: 57,
            page: Number(url.searchParams.get("page")),
            pageSize: 25,
          });
    render(<OrgPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
    await waitFor(() => expect(memberRequests().at(-1)?.searchParams.get("page")).toBe("2"));

    fireEvent.change(screen.getByRole("searchbox", { name: "Search members" }), { target: { value: "person 3" } });
    expect(await screen.findByText("Person 3")).toBeTruthy();
    expect(memberRequests().at(-1)?.searchParams.get("q")).toBe("person 3");
    expect(memberRequests().at(-1)?.searchParams.get("page")).toBe("1");
    await waitFor(() => expect(liveCount()).toBe("1 of 57 members"));

    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    fireEvent.click(within(screen.getByRole("group", { name: "Role" })).getByRole("button", { name: "Admin" }));
    await waitFor(() => expect(memberRequests().at(-1)?.searchParams.get("role")).toBe("admin"));
  });

  it("removes a member through Clerk by their Clerk id, then reloads the page", async () => {
    render(<OrgPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove Person 2" }));
    await waitFor(() => expect(removeMember).toHaveBeenCalledWith("clerk_2"));
    await waitFor(() => expect(memberRequests().length).toBe(2));
    expect(screen.queryByRole("button", { name: "Remove Person 0" })).toBeNull();
  });

  it("offers the way back when a removal empties the last page", async () => {
    let remaining = 26;
    answer = (url) => {
      const page = Number(url.searchParams.get("page"));
      const members = Array.from({ length: remaining }, (_, i) => member(i)).slice((page - 1) * 25, page * 25);
      return json({ members, total: remaining, memberCount: remaining, page, pageSize: 25 });
    };
    removeMember.mockImplementation(async () => {
      remaining = 25;
      return {};
    });
    render(<OrgPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove Person 25" }));
    expect(await screen.findByText(/No members on this page/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to the first page" }));
    expect(await screen.findByText("Person 1")).toBeTruthy();
    expect(memberRequests().at(-1)?.searchParams.get("page")).toBe("1");
  });

  it("sends a shared link's overlong search cut to what the route accepts", async () => {
    urlParams = new URLSearchParams(`members.q=${"x".repeat(150)}%00`);
    render(<OrgPanel />);
    await waitFor(() => expect(memberRequests().at(-1)?.searchParams.get("q")).toBe("x".repeat(100)));
    expect((screen.getByRole("searchbox", { name: "Search members" }) as HTMLInputElement).maxLength).toBe(100);
  });

  it("offers no invite or remove to a member who is not an admin", async () => {
    clerkRole = "org:member";
    render(<OrgPanel />);
    await screen.findByText("Person 1");
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "+ Invite" })).toBeNull();
  });

  it("says the list could not load instead of showing no members", async () => {
    answer = () => json({ error: "boom" }, 500);
    render(<OrgPanel />);
    expect((await screen.findByRole("alert")).textContent).toContain("Could not load the members.");
    expect(screen.queryByText("No members yet.")).toBeNull();
    expect(screen.queryByText(/0 members/)).toBeNull();
  });

  it("says when Clerk counts members this list does not have yet", async () => {
    clerkMembersCount = 59;
    render(<OrgPanel />);
    expect(await screen.findByText(/2 more members have joined in your identity provider/)).toBeTruthy();
  });
});
