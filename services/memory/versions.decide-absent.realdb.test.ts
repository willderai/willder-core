// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test here is skipped, not failed.
//
// memory_version answers a version the caller may not read, an id that was never issued and
// an id from another org the same way, and each costs exactly one memory.read deny row.
// The never-issued and other-org ids are decided at the caller's own org root, so the row
// names neither the other org nor a scope that holds anything.
//
// Real: Postgres, ingest, check() against live capabilities, the audit insert trigger, the MCP
// tool handlers. Doubles: the embedding service and the graph store, which this read never uses.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";

vi.mock("@/services/memory/store", () => ({
  memory: {
    ingest: vi.fn().mockResolvedValue({ episodeId: "ep-hybrid" }),
    retrieve: vi.fn(),
    entity: vi.fn(),
  },
  graphitiStore: { ingest: vi.fn().mockResolvedValue({ episodeId: "ep-graph" }), ingestBulk: vi.fn() },
}));
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "versionsabsent";
const ROOT = `org_${ORG}`;
const OWN = `${ROOT}.own`;
const SIBLING = `${ROOT}.sibling`;
const OTHER_ORG = "versionsabsentother";
const OTHER_ROOT = `org_${OTHER_ORG}`;
const OTHER_SCOPE = `${OTHER_ROOT}.dept`;
const DIMENSIONS = 384;

type ToolReply = { content: { type: "text"; text: string }[]; isError?: boolean };
type Tools = Map<string, (args: Record<string, unknown>) => Promise<ToolReply>>;

describe.skipIf(!QA_URL)(
  "memory_version: hidden, never-issued and other-org ids are one answer and one deny row",
  () => {
    let db: PrismaClient;
    let registerWillderTools: (typeof import("@/mcp/tools"))["registerWillderTools"];

    async function toolsFor(
      orgId: string,
      agentId: string,
      scopePath: string,
      permission: "read" | "write",
    ): Promise<Tools> {
      const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
      await db.capability.create({
        data: {
          orgId,
          agentId,
          tokenHash: hashCapabilityToken(token),
          scopePath,
          permission,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
      const ctx: AccessContext = {
        orgId,
        actor: { type: "agent", id: agentId, capabilityToken: token },
        origin: "mcp",
      };
      const tools: Tools = new Map();
      const server = {
        registerTool: (name: string, _c: unknown, handler: (args: Record<string, unknown>) => Promise<ToolReply>) =>
          tools.set(name, handler),
      };
      registerWillderTools(server as never, ctx, { orgId, agentId, scopePath });
      return tools;
    }
    const textOf = (reply: ToolReply) => reply.content.map((block) => block.text).join("\n");
    const versionIn = (reply: ToolReply) => /Version: (\S+?)\./.exec(textOf(reply))?.[1];
    async function seed(orgId: string, scopePath: string, content: string): Promise<string> {
      const writer = await toolsFor(orgId, `writer-${scopePath}`, scopePath, "write");
      const id = versionIn(await writer.get("memory_ingest")!({ name: "Renewal owner", content, scopePath }));
      expect(id).toBeDefined();
      return id!;
    }
    const readerRows = (orgId: string) =>
      db.auditLog.findMany({ where: { orgId, actorId: "reader", action: "memory.read" }, orderBy: { at: "asc" } });

    beforeAll(async () => {
      if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
      process.env.DATABASE_URL = QA_URL;
      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ embedding: new Array(DIMENSIONS).fill(0.01) }))),
      );
      const inngestModule = await import("@/lib/inngest");
      vi.spyOn(inngestModule.inngest, "send").mockImplementation((async () => ({ ids: ["job"] })) as never);
      ({ registerWillderTools } = await import("@/mcp/tools"));
    });

    afterAll(async () => {
      vi.unstubAllGlobals();
      await db.org.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
      await db.$disconnect();
    });

    beforeEach(async () => {
      await db.org.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
      for (const [orgId, paths] of [
        [ORG, [ROOT, OWN, SIBLING]],
        [OTHER_ORG, [OTHER_ROOT, OTHER_SCOPE]],
      ] as const) {
        await db.org.create({ data: { id: orgId, name: orgId } });
        for (const path of paths) await db.scope.create({ data: { orgId, path, name: path } });
      }
    });

    it("serves its own version, and refuses the other three alike with one deny row each", async () => {
      const own = await seed(ORG, OWN, "Our team owns the renewal.");
      const sibling = await seed(ORG, SIBLING, "The sibling team owns the renewal.");
      const otherOrg = await seed(OTHER_ORG, OTHER_SCOPE, "The other org owns the renewal.");
      const reader = await toolsFor(ORG, "reader", OWN, "read");
      const ask = (versionId: string) => reader.get("memory_version")!({ versionId });

      expect(textOf(await ask(own))).toContain("Our team owns the renewal.");
      const before = (await readerRows(ORG)).length;

      const refusals: [string, string][] = [
        [sibling, SIBLING],
        ["never_issued_version_id", ROOT],
        [otherOrg, ROOT],
      ];
      for (const [versionId, decidedAt] of refusals) {
        const reply = await ask(versionId);
        expect(reply.isError).toBeFalsy();
        expect(textOf(reply)).toMatch(/^Version not found\./);
        expect(textOf(reply)).not.toContain("owns the renewal");
        const rows = (await readerRows(ORG)).slice(before);
        const last = rows.at(-1)!;
        expect(last.decision).toBe("deny");
        expect(last.target).toBe(decidedAt);
      }
      expect((await readerRows(ORG)).length - before).toBe(refusals.length);
      expect(await readerRows(OTHER_ORG)).toEqual([]);
    });

    // memory_version serves rules too, looked up after facts by their own query. A hidden rule
    // and another org's rule must answer exactly as an absent id does, reply for reply.
    it("serves its own rule, and refuses a hidden rule and another org's rule exactly as an absent id", async () => {
      const rule = (orgId: string, scopePath: string, text: string) =>
        db.convention.create({
          data: { orgId, scopePath, kind: "convention", subject: "Renewal owner", text, actorId: "writer" },
        });
      const own = await rule(ORG, OWN, "Our team owns the renewal.");
      const sibling = await rule(ORG, SIBLING, "The sibling team owns the renewal.");
      const otherOrg = await rule(OTHER_ORG, OTHER_SCOPE, "The other org owns the renewal.");
      const reader = await toolsFor(ORG, "reader", OWN, "read");
      const ask = (versionId: string) => reader.get("memory_version")!({ versionId });

      expect(textOf(await ask(own.id))).toContain("Our team owns the renewal.");
      const before = (await readerRows(ORG)).length;

      const absent = await ask("never_issued_version_id");
      const refusals: [string, string][] = [
        [sibling.id, SIBLING],
        [otherOrg.id, ROOT],
      ];
      for (const [versionId, decidedAt] of refusals) {
        expect(await ask(versionId)).toEqual(absent);
        const rows = (await readerRows(ORG)).slice(before);
        expect(rows.at(-1)!.decision).toBe("deny");
        expect(rows.at(-1)!.target).toBe(decidedAt);
      }
      expect(absent).toEqual({ content: [{ type: "text", text: "Version not found." }] });
      expect((await readerRows(ORG)).length - before).toBe(refusals.length + 1);
      expect(await readerRows(OTHER_ORG)).toEqual([]);
    });
  },
);
