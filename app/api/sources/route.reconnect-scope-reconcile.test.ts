import { beforeEach, describe, expect, it, vi } from "vitest";

// The connect's widening gate has its own tests (app/api/sources/route.widening.realdb.test.ts). Here the
// source reports no one beyond the scope, so these tests stay on what they cover.
vi.mock("@/services/connectors/source-readers", () => ({
  readersAtSource: vi.fn(async () => ({ kind: "known", readers: [{ kind: "everyone" }] })),
}));
vi.mock("@/services/access/source-widening", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/access/source-widening")>()),
  scopeAudience: vi.fn(async () => ({ people: [], agents: [] })),
}));

/**
 * A reconnect that moves a source's scope retires the episodes left under the old
 * one (route half).
 *
 * `POST /api/sources` with an explicit `scopePath` rewrites `Source.scopePath`
 * on a reconnect. Graphiti partitions by the scope an episode was written under,
 * so moving that pointer alone left every already-ingested episode in the old
 * group — still retrievable to anyone with access there, and no longer
 * addressable by the sync, which only knows the source's current scope. That
 * makes narrowing a connector's scope do the opposite of what it says.
 *
 * The route now retires the source's content wherever it was written, and drops
 * its sync records, BEFORE the upsert moves the pointer — so the sync fired
 * immediately after re-ingests everything under the new scope.
 */

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: vi.fn(() => false), per: { hour: 3600 } }));
vi.mock("@/lib/inngest", () => ({
  SOURCE_SYNC_EVENT: "source/sync.requested",
  inngest: { send: vi.fn().mockResolvedValue({ ids: ["job_1"] }) },
}));
vi.mock("@/lib/db", () => ({
  db: {
    // bumpRemovalEpoch() (services/access/check.ts), after a source's graph facts are retired.
    $executeRaw: vi.fn(async () => 0),
    source: { findUnique: vi.fn(), upsert: vi.fn() },
    scope: { findUnique: vi.fn() },
    sourceFile: { findMany: vi.fn(), deleteMany: vi.fn() },
    memoryChunk: { deleteMany: vi.fn() },
    changeEvent: { updateMany: vi.fn(async () => ({ count: 0 })) },
    $transaction: vi.fn(),
  },
}));
// The change-feed event is covered by its own tests; here it only has to not throw.
vi.mock("@/services/memory/source-change-event", () => ({ recordSourceChange: vi.fn() }));
vi.mock("@/services/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/access")>();
  return { ...actual, check: vi.fn() };
});
// Mocked at the concrete store module, which is what
// services/memory/source-retirement imports — the retirement helper itself stays
// real, so these tests cover its scope derivation as well as the route.
vi.mock("@/services/memory/store", () => ({
  graphitiStore: { removeGroupFacts: vi.fn() },
}));
vi.mock("@/services/memory/brief-retirement", () => ({ retireBriefsFedBySource: vi.fn(async () => 0) }));

import { requireAccessContext } from "@/lib/access-context";
import { db } from "@/lib/db";
import { check } from "@/services/access";
import { graphitiStore } from "@/services/memory/store";
import { retireBriefsFedBySource } from "@/services/memory/brief-retirement";
import { POST } from "./route";

const OLD_SCOPE = "org_1.slack_eng_a1b2";
const NEW_SCOPE = "org_1.restricted";

const rc = {
  org: { id: "org_1" },
  user: { id: "user_42" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "member" } },
};

/** The source as already stored: connected and synced under the old scope. */
const storedSource = { id: "src_1", orgId: "org_1", scopePath: OLD_SCOPE };

function reconnect(scopePath?: string) {
  return new Request("http://test/api/sources", {
    method: "POST",
    body: JSON.stringify({ type: "slack", channelId: "C123", channelName: "#eng", scopePath }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
  vi.mocked(check).mockResolvedValue({ allowed: true } as never);
  vi.mocked(db.scope.findUnique).mockResolvedValue({ id: "scope_2", path: NEW_SCOPE } as never);
  vi.mocked(db.source.findUnique).mockResolvedValue(storedSource as never);
  vi.mocked(db.source.upsert).mockResolvedValue({
    id: "src_1",
    type: "slack",
    name: "#eng",
    scopePath: NEW_SCOPE,
    status: "active",
  } as never);
  // The upsert runs in a transaction with its change event; pass it straight through.
  vi.mocked(db.$transaction).mockImplementation(((fn: (tx: unknown) => unknown) =>
    fn({ source: db.source, $executeRaw: vi.fn() })) as never);
  vi.mocked(db.sourceFile.findMany).mockResolvedValue([] as never);
  vi.mocked(db.sourceFile.deleteMany).mockResolvedValue({ count: 3 } as never);
  vi.mocked(db.memoryChunk.deleteMany).mockResolvedValue({ count: 2 } as never);
  vi.mocked(graphitiStore.removeGroupFacts).mockResolvedValue({ removedCount: 5 } as never);
});

describe("POST /api/sources — a reconnect that moves the scope", () => {
  it("retires this source's content in the scope it is leaving, in both stores", async () => {
    const res = await POST(reconnect(NEW_SCOPE));
    expect(res.status).toBe(201);

    expect(vi.mocked(graphitiStore.removeGroupFacts)).toHaveBeenCalledWith({
      groupId: OLD_SCOPE,
      sourceId: "src_1",
    });
    expect(vi.mocked(db.memoryChunk.deleteMany)).toHaveBeenCalledWith({
      where: { orgId: "org_1", scopePath: OLD_SCOPE, sourceId: "src_1" },
    });
  });

  it("withdraws the briefs that can no longer read the content, naming the scope it moves to", async () => {
    await POST(reconnect(NEW_SCOPE));

    expect(vi.mocked(retireBriefsFedBySource)).toHaveBeenCalledWith(
      expect.objectContaining({ id: "src_1", orgId: "org_1" }),
      [OLD_SCOPE],
      NEW_SCOPE,
    );
  });

  it("purges and clears the sync records BEFORE the pointer moves", async () => {
    const calls: string[] = [];
    vi.mocked(graphitiStore.removeGroupFacts).mockImplementation(async () => {
      calls.push("retire-facts");
      return { removedCount: 5 };
    });
    vi.mocked(db.memoryChunk.deleteMany).mockImplementation((async () => {
      calls.push("retire-chunks");
      return { count: 2 };
    }) as never);
    vi.mocked(db.sourceFile.deleteMany).mockImplementation((async () => {
      calls.push("drop-sync-records");
      return { count: 3 };
    }) as never);
    vi.mocked(db.source.upsert).mockImplementation((async () => {
      calls.push("move-pointer");
      return { id: "src_1", type: "slack", name: "#eng", scopePath: NEW_SCOPE, status: "active" };
    }) as never);

    await POST(reconnect(NEW_SCOPE));

    // The order is the whole safety property: if any step before the pointer
    // move fails, the source still points at the scope its content is in. The
    // second purge, after the move, catches a sync that was writing to the old
    // scope during the first one and finished before the pointer moved.
    expect(calls).toEqual([
      "retire-facts",
      "retire-chunks",
      "drop-sync-records",
      "move-pointer",
      "retire-facts",
      "retire-chunks",
      "drop-sync-records",
    ]);
  });

  it("covers a scope its files record that the source no longer points at", async () => {
    // A source moved more than once: content exists under two earlier scopes,
    // neither of them the one it points at now.
    const EVEN_OLDER = "org_1.slack_eng_0000";
    vi.mocked(db.sourceFile.findMany).mockResolvedValue([
      { episodeScopePath: EVEN_OLDER },
      { episodeScopePath: OLD_SCOPE },
    ] as never);

    await POST(reconnect(NEW_SCOPE));

    const purgedGroups = [
      ...new Set(vi.mocked(graphitiStore.removeGroupFacts).mock.calls.map((c) => c[0].groupId)),
    ].sort();
    expect(purgedGroups).toEqual([EVEN_OLDER, OLD_SCOPE].sort());
  });

  it("does not move the pointer when the purge fails, so nothing is stranded", async () => {
    vi.mocked(graphitiStore.removeGroupFacts).mockRejectedValue(new Error("memory service 500"));

    await expect(POST(reconnect(NEW_SCOPE))).rejects.toThrow("memory service 500");

    // Pointer unmoved and sync records intact: a retry reconciles the same pair
    // again instead of leaving content under a scope nothing records any more.
    expect(vi.mocked(db.source.upsert)).not.toHaveBeenCalled();
    expect(vi.mocked(db.sourceFile.deleteMany)).not.toHaveBeenCalled();
  });
});

describe("POST /api/sources — reconnects that must NOT purge anything", () => {
  it("a reconnect to the scope it already has leaves its content alone", async () => {
    vi.mocked(db.scope.findUnique).mockResolvedValue({ id: "scope_1", path: OLD_SCOPE } as never);

    const res = await POST(reconnect(OLD_SCOPE));
    expect(res.status).toBe(201);

    // Re-ingesting an unchanged source would be pure waste, and retiring its
    // content first would make it briefly unretrievable for no reason.
    expect(vi.mocked(graphitiStore.removeGroupFacts)).not.toHaveBeenCalled();
    expect(vi.mocked(db.memoryChunk.deleteMany)).not.toHaveBeenCalled();
    expect(vi.mocked(db.sourceFile.deleteMany)).not.toHaveBeenCalled();
  });

  it("a reconnect that omits scopePath reuses its own scope and purges nothing", async () => {
    const res = await POST(reconnect(undefined));
    expect(res.status).toBe(201);

    expect(vi.mocked(db.scope.findUnique)).not.toHaveBeenCalled();
    expect(vi.mocked(graphitiStore.removeGroupFacts)).not.toHaveBeenCalled();
    expect(vi.mocked(db.source.upsert)).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ scopePath: OLD_SCOPE }) }),
    );
  });

  it("a first-time connect with an explicit scope has nothing to retire", async () => {
    vi.mocked(db.source.findUnique).mockResolvedValue(null as never);

    const res = await POST(reconnect(NEW_SCOPE));
    expect(res.status).toBe(201);

    expect(vi.mocked(graphitiStore.removeGroupFacts)).not.toHaveBeenCalled();
    expect(vi.mocked(db.sourceFile.deleteMany)).not.toHaveBeenCalled();
  });
});

describe("POST /api/sources — denied and malformed scope changes touch nothing", () => {
  it("a scopePath that does not exist in this org 404s before any purge", async () => {
    // The scope lookup is keyed on (orgId, path), so another tenant's real scope
    // is indistinguishable from a nonexistent one here — both miss.
    vi.mocked(db.scope.findUnique).mockResolvedValue(null as never);

    const res = await POST(reconnect("org_2.their_private_scope"));
    expect(res.status).toBe(404);

    expect(vi.mocked(graphitiStore.removeGroupFacts)).not.toHaveBeenCalled();
    expect(vi.mocked(db.memoryChunk.deleteMany)).not.toHaveBeenCalled();
    expect(vi.mocked(db.source.upsert)).not.toHaveBeenCalled();
  });

  it("a denied memory.write never reaches the scope change at all", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "no grant on scope" } as never);

    const res = await POST(reconnect(NEW_SCOPE));
    expect(res.status).toBe(403);

    expect(vi.mocked(db.source.findUnique)).not.toHaveBeenCalled();
    expect(vi.mocked(graphitiStore.removeGroupFacts)).not.toHaveBeenCalled();
    expect(vi.mocked(db.source.upsert)).not.toHaveBeenCalled();
  });

  it("a non-string scopePath is treated as absent, not as a scope change", async () => {
    const res = await POST(
      new Request("http://test/api/sources", {
        method: "POST",
        body: JSON.stringify({
          type: "slack",
          channelId: "C123",
          channelName: "#eng",
          scopePath: { path: NEW_SCOPE },
        }),
      }),
    );
    expect(res.status).toBe(201);

    // Falls through to the reconnect branch, which reuses the source's own
    // scope — so there is no scope change and nothing to purge.
    expect(vi.mocked(db.scope.findUnique)).not.toHaveBeenCalled();
    expect(vi.mocked(graphitiStore.removeGroupFacts)).not.toHaveBeenCalled();
  });
});
