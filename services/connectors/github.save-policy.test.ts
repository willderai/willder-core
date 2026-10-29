// What a GitHub sync saves, against the connector policy's GitHub row: every
// "Save" item lands, and no "Don't save" item does. The repository is
// messyRepository(), served the way api.github.com serves it.
//
// Save: PR title, description, state, linked issues and the reviews that
// decide something; issue title, body, labels, state and comments; commit
// messages; README, docs, ADRs, CONTRIBUTING, CHANGELOG; the file tree (paths
// only); the login as author. Don't save: source code bodies, diffs, CI logs,
// author emails, any secret.

import { afterEach, describe, expect, it, vi } from "vitest";
import { listRepositoryItems, type GitHubListing, type GitHubSyncCursor } from "./github";
import {
  awsKeyShapedSecret,
  fakeGitHub,
  messyRepository,
  tokenShapedSecret,
  type FakeRepositoryState,
} from "./fixtures/github";

const REPO = "example-org/lantern";
const NOW = Date.parse("2026-10-14T20:00:00Z");

afterEach(() => vi.unstubAllGlobals());

async function sync(
  state: FakeRepositoryState = messyRepository(REPO),
  cursor: GitHubSyncCursor | null = null,
  stored: string[] = [],
): Promise<GitHubListing & { requests: string[] }> {
  const github = fakeGitHub(state);
  vi.stubGlobal("fetch", vi.fn(github.fetch));
  const listing = await listRepositoryItems(REPO, "test-token", { cursor, stored, now: NOW });
  return { ...listing, requests: github.requests.map((r) => r.path) };
}

const text = (listing: GitHubListing, id: string) => listing.items.find((i) => i.id === id)?.text;
const all = (listing: GitHubListing) => listing.items.map((i) => i.text).join("\n\n");

describe("GitHub sync: what is saved", () => {
  it("saves a pull request's title, description, state and linked issues", async () => {
    const listing = await sync();
    const pr = text(listing, "pr-201");
    expect(pr).toContain("Pull request #201 (draft; gql → main): WIP: switch to GraphQL");
    expect(pr).toContain("Linked issues: #101");
    expect(text(listing, "pr-202")).toContain("(merged;");
  });

  it("saves the reviews that decide something, and drops the ones that do not", async () => {
    const listing = await sync();
    const reviews = listing.items.filter((i) => i.id.startsWith("review-"));
    expect(reviews.map((r) => r.id).sort()).toEqual(["review-7001", "review-7003", "review-7004"]);
    expect(text(listing, "review-7001")).toBe(
      "Review of pull request #201 by dev-blake: commented\n\nWe decided GraphQL waits until the REST client is stable.",
    );
    expect(text(listing, "review-7003")).toContain(
      "changes requested\n\nBlocking: the cache must be keyed by repository",
    );
    // An approval with no text still says who approved; a deleted account falls back to the owner.
    expect(text(listing, "review-7004")).toBe("Review of pull request #202 by example-org: approved.");
    expect(all(listing)).not.toContain("typo on line 3");
    expect(all(listing)).not.toContain("Draft thoughts, not submitted");
  });

  it("saves an issue's title, body, labels and state, and its comments", async () => {
    const listing = await sync();
    expect(text(listing, "issue-101")).toContain(
      "Issue #101 (open; bug, good first issue): Crash when a title has emoji",
    );
    expect(text(listing, "comment-9001")).toBe(
      "Comment on issue #101 by dev-avery:\n\nReproduced on Safari too. Reach me at [email removed] if you need a trace.",
    );
  });

  it("keeps a pull request conversation comment only when it decides something", async () => {
    const listing = await sync();
    expect(text(listing, "comment-9003")).toContain(
      "Comment on pull request #202 by dev-blake:\n\nAgreed: we will keep the LRU at 500 entries",
    );
    expect(listing.items.some((i) => i.id === "comment-9002")).toBe(false);
    // A comment with no body has nothing to keep.
    expect(listing.items.some((i) => i.id === "comment-9004")).toBe(false);
  });

  it("saves commit messages with the account login as author", async () => {
    const listing = await sync();
    const commits = listing.items.filter((i) => i.id.startsWith("commit-"));
    expect(commits).toHaveLength(5);
    expect(commits[1].text).toContain("Brief: keep emoji in titles 🚀");
    expect(commits[1].author).toBe("dev-avery");
  });

  it("saves the ADR, CONTRIBUTING, CHANGELOG and docs, each labelled and linked to GitHub", async () => {
    const listing = await sync();
    const adr = text(listing, "doc:docs/adr/0001-review-threads-in-postgres.md");
    expect(adr).toContain(
      `Decision record docs/adr/0001-review-threads-in-postgres.md in ${REPO} (https://github.com/${REPO}/blob/main/docs/adr/0001-review-threads-in-postgres.md)`,
    );
    expect(adr).toContain(
      "We decided to keep review threads in Postgres instead of Redis, because briefs must survive a restart.",
    );
    expect(text(listing, "doc:CONTRIBUTING.md")).toMatch(
      /^Contribution rules CONTRIBUTING\.md [\s\S]*Every pull request needs one approval/,
    );
    expect(text(listing, "doc:CHANGELOG.md")).toMatch(/^Changelog CHANGELOG\.md [\s\S]*Briefs keep emoji in titles/);
    expect(text(listing, "doc:docs/setup.md")).toMatch(/^Document docs\/setup\.md /);
  });

  it("saves the file tree as paths only", async () => {
    const listing = await sync();
    expect(text(listing, "tree")).toBe(
      [
        `File tree of ${REPO} (paths only, part 1 of 1)`,
        "",
        ".github/workflows/ci.yml",
        "CHANGELOG.md",
        "CONTRIBUTING.md",
        "README.md",
        "docs/adr/0001-review-threads-in-postgres.md",
        "docs/setup.md",
        "src/brief.ts",
      ].join("\n"),
    );
  });
});

describe("GitHub sync: what is never saved", () => {
  it("never reads source code bodies, diffs or CI logs", async () => {
    const listing = await sync();
    expect(all(listing)).not.toContain("summarizeDiffForReviewers");
    expect(all(listing)).not.toContain("runs-on: ubuntu-latest");
    expect(listing.items.some((i) => i.id.startsWith("doc:src/") || i.id.startsWith("doc:.github/workflows"))).toBe(
      false,
    );
    // Only the doc blobs are fetched, never the code's, and nothing on GitHub's diff, patch or Actions paths.
    const blobs = listing.requests.filter((path) => path.includes("/git/blobs/"));
    expect(blobs).toHaveLength(4);
    expect(
      listing.requests.some((path) => /\.(diff|patch)$|\/actions\/|\/pulls\/\d+\/(files|comments)$/.test(path)),
    ).toBe(false);
  });

  it("never saves an email address, a commit trailer's included", async () => {
    const listing = await sync();
    expect(all(listing)).not.toMatch(/@example\.com/);
    expect(listing.items.find((i) => i.text.includes("Co-authored-by"))?.text).toContain(
      "Co-authored-by: Zoë Example <[email removed]>",
    );
  });

  it("never saves an email address as an author, when a git author name is one", async () => {
    const state = messyRepository(REPO);
    state.commits[2].commit.author = {
      name: "laptop@example.com",
      email: "laptop@example.com",
      date: "2026-10-14T10:10:00Z",
    };
    const listing = await sync(state);
    expect(listing.items.map((i) => i.author)).not.toContain("laptop@example.com");
    expect(listing.items.find((i) => i.id === `commit-${state.commits[2].sha}`)?.author).toBe("[email removed]");
  });

  it("never saves a secret, in the README or in a doc", async () => {
    const listing = await sync();
    expect(all(listing)).not.toContain(tokenShapedSecret());
    expect(all(listing)).not.toContain(awsKeyShapedSecret());
    expect(text(listing, "doc:docs/setup.md")).toContain("AWS_ACCESS_KEY_ID=[secret removed]");
  });

  it("never saves a secret or an email address a doc's path holds, in the line that names the doc", async () => {
    const state = messyRepository(REPO);
    state.files["docs/ops@example.com/setup.md"] = "# Setup\n\nAsk ops.";
    state.files[`docs/${awsKeyShapedSecret()}/notes.md`] = "# Notes\n\nKeep it short.";
    const listing = await sync(state);
    const docs = listing.items
      .filter((i) => i.id.startsWith("doc:docs/") && i.id.endsWith(".md"))
      .map((i) => i.text.split("\n", 1)[0]);
    expect(docs.join("\n")).not.toMatch(/@example\.com|%40example\.com/);
    expect(docs.join("\n")).not.toContain(awsKeyShapedSecret());
    expect(docs.some((line) => line.includes("docs/[email removed]/setup.md"))).toBe(true);
  });

  // A GitHub item's first two lines are its heading, which the memory service stores verbatim
  // (no extraction in between), so whatever the scan misses there is served word for word.
  it.each<[string, (state: FakeRepositoryState) => void, RegExp]>([
    [
      "the default branch's name, in a doc's link",
      (state) => {
        state.repo.default_branch = `rel-${awsKeyShapedSecret()}`;
      },
      new RegExp(awsKeyShapedSecret()),
    ],
    [
      "a percent-encoded address in a doc's path",
      (state) => {
        state.files["docs/ops%40example.com/a.md"] = "# A\n\nb";
      },
      /ops%(?:25)?40example\.com/i,
    ],
    [
      "a percent-encoded address on a doc's first line",
      (state) => {
        state.files["docs/contact.md"] = "Write to [ops](mailto:ops%40example.com) first\n\nb";
      },
      /ops%40example\.com/i,
    ],
  ])("never saves a secret or an email address held in %s", async (_where, plant, leaked) => {
    const state = messyRepository(REPO);
    plant(state);
    expect(all(await sync(state))).not.toMatch(leaked);
  });
});

describe("GitHub sync: docs, the tree and reviews across syncs", () => {
  it("reads a doc again only when its blob changed, and keeps an unchanged one without reading it", async () => {
    const state = messyRepository(REPO);
    const first = await sync(state);
    const stored = first.items.map((i) => i.id);
    state.files["CHANGELOG.md"] += "\n## 1.3.0\n\n- Reviews that decide something are kept.\n";

    const second = await sync(state, first.cursor, stored);
    expect(second.items.filter((i) => i.id.startsWith("doc")).map((i) => i.id)).toEqual(["doc:CHANGELOG.md"]);
    expect(second.requests.filter((path) => path.includes("/git/blobs/"))).toHaveLength(1);
    expect(second.gone.filter((id) => id.startsWith("doc") || id.startsWith("tree"))).toEqual([]);
  });

  it("names a deleted doc gone, but not when the tree came back cut short", async () => {
    const state = messyRepository(REPO);
    const first = await sync(state);
    const stored = first.items.map((i) => i.id);
    delete state.files["CONTRIBUTING.md"];

    state.treeTruncated = true;
    expect((await sync(state, first.cursor, stored)).gone).toEqual([]);
    state.treeTruncated = false;
    expect((await sync(state, first.cursor, stored)).gone).toEqual(["doc:CONTRIBUTING.md"]);
  });

  it("names every tree and doc item gone when the token loses Contents, and reads every doc again once it is back", async () => {
    const state = messyRepository(REPO);
    const first = await sync(state);
    const stored = first.items.map((i) => i.id);
    state.forbidden.add("contents");

    const lost = await sync(state, first.cursor, stored);
    expect(lost.unreadable).toEqual(["files"]);
    expect(lost.gone.sort()).toEqual(stored.filter((id) => id === "tree" || id.startsWith("doc")).sort());
    expect(lost.cursor.docs).toEqual({});
    expect(lost.heldCursor.docs).toEqual({});
  });

  it("queues the reviews of pull requests past one sync's reads for the next", async () => {
    const state = messyRepository(REPO);
    const cursor: GitHubSyncCursor = {
      ...(await sync(state)).cursor,
      reviewQueue: Array.from({ length: 35 }, (_, i) => 300 + i),
    };
    const next = await sync(state, cursor);
    // 30 read from the queue in order; the 5 left wait for the next sync. No
    // pull request changed since the first sync, so none joins them.
    expect(
      next.requests.filter((path) => path.endsWith("/reviews")).map((path) => Number(path.split("/").at(-2))),
    ).toEqual(Array.from({ length: 30 }, (_, i) => 300 + i));
    expect(next.cursor.reviewQueue).toEqual([330, 331, 332, 333, 334]);
    // A sync whose item failed reads the same queue again.
    expect(next.heldCursor.reviewQueue).toEqual(cursor.reviewQueue);
  });

  it("syncs an empty repository with no tree and no error", async () => {
    const state = messyRepository(REPO);
    state.files = {};
    state.readme = null;
    const listing = await sync(state, null, ["tree", "doc:CHANGELOG.md"]);
    expect(listing.items.some((i) => i.id === "tree")).toBe(false);
    expect(listing.unreadable).toEqual([]);
    expect(listing.gone.sort()).toEqual(["doc:CHANGELOG.md", "tree"]);
  });
});
