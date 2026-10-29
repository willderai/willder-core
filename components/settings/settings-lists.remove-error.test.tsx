// @vitest-environment jsdom
//
// Remove on the org roles and entity aliases lists. A delete the server refused,
// answered with an error page, or never answered keeps the row on screen and says
// why, with the add form closed; the list is read again only after the server
// confirms the delete. Before this, both panels ignored the answer and reloaded,
// so a refused delete looked like nothing happened.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
// The delete routes, run for real against an admin whom check() refuses a write at the
// org root, so the panel shows the body the route actually sends.
vi.mock("@/lib/access-context", () => ({
  requireAccessContext: async () => ({
    org: { id: "org_1" },
    user: { id: "u_reader", role: "admin" },
    ctx: { orgId: "org_1", actor: { type: "human", id: "u_reader", role: "admin" }, origin: "app" },
  }),
}));
vi.mock("@/services/access", async (importActual) => ({
  ...(await importActual<typeof import("@/services/access")>()),
  check: async () => ({ allowed: false, reason: "read grant only" }),
  recordRefusal: async () => undefined,
}));
vi.mock("@/lib/db", () => ({ db: {} }));

type DeleteRoute = (req: Request, at: { params: Promise<{ id: string }> }) => Promise<Response>;

/** The answer `DELETE` gives the read-only admin, as the panel receives it. */
async function refusedByRoute(DELETE: DeleteRoute) {
  const res = await DELETE(new Request("http://localhost", { method: "DELETE" }), {
    params: Promise.resolve({ id: "r1" }),
  });
  expect(res.status).toBe(403);
  return res;
}

type DeleteAnswer = () => Promise<Response>;

const ROLE = { id: "r1", role: "CTO", aliases: [], user: { id: "u1", name: "Ben", email: "ben@acme.test" } };
const ALIAS = {
  id: "a1",
  entityId: "u1",
  entityType: "user",
  canonicalName: "Ben Ito",
  aliases: ["Benny"],
  createdAt: "2026-10-01T00:00:00.000Z",
};

/** The paging fields a list route that pages its rows adds; ignored by one that does not. */
const ONE_PAGE = { total: 1, count: 1, page: 1, pageSize: 25 };

const PANELS = [
  {
    name: "org roles",
    list: "/api/settings/org-roles",
    item: "/api/settings/org-roles/r1",
    listBody: { roles: [ROLE], ...ONE_PAGE },
    label: "CTO",
    refused: "Could not remove CTO: only an admin with write access to the organization can change roles",
    render: async () => {
      const { OrgRolesPanel } = await import("./org-roles-panel");
      render(<OrgRolesPanel />);
    },
  },
  {
    name: "entity aliases",
    list: "/api/settings/aliases",
    item: "/api/settings/aliases/a1",
    listBody: { aliases: [ALIAS], ...ONE_PAGE },
    label: "Ben Ito",
    refused: "Could not remove Ben Ito: only an admin with write access to the organization can change aliases",
    render: async () => {
      const { AliasesPanel } = await import("./aliases-panel");
      render(<AliasesPanel />);
    },
  },
] as const;

/** Every request the panel made, as `METHOD path`, query string dropped. */
let requests: string[] = [];

function stubFetch(panel: (typeof PANELS)[number], answerDelete: DeleteAnswer) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = new URL(url, "http://localhost").pathname;
      requests.push(`${method} ${path}`);
      if (method === "DELETE") return answerDelete();
      if (path === panel.list) return Response.json(panel.listBody);
      return Response.json({});
    }),
  );
}

const listReads = (panel: (typeof PANELS)[number]) => requests.filter((r) => r === `GET ${panel.list}`).length;

beforeEach(() => {
  requests = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe.each(PANELS)("$name: Remove", (panel) => {
  async function clickRemove(answerDelete: DeleteAnswer) {
    stubFetch(panel, answerDelete);
    await panel.render();
    const row = (await screen.findByText(panel.label)).closest("tr")!;
    // The add form is closed: the state Remove is used in.
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "remove" }));
    await waitFor(() => expect(requests).toContain(`DELETE ${panel.item}`));
  }

  it.each([
    ["a refusal", async () => Response.json({ error: "admin required" }, { status: 403 }), "admin required"],
    ["a 404", async () => Response.json({ error: "not found" }, { status: 404 }), "not found"],
    [
      "an error page that is not JSON",
      async () => new Response("<html>bad gateway</html>", { status: 502 }),
      "the server answered 502",
    ],
    ["a JSON body without an error", async () => Response.json(null, { status: 500 }), "the server answered 500"],
    [
      "an error that is not text",
      async () => Response.json({ error: { code: 7 } }, { status: 400 }),
      "the server answered 400",
    ],
    [
      "a dropped connection",
      async () => {
        throw new TypeError("Failed to fetch");
      },
      "Failed to fetch",
    ],
  ] as const)("on %s, keeps the row and says why", async (_case, answerDelete, reason) => {
    await clickRemove(answerDelete);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(`Could not remove ${panel.label}: ${reason}`);
    const row = screen.getByText(panel.label).closest("tr")!;
    // The button is usable again, so the person can retry.
    expect((within(row).getByRole("button", { name: "remove" }) as HTMLButtonElement).disabled).toBe(false);
    // A paged list starts its reload on a zero-delay timer; let one fire if it was started.
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(listReads(panel)).toBe(1);
  });

  it("tells an admin who may only read the org root that removing needs write access, from the route's real answer", async () => {
    const { DELETE } = await (panel.name === "org roles"
      ? import("@/app/api/settings/org-roles/[id]/route")
      : import("@/app/api/settings/aliases/[id]/route"));
    await clickRemove(() => refusedByRoute(DELETE));

    expect((await screen.findByRole("alert")).textContent).toBe(panel.refused);
    expect(screen.getByText(panel.label)).toBeTruthy();
  });

  it("reads the list again after a confirmed delete, and clears an earlier error", async () => {
    let answer: DeleteAnswer = async () => Response.json({ error: "admin required" }, { status: 403 });
    await clickRemove(() => answer());
    await screen.findByRole("alert");

    answer = async () => Response.json({ deleted: true });
    fireEvent.click(within(screen.getByText(panel.label).closest("tr")!).getByRole("button", { name: "remove" }));

    await waitFor(() => expect(listReads(panel)).toBe(2));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
