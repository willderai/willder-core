// Mocked end to end: needs no database; runs in every environment.

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A connector reconnect that changes a source's scope must not strand the
 * content it already ingested.
 *
 * `POST /api/sources` with an explicit, valid scope rewrites `Source.scopePath`
 * while already-ingested episodes stay in the Graphiti group they were written
 * to. `removeEpisode` maps a 404 onto `{ removed: false }`, so a retirement
 * that addresses the source's current scope after such a reconnect aims at a
 * group the episode was never in and reads as a safe no-op: upstream-deleted
 * content stays retrievable, and an edit leaves two contradicting episodes.
 *
 * The rule: `SourceFile` records `episodeScopePath`, the group each episode
 * was actually written under, and the retirement path addresses that group and
 * fails when the store reports nothing was removed.
 *
 * Two properties of this harness, both of which make these assertions stricter
 * rather than weaker:
 *
 *  1. The `memory.ingest` fake derives its group the way the real store does
 *     (`scopePath ?? groupId`, see `GraphitiMemoryStore.ingest`) instead of
 *     reading `groupId` alone. `buildConnectorIngestInput` passes the bare org
 *     id as `groupId` and the source's scope as `scopePath`, so a connector
 *     episode lands in the scope's group, not the org group.
 *  2. A stored row carries `episodeScopePath`, because that is the field the
 *     retirement path reads. The no-recorded-scope case is its own test below:
 *     a legacy row written before that column existed still cannot be retired
 *     safely, and the acceptance criterion there is that the code says so
 *     instead of reporting a retirement that did not happen and dropping the
 *     last pointer to live content.
 */

vi.mock("@/lib/db", () => ({
  db: {
    // Each SourceFile write commits in one transaction with its change event
    // (services/memory/content-change-event.ts); the callback runs against this mock.
    $transaction(fn: (tx: unknown) => unknown) {
      return fn(this);
    },
    sourceFile: { upsert: vi.fn(), delete: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn() },
  },
}));
// No person has been erased in these orgs (erasure-suppression.realdb.test.ts covers one).
vi.mock("@/services/memory/erasure-suppression", () => ({ loadErasedPersonMatcher: async () => () => false }));
vi.mock("@/services/memory/content-change-event", () => ({
  recordSourceItemChange: vi.fn(),
  recordDocumentIngested: vi.fn(),
}));
vi.mock("@/services/memory", () => ({
  graphitiStore: { removeEpisode: vi.fn() },
  memory: { ingest: vi.fn() },
}));
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: vi.fn().mockResolvedValue(undefined),
  recordEpisode: vi.fn().mockResolvedValue(undefined),
}));

import { retireVanishedTextItem, syncOneTextItem } from "./inngest";
import { graphitiStore, memory } from "@/services/memory";

/** The scope the source was originally connected and synced under. */
const OLD_SCOPE = "org_1.slack-eng-a1b2";
/** The scope an explicit-`scopePath` reconnect moved the source to. */
const NEW_SCOPE = "org_1.restricted";

/** The source as it looks AFTER the reconnect moved it to the narrower scope. */
const movedSource = {
  id: "src_1",
  orgId: "org_1",
  type: "slack",
  name: "eng",
  scopePath: NEW_SCOPE,
  connectAuthorizationId: null,
};

/**
 * Graphiti partitions by `group_id`: an episode is only addressable under the
 * group it was written to, and a delete aimed at any other group 404s. This fake
 * reproduces exactly that, so the assertions below turn on the real storage
 * boundary rather than on a call-argument spy.
 */
function graphWithEpisodeIn(groupId: string, episodeId: string) {
  const live = new Set([`${groupId}::${episodeId}`]);
  vi.mocked(graphitiStore.removeEpisode).mockImplementation(async (input: { groupId: string; episodeId: string }) => {
    const key = `${input.groupId}::${input.episodeId}`;
    if (!live.has(key)) return { removed: false }; // 404 -> safe no-op
    live.delete(key);
    return { removed: true };
  });
  return { isRetrievable: () => live.size > 0, live };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("connector reconnect that changes scope does not strand already-ingested content", () => {
  it("retiring an upstream-deleted item makes it stop being retrievable", async () => {
    const graph = graphWithEpisodeIn(OLD_SCOPE, "ep_old");

    // The item vanished upstream. sourceSync passes the source's CURRENT
    // scopePath, which the reconnect changed to NEW_SCOPE — but the row records
    // the scope its episode was written under, and that is what gets addressed.
    const outcome = await retireVanishedTextItem(
      { id: "src_1", orgId: "org_1", type: "slack", scopePath: NEW_SCOPE, connectAuthorizationId: null },
      {
        externalFileId: "msg_1",
        checksum: "c1",
        episodeId: "ep_old",
        episodeScopePath: OLD_SCOPE,
      },
    );

    // The acceptance criterion: deleted content stops being retrievable.
    expect(graph.isRetrievable()).toBe(false);
    expect(outcome).toBe("retired");
    expect(graphitiStore.removeEpisode).toHaveBeenCalledWith({
      groupId: OLD_SCOPE,
      episodeId: "ep_old",
    });
  });

  it("an edited item leaves exactly one episode, not a contradicting pair", async () => {
    const graph = graphWithEpisodeIn(OLD_SCOPE, "ep_old");
    // A successful ingest of the edited body, written under the source's current
    // scope. The real store derives an episode's group from `scopePath` and falls
    // back to `groupId` only when there is no scope, so the fake does the same.
    vi.mocked(memory.ingest).mockImplementation(async (data: { groupId: string; scopePath?: string }) => {
      graph.live.add(`${data.scopePath ?? data.groupId}::ep_new`);
      return { episodeId: "ep_new" } as never;
    });

    await syncOneTextItem(
      movedSource,
      { id: "msg_1", checksum: "c2_new", text: "edited body" },
      { episodeId: "ep_old", scopePath: OLD_SCOPE },
    );

    // Exactly one episode may remain: the freshly ingested one. The stale
    // episode surviving alongside it would mean the old and the edited text are
    // both retrievable and contradict each other.
    expect([...graph.live]).toEqual([`${NEW_SCOPE}::ep_new`]);
  });

  it("control: the same retirement succeeds when the scope did not change", async () => {
    const graph = graphWithEpisodeIn(OLD_SCOPE, "ep_old");

    const outcome = await retireVanishedTextItem(
      { id: "src_1", orgId: "org_1", type: "slack", scopePath: OLD_SCOPE, connectAuthorizationId: null },
      {
        externalFileId: "msg_1",
        checksum: "c1",
        episodeId: "ep_old",
        episodeScopePath: OLD_SCOPE,
      },
    );

    expect(graph.isRetrievable()).toBe(false);
    expect(outcome).toBe("retired");
  });
});

/**
 * A row written before `SourceFile.episodeScopePath` existed has no record of
 * where its episode went, so the retirement path can only try the source's
 * current scope. For this row the content genuinely cannot be reached, and the
 * requirement is
 * that the code reports that instead of claiming a retirement and deleting the
 * only remaining pointer to live content.
 *
 * Purging these rows is `DELETE /api/sources/:id`'s job — it retires this
 * source's content across every scope it has on record plus the current one
 * (`services/memory/source-retirement.ts`), which needs no per-row scope.
 */
describe("a legacy row with no recorded scope fails loudly instead of silently", () => {
  it("does not report a retirement that did not happen", async () => {
    const graph = graphWithEpisodeIn(OLD_SCOPE, "ep_old");

    const outcome = await retireVanishedTextItem(
      { id: "src_1", orgId: "org_1", type: "slack", scopePath: NEW_SCOPE, connectAuthorizationId: null },
      {
        externalFileId: "msg_1",
        checksum: "c1",
        episodeId: "ep_old",
        episodeScopePath: null,
      },
    );

    expect(outcome).not.toBe("retired");
    // Still live, and honestly reported as not retired — the next sync sees the
    // same row and tries again.
    expect(graph.isRetrievable()).toBe(true);
  });

  it("does not delete the SourceFile row when the episode was not actually removed", async () => {
    graphWithEpisodeIn(OLD_SCOPE, "ep_old");
    const { db } = await import("@/lib/db");

    await retireVanishedTextItem(
      { id: "src_1", orgId: "org_1", type: "slack", scopePath: NEW_SCOPE, connectAuthorizationId: null },
      {
        externalFileId: "msg_1",
        checksum: "c1",
        episodeId: "ep_old",
        episodeScopePath: null,
      },
    );

    // The row is the only remaining pointer to that episode. Dropping it while
    // the episode is still live orphans retrievable content permanently: the
    // next sync's plan can no longer list the item as needing retirement.
    expect(vi.mocked(db.sourceFile.delete)).not.toHaveBeenCalled();
  });
});

/**
 * The retirement spans two stores, so it cannot be atomic. Clearing the row's
 * episode pointer between the two writes is what keeps an interrupted
 * retirement recoverable rather than permanently stuck reporting `failed`.
 */
describe("a retirement interrupted after the graph delete completes", () => {
  it("finishes on the next sync instead of failing forever", async () => {
    const graph = graphWithEpisodeIn(OLD_SCOPE, "ep_old");
    const { db } = await import("@/lib/db");

    // First attempt: the episode goes, the row's pointer is cleared, then the
    // row delete dies (a DB blip, a lost step).
    vi.mocked(db.sourceFile.delete).mockRejectedValueOnce(new Error("connection reset"));
    const first = await retireVanishedTextItem(
      { id: "src_1", orgId: "org_1", type: "slack", scopePath: NEW_SCOPE, connectAuthorizationId: null },
      {
        externalFileId: "msg_1",
        checksum: "c1",
        episodeId: "ep_old",
        episodeScopePath: OLD_SCOPE,
      },
    );
    expect(first).toBe("failed");
    expect(graph.isRetrievable()).toBe(false);
    expect(vi.mocked(db.sourceFile.update)).toHaveBeenCalledWith({
      where: { sourceId_externalFileId: { sourceId: "src_1", externalFileId: "msg_1" } },
      data: { episodeId: null, episodeScopePath: null, episodeRetireStartedAt: null },
    });

    // Next sync: the row the plan now reads has nothing left to retire, so it is
    // dropped without re-addressing an episode that is already gone. Without the
    // cleared pointer this row would retry removeEpisode forever, get
    // `removed: false` because the episode really is gone, and never delete.
    vi.mocked(graphitiStore.removeEpisode).mockClear();
    const second = await retireVanishedTextItem(
      { id: "src_1", orgId: "org_1", type: "slack", scopePath: NEW_SCOPE, connectAuthorizationId: null },
      {
        externalFileId: "msg_1",
        checksum: "c1",
        episodeId: null,
        episodeScopePath: null,
      },
    );
    expect(second).toBe("retired");
    expect(graphitiStore.removeEpisode).not.toHaveBeenCalled();
    expect(vi.mocked(db.sourceFile.delete)).toHaveBeenCalled();
  });
});

describe("an edit interrupted after the graph delete completes", () => {
  it("re-ingests on the next sync instead of failing on an episode already gone", async () => {
    const graph = graphWithEpisodeIn(OLD_SCOPE, "ep_old");
    const { db } = await import("@/lib/db");
    vi.mocked(memory.ingest).mockImplementation(async (data: { groupId: string; scopePath?: string }) => {
      graph.live.add(`${data.scopePath ?? data.groupId}::ep_new`);
      return { episodeId: "ep_new" } as never;
    });

    // First attempt: the stale episode goes, the row's pointer is cleared, then
    // the ingest dies.
    vi.mocked(memory.ingest).mockRejectedValueOnce(new Error("llm timeout"));
    const first = await syncOneTextItem(
      movedSource,
      { id: "msg_1", checksum: "c2_new", text: "edited body" },
      { episodeId: "ep_old", scopePath: OLD_SCOPE },
    );
    expect(first).toBe("failed");
    expect(vi.mocked(db.sourceFile.update)).toHaveBeenCalledWith({
      where: { sourceId_externalFileId: { sourceId: "src_1", externalFileId: "msg_1" } },
      data: { episodeId: null, episodeScopePath: null, episodeRetireStartedAt: null },
    });

    // Next sync: the checksum was never advanced, so the item is still an edit —
    // but its row no longer points at the deleted episode, so there is nothing to
    // retire and the re-ingest simply succeeds. Without the cleared pointer this
    // item would re-address `ep_old`, get `removed: false` because it really is
    // gone, and report `failed` on every sync from here on.
    vi.mocked(graphitiStore.removeEpisode).mockClear();
    const second = await syncOneTextItem(movedSource, { id: "msg_1", checksum: "c2_new", text: "edited body" }, null);
    expect(second).toBe("synced");
    expect(graphitiStore.removeEpisode).not.toHaveBeenCalled();
    expect([...graph.live]).toEqual([`${NEW_SCOPE}::ep_new`]);
  });
});

/**
 * Guard-removal differentials for the two predicates the retirement path
 * relies on, in the form the rest of this repo uses (see `lib/inngest.test.ts`'s
 * `loadScopedSource` block):
 *
 *  - Reverting `retireEpisode`'s addressing to the source's current scope
 *    (`const groupId = currentScopePath`) turns 5 of these 9 tests red: both
 *    scenario tests in the first block, both interruption-recovery tests, and the
 *    recorded-group assertion below.
 *  - Dropping its `if (removed) return; throw ...` check turns 3 red: both tests
 *    in "a legacy row with no recorded scope fails loudly" and the
 *    `removed: false` assertion below.
 *
 * The two assertions below pin the same pair directly, so a regression in either
 * is a failure here and not only in a scenario test.
 */
describe("guard-removal differential: the retirement addresses the recorded group and checks the result", () => {
  it("never addresses an episode under a scope the row did not record", async () => {
    graphWithEpisodeIn(OLD_SCOPE, "ep_old");

    await retireVanishedTextItem(
      { id: "src_1", orgId: "org_1", type: "slack", scopePath: NEW_SCOPE, connectAuthorizationId: null },
      {
        externalFileId: "msg_1",
        checksum: "c1",
        episodeId: "ep_old",
        episodeScopePath: OLD_SCOPE,
      },
    );

    const groups = vi.mocked(graphitiStore.removeEpisode).mock.calls.map((c) => c[0].groupId);
    expect(groups).toEqual([OLD_SCOPE]);
    expect(groups).not.toContain(NEW_SCOPE);
  });

  it("a `removed: false` result is an error, never a silent success", async () => {
    // Nothing anywhere for this episode id: every delete comes back
    // `{ removed: false }`, which is precisely the 404 the old code swallowed.
    vi.mocked(graphitiStore.removeEpisode).mockResolvedValue({ removed: false });
    const { db } = await import("@/lib/db");

    const outcome = await retireVanishedTextItem(
      { id: "src_1", orgId: "org_1", type: "slack", scopePath: OLD_SCOPE, connectAuthorizationId: null },
      {
        externalFileId: "msg_1",
        checksum: "c1",
        episodeId: "ep_old",
        episodeScopePath: OLD_SCOPE,
      },
    );

    expect(outcome).toBe("failed");
    expect(vi.mocked(db.sourceFile.delete)).not.toHaveBeenCalled();
    expect(vi.mocked(db.sourceFile.update)).not.toHaveBeenCalled();
  });
});
