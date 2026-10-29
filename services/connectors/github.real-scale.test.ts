// The GitHub connector at real scale: 900 items in one repository, and a
// listing that shifts between syncs the way a busy repository's does.
//
// Each sync reads about two pages' worth of each kind from where the last one
// stopped, so a long history arrives over a few syncs, and nothing is retired
// for having slid off the newest page: an item leaves only when GitHub shows it
// is gone. Before this, a 50-item window retired every item newer ones pushed
// out of it. The issues endpoint also lists pull requests, so it reads on until
// it has its 200 issues, and the pull requests among them take none of those.

import { afterEach, describe, expect, it, vi } from "vitest";
import { listRepositoryItems, type GitHubSyncCursor } from "./github";
import {
  busyRepository,
  deleteIssues,
  fakeGitHub,
  gitHubIssue,
  pushCommits,
  touchIssues,
  type FakeRepositoryState,
} from "./fixtures/github";
import { planConnectorSync, type ConnectorSyncFile } from "@/lib/inngest/connector-records";

const TOKEN = "test-token";
const SCOPE = "org.example";
/** After every timestamp busyRepository writes, and before pushCommits' first. */
const START = Date.parse("2026-10-01T23:00:00Z");
const HALF_HOUR = 30 * 60_000;
/** Each test syncs a 900-item fake repository one awaited response at a time, which takes seconds on a loaded machine. */
const SYNC_TIMEOUT_MS = 60_000;

afterEach(() => vi.unstubAllGlobals());

/** Every item id the repository holds, as the connector names them. */
function upstreamIds(state: FakeRepositoryState): string[] {
  return [
    "readme",
    ...state.issues.map((i) => `issue-${i.number}`),
    ...state.pulls.map((p) => `pr-${p.number}`),
    ...state.commits.map((c) => `commit-${c.sha}`),
    // The file tree; busyRepository's only file is its README.
    "tree",
  ];
}

/** A source's sync records, kept the way the sync job keeps them: ingest what the plan says, retire what it says. */
class Store {
  records = new Map<string, ConnectorSyncFile>();
  cursor: GitHubSyncCursor | null = null;
  retired: string[] = [];
  ingested = 0;

  async sync(state: FakeRepositoryState, now: number) {
    const github = fakeGitHub(state);
    vi.stubGlobal("fetch", vi.fn(github.fetch));
    const listing = await listRepositoryItems(state.repo.full_name, TOKEN, {
      cursor: this.cursor,
      stored: [...this.records.keys()],
      now,
    });
    const plan = planConnectorSync([...this.records.values()], listing.items, SCOPE, listing.gone);
    for (const { item } of plan.toIngest) {
      this.records.set(item.id, {
        externalFileId: item.id,
        checksum: item.checksum,
        episodeId: `ep-${item.id}`,
        episodeScopePath: SCOPE,
      });
    }
    for (const file of plan.toRetire) {
      this.records.delete(file.externalFileId);
      this.retired.push(file.externalFileId);
    }
    this.ingested += plan.toIngest.length;
    this.cursor = listing.cursor;
    return { listing, plan, requests: github.requests };
  }
}

describe("listRepositoryItems on a 900-item repository", { timeout: SYNC_TIMEOUT_MS }, () => {
  it("reads 200 of each kind in the first sync, though every third entry on the issues endpoint is a pull request", async () => {
    const state = busyRepository();
    expect(state.commits.length + state.issues.length + state.pulls.length).toBe(900);

    const { listing, requests } = await new Store().sync(state, START);
    const count = (prefix: string) => listing.items.filter((i) => i.id.startsWith(prefix)).length;

    expect(count("commit-")).toBe(200);
    expect(count("pr-")).toBe(100);
    expect(count("issue-")).toBe(200);
    // repo, readme, then three pages of issues (the newest two, newest first,
    // then the oldest page: 300 entries, 200 of them issues), two of pulls,
    // which end on their second, one page of comments (there are none), and
    // two of commits; then the reviews of the first 30 pull requests listed,
    // the file tree, and the repository again, to confirm every 404 was not
    // lost access.
    expect(requests.map((r) => r.path.split("/").pop())).toEqual([
      "busy",
      "readme",
      "issues",
      "issues",
      "issues",
      "pulls",
      "pulls",
      "comments",
      "commits",
      "commits",
      ...Array(30).fill("reviews"),
      "main",
      "busy",
    ]);
  });

  it("stops asking for pages once it has 200 issues and has read one oldest-first page, so a sync takes at most 300", async () => {
    // 400 issues: the newest window brings 400 to 201, and the one oldest-first page 1 to 100.
    const state = busyRepository({ commits: 0, issues: 400, pulls: 0 });
    const { listing, requests } = await new Store().sync(state, START);
    expect(requests.filter((r) => r.path.endsWith("/issues"))).toHaveLength(3);
    expect(listing.items.filter((i) => i.id.startsWith("issue-"))).toHaveLength(300);
  });

  it("reads at most ten pages of the issues endpoint a sync, and reaches the issues past a longer run of pull requests on the next", async () => {
    // 1,198 pull requests, then five issues changed after all of them, so the
    // issues sit at the end of an oldest-change-first listing. The newest window
    // of the first sync brings them at once; the oldest-first read reaches them
    // on the second.
    const state = busyRepository({ commits: 0, issues: 0, pulls: 1_198 });
    const late = (n: number) => `2026-10-01T22:0${n}:00Z`;
    for (let n = 1; n <= 5; n++)
      state.issues.push(
        gitHubIssue(state.repo.full_name, 2_000 + n, { title: `Late issue ${n}`, updated_at: late(n) }),
      );
    const store = new Store();

    const first = await store.sync(state, START);
    expect(first.requests.filter((r) => r.path.endsWith("/issues"))).toHaveLength(10);
    expect(first.listing.items.filter((i) => i.id.startsWith("issue-")).map((i) => i.id)).toEqual([
      "issue-2005",
      "issue-2004",
      "issue-2003",
      "issue-2002",
      "issue-2001",
    ]);

    const second = await store.sync(state, START + HALF_HOUR);
    expect(second.listing.items.filter((i) => i.id.startsWith("issue-")).map((i) => i.id)).toEqual([
      "issue-2001",
      "issue-2002",
      "issue-2003",
      "issue-2004",
      "issue-2005",
    ]);
    expect(second.listing.cursor.issues).toEqual({ since: "2026-10-01T22:30:00Z" });
    expect(store.retired).toEqual([]);
  });
});

describe("syncs of a busy repository", { timeout: SYNC_TIMEOUT_MS }, () => {
  it("keeps every item that still exists upstream, however far newer ones push it down", async () => {
    const state = busyRepository();
    const store = new Store();
    await store.sync(state, START);

    pushCommits(state, 30, "board row after sync", 0);
    touchIssues(state, [1, 2, 4, 5, 7, 8, 10, 11, 13, 14], "2026-10-02T00:30:00Z"); // ten of the oldest issues get a comment
    for (let sync = 1; sync <= 6; sync++) await store.sync(state, START + sync * HALF_HOUR);

    expect(store.retired).toEqual([]);
    expect([...store.records.keys()].sort()).toEqual(upstreamIds(state).sort());
    expect(store.ingested).toBe(upstreamIds(state).length);
  });

  it("writes nothing on a sync that finds nothing changed", async () => {
    const state = busyRepository();
    const store = new Store();
    for (let sync = 0; sync < 5; sync++) await store.sync(state, START + sync * HALF_HOUR);
    const before = store.ingested;

    const quiet = await store.sync(state, START + 5 * HALF_HOUR);

    expect(quiet.plan.toIngest).toEqual([]);
    expect(quiet.plan.toRetire).toEqual([]);
    expect(store.ingested).toBe(before);
  });

  it("retires an issue deleted upstream once the deletion check reaches it, and nothing else", async () => {
    const state = busyRepository({ commits: 30, issues: 10, pulls: 5 });
    const store = new Store();
    await store.sync(state, START);
    deleteIssues(state, [4]);

    for (let sync = 1; sync <= 3; sync++) await store.sync(state, START + sync * HALF_HOUR);

    expect(store.retired).toEqual(["issue-4"]);
  });
});
