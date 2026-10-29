// The serve-time rule for graph answers (services/memory/graph-fact-sources.ts), given the
// rows a call got back and a suppression list, without a database. The query itself, its one
// statement per call and every guarded read path end to end are in
// graph-fact-sources.realdb.test.ts and graph-fact-source-recheck.realdb.test.ts.
import { describe, expect, it } from "vitest";
import type { ErasedContentFilter } from "./erasure-suppression";
import { servedFacts, sourcesFrom } from "./graph-fact-sources";
import type { MemoryFact } from "@/types/memory";

const ORG = "o1";
const SALES = "org_o1.sales";
const SALES_GROUP = "org_o1-sales";
const ERASED_AT = new Date("2026-10-20T00:00:00Z");
const BEFORE = new Date("2026-10-01T00:00:00Z");
const AFTER = new Date("2026-10-23T00:00:00Z");

/** A suppression list that erased "Ines Varga" and the version ids in `versions`, at ERASED_AT. */
function listOf(versions: string[] = []): ErasedContentFilter {
  const covers = (writtenAt: Date | null) => writtenAt === null || writtenAt <= ERASED_AT;
  const filter = (text: string, writtenAt: Date | null, _recordName?: string | null, versionId?: string) =>
    (text.includes("Ines Varga") || (versionId !== undefined && versions.includes(versionId))) && covers(writtenAt);
  return Object.assign(filter, { byRecordName: () => false, byContactId: () => false, byRuleId: () => false });
}

const row = { content: null, written_at: BEFORE, entity_name: null, episode: null, scope_path: null };
const chunk = (id: string, content: string, at: Date) => ({
  ...row,
  kind: "chunk" as const,
  id,
  content,
  written_at: at,
});
const file = (sourceId: string, episode: string) => ({ ...row, kind: "file" as const, id: sourceId, episode });
const direct = (id: string, content: string, scopePath: string | null, at = BEFORE) => ({
  ...row,
  kind: "direct" as const,
  id,
  content,
  scope_path: scopePath,
  written_at: at,
});
const graph = (uuid: string, fact: string, extra: Partial<MemoryFact> = {}): MemoryFact => ({
  uuid,
  fact,
  validAt: null,
  store: "graph",
  ...extra,
});
const served = (
  fact: MemoryFact,
  rows: Parameters<typeof sourcesFrom>[1],
  list = listOf(),
  group: string | null = SALES_GROUP,
) => sourcesFrom(ORG, rows, list).supports(fact, group);

describe("a stamped graph fact is served only while one of its chunks is live and unsuppressed", () => {
  it("serves it while one chunk exists, and not once none does", () => {
    const fact = graph("e1", "Heron got a discount.", { chunkIds: ["c-gone", "c-live"] });
    expect(served(fact, [chunk("c-live", "Heron got 12%.", BEFORE)])).toBe(true);
    expect(served(fact, [])).toBe(false);
  });

  it("does not serve it when its only live chunk an erasure suppresses (a restored copy)", () => {
    const fact = graph("e1", "Heron got a discount.", { chunkIds: ["c1"] });
    expect(served(fact, [chunk("c1", "Ines Varga gave Heron 12%.", BEFORE)])).toBe(false);
    expect(served(fact, [chunk("c1", "Heron got 12%.", BEFORE)], listOf(["c1"]))).toBe(false);
  });

  it("judges its own text as of its newest live chunk", () => {
    const fact = graph("e1", "Ines Varga approved it.", { chunkIds: ["c-old", "c-new"] });
    expect(served(fact, [chunk("c-old", "It was approved.", BEFORE)])).toBe(false);
    expect(
      served(fact, [chunk("c-old", "It was approved.", BEFORE), chunk("c-new", "Ines Varga approved it.", AFTER)]),
    ).toBe(true);
  });
});

describe("an unstamped graph fact is served only while a live source or a current direct write supports it", () => {
  it("serves a connector fact whose synced file still lists its episode", () => {
    expect(
      served(graph("e1", "Heron renewed.", { sourceId: "s1", sourceEventIds: ["ep1"] }), [file("s1", "ep1")]),
    ).toBe(true);
  });

  it("does not serve one whose source was deleted, whose item was retired, or whose episode is another source's", () => {
    // QA probe: the source row is gone, so no file of it is read back.
    expect(served(graph("e1", "Heron renewed.", { sourceId: "s-deleted", sourceEventIds: ["ep1"] }), [])).toBe(false);
    expect(
      served(graph("e2", "Heron renewed.", { sourceId: "s1", sourceEventIds: ["ep-retired"] }), [file("s1", "ep1")]),
    ).toBe(false);
    expect(
      served(graph("e3", "Heron renewed.", { sourceId: "s2", sourceEventIds: ["ep1"] }), [file("s1", "ep1")]),
    ).toBe(false);
    // A memory service that reports no episodes leaves nothing to resolve the item by.
    expect(served(graph("e4", "Heron renewed.", { sourceId: "s1" }), [file("s1", "ep1")])).toBe(false);
  });

  it("serves a fact with no source only while a current direct write of its text is stored in its partition", () => {
    const fact = graph("e1", "Heron is based in Lyon.");
    expect(served(fact, [direct("c1", "Heron is based in Lyon.", SALES)])).toBe(true);
    // QA probe: no source and nothing stored any more.
    expect(served(fact, [])).toBe(false);
    // Stored in another partition: not this fact's write.
    expect(served(fact, [direct("c1", "Heron is based in Lyon.", "org_o1.hr")])).toBe(false);
    // No partition known for the fact: nothing to match against.
    expect(served(fact, [direct("c1", "Heron is based in Lyon.", SALES)], listOf(), null)).toBe(false);
    // The stored write is a copy an erasure suppresses.
    expect(served(fact, [direct("c1", "Heron is based in Lyon.", SALES)], listOf(["c1"]))).toBe(false);
  });

  it("matches an untagged direct write to the bare-org partition", () => {
    expect(
      served(graph("e1", "Heron is based in Lyon."), [direct("c1", "Heron is based in Lyon.", null)], listOf(), ORG),
    ).toBe(true);
  });

  it("never serves one the suppression list covers by its text or an episode id", () => {
    expect(
      served(graph("e1", "Ines Varga approved it."), [direct("c1", "Ines Varga approved it.", SALES, AFTER)]),
    ).toBe(false);
    expect(
      served(
        graph("e1", "Approved.", { sourceId: "s1", sourceEventIds: ["ep1"] }),
        [file("s1", "ep1")],
        listOf(["ep1"]),
      ),
    ).toBe(false);
  });
});

describe("servedFacts", () => {
  const sources = (rows: Parameters<typeof sourcesFrom>[1]) => sourcesFrom(ORG, rows, listOf());
  const inSales = () => SALES_GROUP;

  it("never rechecks a vector-store row, which the search itself read and filtered", () => {
    const vectorRow: MemoryFact = { uuid: "c1", fact: "Ines Varga approved it.", validAt: null, store: "semantic" };
    expect(servedFacts([vectorRow], sources([]), inSales)).toEqual([vectorRow]);
  });

  it("serves the stored row a stale graph copy was kept over, in its place, and never the field", () => {
    const vectorRow: MemoryFact = { uuid: "c-site", fact: "Launch moves.", validAt: null, store: "semantic" };
    const copy = graph("g", "Launch moves.", { chunkIds: ["c-gone"], displacedCopies: [vectorRow] });
    expect(servedFacts([copy], sources([]), inSales)).toEqual([vectorRow]);
    expect(servedFacts([copy], sources([chunk("c-gone", "Launch moves.", BEFORE)]), inSales)).toEqual([
      graph("g", "Launch moves.", { chunkIds: ["c-gone"] }),
    ]);
  });

  it("keeps the order of what it serves", () => {
    const facts = ["a", "b", "c"].map((id) => graph(id, `${id}.`, { chunkIds: [`c${id}`] }));
    expect(
      servedFacts(facts, sources([chunk("cc", "C", BEFORE), chunk("ca", "A", BEFORE)]), inSales).map((f) => f.uuid),
    ).toEqual(["a", "c"]);
  });
});
