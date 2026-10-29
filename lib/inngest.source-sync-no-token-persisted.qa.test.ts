import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * No connector token lands in anything
 * Inngest persists.
 *
 * Inngest keeps three things outside the database: the event, every step's
 * return value, and every step's thrown error. The route tests prove the event
 * the routes queue is free of clear tokens, and the replay test proves the job
 * hands the opened token to each Drive call, but each one mocks the crypto on
 * one side. This file runs the REAL sealSecret/unsealSecret across the seam: an
 * event sealed exactly as the routes seal it is run through the real
 * `sourceSync` handler, and the event, every step output and every step error
 * are scanned for a token-shaped value, while the connector still receives the
 * exact token. On main the job reads `input.token`, so the connector receives
 * undefined and these tests go red.
 */

process.env.APP_ENCRYPTION_KEY ??= "ab".repeat(32);

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
vi.mock("@vercel/blob", () => ({ put: vi.fn(), del: vi.fn() }));

import { sourceSync } from "./inngest";
import { db } from "@/lib/db";
import { listChannelMessages } from "@/services/connectors/slack";
import { listFolderFiles, downloadFile } from "@/services/connectors/gdrive";
import { put } from "@vercel/blob";
import { sealSecret } from "@/lib/crypto";

type StepCtx = {
  event: { data: unknown };
  step: { run: (id: string, cb: () => unknown) => Promise<unknown> };
};
const handler = (sourceSync as unknown as { fn: (ctx: StepCtx) => Promise<unknown> }).fn;

/** Any connector credential's own prefix: Slack, Figma, Google OAuth, GitHub, PostHog. */
const TOKEN_SHAPED = /xox[abposr]-|figd_|ya29\.|gh[pousr]_|github_pat_|ph[xc]_/;

/** A step that records what Inngest would persist: each output and each error message. */
function recordingStep() {
  const persisted: unknown[] = [];
  return {
    persisted,
    run: async (id: string, cb: () => unknown) => {
      try {
        const out = await cb();
        persisted.push({ id, out: out === undefined ? null : out });
        return out;
      } catch (e) {
        persisted.push({ id, error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    },
  };
}

const SLACK_SOURCE = {
  id: "src_slack",
  orgId: "org_1",
  type: "slack",
  name: "#general",
  externalId: "C123",
  scopePath: "org_1.general",
  meta: null,
  connectAuthorizationId: null,
};
const DRIVE_SOURCE = {
  id: "src_drive",
  orgId: "org_1",
  type: "gdrive",
  name: "Docs",
  externalId: "F123",
  scopePath: "org_1.docs",
  meta: null,
  connectAuthorizationId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.source.update).mockResolvedValue({} as never);
  vi.mocked(db.source.updateMany).mockResolvedValue({ count: 1 } as never);
  vi.mocked(db.source.findFirst).mockImplementation((async (args: unknown) => {
    const row = (await vi.mocked(db.source.findFirstOrThrow)(args as never)) as unknown as { scopePath: string };
    return { scopePath: row.scopePath };
  }) as never);
  vi.mocked(db.sourceFile.upsert).mockResolvedValue({} as never);
  vi.mocked(db.sourceFile.update).mockResolvedValue({} as never);
  vi.mocked(db.sourceFile.findMany).mockResolvedValue([] as never);
  vi.mocked(db.sourceFile.findUnique).mockResolvedValue(null as never);
});

describe("QA #754: no token in the event, any step output or any step error", () => {
  it("gdrive: the route-sealed token opens inside the job, reaches list and download, and is persisted nowhere", async () => {
    const token = "ya29.qa-not-a-real-google-token";
    const event = { data: { sourceId: "src_drive", orgId: "org_1", sealedToken: sealSecret({ token }) } };
    vi.mocked(db.source.findFirstOrThrow).mockResolvedValue(DRIVE_SOURCE as never);
    vi.mocked(listFolderFiles).mockResolvedValue([
      { id: "f1", name: "a.pdf", checksum: "c1", fileType: "pdf" },
    ] as never);
    vi.mocked(downloadFile).mockResolvedValue({ arrayBuffer: async () => new ArrayBuffer(8) } as never);
    vi.mocked(put).mockResolvedValue({ url: "https://blob/a" } as never);
    const step = recordingStep();

    await handler({ event, step });

    expect(vi.mocked(listFolderFiles)).toHaveBeenCalledWith("F123", token);
    expect(vi.mocked(downloadFile).mock.calls[0]?.[1]).toBe(token);
    expect(JSON.stringify(event)).not.toMatch(TOKEN_SHAPED);
    expect(step.persisted.length).toBeGreaterThan(0);
    expect(JSON.stringify(step.persisted)).not.toMatch(TOKEN_SHAPED);
  });

  it("slack on its stored credential: an event with no token lists with the row's token, persisted nowhere", async () => {
    const token = "xox" + "b-qa-not-a-real-slack-token";
    vi.mocked(db.source.findFirstOrThrow).mockResolvedValue({
      ...SLACK_SOURCE,
      encryptedTokens: sealSecret({ token }),
    } as never);
    vi.mocked(listChannelMessages).mockResolvedValue({
      items: [{ id: "m1", text: "one", checksum: "c1" }],
      gone: [],
      cursor: {},
    } as never);
    const event = { data: { sourceId: "src_slack", orgId: "org_1" } };
    const step = recordingStep();

    await handler({ event, step });

    expect(vi.mocked(listChannelMessages).mock.calls[0]?.[1]).toBe(token);
    expect(JSON.stringify(step.persisted)).not.toMatch(TOKEN_SHAPED);
  });

  it("slack with a fresh token on the re-sync: the event's sealed token wins over the stored one", async () => {
    const fresh = "xox" + "b-qa-fresh-token";
    vi.mocked(db.source.findFirstOrThrow).mockResolvedValue({
      ...SLACK_SOURCE,
      encryptedTokens: sealSecret({ token: "xox" + "b-qa-stale-token" }),
    } as never);
    vi.mocked(listChannelMessages).mockResolvedValue({ items: [], gone: [], cursor: {} } as never);
    const event = { data: { sourceId: "src_slack", orgId: "org_1", sealedToken: sealSecret({ token: fresh }) } };
    const step = recordingStep();

    await handler({ event, step });

    expect(vi.mocked(listChannelMessages).mock.calls[0]?.[1]).toBe(fresh);
    expect(JSON.stringify(event)).not.toMatch(TOKEN_SHAPED);
    expect(JSON.stringify(step.persisted)).not.toMatch(TOKEN_SHAPED);
  });

  it("a gdrive event with no sealed token fails loudly instead of calling Drive unauthenticated", async () => {
    vi.mocked(db.source.findFirstOrThrow).mockResolvedValue(DRIVE_SOURCE as never);
    const step = recordingStep();

    await expect(handler({ event: { data: { sourceId: "src_drive", orgId: "org_1" } }, step })).rejects.toThrow(
      /carries no token/,
    );
    expect(vi.mocked(listFolderFiles)).not.toHaveBeenCalled();
  });
});
