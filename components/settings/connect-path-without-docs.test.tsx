// @vitest-environment jsdom
//
// Criterion 3.10's check before a merge: a user connects a repository without reading
// documentation. The walk runs on the real panel and the real form, from the connect button to the
// connected row, and every step is one the screen itself asks for. It takes no outside knowledge:
// what kind of token, and which permissions, come from the form's own text.
//
// What this holds and does not: it holds the path a stand-in walks. It does not show that a stranger
// finds that path, and it never reaches the cited answer, so it does not replace the stand-in (rule 5).
// Stood in: the API, in sources-test-api's shape and the probe routes' (github-picker.testsupport).
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { gitHubProbeAnswer, pickGitHubRepository } from "./github-picker.testsupport";
import { sourcesPage } from "./sources-test-api";

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const WIDENS = {
  error: "widens",
  code: "widening_not_acknowledged",
  widening: { status: "known", people: 1, agents: 2 },
  acknowledge: { people: 1, agents: 2 },
};
const REPO = "acme/widgets";
const CONNECTED = {
  id: "s1",
  type: "github",
  name: REPO,
  scopePath: "org_acme.widgets",
  status: "active",
  meta: null,
  createdAt: "2026-10-01T00:00:00Z",
  _count: { files: 0 },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("connecting a repository from the screen alone", () => {
  it("walks from the button to the connected row, the form saying all it needs", async () => {
    const posts: Record<string, unknown>[] = [];
    let connected = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const probe = gitHubProbeAnswer(url, [REPO]);
        if (probe) return probe;
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          posts.push(body);
          if (!body.acknowledgeWidening) return json(WIDENS, 409);
          connected = true;
          return json({ source: CONNECTED }, 201);
        }
        return json(sourcesPage(url, connected ? [CONNECTED] : []));
      }),
    );
    const { SourcesPanel } = await import("./sources-panel");
    render(<SourcesPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "+ Connect GitHub repository" }));
    const form = screen.getByRole("form", { name: "Connect a GitHub repository" });

    // What to make and what it needs, on the form, before anything is typed.
    expect(form.textContent).toMatch(/fine-grained personal access token/);
    for (const permission of ["Contents", "Issues", "Pull requests", "Metadata"])
      expect(form.textContent).toContain(permission);
    expect(within(form).queryByRole("link", { name: /docs|documentation|guide/i })).toBeNull();

    await pickGitHubRepository("github_pat_secret", REPO, form);
    fireEvent.click(within(form).getByRole("button", { name: "Connect" }));

    // The one question the path asks is answered on the screen too.
    const question = await within(form).findByRole("alertdialog", { name: "Confirm who can read this source" });
    fireEvent.click(within(question).getByRole("button", { name: "Confirm and connect" }));

    await waitFor(() => expect(screen.queryByRole("form", { name: "Connect a GitHub repository" })).toBeNull());
    expect(await screen.findByText(REPO)).toBeTruthy();
    expect(posts.at(-1)).toMatchObject({ type: "github", repo: REPO, acknowledgeWidening: expect.anything() });
  });
});
