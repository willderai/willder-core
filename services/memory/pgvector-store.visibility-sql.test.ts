// The vector search applies the read's visibility predicate (org, embedding present,
// current versions only, scope containment) in every place it selects rows: the row leg,
// the passage leg, the final SELECT that serves the candidates, and the text leg's own
// query when the query quotes stored text (services/memory/text-match-fusion.ts).
//
// The final SELECT's copy is a second line of defence: every leg already filters, so no
// database test can tell it is missing. This pins it in the SQL itself, so removing it
// is a visible change rather than a silent one.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRawUnsafe: vi.fn(),
    $transaction: (queries: Promise<unknown>[]) => Promise.all(queries),
  },
}));

import { db } from "@/lib/db";
import { PgvectorMemoryStore } from "./pgvector-store";

/** Every occurrence of `needle` in `text`, by offset. */
function offsetsOf(text: string, needle: string): number[] {
  const found: number[] = [];
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) found.push(at);
  return found;
}

describe("PgvectorMemoryStore.retrieve: where the visibility predicate sits", () => {
  beforeEach(() => {
    vi.mocked(db.$queryRaw).mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ embedding: [0.1, 0.2] }), { status: 200 })),
    );
  });

  const sqlOf = () =>
    vi.mocked(db.$queryRaw).mock.calls.map(([strings]) => (strings as TemplateStringsArray).join("?"));
  const CLAUSES = [
    'memory_chunks."orgId" = ?',
    "embedding IS NOT NULL",
    `superseding."kind" = 'supersedes'`,
    '"scopePath" = ',
  ];

  it("filters the row leg, the passage leg and the final SELECT", async () => {
    await new PgvectorMemoryStore().retrieve({
      groupId: "org_o.sales",
      tenantId: "o",
      scopePath: "org_o.sales",
      query: "q",
    });

    // A query that quotes nothing asks the search alone, with no text leg in it.
    expect(sqlOf()).toHaveLength(1);
    const sql = sqlOf().find((text) => text.includes("nearest_passages"))!;
    expect(sql).not.toContain("~*");
    expect(sql).not.toContain("unnest");
    const legsEnd = sql.indexOf("WHERE id IN (SELECT id FROM nearest_rows UNION SELECT id FROM nearest_passages");
    expect(legsEnd).toBeGreaterThan(0);
    for (const clause of CLAUSES) {
      const at = offsetsOf(sql, clause);
      expect(at, clause).toHaveLength(3);
      expect(at[2], `${clause} in the final SELECT`).toBeGreaterThan(legsEnd);
    }
  });

  it("filters the text leg, asked before the search when the query quotes stored text", async () => {
    await new PgvectorMemoryStore().retrieve({
      groupId: "org_o.sales",
      tenantId: "o",
      scopePath: "org_o.sales",
      query: "the renewal key lives here",
    });

    const [text, search] = sqlOf();
    expect(text).toContain("~*");
    expect(search).toContain("nearest_passages");
    for (const clause of CLAUSES) expect(offsetsOf(text!, clause), clause).toHaveLength(1);
  });

  // The text leg scans every visible row whose trigrams a quote shares, so a quote
  // of common words in an order no row holds reads the whole org. It runs under a statement
  // timeout, as readable-values.ts withinTimeout does, and a leg cut short leaves the read to
  // the vector legs instead of failing it.
  it("bounds the text leg with a statement timeout, and a leg that times out leaves the read answered", async () => {
    const canceled = Object.assign(new Error("canceling statement due to statement timeout"), {
      meta: { driverAdapterError: { cause: { originalCode: "57014" } } },
    });
    vi.mocked(db.$executeRawUnsafe).mockClear();
    vi.mocked(db.$queryRaw).mockImplementationOnce(() => Promise.reject(canceled) as never);

    const result = await new PgvectorMemoryStore().retrieve({
      groupId: "org_o.sales",
      tenantId: "o",
      scopePath: "org_o.sales",
      query: "the the the the the the the the",
    });

    const settings = vi.mocked(db.$executeRawUnsafe).mock.calls.map(([statement]) => String(statement));
    expect(settings.some((statement) => /statement_timeout/i.test(statement))).toBe(true);
    expect(result.storesRead).toEqual([{ store: "semantic" }]);
    expect(sqlOf().some((text) => text.includes("nearest_passages"))).toBe(true);
  });
});
