// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The self-host bootstrap (scripts/lib/selfhost.ts) and the two CLIs on top of it, on a
// real Postgres: the operator's token passes check() for its own scope only, the
// bootstrap never reaches an org synced from Clerk, a token is issued under the web app's
// issuer rules, and selfhost:export refuses a scope its person cannot read and leaves no
// file behind, while exporting one it can. `selfhost:token --revoke` refuses the agent's
// next call with the hosted MCP endpoint's answer, and the refusal is in the export; and
// `selfhost:smoke` passes a second time against the same database.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { seedMember } from "@/services/access/member.testsupport";
import { EmptyGraphMemoryService } from "@/mcp/memory-service-stub.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
const CLERK_ORG = "qa-selfhost-clerk-org";
const READER = "u-selfhost-reader";
const REPO = path.resolve(__dirname, "../..");
const TOOLS_LIST = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}';
const MEMORY_QUERY =
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"memory_query","arguments":{"query":"anything"}}}';

describe.skipIf(!QA_URL)("the self-host bootstrap and CLIs against a real database", () => {
  let db: PrismaClient;
  let selfhost: typeof import("./selfhost");
  let check: (typeof import("@/services/access"))["check"];
  let resolveCapability: (typeof import("@/services/access"))["resolveCapability"];
  let scratch: string;

  async function clear() {
    const orgs = await db.org.findMany({
      where: { OR: [{ clerkOrgId: { in: ["self-hosted", "self-hosted-smoke"] } }, { id: CLERK_ORG }] },
    });
    await db.org.deleteMany({ where: { id: { in: orgs.map((o) => o.id) } } });
    await db.user.deleteMany({
      where: { OR: [{ id: READER }, { clerkId: { in: ["self-hosted:operator", "self-hosted-smoke:operator"] } }] },
    });
  }

  const cliEnv = (): NodeJS.ProcessEnv => ({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "test",
    DATABASE_URL: QA_URL,
    DATABASE_URL_UNPOOLED: QA_URL,
  });

  /** Runs a self-host CLI against the test database, as `npm run selfhost:*` would. */
  function cli(script: string, args: string[]) {
    return spawnSync(process.execPath, [require.resolve("tsx/cli"), script, ...args], {
      cwd: REPO,
      env: cliEnv(),
      encoding: "utf8",
      timeout: 60_000,
    });
  }

  /** Like {@link cli}, without blocking this process, so a server it runs can answer the CLI. */
  function cliAsync(
    script: string,
    env: Record<string, string>,
  ): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [require.resolve("tsx/cli"), script], {
        cwd: REPO,
        env: { ...cliEnv(), ...env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  }

  /** One JSON-RPC request to the hosted MCP endpoint's handler, with `token` as the bearer. */
  async function mcpCall(token: string, body: string): Promise<Response> {
    const { POST } = await import("@/app/api/mcp/route");
    return POST(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body,
      }),
    );
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    selfhost = await import("./selfhost");
    ({ check, resolveCapability } = await import("@/services/access"));
    scratch = mkdtempSync(path.join(tmpdir(), "selfhost-realdb-"));
    await clear();
  });

  afterAll(async () => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    if (!db) return;
    await clear();
    await db.$disconnect();
  });

  it("bootstraps once, and the operator's token is allowed in its scope and refused in a sibling", async () => {
    const operator = await selfhost.ensureSelfhostOperator("default");
    expect(await selfhost.ensureSelfhostOperator("default")).toMatchObject({
      orgId: operator.orgId,
      userId: operator.userId,
    });
    expect(operator).toMatchObject({ role: "owner", email: "operator@self-hosted.invalid" });

    const team = selfhost.scopePathIn(operator.orgId, "team");
    const sibling = selfhost.scopePathIn(operator.orgId, "team_x");
    await selfhost.ensureScope(operator, `${team}.alpha`);
    await selfhost.ensureScope(operator, sibling);
    expect(await db.scope.count({ where: { orgId: operator.orgId, path: team } })).toBe(1);

    const issued = await selfhost.issueSelfhostToken(operator, {
      agent: "local-agent",
      scopePath: team,
      permission: "write",
      ttlHours: 1,
    });
    expect(await resolveCapability(issued.token, "mcp")).toMatchObject({
      orgId: operator.orgId,
      agentId: "local-agent",
    });
    expect(await db.capability.findUniqueOrThrow({ where: { id: issued.id } })).toMatchObject({
      createdBy: operator.userId,
    });
    const ctx = {
      orgId: operator.orgId,
      actor: { type: "agent" as const, id: "local-agent", capabilityToken: issued.token },
      origin: "mcp" as const,
    };
    expect((await check(ctx, { action: "memory.write", scope: `${team}.alpha` })).allowed).toBe(true);
    expect((await check(ctx, { action: "memory.read", scope: sibling })).allowed).toBe(false);
  });

  it("issues tokens under the web app's issuer rules: a member who only reads cannot issue one", async () => {
    const operator = await selfhost.selfhostPerson("default");
    await seedMember(db, { orgId: operator.orgId, userId: READER });
    const reader = await selfhost.selfhostPerson("default", `${READER}@member.test`);
    await expect(
      selfhost.issueSelfhostToken(reader, {
        agent: "local-agent",
        scopePath: selfhost.scopePathIn(operator.orgId, "team"),
        permission: "read",
        ttlHours: 1,
      }),
    ).rejects.toThrow("could not issue the token");
  });

  it("never finds a person in an org synced from Clerk, even with the operator's email", async () => {
    await db.org.create({ data: { id: CLERK_ORG, clerkOrgId: "org_qa_selfhost", name: "Hosted" } });
    await db.user.create({
      data: {
        orgId: CLERK_ORG,
        clerkId: "user_qa_selfhost",
        email: "operator@self-hosted-smoke.invalid",
        role: "owner",
      },
    });
    await expect(selfhost.selfhostPerson("smoke")).rejects.toThrow('no self-host org "smoke"');
  });

  it("does not bring back an operator who was removed from the org", async () => {
    const operator = await selfhost.ensureSelfhostOperator("smoke");
    await db.orgMembership.updateMany({
      where: { orgId: operator.orgId, userId: operator.userId },
      data: { removedAt: new Date() },
    });
    await expect(selfhost.ensureSelfhostOperator("smoke")).rejects.toThrow("is not a member");
  });

  it(
    "selfhost:export refuses a scope its person cannot read, leaving no file, and exports one they can",
    { timeout: 120_000 },
    async () => {
      const operator = await selfhost.selfhostPerson("default");
      const team = await db.scope.findUniqueOrThrow({
        where: { orgId_path: { orgId: operator.orgId, path: selfhost.scopePathIn(operator.orgId, "team") } },
      });
      await db.grant.create({
        data: { orgId: operator.orgId, scopeId: team.id, granteeType: "user", granteeId: READER, permission: "read" },
      });

      const refusedFile = path.join(scratch, "refused.jsonl");
      const refused = cli("scripts/selfhost-export.ts", [
        "--as",
        `${READER}@member.test`,
        "--scope",
        "team_x",
        "--out",
        refusedFile,
      ]);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain("refused: You cannot read that scope");
      expect(existsSync(refusedFile)).toBe(false);

      const exportedFile = path.join(scratch, "team.jsonl");
      const exported = cli("scripts/selfhost-export.ts", [
        "--as",
        `${READER}@member.test`,
        "--scope",
        "team",
        "--out",
        exportedFile,
      ]);
      expect(exported.status, exported.stderr).toBe(0);
      const lines = readFileSync(exportedFile, "utf8")
        .trimEnd()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(lines[0]).toMatchObject({ type: "manifest", coverage: "scopes", scopes: ["team"] });
      expect(
        lines
          .filter((l) => l.type === "scope")
          .map((l) => l.path)
          .sort(),
      ).toEqual(["team", "team.alpha"]);

      // An --out that exists is refused before the export starts: the file is untouched, and
      // no audit row records an export nobody received.
      const allowRows = () =>
        db.auditLog.count({ where: { orgId: operator.orgId, actorId: READER, decision: "allow" } });
      const before = await allowRows();
      const again = cli("scripts/selfhost-export.ts", [
        "--as",
        `${READER}@member.test`,
        "--scope",
        "team",
        "--out",
        exportedFile,
      ]);
      expect(again.status).toBe(1);
      expect(again.stderr).toContain("already exists");
      expect(readFileSync(exportedFile, "utf8").split("\n")[0]).toContain('"type":"manifest"');
      expect(await allowRows()).toBe(before);
    },
  );

  it(
    "selfhost:token --revoke refuses the agent's next call, and selfhost:export shows the refusal",
    { timeout: 120_000 },
    async () => {
      const minted = cli("scripts/selfhost-token.ts", ["--agent", "revoke_probe", "--scope", "team"]);
      expect(minted.status, minted.stderr).toBe(0);
      const token = minted.stdout.trimEnd().split("\n").at(-1)!;
      expect(token).toMatch(/^wcap_/);
      expect((await mcpCall(token, TOOLS_LIST)).status).toBe(200);

      const revoked = cli("scripts/selfhost-token.ts", ["--revoke", "revoke_probe"]);
      expect(revoked.status, revoked.stderr).toBe(0);
      const capability = await db.capability.findFirstOrThrow({ where: { agentId: "revoke_probe" } });
      expect(capability.revokedAt).not.toBeNull();
      expect(revoked.stdout).toContain(capability.id);
      expect(revoked.stdout + revoked.stderr).not.toContain(token);

      // The revocation itself is audited as the web app's revoke audits it: an access.manage
      // allow row by the operator, on the token's own scope.
      const operator = await selfhost.selfhostPerson("default");
      const revokeRows = await db.auditLog.findMany({
        where: {
          orgId: operator.orgId,
          action: "access.manage",
          target: { endsWith: `capabilities:revoke:${capability.id}` },
        },
      });
      expect(revokeRows).toEqual([
        expect.objectContaining({
          actorType: "human",
          actorId: operator.userId,
          decision: "allow",
          target: `${capability.scopePath}/capabilities:revoke:${capability.id}`,
        }),
      ]);

      const refused = await mcpCall(token, MEMORY_QUERY);
      expect(refused.status).toBe(401);
      expect(await refused.text()).toContain("Invalid or unknown capability token.");

      const file = path.join(scratch, "after-revoke.jsonl");
      const exported = cli("scripts/selfhost-export.ts", ["--out", file]);
      expect(exported.status, exported.stderr).toBe(0);
      const refusals = readFileSync(file, "utf8")
        .trimEnd()
        .split("\n")
        .map((l) => JSON.parse(l))
        .filter((l) => l.type === "audit" && l.action === "capability.refused");
      expect(refusals).toEqual([
        expect.objectContaining({
          actorType: "agent",
          actorId: "revoke_probe",
          target: capability.scopePath,
          decision: "deny",
        }),
      ]);
      expect(refusals[0].reason).toMatch(/^capability revoked:/);

      // Nothing left to revoke is said, not silently passed.
      const again = cli("scripts/selfhost-token.ts", ["--revoke", "revoke_probe"]);
      expect(again.status).toBe(1);
      expect(again.stderr).toContain('no live token for agent "revoke_probe"');
    },
  );

  it("selfhost:smoke passes a second time against the same database", { timeout: 300_000 }, async () => {
    await clear();
    const memory = new EmptyGraphMemoryService();
    const memoryUrl = await memory.start();
    try {
      const env = {
        GRAPHITI_SERVICE_URL: memoryUrl,
        GRAPHITI_SERVICE_API_KEY: "test",
        INNGEST_BYPASS: "1",
        CHECKPOINT_DISABLE: "1",
        OPENAI_API_KEY: "not-set",
        OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
      };
      for (const run of ["first", "second"]) {
        const smoke = await cliAsync("scripts/selfhost-smoke.ts", env);
        expect(smoke.stdout, `${run} run: ${smoke.stdout}\n${smoke.stderr}`).toMatch(/\n(\d+) of \1 steps passed/);
        expect(smoke.status, `${run} run`).toBe(0);
      }
    } finally {
      await memory.stop();
    }
  });

  it("reports only the tokens a revoke actually changed", async () => {
    const operator = await selfhost.ensureSelfhostOperator("default");
    const scopePath = selfhost.scopePathIn(operator.orgId, "team");
    await selfhost.ensureScope(operator, scopePath);
    const issue = () =>
      selfhost.issueSelfhostToken(operator, { agent: "revoke_race", scopePath, permission: "read", ttlHours: 1 });
    const [first, second] = [await issue(), await issue()];
    await db.capability.update({ where: { id: first.id }, data: { revokedAt: new Date("2026-01-01T00:00:00Z") } });

    const revoked = await selfhost.revokeSelfhostTokens(operator, [first.id, second.id]);
    expect(revoked.map((t) => t.id)).toEqual([second.id]);
    expect((await db.capability.findUniqueOrThrow({ where: { id: first.id } })).revokedAt).toEqual(
      new Date("2026-01-01T00:00:00Z"),
    );
    const audited = await db.auditLog.findMany({
      where: {
        orgId: operator.orgId,
        action: "access.manage",
        target: { endsWith: `capabilities:revoke:${second.id}` },
      },
    });
    expect(audited).toHaveLength(1);
  });

  it(
    "a stdio MCP server started with a revoked token stops, names selfhost:token, and records capability.refused",
    { timeout: 120_000 },
    async () => {
      const operator = await selfhost.ensureSelfhostOperator("default");
      const scopePath = selfhost.scopePathIn(operator.orgId, "team");
      await selfhost.ensureScope(operator, scopePath);
      const issued = await selfhost.issueSelfhostToken(operator, {
        agent: "stdio_probe",
        scopePath,
        permission: "read",
        ttlHours: 1,
      });
      await selfhost.revokeSelfhostTokens(operator, [issued.id]);

      const server = spawnSync(process.execPath, [require.resolve("tsx/cli"), "mcp/server.ts"], {
        cwd: REPO,
        env: {
          ...cliEnv(),
          GRAPHITI_SERVICE_URL: "http://127.0.0.1:9",
          GRAPHITI_SERVICE_API_KEY: "test",
          WILLDER_CAPABILITY_TOKEN: issued.token,
        },
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(server.status).toBe(1);
      expect(server.stdout).toBe("");
      expect(server.stderr).toContain("is not a live token in this database");
      expect(server.stderr).toContain("npm run selfhost:token");
      expect(
        await db.auditLog.count({
          where: { orgId: operator.orgId, action: "capability.refused", actorId: "stdio_probe" },
        }),
      ).toBe(1);
    },
  );
});
