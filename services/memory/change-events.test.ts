// The seam here is `recordChangeEvent`'s conversation with its transaction: what
// SQL it sends, in what order, and what row it finally writes. The ordering is
// the substance — the advisory lock has to be held before the next `seq` is read,
// or two writers can take the same one and a reader can skip an event forever.
//
// A fake transaction can pin that order and those bound values. It cannot prove
// Postgres actually serializes two real transactions behind the lock; that needs
// a database and lives in change-events.realdb.test.ts.
import { describe, expect, it, vi } from "vitest";
import { SUMMARY_MAX_CHARS, recordChangeEvent, summarizeChange } from "./change-events";

const ORG = "org-cuid-1";
const CREATED_ID = "0f6f6a1e-7b1a-4f0e-9d1a-7a3f2c5b9e01";

/** A transaction double that answers the next-seq query with `maxSeq` and records
 * every statement it was sent, in order. */
function fakeTransaction(maxSeq: bigint | null) {
  const sql: { text: string; values: unknown[] }[] = [];
  // The real `create` returns the row it wrote, including the id Postgres/Prisma
  // generated for it — `recordChangeEvent` hands that id back as the feed's cursor.
  const create = vi.fn(async (_args: { data: Record<string, unknown> }) => ({ id: CREATED_ID }));
  const $queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    sql.push({ text, values });
    if (!text.includes("MAX")) return [];
    return [{ next: maxSeq === null ? BigInt(1) : maxSeq + BigInt(1) }];
  });
  return { sql, create, tx: { $queryRaw, changeEvent: { create } } as never };
}

const input = {
  orgId: ORG,
  scopePath: "org_1.sales",
  recordType: "fact",
  recordId: "fact-cuid-1",
  op: "create" as const,
  actorId: "agent-cuid-1",
  actorType: "agent" as const,
  origin: "mcp" as const,
  title: "Acme moved the renewal to Q3",
};

describe("recordChangeEvent", () => {
  it("takes the per-org advisory lock before reading the next seq", async () => {
    const { sql, tx } = fakeTransaction(BigInt(40));

    await recordChangeEvent(tx, input);

    expect(sql).toHaveLength(2);
    expect(sql[0].text).toContain("pg_advisory_xact_lock");
    expect(sql[0].values).toEqual([expect.any(Number), ORG]);
    expect(sql[1].text).toContain("MAX");
  });

  it("assigns the org's next seq", async () => {
    const { create, tx } = fakeTransaction(BigInt(40));

    const { seq } = await recordChangeEvent(tx, input);

    expect(seq).toBe(BigInt(41));
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ orgId: ORG, seq: BigInt(41) }) });
  });

  it("starts at seq 1 for an org with no events yet", async () => {
    const { tx } = fakeTransaction(null);

    expect(await recordChangeEvent(tx, input)).toEqual({ id: CREATED_ID, seq: BigInt(1) });
  });

  it("reads the next seq scoped to the writing org, never across tenants", async () => {
    const { sql, tx } = fakeTransaction(BigInt(40));

    await recordChangeEvent(tx, input);

    expect(sql[1].text).toContain('"orgId" =');
    expect(sql[1].values).toEqual([ORG]);
  });

  it("writes the record's own scope onto the event", async () => {
    const { create, tx } = fakeTransaction(BigInt(0));

    await recordChangeEvent(tx, { ...input, scopePath: "org_1.sales.eu" });

    expect(create.mock.calls[0]?.[0].data.scopePath).toBe("org_1.sales.eu");
  });

  it("refuses a scopePath that is not a valid ltree path, and writes nothing", async () => {
    const { create, tx } = fakeTransaction(BigInt(0));

    // A path like this casts fine as text but throws on `::ltree`, which would
    // make every later read of this org's feed fail rather than just this write.
    await expect(recordChangeEvent(tx, { ...input, scopePath: "org_1..sales" })).rejects.toThrow(
      /valid ltree scopePath/,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses an empty scopePath rather than defaulting to the org root", async () => {
    const { create, tx } = fakeTransaction(BigInt(0));

    await expect(recordChangeEvent(tx, { ...input, scopePath: "" })).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });

  it("stores the summarized title, not the raw one", async () => {
    const { create, tx } = fakeTransaction(BigInt(0));

    await recordChangeEvent(tx, { ...input, title: "  Renewal moved\nInternal note: do not send  " });

    expect(create.mock.calls[0]?.[0].data.summary).toBe("Renewal moved");
  });
});

describe("summarizeChange", () => {
  it("keeps a short single-line title as it is", () => {
    expect(summarizeChange("Acme moved the renewal to Q3")).toBe("Acme moved the renewal to Q3");
  });

  it("keeps only the first line", () => {
    expect(summarizeChange("Renewal moved\nsecond paragraph\nthird")).toBe("Renewal moved");
  });

  it("collapses runs of whitespace and trims", () => {
    expect(summarizeChange("  Acme   moved \t the  renewal ")).toBe("Acme moved the renewal");
  });

  it("replaces control characters instead of storing them", () => {
    expect(summarizeChange("Acme\u0007moved\u0000on")).toBe("Acme moved on");
  });

  it("returns an empty summary for a titleless record", () => {
    expect(summarizeChange("")).toBe("");
    expect(summarizeChange("   \n  ")).toBe("");
  });

  it("truncates to the documented ceiling, counted in code points", () => {
    const summary = summarizeChange("a".repeat(500));

    expect(Array.from(summary)).toHaveLength(SUMMARY_MAX_CHARS);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("never splits a surrogate pair when truncating", () => {
    // Each emoji is two UTF-16 code units, so a length-based cut lands mid-pair
    // and leaves a lone surrogate — a string Postgres rejects as invalid UTF-8.
    const summary = summarizeChange("😀".repeat(400));

    expect(summary).toBe("😀".repeat(SUMMARY_MAX_CHARS - 1) + "…");
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(summary)).toBe(false);
  });

  it("does not truncate a title that is exactly at the ceiling", () => {
    const exact = "b".repeat(SUMMARY_MAX_CHARS);

    expect(summarizeChange(exact)).toBe(exact);
  });
});
