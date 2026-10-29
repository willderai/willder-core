// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Probes for GET /api/changes/notice and the hook `willder init`
// installs, against a real database: tenant isolation, the cursor shared with the
// MCP tool-result notice, audit cost of a quiet poll, and the hook's silence and
// token handling when the server misbehaves.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never the sandbox's inherited
// DATABASE_URL. Skips cleanly without it.
import { execFile } from "node:child_process";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG_A = "org-qa-notice-a";
const ORG_B = "org-qa-notice-b";
const SCOPE = "org_1.sales";
const AGENT = "agent-qa-notice";
const HOOK = fileURLToPath(new URL("../../../../cli/hooks/willder-changes.mjs", import.meta.url));

const listen = async (server: Server) => {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return (server.address() as AddressInfo).port;
};
const close = (server: Server) => new Promise((done) => server.close(done));

const runHook = (env: Record<string, string>) =>
  new Promise<{ code: number; stdout: string; stderr: string; ms: number }>((done) => {
    const started = Date.now();
    const child = execFile(process.execPath, [HOOK], { env: { NODE_ENV: "test", ...env } }, (error, stdout, stderr) =>
      done({ code: error ? (error.code as number) : 0, stdout, stderr, ms: Date.now() - started }),
    );
    child.stdin!.end(JSON.stringify({ hook_event_name: "PostToolUse" }));
  });

describe.skipIf(!QA_URL)("GET /api/changes/notice, real database", () => {
  let db: PrismaClient;
  let GET: (typeof import("./route"))["GET"];
  let changeNotice: (typeof import("@/mcp/change-notices"))["changeNotice"];
  let recordChangeEvent: (typeof import("@/services/memory/change-events"))["recordChangeEvent"];

  async function mint(orgId: string, opts: { agentId?: string; grantGoverned?: boolean } = {}) {
    const raw = `wcap_qa_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId,
        agentId: opts.agentId ?? AGENT,
        tokenHash: hashCapabilityToken(raw),
        scopePath: SCOPE,
        permission: "read",
        grantGoverned: opts.grantGoverned ?? false,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return raw;
  }
  const write = (orgId: string, recordId: string, actorId = "writer") =>
    db.$transaction((tx) =>
      recordChangeEvent(tx, {
        orgId,
        scopePath: SCOPE,
        recordType: "fact",
        recordId,
        op: "create",
        actorId,
        actorType: "agent",
        origin: "mcp",
        title: `title of ${recordId}`,
      }),
    );
  const notice = async (token: string) =>
    (
      await GET(
        new Request("https://willder.test/api/changes/notice", { headers: { authorization: `Bearer ${token}` } }),
      )
    ).json();

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GET } = await import("./route"));
    ({ changeNotice } = await import("@/mcp/change-notices"));
    ({ recordChangeEvent } = await import("@/services/memory/change-events"));
  });
  afterAll(async () => db.$disconnect());
  beforeEach(async () => {
    for (const orgId of [ORG_A, ORG_B]) {
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.changeEvent.deleteMany({ where: { orgId } });
      await db.agentCursor.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
      await db.org.upsert({ where: { id: orgId }, update: {}, create: { id: orgId, name: orgId } });
    }
  });

  it("never tells one tenant about another tenant's change at the same scope path and agent id", async () => {
    const tokenA = await mint(ORG_A);
    const tokenB = await mint(ORG_B);
    await write(ORG_B, "tenant-b-secret");

    expect(await notice(tokenA)).toEqual({ notice: null });
    expect((await notice(tokenB)).notice).toContain("tenant-b-secret");
  });

  it("shares its cursor with the MCP tool-result notice in both directions", async () => {
    const token = await mint(ORG_A);
    const mcpCtx = {
      orgId: ORG_A,
      actor: { type: "agent" as const, id: AGENT, capabilityToken: token },
      origin: "mcp" as const,
    };

    await write(ORG_A, "hook-first");
    expect((await notice(token)).notice).toContain("hook-first");
    expect(await changeNotice(mcpCtx, SCOPE)).toBeNull();

    await write(ORG_A, "mcp-first");
    expect(await changeNotice(mcpCtx, SCOPE)).toContain("mcp-first");
    expect(await notice(token)).toEqual({ notice: null });
  });

  it("a quiet poll after a change was told writes no audit row", async () => {
    const token = await mint(ORG_A);
    await write(ORG_A, "told");
    await notice(token);
    const before = await db.auditLog.count({ where: { orgId: ORG_A } });

    for (let i = 0; i < 5; i++) expect(await notice(token)).toEqual({ notice: null });

    expect(await db.auditLog.count({ where: { orgId: ORG_A } })).toBe(before);
  });

  it("a poll whose only news is the agent's own writes is quiet and writes no audit row", async () => {
    const token = await mint(ORG_A);
    await write(ORG_A, "own-1", AGENT);
    await write(ORG_A, "own-2", AGENT);

    expect(await notice(token)).toEqual({ notice: null });
    expect(await db.auditLog.count({ where: { orgId: ORG_A } })).toBe(0);

    await write(ORG_A, "other-after-own");
    const told = (await notice(token)).notice as string;
    expect(told).toContain("other-after-own");
    expect(told).not.toContain("own-1");
  });

  it("skipping the agent's own writes never passes over another actor's change on either side", async () => {
    const token = await mint(ORG_A);
    await write(ORG_A, "other-before");
    await write(ORG_A, "own-between", AGENT);
    await write(ORG_A, "other-after");

    const told = (await notice(token)).notice as string;
    expect(told).toContain("other-before");
    expect(told).toContain("other-after");
    expect(told).not.toContain("own-between");
  });

  it("the same agent id's own writes in another tenant do not move this tenant's cursor", async () => {
    const tokenA = await mint(ORG_A);
    await mint(ORG_B);
    await write(ORG_A, "tenant-a-change");
    await write(ORG_B, "own-in-b", AGENT);

    expect((await notice(tokenA)).notice).toContain("tenant-a-change");
  });

  describe("the hook against a misbehaving server", () => {
    let seen: IncomingHttpHeaders[] = [];
    let other: Server;
    let otherPort = 0;
    beforeAll(async () => {
      other = createServer((req, res) => {
        seen.push(req.headers);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ notice: "- from the redirect target" }));
      });
      otherPort = await listen(other);
    });
    afterAll(() => close(other));
    beforeEach(() => {
      seen = [];
    });

    const serve = async (handler: Parameters<typeof createServer>[1]) => {
      const server = createServer(handler);
      return { server, url: `http://127.0.0.1:${await listen(server)}` };
    };

    it("does not carry the token across a cross-origin redirect", async () => {
      const { server, url } = await serve((_req, res) => {
        res.writeHead(307, { location: `http://localhost:${otherPort}/api/changes/notice` });
        res.end();
      });
      const result = await runHook({ WILLDER_TOKEN: "wcap_qa_secret", WILLDER_URL: url });
      await close(server);

      expect(result.stdout).not.toContain("wcap_qa_secret");
      expect(result.stderr).toBe("");
      for (const headers of seen) expect(headers.authorization).toBeUndefined();
    });

    it("exits 0 silently, within its own timeout, when the server hangs", async () => {
      const { server, url } = await serve(() => {});
      const result = await runHook({ WILLDER_TOKEN: "wcap_qa_secret", WILLDER_URL: url });
      server.closeAllConnections();
      await close(server);

      expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
      expect(result.ms).toBeLessThan(5000);
    });

    it("exits 0 silently on a 500", async () => {
      const { server, url } = await serve((_req, res) => {
        res.writeHead(500);
        res.end("boom wcap_qa_secret");
      });
      const result = await runHook({ WILLDER_TOKEN: "wcap_qa_secret", WILLDER_URL: url });
      await close(server);

      expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
    });
  });
});
