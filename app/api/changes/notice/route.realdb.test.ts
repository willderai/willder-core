// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// GET /api/changes/notice and the hook `willder init` installs, against a real
// database.
//
// What only a real database can show: that the quiet path really skips check()
// (no audit row is written), that a change reaches an agent once whichever path
// asks, and that a denied token hears exactly what a quiet one hears. The last
// block runs the installed hook as Claude Code would — a separate process, stdin
// in, stdout out — against this route on a real socket.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never an inherited
// DATABASE_URL that points at a live database. Skips cleanly without it.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// Leaf module, not the `@/services/access` barrel: the barrel builds the
// `@/lib/db` singleton at import time, before beforeAll can point DATABASE_URL
// at the QA database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import { init } from "@/cli/willder.mjs";
import { CONTEXT_PREFIX } from "@/cli/hooks/willder-changes.mjs";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-changes-notice";
const SALES = "org_1.sales";
const ENGINEERING = "org_1.engineering";
const AGENT = "agent-notice";

describe.skipIf(!QA_URL)("GET /api/changes/notice against a real database", () => {
  let db: PrismaClient;
  let GET: (typeof import("./route"))["GET"];
  let feedGET: (typeof import("../route"))["GET"];
  let recordChangeEvent: (typeof import("@/services/memory/change-events"))["recordChangeEvent"];

  let token = "";
  let appDb: PrismaClient;
  const appStatements: string[] = [];

  const request = (path: string, bearer: string | null = token) =>
    new Request(`https://willder.test${path}`, {
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    });
  const notice = async (bearer: string | null = token) => GET(request("/api/changes/notice", bearer));

  async function mint(opts: { agentId?: string; scopePath: string; grantGoverned?: boolean }): Promise<string> {
    const raw = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: opts.agentId ?? AGENT,
        tokenHash: hashCapabilityToken(raw),
        scopePath: opts.scopePath,
        permission: "read",
        grantGoverned: opts.grantGoverned ?? false,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return raw;
  }

  const writeEvent = (scopePath: string, recordId: string, actorId = "writer") =>
    db.$transaction(async (tx) =>
      recordChangeEvent(tx, {
        orgId: ORG,
        scopePath,
        recordType: "fact",
        recordId,
        op: "create",
        actorId,
        actorType: "agent",
        origin: "mcp",
        title: `change to ${recordId}`,
      }),
    );

  const auditRows = () => db.auditLog.count({ where: { orgId: ORG } });

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    // The route's own client, set where `@/lib/db` looks for an existing one, so the
    // statements the route sends can be read back. Only the route uses it; setup
    // and assertions go through `db` and are never recorded.
    const logged = new PrismaClient({
      adapter: new PrismaPg({ connectionString: QA_URL }),
      log: [{ emit: "event", level: "query" }],
    });
    logged.$on("query", (e) => appStatements.push(e.query));
    appDb = logged;
    (globalThis as { prisma?: PrismaClient }).prisma = appDb;
    ({ GET } = await import("./route"));
    ({ GET: feedGET } = await import("../route"));
    ({ recordChangeEvent } = await import("@/services/memory/change-events"));
  });

  afterAll(async () => {
    await db.$disconnect();
    await appDb.$disconnect();
  });

  beforeEach(async () => {
    await db.taskStartDelivery.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.agentCursor.deleteMany({ where: { orgId: ORG } });
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    token = await mint({ scopePath: SALES });
  });

  it("tells the agent about a change in its scope, and nothing outside it", async () => {
    await writeEvent(SALES, "pricing-decision");
    await writeEvent(ENGINEERING, "engineering-secret");

    const res = await notice();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.notice).toContain("pricing-decision");
    expect(body.notice).not.toContain("engineering-secret");
  });

  it("says nothing on a quiet org, and writes no audit row saying it", async () => {
    await notice(); // establishes the cursor
    const before = await auditRows();

    const body = await (await notice()).json();

    expect(body).toEqual({ notice: null });
    expect(await auditRows()).toBe(before);
  });

  it("tells each change once, across calls", async () => {
    await writeEvent(SALES, "first");
    expect((await (await notice()).json()).notice).toContain("first");

    expect((await (await notice()).json()).notice).toBeNull();
  });

  it("shares one cursor with the change feed, so a change is never told twice", async () => {
    await writeEvent(SALES, "told-by-hook");
    await notice();

    const feed = await (await feedGET(request("/api/changes"))).json();

    expect(feed.changes).toEqual([]);
  });

  it("does not tell the agent about its own changes", async () => {
    // The session's first poll carries its task-start block, which shows the scope's recent
    // writes, the agent's own included; this test is about the feed after it.
    await notice();
    await writeEvent(SALES, "my-own-write", AGENT);

    expect((await (await notice()).json()).notice).toBeNull();
  });

  it("answers a denied token exactly as it answers a quiet one", async () => {
    // Grant-governed with no live grant: resolveCapability accepts the token,
    // check() denies it.
    const denied = await mint({ agentId: "agent-denied", scopePath: SALES, grantGoverned: true });
    const quiet = await notice(denied);
    await writeEvent(SALES, "hidden-from-denied");

    const afterWrite = await notice(denied);

    expect(quiet.status).toBe(200);
    expect(afterWrite.status).toBe(200);
    expect(await afterWrite.json()).toEqual(await quiet.json());
  });

  describe("a denied token that keeps polling", () => {
    const DENIED = "agent-denied";
    const denyRows = () => db.auditLog.count({ where: { orgId: ORG, actorId: DENIED, decision: "deny" } });

    async function grantRead(): Promise<string> {
      const scope = await db.scope.upsert({
        where: { orgId_path: { orgId: ORG, path: SALES } },
        update: {},
        create: { orgId: ORG, path: SALES, name: "sales" },
      });
      const grant = await db.grant.create({
        data: { orgId: ORG, scopeId: scope.id, granteeType: "agent", granteeId: DENIED, permission: "read" },
      });
      return grant.id;
    }

    it("audits the denial once per change of decision, not once per poll", async () => {
      const denied = await mint({ agentId: DENIED, scopePath: SALES, grantGoverned: true });

      await writeEvent(SALES, "unseen-1");
      for (let i = 0; i < 10; i++) expect(await (await notice(denied)).json()).toEqual({ notice: null });
      expect(await denyRows()).toBe(1);

      // More writes while still denied are not a new decision.
      await writeEvent(SALES, "unseen-2");
      for (let i = 0; i < 10; i++) expect(await (await notice(denied)).json()).toEqual({ notice: null });
      expect(await denyRows()).toBe(1);

      // Granted again: the next change is told, and nothing is denied.
      const grantId = await grantRead();
      await writeEvent(SALES, "after-regrant");
      expect((await (await notice(denied)).json()).notice).toContain("after-regrant");
      expect(await denyRows()).toBe(1);

      // Revoked again: that is a new decision, audited once more, and only once.
      await db.grant.delete({ where: { id: grantId } });
      await writeEvent(SALES, "after-revoke");
      for (let i = 0; i < 10; i++) expect(await (await notice(denied)).json()).toEqual({ notice: null });
      expect(await denyRows()).toBe(2);
    });

    it("audits a second revoke that follows a regrant nothing was written under", async () => {
      const denied = await mint({ agentId: DENIED, scopePath: SALES, grantGoverned: true });
      await notice(denied);
      expect(await denyRows()).toBe(1);

      // Granted again on a quiet org: the allowed poll is the quiet answer, and the
      // feed is never read, so ending the denial cannot wait for a read.
      const grantId = await grantRead();
      expect(await (await notice(denied)).json()).toEqual({ notice: null });

      await db.grant.delete({ where: { id: grantId } });
      await notice(denied);
      await notice(denied);
      expect(await denyRows()).toBe(2);
    });

    it("is not told what was written while it was denied, once granted again", async () => {
      const denied = await mint({ agentId: DENIED, scopePath: SALES, grantGoverned: true });
      await writeEvent(SALES, "written-while-denied");
      await notice(denied);

      await grantRead();
      await writeEvent(SALES, "written-after-grant");
      const told = (await (await notice(denied)).json()).notice as string;
      // The first allowed poll also opens the session, so it leads with the task-start block:
      // the scope as it stands now, which the agent may read again, as its first MCP tool call
      // would show it. What the feed tells is the part after it, which leaves out a write the
      // block already shows, so the write after the grant is told once, in one or the other.
      const at = told.indexOf("Changed in your scope");
      const feed = at === -1 ? "" : told.slice(at);
      const block = at === -1 ? told : told.slice(0, at);

      expect(told).toContain("written-after-grant");
      expect(block.includes("written-after-grant")).not.toBe(feed.includes("written-after-grant"));
      expect(feed).not.toContain("written-while-denied");
    });

    it("sends the same statements to the database after an unseen write as after none", async () => {
      const denied = await mint({ agentId: DENIED, scopePath: SALES, grantGoverned: true });
      const statementsOf = async (poll: () => Promise<unknown>) => {
        appStatements.length = 0;
        await poll();
        return [...appStatements];
      };

      await notice(denied); // starts the denial, and audits it: a one-time step
      const quiet = await statementsOf(() => notice(denied));
      await writeEvent(SALES, "unseen");
      const unseen = await statementsOf(() => notice(denied));

      // Timing a poll is what a denied token could do; the work behind that timing
      // is the statements the route sends. Before the fix, the first unseen write
      // added check()'s audit insert to every poll after it. Deciding only after
      // the feed says something is new would leak each write instead. Either way
      // the two lists differ. Compared as text, so load on the machine running
      // this cannot move the answer.
      expect(quiet.length).toBeGreaterThan(0);
      expect(unseen).toEqual(quiet);
    });
  });

  it("rejects a missing, unknown or revoked token with the same 401 the feed uses", async () => {
    await db.capability.updateMany({
      where: { tokenHash: hashCapabilityToken(token) },
      data: { revokedAt: new Date() },
    });

    const revoked = await notice();
    const unknown = await notice("wcap_never_issued");

    expect((await notice(null)).status).toBe(401);
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toEqual(await unknown.json());
  });

  describe("through the hook `willder init` installs", () => {
    let server: Server;
    let origin = "";
    let projectDir = "";
    let hookPath = "";

    beforeAll(async () => {
      server = createServer((req, res) => {
        void (async () => {
          const response = await GET(
            new Request(`${origin}${req.url}`, {
              headers: { authorization: req.headers.authorization ?? "" },
            }),
          );
          res.writeHead(response.status, { "content-type": "application/json" });
          res.end(await response.text());
        })();
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      projectDir = mkdtempSync(join(tmpdir(), "willder-init-"));
      ({ hookPath } = init({ projectDir, url: origin }));
    });

    afterAll(async () => {
      await new Promise((done) => server.close(done));
      rmSync(projectDir, { recursive: true, force: true });
    });

    const runHook = (event: string, bearer = token) =>
      new Promise<{ code: number | null; stdout: string }>((done) => {
        const child = execFile(
          process.execPath,
          [hookPath],
          { env: { NODE_ENV: "test", WILLDER_URL: origin, WILLDER_TOKEN: bearer } },
          (error, stdout) => done({ code: error ? (error.code as number) : 0, stdout }),
        );
        child.stdin!.end(JSON.stringify({ hook_event_name: event, session_id: "s1" }));
      });

    it("hands Claude Code the change as additional context, under the data prefix", async () => {
      await writeEvent(SALES, "auth-decision");

      const { code, stdout } = await runHook("PostToolUse");
      const output = JSON.parse(stdout);

      expect(code).toBe(0);
      expect(output.hookSpecificOutput.hookEventName).toBe("PostToolUse");
      expect(output.hookSpecificOutput.additionalContext.startsWith(CONTEXT_PREFIX)).toBe(true);
      expect(output.hookSpecificOutput.additionalContext).toContain("auth-decision");
    });

    it("prints nothing when nothing changed", async () => {
      await runHook("UserPromptSubmit");

      expect(await runHook("UserPromptSubmit")).toEqual({ code: 0, stdout: "" });
    });

    it("prints nothing and exits 0 for a revoked token", async () => {
      await writeEvent(SALES, "after-revoke");
      await db.capability.updateMany({
        where: { tokenHash: hashCapabilityToken(token) },
        data: { revokedAt: new Date() },
      });

      expect(await runHook("PostToolUse")).toEqual({ code: 0, stdout: "" });
    });
  });
});
