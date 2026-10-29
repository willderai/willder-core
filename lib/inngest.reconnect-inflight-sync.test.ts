import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression coverage for a
 * reconnect that moves `Source.scopePath` while a `sourceSync` job is already
 * in flight.
 *
 * `sourceSync` reads the `Source` row once, in its `load-source` step, and
 * carries that row for the whole job. `POST /api/sources` retires the old
 * scope's content, deletes the `SourceFile` rows and rewrites the pointer —
 * so before this fix every write the running job made after that landed back
 * under the scope that was just purged, and stamped fresh
 * `SourceFile.episodeScopePath` rows with it. The next sync saw matching
 * checksums, took `planConnectorSync`'s skip path, and the content stayed in
 * the old scope until someone disconnected the source: narrowing a connector's
 * scope did not restrict its content, which is the outcome item
 * connector-reconnect-scope-strand-fix-20260922 exists to prevent.
 *
 * The seam under test is the boundary between a captured `source` row and the
 * writes made from it — `runWhileSourceCurrent` re-reads the stored pointer
 * immediately before each write and reports `"superseded"` instead of writing
 * once it has moved. These tests move the pointer from inside the mock that a
 * write is awaiting, which is the real interleaving, not a pointer flipped
 * between two tidy steps.
 *
 * Expected values come from the reconnect route's own contract (it purges the
 * old scope and sets `status: "active"` itself before firing a fresh sync),
 * not from re-running the code under test.
 */

vi.mock("@/lib/db", () => ({
  db: {
    // Each SourceFile write commits in one transaction with its change event
    // (services/memory/content-change-event.ts); the callback runs against this mock.
    $transaction(fn: (tx: unknown) => unknown) {
      return fn(this);
    },
    source: { findFirst: vi.fn(), findFirstOrThrow: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    sourceFile: {
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
    },
  },
}));
// No person has been erased in these orgs (erasure-suppression.realdb.test.ts covers one), and
// no restore is waiting on a re-apply (restore-completion.realdb.test.ts covers one).
vi.mock("@/services/memory/erasure-suppression", () => ({
  loadErasedPersonMatcher: async () => () => false,
  reapplyDue: async () => false,
}));
vi.mock("@/services/memory/content-change-event", () => ({
  recordSourceItemChange: vi.fn(),
  recordDocumentIngested: vi.fn(),
}));
vi.mock("@/services/memory", () => ({
  memory: { ingest: vi.fn(), graph: vi.fn() },
  graphitiStore: {
    removeEpisode: vi.fn(),
    extractFile: vi.fn(),
    ingestBulk: vi.fn(),
    dedupeNodes: vi.fn(),
  },
  pgvectorStore: { ingest: vi.fn(), ingestAll: vi.fn() },
}));
// The purge itself has its own coverage (app/api/sources/[id]/route.test.ts and
// lib/inngest.disconnect-mid-sync.realdb.test.ts); here it only has to be called.
vi.mock("@/services/memory/source-retirement", () => ({
  retireSourceContent: vi.fn(),
  retireSourceContentAtScope: vi.fn(),
  retireLateSourceWrite: vi.fn(),
}));
vi.mock("@/services/enrichment", () => ({ enrich: vi.fn() }));
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: vi.fn().mockResolvedValue(undefined),
  recordEpisode: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/connectors/slack", () => ({ listChannelMessages: vi.fn(), parseSlackCursor: () => null }));
vi.mock("@/services/connectors/gdrive", () => ({
  listFolderFiles: vi.fn(),
  downloadFile: vi.fn(),
}));
vi.mock("@/services/connectors/posthog", () => ({
  fetchInsightSnapshot: vi.fn(),
  POSTHOG_DEFAULT_HOST: "https://us.posthog.com",
}));
vi.mock("@/lib/crypto", () => ({ unsealSecret: vi.fn(() => ({ token: "tok" })) }));
vi.mock("@vercel/blob", () => ({ put: vi.fn(), del: vi.fn() }));

import { sourceSync, fileIngest, sourceScopeIsCurrent, sourceWriteState, runWhileSourceCurrent } from "./inngest";
import { retireLateSourceWrite, retireSourceContent } from "@/services/memory/source-retirement";
import { recordDocumentIngested } from "@/services/memory/content-change-event";
import { db } from "@/lib/db";
import { memory, graphitiStore, pgvectorStore } from "@/services/memory";
import { listChannelMessages } from "@/services/connectors/slack";
import { listFolderFiles, downloadFile } from "@/services/connectors/gdrive";
import { put } from "@vercel/blob";

type StepCtx = {
  event: { data: unknown };
  step: { run: (id: string, cb: () => unknown) => Promise<unknown> };
};
/** The handler `inngest.createFunction` wraps (inngest 4.5.0 keeps it on `fn`). */
/* eslint-disable @typescript-eslint/no-explicit-any */
const syncHandler = (sourceSync as any).fn as (ctx: StepCtx) => Promise<any>;
const ingestHandler = (fileIngest as any).fn as (ctx: StepCtx) => Promise<any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** A plain step runner: no replay, every closure runs once. */
function step() {
  const invoked: string[] = [];
  return {
    invoked,
    run: async (id: string, cb: () => unknown) => {
      invoked.push(id);
      return cb();
    },
  };
}

const OLD_SCOPE = "org_1.everyone";
const NEW_SCOPE = "org_1.everyone.legal";

const SLACK_SOURCE = {
  id: "src_slack",
  orgId: "org_1",
  type: "slack",
  name: "#general",
  externalId: "C123",
  scopePath: OLD_SCOPE,
};
const DRIVE_SOURCE = {
  id: "src_drive",
  orgId: "org_1",
  type: "gdrive",
  name: "Docs",
  externalId: "F123",
  scopePath: OLD_SCOPE,
};

const EVENT = (sourceId: string) => ({ data: { sourceId, orgId: "org_1", sealedToken: "sealed-tok" } });

/**
 * The scope the `Source` row currently records, as the route would have left
 * it. `null` stands for a row the reconnect (or a disconnect) removed.
 */
let storedScopePath: string | null = OLD_SCOPE;
/** The status the `Source` row currently records. A disconnect keeps the row. */
let storedStatus = "syncing";

/**
 * Terminal status writes that landed. Both terminal steps write through
 * `updateMany`, conditional on the row not being disconnected, and the mock
 * applies that condition to `storedStatus` the way Postgres would.
 */
function terminalStatusWrites() {
  const { calls, results } = vi.mocked(db.source.updateMany).mock;
  // `load-source` marking the source "syncing" is not a terminal write.
  return results.filter(
    (r, i) =>
      (r.value as { count: number }).count > 0 &&
      (calls[i][0] as { data: { status?: string } }).data.status !== "syncing",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  storedScopePath = OLD_SCOPE;
  storedStatus = "syncing";
  vi.mocked(db.source.update).mockResolvedValue({} as never);
  vi.mocked(db.source.updateMany).mockImplementation(((args: { where: { status?: { not: string } } }) => ({
    count: storedScopePath !== null && storedStatus !== args.where.status?.not ? 1 : 0,
  })) as never);
  vi.mocked(db.sourceFile.deleteMany).mockResolvedValue({ count: 0 } as never);
  vi.mocked(retireSourceContent).mockResolvedValue({
    retiredFacts: 0,
    retiredChunks: 0,
    redactedChangeEvents: 0,
    retiredBriefs: 0,
    scopePaths: [],
  });
  vi.mocked(db.sourceFile.upsert).mockResolvedValue({} as never);
  vi.mocked(db.sourceFile.update).mockResolvedValue({} as never);
  vi.mocked(db.sourceFile.delete).mockResolvedValue({} as never);
  vi.mocked(db.sourceFile.findUnique).mockResolvedValue(null as never);
  vi.mocked(graphitiStore.removeEpisode).mockResolvedValue({ removed: true } as never);
  // The stored pointer, read back the way `sourceScopeIsCurrent` reads it — and
  // filtered the way Prisma actually filters, on the keys the `where` clause
  // carries and no others. A query that omits `orgId` therefore matches the row
  // whatever org it belongs to, which is what lets the cross-tenant case below
  // fail for the reason it names: refusing an absent `orgId` here instead would
  // make a guard that dropped the org miss every row, so that test would keep
  // passing on a fail-closed accident rather than on the boundary it claims.
  vi.mocked(db.source.findFirst).mockImplementation((async (args: unknown) => {
    const { id, orgId } = (args as { where: { id: string; orgId?: string } }).where;
    if (orgId !== undefined && orgId !== "org_1") return null;
    if (id !== SLACK_SOURCE.id && id !== DRIVE_SOURCE.id) return null;
    return storedScopePath === null ? null : { scopePath: storedScopePath, status: storedStatus };
  }) as never);
});

// ---------------------------------------------------------------------------
// The guard itself.
// ---------------------------------------------------------------------------
describe("sourceScopeIsCurrent — the stored pointer, re-read at write time", () => {
  it("is current while the row still records the captured scope", async () => {
    await expect(sourceScopeIsCurrent(SLACK_SOURCE)).resolves.toBe(true);
  });

  it("is not current once the row records a different scope", async () => {
    storedScopePath = NEW_SCOPE;
    await expect(sourceScopeIsCurrent(SLACK_SOURCE)).resolves.toBe(false);
  });

  it("is not current when the row is gone", async () => {
    storedScopePath = null;
    await expect(sourceScopeIsCurrent(SLACK_SOURCE)).resolves.toBe(false);
    await expect(sourceWriteState(SLACK_SOURCE)).resolves.toBe("disconnected");
  });

  // DELETE /api/sources/:id keeps
  // the row and sets its status, leaving the pointer where it was; a guard that
  // compared pointers alone let the whole first sync keep writing.
  it("is not current once the row is marked disconnected, though its scope is unchanged", async () => {
    storedStatus = "disconnected";
    await expect(sourceScopeIsCurrent(SLACK_SOURCE)).resolves.toBe(false);
    await expect(sourceWriteState(SLACK_SOURCE)).resolves.toBe("disconnected");
  });

  it("tells a moved source apart from a disconnected one", async () => {
    storedScopePath = NEW_SCOPE;
    await expect(sourceWriteState(SLACK_SOURCE)).resolves.toBe("moved");
  });

  it("scopes the re-read to the org, so another tenant's source id never verifies", async () => {
    await expect(sourceScopeIsCurrent({ ...SLACK_SOURCE, orgId: "org_2" })).resolves.toBe(false);
  });

  it("runs the write only while the scope holds, and reports superseded otherwise", async () => {
    const write = vi.fn().mockResolvedValue("synced" as const);
    await expect(runWhileSourceCurrent(SLACK_SOURCE, write)).resolves.toBe("synced");
    expect(write).toHaveBeenCalledTimes(1);

    storedScopePath = NEW_SCOPE;
    await expect(runWhileSourceCurrent(SLACK_SOURCE, write)).resolves.toBe("superseded");
    expect(write).toHaveBeenCalledTimes(1); // not called again

    storedScopePath = OLD_SCOPE;
    storedStatus = "disconnected";
    await expect(runWhileSourceCurrent(SLACK_SOURCE, write)).resolves.toBe("disconnected");
    expect(write).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The text branch (Slack / Figma / PostHog).
// ---------------------------------------------------------------------------
describe("sourceSync text branch — a reconnect that moves scope mid-run", () => {
  beforeEach(() => {
    vi.mocked(db.source.findFirstOrThrow).mockResolvedValue(SLACK_SOURCE as never);
    vi.mocked(db.sourceFile.findMany).mockResolvedValue([] as never);
    vi.mocked(listChannelMessages).mockResolvedValue({
      items: [
        { id: "m1", text: "one", checksum: "c1" },
        { id: "m2", text: "two", checksum: "c2" },
        { id: "m3", text: "three", checksum: "c3" },
      ],
      gone: [],
      cursor: {},
    } as never);
  });

  it("stops writing as soon as the pointer moves, instead of stranding the rest in the old scope", async () => {
    // The reconnect lands while m1's ingest is in flight: it purges the old
    // scope and repoints the source, exactly as POST /api/sources does.
    vi.mocked(memory.ingest).mockImplementation((async () => {
      storedScopePath = NEW_SCOPE;
      return { episodeId: "ep1" };
    }) as never);

    const result = await syncHandler({ event: EVENT("src_slack"), step: step() });

    expect(memory.ingest).toHaveBeenCalledTimes(1); // m2 and m3 never written
    expect(result.superseded).toBe(true);
    expect(result.synced).toBe(1);
  });

  it("never stamps a SourceFile row with a scope the source has already left", async () => {
    vi.mocked(memory.ingest).mockImplementation((async () => {
      storedScopePath = NEW_SCOPE;
      return { episodeId: "ep1" };
    }) as never);

    await syncHandler({ event: EVENT("src_slack"), step: step() });

    // m1's own row is written under the scope that was still current when it
    // was checked; nothing is written for m2/m3 at all. Before the fix all
    // three were stamped OLD_SCOPE after the source had moved to NEW_SCOPE,
    // and the next sync's checksum match then skipped them forever.
    const stamped = vi
      .mocked(db.sourceFile.upsert)
      .mock.calls.map((c) => (c[0] as { create: { externalFileId: string } }).create.externalFileId);
    expect(stamped).toEqual(["m1"]);
  });

  it("leaves the terminal status and meta to the reconnect, which already set them", async () => {
    vi.mocked(memory.ingest).mockImplementation((async () => {
      storedScopePath = NEW_SCOPE;
      return { episodeId: "ep1" };
    }) as never);

    await syncHandler({ event: EVENT("src_slack"), step: step() });

    // The route's upsert already wrote status: "active" for the new scope.
    // A superseded run writing its own partial counts over that would describe
    // a pass across a scope the source no longer uses.
    expect(terminalStatusWrites()).toHaveLength(0);
  });

  it("stops the vanished-item retirement loop too", async () => {
    vi.mocked(listChannelMessages).mockResolvedValue({ items: [], gone: ["gone1", "gone2"], cursor: {} } as never);
    vi.mocked(db.sourceFile.findMany).mockResolvedValue([
      { externalFileId: "gone1", checksum: "c1", episodeId: "ep1", episodeScopePath: OLD_SCOPE },
      { externalFileId: "gone2", checksum: "c2", episodeId: "ep2", episodeScopePath: OLD_SCOPE },
    ] as never);
    // The move lands while the first retirement is in flight.
    vi.mocked(graphitiStore.removeEpisode).mockImplementation((async () => {
      storedScopePath = NEW_SCOPE;
      return { removed: true };
    }) as never);

    const result = await syncHandler({ event: EVENT("src_slack"), step: step() });

    expect(graphitiStore.removeEpisode).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.sourceFile.delete)).toHaveBeenCalledTimes(1);
    expect(result.superseded).toBe(true);
  });

  it("stops when the source row is gone mid-run, and retires what it wrote", async () => {
    vi.mocked(memory.ingest).mockImplementation((async () => {
      storedScopePath = null;
      return { episodeId: "ep1" };
    }) as never);

    const result = await syncHandler({ event: EVENT("src_slack"), step: step() });

    expect(memory.ingest).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ superseded: false, disconnected: true });
    expect(retireSourceContent).toHaveBeenCalledWith(SLACK_SOURCE, null);
  });

  it("control: an untouched pointer still completes the whole run normally", async () => {
    vi.mocked(memory.ingest).mockResolvedValue({ episodeId: "ep" } as never);

    const result = await syncHandler({ event: EVENT("src_slack"), step: step() });

    expect(memory.ingest).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ files: 3, synced: 3, failed: 0, superseded: false });
    expect(terminalStatusWrites()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/sources/:id while
// the first sync is in flight. The route retires the source's content and
// marks the row disconnected; without the guard, the run keeps ingesting, its facts
// stayed retrievable, and its `complete` step marked the source active again.
// ---------------------------------------------------------------------------
describe("sourceSync text branch — a disconnect mid-run", () => {
  beforeEach(() => {
    vi.mocked(db.source.findFirstOrThrow).mockResolvedValue(SLACK_SOURCE as never);
    vi.mocked(db.sourceFile.findMany).mockResolvedValue([] as never);
    vi.mocked(listChannelMessages).mockResolvedValue({
      items: [
        { id: "m1", text: "one", checksum: "c1" },
        { id: "m2", text: "two", checksum: "c2" },
        { id: "m3", text: "three", checksum: "c3" },
      ],
      gone: [],
      cursor: {},
    } as never);
  });

  /** The disconnect lands while the given message's ingest is in flight. */
  function disconnectDuring(text: string) {
    vi.mocked(memory.ingest).mockImplementation((async (input: { content: string }) => {
      if (input.content.includes(text)) storedStatus = "disconnected";
      return { episodeId: `ep_${text}` };
    }) as never);
  }

  it("writes nothing after the disconnect, then retires what it wrote and drops its records", async () => {
    disconnectDuring("one");

    const result = await syncHandler({ event: EVENT("src_slack"), step: step() });

    expect(memory.ingest).toHaveBeenCalledTimes(1); // m2 and m3 never written
    expect(result).toMatchObject({ synced: 1, superseded: false, disconnected: true });
    expect(retireSourceContent).toHaveBeenCalledWith(SLACK_SOURCE, null);
    expect(db.sourceFile.deleteMany).toHaveBeenCalledWith({ where: { sourceId: SLACK_SOURCE.id } });
    // The row stays disconnected: no terminal status write landed.
    expect(terminalStatusWrites()).toHaveLength(0);
  });

  it("retires what it wrote when the disconnect lands during the last write, past every guard", async () => {
    disconnectDuring("three");

    const result = await syncHandler({ event: EVENT("src_slack"), step: step() });

    expect(memory.ingest).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ synced: 3, disconnected: true });
    expect(retireSourceContent).toHaveBeenCalledTimes(1);
    expect(terminalStatusWrites()).toHaveLength(0);
  });

  it("retires what it wrote instead of retrying when the run fails after a disconnect", async () => {
    // The disconnect lands while the listing is in flight, and the listing fails.
    vi.mocked(listChannelMessages).mockImplementation((async () => {
      storedStatus = "disconnected";
      throw new Error("connection reset");
    }) as never);

    const result = await syncHandler({ event: EVENT("src_slack"), step: step() });

    expect(result).toMatchObject({ disconnected: true });
    expect(retireSourceContent).toHaveBeenCalledWith(SLACK_SOURCE, null);
    expect(terminalStatusWrites()).toHaveLength(0);
  });

  it("does nothing for a job that starts after the disconnect, and leaves the row disconnected", async () => {
    vi.mocked(db.source.findFirstOrThrow).mockResolvedValue({ ...SLACK_SOURCE, status: "disconnected" } as never);

    const result = await syncHandler({ event: EVENT("src_slack"), step: step() });

    expect(result).toMatchObject({ files: 0, disconnected: true });
    expect(listChannelMessages).not.toHaveBeenCalled();
    expect(memory.ingest).not.toHaveBeenCalled();
    expect(db.source.update).not.toHaveBeenCalled(); // never marked "syncing"
  });

  it("control: a run with no disconnect retires nothing and writes its terminal status", async () => {
    vi.mocked(memory.ingest).mockResolvedValue({ episodeId: "ep" } as never);

    const result = await syncHandler({ event: EVENT("src_slack"), step: step() });

    expect(result).toMatchObject({ synced: 3, disconnected: false });
    expect(retireSourceContent).not.toHaveBeenCalled();
    expect(terminalStatusWrites()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The Drive branch.
// ---------------------------------------------------------------------------
describe("sourceSync drive branch — a reconnect that moves scope mid-run", () => {
  beforeEach(() => {
    vi.mocked(db.source.findFirstOrThrow).mockResolvedValue(DRIVE_SOURCE as never);
    vi.mocked(listFolderFiles).mockResolvedValue([
      { id: "f1", name: "a.pdf", checksum: "c1", fileType: "pdf" },
      { id: "f2", name: "b.pdf", checksum: "c2", fileType: "pdf" },
    ] as never);
    vi.mocked(downloadFile).mockResolvedValue({ arrayBuffer: async () => new ArrayBuffer(4) } as never);
    vi.mocked(put).mockResolvedValue({ url: "https://blob/x" } as never);
    vi.mocked(db.sourceFile.findMany).mockResolvedValue([] as never);
    vi.mocked(graphitiStore.extractFile).mockResolvedValue({ chunks: ["page"] } as never);
    vi.mocked(graphitiStore.ingestBulk).mockResolvedValue(["ep_1"] as never);
    vi.mocked(pgvectorStore.ingest).mockResolvedValue({ episodeId: "chunk_1" } as never);
  });

  it("stops ingesting files once the pointer moves", async () => {
    // The move lands while f1's blob upload is in flight, after the check
    // made before the download. f1 is not written either: the file re-checks
    // right before its graph write.
    vi.mocked(put).mockImplementation((async () => {
      storedScopePath = NEW_SCOPE;
      return { url: "https://blob/x" };
    }) as never);

    const result = await syncHandler({ event: EVENT("src_drive"), step: step() });

    expect(vi.mocked(downloadFile)).toHaveBeenCalledTimes(1); // f2 never touched
    expect(vi.mocked(graphitiStore.ingestBulk)).not.toHaveBeenCalled();
    expect(vi.mocked(pgvectorStore.ingest)).not.toHaveBeenCalled();
    expect(result.superseded).toBe(true);
    expect(terminalStatusWrites()).toHaveLength(0);
  });

  it("writes nothing for a file whose download a disconnect lands during", async () => {
    // Bar 1 of docs/consent-deletion-suite.md counts writes, not what is still
    // retrievable afterwards: the run's retirement would hide a graph write
    // made after the disconnect, so this asserts the write never happens.
    vi.mocked(put).mockImplementation((async () => {
      storedStatus = "disconnected";
      return { url: "https://blob/x" };
    }) as never);

    const result = await syncHandler({ event: EVENT("src_drive"), step: step() });

    expect(vi.mocked(downloadFile)).toHaveBeenCalledTimes(1); // f2 never touched
    expect(vi.mocked(graphitiStore.ingestBulk)).not.toHaveBeenCalled();
    expect(vi.mocked(pgvectorStore.ingest)).not.toHaveBeenCalled();
    expect(result.disconnected).toBe(true);
    expect(vi.mocked(retireSourceContent)).toHaveBeenCalledTimes(1);
  });

  it("writes no chunk once a disconnect lands between a file's graph write and its chunk write", async () => {
    // Bar 1 of docs/consent-deletion-suite.md: nothing is written for a source
    // that is disconnected at write time. The episode that landed first is
    // recorded and retired by the run once it stops.
    vi.mocked(graphitiStore.ingestBulk).mockImplementation((async () => {
      storedStatus = "disconnected";
      return ["ep_1"];
    }) as never);

    const result = await syncHandler({ event: EVENT("src_drive"), step: step() });

    expect(vi.mocked(graphitiStore.ingestBulk)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pgvectorStore.ingest)).not.toHaveBeenCalled();
    expect(result.disconnected).toBe(true);
    expect(vi.mocked(retireSourceContent)).toHaveBeenCalledTimes(1);
    expect(terminalStatusWrites()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The second hop: fileIngest writes the Drive episode after sourceSync returns.
// ---------------------------------------------------------------------------
describe("fileIngest — the connector scope carried in the event, re-checked before writing", () => {
  const CONNECTOR_EVENT = {
    data: {
      groupId: "org_1",
      blobUrl: "https://blob/x",
      filename: "a.pdf",
      fileType: "pdf",
      actorType: "extraction",
      actorId: "gdrive-sync:src_drive",
      actorName: "Docs",
      scopePath: OLD_SCOPE,
      sourceId: "src_drive",
    },
  };

  beforeEach(() => {
    vi.mocked(graphitiStore.extractFile).mockResolvedValue({ chunks: ["one", "two"] } as never);
    vi.mocked(pgvectorStore.ingestAll).mockResolvedValue([] as never);
    vi.mocked(graphitiStore.ingestBulk).mockResolvedValue({} as never);
    vi.mocked(graphitiStore.dedupeNodes).mockResolvedValue(0 as never);
  });

  it("writes nothing when the source moved between sourceSync firing this job and it running", async () => {
    storedScopePath = NEW_SCOPE;

    const result = await ingestHandler({ event: CONNECTOR_EVENT, step: step() });

    expect(pgvectorStore.ingestAll).not.toHaveBeenCalled();
    expect(graphitiStore.ingestBulk).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ingested: 0, superseded: true });
  });

  it("writes no episode once a disconnect lands during the chunk write, and purges the chunks", async () => {
    vi.mocked(pgvectorStore.ingestAll).mockImplementation((async () => {
      storedStatus = "disconnected";
      return [];
    }) as never);

    const result = await ingestHandler({ event: CONNECTOR_EVENT, step: step() });

    expect(graphitiStore.ingestBulk).not.toHaveBeenCalled();
    expect(retireLateSourceWrite).toHaveBeenCalledWith({ orgId: "org_1", sourceId: "src_drive", scopePath: OLD_SCOPE });
    expect(result).toMatchObject({ ingested: 0, superseded: true });
  });

  it("purges both stores when a disconnect lands during the graph write", async () => {
    // The check inside a step cannot see a disconnect that lands while its own
    // write is in flight; the check after the last write does.
    vi.mocked(graphitiStore.ingestBulk).mockImplementation((async () => {
      storedStatus = "disconnected";
      return [];
    }) as never);

    const result = await ingestHandler({ event: CONNECTOR_EVENT, step: step() });

    expect(retireLateSourceWrite).toHaveBeenCalledTimes(1);
    expect(retireLateSourceWrite).toHaveBeenCalledWith({ orgId: "org_1", sourceId: "src_drive", scopePath: OLD_SCOPE });
    expect(recordDocumentIngested).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ingested: 0, superseded: true });
  });

  it("refuses a connector event carrying no scope rather than widening to the org", async () => {
    const noScope = { data: { ...CONNECTOR_EVENT.data, scopePath: undefined } };

    const result = await ingestHandler({ event: noScope, step: step() });

    expect(pgvectorStore.ingestAll).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ingested: 0, superseded: true });
  });

  it("control: an unmoved connector scope still ingests", async () => {
    const result = await ingestHandler({ event: CONNECTOR_EVENT, step: step() });

    expect(pgvectorStore.ingestAll).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pgvectorStore.ingestAll).mock.calls[0]![0]).toHaveLength(2);
    expect(retireLateSourceWrite).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ingested: 2 });
  });

  it("control: a direct user upload has no source to re-check and is untouched", async () => {
    // FileIngestInput.sourceId is set only by Drive sync — an upload must not
    // be gated on a connector row it has nothing to do with.
    const upload = {
      data: {
        groupId: "org_1",
        blobUrl: "https://blob/y",
        filename: "u.pdf",
        fileType: "pdf",
        actorId: "user_1",
        scopePath: OLD_SCOPE,
      },
    };
    storedScopePath = NEW_SCOPE; // irrelevant to an upload

    const result = await ingestHandler({ event: upload, step: step() });

    expect(db.source.findFirst).not.toHaveBeenCalled();
    expect(pgvectorStore.ingestAll).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pgvectorStore.ingestAll).mock.calls[0]![0]).toHaveLength(2);
    expect(result).toMatchObject({ ingested: 2 });
  });
});
