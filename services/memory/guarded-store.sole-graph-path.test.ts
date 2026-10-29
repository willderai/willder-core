// Structural: GuardedMemoryStore reads the graph only through the serve-time source check
// (services/memory/source-checked-reads.ts). A read of the backing store
// that goes around it (`this.store.retrieve`, `.entity`, `.graph`, `.findFactById`) could hand
// a reader graph text whose stored source was deleted or erased, so this fails on one. The
// writes and removals (`removeFact`, `removeEntity`, `transferEntity`) serve no graph text.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(__dirname, "guarded-store.ts"), "utf8");
const GRAPH_READS = ["retrieve", "entity", "graph", "findFactById"];

describe("GuardedMemoryStore's graph reads", () => {
  it("never read the backing store around the source check", () => {
    const bypasses = [...source.matchAll(/this\.store\s*\.\s*(\w+)/g)]
      .map((m) => m[1])
      .filter((method) => GRAPH_READS.includes(method!));
    expect(bypasses).toEqual([]);
  });

  it("read through the source-checked wrapper, built over the backing store", () => {
    expect(source).toMatch(/this\.reads = sourceCheckedReads\(store\)/);
    for (const method of GRAPH_READS) expect(source).toMatch(new RegExp(`this\\.reads\\.${method}\\(`));
  });
});
