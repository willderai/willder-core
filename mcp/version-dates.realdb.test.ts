// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test here is skipped, not failed.
//
// The read paths that serve an older version date it, from the rows themselves:
// - memory_version names when the version it reads was superseded and the date of each version
//   its lineage names (services/memory/versions.ts lineageDatedAt, mcp/tools/memory-version.ts);
// - the task-start read dates when a served write's version was replaced, by its replacement's
//   own date, else the edge's, with the same predicates as the winner it names
//   (services/memory/task-start.ts replacementDatedAt).
// - A replacement that reads as erased is neither named nor dated anywhere: not on
//   memory_version, not on the task-start read, not on the change feed or memory_changes.
// No date is served for a version the caller may not read: a hidden version is "not found".
//
// Real: Postgres, check() against live capabilities, the MCP tool handlers. Doubles: the graph
// store and the embedding call, which these reads never use.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";

vi.mock("@/services/memory/store", () => ({
  memory: { ingest: vi.fn(), retrieve: vi.fn(), entity: vi.fn() },
  graphitiStore: { ingest: vi.fn(), ingestBulk: vi.fn() },
}));
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "versiondates";
const OTHER_ORG = "versiondatesother";
const ROOT = `org_${ORG}`;
const SCOPE = `${ROOT}.eng`;
const SIBLING = `${ROOT}.sales`;
const TASK = "database migration";

type ToolReply = { content: { type: "text"; text: string }[]; isError?: boolean };
type Tools = Map<string, (args: Record<string, unknown>) => Promise<ToolReply>>;

describe.skipIf(!QA_URL)("older versions are served with their dates", () => {
  let db: PrismaClient;
  let registerWillderTools: (typeof import("@/mcp/tools"))["registerWillderTools"];
  let readTaskStartUnchecked: (typeof import("@/services/memory/task-start"))["readTaskStartUnchecked"];

  async function toolsFor(agentId: string, scopePath: string): Promise<Tools> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath,
        permission: "read",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const ctx: AccessContext = {
      orgId: ORG,
      actor: { type: "agent", id: agentId, capabilityToken: token },
      origin: "mcp",
    };
    const tools: Tools = new Map();
    const server = {
      registerTool: (name: string, _c: unknown, handler: (args: Record<string, unknown>) => Promise<ToolReply>) =>
        tools.set(name, handler),
    };
    registerWillderTools(server as never, ctx, { orgId: ORG, agentId, scopePath });
    return tools;
  }
  const textOf = (reply: ToolReply) => reply.content.map((block) => block.text).join("\n");
  const chunk = (id: string, content: string, createdAt: string, occurredAt: string | null = null) =>
    db.memoryChunk.create({
      data: {
        id,
        orgId: ORG,
        content,
        entityName: "Database",
        scopePath: SCOPE,
        actorId: "writer",
        actorType: "agent",
        createdAt: new Date(createdAt),
        occurredAt: occurredAt ? new Date(occurredAt) : null,
      },
    });
  const edge = (fromId: string, toId: string, createdAt: string, extra: Record<string, unknown> = {}) =>
    db.factEdge.create({
      data: {
        orgId: ORG,
        fromId,
        toId,
        kind: "supersedes",
        scopePath: SCOPE,
        actorType: "agent",
        actorId: "writer",
        createdAt: new Date(createdAt),
        ...extra,
      } as never,
    });

  async function cleanup(): Promise<void> {
    await db.factEdge.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    await db.changeEvent.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    await deleteOrgsWithRetry(db, { where: { id: { in: [ORG, OTHER_ORG] } } });
  }

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ registerWillderTools } = await import("@/mcp/tools"));
    ({ readTaskStartUnchecked } = await import("@/services/memory/task-start"));
    await cleanup();
    for (const id of [ORG, OTHER_ORG]) await db.org.create({ data: { id, name: id } });
    await chunk("vd-v1", "We use Postgres.", "2026-01-05T08:00:00Z");
    await chunk("vd-v2", "We use MySQL.", "2026-03-01T09:00:00Z", "2026-02-20T00:00:00Z");
    await chunk("vd-v3", "We use SQLite.", "2026-06-01T10:00:00Z");
    await edge("vd-v2", "vd-v1", "2026-03-01T09:00:00Z");
    await edge("vd-v3", "vd-v2", "2026-06-01T10:00:00Z");
  });

  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  it("memory_version dates the replacement, the replaced version and the version's own stated date", async () => {
    const reader = await toolsFor("vd-reader", SCOPE);
    const text = textOf(await reader.get("memory_version")!({ versionId: "vd-v2" }));
    expect(text).toContain("fact vd-v2 (superseded)\n");
    expect(text).toContain("written by writer at 2026-03-01T09:00:00.000Z, as of 2026-02-20\n");
    expect(text).toContain("superseded by: vd-v3 (as of 2026-06-01)\n");
    expect(text).toContain("supersedes: vd-v1 (as of 2026-01-05)\n");
    // The oldest version: superseded on the day its replacement was written, and stated as such.
    const oldest = textOf(await reader.get("memory_version")!({ versionId: "vd-v1" }));
    expect(oldest).toContain("superseded by: vd-v2 (as of 2026-02-20), recorded 2026-03-01\n");
  });

  it("dates nothing for a reader who may not read the version's scope", async () => {
    const outsider = await toolsFor("vd-outsider", SIBLING);
    expect(textOf(await outsider.get("memory_version")!({ versionId: "vd-v2" }))).toBe("Version not found.");
  });

  it("the task-start read dates when a served write's version was replaced, by the first edge of this org and kind", async () => {
    const at = (s: number) => new Date(Date.UTC(2026, 9, 1) + s * 1000);
    const events = ["vd-w1", "vd-w2", "vd-w3", "vd-w4"].map((recordId, i) => ({
      orgId: ORG,
      seq: BigInt(9_000_000 + i),
      scopePath: SCOPE,
      recordType: "fact",
      recordId,
      op: "create" as const,
      actorId: "writer",
      summary: `${TASK} ${recordId}`,
      createdAt: at(i),
    }));
    await db.changeEvent.createMany({ data: events });
    await edge("vd-w1-late", "vd-w1", "2026-10-05T00:00:00Z");
    await edge("vd-w1-early", "vd-w1", "2026-10-03T00:00:00Z");
    await edge("vd-w2-other", "vd-w2", "2026-10-02T00:00:00Z", { orgId: OTHER_ORG });
    await edge("vd-w3-dep", "vd-w3", "2026-10-02T00:00:00Z", { kind: "dependsOn" });
    // A replacement imported with its stated date is dated by it, not by the day it was recorded.
    await chunk("vd-w4-next", "We use SQLite.", "2026-10-20T00:00:00Z", "2024-12-12T00:00:00Z");
    await edge("vd-w4-next", "vd-w4", "2026-10-20T00:00:00Z");
    const read = await readTaskStartUnchecked(
      { orgId: ORG, actor: { type: "agent", id: "vd-qa" }, origin: "mcp" } as AccessContext,
      SCOPE,
      TASK,
    );
    expect(read.winners.get("vd-w1")).toBe("vd-w1-early");
    expect(read.replacementDatedAt?.get("vd-w1")).toBe("2026-10-03T00:00:00.000Z");
    expect(read.replacementDatedAt?.has("vd-w2")).toBe(false);
    expect(read.replacementDatedAt?.has("vd-w3")).toBe(false);
    expect(read.replacementDatedAt?.get("vd-w4")).toBe("2024-12-12T00:00:00.000Z");
  });

  describe("a replacement that reads as erased", () => {
    const at = (s: number) => new Date(Date.UTC(2026, 9, 2) + s * 1000);
    beforeAll(async () => {
      const { versionIdEntry } = await import("@/services/memory/erasure-suppression");
      await db.changeEvent.create({
        data: {
          orgId: ORG,
          seq: BigInt(9_000_100),
          scopePath: SCOPE,
          recordType: "fact",
          recordId: "vd-w5",
          op: "create",
          actorId: "writer",
          summary: `${TASK} vd-w5`,
          createdAt: at(0),
        },
      });
      await chunk("vd-w5-next", "We use DuckDB.", "2026-10-03T00:00:00Z", "2025-07-07T00:00:00Z");
      await edge("vd-w5-next", "vd-w5", "2026-10-03T00:00:00Z");
      // An erasure that removed the replacement's id, recorded after it was written.
      // Listed and marked applied the way an erasure lists its own entries (app.erasure_listing), so
      // the org is not taken for a restore whose erasures are still due, which refuses every read.
      const entry = versionIdEntry(ORG, "vd-w5-next");
      await db.$transaction([
        db.$executeRaw`SELECT set_config('app.erasure_listing', 'on', true)`,
        db.erasureSuppression.create({
          data: { orgId: ORG, ...entry, requestId: "vd-erasure", createdAt: new Date("2026-10-04T00:00:00Z") },
        }),
        db.erasureSuppressionApplied.create({ data: { orgId: ORG, ...entry, by: "vd-qa" } }),
      ]);
    });

    it("the task-start read still marks the write superseded, naming and dating no replacement", async () => {
      const { markWritesAgainst } = await import("@/services/memory/superseded-facts");
      const read = await readTaskStartUnchecked(
        { orgId: ORG, actor: { type: "agent", id: "vd-qa" }, origin: "mcp" } as AccessContext,
        SCOPE,
        TASK,
      );
      expect(read.winners.has("vd-w5")).toBe(true);
      expect(read.winners.get("vd-w5")).toBeNull();
      expect(read.replacementDatedAt?.has("vd-w5")).toBe(false);
      // A replacement not erased is still named and dated.
      expect(read.winners.get("vd-w4")).toBe("vd-w4-next");
      const marked = markWritesAgainst(read.context.writes, read.winners, read.replacementDatedAt).find(
        (w) => w.recordId === "vd-w5",
      )!;
      expect(marked).toMatchObject({
        supersededById: null,
        supersededUnnamed: true,
        summary: `[superseded] ${TASK} vd-w5`,
      });
      expect(JSON.stringify(marked)).not.toMatch(/vd-w5-next|2025-07-07/);
    });

    it("the change feed and memory_changes mark the write superseded without naming the replacement", async () => {
      const { markSupersededWrites } = await import("@/services/memory/superseded-facts");
      const [feed] = await markSupersededWrites(ORG, [
        { recordType: "fact", recordId: "vd-w5", op: "create", summary: `${TASK} vd-w5` },
      ]);
      expect(feed).toMatchObject({
        supersededById: null,
        supersededUnnamed: true,
        summary: `[superseded] ${TASK} vd-w5`,
      });
      const [kept] = await markSupersededWrites(ORG, [
        { recordType: "fact", recordId: "vd-w4", op: "create", summary: "x" },
      ]);
      expect(kept).toMatchObject({ supersededById: "vd-w4-next", summary: "[superseded by vd-w4-next] x" });

      const reader = await toolsFor("vd-feed-reader", SCOPE);
      const text = textOf(await reader.get("memory_changes")!({ limit: 50 }));
      expect(text).toMatch(
        new RegExp(`^create fact vd-w5 by writer: \\[superseded\\] ${TASK} vd-w5 · 2026-10-02$`, "m"),
      );
      expect(text).not.toContain("vd-w5-next");
    });
  });
});
