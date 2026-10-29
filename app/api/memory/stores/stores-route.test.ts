import { beforeEach, describe, expect, it, vi } from "vitest";

// Handler plus services/memory/store-overview: the auth gate, the check()
// wiring, and the scope filter each query receives. What Postgres does with
// that filter (an `_` in a path matching literally) is covered against a real
// database in stores-scope-realdb.qa.test.ts.
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: vi.fn(),
    contact: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    erasureSuppression: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
    scope: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));
vi.mock("@/services/memory/erasure-suppression", () => ({ loadErasedContentFilter: vi.fn() }));
vi.mock("@/services/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/access")>();
  return { ...actual, check: vi.fn() };
});

import { requireAccessContext } from "@/lib/access-context";
import { db } from "@/lib/db";
import { check, orgRootPath } from "@/services/access";
import type { StorePage, StoresOverview } from "@/types/memory";
import { loadErasedContentFilter } from "@/services/memory/erasure-suppression";
import { GET } from "./route";

const rc = {
  org: { id: "org_1" },
  user: { id: "user_42" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "member" } },
};
const ROOT = orgRootPath("org_1");
const SALES = `${ROOT}.sales`;
/** Every raw query the handler ran, as SQL text plus bound values. */
const rawQueries = () =>
  vi.mocked(db.$queryRaw).mock.calls.map(([strings, ...values]) => ({
    sql: (strings as unknown as string[]).join("?"),
    values,
  }));
/** Answer raw queries by the table they read: a count row or a list of rows. */
const rawRows = (rows: Record<string, unknown[]>, counts: Record<string, number> = {}) =>
  vi.mocked(db.$queryRaw).mockImplementation(((strings: string[]) => {
    const sql = strings.join("?");
    const table = /FROM "(\w+)"/.exec(sql)?.[1] ?? "";
    return Promise.resolve(sql.includes("COUNT(*)") ? [{ n: counts[table] ?? 0 }] : (rows[table] ?? []));
  }) as never);
const get = (scope?: string) =>
  GET(new Request(`http://t/api/memory/stores${scope === undefined ? "" : `?scope=${encodeURIComponent(scope)}`}`));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
  vi.mocked(check).mockResolvedValue({ allowed: true, reason: "ok" } as never);
  rawRows({});
});

describe("GET /api/memory/stores", () => {
  it("401 without an access context", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    expect(check).not.toHaveBeenCalled();
  });

  it("403 and no store read when check() denies the scope", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "no grant" } as never);
    const res = await get(SALES);
    expect(res.status).toBe(403);
    expect(check).toHaveBeenCalledWith(rc.ctx, { action: "memory.read", scope: SALES, target: "stores:overview" });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("a sub-scope reads only that scope and its descendants: no untagged chunks, no contacts", async () => {
    await get(SALES);
    const queries = rawQueries();
    // Counts and newest rows of sources, chunks and files, and a page plus count of briefs, rules and notes.
    expect(queries).toHaveLength(12);
    for (const q of queries) {
      expect(q.sql).toContain(`"orgId" = ?`);
      expect(q.sql).toContain(`LIKE ? ESCAPE`);
      expect(q.sql).not.toContain("IS NULL");
      expect(q.values).toEqual(expect.arrayContaining(["org_1", SALES, "org\\_org\\_1.sales.%"]));
    }
    expect(db.contact.count).not.toHaveBeenCalled();
    expect(db.contact.findMany).not.toHaveBeenCalled();
  });

  it("escapes `_` in the scope path so LIKE matches it literally", async () => {
    await get(`${ROOT}.dept_sales`);
    for (const q of rawQueries()) expect(q.values).toContain("org\\_org\\_1.dept\\_sales.%");
  });

  it("the org root also counts untagged chunks and contacts", async () => {
    vi.mocked(db.contact.count).mockResolvedValue(3);
    rawRows({}, { briefs: 2, sources: 1, conventions: 5, working_notes: 7 });
    const body = (await (await get()).json()) as StoresOverview;
    expect(check).toHaveBeenCalledWith(rc.ctx, { action: "memory.read", scope: undefined, target: "stores:overview" });
    const chunkQueries = rawQueries().filter((q) => q.sql.includes(`FROM "memory_chunks"`));
    expect(chunkQueries).toHaveLength(2);
    for (const q of chunkQueries) expect(q.sql).toContain("IS NULL");
    for (const q of rawQueries().filter((q) => !q.sql.includes(`FROM "memory_chunks"`))) {
      expect(q.sql).not.toContain("IS NULL");
    }
    expect(body.scope).toBe(ROOT);
    expect(body.counts).toEqual({ records: 4, briefs: 2, rules: 5, notes: 7, chunks: 0, files: 0 });
  });

  it("a malformed scope falls back to the org root, which check() must still allow", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "no grant" } as never);
    const res = await get("not a path;drop");
    expect(res.status).toBe(403);
    expect(check).toHaveBeenCalledWith(rc.ctx, { action: "memory.read", scope: undefined, target: "stores:overview" });
  });

  it("maps rows: trims chunk snippets, counts a file's chunks, lists briefs apart from sources", async () => {
    rawRows({
      memory_chunks: [
        {
          id: "c1",
          content: "x".repeat(300),
          source: "document",
          actorName: null,
          scopePath: SALES,
          createdAt: new Date("2026-09-01"),
        },
      ],
      source_files: [
        {
          id: "f1",
          externalFileId: "drive-1",
          chunkCount: 3,
          syncedAt: new Date("2026-09-02"),
          sourceName: "Design docs",
          sourceType: "gdrive",
          scopePath: SALES,
        },
      ],
      briefs: [
        { id: "b1", type: "handoff", title: "Older brief", scopePath: SALES, createdAt: new Date("2026-09-01") },
      ],
      sources: [
        {
          id: "s1",
          type: "gdrive",
          name: "Design docs",
          status: "active",
          scopePath: SALES,
          updatedAt: new Date("2026-09-03"),
        },
      ],
    });

    const body = (await (await get(SALES)).json()) as StoresOverview;
    expect(body.chunks[0].snippet).toHaveLength(241);
    expect(body.chunks[0].snippet.endsWith("…")).toBe(true);
    expect(body.files[0]).toMatchObject({ sourceName: "Design docs", chunkCount: 3, scopePath: SALES });
    expect(body.records.map((r) => r.id)).toEqual(["s1"]);
    expect(body.briefs).toEqual([
      {
        id: "b1",
        type: "handoff",
        title: "Older brief",
        scopePath: SALES,
        scopeName: null,
        createdAt: "2026-09-01T00:00:00.000Z",
      },
    ]);
  });

  it("says whether each rule is in force, replaced or retired, and whether each note is live", async () => {
    const at = new Date("2026-09-01");
    rawRows({
      conventions: [
        {
          id: "r1",
          kind: "convention",
          subject: "Dedupe",
          text: "By domain",
          scopePath: SALES,
          createdAt: at,
          retiredAt: null,
          supersededById: null,
          replaced: false,
        },
        {
          id: "r2",
          kind: "decision",
          subject: "Pricing",
          text: "29 and 99",
          scopePath: SALES,
          createdAt: at,
          retiredAt: null,
          supersededById: null,
          replaced: true,
        },
        {
          id: "r3",
          kind: "decision",
          subject: "Lost race",
          text: "x",
          scopePath: SALES,
          createdAt: at,
          retiredAt: null,
          supersededById: "r9",
          replaced: false,
        },
        {
          id: "r4",
          kind: "convention",
          subject: "Old",
          text: "y",
          scopePath: SALES,
          createdAt: at,
          retiredAt: at,
          supersededById: null,
          replaced: true,
        },
      ],
      working_notes: [
        {
          id: "n1",
          kind: "claim",
          task: "t",
          body: "b",
          agentName: "Copy",
          scopePath: SALES,
          createdAt: at,
          expiresAt: new Date(Date.now() + 60_000),
          releasedAt: null,
        },
        {
          id: "n2",
          kind: "intent",
          task: "t",
          body: "b",
          agentName: null,
          scopePath: SALES,
          createdAt: at,
          expiresAt: new Date(Date.now() - 60_000),
          releasedAt: null,
        },
        {
          id: "n3",
          kind: "status",
          task: "t",
          body: "b",
          agentName: "Copy",
          scopePath: SALES,
          createdAt: at,
          expiresAt: new Date(Date.now() + 60_000),
          releasedAt: at,
        },
      ],
    });
    const body = (await (await get(SALES)).json()) as StoresOverview;
    expect(body.rules.map((r) => r.status)).toEqual(["in_force", "replaced", "replaced", "retired"]);
    expect(body.notes.map((n) => n.status)).toEqual(["live", "expired", "released"]);
  });

  it("names each row's scope from the scope rows of the paths it lists, in one lookup", async () => {
    vi.mocked(db.scope.findMany).mockResolvedValue([{ path: SALES, name: "Sales" }] as never);
    rawRows({
      briefs: [{ id: "b1", type: "handoff", title: "Brief", scopePath: SALES, createdAt: new Date("2026-09-01") }],
      sources: [
        {
          id: "s1",
          type: "gdrive",
          name: "Docs",
          status: "active",
          scopePath: `${SALES}.emea_1a2b3c`,
          updatedAt: new Date("2026-09-03"),
        },
      ],
    });
    const body = (await (await get(SALES)).json()) as StoresOverview;
    expect(body.briefs[0].scopeName).toBe("Sales");
    expect(body.records[0].scopeName).toBeNull();
    expect(db.scope.findMany).toHaveBeenCalledTimes(1);
    expect(db.scope.findMany).toHaveBeenCalledWith({
      where: { orgId: "org_1", path: { in: [`${SALES}.emea_1a2b3c`, SALES] } },
      select: { path: true, name: true },
    });
  });

  it("leaves a restored pre-erasure copy of a rule out of both the list and its count", async () => {
    vi.mocked(db.erasureSuppression.findFirst).mockResolvedValue({ id: "e1" } as never);
    const filter = Object.assign((text: string) => text.includes("Dana Whitfield"), {
      byRuleId: (id: string) => id === "r-redacted",
    });
    vi.mocked(loadErasedContentFilter).mockResolvedValue(filter as never);
    const at = new Date("2026-09-01");
    const row = (id: string, text: string) => ({
      id,
      kind: "convention",
      subject: "s",
      text,
      scopePath: SALES,
      createdAt: at,
      retiredAt: null,
      supersededById: null,
      replaced: false,
    });
    rawRows(
      { conventions: [row("r1", "Ask Dana Whitfield first"), row("r-redacted", "x"), row("r3", "Dedupe by domain")] },
      { conventions: 3 },
    );
    const res = await GET(new Request(`http://t/api/memory/stores?list=rules&scope=${encodeURIComponent(SALES)}&q=d`));
    const page = (await res.json()) as StorePage;
    expect(page.items.map((r) => r.id)).toEqual(["r3"]);
    expect(page.total).toBe(1);
  });

  it("refuses a list value outside the accepted ones, naming them", async () => {
    const res = await GET(new Request("http://t/api/memory/stores?list=notes&kind=todo"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("kind must be one of claim, intent, status, question for notes");
  });
});
