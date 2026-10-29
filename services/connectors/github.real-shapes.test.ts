// The GitHub connector against payloads in GitHub's own shape (fixtures/github.ts):
// the mess a real repository carries, GitHub's rate-limit answers, and edits,
// renames and deletes across two syncs, the second reading from the first's cursor. github.test.ts covers the contract on
// minimal payloads; this file covers what production actually sends.

import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubConnectorError, listRepositoryItems, repositoryReaders } from "./github";
import {
  deleteIssues,
  fakeGitHub,
  gitHubRepo,
  messyRepository,
  oversizedGitHubReadme,
  tokenShapedSecret,
} from "./fixtures/github";
import { planConnectorSync, type ConnectorSyncFile } from "@/lib/inngest/connector-records";

const TOKEN = "test-token";
const REPO = "example-org/lantern";

afterEach(() => vi.unstubAllGlobals());

/** After every timestamp in messyRepository. */
const NOW = Date.parse("2026-10-14T13:00:00Z");

async function syncMessy(state = messyRepository(REPO), options: Parameters<typeof listRepositoryItems>[2] = {}) {
  const github = fakeGitHub(state);
  vi.stubGlobal("fetch", vi.fn(github.fetch));
  return { ...(await listRepositoryItems(REPO, TOKEN, { now: NOW, ...options })), requests: github.requests };
}

function textOf(items: { id: string; text: string }[], id: string): string {
  const item = items.find((i) => i.id === id);
  if (!item) throw new Error(`no item ${id}; have ${items.map((i) => i.id).join(", ")}`);
  return item.text;
}

describe("listRepositoryItems on a real-shaped repository", () => {
  it("asks for each kind newest first on a first sync, a page of 100 at a time, the commits no newer than the sync's start", async () => {
    const { requests } = await syncMessy();
    const lists = requests.filter((r) => /\/(issues|pulls|commits)$/.test(r.path));
    expect(lists.map((r) => [r.path.split("/").pop(), r.query])).toEqual([
      ["issues", { state: "all", sort: "updated", direction: "desc", per_page: "100", page: "1" }],
      ["pulls", { state: "all", sort: "updated", direction: "desc", per_page: "100", page: "1" }],
      ["commits", { per_page: "100", page: "1", until: "2026-10-14T13:00:00Z" }],
    ]);
  });

  it("keeps issues and pull requests apart, though the issues endpoint lists both", async () => {
    const { items, unreadable } = await syncMessy();
    expect(unreadable).toEqual([]);
    expect(items.filter((i) => i.id.startsWith("issue-")).map((i) => i.id)).toEqual([
      "issue-106",
      "issue-105",
      "issue-104",
      "issue-103",
      "issue-102",
      "issue-101",
    ]);
    expect(items.filter((i) => i.id.startsWith("pr-")).map((i) => i.id)).toEqual([
      "pr-205",
      "pr-204",
      "pr-203",
      "pr-202",
      "pr-201",
    ]);
  });

  it("names the author GitHub gives: a ghost, a bot, and the repository owner when there is none", async () => {
    const { items } = await syncMessy();
    const author = (id: string) => items.find((i) => i.id === id)?.author;
    expect(author("issue-102")).toBe("ghost");
    expect(author("issue-103")).toBe("dependabot[bot]");
    expect(author("issue-105")).toBe("example-org");
    expect(author("pr-204")).toBe("renovate[bot]");
  });

  it("states a pull request as draft, merged or closed from draft and merged_at", async () => {
    const { items } = await syncMessy();
    expect(textOf(items, "pr-201")).toMatch(/^Pull request #201 \(draft; gql → main\)/);
    expect(textOf(items, "pr-202")).toMatch(/^Pull request #202 \(merged;/);
    expect(textOf(items, "pr-203")).toMatch(/^Pull request #203 \(closed;/);
    expect(textOf(items, "pr-205")).toMatch(/\(open; patch-1 → main\)/);
  });

  it("writes a null body as nothing and clips a body over 8,000 characters", async () => {
    const { items } = await syncMessy();
    expect(textOf(items, "issue-102")).toBe("Issue #102 (closed): Old proposal from a deleted account");
    expect(textOf(items, "pr-203")).not.toContain("null");
    const long = textOf(items, "issue-104");
    expect(long).toHaveLength(8_001);
    expect(long.endsWith("…")).toBe(true);
  });

  it("keeps emoji, right-to-left text and labels intact", async () => {
    const { items } = await syncMessy();
    expect(textOf(items, "issue-101")).toContain(
      "Issue #101 (open; bug, good first issue): Crash when a title has emoji 🚀 or RTL text שלום",
    );
    const readme = items
      .filter((i) => i.id.startsWith("readme"))
      .map((i) => i.text)
      .join("\n");
    expect(readme).toContain("שלום עולם");
    expect(readme).toContain("東京, Zoë, Ångström");
  });

  it("keeps a multi-line commit message whole and falls back from account login to git author name to owner", async () => {
    const { items } = await syncMessy();
    const commits = items.filter((i) => i.id.startsWith("commit-"));
    expect(commits).toHaveLength(5);
    expect(commits[1].text).toContain("Co-authored-by: Zoë Example");
    expect(commits.map((c) => c.author)).toEqual([
      "dev-avery",
      "dev-avery",
      "Unmapped Laptop User",
      "github-actions[bot]",
      "example-org",
    ]);
    expect(commits[4].createdAt).toBeUndefined();
  });

  it("removes a token-shaped secret from the README before storage and keeps the line around it", async () => {
    const { items } = await syncMessy();
    const readme = items
      .filter((i) => i.id.startsWith("readme"))
      .map((i) => i.text)
      .join("\n");
    expect(readme).not.toContain(tokenShapedSecret());
    expect(readme).toContain("GITHUB_TOKEN=[secret removed]");
  });

  it("skips a README over 1 MB, which GitHub sends with encoding none and no content", async () => {
    const state = messyRepository(REPO);
    state.readme = oversizedGitHubReadme(REPO, 1_400_000);
    const { items, unreadable } = await syncMessy(state);
    expect(items.some((i) => i.id.startsWith("readme"))).toBe(false);
    expect(unreadable).toEqual([]);
  });

  it("fails the sync on either rate limit rather than reading it as a kind the token cannot see", async () => {
    for (const limit of ["primary", "secondary"] as const) {
      const state = messyRepository(REPO);
      state.rateLimited = limit;
      await expect(syncMessy(state)).rejects.toThrow(GitHubConnectorError);
    }
  });

  it("names a kind the token lacks permission for and still syncs the rest", async () => {
    const state = messyRepository(REPO);
    state.forbidden.add("pulls");
    const { items, unreadable } = await syncMessy(state);
    // Reviews follow their pull request, so GitHub's refusal of pull requests covers them.
    expect(unreadable).toEqual(["pulls"]);
    expect(items.some((i) => i.id.startsWith("pr-") || i.id.startsWith("review-"))).toBe(false);
    expect(items.some((i) => i.id.startsWith("issue-"))).toBe(true);
  });
});

describe("repositoryReaders on real-shaped repositories", () => {
  async function readersOf(repo: ReturnType<typeof gitHubRepo>) {
    const state = messyRepository(REPO);
    state.repo = repo;
    vi.stubGlobal("fetch", vi.fn(fakeGitHub(state).fetch));
    return repositoryReaders(REPO, TOKEN);
  }

  it("reads a public repository as readable by everyone, with or without the visibility field", async () => {
    expect(await readersOf(gitHubRepo(REPO))).toEqual({ kind: "known", readers: [{ kind: "everyone" }] });
    const withoutVisibility = gitHubRepo(REPO);
    delete withoutVisibility.visibility;
    expect(await readersOf(withoutVisibility)).toEqual({ kind: "known", readers: [{ kind: "everyone" }] });
  });

  it("reads a private or internal repository's readers as unknown", async () => {
    expect((await readersOf(gitHubRepo(REPO, { private: true }))).kind).toBe("unknown");
    expect((await readersOf(gitHubRepo(REPO, { private: true, visibility: "internal" }))).kind).toBe("unknown");
  });
});

describe("two syncs of one repository", () => {
  const SCOPE = "org.example";

  function recordsOf(items: { id: string; checksum: string }[]): ConnectorSyncFile[] {
    return items.map((i) => ({
      externalFileId: i.id,
      checksum: i.checksum,
      episodeId: `ep-${i.id}`,
      episodeScopePath: SCOPE,
    }));
  }

  it("re-ingests a renamed issue over its old episode, retires a deleted one and skips the rest", async () => {
    const state = messyRepository(REPO);
    const first = await syncMessy(state);

    const renamed = state.issues.find((i) => i.number === 101);
    if (!renamed) throw new Error("fixture lost issue 101");
    renamed.title = "Crash on astral-plane characters in titles";
    renamed.updated_at = "2026-10-14T13:10:00Z";
    deleteIssues(state, [106]);

    const stored = first.items.map((i) => i.id);
    const second = await syncMessy(state, { cursor: first.cursor, stored, now: NOW + 30 * 60_000 });
    const plan = planConnectorSync(recordsOf(first.items), second.items, SCOPE, second.gone);

    expect(plan.toIngest.map((p) => [p.item.id, p.previousEpisode?.episodeId])).toEqual([
      ["issue-101", "ep-issue-101"],
    ]);
    expect(plan.toRetire.map((f) => f.externalFileId)).toEqual(["issue-106"]);
    expect(plan.skippedCount).toBe(second.items.length - 1);
  });
});
