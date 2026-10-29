import { beforeEach, describe, expect, it, vi } from "vitest";

// DELETE /api/sources/:id must retire everything a source ingested, for
// every source type, so revoked or deleted content becomes unavailable to
// retrieval; flipping Source.status alone would leave every fact/chunk live.
// These pin that a delete retires BOTH stores (Graphiti facts by scope,
// pgvector chunks by orgId+scopePath) before marking the source disconnected,
// and that a retirement failure blocks the disconnect rather than reporting
// success on content that is still reachable.

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/access")>();
  const check = vi.fn();
  const can = vi.fn();
  // The real record helper, deciding with the stubs above.
  return { ...actual, check, can, authorizeRecord: actual.recordAuthorizer({ check, can }) };
});
// Mocked at the concrete store module, not the `@/services/memory` barrel:
// the route reaches `removeGroupFacts` through
// `services/memory/source-retirement`, which imports the store directly, so
// this is the one seam both of them share (item
// connector-reconnect-scope-strand-fix-20260922). The retirement helper itself
// stays real here, so these tests cover its scope derivation too.
vi.mock("@/services/memory/store", () => ({
  graphitiStore: { removeGroupFacts: vi.fn() },
}));
vi.mock("@/services/memory/brief-retirement", () => ({ retireBriefsFedBySource: vi.fn(async () => 0) }));
vi.mock("@/lib/db", () => ({
  db: {
    // bumpRemovalEpoch() (services/access/check.ts), after a source's graph facts are retired.
    $executeRaw: vi.fn(async () => 0),
    source: { findFirst: vi.fn(), update: vi.fn() },
    memoryChunk: { deleteMany: vi.fn() },
    changeEvent: { updateMany: vi.fn(async () => ({ count: 0 })) },
    sourceFile: { deleteMany: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));
// The change-feed event is covered by its own tests; here it only has to not throw.
vi.mock("@/services/memory/source-change-event", () => ({ recordSourceChange: vi.fn() }));

import { requireAccessContext } from "@/lib/access-context";
import { db } from "@/lib/db";
import { can, check } from "@/services/access";
import { graphitiStore } from "@/services/memory/store";
import { MemoryServiceError } from "@/services/memory/graphiti-store";
import { recordSourceChange } from "@/services/memory/source-change-event";
import { retireBriefsFedBySource } from "@/services/memory/brief-retirement";
import { DELETE } from "./route";

const rc = {
  org: { id: "org_1" },
  user: { id: "user_42" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "member" }, origin: "app" },
};

const SOURCE = {
  id: "src_1",
  orgId: "org_1",
  type: "slack",
  scopePath: "org_1.slack_general",
  status: "active",
};

function callDelete(id = "src_1") {
  return DELETE(new Request(`http://test/api/sources/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
  vi.mocked(check).mockResolvedValue({ allowed: true } as never);
  // The caller can read the source, so a denial is a 403 rather than its 404.
  vi.mocked(can).mockResolvedValue({ allowed: true } as never);
  vi.mocked(db.source.findFirst).mockResolvedValue(SOURCE as never);
  vi.mocked(graphitiStore.removeGroupFacts).mockResolvedValue({ removedCount: 0 } as never);
  vi.mocked(db.memoryChunk.deleteMany).mockResolvedValue({ count: 0 } as never);
  // Dropping the rows empties what the next scope lookup sees, as it would in
  // Postgres, so the purge after the disconnect covers the current scope only.
  vi.mocked(db.sourceFile.deleteMany).mockImplementation((async () => {
    vi.mocked(db.sourceFile.findMany).mockResolvedValue([] as never);
    return { count: 0 };
  }) as never);
  // No row records a different scope, so the source's own scopePath is the only
  // one retirement has to cover — the single-scope case every test here asserts.
  vi.mocked(db.sourceFile.findMany).mockResolvedValue([] as never);
  vi.mocked(db.source.update).mockResolvedValue(SOURCE as never);
  vi.mocked(db.$transaction).mockImplementation(((fn: (tx: unknown) => unknown) =>
    fn({ source: db.source, sourceFile: db.sourceFile })) as never);
});

describe("DELETE /api/sources/:id", () => {
  it("401s an unauthenticated caller", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null as never);
    const res = await callDelete();
    expect(res.status).toBe(401);
  });

  it("404s a source outside the caller's org", async () => {
    vi.mocked(db.source.findFirst).mockResolvedValue(null as never);
    const res = await callDelete("nope");
    expect(res.status).toBe(404);
    expect(vi.mocked(graphitiStore.removeGroupFacts)).not.toHaveBeenCalled();
  });

  it("403s a denied caller and retires nothing", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "not authorized" } as never);
    const res = await callDelete();
    expect(res.status).toBe(403);
    expect(vi.mocked(graphitiStore.removeGroupFacts)).not.toHaveBeenCalled();
    expect(vi.mocked(db.memoryChunk.deleteMany)).not.toHaveBeenCalled();
    expect(vi.mocked(db.$transaction)).not.toHaveBeenCalled();
  });

  it("retires graph facts and pgvector chunks scoped to this source, then marks it disconnected", async () => {
    // The first purge finds the content; the one after the disconnect finds
    // nothing left, as a real store would.
    vi.mocked(graphitiStore.removeGroupFacts).mockResolvedValueOnce({ removedCount: 12 } as never);
    vi.mocked(db.memoryChunk.deleteMany).mockResolvedValueOnce({ count: 4 } as never);

    const res = await callDelete();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ disconnected: "src_1", retiredFacts: 12, retiredChunks: 4 });

    // Scoped to THIS source's own scope path AND its own id — a
    // caller-suppliable scopePath alone is never enough (item
    // sources-delete-retention-provenance-marker-20260919).
    expect(vi.mocked(graphitiStore.removeGroupFacts)).toHaveBeenCalledWith({
      groupId: "org_1.slack_general",
      sourceId: "src_1",
    });
    expect(vi.mocked(db.memoryChunk.deleteMany)).toHaveBeenCalledWith({
      where: { orgId: "org_1", scopePath: "org_1.slack_general", sourceId: "src_1" },
    });
    // A disconnect has no destination, so every brief that could quote the
    // content is withdrawn (services/memory/brief-retirement.ts).
    expect(vi.mocked(retireBriefsFedBySource)).toHaveBeenCalledWith(
      expect.objectContaining({ id: "src_1", orgId: "org_1" }),
      ["org_1.slack_general"],
      null,
    );
    // SourceFile rows are dropped in the same transaction that flips status,
    // so a reconnect + re-sync doesn't see stale checksums and skip
    // re-ingesting content that was just retired.
    expect(vi.mocked(db.sourceFile.deleteMany)).toHaveBeenCalledWith({ where: { sourceId: "src_1" } });
    expect(vi.mocked(db.source.update)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "src_1" },
        data: { status: "disconnected", encryptedTokens: null },
      }),
    );
    expect(vi.mocked(db.$transaction)).toHaveBeenCalledTimes(1);
    // The event describes the row the update returned, and a disconnect keeps the row.
    expect(vi.mocked(recordSourceChange)).toHaveBeenCalledWith(expect.anything(), SOURCE, "update", "user_42", "app");
  });

  // Guard-removal differential: prove retirement is actually load-bearing, not
  // a call that happens to run alongside a disconnect that would succeed
  // anyway. Removing the two retirement calls leaves the test above passing
  // regardless, since it never observes the ordering; the two tests below are
  // what catch that: a store failure must block the disconnect outright.
  it("does not mark the source disconnected if graph retirement fails, and says why", async () => {
    vi.mocked(graphitiStore.removeGroupFacts).mockRejectedValue(
      new MemoryServiceError("memory service unreachable", 503),
    );

    const res = await callDelete();
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe(
      "Could not remove this source's facts from memory, so it is still connected. memory service unreachable",
    );
    expect(vi.mocked(db.$transaction)).not.toHaveBeenCalled();
    expect(vi.mocked(db.source.update)).not.toHaveBeenCalled();
  });

  it("does not mark the source disconnected if pgvector retirement fails, and returns a body without the raw error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(db.memoryChunk.deleteMany).mockRejectedValue(new Error("db unreachable at 10.0.0.5"));

    const res = await callDelete();
    expect(res.status).toBe(500);
    const { error } = await res.json();
    expect(error).toBe("Could not remove this source's content from memory, so it is still connected. Try again.");
    expect(vi.mocked(db.$transaction)).not.toHaveBeenCalled();
  });

  // A Drive source whose
  // first sync failed has no SourceFile rows and nothing in either store. It
  // still goes through the same retirement (a failed sync can stop after a
  // partial write), which finds nothing, and the source is disconnected.
  it("disconnects an errored source that never ingested anything", async () => {
    vi.mocked(db.source.findFirst).mockResolvedValue({
      ...SOURCE,
      type: "gdrive",
      scopePath: "org_1.mock_sales_collateral",
      status: "error",
    } as never);

    const res = await callDelete();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ disconnected: "src_1", retiredFacts: 0, retiredChunks: 0 });
    expect(vi.mocked(graphitiStore.removeGroupFacts)).toHaveBeenCalledWith({
      groupId: "org_1.mock_sales_collateral",
      sourceId: "src_1",
    });
    expect(vi.mocked(db.source.update)).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "disconnected", encryptedTokens: null } }),
    );
  });

  it("retiring an already-disconnected source's leftover content is idempotent (0 the second time)", async () => {
    vi.mocked(graphitiStore.removeGroupFacts).mockResolvedValue({ removedCount: 0 } as never);
    vi.mocked(db.memoryChunk.deleteMany).mockResolvedValue({ count: 0 } as never);

    const res = await callDelete();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ disconnected: "src_1", retiredFacts: 0, retiredChunks: 0 });
  });

  // A sync still in flight can
  // finish a write after the first purge. The route purges again once the row
  // is disconnected, and whatever that finds is part of what it reports.
  it("purges again after marking the source disconnected, and reports what that found", async () => {
    const order: string[] = [];
    vi.mocked(graphitiStore.removeGroupFacts).mockImplementation((async () => {
      order.push("retire");
      return { removedCount: order.length === 1 ? 5 : 2 };
    }) as never);
    vi.mocked(db.$transaction).mockImplementation((async (fn: (tx: unknown) => unknown) => {
      order.push("disconnect");
      return fn({ source: db.source, sourceFile: db.sourceFile });
    }) as never);

    const res = await callDelete();

    expect(order).toEqual(["retire", "disconnect", "retire"]);
    expect(vi.mocked(graphitiStore.removeGroupFacts)).toHaveBeenLastCalledWith({
      groupId: SOURCE.scopePath,
      sourceId: "src_1",
    });
    expect(await res.json()).toEqual({ disconnected: "src_1", retiredFacts: 7, retiredChunks: 0 });
  });

  it("says the source is disconnected but not yet clean when the second purge fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(graphitiStore.removeGroupFacts)
      .mockResolvedValueOnce({ removedCount: 3 } as never)
      .mockRejectedValueOnce(new MemoryServiceError("memory service unreachable", 503));

    const res = await callDelete();

    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe(
      "The source is disconnected, but content its last sync wrote may still be in memory. " +
        "Disconnect it again to remove it.",
    );
    expect(vi.mocked(db.source.update)).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "disconnected", encryptedTokens: null } }),
    );
  });

  // There is no "refuse the retirement when the scope is shared" heuristic;
  // see route.shared-scope.qa.test.ts for the marker-scoped purge that
  // removes only this source's own content, whether or not the scope happens
  // to be shared.
});

/**
 * Retirement must cover every scope the source ever wrote to, not only
 * `source.scopePath`, the scope the source points at right now. A reconnect
 * that passes an explicit scopePath moves that pointer while already-ingested
 * episodes stay in the group they were written to, so purging only the
 * current scope would leave everything ingested under the previous one live
 * and retrievable. Narrowing a source's scope and then disconnecting it is
 * exactly the revoke path.
 */
describe("DELETE /api/sources/:id — content left in a scope the source no longer points at", () => {
  const PREVIOUS_SCOPE = "org_1.slack_general_old";
  const EVEN_EARLIER = "org_1.slack_general_first";

  it("retires the source's content in every scope its files record, plus the current one", async () => {
    vi.mocked(db.sourceFile.findMany).mockResolvedValue([
      { episodeScopePath: PREVIOUS_SCOPE },
      { episodeScopePath: EVEN_EARLIER },
    ] as never);

    const res = await callDelete();
    expect(res.status).toBe(200);

    const purgedGroups = vi
      .mocked(graphitiStore.removeGroupFacts)
      .mock.calls.map((c) => c[0].groupId)
      .sort();
    // Every recorded scope plus the current one, then the current one again: the
    // purge after the disconnect, where an in-flight sync would have written.
    const expected = [EVEN_EARLIER, PREVIOUS_SCOPE, SOURCE.scopePath, SOURCE.scopePath].sort();
    expect(purgedGroups).toEqual(expected);

    const purgedChunkScopes = vi
      .mocked(db.memoryChunk.deleteMany)
      .mock.calls.map((c) => (c[0] as { where: { scopePath: string } }).where.scopePath)
      .sort();
    expect(purgedChunkScopes).toEqual(expected);
  });

  it("still filters every purge on this source's own id, in every scope", async () => {
    vi.mocked(db.sourceFile.findMany).mockResolvedValue([{ episodeScopePath: PREVIOUS_SCOPE }] as never);

    await callDelete();

    // A previous scope is no more exclusive to this source than its current one
    // (see route.shared-scope.qa.test.ts), so widening the scope set must not
    // quietly widen what gets destroyed inside each one.
    for (const call of vi.mocked(graphitiStore.removeGroupFacts).mock.calls) {
      expect(call[0].sourceId).toBe("src_1");
    }
    for (const call of vi.mocked(db.memoryChunk.deleteMany).mock.calls) {
      expect((call[0] as { where: { sourceId: string } }).where.sourceId).toBe("src_1");
    }
  });

  it("reports the totals summed across every scope it purged", async () => {
    vi.mocked(db.sourceFile.findMany).mockResolvedValue([{ episodeScopePath: PREVIOUS_SCOPE }] as never);
    vi.mocked(graphitiStore.removeGroupFacts)
      .mockResolvedValueOnce({ removedCount: 4 } as never)
      .mockResolvedValueOnce({ removedCount: 4 } as never);
    vi.mocked(db.memoryChunk.deleteMany)
      .mockResolvedValueOnce({ count: 3 } as never)
      .mockResolvedValueOnce({ count: 3 } as never);

    const res = await callDelete();

    // Two scopes, so the counts are the sum, not one scope's worth reported as
    // if it were everything.
    expect(await res.json()).toEqual({ disconnected: "src_1", retiredFacts: 8, retiredChunks: 6 });
  });

  it("purges a scope once when its files record the scope the source still points at", async () => {
    // The common case: the source never moved, so every row records the scope it
    // still points at. Purging it twice would double-count the reported totals.
    vi.mocked(db.sourceFile.findMany).mockResolvedValue([
      { episodeScopePath: SOURCE.scopePath },
      { episodeScopePath: SOURCE.scopePath },
    ] as never);

    await callDelete();

    // Once per purge: before the disconnect and after it.
    expect(vi.mocked(graphitiStore.removeGroupFacts)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(db.memoryChunk.deleteMany)).toHaveBeenCalledTimes(2);
  });

  it("does not disconnect the source when a previous scope's purge fails", async () => {
    vi.mocked(db.sourceFile.findMany).mockResolvedValue([{ episodeScopePath: PREVIOUS_SCOPE }] as never);
    vi.mocked(graphitiStore.removeGroupFacts)
      .mockResolvedValueOnce({ removedCount: 1 } as never)
      .mockRejectedValueOnce(new MemoryServiceError("memory service 500", 500));

    const res = await callDelete();
    expect(res.status).toBe(502);

    // Same contract as a current-scope failure: the source stays active with its
    // sync history intact, so a retry re-attempts the whole purge.
    expect(vi.mocked(db.$transaction)).not.toHaveBeenCalled();
  });

  it("a row with no recorded scope does not widen the purge to a null group", async () => {
    // Legacy rows (written before the column existed) select out of the query
    // entirely; this pins that a null never reaches a store call as a group id.
    vi.mocked(db.sourceFile.findMany).mockResolvedValue([] as never);

    await callDelete();

    expect(vi.mocked(db.sourceFile.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sourceId: "src_1", episodeScopePath: { not: null } } }),
    );
    // Once per purge, and each time only the current scope.
    expect(vi.mocked(graphitiStore.removeGroupFacts).mock.calls).toEqual([
      [{ groupId: SOURCE.scopePath, sourceId: "src_1" }],
      [{ groupId: SOURCE.scopePath, sourceId: "src_1" }],
    ]);
  });
});
