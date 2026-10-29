// The seam between the two halves of provenance re-ranking.
//
// guarded-store.test.ts proves GuardedMemoryStore SORTS on `actorType`, driving
// the real ranker against a mock store that hands it facts already carrying a
// tier. memory-service's Python tests prove /search EMITS `actor_type`. Neither
// covers the piece in between: the two real backend stores actually carrying
// that tier out of the DB row / off the wire and into MemoryFact.
//
// That gap is not theoretical. Deleting the `actorType:` mapping from BOTH
// pgvector-store.ts and graphiti-store.ts leaves the full suite green and
// `tsc --noEmit` clean (MemoryFact.actorType is optional, so the compiler has
// nothing to say). Every fact then falls to the ranker's UNRANKED tier, the
// sort silently degrades to a no-op, and the feature is dead in production with
// no test anywhere going red. These tests pin that wiring.
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: vi.fn(),
    // retrieve() sends its SELECT in one transaction with the index's probe count.
    $executeRawUnsafe: vi.fn(),
    $transaction: (queries: Promise<unknown>[]) => Promise.all(queries),
    auditLog: { create: vi.fn() },
    // The vector read's erased-person filter, for an org with no erasures.
    erasureSuppression: { findMany: vi.fn(async () => []) },
  },
}));

// The access gate is not what's under test here — this file is about
// ranking/ordering only; check()/evaluate() are out of scope.
vi.mock("@/services/access", async () => ({
  check: vi.fn().mockResolvedValue({ allowed: true }),
  recordReadFactIds: vi.fn(),
  // guarded-store.ts calls descendantScopePaths in retrieve()/entity() to fan
  // out to real registered descendant scopes. Not what these tests are about,
  // so it defaults to none.
  // guarded-store.ts's retrieve() calls this pure containment check directly
  // (no DB round trip) to decide whether untagged/bare-org content should be
  // visible for this read — mirrors services/access/check.ts's real pathCovers
  // exactly (ancestor-or-self on dot-separated ltree labels), not a test-only
  // stub, since a wrong mock here would hide a real regression rather than
  // isolate one.
  pathCovers: (coveringPath: string, targetPath: string) =>
    targetPath === coveringPath || targetPath.startsWith(`${coveringPath}.`),
  descendantScopePaths: vi.fn().mockResolvedValue({ paths: [], unsearched: [], partial: false }),
  orgRootPath: vi.fn((orgId: string) => `org_${orgId}`),
  // The real partition resolver, not a copy: it is the store's tenant guard,
  // and every partition these tests read from sits inside the test org.
  resolveExecutedPartition: (await vi.importActual<typeof import("@/services/access/check")>("@/services/access/check"))
    .resolveExecutedPartition,
  // The real SQL builders: pgvector-store.ts assembles every read with them.
  ...(await vi.importActual<typeof import("@/services/access/scope-containment")>(
    "@/services/access/scope-containment",
  )),
  AccessDeniedError: class AccessDeniedError extends Error {
    constructor(public decision: unknown) {
      super("denied");
    }
  },
}));

import { db } from "@/lib/db";
import { GraphitiMemoryStore } from "./graphiti-store";
import { GuardedMemoryStore } from "./guarded-store";
import { PgvectorMemoryStore } from "./pgvector-store";
import type { AccessContext } from "@/services/access";

const ctx = { orgId: "org_1" } as AccessContext;

/** pgvector's retrieve() embeds the query before it ever reaches SQL. */
function stubEmbedding() {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ embedding: [0.1, 0.2] }) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("provenance wiring — backend stores carry actorType into MemoryFact", () => {
  it("pgvector-store carries each row's actorType out of the DB, not a constant", async () => {
    stubEmbedding();
    // Two rows with DIFFERENT tiers: a mapping that dropped the column, or hard-coded
    // one tier for every row, cannot reproduce this.
    vi.mocked(db.$queryRaw).mockResolvedValue([
      {
        id: "c1",
        content: "board approved the raise",
        created_at: new Date("2026-01-01T00:00:00Z"),
        actor_type: "human",
      },
      {
        id: "c2",
        content: "scraped from the deck",
        created_at: new Date("2026-01-02T00:00:00Z"),
        actor_type: "extraction",
      },
    ] as never);

    const facts = (await new PgvectorMemoryStore().retrieve({ groupId: "org_1", query: "raise" })).facts;

    expect(facts.map((f) => [f.uuid, f.actorType])).toEqual([
      ["c1", "human"],
      ["c2", "extraction"],
    ]);
  });

  it("graphiti-store maps /search's actor_type onto actorType", async () => {
    // The existing "retrieve maps snake_case -> camelCase" case in
    // graphiti-store.test.ts asserts with toEqual, which treats an absent key and
    // an `undefined` one as equal — so it stays green whether or not actorType is
    // mapped at all. This asserts the value itself.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          facts: [
            { uuid: "f1", fact: "Jane is CTO", valid_at: null, actor_type: "human" },
            { uuid: "f2", fact: "maybe hiring", valid_at: null, actor_type: "agent" },
          ],
        }),
      }),
    );

    const facts = (
      await new GraphitiMemoryStore("http://svc", "k").retrieve({
        groupId: "org_1",
        query: "cto",
      })
    ).facts;

    expect(facts.map((f) => [f.uuid, f.actorType])).toEqual([
      ["f1", "human"],
      ["f2", "agent"],
    ]);
  });

  it("graphiti-store leaves actorType unset when /search omits it, so the ranker's own default applies", async () => {
    // The documented fallback: fetch_edge_provenance() is best-effort on the
    // Python side and returns null on lookup failure. That must arrive as an
    // absent tier the ranker defaults, never as a crash or a bogus "human".
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ facts: [{ uuid: "f1", fact: "x", valid_at: null, actor_type: null }] }),
      }),
    );

    const facts = (
      await new GraphitiMemoryStore("http://svc", "k").retrieve({
        groupId: "org_1",
        query: "q",
      })
    ).facts;

    expect(facts[0].actorType).toBeUndefined();
  });

  it("end to end: a human row in the DB outranks an extraction row through the real guarded read", async () => {
    // The whole point of provenance ranking, with no hand-written tier anywhere in the test:
    // the tiers come off the DB rows, a real PgvectorMemoryStore maps them, and
    // the real GuardedMemoryStore ranks them. Row order is deliberately the
    // WRONG way round (extraction first, as pgvector's relevance ORDER BY could
    // legitimately return it) so an unranked passthrough keeps "c-extraction"
    // and fails.
    stubEmbedding();
    vi.mocked(db.$queryRaw).mockResolvedValue([
      {
        id: "c-extraction",
        content: "scraped guess",
        created_at: new Date("2026-01-01T00:00:00Z"),
        actor_type: "extraction",
      },
      { id: "c-human", content: "founder said it", created_at: new Date("2026-01-02T00:00:00Z"), actor_type: "human" },
    ] as never);

    const guarded = new GuardedMemoryStore(new PgvectorMemoryStore());
    const result = await guarded.retrieve(ctx, { groupId: "org_1", query: "pricing", limit: 1 });

    expect(result.facts.map((f) => f.uuid)).toEqual(["c-human"]);
  });
});

describe("citation wiring — backend stores carry sourceId and actorName into MemoryFact", () => {
  it("graphiti-store maps /search's source_id and actor_name, leaving them unset when the service sends null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          facts: [
            {
              uuid: "f1",
              fact: "release ships Friday",
              valid_at: null,
              actor_type: "extraction",
              actor_name: "eng-updates",
              source_id: "src_1",
            },
            {
              uuid: "f2",
              fact: "Dana owns the release",
              valid_at: null,
              actor_type: "human",
              actor_name: "Dana",
              source_id: null,
            },
          ],
        }),
      }),
    );

    const facts = (await new GraphitiMemoryStore("http://svc", "k").retrieve({ groupId: "org_1", query: "release" }))
      .facts;

    expect(facts.map((f) => [f.uuid, f.sourceId, f.actorName])).toEqual([
      ["f1", "src_1", "eng-updates"],
      ["f2", undefined, "Dana"],
    ]);
  });

  it("pgvector-store selects each chunk's sourceId and actorName and carries them out", async () => {
    stubEmbedding();
    vi.mocked(db.$queryRaw).mockResolvedValue([
      {
        id: "c1",
        content: "release ships Friday",
        created_at: new Date("2026-01-01T00:00:00Z"),
        actor_type: "extraction",
        actor_name: "eng-updates",
        source_id: "src_1",
      },
      {
        id: "c2",
        content: "Dana owns the release",
        created_at: new Date("2026-01-02T00:00:00Z"),
        actor_type: "human",
        actor_name: null,
        source_id: null,
      },
    ] as never);

    const facts = (await new PgvectorMemoryStore().retrieve({ groupId: "org_1", query: "release" })).facts;

    const sql = (vi.mocked(db.$queryRaw).mock.calls[0][0] as unknown as string[]).join("?");
    expect(sql).toContain('"sourceId" as source_id');
    expect(sql).toContain('"actorName" as actor_name');
    expect(facts.map((f) => [f.uuid, f.sourceId, f.actorName])).toEqual([
      ["c1", "src_1", "eng-updates"],
      ["c2", undefined, undefined],
    ]);
  });
});
