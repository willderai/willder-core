// @vitest-environment jsdom
//
// The connect feedback: where focus lands
// when the form a person was working in changes under them, and what the success line
// says on a reconnect (the case here: the repository was connected before).
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { gitHubProbeAnswer, pickGitHubRepository } from "./github-picker.testsupport";
import { sourcesPage } from "./sources-test-api";

const REPO = "acme/widgets";
const SCOPE = "org_acme.widgets_4d11a1";
const WIDENS = {
  error: "widens",
  code: "widening_not_acknowledged",
  widening: { status: "known", people: 1, agents: 2 },
  acknowledge: { people: 1, agents: 2 },
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

/** A reconnect: the repository was synced before, and this connect queued a new sync. */
const reconnected = {
  id: "s9",
  type: "github",
  name: REPO,
  scopePath: SCOPE,
  status: "active",
  createdAt: "2026-09-01T10:00:00Z",
  updatedAt: "2026-10-17T10:00:00Z",
  meta: { lastSyncAt: "2026-10-01T10:00:00Z", synced: 12, skipped: 0, syncRequestedAt: "2026-10-17T10:00:00Z" },
  _count: { files: 12 },
};

function serve(post: (body: Record<string, unknown>) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const probe = gitHubProbeAnswer(url, [REPO]);
      if (probe) return probe;
      if (init?.method === "POST") return post(JSON.parse(String(init.body)));
      return json(sourcesPage(url, [reconnected]));
    }),
  );
}

async function clickConnect(): Promise<HTMLElement> {
  const { SourcesPanel } = await import("./sources-panel");
  render(<SourcesPanel />);
  fireEvent.click(await screen.findByRole("button", { name: "+ Connect GitHub repository" }));
  await pickGitHubRepository("github_pat_secret", REPO);
  const form = screen.getByRole("form", { name: "Connect a GitHub repository" });
  fireEvent.click(within(form).getByRole("button", { name: "Connect" }));
  return form;
}

const connected = () =>
  json({ source: { id: "s9", type: "github", name: REPO, scopePath: SCOPE, status: "active" } }, 201);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("Connect feedback keeps the person's place", () => {
  it("Cancel on the widening question gives focus back to Connect, not to the page", async () => {
    serve(() => json(WIDENS, 409));
    const form = await clickConnect();
    fireEvent.click(within(await within(form).findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    await act(async () => {});
    expect(document.activeElement).toBe(within(form).getByRole("button", { name: "Connect" }));
  });

  it("a successful connect moves focus to the card under Just connected, not to the page", async () => {
    serve(connected);
    await clickConnect();
    const pinned = await screen.findByRole("region", { name: "Just connected" });
    await within(pinned).findByText("Sync queued");
    await act(async () => {});
    expect(pinned.contains(document.activeElement)).toBe(true);
  });

  it("the success line on a reconnect does not call its sync the first", async () => {
    serve(connected);
    await clickConnect();
    const line = await screen.findByText(new RegExp(`^${REPO} connected\\.`));
    expect(line.textContent).not.toMatch(/first sync/);
  });
});
