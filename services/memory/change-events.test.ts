// The seam here is `recordChangeEvent`'s conversation with its transaction: what
// SQL it sends and what row it writes. The substance is that the event's `seq` is
// taken inside the INSERT itself, by public.change_event_next_seq, which takes the
// per-org advisory lock and only then reads the next `seq`; split apart, two writers
// could take the same one and a reader could skip an event forever.
//
// A fake transaction can pin that statement and its bound values. It cannot prove
// Postgres actually serializes two real transactions behind the lock, or that the
// function reads after the lock is granted; that needs a database and lives in
// change-events.realdb.test.ts.
import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@/lib/generated/prisma/client";
import {
  SUMMARY_MAX_CHARS,
  recordChangeEvent,
  recordChangeEvents,
  recordFactCreateOnce,
  summarizeChange,
} from "./change-events";
import { insertedChangeEvents, statementOf } from "./change-events.testsupport";

const ORG = "org-cuid-1";
const CREATED_ID = "0f6f6a1e-7b1a-4f0e-9d1a-7a3f2c5b9e01";

/** A transaction double that answers an event insert with seq `nextSeq` (as node-postgres
 * hands a BIGINT back, a string) and records every statement it was sent, in order. */
function fakeTransaction(nextSeq: bigint) {
  const sql: Prisma.Sql[] = [];
  const create = vi.fn();
  const createMany = vi.fn();
  const $queryRaw = vi.fn(async (query: TemplateStringsArray, ...values: unknown[]) => {
    const statement = statementOf(query, values);
    sql.push(statement);
    const rows = insertedChangeEvents(statement) ?? [];
    return rows.map((_, i) => ({ id: CREATED_ID, seq: String(nextSeq + BigInt(i)) }));
  });
  return { sql, create, tx: { $queryRaw, changeEvent: { create, createMany } } as never };
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
  it("writes the event in one statement whose seq is taken under the org's lock inside it", async () => {
    const { sql, create, tx } = fakeTransaction(BigInt(41));

    await recordChangeEvent(tx, input);

    expect(sql).toHaveLength(1);
    expect(sql[0]!.sql).toMatch(/^\s*INSERT INTO "change_events"/);
    expect(sql[0]!.sql).toContain("public.change_event_next_seq(");
    expect(create).not.toHaveBeenCalled();
  });

  it("returns the seq the database assigned, as a bigint", async () => {
    const { tx } = fakeTransaction(BigInt(41));

    expect(await recordChangeEvent(tx, input)).toEqual({ id: CREATED_ID, seq: BigInt(41) });
  });

  it("takes the next seq for the writing org, never across tenants", async () => {
    const { sql, tx } = fakeTransaction(BigInt(1));

    await recordChangeEvent(tx, input);

    const call = /public\.change_event_next_seq\(\$(\d+)\)/.exec(sql[0]!.text);
    expect(sql[0]!.values[Number(call![1]) - 1]).toBe(ORG);
  });

  it("writes the record's own scope onto the event", async () => {
    const { sql, tx } = fakeTransaction(BigInt(1));

    await recordChangeEvent(tx, { ...input, scopePath: "org_1.sales.eu" });

    expect(insertedChangeEvents(sql[0]!)![0]!.scopePath).toBe("org_1.sales.eu");
  });

  it("refuses a scopePath that is not a valid ltree path, and writes nothing", async () => {
    const { sql, tx } = fakeTransaction(BigInt(1));

    // A path like this casts fine as text but throws on `::ltree`, which would
    // make every later read of this org's feed fail rather than just this write.
    await expect(recordChangeEvent(tx, { ...input, scopePath: "org_1..sales" })).rejects.toThrow(
      /valid ltree scopePath/,
    );
    expect(sql).toHaveLength(0);
  });

  it("refuses an empty scopePath rather than defaulting to the org root", async () => {
    const { sql, tx } = fakeTransaction(BigInt(1));

    await expect(recordChangeEvent(tx, { ...input, scopePath: "" })).rejects.toThrow();
    expect(sql).toHaveLength(0);
  });

  it("stores the summarized title, not the raw one", async () => {
    const { sql, tx } = fakeTransaction(BigInt(1));

    await recordChangeEvent(tx, { ...input, title: "  Renewal moved\nInternal note: do not send  " });

    expect(insertedChangeEvents(sql[0]!)![0]!.summary).toBe("Renewal moved");
  });
});

describe("recordChangeEvents", () => {
  it("writes every event in one statement, taking the org's next seq once for the first", async () => {
    const { sql, tx } = fakeTransaction(BigInt(1));

    await recordChangeEvents(tx, [input, { ...input, recordId: "fact-cuid-2" }]);

    expect(sql).toHaveLength(1);
    expect(sql[0]!.sql.match(/public\.change_event_next_seq\(/g)).toHaveLength(1);
    expect(insertedChangeEvents(sql[0]!)!.map((event) => event.recordId)).toEqual(["fact-cuid-1", "fact-cuid-2"]);
  });

  it("refuses any event with an invalid scope, and writes nothing", async () => {
    const { sql, tx } = fakeTransaction(BigInt(1));

    await expect(recordChangeEvents(tx, [input, { ...input, scopePath: "org_1..sales" }])).rejects.toThrow(
      /valid ltree scopePath/,
    );
    expect(sql).toHaveLength(0);
  });

  it("refuses events of two orgs in one call", async () => {
    const { sql, tx } = fakeTransaction(BigInt(1));

    await expect(recordChangeEvents(tx, [input, { ...input, orgId: "org-other" }])).rejects.toThrow(/one org's events/);
    expect(sql).toHaveLength(0);
  });
});

describe("recordFactCreateOnce", () => {
  it("takes the seq inside its insert and defers to the fact's create-once index", async () => {
    const { sql, tx } = fakeTransaction(BigInt(7));

    expect(await recordFactCreateOnce(tx, input)).toEqual({ id: CREATED_ID, seq: BigInt(7) });
    expect(sql).toHaveLength(1);
    expect(sql[0]!.sql).toContain("public.change_event_next_seq(");
    expect(sql[0]!.sql).toContain("ON CONFLICT");
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
