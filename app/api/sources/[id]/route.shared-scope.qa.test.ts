// Mocked end to end: needs no database; runs in every environment.

import { beforeEach, describe, expect, it, vi } from "vitest";

// DELETE /api/sources/:id on a scope shared with other content.
//
// A scope is never exclusive to one source: another connector Source, the
// org's own directly ingested memory, or a document upload can all share it.
// Purging a disconnected source's WHOLE scope would destroy that co-located
// content and report the collateral back as this source's own retired
// content; refusing the whole retirement whenever the scope is shared would
// leave a revoked source's OWN content retrievable there, and could not even
// detect an upload (uploads write actorType "extraction", the same tag
// connector sync uses).
//
// So MemoryChunk.sourceId and every Graphiti fact's stamped source_id
// (memory-service/app/main.py's provenance JSON) identify which connector
// Source produced a row, and the route purges by that marker unconditionally,
// with no "is this scope exclusive?" check: a source's own content comes out
// wherever it lives, and anything not stamped with this exact source's id (a
// co-located source, direct org memory, an upload) is structurally untouched.

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/access")>();
  const check = vi.fn();
  // The real record helper, deciding with the stub above.
  return { ...actual, check, authorizeRecord: actual.recordAuthorizer({ check, can: actual.can }) };
});
// Mocked at the concrete store module, not the `@/services/memory` barrel:
// the route reaches `removeGroupFacts` through
// `services/memory/source-retirement`, which imports the store directly, so
// this is the one seam both of them share. The retirement helper itself
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
import { matchWhere } from "@/lib/db-where.testsupport";
import { check } from "@/services/access";
import { graphitiStore } from "@/services/memory/store";
import { DELETE } from "./route";

// One scope, several legitimate producers — the shape a user gets by
// connecting a second source into a scope they already use, or by uploading
// a document into a connector-synced scope.
const SHARED_SCOPE = "org_1.engineering";
const OTHER_SCOPE = "org_1.sales";

type ChunkRow = {
  orgId: string;
  scopePath: string;
  actorType: "human" | "extraction";
  sourceId: string | null;
  producedBy: string;
};
type FactRow = { orgId: string; scopePath: string; sourceId: string | null; producedBy: string };

let chunks: ChunkRow[];
let facts: FactRow[];

const rc = {
  org: { id: "org_1" },
  user: { id: "user_42" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "member" } },
};

const SLACK_SOURCE = {
  id: "src_slack",
  orgId: "org_1",
  type: "slack",
  scopePath: SHARED_SCOPE,
  status: "active",
};

function callDelete(id: string) {
  return DELETE(new Request(`http://test/api/sources/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();

  chunks = [
    {
      orgId: "org_1",
      scopePath: SHARED_SCOPE,
      actorType: "extraction",
      sourceId: "src_slack",
      producedBy: "src_slack",
    },
    {
      orgId: "org_1",
      scopePath: SHARED_SCOPE,
      actorType: "extraction",
      sourceId: "src_figma",
      producedBy: "src_figma",
    },
    { orgId: "org_1", scopePath: SHARED_SCOPE, actorType: "human", sourceId: null, producedBy: "human-chat" },
    { orgId: "org_1", scopePath: SHARED_SCOPE, actorType: "extraction", sourceId: null, producedBy: "human-upload" },
    {
      orgId: "org_1",
      scopePath: OTHER_SCOPE,
      actorType: "extraction",
      sourceId: "src_other_scope",
      producedBy: "src_other_scope",
    },
    // Another tenant's chunk, deliberately colliding on BOTH the scope path
    // and the source id so that `orgId` is the only predicate left that can
    // exclude it. Production does not mint this row — a scope path carries its
    // own org's root segment and a Source id is a primary key — and that is
    // precisely why the purge's `orgId` leg is otherwise unexercised here:
    // every other fixture is already excluded by scopePath or sourceId. This
    // pins the one predicate that stays correct if either of those properties
    // ever stops holding (a mis-stamped chunk, a non-unique marker); it is not
    // a reachable cross-tenant leak today.
    {
      orgId: "org_2",
      scopePath: SHARED_SCOPE,
      actorType: "extraction",
      sourceId: "src_slack",
      producedBy: "other-tenant",
    },
  ];
  // No cross-tenant fact fixture: the graph side has no orgId argument at all
  // (`removeGroupFacts` takes groupId + sourceId), because a group id IS a
  // scope path and a scope path is rooted at its own org. The tenant boundary
  // there is the group id, and the "leaves a different scope alone" case below
  // is what exercises it.
  facts = [
    { orgId: "org_1", scopePath: SHARED_SCOPE, sourceId: "src_slack", producedBy: "src_slack" },
    { orgId: "org_1", scopePath: SHARED_SCOPE, sourceId: "src_figma", producedBy: "src_figma" },
  ];

  vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
  vi.mocked(check).mockResolvedValue({ allowed: true } as never);
  vi.mocked(db.source.findFirst).mockResolvedValue(SLACK_SOURCE as never);

  // Real filter semantics, in memory: whatever the route's where-clause
  // actually says, and nothing it does not say. Dropping a predicate therefore
  // BROADENS the delete, which is what lets the "does NOT destroy ..." cases
  // below fail when the guard that protects them goes missing — see
  // lib/db-where.testsupport.ts for the fail-closed accident that reading
  // `args.where.sourceId` directly would reintroduce.
  vi.mocked(db.memoryChunk.deleteMany).mockImplementation((async (args: { where: Record<string, unknown> }) => {
    const doomed = new Set(matchWhere(chunks, args.where, ["orgId", "scopePath", "sourceId"]));
    const before = chunks.length;
    chunks = chunks.filter((c) => !doomed.has(c));
    return { count: before - chunks.length };
  }) as never);

  // The graph side's real semantics, not a fail-closed approximation:
  // `removeGroupFacts` omitting `sourceId` sends DELETE /groups/:id with no
  // `source_id` param, which purges the WHOLE group (services/memory/
  // graphiti-store.ts and its own tests). So losing the discriminator has to
  // destroy the co-located source's facts here too, or the case that asserts
  // they survive is asserting the fake rather than the marker.
  vi.mocked(graphitiStore.removeGroupFacts).mockImplementation((async (args: {
    groupId: string;
    sourceId?: string;
  }) => {
    const before = facts.length;
    facts = facts.filter(
      (f) => !(f.scopePath === args.groupId && (args.sourceId === undefined || f.sourceId === args.sourceId)),
    );
    return { removedCount: before - facts.length };
  }) as never);

  vi.mocked(db.sourceFile.deleteMany).mockResolvedValue({ count: 0 } as never);
  // No row records a different scope, so the source's own scopePath is the only
  // one retirement has to cover — the single-scope case every test here asserts.
  vi.mocked(db.sourceFile.findMany).mockResolvedValue([] as never);
  vi.mocked(db.source.update).mockResolvedValue(SLACK_SOURCE as never);
  vi.mocked(db.$transaction).mockImplementation(((fn: (tx: unknown) => unknown) =>
    fn({ source: db.source, sourceFile: db.sourceFile })) as never);
});

describe("DELETE /api/sources/:id — shared scope, marker-scoped retirement", () => {
  it("retires this source's own pgvector chunks", async () => {
    await callDelete("src_slack");

    expect(chunks.some((c) => c.producedBy === "src_slack")).toBe(false);
  });

  it("retires this source's own graph facts", async () => {
    await callDelete("src_slack");

    expect(facts.some((f) => f.producedBy === "src_slack")).toBe(false);
  });

  it("does NOT destroy a co-located source's pgvector chunks or graph facts", async () => {
    await callDelete("src_slack");

    expect(chunks.some((c) => c.producedBy === "src_figma")).toBe(true);
    expect(facts.some((f) => f.producedBy === "src_figma")).toBe(true);
  });

  it("does NOT destroy the org's own directly-ingested (chat/manual) memory", async () => {
    await callDelete("src_slack");

    expect(chunks.some((c) => c.producedBy === "human-chat")).toBe(true);
  });

  it("does NOT destroy a document upload's chunk, which no exclusivity check could detect", async () => {
    // A check for another Source row or a human-authored chunk could never
    // see this case at all: an upload writes actorType "extraction",
    // identical to connector-sync content, and there is no co-located
    // Source row for an upload. The marker covers it anyway, because the
    // purge never asks "is anything else here"; it only ever removes rows
    // stamped with src_slack's own id, and an upload is never stamped.
    await callDelete("src_slack");

    expect(chunks.some((c) => c.producedBy === "human-upload")).toBe(true);
  });

  it("carries the sourceId discriminator on both purge calls — never a bare scope purge", async () => {
    await callDelete("src_slack");

    expect(db.memoryChunk.deleteMany).toHaveBeenCalledWith({
      where: { orgId: "org_1", scopePath: SHARED_SCOPE, sourceId: "src_slack" },
    });
    expect(graphitiStore.removeGroupFacts).toHaveBeenCalledWith({
      groupId: SHARED_SCOPE,
      sourceId: "src_slack",
    });
  });

  it("reports only this source's own retired counts, not the shared scope's whole population", async () => {
    const res = await callDelete("src_slack");
    const body = await res.json();

    // Exactly 1 chunk and 1 fact are actually src_slack's; everything else
    // at the scope (co-located source, human chat, upload) is untouched.
    expect(body).toEqual({ disconnected: "src_slack", retiredFacts: 1, retiredChunks: 1 });
  });

  it("still disconnects the source and drops its own sync history", async () => {
    await callDelete("src_slack");

    expect(db.sourceFile.deleteMany).toHaveBeenCalledWith({ where: { sourceId: "src_slack" } });
    expect(db.source.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "src_slack" },
        data: { status: "disconnected", encryptedTokens: null },
      }),
    );
  });

  it("does NOT purge another tenant's chunk that shares this source's id and scope", async () => {
    await callDelete("src_slack");

    expect(chunks.some((c) => c.producedBy === "other-tenant")).toBe(true);
  });

  it("leaves a different scope alone", async () => {
    await callDelete("src_slack");

    expect(chunks.some((c) => c.producedBy === "src_other_scope")).toBe(true);
  });
});
