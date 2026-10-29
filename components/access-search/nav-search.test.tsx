// @vitest-environment jsdom
//
// The sidebar search box: what it shows for each kind the server answers, how
// it shows a kind the server refused, and that an older query's late answer
// never replaces the current one.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children?: unknown; onClick?: () => void }) =>
    createElement("a", { href, ...props }, children as never),
}));
const push = vi.fn();
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard", useRouter: () => ({ push }) }));

import { NavSearch } from "./nav-search";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const empty = { denied: false, items: [], hasMore: false };

function results(overrides: Record<string, unknown>) {
  return { scopes: empty, agents: empty, tokens: empty, sources: empty, audit: empty, ...overrides };
}

function renderBox() {
  render(createElement(NavSearch, { collapsed: false, onExpand: () => {}, onNavigate: () => {} }));
  return screen.getByRole("searchbox", { name: "Search scopes, agents, tokens, sources and audit" });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  push.mockReset();
});

describe("NavSearch", () => {
  it("groups matches by kind and links each to where it lives", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(
          results({
            scopes: { denied: false, hasMore: true, items: [{ id: "s1", name: "Sales", path: "org_1.dept_sales" }] },
            tokens: {
              denied: false,
              hasMore: false,
              items: [{ id: "cmg6k2m1p0001l804a7f3x9qz", agentId: "qa-agent", status: "active" }],
            },
            audit: {
              denied: false,
              hasMore: false,
              items: [
                {
                  id: "a1",
                  actorName: "qa-agent",
                  action: "memory.read",
                  target: "org_1.dept_sales",
                  decision: "deny",
                },
              ],
            },
          }),
        ),
      ),
    );
    fireEvent.change(renderBox(), { target: { value: "sales" } });

    const panel = await screen.findByRole("region", { name: "Search results" });
    await within(panel).findByText("Sales");
    expect(within(panel).getByText("Sales").closest("a")?.getAttribute("href")).toBe("/access?tab=scopes&q=Sales");
    expect(within(panel).getByText("1+")).toBeTruthy();
    expect(within(panel).getByText("See all on Access").getAttribute("href")).toBe("/access?tab=scopes&q=sales");
    expect(within(panel).getByText("Token a7f3x9qz").closest("a")?.getAttribute("href")).toBe(
      "/access?tab=tokens&q=a7f3x9qz",
    );
    const auditHit = within(panel).getByText("qa-agent").closest("a");
    expect(auditHit?.textContent?.startsWith("Denied: qa-agent · memory.read")).toBe(true);
  });

  it("draws an audit hit's writer whole-marked: the action beside it cannot push the marker off", async () => {
    const writer = 'Architecture agent Agent (agent key "custom-1")';
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(
          results({
            audit: {
              denied: false,
              hasMore: false,
              items: [
                {
                  id: "a1",
                  actorName: writer,
                  action: "memory.write.effect.with.a.long.name",
                  target: "org_1",
                  decision: "deny",
                },
              ],
            },
          }),
        ),
      ),
    );
    fireEvent.change(renderBox(), { target: { value: "arch" } });
    const panel = await screen.findByRole("region", { name: "Search results" });
    await within(panel).findByText("Architecture agent Agent");
    const marker = within(panel).getByText((_, el) => el?.textContent === ' (agent key "custom-1")');
    expect(marker.className).toContain("shrink-0");
    expect(within(panel).getByText("Architecture agent Agent").className).toContain("truncate");
  });

  it("names a refused kind as not searched instead of implying no matches", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(
          results({
            scopes: { denied: true },
            tokens: { denied: true },
            audit: { denied: true },
            sources: { denied: true },
            agents: {
              denied: false,
              hasMore: false,
              items: [{ id: "g1", name: "Researcher", agentKey: "research-agent" }],
            },
          }),
        ),
      ),
    );
    fireEvent.change(renderBox(), { target: { value: "res" } });

    expect(
      await screen.findByText("Not searched: scopes, tokens, sources, audit rows. Your role cannot list them."),
    ).toBeTruthy();
    expect(screen.getByText("Researcher").closest("a")?.getAttribute("href")).toBe("/agents/g1");
  });

  it("keeps the newest query's answer when an older one arrives later", async () => {
    let releaseOld: () => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.endsWith("q=sa")) {
          return new Promise<Response>((resolve) => {
            releaseOld = () =>
              resolve(
                json(
                  results({
                    scopes: {
                      denied: false,
                      hasMore: false,
                      items: [{ id: "old", name: "Sandbox", path: "org_1.sandbox" }],
                    },
                  }),
                ),
              );
          });
        }
        return Promise.resolve(
          json(
            results({
              scopes: {
                denied: false,
                hasMore: false,
                items: [{ id: "new", name: "Sales", path: "org_1.dept_sales" }],
              },
            }),
          ),
        );
      }),
    );
    const box = renderBox();
    fireEvent.change(box, { target: { value: "sa" } });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    fireEvent.change(box, { target: { value: "sales" } });

    expect(await screen.findByText("Sales")).toBeTruthy();
    releaseOld();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText("Sandbox")).toBeNull();
    expect(screen.getByText("Sales")).toBeTruthy();
  });

  it("says when the search failed rather than showing no matches", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 500 })),
    );
    fireEvent.change(renderBox(), { target: { value: "sales" } });
    expect(await screen.findByText("Search failed. Try again.")).toBeTruthy();
  });

  it("opens the first match on Enter", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(
          results({
            agents: {
              denied: false,
              hasMore: false,
              items: [{ id: "g1", name: "Researcher", agentKey: "research-agent" }],
            },
          }),
        ),
      ),
    );
    const box = renderBox();
    fireEvent.change(box, { target: { value: "res" } });
    await screen.findByText("Researcher");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(push).toHaveBeenCalledWith("/agents/g1");
  });
});
