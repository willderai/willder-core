// @vitest-environment jsdom
// The GitHub connect form against a controlled fetch: what it sends (the token in the
// body, never a URL), what it shows of a token's breadth and of the picked repository,
// that an answer for an earlier token, search or pick is never shown, and that only a
// picked repository can be connected. github-connect-form.contract.test.tsx drives the
// same form through the real routes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { GitHubConnectForm, breadthLines, reachLine, repoFullName, type RepositoryPage } from "./github-connect-form";
import type { GitHubRepositorySummary, GitHubTokenBreadth } from "@/services/connectors/github-token-probe";

const TOKEN_A = ["github", "_pat_", "AAAA", "a".repeat(78)].join("");
const TOKEN_B = ["github", "_pat_", "BBBB", "b".repeat(78)].join("");

const FINE: GitHubTokenBreadth = {
  kind: "fine-grained",
  scopes: null,
  canWrite: "unknown",
  writeScopes: [],
  expiresAt: null,
};

function repo(fullName: string, extra: Partial<GitHubRepositorySummary> = {}): GitHubRepositorySummary {
  return {
    fullName,
    private: false,
    visibility: "public",
    description: null,
    archived: false,
    fork: false,
    pushedAt: "2026-10-14T18:31:02Z",
    ...extra,
  };
}

/** A listing GitHub did not filter for SAML single sign-on. */
const NO_SSO = { ssoPartialResults: false, ssoWithheldOrganizations: 0, ssoWithheldOrganizationIds: [] };

function page(rows: GitHubRepositorySummary[], extra: Partial<RepositoryPage> = {}): RepositoryPage {
  return {
    token: FINE,
    reached: rows.length,
    truncated: false,
    ...NO_SSO,
    rows,
    total: rows.length,
    page: 1,
    pageSize: 20,
    ...extra,
  };
}

type Call = { url: string; body: Record<string, unknown>; resolve: (res: Response) => void };
let calls: Call[] = [];

/** A fetch whose every answer the test gives by hand, in any order. */
function controlledFetch() {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (url: string, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")), resolve });
        }),
    ),
  );
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function callsTo(path: string) {
  return calls.filter((c) => c.url === path);
}

async function answer(call: Call | undefined, res: Response) {
  if (!call) throw new Error("no such request");
  await act(async () => call.resolve(res));
}

function renderForm(onConnect = vi.fn(), busy = false) {
  render(<GitHubConnectForm busy={busy} onConnect={onConnect} onCancel={() => {}} />);
  return onConnect;
}

function typeToken(token: string) {
  fireEvent.change(screen.getByLabelText("Token"), { target: { value: token } });
}

async function findWith(token: string) {
  const before = callsTo("/api/sources/github/repositories").length;
  typeToken(token);
  fireEvent.click(screen.getByRole("button", { name: "Find repositories" }));
  await waitFor(() => expect(callsTo("/api/sources/github/repositories").length).toBe(before + 1));
  return callsTo("/api/sources/github/repositories").at(-1)!;
}

const connectButton = () => screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement;

beforeEach(() => {
  controlledFetch();
  window.history.replaceState(null, "", "/integrations");
});

afterEach(() => vi.unstubAllGlobals());

describe("repoFullName", () => {
  it.each([
    ["acme/widgets", "acme/widgets"],
    ["  acme/widgets  ", "acme/widgets"],
    ["https://github.com/acme/widgets", "acme/widgets"],
    ["https://github.com/acme/widgets.git", "acme/widgets"],
    ["github.com/acme/widgets/", "acme/widgets"],
    ["https://www.github.com/acme/my.repo?tab=readme", "acme/my.repo"],
  ])("reads %j as %j", (input, expected) => {
    expect(repoFullName(input)).toBe(expected);
  });

  it("leaves anything else as typed", () => {
    expect(repoFullName("https://gitlab.com/acme/widgets")).toBe("https://gitlab.com/acme/widgets");
    expect(repoFullName("https://github.com/acme/widgets/tree/main")).toBe("https://github.com/acme/widgets/tree/main");
  });
});

describe("breadthLines", () => {
  it("a classic token that can write warns twice: it can change and it reaches more than one", () => {
    const lines = breadthLines({
      token: { kind: "classic", scopes: ["repo", "read:org"], canWrite: "yes", writeScopes: ["repo"], expiresAt: null },
      reached: 1_000,
      truncated: false,
      ...NO_SSO,
    });
    expect(lines[0]).toEqual({ tone: "info", text: "Classic token · lists 1,000 repositories" });
    expect(lines.filter((l) => l.tone === "warning").map((l) => l.text)).toEqual([
      expect.stringMatching(/can change things at GitHub \(scope repo\)/),
      expect.stringMatching(/^It lists 1,000 repositories\. Willder reads only the one you pick/),
    ]);
  });

  it("a fine-grained token for one repository warns about nothing, and says GitHub hides its permissions", () => {
    const lines = breadthLines({
      token: { ...FINE, expiresAt: "2026-11-14T00:00:00Z" },
      reached: 1,
      truncated: false,
      ...NO_SSO,
    });
    expect(lines.every((l) => l.tone === "info")).toBe(true);
    expect(lines[0].text).toBe("Fine-grained token · lists 1 repository · expires Nov 14, 2026");
    expect(lines[1].text).toMatch(/does not show a fine-grained token's permissions/);
  });

  it("read-only classic scopes are named; no scopes at all say public only", () => {
    expect(
      breadthLines({
        token: { kind: "classic", scopes: ["read:org"], canWrite: "no", writeScopes: [], expiresAt: null },
        reached: 1,
        truncated: false,
        ...NO_SSO,
      })[1].text,
    ).toBe("Read-only scopes: read:org.");
    expect(
      breadthLines({
        token: { kind: "classic", scopes: [], canWrite: "no", writeScopes: [], expiresAt: null },
        reached: 1,
        truncated: false,
        ...NO_SSO,
      })[1].text,
    ).toMatch(/public repositories only/);
  });

  it("a scope that changes things outside repositories is named as one, never as read-only", () => {
    const lines = breadthLines({
      token: {
        kind: "classic",
        scopes: ["read:org", "delete_repo", "admin:org"],
        canWrite: "yes",
        writeScopes: ["delete_repo", "admin:org"],
        expiresAt: null,
      },
      reached: 1,
      truncated: false,
      ...NO_SSO,
    });
    expect(lines[1]).toEqual({
      tone: "warning",
      text: expect.stringContaining("can change things at GitHub (scopes delete_repo, admin:org)"),
    });
    expect(lines.some((l) => l.text.startsWith("Read-only"))).toBe(false);
  });

  it("an app token whose permissions GitHub does not show is a warning, not reassurance", () => {
    const lines = breadthLines({
      token: { kind: "github-app", scopes: [], canWrite: "unknown", writeScopes: [], expiresAt: null },
      reached: 1,
      truncated: false,
      ...NO_SSO,
    });
    expect(lines[1]).toMatchObject({ tone: "warning", text: expect.stringMatching(/not a personal access token/) });
  });

  it("a listing that stopped at its cap never reads as the whole count", () => {
    const lines = breadthLines({ token: FINE, reached: 2_000, truncated: true, ...NO_SSO });
    expect(lines[0].text).toContain("lists more than 2,000 repositories");
    expect(lines.at(-1)!.text).toMatch(/first 2,000 repositories by name\. Search owner\/name/);
  });
});

describe("breadthLines, for a listing GitHub filtered for SAML single sign-on", () => {
  const CLASSIC_REPO: GitHubTokenBreadth = {
    kind: "classic",
    scopes: ["repo"],
    canWrite: "yes",
    writeScopes: ["repo"],
    expiresAt: null,
  };
  const SSO_LINE = /withheld (its|their) repositories: authorize this token for SSO at GitHub to include them\.$/;

  it("puts the withheld organizations right after the count, so the count never reads as all of them", () => {
    const lines = breadthLines({
      token: CLASSIC_REPO,
      reached: 12,
      truncated: false,
      ssoPartialResults: true,
      ssoWithheldOrganizations: 2,
    });
    expect(lines[0].text).toBe("Classic token · lists 12 repositories");
    expect(lines[1]).toEqual({
      tone: "warning",
      text: "2 organizations withheld their repositories: authorize this token for SSO at GitHub to include them.",
    });
  });

  it("says one organization in the singular", () => {
    const lines = breadthLines({
      token: CLASSIC_REPO,
      reached: 12,
      truncated: false,
      ssoPartialResults: true,
      ssoWithheldOrganizations: 1,
    });
    expect(lines[1].text).toBe(
      "1 organization withheld its repositories: authorize this token for SSO at GitHub to include them.",
    );
  });

  it("warns a token that lists one repository reaches more when SSO withheld others", () => {
    const lines = breadthLines({
      token: CLASSIC_REPO,
      reached: 1,
      truncated: false,
      ssoPartialResults: true,
      ssoWithheldOrganizations: 2,
    });
    expect(lines.some((l) => l.tone === "warning" && /A token limited to that repository is safer/.test(l.text))).toBe(
      true,
    );
  });

  it("never says the listed count is all the token reaches when SSO withheld some", () => {
    const lines = breadthLines({
      token: CLASSIC_REPO,
      reached: 12,
      truncated: false,
      ssoPartialResults: true,
      ssoWithheldOrganizations: 2,
    });
    const breadth = lines.find((l) => /Willder reads only the one you pick/.test(l.text))!;
    expect(breadth.text).toMatch(/^It lists 12 repositories, and more once SSO allows it\./);
  });

  it("still warns when GitHub withheld results without naming an organization", () => {
    const lines = breadthLines({
      token: CLASSIC_REPO,
      reached: 12,
      truncated: false,
      ssoPartialResults: true,
      ssoWithheldOrganizations: 0,
    });
    expect(lines[1]).toEqual({
      tone: "warning",
      text: "At least one organization withheld its repositories: authorize this token for SSO at GitHub to include them.",
    });
  });

  it("warns for a token that lists nothing because every repository was withheld", () => {
    const lines = breadthLines({
      token: CLASSIC_REPO,
      reached: 0,
      truncated: false,
      ssoPartialResults: true,
      ssoWithheldOrganizations: 3,
    });
    expect(lines[0].text).toBe("Classic token · lists 0 repositories");
    expect(lines[1].text).toMatch(/^3 organizations withheld their repositories/);
  });

  it("says nothing about SSO when GitHub withheld nothing", () => {
    const lines = breadthLines({ token: CLASSIC_REPO, reached: 12, truncated: true, ...NO_SSO });
    expect(lines.some((l) => SSO_LINE.test(l.text) || /SSO/.test(l.text))).toBe(false);
  });

  it.each(["fine-grained", "classic", "oauth-app", "github-app", "unknown"] as const)(
    "says a %s token lists its repositories, never that it can read only those",
    (kind) => {
      const lines = breadthLines({ token: { ...FINE, kind }, reached: 3, truncated: false, ...NO_SSO });
      expect(lines.some((l) => /can read 3/.test(l.text))).toBe(false);
      expect(lines.some((l) => l.text.startsWith("It lists 3 repositories."))).toBe(true);
    },
  );
});

describe("reachLine", () => {
  it("names each unreadable part and the permission that would include it, once each", () => {
    expect(reachLine("acme/widgets", ["readme", "commits"]).text).toBe(
      "It cannot read the README, docs, the file tree, and commits of acme/widgets, so a sync skips them. Give the token read access to Contents to include them.",
    );
    expect(reachLine("acme/widgets", ["issues", "pulls"]).text).toBe(
      "It cannot read issues with their comments and pull requests with their reviews of acme/widgets, so a sync skips them. Give the token read access to Issues and Pull requests to include them.",
    );
    expect(reachLine("acme/widgets", [])).toMatchObject({ tone: "info" });
  });

  it("names every part a sync reads when the token reads them all", () => {
    expect(reachLine("acme/widgets", []).text).toBe(
      "It can read the README, docs, the file tree (paths only), issues with their comments, pull requests with their reviews, and commits of acme/widgets.",
    );
  });

  it("names each part once and each permission once when nothing is readable", () => {
    expect(reachLine("acme/widgets", ["readme", "issues", "pulls", "commits"]).text).toBe(
      "It cannot read the README, docs, the file tree, issues with their comments, pull requests with their reviews, and commits of acme/widgets, so a sync skips them. Give the token read access to Contents, Issues, and Pull requests to include them.",
    );
  });

  it("says one part on its own without a list", () => {
    expect(reachLine("acme/widgets", ["commits"]).text).toBe(
      "It cannot read commits of acme/widgets, so a sync skips them. Give the token read access to Contents to include them.",
    );
  });
});

describe("GitHubConnectForm", () => {
  it("has no repository field to type into: a repository is picked from what the token lists", () => {
    renderForm();
    expect(screen.queryByLabelText("Repository")).toBeNull();
    expect(screen.getByLabelText("Token").getAttribute("type")).toBe("password");
    expect(connectButton().disabled).toBe(true);
  });

  it("sends the trimmed token in the request body, never in a URL", async () => {
    renderForm();
    const call = await findWith(`  ${TOKEN_A}  `);
    expect(call.url).toBe("/api/sources/github/repositories");
    expect(call.body).toEqual({ token: TOKEN_A, sort: "pushed", order: "desc", page: 1 });
    expect(window.location.href).not.toContain(TOKEN_A);
  });

  it("finds with Enter in the token field, and keeps the Enter from submitting the form", async () => {
    renderForm();
    typeToken(TOKEN_A);
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    screen.getByLabelText("Token").dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    await waitFor(() => expect(callsTo("/api/sources/github/repositories")).toHaveLength(1));
  });

  it("names each repository's radio by its full name, with its visibility and push date as the description", async () => {
    renderForm();
    await answer(
      await findWith(TOKEN_A),
      json(
        page([repo("acme/widgets", { private: true, visibility: "private", archived: true, description: "Widgets." })]),
      ),
    );
    const radio = screen.getByRole("radio", { name: "acme/widgets" });
    expect(document.getElementById(radio.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Private · pushed Oct 14, 2026 · archived · Widgets.",
    );
  });

  it("lists, picks and connects the picked repository with the token", async () => {
    const onConnect = renderForm();
    await answer(
      await findWith(TOKEN_A),
      json(page([repo("acme/widgets"), repo("acme/gadgets", { private: true, visibility: "private" })])),
    );

    expect(screen.getByRole("group", { name: "What this token reaches" }).textContent).toContain(
      "Fine-grained token · lists 2 repositories",
    );
    expect(connectButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /acme\/gadgets/ }));
    await waitFor(() => expect(callsTo("/api/sources/github/reach")).toHaveLength(1));
    expect(callsTo("/api/sources/github/reach")[0].body).toEqual({ token: TOKEN_A, repo: "acme/gadgets" });

    fireEvent.click(connectButton());
    expect(onConnect).toHaveBeenCalledExactlyOnceWith({ type: "github", repo: "acme/gadgets", token: TOKEN_A });
  });

  it("warns about a broad token and still lets it connect", async () => {
    const onConnect = renderForm();
    await answer(
      await findWith(TOKEN_A),
      json(
        page([repo("acme/widgets")], {
          token: { kind: "classic", scopes: ["repo"], canWrite: "yes", writeScopes: ["repo"], expiresAt: null },
          reached: 1_000,
          total: 1_000,
        }),
      ),
    );
    const breadth = screen.getByRole("group", { name: "What this token reaches" }).textContent ?? "";
    expect(breadth).toMatch(/can change things at GitHub/);
    expect(breadth).toMatch(/It lists 1,000 repositories\./);
    fireEvent.click(screen.getByRole("radio", { name: /acme\/widgets/ }));
    fireEvent.click(connectButton());
    expect(onConnect).toHaveBeenCalledOnce();
  });

  it("shows what the token cannot read in the picked repository", async () => {
    renderForm();
    await answer(await findWith(TOKEN_A), json(page([repo("acme/widgets")])));
    fireEvent.click(screen.getByRole("radio", { name: /acme\/widgets/ }));
    await waitFor(() => expect(callsTo("/api/sources/github/reach")).toHaveLength(1));
    await answer(callsTo("/api/sources/github/reach")[0], json({ repo: repo("acme/widgets"), unreadable: ["issues"] }));
    expect(
      screen.getByText(/cannot read issues with their comments of acme\/widgets, so a sync skips them/),
    ).toBeTruthy();
  });

  it("never shows a late answer about an earlier pick under the current one", async () => {
    renderForm();
    await answer(await findWith(TOKEN_A), json(page([repo("acme/one"), repo("acme/two")])));
    fireEvent.click(screen.getByRole("radio", { name: /acme\/one/ }));
    await waitFor(() => expect(callsTo("/api/sources/github/reach")).toHaveLength(1));
    fireEvent.click(screen.getByRole("radio", { name: /acme\/two/ }));
    await waitFor(() => expect(callsTo("/api/sources/github/reach")).toHaveLength(2));
    const [first, second] = callsTo("/api/sources/github/reach");
    await answer(second, json({ repo: repo("acme/two"), unreadable: [] }));
    await answer(first, json({ repo: repo("acme/one"), unreadable: ["pulls"] }));
    expect(screen.queryByText(/cannot read pull requests/)).toBeNull();
    expect(
      screen.getByText(
        /can read the README, docs, the file tree \(paths only\), issues with their comments, pull requests with their reviews, and commits of acme\/two/,
      ),
    ).toBeTruthy();
  });

  it("clears the list and the pick when the token is edited, and never shows the old token's late answer", async () => {
    const onConnect = renderForm();
    const first = await findWith(TOKEN_A);
    const second = await findWith(TOKEN_B);
    expect(second.body.token).toBe(TOKEN_B);
    await answer(second, json(page([repo("beta/only")])));
    await answer(first, json(page([repo("acme/late")])));
    expect(screen.queryByRole("radio", { name: /acme\/late/ })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /beta\/only/ }));
    expect(connectButton().disabled).toBe(false);

    typeToken(TOKEN_A);
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByText("Picked")).toBeNull();
    expect(connectButton().disabled).toBe(true);
    fireEvent.submit(screen.getByRole("form", { name: "Connect a GitHub repository" }));
    expect(onConnect).not.toHaveBeenCalled();
  });

  it("asks the server to search, sends a pasted address as owner/name, and never shows an earlier search's late answer", async () => {
    renderForm();
    await answer(await findWith(TOKEN_A), json(page([repo("acme/widgets")], { reached: 40, total: 40 })));
    const search = screen.getByRole("searchbox", { name: "Search repositories" });

    fireEvent.change(search, { target: { value: "acme" } });
    await waitFor(() => expect(callsTo("/api/sources/github/repositories")).toHaveLength(2));
    fireEvent.change(search, { target: { value: "https://github.com/acme/gadgets.git" } });
    await waitFor(() => expect(callsTo("/api/sources/github/repositories")).toHaveLength(3));
    const [, older, newer] = callsTo("/api/sources/github/repositories");
    expect(older.body.q).toBe("acme");
    expect(newer.body).toMatchObject({ q: "acme/gadgets", page: 1 });

    await answer(newer, json(page([repo("acme/gadgets")], { reached: 40, total: 1 })));
    await answer(older, json(page([repo("acme/stale")], { reached: 40, total: 9 })));
    expect(screen.queryByRole("radio", { name: /acme\/stale/ })).toBeNull();
    expect(screen.getByRole("radio", { name: /acme\/gadgets/ })).toBeTruthy();
  });

  it("keeps an Enter in the search box from submitting the connect", async () => {
    renderForm();
    await answer(await findWith(TOKEN_A), json(page([repo("acme/widgets")])));
    fireEvent.click(screen.getByRole("radio", { name: /acme\/widgets/ }));
    const search = screen.getByRole("searchbox", { name: "Search repositories" });
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    search.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
  });

  it("keeps the search and the page out of the URL, even a token pasted into the search box", async () => {
    renderForm();
    const rows = Array.from({ length: 20 }, (_, i) => repo(`acme/r${i}`));
    await answer(await findWith(TOKEN_A), json(page(rows, { reached: 45, total: 45 })));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search repositories" }), { target: { value: TOKEN_B } });
    await waitFor(() => expect(callsTo("/api/sources/github/repositories")).toHaveLength(2));
    await answer(callsTo("/api/sources/github/repositories")[1], json(page(rows, { reached: 45, total: 45 })));
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(callsTo("/api/sources/github/repositories")).toHaveLength(3));
    expect(window.location.search).toBe("");
    expect(window.location.href).not.toContain(TOKEN_B);
  });

  it("shows no rows from the previous search while the next one loads", async () => {
    renderForm();
    await answer(await findWith(TOKEN_A), json(page([repo("acme/widgets")], { reached: 40, total: 40 })));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search repositories" }), { target: { value: "zeta" } });
    await waitFor(() => expect(callsTo("/api/sources/github/repositories")).toHaveLength(2));
    expect(screen.queryByRole("radio", { name: "acme/widgets" })).toBeNull();
    expect(screen.getByText("Loading repositories…")).toBeTruthy();
  });

  it("shows no earlier token's breadth while a new token's listing loads", async () => {
    renderForm();
    await answer(
      await findWith(TOKEN_A),
      json(
        page([repo("acme/widgets")], {
          token: { kind: "classic", scopes: ["repo"], canWrite: "yes", writeScopes: ["repo"], expiresAt: null },
        }),
      ),
    );
    await findWith(TOKEN_B);
    expect(screen.queryByRole("group", { name: "What this token reaches" })).toBeNull();
    expect(screen.getByText("Checking what this token can reach…")).toBeTruthy();
  });

  it("shows no earlier pick's reach while the next pick is checked", async () => {
    renderForm();
    await answer(await findWith(TOKEN_A), json(page([repo("acme/one"), repo("acme/two")])));
    fireEvent.click(screen.getByRole("radio", { name: "acme/one" }));
    await waitFor(() => expect(callsTo("/api/sources/github/reach")).toHaveLength(1));
    await answer(callsTo("/api/sources/github/reach")[0], json({ repo: repo("acme/one"), unreadable: ["pulls"] }));
    fireEvent.click(screen.getByRole("radio", { name: "acme/two" }));
    expect(screen.queryByText(/cannot read pull requests with their reviews of acme\/one/)).toBeNull();
    expect(screen.getByText("Checking what it can read in acme/two…")).toBeTruthy();
  });

  it("checks a pick again after a refused check", async () => {
    renderForm();
    await answer(await findWith(TOKEN_A), json(page([repo("acme/one")])));
    fireEvent.click(screen.getByRole("radio", { name: "acme/one" }));
    await waitFor(() => expect(callsTo("/api/sources/github/reach")).toHaveLength(1));
    await answer(
      callsTo("/api/sources/github/reach")[0],
      json(
        { error: "GitHub did not answer (HTTP 502). Try again in a minute.", reason: "unavailable", retryAt: null },
        502,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(callsTo("/api/sources/github/reach")).toHaveLength(2));
    await answer(callsTo("/api/sources/github/reach")[1], json({ repo: repo("acme/one"), unreadable: [] }));
    expect(
      screen.getByText(
        /can read the README, docs, the file tree \(paths only\), issues with their comments, pull requests with their reviews, and commits of acme\/one/,
      ),
    ).toBeTruthy();
  });

  it("pages on the server and keeps the pick across pages", async () => {
    renderForm();
    const rows = Array.from({ length: 20 }, (_, i) => repo(`acme/r${i}`));
    await answer(await findWith(TOKEN_A), json(page(rows, { reached: 45, total: 45 })));
    expect(screen.getByText(/1–20 of 45 repositories/)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "acme/r3" }));
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(callsTo("/api/sources/github/repositories")).toHaveLength(2));
    expect(callsTo("/api/sources/github/repositories")[1].body.page).toBe(2);
    expect(screen.getByText("Picked").parentElement?.textContent).toBe("Picked acme/r3");
    expect(screen.getByRole("group", { name: "What this token reaches" })).toBeTruthy();
  });

  it("shows GitHub's refusal, offers to try again, and connects nothing", async () => {
    const onConnect = renderForm();
    await answer(
      await findWith(TOKEN_A),
      json(
        {
          error: "GitHub rejected this token. Check it was copied whole and has not expired or been revoked.",
          reason: "token-rejected",
          retryAt: null,
        },
        400,
      ),
    );
    expect(screen.getByRole("alert").textContent).toMatch(/GitHub rejected this token/);
    expect(screen.queryByRole("radiogroup")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(callsTo("/api/sources/github/repositories")).toHaveLength(2));
    expect(callsTo("/api/sources/github/repositories")[1].body).toEqual(
      callsTo("/api/sources/github/repositories")[0].body,
    );
    expect(onConnect).not.toHaveBeenCalled();
  });

  it("says when GitHub allows more after a rate limit", async () => {
    renderForm();
    await answer(
      await findWith(TOKEN_A),
      json(
        {
          error: "GitHub's rate limit for this token is used up. Try again later.",
          reason: "rate-limited",
          retryAt: "2026-10-15T14:05:00Z",
        },
        429,
      ),
    );
    expect(screen.getByRole("alert").textContent).toMatch(/rate limit .* GitHub allows more after \d{1,2}:\d{2}/);
  });

  it("shows the SSO line beside the count on screen", async () => {
    renderForm();
    await answer(
      await findWith(TOKEN_A),
      json(
        page([repo("acme/widgets")], {
          token: { kind: "classic", scopes: ["repo"], canWrite: "yes", writeScopes: ["repo"], expiresAt: null },
          ssoPartialResults: true,
          ssoWithheldOrganizations: 2,
          ssoWithheldOrganizationIds: ["21955855", "20582480"],
        }),
      ),
    );
    const lines = within(screen.getByRole("group", { name: "What this token reaches" }))
      .getAllByRole("paragraph")
      .map((p) => p.textContent);
    expect(lines.slice(0, 2)).toEqual([
      "Classic token · lists 1 repository",
      "2 organizations withheld their repositories: authorize this token for SSO at GitHub to include them.",
    ]);
  });

  it("checks again, reading GitHub afresh, after the person authorizes the token for SSO", async () => {
    renderForm();
    const first = await findWith(TOKEN_A);
    expect(first.body).not.toHaveProperty("refresh");
    await answer(
      first,
      json(
        page([repo("acme/widgets")], {
          ssoPartialResults: true,
          ssoWithheldOrganizations: 1,
          ssoWithheldOrganizationIds: ["7"],
        }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(callsTo("/api/sources/github/repositories")).toHaveLength(2));
    const second = callsTo("/api/sources/github/repositories")[1];
    expect(second.body).toMatchObject({ token: TOKEN_A, refresh: true });
    await answer(second, json(page([repo("acme/widgets"), repo("octo/payments")])));
    expect(screen.queryByText(/withheld/)).toBeNull();
    expect(screen.getByRole("button", { name: "Find repositories" }).hasAttribute("disabled")).toBe(true);
  });

  it("asks GitHub afresh only for the check, not for the pages read after it", async () => {
    renderForm();
    const rows = Array.from({ length: 25 }, (_, i) => repo(`acme/r${String(i).padStart(2, "0")}`));
    await answer(
      await findWith(TOKEN_A),
      json(
        page(rows.slice(0, 20), {
          reached: 25,
          total: 25,
          ssoPartialResults: true,
          ssoWithheldOrganizations: 1,
          ssoWithheldOrganizationIds: ["7"],
        }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(callsTo("/api/sources/github/repositories")).toHaveLength(2));
    await answer(
      callsTo("/api/sources/github/repositories")[1],
      json(page(rows.slice(0, 20), { reached: 25, total: 25 })),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(callsTo("/api/sources/github/repositories")).toHaveLength(3));
    expect(callsTo("/api/sources/github/repositories")[2].body).toMatchObject({ page: 2 });
    expect(callsTo("/api/sources/github/repositories")[2].body).not.toHaveProperty("refresh");
  });

  const SSO_PAGE = { ssoPartialResults: true, ssoWithheldOrganizations: 1, ssoWithheldOrganizationIds: ["7"] };
  const listingCalls = () => callsTo("/api/sources/github/repositories");
  const checkAgainButton = () => screen.getByRole("button", { name: "Check again" }) as HTMLButtonElement;

  it("keeps Check again on screen but disabled while its check loads, Enter included, and offers it again after", async () => {
    renderForm();
    await answer(await findWith(TOKEN_A), json(page([repo("acme/widgets")], SSO_PAGE)));
    fireEvent.click(checkAgainButton());
    await waitFor(() => expect(listingCalls()).toHaveLength(2));
    expect(checkAgainButton().disabled).toBe(true);
    fireEvent.keyDown(screen.getByLabelText("Token"), { key: "Enter" });
    await act(async () => {});
    expect(listingCalls()).toHaveLength(2);
    await answer(listingCalls()[1], json(page([repo("acme/widgets")], SSO_PAGE)));
    expect(checkAgainButton().disabled).toBe(false);
    fireEvent.click(checkAgainButton());
    await waitFor(() => expect(listingCalls()).toHaveLength(3));
    expect(listingCalls()[2].body).toMatchObject({ refresh: true });
  });

  it.each([
    [
      "the route refuses it",
      (call: Call) => answer(call, json({ error: "Too many repository lookups. Try again in a few minutes." }, 429)),
    ],
    [
      "the connection fails",
      (call: Call) => answer(call, Promise.reject(new TypeError("Failed to fetch")) as unknown as Response),
    ],
  ])("reads GitHub afresh on Try again when %s during Check again", async (_, fail) => {
    renderForm();
    await answer(await findWith(TOKEN_A), json(page([repo("acme/widgets")], SSO_PAGE)));
    fireEvent.click(checkAgainButton());
    await waitFor(() => expect(listingCalls()).toHaveLength(2));
    await fail(listingCalls()[1]);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(listingCalls()).toHaveLength(3));
    expect(listingCalls()[2].body).toMatchObject({ page: 1, refresh: true });
  });

  it("does not read GitHub afresh on Try again after a plain read failed", async () => {
    renderForm();
    await answer(await findWith(TOKEN_A), json({ error: "GitHub did not answer. Try again in a minute." }, 502));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(listingCalls()).toHaveLength(2));
    expect(listingCalls()[1].body).not.toHaveProperty("refresh");
  });

  it("does not read GitHub afresh after the token is edited away and pasted back", async () => {
    renderForm();
    await answer(await findWith(TOKEN_A), json(page([repo("acme/widgets")], SSO_PAGE)));
    fireEvent.click(checkAgainButton());
    await waitFor(() => expect(listingCalls()).toHaveLength(2));
    await answer(listingCalls()[1], json(page([repo("acme/widgets")], SSO_PAGE)));
    typeToken(TOKEN_B);
    const again = await findWith(TOKEN_A);
    expect(again.body).toMatchObject({ token: TOKEN_A, page: 1 });
    expect(again.body).not.toHaveProperty("refresh");
  });

  it("says why the list is empty when SSO withheld every repository, instead of saying the token lists none", async () => {
    renderForm();
    await answer(
      await findWith(TOKEN_A),
      json(page([], { ssoPartialResults: true, ssoWithheldOrganizations: 1, ssoWithheldOrganizationIds: ["7"] })),
    );
    expect(screen.queryByText(/This token lists no repositories\. Search/)).toBeNull();
    expect(screen.getByText(/Nothing to pick until the token is authorized for SSO at GitHub/)).toBeTruthy();
  });

  it("says plainly when the token lists nothing", async () => {
    renderForm();
    await answer(await findWith(TOKEN_A), json(page([])));
    expect(screen.getByText(/This token lists no repositories/)).toBeTruthy();
  });

  it("sends nothing while a connect is already in flight", async () => {
    const onConnect = renderForm(vi.fn(), true);
    await answer(await findWith(TOKEN_A), json(page([repo("acme/widgets")])));
    fireEvent.click(screen.getByRole("radio", { name: /acme\/widgets/ }));
    fireEvent.submit(screen.getByRole("form", { name: "Connect a GitHub repository" }));
    expect(onConnect).not.toHaveBeenCalled();
  });

  it("keeps each form's token field apart when two are on the page", () => {
    render(
      <>
        <GitHubConnectForm busy={false} onConnect={() => {}} onCancel={() => {}} />
        <GitHubConnectForm busy={false} onConnect={() => {}} onCancel={() => {}} />
      </>,
    );
    const [first, second] = screen.getAllByRole("form", { name: "Connect a GitHub repository" });
    const a = within(first!).getByLabelText("Token");
    const b = within(second!).getByLabelText("Token");
    expect(a).not.toBe(b);
    expect(a.id).not.toBe(b.id);
  });
});

describe("repository pager freshness", () => {
  beforeEach(() => controlledFetch());
  it.each([200, 403, 500])("keeps focus when a page ends in %s, including a shrunken empty result", async (status) => {
    renderForm();
    await answer(await findWith(TOKEN_A), json(page([repo("acme/first")], { reached: 45, total: 45 })));
    const next = screen.getByRole("button", { name: "Next page" });
    next.focus();
    fireEvent.click(next);
    await waitFor(() => expect(callsTo("/api/sources/github/repositories")).toHaveLength(2));
    expect(document.activeElement).toBe(next);
    const nav = screen.getByRole("navigation", { name: "Pages of repositories" });
    expect(nav.textContent).toContain("Loading page 2");
    expect(nav.textContent).not.toContain(" of ");
    fireEvent.click(next);
    expect(callsTo("/api/sources/github/repositories")).toHaveLength(2);
    await answer(
      callsTo("/api/sources/github/repositories")[1],
      status === 200 ? json(page([], { reached: 0, total: 0, page: 2 })) : json({ error: "Listing refused" }, status),
    );
    expect(document.activeElement).toBe(next);
    expect(nav.getAttribute("aria-busy")).toBe("false");
    expect(nav.textContent).not.toMatch(/21–0|Page 2 of 1/);
    expect(next.getAttribute("aria-disabled")).toBe("true");
    if (status !== 200) expect(nav.textContent).not.toContain(" of ");
  });

  it("hides old breadth during Check again and resets pagination for a new token", async () => {
    renderForm();
    await answer(
      await findWith(TOKEN_A),
      json(page([repo("acme/first")], { reached: 45, total: 45, ssoPartialResults: true })),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(callsTo("/api/sources/github/repositories")).toHaveLength(2));
    await answer(
      callsTo("/api/sources/github/repositories")[1],
      json(page([repo("acme/second")], { reached: 45, total: 45, page: 2, ssoPartialResults: true })),
    );
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(callsTo("/api/sources/github/repositories")).toHaveLength(3));
    expect(screen.queryByText(/lists 45 repositories/)).toBeNull();
    typeToken(TOKEN_B);
    fireEvent.click(screen.getByRole("button", { name: "Find repositories" }));
    await waitFor(() => expect(callsTo("/api/sources/github/repositories")).toHaveLength(4));
    expect(callsTo("/api/sources/github/repositories")[3].body.page).toBe(1);
    expect(screen.queryByRole("navigation", { name: "Pages of repositories" })).toBeNull();
  });
});

describe("token editing invalidates repository answers", () => {
  beforeEach(() => controlledFetch());
  it("does not resurrect an old answer after the same token is pasted again", async () => {
    renderForm();
    await answer(await findWith(TOKEN_A), json(page([repo("acme/first")], { reached: 45, total: 45 })));
    typeToken("");
    typeToken(TOKEN_A);
    fireEvent.click(screen.getByRole("button", { name: "Find repositories" }));
    await waitFor(() => expect(callsTo("/api/sources/github/repositories")).toHaveLength(2));
    expect(screen.queryByRole("radio", { name: "acme/first" })).toBeNull();
    expect(screen.queryByText(/lists 45 repositories/)).toBeNull();
  });
});

describe("empty repository pages", () => {
  beforeEach(() => controlledFetch());
  it("reports a fresh total without inventing rows for an empty in-range answer", async () => {
    renderForm();
    await answer(await findWith(TOKEN_A), json(page([], { reached: 45, total: 45 })));
    expect(screen.getByText("45 repositories total")).toBeTruthy();
    expect(screen.queryByText(/1–20 of/)).toBeNull();
  });
});

describe("returning to a previous reach request", () => {
  it.each(["token", "pick"])("requires a new reach answer after revisiting the %s", async (change) => {
    renderForm();
    const rows = [repo("acme/first"), repo("acme/second")];
    await answer(await findWith(TOKEN_A), json(page(rows)));
    fireEvent.click(screen.getByRole("radio", { name: "acme/first" }));
    await waitFor(() => expect(callsTo("/api/sources/github/reach")).toHaveLength(1));
    await answer(callsTo("/api/sources/github/reach")[0], json({ unreadable: [] }));
    if (change === "token") {
      typeToken("");
      await answer(await findWith(TOKEN_A), json(page(rows)));
    } else {
      fireEvent.click(screen.getByRole("radio", { name: "acme/second" }));
      await waitFor(() => expect(callsTo("/api/sources/github/reach")).toHaveLength(2));
    }
    fireEvent.click(screen.getByRole("radio", { name: "acme/first" }));
    const count = change === "token" ? 2 : 3;
    await waitFor(() => expect(callsTo("/api/sources/github/reach")).toHaveLength(count));
    expect(screen.getByText("Checking what it can read in acme/first…")).toBeTruthy();
    expect(screen.queryByText(/The token can read/)).toBeNull();
    await answer(callsTo("/api/sources/github/reach")[count - 1], json({ error: "Reach refused" }, 403));
    expect(screen.getByText("Reach refused")).toBeTruthy();
  });
});

describe("returning to a previous repository view", () => {
  it.each([false, true])("requires a fresh answer when empty=%s and its query returns", async (empty) => {
    renderForm();
    await answer(await findWith(TOKEN_A), json(page(empty ? [] : [repo("acme/first")], { reached: 45, total: 45 })));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "new-search" } });
    await waitFor(() => expect(callsTo("/api/sources/github/repositories")).toHaveLength(2));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    await waitFor(() => expect(callsTo("/api/sources/github/repositories")).toHaveLength(3));
    expect(screen.queryByRole("radio", { name: "acme/first" })).toBeNull();
    expect(screen.queryByText(/This token lists no repositories/)).toBeNull();
    const nav = screen.getByRole("navigation", { name: "Pages of repositories" });
    expect(nav.textContent).toContain("Loading page 1");
    expect(nav.textContent).not.toContain(" of ");
    expect(within(nav).getByRole("button", { name: "Next page" }).getAttribute("aria-disabled")).toBe("true");
    await answer(callsTo("/api/sources/github/repositories")[2], json(page([repo("acme/fresh")])));
    await answer(callsTo("/api/sources/github/repositories")[1], json(page([repo("acme/late")])));
    expect(screen.getByRole("radio", { name: "acme/fresh" })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "acme/late" })).toBeNull();
  });
});
