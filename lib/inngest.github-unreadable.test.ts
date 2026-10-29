import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A GitHub token that may read some of a repository but not all of it (no
 * Issues permission, say) syncs what it can read instead of failing the whole
 * source. Two things must hold at the `sourceSync` seam:
 *   - the skipped kind is recorded on `Source.meta.unreadable`, so the source
 *     says why its issues are missing rather than looking complete;
 *   - items of that kind ingested under an earlier, broader token are retired,
 *     because content the stored credential can no longer read must stop being
 *     retrievable, the same as a revoked grant.
 */

vi.mock("@/lib/db", () => ({
  db: {
    $transaction(fn: (tx: unknown) => unknown) {
      return fn(this);
    },
    source: { findFirst: vi.fn(), findFirstOrThrow: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    sourceFile: {
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
    },
    // No restore is waiting on a re-apply (restore-completion.realdb.test.ts covers one).
    erasureReapplyDue: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock("@/services/memory/content-change-event", () => ({
  recordSourceItemChange: vi.fn(),
  recordDocumentIngested: vi.fn(),
}));
vi.mock("@/services/memory", () => ({
  memory: { ingest: vi.fn(), graph: vi.fn() },
  graphitiStore: { removeEpisode: vi.fn(), dedupeNodes: vi.fn() },
  pgvectorStore: { ingest: vi.fn() },
}));
vi.mock("@/services/enrichment", () => ({ enrich: vi.fn() }));
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: vi.fn().mockResolvedValue(undefined),
  recordEpisode: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/connectors/github", () => ({ listRepositoryItems: vi.fn(), parseCursor: vi.fn(() => null) }));
vi.mock("@/lib/crypto", () => ({ unsealSecret: vi.fn(() => ({ token: "github_pat_real" })) }));

import { sourceSync } from "./inngest";
import { db } from "@/lib/db";
import { graphitiStore } from "@/services/memory";
import { listRepositoryItems } from "@/services/connectors/github";

type StepCtx = {
  event: { data: unknown };
  step: { run: (id: string, cb: () => unknown) => Promise<unknown> };
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const syncHandler = (sourceSync as any).fn as (ctx: StepCtx) => Promise<any>;

const SCOPE = "org_1.everyone";
const SOURCE = {
  id: "src_gh",
  orgId: "org_1",
  type: "github",
  name: "o/r",
  externalId: "o/r",
  scopePath: SCOPE,
  status: "syncing",
  meta: {},
  encryptedTokens: "sealed-blob",
};
const README = { id: "readme", text: "README of o/r", author: "o", checksum: "r1" };
const CURSOR = {
  issues: {},
  pulls: {},
  commits: {},
  comments: {},
  reviewQueue: [],
  docs: {},
  probeOffset: 0,
  refusedParents: [] as ("issues" | "pulls")[],
};

function run() {
  const steps: string[] = [];
  const step = {
    run: async (id: string, cb: () => unknown) => {
      steps.push(id);
      return cb();
    },
  };
  return syncHandler({ event: { data: { sourceId: SOURCE.id, orgId: "org_1" } }, step }).then((result) => ({
    result,
    steps,
  }));
}

function completedMeta() {
  const call = vi.mocked(db.source.updateMany).mock.calls.at(-1);
  return (call?.[0] as { data: { meta: Record<string, unknown> } }).data.meta;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.source.findFirstOrThrow).mockResolvedValue(SOURCE as never);
  vi.mocked(db.source.update).mockResolvedValue({} as never);
  vi.mocked(db.source.findFirst).mockResolvedValue({ scopePath: SCOPE, status: "syncing" } as never);
  vi.mocked(db.source.updateMany).mockResolvedValue({ count: 1 } as never);
  vi.mocked(db.sourceFile.update).mockResolvedValue({} as never);
  vi.mocked(db.sourceFile.delete).mockResolvedValue({} as never);
  vi.mocked(db.sourceFile.updateMany).mockResolvedValue({ count: 1 } as never);
  vi.mocked(db.sourceFile.findFirst).mockResolvedValue({ episodeRetireStartedAt: null } as never);
  vi.mocked(graphitiStore.removeEpisode).mockResolvedValue({ removed: true } as never);
  // The README is already stored unchanged; issue #3 came from an earlier sync
  // whose token could still read issues.
  vi.mocked(db.sourceFile.findMany).mockResolvedValue([
    { externalFileId: "readme", checksum: "r1", episodeId: "ep_readme", episodeScopePath: SCOPE },
    { externalFileId: "issue-3", checksum: "i3", episodeId: "ep_issue3", episodeScopePath: SCOPE },
  ] as never);
});

describe("sourceSync — a GitHub token without permission for one kind", () => {
  it("completes, records the unreadable kind on Source.meta, and retires that kind's old items", async () => {
    // The connector names the unreadable kind's stored items gone (services/connectors/github.test.ts).
    vi.mocked(listRepositoryItems).mockResolvedValue({
      items: [README],
      unreadable: ["issues"],
      gone: ["issue-3"],
      cursor: CURSOR,
      heldCursor: CURSOR,
    });

    const { result, steps } = await run();

    expect(result).toMatchObject({ files: 1, skipped: 1, failed: 0, disconnected: false });
    expect(steps).toContain("retire-vanished-issue-3");
    expect(steps).not.toContain("retire-vanished-readme");
    expect(vi.mocked(db.sourceFile.delete)).toHaveBeenCalledWith({
      where: { sourceId_externalFileId: { sourceId: SOURCE.id, externalFileId: "issue-3" } },
    });
    expect(completedMeta()).toMatchObject({ unreadable: ["issues"], failed: 0 });
  });

  it("clears an earlier unreadable note once the token can read everything again", async () => {
    vi.mocked(db.source.findFirstOrThrow).mockResolvedValue({ ...SOURCE, meta: { unreadable: ["issues"] } } as never);
    vi.mocked(listRepositoryItems).mockResolvedValue({
      items: [README, { id: "issue-3", text: "Issue #3", author: "a", checksum: "i3" }],
      unreadable: [],
      gone: [],
      cursor: CURSOR,
      heldCursor: CURSOR,
    });

    await run();

    expect(completedMeta().unreadable).toEqual([]);
  });
});
