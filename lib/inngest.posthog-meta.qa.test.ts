// Mocked end to end: needs no database; runs in every environment.

import { beforeEach, describe, expect, it, vi } from "vitest";

// A PostHog source's upstream address must survive every sync.
//
// The PostHog connector stores the non-secret half of a source's upstream
// address — `projectId` and `host` — on `Source.meta`, written once by
// `POST /api/sources` at connect time. `listPostHogItems` reads it back on
// every sync and throws without it.
//
// `sourceSync` finishes by REPLACING that column rather than merging into it:
// `complete` writes `meta: { lastSyncAt, fileCount, synced, skipped, failed }`
// and `mark-sync-error` writes the same keys plus `error` (lib/inngest.ts,
// the two `db.source.update` calls at the end of `sourceSync`). Neither
// carries `projectId` or `host` forward. These tests pin what that leaves
// behind for the next sync.

vi.mock("@/lib/db", () => ({
  db: {
    account: { update: vi.fn() },
    contact: { update: vi.fn() },
    source: { findFirstOrThrow: vi.fn(), update: vi.fn() },
    sourceFile: { upsert: vi.fn(), delete: vi.fn() },
  },
}));
vi.mock("@/services/memory", () => ({
  memory: { graph: vi.fn(), ingest: vi.fn() },
  graphitiStore: { removeEpisode: vi.fn() },
}));
vi.mock("@/services/enrichment", () => ({ enrich: vi.fn() }));
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: vi.fn().mockResolvedValue(undefined),
  recordEpisode: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/connectors/posthog", () => ({
  fetchInsightSnapshot: vi.fn(),
  POSTHOG_DEFAULT_HOST: "https://us.posthog.com",
}));
vi.mock("@/lib/crypto", () => ({ unsealSecret: vi.fn() }));

import { listPostHogItems } from "./inngest";
import { fetchInsightSnapshot } from "@/services/connectors/posthog";
import { unsealSecret } from "@/lib/crypto";

/** What POST /api/sources writes to Source.meta on connect. */
const META_AT_CONNECT = { projectId: "1", host: "https://eu.posthog.com" };

/** What sourceSync's `complete` step writes to Source.meta after a sync. */
const META_AFTER_SUCCESSFUL_SYNC = {
  lastSyncAt: "2026-09-21T05:00:00.000Z",
  fileCount: 1,
  synced: 1,
  skipped: 0,
  failed: 0,
};

/** What sourceSync's `mark-sync-error` step writes to Source.meta. */
const META_AFTER_FAILED_SYNC = { ...META_AFTER_SUCCESSFUL_SYNC, synced: 0, failed: 1, error: "boom" };

function source(meta: unknown) {
  return { id: "src_1", externalId: "42", meta, encryptedTokens: "sealed-blob" };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(unsealSecret).mockReturnValue({ apiKey: "phx_key" });
  vi.mocked(fetchInsightSnapshot).mockResolvedValue([]);
});

describe("listPostHogItems — Source.meta survival across syncs", () => {
  it("works on the meta the connect route writes", async () => {
    await expect(listPostHogItems(source(META_AT_CONNECT))).resolves.toEqual([]);
    expect(vi.mocked(fetchInsightSnapshot)).toHaveBeenCalledWith("1", "42", "phx_key", "https://eu.posthog.com");
  });

  it("throws on the meta a SUCCESSFUL sync leaves behind — projectId is gone", async () => {
    await expect(listPostHogItems(source(META_AFTER_SUCCESSFUL_SYNC))).rejects.toThrow(/missing its project id/i);
    expect(vi.mocked(fetchInsightSnapshot)).not.toHaveBeenCalled();
  });

  it("throws on the meta a FAILED sync leaves behind too", async () => {
    await expect(listPostHogItems(source(META_AFTER_FAILED_SYNC))).rejects.toThrow(/missing its project id/i);
  });

  it("silently loses a custom host back to the US default when meta survives but host does not", async () => {
    await expect(listPostHogItems(source({ projectId: "1" }))).resolves.toEqual([]);
    expect(vi.mocked(fetchInsightSnapshot)).toHaveBeenCalledWith("1", "42", "phx_key", "https://us.posthog.com");
  });
});
