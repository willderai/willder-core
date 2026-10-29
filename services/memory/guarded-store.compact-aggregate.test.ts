// An aggregate read (RetrieveOptions.compactAggregate, set by memory_query only with
// RETRIEVAL_QUERY_SHAPES on) asks its legs wider and serves compact dated snippets, in no more
// characters than the page of whole facts the same read serves without it. Without the option
// the legs are asked, and the page served, exactly as before. These drive the real
// GuardedMemoryStore.retrieve().
import { describe, expect, it, vi } from "vitest";
vi.mock("@/services/memory/superseded-facts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/superseded-facts")>()),
  loadSupersededVersions: async () => ({ byId: new Map(), byText: new Map() }),
}));

vi.mock("@/services/access", async () => ({
  check: vi.fn().mockResolvedValue({ allowed: true }),
  recordReadFactIds: vi.fn(),
  pathCovers: (coveringPath: string, targetPath: string) =>
    targetPath === coveringPath || targetPath.startsWith(`${coveringPath}.`),
  descendantScopePaths: vi.fn().mockResolvedValue({ paths: [], unsearched: [], partial: false }),
  orgRootPath: vi.fn((orgId: string) => `org_${orgId}`),
  resolveExecutedPartition: (await vi.importActual<typeof import("@/services/access/check")>("@/services/access/check"))
    .resolveExecutedPartition,
  AccessDeniedError: class AccessDeniedError extends Error {},
}));

import { recordReadFactIds } from "@/services/access";
import { GuardedMemoryStore } from "./guarded-store";
import type { MemoryStore } from "./memory-store";
import type { MemoryFact } from "@/types/memory";
import type { AccessContext } from "@/services/access";
import { servedCharsOf } from "./query-shapes";

const ctx = { orgId: "org_1" } as AccessContext;

const LONG_ANSWER = "Here is a long and friendly answer with many details. ".repeat(12);
/** One stored round of a dated session, ranked by `similarity`. */
function round(i: number): MemoryFact {
  const day = String((i % 28) + 1).padStart(2, "0");
  return {
    uuid: `r${i}`,
    fact: `Session date: 2023/${String(1 + (i % 12)).padStart(2, "0")}/${day} (Mon) 10:00\n\nuser: I bought jigsaw puzzle number ${i} at the hobby shop.\n\nassistant: ${LONG_ANSWER}`,
    validAt: null,
    actorType: "agent",
    store: "semantic",
    similarity: 0.9 - i / 1000,
  };
}
const ROUNDS = Array.from({ length: 60 }, (_, i) => round(i));

function store(): MemoryStore & { retrieve: ReturnType<typeof vi.fn> } {
  return {
    retrieve: vi.fn().mockImplementation(async (input: { limit?: number }) => ({
      facts: ROUNDS.slice(0, input.limit ?? 10),
      storesRead: [{ store: "semantic" }],
    })),
  } as unknown as MemoryStore & { retrieve: ReturnType<typeof vi.fn> };
}

const QUERY = "How many jigsaw puzzles have I bought?";

describe("GuardedMemoryStore.retrieve with compactAggregate", () => {
  it("asks the legs exactly as before, and serves the same page, without the option", async () => {
    const plain = store();
    const named = store();
    const a = await new GuardedMemoryStore(plain, async () => "enterprise").retrieve(
      ctx,
      { groupId: "org_1", query: QUERY, limit: 10 },
      undefined,
      {},
    );
    const b = await new GuardedMemoryStore(named, async () => "enterprise").retrieve(
      ctx,
      { groupId: "org_1", query: QUERY, limit: 10 },
      undefined,
      { checkNamedValues: false },
    );
    expect(plain.retrieve.mock.calls[0]![0].limit).toBe(40);
    expect(named.retrieve.mock.calls[0]![0].limit).toBe(40);
    expect(JSON.stringify(a.facts)).toBe(JSON.stringify(b.facts));
    expect(a.facts.map((f) => f.uuid)).toEqual(ROUNDS.slice(0, 10).map((f) => f.uuid));
  });

  it("asks wider, serves more records in no more characters, dated and in date order", async () => {
    for (const tier of ["starter", "team", "enterprise"] as const) {
      const wholeStore = store();
      const whole = await new GuardedMemoryStore(wholeStore, async () => tier).retrieve(ctx, {
        groupId: "org_1",
        query: QUERY,
        limit: 10,
      });
      const compactStore = store();
      const compact = await new GuardedMemoryStore(compactStore, async () => tier).retrieve(
        ctx,
        { groupId: "org_1", query: QUERY, limit: 10 },
        undefined,
        { compactAggregate: true },
      );
      expect(compactStore.retrieve.mock.calls[0]![0].limit).toBe(100);
      expect(compact.facts.length, tier).toBeGreaterThan(whole.facts.length);
      expect(servedCharsOf(compact.facts), tier).toBeLessThanOrEqual(servedCharsOf(whole.facts));
      for (const f of compact.facts) {
        expect(f.fact).toMatch(/^Session date: 2023\/\d\d\/\d\d/);
        expect(f.fact).toMatch(/jigsaw puzzle number \d+/);
        expect(f.fact).not.toContain("friendly answer");
      }
      const dates = compact.facts.map((f) => f.fact.slice(14, 24));
      expect(dates).toEqual([...dates].sort());
    }
  });

  it("with aggregateDigest, asks wider still and serves only matching snippets in no more characters", async () => {
    const wholeStore = store();
    const whole = await new GuardedMemoryStore(wholeStore, async () => "enterprise").retrieve(ctx, {
      groupId: "org_1",
      query: QUERY,
      limit: 10,
    });
    const digestStore = store();
    const digest = await new GuardedMemoryStore(digestStore, async () => "enterprise").retrieve(
      ctx,
      { groupId: "org_1", query: QUERY, limit: 10 },
      undefined,
      { compactAggregate: true, aggregateDigest: true },
    );
    // DIGEST_WIDEN (8) times the page, which every leg's overfetch cap (100) already covers.
    expect(digestStore.retrieve.mock.calls[0]![0].limit).toBe(100);
    expect(servedCharsOf(digest.facts)).toBeLessThanOrEqual(servedCharsOf(whole.facts));
    expect(digest.facts.length).toBeGreaterThan(whole.facts.length);
    for (const f of digest.facts)
      expect(f.fact).toMatch(
        /^Session date: 2023\/\d\d\/\d\d[^\n]*\nuser: I bought jigsaw puzzle number \d+ at the hobby shop\.$/,
      );
  });

  it("audits exactly the facts it serves", async () => {
    vi.mocked(recordReadFactIds).mockClear();
    const result = await new GuardedMemoryStore(store(), async () => "team").retrieve(
      ctx,
      { groupId: "org_1", query: QUERY, limit: 10 },
      undefined,
      { compactAggregate: true },
    );
    expect(vi.mocked(recordReadFactIds).mock.calls[0]![2]).toEqual(result.facts.map((f) => f.uuid));
  });
});
