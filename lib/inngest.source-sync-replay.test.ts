import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Connector-sync progress counters survive an Inngest replay.
 *
 * A counter that is a `let` mutated INSIDE a `step.run` closure reads wrong on
 * replay: Inngest serves an already-completed step from its memoized cache and
 * never re-runs the closure. Each branch returns an item's outcome as the
 * step's own durable return value and aggregates with `summarizeSyncOutcomes`.
 * The pure-function tests of `summarizeSyncOutcomes` and `sourceSyncStatus`
 * prove the aggregator is correct, but NOT that every branch of `sourceSync`
 * actually uses it.
 *
 * These tests drive the real `sourceSync` handler against a step runner that
 * reproduces Inngest's replay semantics (a memoized step returns its cached
 * output and does NOT re-invoke its closure), and run the SAME scenario
 * against both branches. The text branch is the control: it must survive a
 * replay. Any divergence is the defect, not the harness.
 */

vi.mock("@/lib/db", () => ({
  db: {
    // Each SourceFile write commits in one transaction with its change event
    // (services/memory/content-change-event.ts); the callback runs against this mock.
    $transaction(fn: (tx: unknown) => unknown) {
      return fn(this);
    },
    account: { update: vi.fn() },
    contact: { update: vi.fn() },
    source: { findFirst: vi.fn(), findFirstOrThrow: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    sourceFile: {
      upsert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      findMany: vi.fn(),
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
  memory: { graph: vi.fn(), ingest: vi.fn() },
  graphitiStore: {
    removeEpisode: vi.fn(),
    extractFile: vi.fn(async () => ({ chunks: ["page"] })),
    ingestBulk: vi.fn(async () => ["ep"]),
    dedupeNodes: vi.fn(async () => 0),
  },
  pgvectorStore: { ingest: vi.fn(async () => ({ episodeId: "chunk" })) },
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

import { sourceSync } from "./inngest";
import { db } from "@/lib/db";
import { memory } from "@/services/memory";
import { listChannelMessages } from "@/services/connectors/slack";
import { listFolderFiles, downloadFile } from "@/services/connectors/gdrive";
import { fetchInsightSnapshot } from "@/services/connectors/posthog";
import { unsealSecret } from "@/lib/crypto";
import { put } from "@vercel/blob";

/** The handler `inngest.createFunction` wraps (inngest 4.5.0 keeps it on `fn`). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handler = (sourceSync as any).fn as (ctx: {
  event: { data: unknown };
  step: { run: (id: string, cb: () => unknown) => Promise<unknown> };
}) => Promise<unknown>;

/**
 * A `step` that behaves the way Inngest does across a replay: a step id that
 * already has a recorded output is served FROM THAT OUTPUT and its closure is
 * never invoked again. `throwOn` simulates the process dying at a given step,
 * so that step never gets memoized and the next pass is a genuine replay of
 * everything before it.
 */
function replayStep(memo: Map<string, unknown>, throwOn?: string) {
  const invoked: string[] = [];
  return {
    invoked,
    run: async (id: string, cb: () => unknown) => {
      if (memo.has(id)) return memo.get(id); // replay: closure NOT re-invoked
      if (id === throwOn) throw new Error(`simulated crash at step ${id}`);
      invoked.push(id);
      const out = await cb();
      memo.set(id, out);
      return out;
    },
  };
}

/**
 * The `data` payload persisted by whichever terminal step ran last. Both terminal
 * steps write through `updateMany`, conditional on the source not being
 * disconnected; the opening "syncing" mark is the only `update`.
 */
function lastPersistedMeta() {
  const calls = vi.mocked(db.source.updateMany).mock.calls;
  return (calls.at(-1)?.[0] as { data: { status: string; meta: Record<string, unknown> } }).data;
}

const SLACK_SOURCE = {
  id: "src_slack",
  orgId: "org_1",
  type: "slack",
  name: "#general",
  externalId: "C123",
  scopePath: "org_1.general",
};
const DRIVE_SOURCE = {
  id: "src_drive",
  orgId: "org_1",
  type: "gdrive",
  name: "Docs",
  externalId: "F123",
  scopePath: "org_1.docs",
};
const POSTHOG_SOURCE = {
  id: "src_posthog",
  orgId: "org_1",
  type: "posthog",
  name: "Signups",
  externalId: "1:42",
  scopePath: "org_1.signups",
  meta: { projectId: "1", host: "https://eu.posthog.com" },
  encryptedTokens: "sealed-blob",
};

const EVENT = (sourceId: string) => ({
  data: { sourceId, orgId: "org_1", sealedToken: "sealed-tok" },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.source.update).mockResolvedValue({} as never);
  vi.mocked(db.source.updateMany).mockResolvedValue({ count: 1 } as never);
  // The sync re-reads the source's scope pointer before each write. Nothing
  // here moves that pointer, so the re-read resolves to the same row
  // `load-source` loaded and these assertions stay about replay semantics
  // rather than that guard, which has its own coverage in
  // lib/inngest.reconnect-inflight-sync.test.ts.
  vi.mocked(db.source.findFirst).mockImplementation((async (args: unknown) => {
    const row = (await vi.mocked(db.source.findFirstOrThrow)(args as never)) as unknown as {
      scopePath: string;
    };
    return { scopePath: row.scopePath };
  }) as never);
  vi.mocked(db.sourceFile.upsert).mockResolvedValue({} as never);
  vi.mocked(db.sourceFile.update).mockResolvedValue({} as never);
  vi.mocked(db.sourceFile.delete).mockResolvedValue({} as never);
});

// ---------------------------------------------------------------------------
// Control: the TEXT branch, which returns durable per-step outcomes. A replay
// must report the same counts as the first pass.
// ---------------------------------------------------------------------------
describe("sourceSync text branch (control) — counts survive an Inngest replay", () => {
  it("reports the same synced/failed after a replay as the original pass", async () => {
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
    // m2's ingest genuinely fails on the first pass.
    vi.mocked(memory.ingest)
      .mockResolvedValueOnce({ episodeId: "ep1" } as never)
      .mockRejectedValueOnce(new Error("graphiti 503"))
      .mockResolvedValueOnce({ episodeId: "ep3" } as never);

    const memo = new Map<string, unknown>();
    // Pass A: everything runs, then the process dies before `complete` lands.
    await expect(handler({ event: EVENT("src_slack"), step: replayStep(memo, "complete") })).rejects.toThrow(
      /simulated crash/,
    );

    // Pass B: the replay. Every per-item step is served from cache.
    const passB = replayStep(memo);
    await handler({ event: EVENT("src_slack"), step: passB });

    expect(passB.invoked).not.toContain("process-item-m1"); // genuinely memoized
    const { status, meta } = lastPersistedMeta();
    expect(meta.synced).toBe(2);
    expect(meta.failed).toBe(1); // the real m2 failure survives the replay
    expect(status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// The DRIVE branch must hold the same property. Same harness, same replay.
// ---------------------------------------------------------------------------
describe("sourceSync drive branch — counters across an Inngest replay", () => {
  it("reports synced/failed from durable step outputs, not closure-mutated counters", async () => {
    vi.mocked(db.source.findFirstOrThrow).mockResolvedValue(DRIVE_SOURCE as never);
    vi.mocked(db.sourceFile.findUnique).mockResolvedValue(null as never);
    vi.mocked(db.sourceFile.findMany).mockResolvedValue([] as never);
    vi.mocked(listFolderFiles).mockResolvedValue([
      { id: "f1", name: "a.pdf", checksum: "c1", fileType: "pdf" },
      { id: "f2", name: "b.pdf", checksum: "c2", fileType: "pdf" },
      { id: "f3", name: "c.pdf", checksum: "c3", fileType: "pdf" },
    ] as never);
    vi.mocked(downloadFile).mockResolvedValue({
      arrayBuffer: async () => new ArrayBuffer(8),
    } as never);
    // f2's download genuinely fails on the first pass.
    vi.mocked(put)
      .mockResolvedValueOnce({ url: "https://blob/a" } as never)
      .mockRejectedValueOnce(new Error("blob 500"))
      .mockResolvedValueOnce({ url: "https://blob/c" } as never);

    const memo = new Map<string, unknown>();
    await expect(handler({ event: EVENT("src_drive"), step: replayStep(memo, "complete") })).rejects.toThrow(
      /simulated crash/,
    );

    const passB = replayStep(memo);
    await handler({ event: EVENT("src_drive"), step: passB });

    expect(passB.invoked).not.toContain("process-file-f1"); // memoized, same as control

    const { status, meta } = lastPersistedMeta();
    // Two files really did sync and one really did fail on the executing pass.
    expect(meta.synced).toBe(2);
    expect(meta.failed).toBe(1);
    // …and a run where the only real outcome was a failure must not read clean.
    expect(status).toBe("active");
  });

  it("a fully-failed drive sync does not report a clean terminal status on replay", async () => {
    vi.mocked(db.source.findFirstOrThrow).mockResolvedValue(DRIVE_SOURCE as never);
    vi.mocked(db.sourceFile.findUnique).mockResolvedValue(null as never);
    vi.mocked(db.sourceFile.findMany).mockResolvedValue([] as never);
    vi.mocked(listFolderFiles).mockResolvedValue([
      { id: "f1", name: "a.pdf", checksum: "c1", fileType: "pdf" },
    ] as never);
    vi.mocked(downloadFile).mockRejectedValue(new Error("gdrive 403"));

    const memo = new Map<string, unknown>();
    await expect(handler({ event: EVENT("src_drive"), step: replayStep(memo, "complete") })).rejects.toThrow(
      /simulated crash/,
    );

    await handler({ event: EVENT("src_drive"), step: replayStep(memo) });

    const { status, meta } = lastPersistedMeta();
    expect(meta.failed).toBe(1);
    // sourceSyncStatus({synced:0, failed:0}) resolves to "active" — so losing
    // the failure count also loses the error status the user would see.
    expect(status).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// An uncaught failure before `complete` must not leave the source stuck at
// "syncing" forever: the try/catch + mark-sync-error step writes a terminal
// status. The pure `sourceSyncStatus` tests do not exercise that wiring; this
// drives the real handler to check it.
// ---------------------------------------------------------------------------
describe("sourceSync — terminal status on a fatal error", () => {
  it("writes a terminal error status instead of leaving the source at syncing", async () => {
    vi.mocked(db.source.findFirstOrThrow).mockResolvedValue(SLACK_SOURCE as never);
    vi.mocked(listChannelMessages).mockRejectedValue(new Error("slack 401"));

    await expect(handler({ event: EVENT("src_slack"), step: replayStep(new Map()) })).rejects.toThrow(/slack 401/);

    const statuses = [...vi.mocked(db.source.update).mock.calls, ...vi.mocked(db.source.updateMany).mock.calls].map(
      (c) => (c[0] as { data: { status: string } }).data.status,
    );
    expect(statuses.at(-1)).toBe("error");
    expect(statuses.at(-1)).not.toBe("syncing");
  });
});

// ---------------------------------------------------------------------------
// `complete` and `mark-sync-error` merge into the existing `Source.meta` rather
// than replace it. A wholesale replace drops the `projectId`/`host` a posthog
// source stores there from connect time, so the connector works exactly once
// and every later sync reads back a `meta` with no `projectId` and throws.
// ---------------------------------------------------------------------------
describe("sourceSync — posthog Source.meta survives past the first sync", () => {
  beforeEach(() => {
    vi.mocked(unsealSecret).mockReturnValue({ apiKey: "phx_key" } as never);
  });

  it("keeps projectId/host in meta after a successful sync", async () => {
    vi.mocked(db.source.findFirstOrThrow).mockResolvedValue(POSTHOG_SOURCE as never);
    vi.mocked(db.sourceFile.findMany).mockResolvedValue([] as never);
    vi.mocked(fetchInsightSnapshot).mockResolvedValue([
      { id: "insight-42", text: "signups up 12%", checksum: "c1" },
    ] as never);
    vi.mocked(memory.ingest).mockResolvedValue({ episodeId: "ep1" } as never);

    await handler({ event: EVENT("src_posthog"), step: replayStep(new Map()) });

    const { meta } = lastPersistedMeta();
    expect(meta.projectId).toBe("1");
    expect(meta.host).toBe("https://eu.posthog.com");
    expect(meta.synced).toBe(1);

    // And the next sync can still read the source back: a second sync must not
    // throw "missing its project id" from this exact persisted shape.
    vi.mocked(db.source.findFirstOrThrow).mockResolvedValue({ ...POSTHOG_SOURCE, meta } as never);
    await handler({ event: EVENT("src_posthog"), step: replayStep(new Map()) });
    expect(vi.mocked(fetchInsightSnapshot)).toHaveBeenLastCalledWith("1", "42", "phx_key", "https://eu.posthog.com");
  });

  it("keeps projectId/host in meta after a failed sync", async () => {
    vi.mocked(db.source.findFirstOrThrow).mockResolvedValue(POSTHOG_SOURCE as never);
    vi.mocked(fetchInsightSnapshot).mockRejectedValue(new Error("posthog 500"));

    await expect(handler({ event: EVENT("src_posthog"), step: replayStep(new Map()) })).rejects.toThrow(/posthog 500/);

    const { meta } = lastPersistedMeta();
    expect(meta.projectId).toBe("1");
    expect(meta.host).toBe("https://eu.posthog.com");
    // The person reads the fix (lib/inngest/sync-failure-message.ts), never the error's own text.
    expect(meta.error).toMatch(/^This PostHog sync stopped before it finished\. Sync again/);
  });
});

// ---------------------------------------------------------------------------
// gdrive's token is never stored: the event seals it, and every Drive call in
// the job, the per-file download as well as the listing, must use the token
// opened from that seal. A download sent without it is "Bearer undefined" and
// every file fails with a 401 after a listing that succeeded.
// ---------------------------------------------------------------------------
describe("sourceSync drive branch — the sealed event token reaches every Drive call", () => {
  it("lists and downloads with the token opened from the event's seal", async () => {
    vi.mocked(unsealSecret).mockReturnValue({ token: "tok" } as never);
    vi.mocked(db.source.findFirstOrThrow).mockResolvedValue(DRIVE_SOURCE as never);
    vi.mocked(db.sourceFile.findUnique).mockResolvedValue(null as never);
    vi.mocked(db.sourceFile.findMany).mockResolvedValue([] as never);
    vi.mocked(listFolderFiles).mockResolvedValue([
      { id: "f1", name: "a.pdf", checksum: "c1", fileType: "pdf" },
    ] as never);
    vi.mocked(downloadFile).mockResolvedValue({ arrayBuffer: async () => new ArrayBuffer(8) } as never);
    vi.mocked(put).mockResolvedValue({ url: "https://blob/a" } as never);

    await handler({ event: EVENT("src_drive"), step: replayStep(new Map()) });

    expect(vi.mocked(unsealSecret)).toHaveBeenCalledWith("sealed-tok");
    expect(vi.mocked(listFolderFiles)).toHaveBeenCalledWith("F123", "tok");
    expect(vi.mocked(downloadFile)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(downloadFile).mock.calls[0][1]).toBe("tok");
  });
});
