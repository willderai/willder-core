// @vitest-environment jsdom
//
// Save on the org roles and entity aliases panels. A save the server refused or
// failed shows why under the form: the server's own `error` text, or the status it
// answered with when the body is an error page or carries no text error. Before
// this, both panels parsed every answer as JSON, so a 500 error page showed a JSON
// parse error instead of a reason.
//
// Each case fills the form as a person does: the member comes from the picker's
// server search (type, then pick a match), since Save sends nothing until one is
// picked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));

const ONE_PAGE = { total: 0, count: 0, page: 1, pageSize: 25 };
const MEMBER = { id: "u1", name: "Sarah Nguyen", email: "sarah@co.com" };

/** Opens the member picker, types part of a name, and picks the match the server sent. */
async function pickMember(field: RegExp) {
  fireEvent.click(screen.getByRole("button", { name: field }));
  fireEvent.change(screen.getByRole("combobox", { name: /^Search / }), { target: { value: "Sarah" } });
  fireEvent.click(await screen.findByRole("option", { name: /Sarah Nguyen/ }));
}

const PANELS = [
  {
    name: "org roles",
    path: "/api/settings/org-roles",
    listBody: { roles: [], ...ONE_PAGE },
    open: "+ Add role",
    render: async () => {
      const { OrgRolesPanel } = await import("./org-roles-panel");
      render(<OrgRolesPanel />);
    },
    fill: async () => {
      fireEvent.change(screen.getByPlaceholderText(/e\.g\. CEO/), { target: { value: "CEO" } });
      await pickMember(/^Person:/);
    },
  },
  {
    name: "entity aliases",
    path: "/api/settings/aliases",
    listBody: { aliases: [], ...ONE_PAGE },
    open: "+ Add alias",
    render: async () => {
      const { AliasesPanel } = await import("./aliases-panel");
      render(<AliasesPanel />);
    },
    // Picking the member also fills the canonical name.
    fill: () => pickMember(/^Member:/),
  },
] as const;

let posts = 0;

function stubFetch(panel: (typeof PANELS)[number], answerSave: () => Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url, "http://localhost").pathname;
      if (init?.method === "POST") {
        posts += 1;
        return answerSave();
      }
      if (path === panel.path) return Response.json(panel.listBody);
      if (path === "/api/settings/members") {
        const q = new URL(url, "http://localhost").searchParams.get("q") ?? "";
        const members = MEMBER.name.toLowerCase().includes(q.toLowerCase()) ? [MEMBER] : [];
        return Response.json({ members, total: members.length });
      }
      return Response.json({});
    }),
  );
}

beforeEach(() => {
  posts = 0;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe.each(PANELS)("$name: Save", (panel) => {
  it.each([
    [
      "a refusal",
      async () =>
        Response.json(
          { error: "only an admin with write access to the organization can change things" },
          { status: 403 },
        ),
      "only an admin with write access to the organization can change things",
    ],
    [
      "an error page that is not JSON",
      async () => new Response("<html>internal error</html>", { status: 500 }),
      "the server answered 500",
    ],
    ["an empty error body", async () => new Response(null, { status: 500 }), "the server answered 500"],
    [
      "a JSON body without a text error",
      async () => Response.json({ error: { code: 7 } }, { status: 400 }),
      "the server answered 400",
    ],
  ] as const)("on %s, keeps the form open and says why", async (_case, answerSave, reason) => {
    stubFetch(panel, answerSave);
    await panel.render();
    fireEvent.click(await screen.findByRole("button", { name: panel.open }));
    await panel.fill();
    fireEvent.click(screen.getByRole("button", { name: /^Save/ }));

    await waitFor(() => expect(posts).toBe(1));
    expect(await screen.findByText(reason)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Save/ })).toBeTruthy();
  });
});
