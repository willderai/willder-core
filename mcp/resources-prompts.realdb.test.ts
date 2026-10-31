// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Willder's MCP resources (mcp/resources.ts) and prompts (mcp/prompts.ts) never serve memory
// the caller may not read. The rules under test:
//  - willder://version/{id} serves a version in the token's scope, and answers a version in a
//    sibling scope, in a scope an unescaped LIKE would match, in another org, erased, or never
//    written exactly alike;
//  - willder://brief serves the brief at the token's own scope, never another scope's or org's;
//  - willder://version and memory_version answer an erased rule like an unknown id;
//  - start_task serves only facts the token may read, refuses a scope outside the token, and
//    gives memory_query's note for a value no readable memory holds;
//  - the scopePath completion offers only scopes the token may read, compares `_` and `%`
//    literally, marks a cut list as having more, and offers nothing to a revoked token;
//  - a connection is listed the brief, start_task and Willder's tools, and no fixture.
//
// Real: the hosted MCP endpoint over a socket (mcp/http-test-server.ts), check() against live
// capability tokens, the version, brief and vector reads on Postgres. A stand-in memory
// service answers embeddings with one fixed vector and holds no graph facts.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
// Leaf modules, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import { EmptyGraphMemoryService } from "./memory-service-stub.testsupport";
import { NO_READABLE_MATCH_NOTE } from "./read-notes";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "mcpresourcesprompts";
const OTHER_ORG = "mcpresourcespromptsother";
const ROOT = `org_${ORG}`;
/** The reader's scope. Its underscore is a LIKE wildcard if left unescaped. */
const TEAM = `${ROOT}.team_a`;
const TEAM_CHILD = `${TEAM}.notes`;
/** A sibling whose path starts with the reader's: `team_a` is not `team_ab`. */
const PREFIX_SIBLING = `${ROOT}.team_ab`;
/** What an unescaped `team_a` LIKE pattern would also match. */
const WILDCARD_SIBLING = `${ROOT}.teamXa`;
const OTHER_ROOT = `org_${OTHER_ORG}`;
const OTHER_TEAM = `${OTHER_ROOT}.team_a`;

const VECTOR = `[${new Array(384).fill(0.01).join(",")}]`;

/** Every fact's text names the onboarding task, so the vector read would return any of them. */
const READABLE = "Onboarding: the deploy key lives in the team vault (readable).";
const HIDDEN: Record<string, [org: string, scope: string, text: string]> = {
  "a prefix sibling": [ORG, PREFIX_SIBLING, "Onboarding: the sibling's payroll export is on Fridays."],
  "a LIKE-wildcard sibling": [ORG, WILDCARD_SIBLING, "Onboarding: the wildcard sibling's salary bands."],
  "the org root above the token": [ORG, ROOT, "Onboarding: the board's acquisition plan."],
  "another org": [OTHER_ORG, OTHER_TEAM, "Onboarding: the other org's customer list."],
};
const ERASED = "Onboarding: Dana Whitfield's home phone.";

interface ResourceRead {
  contents: { uri: string; mimeType?: string; text?: string }[];
}

describe.skipIf(!QA_URL)("MCP resources and prompts, on a real read", { timeout: 30_000 }, () => {
  const service = new EmptyGraphMemoryService();
  let db: PrismaClient;
  let mcpUrl: string;
  let closeMcp: () => Promise<void>;
  let reader = "";
  let readableId = "";
  let erasedId = "";
  let erasedRuleId = "";
  const hiddenIds = new Map<string, string>();

  async function mint(orgId: string, agentId: string, scopePath: string): Promise<string> {
    const token = `wcap_test_${agentId}_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath,
        permission: "read",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return token;
  }

  async function connect(token: string, headers: Record<string, string> = {}): Promise<Client> {
    const client = new Client({ name: "willder-test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(mcpUrl), {
        requestInit: { headers: { Authorization: `Bearer ${token}`, ...headers } },
      }),
    );
    return client;
  }

  async function withClient<T>(run: (client: Client) => Promise<T>, token = reader): Promise<T> {
    const client = await connect(token);
    try {
      return await run(client);
    } finally {
      await client.close();
    }
  }

  async function insertFact(orgId: string, scopePath: string, content: string): Promise<string> {
    const id = `c-${Math.random().toString(36).slice(2)}`;
    await db.$executeRawUnsafe(
      `INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorName","scopePath","embedding","createdAt")
       VALUES ($1, $2, $3, 'text', 'agent', 'seed', $4, $5::vector, now())`,
      id,
      orgId,
      content,
      scopePath,
      VECTOR,
    );
    return id;
  }

  /** The error a read answers with, as the client sees it: code, message and data. */
  async function readError(uri: string): Promise<string> {
    return withClient(async (client) => {
      const error = await client.readResource({ uri }).then(
        () => null,
        (e: { code?: number; message?: string; data?: unknown }) => e,
      );
      expect(error, `${uri} was served`).not.toBeNull();
      return JSON.stringify({ code: error!.code, message: error!.message, data: error!.data });
    });
  }

  beforeAll(async () => {
    if (QA_URL === undefined) return;
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    process.env.GRAPHITI_SERVICE_URL = await service.start();
    process.env.GRAPHITI_SERVICE_API_KEY = "test-key";
    // The fixtures are served only to the agent this lists (mcp/conformance-fixtures.ts).
    vi.stubEnv("MCP_CONFORMANCE_AGENTS", `${ORG}/team-reader`);
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    const { startMcpTestServer } = await import("./http-test-server");
    const mcp = await startMcpTestServer();
    mcpUrl = mcp.url;
    closeMcp = mcp.close;

    await deleteOrgsWithRetry(db, { where: { id: { in: [ORG, OTHER_ORG] } } });
    for (const [orgId, paths] of [
      [ORG, [ROOT, TEAM, TEAM_CHILD, PREFIX_SIBLING, WILDCARD_SIBLING]],
      [OTHER_ORG, [OTHER_ROOT, OTHER_TEAM]],
    ] as const) {
      await db.org.create({ data: { id: orgId, name: orgId } });
      for (const path of paths) await db.scope.create({ data: { orgId, path, name: path.split(".").at(-1)! } });
    }
    reader = await mint(ORG, "team-reader", TEAM);
    readableId = await insertFact(ORG, TEAM, READABLE);
    for (const [label, [orgId, scope, text]] of Object.entries(HIDDEN))
      hiddenIds.set(label, await insertFact(orgId, scope, text));
    erasedId = await insertFact(ORG, TEAM, ERASED);
    // A rule an erasure redacted, as services/memory/erasure-rules.ts leaves one: text blanked,
    // retired, and its id on the suppression list.
    erasedRuleId = (
      await db.convention.create({
        data: {
          orgId: ORG,
          scopePath: TEAM,
          kind: "convention",
          subject: "",
          text: "",
          actorId: "agent-x",
          retiredAt: new Date(),
        },
      })
    ).id;
    const { recordErasedVersions, recordErasedRules, markApplied, listEntriesAsOf } = await import(
      "@/services/memory/erasure-suppression"
    );
    // In one transaction, as the erasure job lists them: a listing outside one reads as a
    // restore's copy-back and marks the org's erasures due for re-apply (20261019100000).
    await db.$transaction(async (tx) => {
      await recordErasedVersions(tx, ORG, "erasure-request-resources", [erasedId]);
      await recordErasedRules(tx, ORG, "erasure-request-resources", [erasedRuleId]);
    });
    await markApplied(db, ORG, "test", { entries: (await listEntriesAsOf(ORG)).entries });

    const brief = (orgId: string, scopePath: string, title: string) =>
      db.brief.create({
        data: {
          orgId,
          type: "handoff",
          scopePath,
          title,
          summary: `${title} summary`,
          sections: [{ heading: "Notes", content: `${title} notes` }],
        },
      });
    await brief(ORG, TEAM, "Team handoff");
    await brief(ORG, PREFIX_SIBLING, "Sibling handoff");
    await brief(ORG, ROOT, "Root handoff");
    await brief(OTHER_ORG, OTHER_TEAM, "Other org handoff");
  }, 120_000);

  afterAll(async () => {
    if (QA_URL === undefined) return;
    vi.unstubAllEnvs();
    await closeMcp?.();
    await service.stop();
    await deleteOrgsWithRetry(db, { where: { id: { in: [ORG, OTHER_ORG] } } });
    await db.$disconnect();
  });

  describe("willder://version/{versionId}", () => {
    it("serves a version in the token's scope, with its text and status", async () => {
      const read = (await withClient((client) =>
        client.readResource({ uri: `willder://version/${readableId}` }),
      )) as ResourceRead;
      expect(read.contents).toHaveLength(1);
      expect(read.contents[0]!.text).toContain(`fact ${readableId} (current)`);
      expect(read.contents[0]!.text).toContain(READABLE);
    });

    it("answers a version the token may not read, an erased fact or rule and an unknown id exactly alike", async () => {
      const answer = async (id: string) => (await readError(`willder://version/${id}`)).replaceAll(id, "<id>");
      const unknown = await answer("c-never-written");
      expect(unknown).toContain("Resource not found");
      for (const [label, id] of [
        ...hiddenIds,
        ["erased fact", erasedId] as const,
        ["erased rule", erasedRuleId] as const,
      ])
        expect(await answer(id), label).toBe(unknown);
    });

    // The memory_version tool reads through the same readMemoryVersion, so it answers the same.
    it.each([
      ["an erased rule", () => erasedRuleId],
      ["an erased fact", () => erasedId],
      ["an unknown id", () => "c-never-written"],
    ])("is matched by memory_version, which reports %s as not found", async (_, id) => {
      const result = await withClient((client) =>
        client.callTool({ name: "memory_version", arguments: { versionId: id() } }),
      );
      expect((result.content as { text: string }[])[0]!.text).toBe("Version not found.");
    });
  });

  describe("willder://brief", () => {
    it("serves the brief at the token's own scope and no other scope's or org's", async () => {
      const read = (await withClient((client) => client.readResource({ uri: "willder://brief" }))) as ResourceRead;
      const text = read.contents.map((c) => c.text).join("\n");
      expect(text).toContain("# Team handoff");
      for (const other of ["Sibling handoff", "Root handoff", "Other org handoff"]) expect(text).not.toContain(other);
    });

    it("says there is none for a token whose scope has no brief, rather than serving a nearby one", async () => {
      const childReader = await mint(ORG, "child-reader", TEAM_CHILD);
      const read = (await withClient(
        (client) => client.readResource({ uri: "willder://brief" }),
        childReader,
      )) as ResourceRead;
      expect(read.contents.map((c) => c.text)).toEqual(["No brief found for this scope."]);
    });
  });

  describe("start_task", () => {
    it("opens the task with the facts the token may read, and nothing hidden or erased", async () => {
      const prompt = await withClient((client) =>
        client.getPrompt({ name: "start_task", arguments: { task: "Onboarding a new teammate" } }),
      );
      const text = prompt.messages.map((m) => (m.content.type === "text" ? m.content.text : "")).join("\n");
      expect(text).toContain("I am starting this task: Onboarding a new teammate");
      expect(text).toContain(READABLE);
      for (const [, , hidden] of Object.values(HIDDEN)) expect(text).not.toContain(hidden);
      expect(text).not.toContain(ERASED);
      expect(text).not.toContain(NO_READABLE_MATCH_NOTE);
    });

    it("says so, as memory_query does, when the task names a value no readable memory holds", async () => {
      const prompt = await withClient((client) =>
        client.getPrompt({ name: "start_task", arguments: { task: "Onboarding: pay the $48,000 invoice" } }),
      );
      const text = prompt.messages.map((m) => (m.content.type === "text" ? m.content.text : "")).join("\n");
      expect(text).toContain(NO_READABLE_MATCH_NOTE);
      expect(text).not.toContain("48,000\n");
    });

    it.each([
      ["a prefix sibling", PREFIX_SIBLING],
      ["the org root above the token", ROOT],
      ["another org's scope", OTHER_TEAM],
    ])("refuses a scopePath in %s", async (_, scopePath) => {
      const error = await withClient((client) =>
        client.getPrompt({ name: "start_task", arguments: { task: "Onboarding a new teammate", scopePath } }).then(
          () => null,
          (e: Error) => e,
        ),
      );
      expect(error?.message).toMatch(/Access denied/);
      for (const [, , hidden] of Object.values(HIDDEN)) expect(error?.message).not.toContain(hidden);
    });
  });

  describe("start_task's scopePath completion", () => {
    const complete = (value: string, token = reader) =>
      withClient(
        async (client) =>
          (
            await client.complete({
              ref: { type: "ref/prompt", name: "start_task" },
              argument: { name: "scopePath", value },
            })
          ).completion.values,
        token,
      );

    it.each([
      ["the token's scope and its child, for the org prefix", ROOT, [TEAM, TEAM_CHILD]],
      ["the token's scope and its child, for its own path", TEAM, [TEAM, TEAM_CHILD]],
      ["no prefix sibling for a path one letter longer", `${TEAM}b`, []],
      ["`_` compared literally", `${ROOT}.team_`, [TEAM, TEAM_CHILD]],
      ["`%` compared literally", `${ROOT}.team%`, []],
      ["nothing in another org", OTHER_ROOT, []],
    ])("offers %s", async (_, value, expected) => {
      expect(await complete(value)).toEqual(expected);
    });

    it("marks a completion cut at the limit as having more", async () => {
      const many = `${ROOT}.many`;
      const manyReader = await mint(ORG, "many-reader", many);
      await db.scope.createMany({
        data: [many, ...Array.from({ length: 101 }, (_, i) => `${many}.s${String(i).padStart(3, "0")}`)].map(
          (path) => ({ orgId: ORG, path, name: path }),
        ),
      });
      const result = await withClient(
        (client) =>
          client.complete({
            ref: { type: "ref/prompt", name: "start_task" },
            argument: { name: "scopePath", value: many },
          }),
        manyReader,
      );
      expect(result.completion.values).toHaveLength(100);
      expect(result.completion.hasMore).toBe(true);
      const exact = await withClient(
        (client) =>
          client.complete({
            ref: { type: "ref/prompt", name: "start_task" },
            argument: { name: "scopePath", value: `${many}.s09` },
          }),
        manyReader,
      );
      expect(exact.completion.values).toEqual(Array.from({ length: 10 }, (_, i) => `${many}.s09${i}`));
      expect(exact.completion.hasMore).toBe(false);
    });

    it("offers nothing to a token that has been revoked since it connected", async () => {
      const revoked = await mint(ORG, "revoked-reader", TEAM);
      const cap = await db.capability.findFirstOrThrow({ where: { orgId: ORG, agentId: "revoked-reader" } });
      // A stdio server resolves its token once and serves it for the life of the process, so the
      // completion must decide again; the hosted route would refuse the token at the door.
      const { registerWillderPrompts } = await import("./prompts");
      const server = new McpServer({ name: "test", version: "0" });
      registerWillderPrompts(
        server,
        { orgId: ORG, actor: { type: "agent", id: "revoked-reader", capabilityToken: revoked }, origin: "mcp" },
        { orgId: ORG, agentId: "revoked-reader", scopePath: TEAM },
      );
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      const client = new Client({ name: "willder-test", version: "0.0.0" });
      await client.connect(clientSide);
      const ask = async () =>
        (
          await client.complete({
            ref: { type: "ref/prompt", name: "start_task" },
            argument: { name: "scopePath", value: ROOT },
          })
        ).completion.values;
      expect(await ask()).toEqual([TEAM, TEAM_CHILD]);
      await db.capability.update({ where: { id: cap.id }, data: { revokedAt: new Date() } });
      expect(await ask()).toEqual([]);
      await client.close();
    });
  });

  describe("what a connection is listed", () => {
    it("lists the brief, start_task and Willder's tools, no fixture, and no capability only the fixtures use", async () => {
      const client = await connect(reader);
      try {
        expect((await client.listResources()).resources.map((r) => r.uri)).toEqual(["willder://brief"]);
        expect((await client.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate)).toEqual([
          "willder://version/{versionId}",
        ]);
        expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual(["start_task"]);
        expect((await client.listTools()).tools.map((t) => t.name).filter((name) => name.startsWith("test_"))).toEqual(
          [],
        );
        const capabilities = client.getServerCapabilities();
        expect(capabilities?.logging).toBeUndefined();
        expect(capabilities?.resources?.subscribe).toBeUndefined();
        expect(capabilities?.completions).toEqual({});
      } finally {
        await client.close();
      }
    });

    it("adds the suite's fixtures only for a connection that asks for them", async () => {
      const client = await connect(reader, { "X-Willder-Conformance": "fixtures" });
      try {
        const tools = (await client.listTools()).tools.map((t) => t.name);
        expect(tools).toEqual(
          expect.arrayContaining(["memory_query", "test_image_content", "test_sampling", "test_elicitation"]),
        );
        expect((await client.listResources()).resources.map((r) => r.uri)).toEqual(
          expect.arrayContaining(["willder://brief", "test://static-text"]),
        );
        expect(client.getServerCapabilities()?.logging).toEqual({});
      } finally {
        await client.close();
      }
    });
  });
});
