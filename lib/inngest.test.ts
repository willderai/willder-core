import { beforeEach, describe, expect, it, vi } from "vitest";

// Test the best-effort CRM↔memory entity matcher in isolation. The Inngest fn's
// other steps (gather/ingest) are covered by the enrichment + route tests; this pins
// the name-matching + which record gets stamped. Module deps are mocked so importing
// lib/inngest doesn't touch Prisma/Graphiti/providers.
vi.mock("@/lib/db", () => ({
  db: {
    // Each SourceFile write commits in one transaction with its change event
    // (services/memory/content-change-event.ts); the callback runs against this mock.
    $transaction(fn: (tx: unknown) => unknown) {
      return fn(this);
    },
    account: { update: vi.fn() },
    contact: { update: vi.fn() },
    // No tier recorded: enterprise, every org's tier today, so linkEntity reads the graph.
    org: { findUnique: vi.fn(async () => ({ settings: {} })) },
    source: { findFirst: vi.fn(), findFirstOrThrow: vi.fn() },
    sourceFile: {
      upsert: vi.fn(),
      delete: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    // An edit records what replaced the old episode (services/memory/edges.ts).
    factEdge: {
      createMany: vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length })),
      // No version here has been replaced yet.
      findMany: vi.fn(async () => []),
    },
  },
}));
// No person has been erased in these orgs (erasure-suppression.realdb.test.ts covers one).
vi.mock("@/services/memory/erasure-suppression", () => ({ loadErasedPersonMatcher: async () => () => false }));
vi.mock("@/services/memory/content-change-event", () => ({
  recordSourceItemChange: vi.fn(),
  recordDocumentIngested: vi.fn(),
}));
vi.mock("@/services/memory", () => ({
  memory: { graph: vi.fn(), ingest: vi.fn() },
  graphitiStore: { removeEpisode: vi.fn(), extractFile: vi.fn(), ingestBulk: vi.fn() },
  pgvectorStore: { ingest: vi.fn() },
}));
vi.mock("@/services/enrichment", () => ({ enrich: vi.fn() }));
// syncOneTextItem goes through the same episode-cap guard every other ingest
// path does; mocked out here the same way the route/eval tests mock it, so
// these tests exercise connector-sync's own retirement/counting logic, not
// the (separately tested) episode-cap guardrail.
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: vi.fn().mockResolvedValue(undefined),
  recordEpisode: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/connectors/posthog", () => ({
  fetchInsightSnapshot: vi.fn(),
  POSTHOG_DEFAULT_HOST: "https://us.posthog.com",
}));
vi.mock("@/services/connectors/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/connectors/github")>()),
  listRepositoryItems: vi.fn(),
}));
vi.mock("@/lib/crypto", () => ({ unsealSecret: vi.fn() }));

import {
  linkEntity,
  attributeToSentence,
  parseAttributes,
  buildConnectorIngestInput,
  loadScopedSource,
  listPostHogItems,
  listGitHubItems,
  planConnectorSync,
  syncOneTextItem,
  retireVanishedTextItem,
  summarizeSyncOutcomes,
  sourceSyncStatus,
  processDriveFile,
  type EnrichmentJobInput,
  type ConnectorSyncOutcome,
} from "./inngest";
import { db } from "@/lib/db";
import { memory, graphitiStore, pgvectorStore } from "@/services/memory";
import { fetchInsightSnapshot } from "@/services/connectors/posthog";
import { listRepositoryItems } from "@/services/connectors/github";
import { unsealSecret } from "@/lib/crypto";

const base: EnrichmentJobInput = {
  orgId: "org_1",
  recordId: "a1",
  target: { kind: "account", name: "Acme", domain: "acme.com" },
  actorId: "user_42",
  origin: "app",
};

beforeEach(() => vi.clearAllMocks());

describe("linkEntity", () => {
  it("stamps an account's entityId on an exact name match", async () => {
    vi.mocked(memory.graph).mockResolvedValue({
      nodes: [
        { uuid: "n_other", name: "Globex", type: "Company" },
        { uuid: "n_acme", name: "Acme", type: "Company" },
      ],
      edges: [],
    });

    const uuid = await linkEntity(base);
    expect(uuid).toBe("n_acme");
    expect(db.account.update).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { entityId: "n_acme" },
    });
    expect(db.contact.update).not.toHaveBeenCalled();
  });

  it("falls back to a substring match (graph node 'Acme Corporation' vs 'Acme')", async () => {
    vi.mocked(memory.graph).mockResolvedValue({
      nodes: [{ uuid: "n_acme", name: "Acme Corporation", type: "Company" }],
      edges: [],
    });
    const uuid = await linkEntity(base);
    expect(uuid).toBe("n_acme");
  });

  it("returns null and updates nothing when no node matches", async () => {
    vi.useFakeTimers();
    vi.mocked(memory.graph).mockResolvedValue({
      nodes: [{ uuid: "n_x", name: "Initech", type: "Company" }],
      edges: [],
    });
    const promise = linkEntity(base);
    // Skip the 3x 3s retry delays
    await vi.runAllTimersAsync();
    const uuid = await promise;
    expect(uuid).toBeNull();
    expect(db.account.update).not.toHaveBeenCalled();
    expect(db.contact.update).not.toHaveBeenCalled();
    vi.useRealTimers();
  }, 15000);

  it("stamps a contact's entityId for a contact target", async () => {
    vi.mocked(memory.graph).mockResolvedValue({
      nodes: [{ uuid: "n_jane", name: "Jane Doe", type: "Person" }],
      edges: [],
    });
    const uuid = await linkEntity({
      ...base,
      recordId: "c1",
      target: { kind: "contact", name: "Jane Doe", email: "jane@acme.com" },
    });
    expect(uuid).toBe("n_jane");
    expect(db.contact.update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { entityId: "n_jane" },
    });
    expect(db.account.update).not.toHaveBeenCalled();
  });
});

describe("attributeToSentence — node attribute facts", () => {
  it("renders each predicate into a clean declarative sentence", () => {
    expect(
      attributeToSentence({ subject: "Acme Corp", predicate: "has_goal", value: "cut vendor spend 20% this year" }),
    ).toBe("Acme Corp's goal is to cut vendor spend 20% this year.");
    expect(attributeToSentence({ subject: "Acme Corp", predicate: "has_trait", value: "risk-averse" })).toBe(
      "Acme Corp is risk-averse.",
    );
    expect(
      attributeToSentence({ subject: "Sarah Chen", predicate: "prefers", value: "async communication over meetings" }),
    ).toBe("Sarah Chen prefers async communication over meetings.");
    expect(
      attributeToSentence({ subject: "Acme Corp", predicate: "has_status", value: "in active contract negotiation" }),
    ).toBe("Acme Corp is currently in active contract negotiation.");
    expect(attributeToSentence({ subject: "Acme Corp", predicate: "has_attribute", value: "Series B" })).toBe(
      "Acme Corp has the attribute: Series B.",
    );
  });

  it("trims a trailing period on the value so sentences don't double-punctuate", () => {
    expect(attributeToSentence({ subject: "Acme", predicate: "has_trait", value: "cost-sensitive." })).toBe(
      "Acme is cost-sensitive.",
    );
  });
});

describe("parseAttributes — validation + normalization", () => {
  it("keeps only well-formed objects with a known predicate", () => {
    const parsed = parseAttributes([
      { subject: "Acme", predicate: "has_trait", value: "risk-averse" },
      { subject: "Acme", predicate: "unknown_pred", value: "x" }, // bad predicate
      { subject: "A", predicate: "has_goal" }, // missing value
      { predicate: "has_trait", value: "y" }, // missing subject
      "not an object",
    ]);
    expect(parsed).toEqual([{ subject: "Acme", predicate: "has_trait", value: "risk-averse" }]);
  });

  it("returns [] for non-array input", () => {
    expect(parseAttributes(undefined)).toEqual([]);
    expect(parseAttributes(null)).toEqual([]);
    expect(parseAttributes("nope")).toEqual([]);
  });
});

// The tenant-scoping call site for the Slack/Figma sync branch in sourceSync,
// pulled out as its own function so verifying it doesn't require driving the
// whole Inngest step function.
describe("buildConnectorIngestInput — connector sync tenant scoping", () => {
  const source = {
    id: "src_1",
    orgId: "org_1",
    type: "slack",
    name: "#general",
    scopePath: "org_1.general",
  };

  it("stamps the source's own org and scope, never a caller-supplied one", () => {
    const input = buildConnectorIngestInput(source, { text: "hello team" });
    expect(input.groupId).toBe("org_1");
    expect(input.scopePath).toBe("org_1.general");
    expect(input.content).toBe("hello team");
  });

  it("marks the episode as extraction provenance, not human, and skips re-resolution", () => {
    const input = buildConnectorIngestInput(source, { text: "hello team" });
    expect(input.actorType).toBe("extraction");
    expect(input.resolve).toBe(false);
  });

  it("marks the item as a document so passages whose numbers extraction drops are kept verbatim", () => {
    expect(buildConnectorIngestInput(source, { text: "x" }).recordType).toBe("document");
  });

  // The memory service keeps it verbatim; the connector decides what it is.
  it("sends the heading the connector named the item with, and none when it named none", () => {
    expect(buildConnectorIngestInput(source, { text: "x", heading: "Issue #7 (open): x" }).heading).toBe(
      "Issue #7 (open): x",
    );
    expect(buildConnectorIngestInput(source, { text: "Issue #7 (open): x" }).heading).toBeUndefined();
  });

  it("keys actorId on the source type and id so Slack and Figma sync distinctly", () => {
    const slack = buildConnectorIngestInput(source, { text: "x" });
    const figma = buildConnectorIngestInput({ ...source, id: "src_2", type: "figma" }, { text: "x" });
    expect(slack.actorId).toBe("slack-sync:src_1");
    expect(figma.actorId).toBe("figma-sync:src_2");
    expect(slack.actorId).not.toBe(figma.actorId);
  });

  it("a different org's source never produces another org's groupId/scopePath", () => {
    const otherOrg = { ...source, orgId: "org_2", scopePath: "org_2.general" };
    const input = buildConnectorIngestInput(otherOrg, { text: "x" });
    expect(input.groupId).toBe("org_2");
    expect(input.scopePath).toBe("org_2.general");
    expect(input.groupId).not.toBe(source.orgId);
  });

  // Every connector-sync episode carries its own Source.id as a real
  // discriminator, so a later disconnect can purge just this source's
  // content even when it shares a scope with another producer.
  it("stamps the source's own id as sourceId, distinctly per source", () => {
    const slack = buildConnectorIngestInput(source, { text: "x" });
    const other = buildConnectorIngestInput({ ...source, id: "src_2" }, { text: "x" });
    expect(slack.sourceId).toBe("src_1");
    expect(other.sourceId).toBe("src_2");
  });
});

// Slack ts/user and Figma author reach the episode as real grounding
// (actorName/referenceTime), not just the connector's generic source name and
// the ingest-time clock.
describe("buildConnectorIngestInput — grounding: real author + timestamp", () => {
  const slackSource = {
    id: "src_1",
    orgId: "org_1",
    type: "slack",
    name: "#general",
    scopePath: "org_1.general",
  };
  const figmaSource = { ...slackSource, id: "src_2", type: "figma", name: "Willder UI" };

  it("stamps the real Slack user + a real reference time derived from ts, not ingest time", () => {
    const input = buildConnectorIngestInput(slackSource, {
      text: "shipped the connector fix",
      user: "U_ALICE",
      ts: "1700000000.0001",
    });
    expect(input.actorName).toContain("U_ALICE");
    expect(input.referenceTime).toBe(new Date(1700000000 * 1000).toISOString());
  });

  it("stamps the real Figma author + the comment's own createdAt, not ingest time", () => {
    const input = buildConnectorIngestInput(figmaSource, {
      text: "tighten the spacing",
      author: "mock_designer",
      createdAt: "2026-09-01T10:00:00.000Z",
    });
    expect(input.actorName).toContain("mock_designer");
    expect(input.referenceTime).toBe("2026-09-01T10:00:00.000Z");
  });

  it("falls back to the connector source's own name and no referenceTime when the item carries no author/ts (existing bare-text callers)", () => {
    const input = buildConnectorIngestInput(slackSource, { text: "x" });
    expect(input.actorName).toBe("#general");
    expect(input.referenceTime).toBeUndefined();
  });

  it("never cross-wires Slack's own fields onto a Figma item or vice versa", () => {
    // A slack-typed source with a figma-shaped item (author/createdAt) must not
    // accidentally read those — and a figma-typed source must not read user/ts.
    const slackWithFigmaFields = buildConnectorIngestInput(slackSource, {
      text: "x",
      author: "should_not_be_used",
      createdAt: "2020-01-01T00:00:00.000Z",
    } as never);
    expect(slackWithFigmaFields.actorName).toBe("#general");
    expect(slackWithFigmaFields.referenceTime).toBeUndefined();

    const figmaWithSlackFields = buildConnectorIngestInput(figmaSource, {
      text: "x",
      user: "should_not_be_used",
      ts: "1700000000.0000",
    } as never);
    expect(figmaWithSlackFields.actorName).toBe("Willder UI");
    expect(figmaWithSlackFields.referenceTime).toBeUndefined();
  });
});

describe("listGitHubItems — github's list-items step, pulled out", () => {
  const source = {
    id: "src_gh",
    externalId: "acme/widgets",
    encryptedTokens: "sealed-blob",
    meta: {},
    connectAuthorizationId: "audit_connect_2",
    scopePath: "org_1.eng",
  };
  const cursor = {
    issues: { since: "2026-10-14T20:00:00Z" },
    pulls: {},
    commits: {},
    comments: {},
    reviewQueue: [],
    docs: {},
    probeOffset: 3,
    refusedParents: [] as ("issues" | "pulls")[],
  };
  const heldCursor = {
    issues: {},
    pulls: {},
    commits: {},
    comments: {},
    reviewQueue: [],
    docs: {},
    probeOffset: 3,
    refusedParents: [] as ("issues" | "pulls")[],
  };

  it("decrypts the stored token and lists the source's own repository, never a client-supplied token", async () => {
    vi.mocked(unsealSecret).mockReturnValue({ token: "github_pat_real" });
    const listing = {
      items: [{ id: "issue-7", text: "Issue #7 (open): flaky sync", author: "octocat", checksum: "c" }],
      unreadable: [],
      gone: [],
      cursor,
      heldCursor,
    };
    vi.mocked(listRepositoryItems).mockResolvedValue(listing);

    const result = await listGitHubItems(source, ["issue-7"]);

    expect(vi.mocked(unsealSecret)).toHaveBeenCalledWith("sealed-blob");
    expect(vi.mocked(listRepositoryItems)).toHaveBeenCalledWith("acme/widgets", "github_pat_real", {
      cursor: null,
      stored: ["issue-7"],
    });
    const connection = expect.stringMatching(/^[0-9a-f]{64}$/);
    expect(result).toEqual({
      ...listing,
      cursor: { connection, value: cursor },
      heldCursor: { connection, value: heldCursor },
    });
    expect(result.heldCursor?.connection).toBe(result.cursor?.connection);
    expect(JSON.stringify(result)).not.toContain("audit_connect_2");
  });

  it("continues the cursor stored under this connect, and starts over under any other", async () => {
    vi.mocked(unsealSecret).mockReturnValue({ token: "github_pat_real" });
    vi.mocked(listRepositoryItems).mockResolvedValue({ items: [], unreadable: [], gone: [], cursor, heldCursor });
    // What a sync under this connect stored on the row.
    const { cursor: written } = await listGitHubItems(source, []);
    const withCursor = (row: Partial<typeof source>) => ({ ...source, ...row, meta: { syncCursor: written } });
    vi.mocked(listRepositoryItems).mockClear();

    await listGitHubItems(withCursor({}), []);
    await listGitHubItems(withCursor({ connectAuthorizationId: "audit_connect_3" }), []);
    await listGitHubItems(withCursor({ scopePath: "org_1" }), []);

    const cursors = vi.mocked(listRepositoryItems).mock.calls.map((call) => call[2]?.cursor);
    expect(cursors).toEqual([cursor, null, null]);
  });

  it("throws instead of calling GitHub when the source has no stored credential", async () => {
    await expect(listGitHubItems({ ...source, encryptedTokens: null }, [])).rejects.toThrow(
      /missing its stored credential/i,
    );
    expect(vi.mocked(listRepositoryItems)).not.toHaveBeenCalled();
  });

  it("throws instead of calling GitHub when the sealed blob carries no token", async () => {
    vi.mocked(unsealSecret).mockReturnValue({});
    await expect(listGitHubItems(source, [])).rejects.toThrow(/missing a token/i);
    expect(vi.mocked(listRepositoryItems)).not.toHaveBeenCalled();
  });
});

describe("listPostHogItems — posthog's list-items step, pulled out", () => {
  const source = {
    id: "src_ph",
    externalId: "456",
    meta: { projectId: "123", host: "https://eu.posthog.com" },
    encryptedTokens: "sealed-blob",
  };

  it("decrypts the stored key and fetches with the source's own project/host, never the client-supplied token", async () => {
    vi.mocked(unsealSecret).mockReturnValue({ apiKey: "phx_real" });
    vi.mocked(fetchInsightSnapshot).mockResolvedValue([
      { id: "insight-456", text: "t", author: "PostHog", checksum: "c" },
    ]);

    const items = await listPostHogItems(source);

    expect(vi.mocked(unsealSecret)).toHaveBeenCalledWith("sealed-blob");
    expect(vi.mocked(fetchInsightSnapshot)).toHaveBeenCalledWith("123", "456", "phx_real", "https://eu.posthog.com");
    expect(items).toEqual([{ id: "insight-456", text: "t", author: "PostHog", checksum: "c" }]);
  });

  it("falls back to the default host when meta doesn't carry one", async () => {
    vi.mocked(unsealSecret).mockReturnValue({ apiKey: "phx_real" });
    vi.mocked(fetchInsightSnapshot).mockResolvedValue([]);
    await listPostHogItems({ ...source, meta: { projectId: "123" } });
    expect(vi.mocked(fetchInsightSnapshot)).toHaveBeenCalledWith("123", "456", "phx_real", "https://us.posthog.com");
  });

  it("throws instead of calling PostHog when the source has no stored credential", async () => {
    await expect(listPostHogItems({ ...source, encryptedTokens: null })).rejects.toThrow(
      /missing its stored credential/i,
    );
    expect(vi.mocked(fetchInsightSnapshot)).not.toHaveBeenCalled();
  });

  it("throws instead of calling PostHog when the source has no project id in meta", async () => {
    await expect(listPostHogItems({ ...source, meta: {} })).rejects.toThrow(/missing its project id/i);
    expect(vi.mocked(fetchInsightSnapshot)).not.toHaveBeenCalled();
  });

  it("throws when the decrypted payload has no apiKey (a corrupt or mis-sealed blob), rather than calling PostHog with undefined", async () => {
    vi.mocked(unsealSecret).mockReturnValue({});
    await expect(listPostHogItems(source)).rejects.toThrow(/missing an api key/i);
    expect(vi.mocked(fetchInsightSnapshot)).not.toHaveBeenCalled();
  });
});

// The block above only exercises the pure buildConnectorIngestInput helper
// with a hand-built `source` object; it never touches the REAL DB-level tenant
// guard (`load-source`'s findFirstOrThrow). loadScopedSource is that guard,
// pulled out so it's directly testable: reverting its where clause to
// `{ id: sourceId }` turns "refuses a caller from another org" red.
describe("loadScopedSource — real tenant guard on connector sync", () => {
  const rows = [
    { id: "src_1", orgId: "org_A", type: "slack", name: "#eng-a" },
    { id: "src_1", orgId: "org_B", type: "slack", name: "#eng-b" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    // Models Prisma's real findFirstOrThrow: filters by EVERY key in `where`
    // and throws when nothing matches — so if the source code stops passing
    // orgId, a same-id row from a DIFFERENT org would wrongly satisfy it.
    vi.mocked(db.source.findFirstOrThrow).mockImplementation((async (args: unknown) => {
      const where = (args as { where: Record<string, string> }).where;
      const match = rows.find((r) => Object.entries(where).every(([k, v]) => (r as never)[k] === v));
      if (!match)
        throw new Error(
          "An operation failed because it depends on one or more records that were required but not found.",
        );
      return match;
    }) as never);
  });

  it("loads the source when the caller's org actually owns it", async () => {
    const source = await loadScopedSource("src_1", "org_A");
    expect(source.orgId).toBe("org_A");
    expect(source.name).toBe("#eng-a");
  });

  it("refuses a caller from a DIFFERENT org for the same sourceId (the real cross-tenant guard)", async () => {
    await expect(loadScopedSource("src_1", "org_C")).rejects.toThrow();
  });

  it("passes orgId as part of the where clause (not filtered client-side after the fact)", async () => {
    await loadScopedSource("src_1", "org_B");
    expect(db.source.findFirstOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "src_1", orgId: "org_B" },
      }),
    );
  });
});

// A re-sync that only compares a FRESH item against its own prior SourceFile
// row (skip if checksum matches, else re-ingest) never notices an item vanish
// from the upstream listing, so a deleted message/comment's episode lives
// forever, and an edited one gets a second, contradicting episode next to the
// still-live original. planConnectorSync is the pulled-out decision logic that
// closes both gaps; these are guard-removal-style differentials against it.
describe("planConnectorSync — retirement + re-ingest decisions", () => {
  it("a brand-new item (no prior record) needs ingest with nothing to retire", () => {
    const plan = planConnectorSync([], [{ id: "m1", checksum: "c1" }], "org_1.general");
    expect(plan.toIngest).toEqual([{ item: { id: "m1", checksum: "c1" }, previousEpisode: null }]);
    expect(plan.toRetire).toEqual([]);
    expect(plan.skippedCount).toBe(0);
  });

  it("an unchanged item (same checksum) is skipped, not re-ingested", () => {
    const existing = [{ externalFileId: "m1", checksum: "c1", episodeId: "ep-1", episodeScopePath: "org_1.general" }];
    const plan = planConnectorSync(existing, [{ id: "m1", checksum: "c1" }], "org_1.general");
    expect(plan.toIngest).toEqual([]);
    expect(plan.toRetire).toEqual([]);
    expect(plan.skippedCount).toBe(1);
  });

  it("an unchanged item recorded at another scope is re-ingested here, retiring the episode there", () => {
    // A sync a reconnect moved off org_1.old wrote this item there after the
    // reconnect's purge. Skipping it would leave the new scope without it.
    const existing = [{ externalFileId: "m1", checksum: "c1", episodeId: "ep-old", episodeScopePath: "org_1.old" }];
    const plan = planConnectorSync(existing, [{ id: "m1", checksum: "c1" }], "org_1.general");
    expect(plan.toIngest).toEqual([
      { item: { id: "m1", checksum: "c1" }, previousEpisode: { episodeId: "ep-old", scopePath: "org_1.old" } },
    ]);
    expect(plan.skippedCount).toBe(0);
  });

  it("an unchanged item whose record predates episode scopes is still skipped", () => {
    const existing = [{ externalFileId: "m1", checksum: "c1", episodeId: "ep-1", episodeScopePath: null }];
    const plan = planConnectorSync(existing, [{ id: "m1", checksum: "c1" }], "org_1.general");
    expect(plan.skippedCount).toBe(1);
  });

  it("an EDITED item (checksum changed) needs ingest AND carries the old episode, with the group it was written to", () => {
    const existing = [{ externalFileId: "m1", checksum: "c1_old", episodeId: "ep-old", episodeScopePath: "org_1.old" }];
    const plan = planConnectorSync(existing, [{ id: "m1", checksum: "c2_new" }], "org_1.general");
    expect(plan.toIngest).toEqual([
      {
        item: { id: "m1", checksum: "c2_new" },
        previousEpisode: { episodeId: "ep-old", scopePath: "org_1.old" },
      },
    ]);
    expect(plan.toRetire).toEqual([]);
  });

  it("a VANISHED item (was synced, no longer in the fresh listing) is retired, not left live forever", () => {
    const existing = [{ externalFileId: "m1", checksum: "c1", episodeId: "ep-1", episodeScopePath: "org_1.general" }];
    const plan = planConnectorSync(existing, [], "org_1.general"); // upstream now returns nothing (deleted)
    expect(plan.toIngest).toEqual([]);
    expect(plan.toRetire).toEqual([
      { externalFileId: "m1", checksum: "c1", episodeId: "ep-1", episodeScopePath: "org_1.general" },
    ]);
  });

  it("guard-removal differential: an edit never produces BOTH a stale-live retirable AND a duplicate ingest at once", () => {
    // Re-ingesting an edited item with no retirement step leaves the OLD
    // episode neither in toRetire (the item didn't vanish, it's still present)
    // nor retired before the new ingest — it silently keeps existing. So the
    // edited item's old episode must appear as `previousEpisode` on the
    // toIngest entry (so the caller retires it before re-ingesting), and must
    // NOT also appear in toRetire (it isn't a vanished item).
    const existing = [
      { externalFileId: "m1", checksum: "c1_old", episodeId: "ep-old", episodeScopePath: "org_1.general" },
    ];
    const plan = planConnectorSync(existing, [{ id: "m1", checksum: "c2_new" }], "org_1.general");
    expect(plan.toIngest[0].previousEpisode?.episodeId).toBe("ep-old");
    expect(plan.toRetire.find((f) => f.episodeId === "ep-old")).toBeUndefined();
  });

  it("mixed batch: new + edited + unchanged + vanished are all classified independently in one pass", () => {
    const existing = [
      { externalFileId: "unchanged", checksum: "same", episodeId: "ep-u", episodeScopePath: "org_1.general" },
      { externalFileId: "edited", checksum: "old", episodeId: "ep-e", episodeScopePath: "org_1.general" },
      { externalFileId: "gone", checksum: "c", episodeId: "ep-g", episodeScopePath: "org_1.general" },
    ];
    const fresh = [
      { id: "unchanged", checksum: "same" },
      { id: "edited", checksum: "new" },
      { id: "brand_new", checksum: "c0" },
    ];
    const plan = planConnectorSync(existing, fresh, "org_1.general");
    expect(plan.toIngest.map((p) => p.item.id).sort()).toEqual(["brand_new", "edited"]);
    expect(plan.toRetire.map((f) => f.externalFileId)).toEqual(["gone"]);
    expect(plan.skippedCount).toBe(1);
  });

  it("an item with no prior captured episode id (a past failed sync) has nothing to retire, even if its checksum changed", () => {
    const existing = [{ externalFileId: "m1", checksum: "c1_old", episodeId: null, episodeScopePath: null }];
    const plan = planConnectorSync(existing, [{ id: "m1", checksum: "c2_new" }], "org_1.general");
    expect(plan.toIngest[0].previousEpisode).toBeNull();
  });
});

const syncSource = {
  id: "src_1",
  orgId: "org_1",
  type: "slack",
  name: "#general",
  scopePath: "org_1.general",
  connectAuthorizationId: "al_connect_1",
};

// syncOneTextItem is process-item's step body pulled out of its step.run
// closure so it's directly testable and so a retirement failure never gets
// silently swallowed alongside a false "synced" report.
describe("syncOneTextItem — retire-then-ingest for one item", () => {
  beforeEach(() => vi.clearAllMocks());

  it("a brand-new item (no previous episode) ingests and upserts without ever calling removeEpisode", async () => {
    vi.mocked(memory.ingest).mockResolvedValue({ episodeId: "ep-new" } as never);
    const outcome = await syncOneTextItem(syncSource, { id: "m1", text: "hello", checksum: "c1" }, null);
    expect(outcome).toBe("synced");
    expect(graphitiStore.removeEpisode).not.toHaveBeenCalled();
    expect(db.sourceFile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          sourceId: "src_1",
          externalFileId: "m1",
          checksum: "c1",
          episodeId: "ep-new",
          episodeScopePath: "org_1.general",
        }),
      }),
    );
  });

  it("an edited item retires the stale episode BEFORE ingesting the correction", async () => {
    const calls: string[] = [];
    vi.mocked(graphitiStore.removeEpisode).mockImplementation(async () => {
      calls.push("remove");
      return { removed: true };
    });
    vi.mocked(memory.ingest).mockImplementation(async () => {
      calls.push("ingest");
      return { episodeId: "ep-2" } as never;
    });
    const outcome = await syncOneTextItem(
      syncSource,
      { id: "m1", text: "corrected", checksum: "c2" },
      { episodeId: "ep-old", scopePath: "org_1.general" },
    );
    expect(outcome).toBe("synced");
    expect(calls).toEqual(["remove", "ingest"]);
    expect(graphitiStore.removeEpisode).toHaveBeenCalledWith({ groupId: "org_1.general", episodeId: "ep-old" });
    expect(db.factEdge.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ fromId: "ep-2", toId: "ep-old", kind: "supersedes", scopePath: "org_1.general" }),
      ],
      skipDuplicates: true,
    });
  });

  it("a genuine retirement failure is reported failed, not synced — and the ingest never runs", async () => {
    vi.mocked(graphitiStore.removeEpisode).mockRejectedValue(new Error("memory service removeEpisode failed: 500"));
    const outcome = await syncOneTextItem(
      syncSource,
      { id: "m1", text: "corrected", checksum: "c2" },
      { episodeId: "ep-old", scopePath: "org_1.general" },
    );
    expect(outcome).toBe("failed");
    // The old code's `.catch(() => {})` around removeEpisode meant the ingest
    // below always still ran on a swallowed retirement failure — proving it
    // does NOT run here is what actually closes the "reports success while
    // stale content lives on" gap, not just the return value.
    expect(memory.ingest).not.toHaveBeenCalled();
    expect(db.sourceFile.upsert).not.toHaveBeenCalled();
  });

  it("a plain ingest failure (not retirement) is also reported failed, not synced", async () => {
    vi.mocked(memory.ingest).mockRejectedValue(new Error("llm timeout"));
    const outcome = await syncOneTextItem(syncSource, { id: "m1", text: "x", checksum: "c1" }, null);
    expect(outcome).toBe("failed");
    expect(db.sourceFile.upsert).not.toHaveBeenCalled();
  });
});

describe("retireVanishedTextItem — retiring an item that vanished upstream", () => {
  beforeEach(() => vi.clearAllMocks());

  it("removes the episode then deletes the SourceFile row", async () => {
    vi.mocked(graphitiStore.removeEpisode).mockResolvedValue({ removed: true } as never);
    const outcome = await retireVanishedTextItem(
      {
        id: "src_1",
        orgId: "org_1",
        type: "slack",
        scopePath: "org_1.general",
        connectAuthorizationId: "al_connect_1",
      },
      {
        externalFileId: "m1",
        checksum: "c1",
        episodeId: "ep-1",
        episodeScopePath: "org_1.general",
      },
    );
    expect(outcome).toBe("retired");
    expect(graphitiStore.removeEpisode).toHaveBeenCalledWith({ groupId: "org_1.general", episodeId: "ep-1" });
    expect(db.sourceFile.delete).toHaveBeenCalledWith({
      where: { sourceId_externalFileId: { sourceId: "src_1", externalFileId: "m1" } },
    });
  });

  it("a genuine removeEpisode failure is reported failed and leaves the SourceFile row in place for the next sync to retry", async () => {
    vi.mocked(graphitiStore.removeEpisode).mockRejectedValue(new Error("memory service removeEpisode failed: 500"));
    const outcome = await retireVanishedTextItem(
      {
        id: "src_1",
        orgId: "org_1",
        type: "slack",
        scopePath: "org_1.general",
        connectAuthorizationId: "al_connect_1",
      },
      {
        externalFileId: "m1",
        checksum: "c1",
        episodeId: "ep-1",
        episodeScopePath: "org_1.general",
      },
    );
    expect(outcome).toBe("failed");
    expect(db.sourceFile.delete).not.toHaveBeenCalled();
  });

  it("an item with no captured episode id just deletes the row (nothing to retire in the graph)", async () => {
    const outcome = await retireVanishedTextItem(
      {
        id: "src_1",
        orgId: "org_1",
        type: "slack",
        scopePath: "org_1.general",
        connectAuthorizationId: "al_connect_1",
      },
      {
        externalFileId: "m1",
        checksum: "c1",
        episodeId: null,
        episodeScopePath: null,
      },
    );
    expect(outcome).toBe("retired");
    expect(graphitiStore.removeEpisode).not.toHaveBeenCalled();
    expect(db.sourceFile.delete).toHaveBeenCalled();
  });
});

// "On Inngest replay a fully-failed sync reports status active with failed 0"
// is what closure-mutated counters (not durable across replay) produce;
// AGGREGATING FROM RETURNED STEP OUTPUTS (durable across replay) does not.
// These tests pin the aggregation itself; syncOneTextItem/retireVanishedTextItem's
// own tests above pin that each item's outcome is a real return value.
describe("summarizeSyncOutcomes — durable aggregation from step outputs", () => {
  it("a fully-failed batch reports the real failed count, not 0", () => {
    const outcomes: ConnectorSyncOutcome[] = ["failed", "failed", "failed"];
    expect(summarizeSyncOutcomes(outcomes)).toEqual({ synced: 0, failed: 3 });
  });

  it("a mixed batch counts synced and failed independently; retired successes count toward neither", () => {
    const outcomes: ConnectorSyncOutcome[] = ["synced", "synced", "failed", "retired", "retired"];
    expect(summarizeSyncOutcomes(outcomes)).toEqual({ synced: 2, failed: 1 });
  });

  it("an empty batch (nothing changed upstream) reports zero for both", () => {
    expect(summarizeSyncOutcomes([])).toEqual({ synced: 0, failed: 0 });
  });
});

describe("sourceSyncStatus — terminal Source.status resolution", () => {
  it("all failed, nothing synced -> error", () => {
    expect(sourceSyncStatus({ synced: 0, failed: 3 })).toBe("error");
  });

  it("some synced despite some failures -> active (partial progress isn't a hard failure)", () => {
    expect(sourceSyncStatus({ synced: 1, failed: 2 })).toBe("active");
  });

  it("nothing failed -> active", () => {
    expect(sourceSyncStatus({ synced: 5, failed: 0 })).toBe("active");
  });

  it("fatal=true always resolves to error, even with zero recorded failures, so an uncaught exception never leaves a source stuck at 'syncing'", () => {
    expect(sourceSyncStatus({ synced: 0, failed: 0 }, true)).toBe("error");
  });
});

// `processDriveFile` stamps `sourceId` on every Drive ingest, the same marker
// `buildConnectorIngestInput` (Slack/Figma) has its own case for above.
//
// The marker is the ONLY discriminator `DELETE /api/sources/:id` has; there is
// no scope-exclusivity fallback. An unstamped ingest path is not "retired a
// bit less precisely": its content is never retired at all, silently, and
// revoked/deleted content must become unavailable to retrieval. This test
// fails with the stamping line removed.
describe("processDriveFile — per-source provenance marker", () => {
  const source = {
    id: "src_drive",
    orgId: "org_1",
    name: "Eng Drive",
    scopePath: "org_1.engineering",
    connectAuthorizationId: "al_connect_drive",
  };
  const file = {
    id: "file_1",
    name: "spec.pdf",
    mimeType: "application/pdf",
    checksum: "abc123",
    contentVersion: "abc123",
    fileType: "pdf" as const,
  };

  beforeEach(() => {
    vi.mocked(db.sourceFile.findUnique).mockResolvedValue(null as never);
    vi.mocked(db.sourceFile.upsert).mockResolvedValue({} as never);
    // Still connected at its scope when each write re-checks it.
    vi.mocked(db.source.findFirst).mockResolvedValue({ scopePath: source.scopePath, status: "active" } as never);
  });

  it("stamps the source's own id onto every chunk it ingests, so a disconnect can retire Drive-synced content", async () => {
    vi.mocked(graphitiStore.extractFile).mockResolvedValue({ chunks: ["page one", "page two"] });
    vi.mocked(graphitiStore.ingestBulk).mockResolvedValue(["ep_1", "ep_2"]);
    vi.mocked(pgvectorStore.ingest).mockResolvedValue({ episodeId: "chunk_1" });
    const deps = {
      downloadFile: vi.fn().mockResolvedValue(new Blob(["pdf-bytes"])),
      put: vi.fn().mockResolvedValue({ url: "https://blob.example/spec.pdf" }),
      del: vi.fn().mockResolvedValue(undefined),
    };

    const outcome = await processDriveFile(source, file, "tok", deps);

    expect(outcome).toBe("synced");
    const written = [
      ...vi.mocked(graphitiStore.ingestBulk).mock.calls[0][0],
      ...vi.mocked(pgvectorStore.ingest).mock.calls.map(([input]) => input),
    ];
    expect(written).toHaveLength(4);
    for (const input of written) {
      // The assertion this file was missing entirely.
      expect(input.sourceId).toBe("src_drive");
      // Pinned alongside it: the scope tag the purge's other half keys on, so a
      // regression that drops either one is caught here rather than at a
      // customer's disconnect.
      expect(input.scopePath).toBe("org_1.engineering");
    }
  });

  const deps = () => ({
    downloadFile: vi.fn().mockResolvedValue(new Blob(["pdf-bytes"])),
    put: vi.fn().mockResolvedValue({ url: "https://blob.example/spec.pdf" }),
    del: vi.fn().mockResolvedValue(undefined),
  });
  const recorded = (episodeScopePath: string) =>
    ({ checksum: file.checksum, episodeId: null, episodeIds: [], chunkIds: [], episodeScopePath }) as never;

  it("skips an unchanged file recorded at the source's own scope", async () => {
    vi.mocked(db.sourceFile.findUnique).mockResolvedValue(recorded(source.scopePath));
    const d = deps();

    expect(await processDriveFile(source, file, "tok", d)).toBe("skipped");
    expect(d.downloadFile).not.toHaveBeenCalled();
  });

  it("writes an unchanged file again when its record is pinned to a scope the source left", async () => {
    // A sync a reconnect moved off org_1.old wrote it there after the purge.
    vi.mocked(db.sourceFile.findUnique).mockResolvedValue(recorded("org_1.old"));
    vi.mocked(graphitiStore.extractFile).mockResolvedValue({ chunks: ["page one"] });
    vi.mocked(graphitiStore.ingestBulk).mockResolvedValue(["ep_1"]);
    vi.mocked(pgvectorStore.ingest).mockResolvedValue({ episodeId: "chunk_1" });
    const d = deps();

    expect(await processDriveFile(source, file, "tok", d)).toBe("synced");
    expect(d.downloadFile).toHaveBeenCalledTimes(1);
  });
});
