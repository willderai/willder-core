// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// An export of one scope (exportMemory's `scope` option, which `npm run selfhost:export
// -- --scope` uses) holds that scope and its descendants as far as the caller may read
// them, and nothing else. It never widens what the caller's export without a scope would
// hold, and a scope they can read nothing of is refused like the web export's refusals:
// with AccessDeniedError, before any line, and a deny row in the audit log.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";
import { seedMember } from "@/services/access/member.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa-export-scope";
const OTHER_ORG = "qa-export-scope-other";
const ROOT = `org_${ORG}`;
const ADMIN = "u-export-scope-admin";
const ALPHA_READER = "u-export-scope-alpha";
const DEEP_READER = "u-export-scope-deep";
const DIMENSIONS = 384;
const NOW = new Date("2026-10-18T12:00:00.000Z");

const FACTS = {
  alpha: "Alpha ships on Thursdays.",
  "alpha.deep": "Alpha's deep team owns the parser.",
  alpha_x: "Alpha X is a different team with a longer label.",
  beta: "Beta ships on Mondays.",
} as const;
const UNSCOPED = "The org's fiscal year starts in April.";

function embed(text: string): number[] {
  const vector: number[] = [];
  for (let block = 0; vector.length < DIMENSIONS; block++) {
    for (const byte of createHash("sha256").update(`${block}:${text}`).digest()) vector.push(byte / 255 - 0.5);
  }
  const norm = Math.hypot(...vector.slice(0, DIMENSIONS));
  return vector.slice(0, DIMENSIONS).map((x) => x / norm);
}

const person = (id: string): AccessContext => ({
  orgId: ORG,
  actor: { type: "human", id, role: "member" },
  origin: "script",
});

describe.skipIf(!QA_URL)("an export of one scope, real Postgres", () => {
  let db: PrismaClient;
  let exportMemory: (typeof import("./org-export"))["exportMemory"];
  let AccessDeniedError: (typeof import("@/services/access"))["AccessDeniedError"];

  async function collect(ctx: AccessContext, scope?: string): Promise<Record<string, unknown>[]> {
    const lines: Record<string, unknown>[] = [];
    for await (const line of exportMemory(ctx, NOW, scope === undefined ? {} : { scope })) lines.push(JSON.parse(line));
    return lines;
  }
  const factsOf = (records: Record<string, unknown>[]) =>
    records
      .filter((r) => r.type === "fact")
      .map((r) => r.content)
      .sort();

  async function reset() {
    await db.org.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
    await db.user.deleteMany({ where: { id: { in: [ADMIN, ALPHA_READER, DEEP_READER] } } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ exportMemory } = await import("./org-export"));
    ({ AccessDeniedError } = await import("@/services/access"));
    await reset();

    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.org.create({ data: { id: OTHER_ORG, name: OTHER_ORG } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "role", granteeId: "admin", permission: "admin" },
    });
    await db.scope.create({ data: { orgId: OTHER_ORG, path: `org_${OTHER_ORG}`, name: "root" } });
    await db.scope.create({ data: { orgId: OTHER_ORG, path: `org_${OTHER_ORG}.alpha`, name: "alpha" } });
    const scopeIds: Record<string, string> = {};
    for (const relative of Object.keys(FACTS)) {
      const scope = await db.scope.create({ data: { orgId: ORG, path: `${ROOT}.${relative}`, name: relative } });
      scopeIds[relative] = scope.id;
    }
    await seedMember(db, { orgId: ORG, userId: ADMIN, role: "admin" });
    await seedMember(db, { orgId: ORG, userId: ALPHA_READER });
    await seedMember(db, { orgId: ORG, userId: DEEP_READER });
    await db.grant.create({
      data: { orgId: ORG, scopeId: scopeIds.alpha, granteeType: "user", granteeId: ALPHA_READER, permission: "read" },
    });
    await db.grant.create({
      data: {
        orgId: ORG,
        scopeId: scopeIds["alpha.deep"],
        granteeType: "user",
        granteeId: DEEP_READER,
        permission: "read",
      },
    });

    const rows: [string, string, string | null][] = [
      ...Object.entries(FACTS).map(([relative, content]): [string, string, string] => [
        `f-${relative}`,
        content,
        `${ROOT}.${relative}`,
      ]),
      ["f-unscoped", UNSCOPED, null],
    ];
    for (const [id, content, scopePath] of rows) {
      await db.$executeRaw`
        INSERT INTO memory_chunks (id, "orgId", content, source, "actorType", "actorId", "scopePath", embedding)
        VALUES (${id}, ${ORG}, ${content}, 'text', 'agent', 'agent-1', ${scopePath}, ${`[${embed(content).join(",")}]`}::vector)`;
    }
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await reset();
    await db.$disconnect();
  });

  it.each([
    ["an admin, alpha", ADMIN, `${ROOT}.alpha`, ["alpha"], [FACTS.alpha, FACTS["alpha.deep"]]],
    ["an admin, a grandchild", ADMIN, `${ROOT}.alpha.deep`, ["alpha.deep"], [FACTS["alpha.deep"]]],
    ["an alpha reader, alpha", ALPHA_READER, `${ROOT}.alpha`, ["alpha"], [FACTS.alpha, FACTS["alpha.deep"]]],
    ["a reader of only alpha.deep, alpha", DEEP_READER, `${ROOT}.alpha`, ["alpha.deep"], [FACTS["alpha.deep"]]],
  ])(
    "%s: holds the scope and its descendants the caller may read, never the sibling alpha_x",
    async (_label, userId, scope, scopes, facts) => {
      const records = await collect(person(userId), scope);
      expect(records[0]).toMatchObject({ type: "manifest", format: "willder-export", coverage: "scopes", scopes });
      expect(factsOf(records)).toEqual([...facts].sort());
      expect(records.filter((r) => r.type === "audit")).toEqual([]);
      expect(records.at(-1)).toMatchObject({ type: "end", counts: { fact: facts.length } });
    },
  );

  it("the org root as the scope is the same export as no scope", async () => {
    const whole = await collect(person(ADMIN));
    const rooted = await collect(person(ADMIN), ROOT);
    expect(rooted[0]).toEqual(whole[0]);
    expect(factsOf(rooted)).toEqual(factsOf(whole));
    expect(factsOf(whole)).toContain(UNSCOPED);
  });

  it("a member's export of their own scope is line for line the export the web route gives them", async () => {
    expect(await collect(person(ALPHA_READER), `${ROOT}.alpha`)).toEqual(await collect(person(ALPHA_READER)));
  });

  it.each([
    ["a scope the member cannot read", ALPHA_READER, `${ROOT}.beta`],
    ["a sibling whose label extends theirs", ALPHA_READER, `${ROOT}.alpha_x`],
    ["a scope beside the only one they can read", DEEP_READER, `${ROOT}.alpha_x`],
    ["a scope that does not exist", ALPHA_READER, `${ROOT}.nowhere`],
    ["a same-named scope in another org", ADMIN, `org_${OTHER_ORG}.alpha`],
    ["a LIKE pattern", ADMIN, `${ROOT}.alpha%`],
    ["an empty path", ADMIN, ""],
  ])("refuses %s before writing a line, and records the refusal", async (_label, userId, scope) => {
    const before = await db.auditLog.count({ where: { orgId: ORG, actorId: userId, decision: "deny" } });
    const lines = exportMemory(person(userId), NOW, { scope });
    const refusal = await lines.next().then(
      () => null,
      (e: unknown) => e,
    );
    expect(refusal).toBeInstanceOf(AccessDeniedError);
    expect((refusal as InstanceType<typeof AccessDeniedError>).decision.reason).toBe(
      "You cannot read that scope, so there is nothing in it you may export.",
    );
    expect(await db.auditLog.count({ where: { orgId: ORG, actorId: userId, decision: "deny" } })).toBe(before + 1);
  });

  it("an agent is refused with a scope as without one", async () => {
    const agent: AccessContext = {
      orgId: ORG,
      actor: { type: "agent", id: "agent-1", capabilityToken: "wcap_x" },
      origin: "mcp",
    };
    const lines = exportMemory(agent, NOW, { scope: `${ROOT}.alpha` });
    await expect(lines.next()).rejects.toThrow("Agent tokens cannot export memory");
  });
});
