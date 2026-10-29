import { describe, it, expect, vi, afterEach } from "vitest";
import {
  initialCursor,
  isDocPath,
  itemHeading,
  listRepositoryItems,
  parseCursor,
  parseRepoFullName,
  readmeItems,
  GitHubConnectorError,
  type GitHubSyncCursor,
} from "./github";
import {
  busyRepository,
  deleteIssues,
  fakeGitHub,
  gitHubComment,
  gitHubIssue,
  messyRepository,
  pushCommits,
  touchIssues,
  type FakeRepositoryState,
} from "./fixtures/github";
import { SourceAccessError } from "./source-access";

const token = "test-token";

function mockFetch(routes: Record<string, { status?: number; body?: unknown }>) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    const path = new URL(url).pathname + (new URL(url).search ? "" : "");
    const key = Object.keys(routes).find((k) => path === k);
    const r = key ? routes[key] : { status: 404 };
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      json: async () => r.body,
      text: async () => JSON.stringify(r.body ?? ""),
    } as unknown as Response;
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("parseRepoFullName", () => {
  it("accepts owner/name and rejects anything else", () => {
    expect(parseRepoFullName("example-org/example-repo")).toEqual({ owner: "example-org", name: "example-repo" });
    for (const bad of ["willder", "a/b/c", "https://github.com/a/b", "", "a/b c", "a/..", "a/."]) {
      expect(() => parseRepoFullName(bad)).toThrow(GitHubConnectorError);
    }
  });
});

describe("listRepositoryItems", () => {
  it("lists README, issues (not PRs from the issues endpoint), PRs and commits with stable ids and checksums", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "/repos/o/r/readme": {
          body: { content: Buffer.from("# Lantern\nsummarizes PRs").toString("base64"), encoding: "base64" },
        },
        "/repos/o/r/issues": {
          body: [
            {
              number: 3,
              title: "Rate limit",
              body: "REST too low",
              state: "open",
              updated_at: "2026-09-22T01:00:00Z",
              user: { login: "a" },
              labels: [{ name: "bug" }],
            },
            {
              number: 4,
              title: "A PR in disguise",
              body: "",
              state: "open",
              updated_at: "2026-09-22T01:00:00Z",
              pull_request: {},
            },
          ],
        },
        "/repos/o/r/pulls": {
          body: [
            {
              number: 4,
              title: "Switch to GraphQL",
              body: "closes #3",
              state: "open",
              updated_at: "2026-09-22T02:00:00Z",
              user: { login: "b" },
              head: { ref: "gql" },
              base: { ref: "main" },
              merged_at: null,
            },
          ],
        },
        "/repos/o/r/commits": {
          body: [
            {
              sha: "abcdef1234567",
              commit: { message: "start REST client", author: { name: "B", date: "2026-09-22T00:30:00Z" } },
              author: { login: "b" },
            },
          ],
        },
        "/repos/o/r": { body: { full_name: "o/r", default_branch: "main" } },
      }),
    );
    const { items, unreadable } = await listRepositoryItems("o/r", token);
    expect(unreadable).toEqual([]);
    expect(items.map((i) => i.id)).toEqual(["readme", "issue-3", "pr-4", "commit-abcdef1234567"]);
    expect(items[1].text).toContain("bug");
    expect(items[2].text).toContain("gql → main");
    expect(items[1].createdAt).toBe("2026-09-22T01:00:00Z");
    expect(new Set(items.map((i) => i.checksum)).size).toBe(4);
  });

  // GitHub answers 404, not 403, to a token that cannot see a private repository,
  // and has no answer that tells that apart from a deleted one. Neither may retire.
  it.each([
    ["a 404", 404, { message: "Not Found" }],
    ["a permission 403", 403, { message: "Resource not accessible by personal access token" }],
    [
      "an SSO 403",
      403,
      {
        message:
          "Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization.",
      },
    ],
    [
      "a classic-token ban 403",
      403,
      {
        message:
          "`acme` forbids access via a personal access token (classic). Please use a GitHub App, OAuth App, or a personal access token with fine-grained permissions.",
      },
    ],
    [
      "a token-lifetime ban 403",
      403,
      {
        message:
          "The 'acme' organization forbids access via a fine-grained personal access tokens if the token's lifetime is greater than 366 days.",
      },
    ],
  ])(
    "reports %s for the repository itself as lost access naming the fix, never as everything gone",
    async (_case, status, body) => {
      vi.stubGlobal("fetch", mockFetch({ "/repos/o/r": { status, body } }));
      const listing = listRepositoryItems("o/r", token, { stored: ["readme", "issue-3", "commit-abc"] });
      await expect(listing).rejects.toThrow(SourceAccessError);
      await expect(listing).rejects.toThrow(/can't read o\/r.*Grant the token access to o\/r/);
    },
  );

  it.each([
    ["a rejected token", 401, { message: "Bad credentials" }],
    ["a rate limit", 403, { message: "API rate limit exceeded for user ID 1." }],
    ["a 5xx", 502, { message: "Bad Gateway" }],
  ])("fails the sync on %s for the repository, which a later attempt may get past", async (_case, status, body) => {
    vi.stubGlobal("fetch", mockFetch({ "/repos/o/r": { status, body } }));
    const listing = listRepositoryItems("o/r", token, { stored: ["readme"] });
    await expect(listing).rejects.toThrow(GitHubConnectorError);
    await expect(listing).rejects.not.toThrow(SourceAccessError);
  });

  it("requires a token", async () => {
    await expect(listRepositoryItems("o/r", "")).rejects.toThrow(GitHubConnectorError);
  });

  it("skips a kind the token has no permission for, names it, and still lists the rest", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "/repos/o/r": { body: { full_name: "o/r" } },
        "/repos/o/r/readme": { body: { content: Buffer.from("# Lantern").toString("base64"), encoding: "base64" } },
        "/repos/o/r/issues": { status: 403, body: { message: "Resource not accessible by personal access token" } },
        "/repos/o/r/commits": { body: [{ sha: "abcdef1234567", commit: { message: "init" } }] },
      }),
    );
    const { items, unreadable } = await listRepositoryItems("o/r", token);
    expect(items.map((i) => i.id)).toEqual(["readme", "commit-abcdef1234567"]);
    expect(unreadable).toEqual(["issues"]);
  });

  it("still fails the sync on a rate-limit 403, which is not a missing permission", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "/repos/o/r": { body: { full_name: "o/r" } },
        "/repos/o/r/issues": { status: 403, body: { message: "API rate limit exceeded for user ID 1." } },
      }),
    );
    await expect(listRepositoryItems("o/r", token)).rejects.toThrow(/403/);
  });

  it("never issues anything but GET", async () => {
    const f = mockFetch({ "/repos/o/r": { body: { full_name: "o/r" } } });
    vi.stubGlobal("fetch", f);
    await listRepositoryItems("o/r", token);
    for (const call of f.mock.calls) expect(call[1]?.method ?? "GET").toBe("GET");
  });
});

describe("readmeItems", () => {
  // Shaped like a real hard-wrapped repository README: several sections, and the
  // last sentence wrapped across the final two physical lines.
  const filler = (n: number) =>
    Array.from(
      { length: n },
      (_, i) => `Line ${i} of this section explains one more operating detail,\nwrapped the way an editor wraps prose.`,
    ).join("\n");
  const README = [
    "# Operations",
    filler(6),
    "",
    "## Controls",
    filler(8),
    "",
    "## Tooling",
    "- [Task records](docs/task-records.md)",
    "- [Status](docs/status.md): `npm run status`",
    "",
    "[Context policy](docs/context-policy.md): the lead uses the compact current-work tool;",
    "the observer owns loop observation. Historical evidence stays available on demand.",
  ].join("\n");
  const LAST_PARAGRAPH =
    "[Context policy](docs/context-policy.md): the lead uses the compact current-work tool; the observer owns loop observation. Historical evidence stays available on demand.";

  it("puts the README's last wrapped sentence whole on one line of one small section", () => {
    const items = readmeItems("o/r", README, "o");
    const holders = items.filter((i) => i.text.split("\n").some((line) => line === LAST_PARAGRAPH));
    expect(holders).toHaveLength(1);
    expect(holders[0].text.length).toBeLessThanOrEqual(1_500 + "README of o/r\n\n".length);
    expect(items.every((i) => i.text.startsWith("README of o/r\n\n"))).toBe(true);
  });

  it("gives each section a stable id and checksum, the first keeping `readme`", () => {
    const items = readmeItems("o/r", README, "o");
    expect(items.length).toBeGreaterThan(1);
    expect(items.map((i) => i.id)).toEqual(["readme", ...items.slice(1).map((_, i) => `readme-${i + 2}`)]);
    expect(readmeItems("o/r", README, "o")).toEqual(items);
    expect(new Set(items.map((i) => i.checksum)).size).toBe(items.length);
  });

  it("keeps every sentence: no section drops or cuts text", () => {
    const joined = readmeItems("o/r", README, "o")
      .map((i) => i.text.replace("README of o/r\n\n", ""))
      .join(" ");
    const words = (s: string) => s.split(/\s+/).filter(Boolean);
    expect(words(joined)).toEqual(words(README));
  });
});

describe("listRepositoryItems — reading changes since the last sync", () => {
  const REPO = "example-org/busy";
  /** After every timestamp busyRepository writes, and before pushCommits' first. */
  const NOW = Date.parse("2026-10-01T23:00:00Z");
  const HOUR = 60 * 60 * 1000;
  const list = (state: FakeRepositoryState, cursor: GitHubSyncCursor | null, stored: string[] = [], now = NOW) => {
    const github = fakeGitHub(state);
    vi.stubGlobal("fetch", github.fetch);
    return listRepositoryItems(REPO, token, { cursor, stored, now }).then((listing) => ({
      ...listing,
      requests: github.requests,
    }));
  };
  const commitIds = (items: { id: string }[]) => items.map((i) => i.id).filter((id) => id.startsWith("commit-"));
  const repo = (counts: { commits?: number; issues?: number; pulls?: number }) =>
    busyRepository({ commits: 0, issues: 0, pulls: 0, ...counts }, REPO);

  it("reads a long history over several syncs, two pages of each kind per sync, and none twice", async () => {
    const state = repo({ commits: 450 });
    const seen: string[] = [];
    let cursor: GitHubSyncCursor | null = null;
    for (let sync = 0; sync < 3; sync++) {
      const listing = await list(state, cursor);
      expect(commitIds(listing.items).length).toBeLessThanOrEqual(200);
      seen.push(...commitIds(listing.items));
      cursor = listing.cursor;
    }
    expect(new Set(seen).size).toBe(450);
    expect(seen).toHaveLength(450);
    // The pass finished: the next one reads back to an hour before it started.
    expect(cursor!.commits).toEqual({ since: "2026-10-01T22:00:00Z" });
  });

  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  /** A cursor whose issues and comments read from before every row the fixtures write, so no newest-first window runs. */
  const FROM_START: GitHubSyncCursor = {
    ...initialCursor(),
    issues: { since: "2026-10-01T00:00:00Z" },
    comments: { since: "2026-10-01T00:00:00Z" },
  };
  /** Minute `n` of 2026-10-01, as busyRepository stamps item `n`. */
  const minute = (n: number) =>
    `2026-10-01T${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}:00Z`;
  const withComments = (count: number) => {
    const state = repo({});
    state.comments = range(1, count).map((id) =>
      gitHubComment(REPO, id, { number: 1, body: `Note ${id}`, updated_at: minute(id) }),
    );
    return state;
  };
  /** Run `change` on the repository right after the first page of `listing` is answered; optionally make `since` exclude its own second. */
  const afterFirstPage = (
    state: FakeRepositoryState,
    listing: "issues" | "issues/comments",
    change: () => void,
    exclusiveSince = false,
  ) => {
    const github = fakeGitHub(state);
    let pages = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      const asked = new URL(url);
      const since = asked.searchParams.get("since");
      // The fake's `since` includes its own second; asking one second later excludes it.
      if (exclusiveSince && since)
        asked.searchParams.set("since", new Date(Date.parse(since) + 1000).toISOString().replace(".000Z", "Z"));
      const res = await github.fetch(asked.toString());
      if (new URL(url).pathname.endsWith(`/${listing}`) && ++pages === 1) change();
      return res;
    });
    return github.requests;
  };

  // Issues and comments can be deleted upstream, and a row deleted or changed
  // behind a paged read must not shift the pages after it past a row.
  it.each([
    {
      name: "an issue deleted after the first page",
      listing: "issues" as const,
      state: () => repo({ issues: 250 }),
      change: (s: FakeRepositoryState) => deleteIssues(s, [10]),
      ids: range(1, 250).map((n) => `issue-${n}`),
      pages: 3,
    },
    {
      name: "a comment deleted after the first page",
      listing: "issues/comments" as const,
      state: () => withComments(250),
      change: (s: FakeRepositoryState) => {
        s.comments = s.comments.filter((c) => c.id !== 10);
      },
      ids: range(1, 250).map((n) => `comment-${n}`),
      pages: 3,
    },
    {
      name: "an issue read already and one not yet read, both changed after the first page",
      listing: "issues" as const,
      state: () => repo({ issues: 250 }),
      change: (s: FakeRepositoryState) => {
        touchIssues(s, [20, 150], "2026-10-01T22:00:00Z");
        for (const issue of s.issues)
          if (issue.number === 20 || issue.number === 150) issue.title = `Retitled ${issue.number}`;
      },
      ids: [...range(1, 19), ...range(21, 149), ...range(151, 250), 20, 150].map((n) => `issue-${n}`),
      pages: 3,
      retitled: ["issue-20", "issue-150"],
    },
    { name: "an empty repository", listing: "issues" as const, state: () => repo({}), ids: [], pages: 1 },
    {
      name: "one short page",
      listing: "issues" as const,
      state: () => repo({ issues: 7 }),
      ids: range(1, 7).map((n) => `issue-${n}`),
      pages: 1,
    },
    {
      name: "exactly one full page, whose last issue the next request repeats",
      listing: "issues" as const,
      state: () => repo({ issues: 100 }),
      ids: range(1, 100).map((n) => `issue-${n}`),
      pages: 2,
    },
    {
      name: "150 issues changed in the same second, more than a page",
      listing: "issues" as const,
      state: () => {
        const s = repo({});
        s.issues = range(1, 150).map((n) =>
          gitHubIssue(REPO, n, { title: `Bulk ${n}`, updated_at: "2026-10-01T12:00:00Z" }),
        );
        return s;
      },
      ids: range(1, 150).map((n) => `issue-${n}`),
      pages: 3,
      // Its last page is past page 1 of the run, so the next sync reads the run again.
      cursor: { since: "2026-10-01T11:59:59Z" },
    },
    {
      // GitHub documents `since` as "after"; the second of overlap keeps the
      // rest of a run split across pages when it excludes its own second.
      name: "150 issues changed in the same second, when since excludes its own second",
      listing: "issues" as const,
      exclusiveSince: true,
      state: () => {
        const s = repo({});
        s.issues = range(1, 150).map((n) =>
          gitHubIssue(REPO, n, { title: `Bulk ${n}`, updated_at: "2026-10-01T12:00:00Z" }),
        );
        return s;
      },
      ids: range(1, 150).map((n) => `issue-${n}`),
      pages: 3,
      cursor: { since: "2026-10-01T11:59:59Z" },
    },
  ])(
    "reads every row once from $name",
    async ({ listing, state: build, change, ids, pages, retitled, cursor, exclusiveSince }) => {
      const state = build();
      const requests = afterFirstPage(state, listing, () => change?.(state), exclusiveSince);
      const result = await listRepositoryItems(REPO, token, { cursor: FROM_START, now: NOW });
      const prefix = listing === "issues" ? "issue-" : "comment-";
      expect(result.items.map((i) => i.id).filter((id) => id.startsWith(prefix))).toEqual(ids);
      expect(requests.filter((r) => r.path.endsWith(`/${listing}`))).toHaveLength(pages);
      for (const id of retitled ?? []) expect(result.items.find((i) => i.id === id)?.text).toContain("Retitled");
      // A read that reached the present reads back to an hour before this sync next time.
      expect(result.cursor[listing === "issues" ? "issues" : "comments"]).toEqual(
        cursor ?? { since: "2026-10-01T22:00:00Z" },
      );
    },
  );

  it.each([
    ["deleted", (s: FakeRepositoryState) => deleteIssues(s, range(1, 60))],
    ["changed", (s: FakeRepositoryState) => touchIssues(s, range(1, 60), "2026-10-01T23:30:00Z")],
  ])("reads the rest of a same-second run when part of it is %s between two syncs", async (_case, change) => {
    const state = repo({});
    state.issues = range(1, 250).map((n) =>
      gitHubIssue(REPO, n, { title: `Bulk ${n}`, updated_at: "2026-10-01T12:00:00Z" }),
    );
    const first = await list(state, FROM_START);
    change(state);
    const second = await list(state, first.cursor, [], NOW + HOUR);
    const third = await list(state, second.cursor, [], NOW + 2 * HOUR);
    const ids = new Set([...second.items, ...third.items].map((i) => i.id));
    expect(range(201, 250).filter((n) => !ids.has(`issue-${n}`))).toEqual([]);
  });

  it("fails as a GitHub error, not a crash, on a listed row without a readable updated_at", async () => {
    // The newest window reads 250 to 51; the oldest-first read then ends its first page on issue 100.
    const state = repo({ issues: 250 });
    state.issues[99].updated_at = "2026-10-01T01:40:00Zjunk";
    await expect(list(state, null)).rejects.toThrow(GitHubConnectorError);
  });

  it("continues a same-second run longer than one sync's budget at its next page", async () => {
    const state = repo({});
    state.issues = range(1, 250).map((n) =>
      gitHubIssue(REPO, n, { title: `Bulk ${n}`, updated_at: "2026-10-01T12:00:00Z" }),
    );
    const first = await list(state, FROM_START);
    expect(first.cursor.issues).toEqual({ since: "2026-10-01T11:59:59Z", page: 3 });
    const second = await list(state, first.cursor, [], NOW + HOUR);
    const ids = [...first.items, ...second.items].map((i) => i.id).filter((id) => id.startsWith("issue-"));
    expect([...new Set(ids)].sort()).toEqual(
      range(1, 250)
        .map((n) => `issue-${n}`)
        .sort(),
    );
  });

  // QA: a person's first session after connecting must see current work, not the oldest history.
  it.each([
    ["500 issues", () => repo({ issues: 500 }), "issue-", 500],
    ["2,000 issues", () => repo({ issues: 2_000 }), "issue-", 2_000],
    ["500 comments", () => withComments(500), "comment-", 500],
  ] as const)(
    "brings a long history's newest rows on the first sync, then the rest, each once a sync: %s",
    async (_case, build, prefix, total) => {
      const state = build();
      const first = await list(state, null);
      const ids = (items: { id: string }[]) => items.map((i) => i.id).filter((id) => id.startsWith(prefix));
      expect(range(total - 49, total).filter((n) => !ids(first.items).includes(`${prefix}${n}`))).toEqual([]);
      // The newest window stores no position: the backfill starts at the oldest change.
      expect(ids(first.items)).toContain(`${prefix}1`);
      const seen = new Set(ids(first.items));
      let cursor = first.cursor;
      for (let sync = 1; sync <= 12; sync++) {
        const listing = await list(state, cursor, [], NOW + sync * HOUR);
        expect(new Set(ids(listing.items)).size).toBe(ids(listing.items).length);
        for (const id of ids(listing.items)) seen.add(id);
        cursor = listing.cursor;
      }
      expect(seen.size).toBe(total);
    },
  );

  // QA: a bulk change spanning a second boundary (60 + 60 rows) fills a page from `since` to
  // `since` + 1s, so the read turns pages; a row deleted between those two pages must not skip one,
  // even when newer rows fill the second page. No run here has more than 100 rows in one second.
  // A deletion between the window's two pages leaves its second page short,
  // which must not read as the end of a listing longer than one page.
  it.each([
    ["101 issues", () => repo({ issues: 101 }), "issues" as const, "issue-", 101],
    ["200 issues", () => repo({ issues: 200 }), "issues" as const, "issue-", 200],
    ["150 comments", () => withComments(150), "issues/comments" as const, "comment-", 150],
  ])(
    "reads every row of %s though the newest is deleted between the first sync's newest pages",
    async (_case, build, listing, prefix, total) => {
      const state = build();
      afterFirstPage(state, listing, () => {
        if (listing === "issues") deleteIssues(state, [total]);
        else state.comments = state.comments.filter((c) => c.id !== total);
      });
      const first = await listRepositoryItems(REPO, token, { cursor: null, now: NOW });
      const ids = first.items.map((i) => i.id).filter((id) => id.startsWith(prefix));
      expect(range(1, total).filter((n) => !ids.includes(`${prefix}${n}`))).toEqual([]);
    },
  );

  it("skips no issue of a bulk change spread over two adjacent seconds when one is deleted between its pages", async () => {
    const state = repo({});
    const stamp = (n: number) =>
      n <= 40
        ? `2026-10-01T01:${String(n).padStart(2, "0")}:00Z`
        : n <= 100
          ? "2026-10-01T12:00:00Z"
          : n <= 160
            ? "2026-10-01T12:00:01Z"
            : `2026-10-01T2${Math.floor((n - 161) / 60)}:${String((n - 161) % 60).padStart(2, "0")}:00Z`;
    state.issues = range(1, 250).map((n) => gitHubIssue(REPO, n, { title: `Issue ${n}`, updated_at: stamp(n) }));
    const github = fakeGitHub(state);
    vi.stubGlobal("fetch", async (url: string) => {
      if (new URL(url).searchParams.get("page") === "2" && !state.deletedIssues.has(50)) deleteIssues(state, [50]);
      return github.fetch(url);
    });
    const seen = new Set<string>();
    // From a stored cursor, so the first sync's newest-first window does not read #141 and mask the skip.
    let cursor: GitHubSyncCursor | null = FROM_START;
    for (let sync = 0; sync < 3; sync++) {
      const listing = await listRepositoryItems(REPO, token, { cursor, now: NOW + sync * HOUR });
      for (const item of listing.items) seen.add(item.id);
      cursor = listing.cursor;
    }
    expect(range(1, 250).filter((n) => n !== 50 && !seen.has(`issue-${n}`))).toEqual([]);
  });

  // QA: a run of exactly one page (100 rows) in one second turns the page, and a
  // run row deleted between the pages must not skip the first row after the run, which nothing reads
  // again until it changes. Only the run's own rows are the stated residual.
  it("skips no row after a one-page same-second run when one of the run is deleted between its pages", async () => {
    const state = repo({});
    state.issues = [
      ...range(1, 100).map((n) => gitHubIssue(REPO, n, { title: `Bulk ${n}`, updated_at: "2026-10-01T12:00:00Z" })),
      ...range(101, 250).map((n) => gitHubIssue(REPO, n, { title: `Issue ${n}`, updated_at: minute(n + 900) })),
    ];
    const github = fakeGitHub(state);
    vi.stubGlobal("fetch", async (url: string) => {
      if (new URL(url).searchParams.get("page") === "2" && !state.deletedIssues.has(1)) deleteIssues(state, [1]);
      return github.fetch(url);
    });
    const seen = new Set<string>();
    let cursor: GitHubSyncCursor | null = { ...initialCursor(), issues: { since: "2026-10-01T12:00:00Z" } };
    for (let sync = 0; sync < 3; sync++) {
      const listing = await listRepositoryItems(REPO, token, { cursor, now: NOW + sync * HOUR });
      for (const item of listing.items) seen.add(item.id);
      cursor = listing.cursor;
    }
    expect(range(101, 250).filter((n) => !seen.has(`issue-${n}`))).toEqual([]);
  });

  it("asks again from the second after a one-page same-second run once its next page shows the run ended", async () => {
    const state = repo({});
    state.issues = [
      ...range(1, 100).map((n) => gitHubIssue(REPO, n, { title: `Bulk ${n}`, updated_at: "2026-10-01T12:00:00Z" })),
      ...range(101, 250).map((n) => gitHubIssue(REPO, n, { title: `Issue ${n}`, updated_at: minute(n + 900) })),
    ];
    afterFirstPage(state, "issues", () => deleteIssues(state, [1]));
    const cursor: GitHubSyncCursor = { ...initialCursor(), issues: { since: "2026-10-01T12:00:00Z" } };
    const listing = await listRepositoryItems(REPO, token, { cursor, now: NOW });
    // Pages 1 and 2 fill the budget; the next sync starts after the run, not at page 3 of it.
    expect(listing.cursor.issues).toEqual({ since: "2026-10-01T12:00:01Z" });
  });

  it("reads every issue of a long history over several syncs though one already read is deleted between them", async () => {
    const state = repo({ issues: 450 });
    const seen = new Set<string>();
    let cursor: GitHubSyncCursor | null = FROM_START;
    for (let sync = 0; sync < 3; sync++) {
      const listing = await list(state, cursor, [], NOW + sync * HOUR);
      for (const item of listing.items) if (item.id.startsWith("issue-")) seen.add(item.id);
      if (sync === 0) {
        // The first sync stopped inside the history, at the second before the last issue it read.
        expect(listing.cursor.issues).toEqual({ since: "2026-10-01T04:57:59Z" });
        deleteIssues(state, [5]);
      }
      cursor = listing.cursor;
    }
    expect([...seen].sort()).toEqual(
      range(1, 450)
        .map((n) => `issue-${n}`)
        .sort(),
    );
  });

  it("pages a long history through one unchanging list while new commits land on top", async () => {
    const state = repo({ commits: 250 });
    const first = await list(state, null);
    pushCommits(state, 30, "new", 0);
    const second = await list(state, first.cursor, [], NOW + HOUR);
    const third = await list(state, second.cursor, [], NOW + 2 * HOUR);
    expect(new Set([first, second, third].flatMap((l) => commitIds(l.items))).size).toBe(280);
  });

  it("asks only for what changed since an hour before the last finished sync", async () => {
    const cursor: GitHubSyncCursor = {
      ...initialCursor(),
      issues: { since: "2026-10-01T22:00:00Z" },
      commits: { since: "2026-10-01T22:00:00Z" },
    };
    const { requests } = await list(repo({}), cursor);
    const query = (kind: string) => requests.find((r) => r.path.endsWith(`/${kind}`))?.query;
    expect(query("issues")).toMatchObject({ since: "2026-10-01T22:00:00Z", page: "1", per_page: "100" });
    expect(query("commits")).toMatchObject({ since: "2026-10-01T22:00:00Z", until: "2026-10-01T23:00:00Z", page: "1" });
  });

  it("stops reading pull requests at the first one older than the cursor, which the endpoint cannot filter", async () => {
    // busyRepository updates pull request n at minute n of 2026-10-01, so #141 at 02:21.
    const cursor: GitHubSyncCursor = { ...initialCursor(), pulls: { since: "2026-10-01T02:21:00Z" } };
    const listing = await list(repo({ pulls: 150 }), cursor);
    expect(listing.items.filter((i) => i.id.startsWith("pr-")).map((i) => i.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `pr-${150 - i}`),
    );
    expect(listing.cursor.pulls).toEqual({ since: "2026-10-01T22:00:00Z" });
  });

  it("names nothing gone because the listing left it out", async () => {
    const state = repo({ commits: 5, issues: 1 });
    const first = await list(state, null);
    const second = await list(
      state,
      first.cursor,
      first.items.map((i) => i.id),
      NOW + HOUR,
    );
    // The README and the file tree are read whole every sync; nothing else changed.
    expect(second.items.map((i) => i.id)).toEqual(["readme", "tree"]);
    expect(second.gone).toEqual([]);
  });

  it("names a deleted issue and a force-pushed commit gone, once the probe reaches them", async () => {
    const state = repo({ commits: 3, issues: 2 });
    const first = await list(state, null);
    const dropped = state.commits[0].sha;
    deleteIssues(state, [1]);
    state.commits = state.commits.slice(1);
    const second = await list(
      state,
      first.cursor,
      first.items.map((i) => i.id),
      NOW + HOUR,
    );
    expect(second.gone.sort()).toEqual([`commit-${dropped}`, "issue-1"]);
  });

  it("probes a different slice of the stored items each sync, so every one is asked about in turn", async () => {
    const state = repo({ commits: 50 });
    const stored = state.commits.map((c) => `commit-${c.sha}`);
    let cursor: GitHubSyncCursor = { ...initialCursor(), commits: { since: "2026-10-01T22:00:00Z" } };
    const probed = new Set<string>();
    for (let sync = 0; sync < 3; sync++) {
      const listing = await list(state, cursor, stored);
      cursor = listing.cursor;
      for (const r of listing.requests) if (/\/commits\/[0-9a-f]{40}$/.test(r.path)) probed.add(r.path);
    }
    expect(probed.size).toBe(50);
  });

  it("probes every stored item in turn from the held cursor a failing sync stores, which keeps its passes", async () => {
    const state = repo({ commits: 250 });
    const stored = state.commits.slice(0, 50).map((c) => `commit-${c.sha}`);
    const start: GitHubSyncCursor = { ...initialCursor(), commits: { startedAt: "2026-10-01T22:00:00Z", page: 2 } };
    let cursor = start;
    const probed = new Set<string>();
    for (let sync = 0; sync < 3; sync++) {
      const listing = await list(state, cursor, stored);
      expect(listing.heldCursor).toEqual({ ...start, probeOffset: listing.cursor.probeOffset });
      cursor = listing.heldCursor;
      for (const r of listing.requests) if (/\/commits\/[0-9a-f]{40}$/.test(r.path)) probed.add(r.path);
    }
    expect(probed.size).toBe(50);
  });

  it("does not take a probe it may not make, or a rate limit, as a deletion", async () => {
    const state = repo({ issues: 1 });
    const cursor: GitHubSyncCursor = { ...initialCursor(), issues: { since: "2026-10-01T22:00:00Z" } };
    const answering = (body: object) => async (url: string) =>
      new URL(url).pathname.endsWith("/issues/1")
        ? new Response(JSON.stringify(body), { status: 403 })
        : fakeGitHub(state).fetch(url);
    vi.stubGlobal("fetch", answering({ message: "Resource not accessible by personal access token" }));
    expect((await listRepositoryItems(REPO, token, { cursor, stored: ["issue-1"], now: NOW })).gone).toEqual([]);
    vi.stubGlobal("fetch", answering({ message: "API rate limit exceeded for user ID 1." }));
    await expect(listRepositoryItems(REPO, token, { cursor, stored: ["issue-1"], now: NOW })).rejects.toThrow(/403/);
  });

  it("names every stored item of a kind the token lost gone, and reads that kind from the start once it is back", async () => {
    const state = repo({ issues: 1 });
    state.forbidden.add("issues");
    const cursor: GitHubSyncCursor = { ...initialCursor(), issues: { since: "2026-10-01T22:00:00Z" } };
    const listing = await list(state, cursor, ["readme", "issue-1"]);
    // Issue comments answer the pull requests permission too, so only issues are refused.
    expect(listing.unreadable).toEqual(["issues"]);
    expect(listing.gone).toEqual(["issue-1"]);
    expect(listing.cursor.issues).toEqual({});
  });

  it("holds a kind the token lost at its start too, so a sync where an item failed still reads it from the start once it is back", async () => {
    const state = repo({ issues: 1 });
    state.forbidden.add("issues");
    const cursor: GitHubSyncCursor = { ...initialCursor(), issues: { since: "2026-10-01T22:00:00Z" } };
    const listing = await list(state, cursor, ["readme", "issue-1"]);
    expect(listing.gone).toEqual(["issue-1"]);
    expect(listing.heldCursor.issues).toEqual({});
  });

  // A token that loses access part way through a sync answers 404 to every
  // request after that, which reads like a deleted README, tree and issue.
  // On a first sync nothing is stored to be found gone, and a 404 page reads as
  // an empty, finished pass that would move the cursor past the whole history.
  it.each([
    ["after the repository read", 1, true],
    ["after the listings, during the deletion probe", 8, true],
    ["after the repository read, on a first sync", 1, false],
  ])("reports access lost, not items gone, when the token loses the repository %s", async (_case, answered, synced) => {
    const state = repo({ commits: 2, issues: 2 });
    const first = synced ? await list(state, null) : null;
    const github = fakeGitHub(state);
    let calls = 0;
    vi.stubGlobal("fetch", async (url: string) =>
      ++calls <= answered ? github.fetch(url) : new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
    );
    const stored = first?.items.map((i) => i.id) ?? [];
    await expect(
      listRepositoryItems(REPO, token, { cursor: first?.cursor ?? null, stored, now: NOW + HOUR }),
    ).rejects.toThrow(SourceAccessError);
  });

  it("names a README section the README no longer has gone", async () => {
    const listing = await list(repo({}), null, ["readme", "readme-2"]);
    expect(listing.gone).toEqual(["readme-2"]);
  });
});

describe("itemHeading", () => {
  // Stored verbatim by the memory service, so an item is found by its change's title line.
  // The id keeps two items with the same lines apart.
  it.each([
    [
      "doc:docs/api.md",
      "Document docs/api.md in acme/app (<link>)\n\n## Parameters\nSee below.",
      "Document docs/api.md in acme/app (<link>)\n## Parameters\n(acme/app doc:docs/api.md)",
    ],
    [
      "doc-2:docs/api.md",
      "Document docs/api.md in acme/app (<link>)\n\n## Parameters\nSee below.",
      "Document docs/api.md in acme/app (<link>)\n## Parameters\n(acme/app doc-2:docs/api.md)",
    ],
    [
      "comment-9",
      "Comment on issue #7 by ana:\r\n\r\nWrite to ana%40example.com",
      "Comment on issue #7 by ana:\n(acme/app comment-9)",
    ],
    ["commit-abc", `Commit abc1234:  ${"é".repeat(400)}`, `Commit abc1234: ${"é".repeat(261)}…\n(acme/app commit-abc)`],
  ])("names %s by its first lines and its id, cleaned, at most 300 characters", (id, text, heading) => {
    expect(itemHeading("acme/app", { id, text })).toBe(heading);
  });

  it("keeps the id when the lines fill the heading, so sections of a doc with a long path stay apart", () => {
    const path = `docs/${"deep/".repeat(30)}guide.md`;
    const text = `Document ${path} in acme/app (https://github.com/acme/app/blob/main/${path})\n\n## Install`;
    const headings = [`doc:${path}`, `doc-2:${path}`, `doc-3:${path}x`].map((id) =>
      itemHeading("acme/app", { id, text }),
    );
    expect(new Set(headings).size).toBe(3);
    for (const heading of headings) expect(Array.from(heading).length).toBeLessThanOrEqual(300);
  });

  // Stored verbatim, so a line is checked on its decoded copy and dropped whole on any hit,
  // never scrubbed: one row per form a scrub was found to miss.
  it.each([
    "ana@example.com",
    "ana%40example.com",
    "ana%252540example.com",
    "ana&#64example.com",
    "ana&#x0040;example.com",
    "ana&#64;example&#46;com",
    "ana%40example%2Ecom",
    "&#97;na&#64;example.com",
    "ana＠example．com",
    `token ${["gh", "p_", "Fx".repeat(18)].join("")}`,
    `token ${["gh", "p&#95;", "Fx".repeat(18)].join("")}`,
    `token ${["gh", "p%5F", "Fx".repeat(18)].join("")}`,
    // No word boundary, invisible characters, non-ASCII, long zeros, deep nesting.
    "_ana@example.com_",
    "ana@example.com9",
    "ana@exa\u200bmple.com",
    "ana@exa\u00admple.com",
    "ana@münchen.de",
    "josé@example.com",
    "ana@example\u3002com",
    "ana&#000000064;example.com",
    "ana&#x0000000040;example.com",
    `ana%${"25".repeat(10)}40example.com`,
    `ana&${"amp;".repeat(6)}#64;example.com`,
    `${["gh", "p_", "Fx".repeat(18)].join("")}_x`,
    ["AKIA", "IOSFODNN7EXAMPLEZZZ"].join(""),
    // A vendor's token the scan has no pattern for, by its shape.
    ["hf", "_", "AbCdEfGhIjKlMnOpQrStUvWxYz012345"].join(""),
    ["shpat", "_", "0123456789abcdef0123456789abcdef"].join(""),
    ["lin", "_api_", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd"].join(""),
    ["sk", "_test_", "51Habcdefghijklmnopqrstuvwx0123"].join(""),
    // A versioned prefix (DigitalOcean's dop_v1_) before a lowercase hex run.
    ["dop", "_v1_", "0123456789abcdef".repeat(4)].join(""),
  ])("drops a line that holds %s whole, and keeps the rest", (held) => {
    const heading = itemHeading("acme/app", {
      id: "comment-9",
      text: `Comment on issue #7 by ana:\n\nWrite to ${held}`,
    });
    expect(heading).toBe("Comment on issue #7 by ana:\n(acme/app comment-9)");
  });

  // 9 of the 11 lines once dropped across 1,138 real items were
  // words ending in "sk" before a hyphen (task-, ask-), read as the start of an "sk-" key.
  it.each([
    "Commit 4f1c2ab: docs: ask-before-merge checklist",
    "Pull request #57 (open; fix/task-queue-retry → main): Retry the queue",
  ])("keeps a line whose words only contain a key's prefix: %s", (first) => {
    expect(itemHeading("acme/app", { id: "pr-820", text: `${first}\n\nBody.` })).toBe(
      `${first}\nBody.\n(acme/app pr-820)`,
    );
  });

  it("checks the heading whole, so an address split across its parts is not shown", () => {
    // Each part alone reads as clean; shown together they spell the address.
    expect(itemHeading("acme/app", { id: "comment-9", text: "reach ana\n\n@example.com" })).toBe(
      "reach ana\n(acme/app comment-9)",
    );
    expect(itemHeading("acme/app", { id: "@example.com", text: "reach ana" })).toMatch(/^\(acme\/app [0-9a-f]{16}\)$/);
  });

  it("stays within 300 code points whatever the repository name, id and text", () => {
    const heading = itemHeading(`o/${"r".repeat(400)}`, { id: `doc:${"p".repeat(120)}`, text: "t".repeat(5000) });
    expect(Array.from(heading).length).toBeLessThanOrEqual(300);
  });

  it("never shows part of an address or a secret a long id holds where the id is shortened", () => {
    const secret = ["gh", "p_", "Fx".repeat(18)].join("");
    for (const held of ["dana.whitfield@example.com", secret]) {
      for (let pad = 16; pad <= 40; pad += 2) {
        const id = `doc:docs/${"x".repeat(pad)}/${held}/${"y".repeat(120)}.md`;
        const heading = itemHeading("acme/app", { id, text: "Document docs/a.md in acme/app (<link>)" });
        expect(heading, `pad ${pad}`).not.toMatch(/dana|whitf|ghp_F/);
      }
    }
  });
});

describe("isDocPath", () => {
  it("takes ADRs, CONTRIBUTING, CHANGELOG and docs directories, at any depth and in any case", () => {
    for (const path of [
      "CONTRIBUTING.md",
      ".github/CONTRIBUTING.md",
      "CHANGELOG",
      "docs/CHANGELOG.md",
      "HISTORY.rst",
      "docs/setup.md",
      "Docs/Guide.MD",
      "packages/api/docs/auth.mdx",
      "doc/adr/0007-queues.md",
      "adr/0001-use-postgres.md",
      "architecture/decisions/0002-postgres.md",
      "rfcs/0004-sync.txt",
    ])
      expect(isDocPath(path), path).toBe(true);
  });

  it("leaves out source code, config, the root README and vendored code's docs", () => {
    for (const path of [
      "README.md",
      "readme",
      "src/brief.ts",
      "docs/build.sh",
      ".github/workflows/ci.yml",
      "package.json",
      "node_modules/zod/docs/README.md",
      "vendor/github.com/x/y/docs/a.md",
      "third_party/lib/CHANGELOG.md",
      "docsite/index.md",
      "mydocs/a.md",
    ])
      expect(isDocPath(path), path).toBe(false);
  });
});

describe("parseCursor", () => {
  it("accepts a cursor the connector wrote and rejects anything else", () => {
    const cursor: GitHubSyncCursor = {
      issues: { since: "2026-10-14T19:00:00Z" },
      pulls: { startedAt: "2026-10-14T20:00:00Z", page: 3 },
      commits: {},
      comments: { since: "2026-10-14T18:00:00Z" },
      reviewQueue: [12, 9],
      docs: { "docs/adr/0001-postgres.md": "a".repeat(40) },
      probeOffset: 4,
      refusedParents: ["issues"],
    };
    expect(parseCursor(cursor)).toEqual(cursor);
    expect(parseCursor(null)).toBeNull();
    expect(parseCursor({ ...cursor, probeOffset: -1 })).toBeNull();
    expect(parseCursor({ ...cursor, pulls: { page: 3 } })).toBeNull();
    expect(parseCursor({ ...cursor, issues: { since: "yesterday" } })).toBeNull();
    expect(parseCursor({ ...cursor, reviewQueue: [0] })).toBeNull();
    expect(parseCursor({ ...cursor, docs: { "CHANGELOG.md": 7 } })).toBeNull();
    for (const refusedParents of [["comments"], ["reviews"], "issues", [null]]) {
      expect(parseCursor({ ...cursor, refusedParents }), JSON.stringify(refusedParents)).toBeNull();
    }
  });

  it.each([
    [
      "a pass inside a same-second run",
      { since: "2026-10-14T19:00:00Z", page: 3 },
      { since: "2026-10-14T19:00:00Z", page: 3 },
    ],
    // Stored while issues and comments were read newest first: its page counts from the newest change.
    [
      "an unfinished newest-first pass, which restarts from its since",
      { since: "2026-10-14T19:00:00Z", startedAt: "2026-10-14T20:00:00Z", page: 4 },
      { since: "2026-10-14T19:00:00Z" },
    ],
    [
      "an unfinished newest-first first pass, which restarts from the oldest change",
      { startedAt: "2026-10-14T20:00:00Z", page: 4 },
      {},
    ],
    ["a page with no since", { page: 3 }, null],
    ["page 1, which is never stored", { since: "2026-10-14T19:00:00Z", page: 1 }, null],
  ])("reads an issues or comments pass that is %s", (_case, pass, expected) => {
    const base = { ...initialCursor(), issues: { since: "2026-10-14T19:00:00Z" } };
    expect(parseCursor({ ...base, issues: pass })?.issues ?? null).toEqual(expected);
    expect(parseCursor({ ...base, comments: pass })?.comments ?? null).toEqual(expected);
  });

  it("carries on a cursor stored before comments, reviews and docs were read, starting only those over", () => {
    const legacy = { issues: { since: "2026-10-14T19:00:00Z" }, pulls: {}, commits: {}, probeOffset: 2 };
    expect(parseCursor(legacy)).toEqual({ ...legacy, comments: {}, reviewQueue: [], docs: {}, refusedParents: [] });
  });
});

// GitHub has no permission for comments or reviews: an issue comment answers a token with the
// issues or the pull requests permission, a review only the pull requests one. So each follows
// the issue or pull request it is on, and the source names only what GitHub refused.
// messyRepository keeps comment-9001 (on issue 101), comment-9003 (on
// pull request 202) and reviews 7001, 7003 and 7004.
describe("comments and reviews follow the issue or pull request they are on", () => {
  const NOW = Date.parse("2026-10-14T13:00:00Z");
  const HOUR = 60 * 60 * 1000;
  const COMMENTS = ["comment-9001", "comment-9003"];
  const REVIEWS = ["review-7001", "review-7003", "review-7004"];
  /** After every comment messyRepository writes, so an incremental pass lists none of them. */
  const PAST_COMMENTS: GitHubSyncCursor = { ...initialCursor(), comments: { since: "2026-10-14T12:00:00Z" } };
  const refusing = (kinds: ("issues" | "pulls")[], fullName = "example-org/lantern") => {
    const state = messyRepository(fullName);
    for (const kind of kinds) state.forbidden.add(kind);
    return state;
  };
  const sync = async (
    state: FakeRepositoryState,
    {
      cursor = null,
      stored = [],
      now = NOW,
      fetch,
    }: { cursor?: GitHubSyncCursor | null; stored?: string[]; now?: number; fetch?: typeof globalThis.fetch } = {},
  ) => {
    const github = fakeGitHub(state);
    vi.stubGlobal("fetch", fetch ?? github.fetch);
    return {
      ...(await listRepositoryItems(state.repo.full_name, token, { cursor, stored, now })),
      requests: github.requests,
    };
  };
  const idsOf = (items: { id: string }[], prefix: string) =>
    items
      .map((i) => i.id)
      .filter((id) => id.startsWith(prefix))
      .sort();
  /** The fake, except that `path` answers GitHub's permission refusal. */
  const refusingPath = (state: FakeRepositoryState, path: RegExp): typeof globalThis.fetch => {
    const github = fakeGitHub(state);
    return (async (input: string) =>
      path.test(new URL(input).pathname)
        ? new Response(JSON.stringify({ message: "Resource not accessible by personal access token" }), { status: 403 })
        : github.fetch(input)) as typeof globalThis.fetch;
  };

  it.each([
    { refused: [] as ("issues" | "pulls")[], comments: COMMENTS, reviews: REVIEWS },
    { refused: ["issues"] as ("issues" | "pulls")[], comments: ["comment-9003"], reviews: REVIEWS },
    { refused: ["pulls"] as ("issues" | "pulls")[], comments: ["comment-9001"], reviews: [] },
    { refused: ["issues", "pulls"] as ("issues" | "pulls")[], comments: [], reviews: [] },
  ])(
    "a token refused $refused names exactly that and lists only the comments and reviews on what it may read",
    async ({ refused, comments, reviews }) => {
      const listing = await sync(refusing(refused), { cursor: initialCursor(), stored: [...COMMENTS, ...REVIEWS] });
      expect(listing.unreadable).toEqual(refused);
      expect(idsOf(listing.items, "comment-")).toEqual(comments);
      expect(idsOf(listing.items, "review-")).toEqual(reviews);
      // Every stored comment or review on a refused parent leaves memory.
      expect(listing.gone.filter((id) => !comments.includes(id) && !reviews.includes(id)).sort()).toEqual(
        [...COMMENTS, ...REVIEWS].filter((id) => !comments.includes(id) && !reviews.includes(id)).sort(),
      );
      expect(listing.gone.some((id) => comments.includes(id) || reviews.includes(id))).toBe(false);
      expect(listing.cursor.refusedParents).toEqual(refused);
    },
  );

  it("asks for no comments or reviews when both parents are refused, the way GitHub would refuse them", async () => {
    const { requests } = await sync(refusing(["issues", "pulls"]));
    expect(requests.some((r) => r.path.endsWith("/issues/comments") || r.path.endsWith("/reviews"))).toBe(false);
  });

  it("reads a comment's parent from its URL path, so a repository named pull keeps its issue comments apart", async () => {
    // Every URL in example-org/pull holds "/pull/", issue comments' included.
    const open = await sync(refusing([], "example-org/pull"));
    expect(open.items.find((i) => i.id === "comment-9001")?.text).toMatch(/^Comment on issue #101 /);
    const refusedIssues = await sync(refusing(["issues"], "example-org/pull"));
    expect(idsOf(refusedIssues.items, "comment-")).toEqual(["comment-9003"]);
  });

  it.each([
    ["a discussion URL", "https://github.com/example-org/lantern/discussions/7#discussioncomment-1"],
    ["no URL", ""],
    ["an issue URL with more path", "https://github.com/example-org/lantern/issues/101/extra"],
  ])("leaves out a comment whose parent it cannot tell (%s) while either parent is refused", async (_case, url) => {
    for (const refused of [["issues"], ["pulls"]] as ("issues" | "pulls")[][]) {
      const state = refusing(refused);
      state.comments = [
        {
          ...gitHubComment(state.repo.full_name, 9100, {
            number: 101,
            body: "We decided to ship.",
            updated_at: "2026-10-14T10:20:00Z",
          }),
          html_url: url,
        },
      ];
      expect(idsOf((await sync(state)).items, "comment-"), refused.join()).toEqual([]);
    }
  });

  it.each([
    ["the last sync named no refused parent", PAST_COMMENTS],
    [
      "a cursor stored before refused parents were recorded",
      (() => {
        const { refusedParents: _dropped, ...legacy } = PAST_COMMENTS;
        return parseCursor(legacy)!;
      })(),
    ],
  ])(
    "retires the stored comments a newly refused parent may hide when %s, then lists the readable ones again without retiring them twice",
    async (_case, cursor) => {
      const state = refusing(["issues"]);
      const first = await sync(state, { cursor, stored: COMMENTS });
      // Nothing was listed, and a stored id does not say what it is on, so both retire.
      expect(first.gone.filter((id) => id.startsWith("comment-")).sort()).toEqual(COMMENTS);
      expect(first.cursor.comments).toEqual({});
      expect(first.cursor.refusedParents).toEqual(["issues"]);

      const second = await sync(state, { cursor: first.cursor, now: NOW + HOUR });
      expect(idsOf(second.items, "comment-")).toEqual(["comment-9003"]);

      const third = await sync(state, { cursor: second.cursor, stored: ["comment-9003"], now: NOW + 2 * HOUR });
      expect(third.gone).toEqual([]);
      expect(third.cursor.refusedParents).toEqual(["issues"]);
    },
  );

  it("keeps a held sync's refused parents and restarts its comments pass, so the next sync retires again what a failed one did not", async () => {
    const listing = await sync(refusing(["issues"]), { cursor: PAST_COMMENTS, stored: COMMENTS });
    expect(listing.heldCursor.refusedParents).toEqual([]);
    expect(listing.heldCursor.comments).toEqual({});
    const again = await sync(refusing(["issues"]), { cursor: listing.heldCursor, stored: COMMENTS, now: NOW + HOUR });
    expect(again.gone).toContain("comment-9001");
  });

  it("reads the comments again from the start once a refused parent is readable again, writing none until the cursor says so", async () => {
    const back = await sync(refusing([]), {
      cursor: { ...PAST_COMMENTS, refusedParents: ["issues"] },
      stored: ["comment-9003"],
    });
    expect(back.gone).toEqual([]);
    expect(idsOf(back.items, "comment-")).toEqual([]);
    expect(back.requests.some((r) => r.path.endsWith("/issues/comments"))).toBe(false);
    expect(back.cursor.comments).toEqual({});
    expect(back.cursor.refusedParents).toEqual([]);
    const next = await sync(refusing([]), { cursor: back.cursor, stored: ["comment-9003"], now: NOW + HOUR });
    expect(idsOf(next.items, "comment-")).toEqual(COMMENTS);
  });

  // Red-team, 2026-10-20: a sync where a parent was readable again wrote its comments under a
  // cursor that still named it refused, kept by a held sync or by one that threw, so the next
  // refusal read as nothing new and a comment on the refused pull request stayed readable.
  it.each([
    ["held", (listing: Awaited<ReturnType<typeof sync>>) => listing.heldCursor],
    [
      "kept by a sync that threw",
      (_listing: Awaited<ReturnType<typeof sync>>) =>
        ({ ...initialCursor(), refusedParents: ["pulls"] }) as GitHubSyncCursor,
    ],
  ])("leaves no comment on a parent refused again behind a cursor %s after it was readable", async (_case, kept) => {
    const refusedBefore: GitHubSyncCursor = { ...initialCursor(), refusedParents: ["pulls"] };
    const back = await sync(refusing([]), { cursor: refusedBefore, stored: ["comment-9001"] });
    const written = idsOf(back.items, "comment-");
    const again = await sync(refusing(["pulls"]), {
      cursor: kept(back),
      stored: ["comment-9001", ...written],
      now: NOW + HOUR,
    });
    expect(written.filter((id) => id === "comment-9003" && !again.gone.includes(id))).toEqual([]);
    expect(idsOf(again.items, "comment-")).not.toContain("comment-9003");
  });

  it("names comments or reviews only when GitHub refuses them while their parent is readable, and retires them", async () => {
    const state = messyRepository();
    const comments = await sync(state, { stored: COMMENTS, fetch: refusingPath(state, /\/issues\/comments$/) });
    expect(comments.unreadable).toEqual(["comments"]);
    expect(comments.gone.sort()).toEqual(COMMENTS);
    expect(comments.cursor.comments).toEqual({});

    const reviews = await sync(state, { stored: REVIEWS, fetch: refusingPath(state, /\/reviews$/) });
    expect(reviews.unreadable).toEqual(["reviews"]);
    expect(reviews.gone.sort()).toEqual(REVIEWS);
    expect(idsOf(reviews.items, "review-")).toEqual([]);
  });
});
