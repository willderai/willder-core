// Latency budget for a person erasure and its digest rule on hostile text, apart from the
// functional tests because a clock reading is only meaningful on a machine that is not busy.
//
// Skipped unless WILLDER_PERF_TESTS=1 and QA_DATABASE_URL names an isolated, migrated Postgres.
// CI does not set WILLDER_PERF_TESTS: its shards run many workers at once, and a bound fails
// there under load with the code unchanged. The same inputs are judged without a clock in
// erasure-rule-agreement.realdb.test.ts ("reads 100,000 characters of one word or one mark"),
// which runs in every CI shard.
//
// The claim: each rule reads a long run of one word or one mark in time linear in its length.
// Each of these inputs took 20 to 45 s in the digest rule while its runs started at every
// character rather than at a word's first letter. The budget is per erasure, so it does not move
// when a suite erases more people. Measured 2026-10-17 on a loaded laptop (PG 18.6, builtin
// C.UTF-8), these eight texts: 0.3 to 0.8 s per erasure on main, which folded less, and 0.7 to
// 1.9 s here.
//
// Run on a quiet machine:
//   WILLDER_PERF_TESTS=1 QA_DATABASE_URL=<test database> npx vitest run --project node services/memory/erasure-linear-time.perf.realdb.test.ts
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";

vi.mock("./store", () => ({
  memory: {},
  graphitiStore: {
    planPersonErasure: async () => [],
    erasePerson: vi.fn(async () => ({ episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] })),
  },
}));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "qa_erasure_linear_time";
const ROOT = `org_${ORG}`;
const ADMIN = "qa_erasure_linear_time_admin";
const DIMENSIONS = 384;

/** People whose names exercise every pattern kind: hyphens, capitals inside a word, accents, Greek, a Turkish İ. */
const PEOPLE = [
  { id: "dana", name: "Dana Whitfield", email: "dana@linear.example" },
  { id: "anne", name: "Anne-Marie Dupont", email: "amd@linear.example" },
  { id: "rory", name: "Rory McDonald", email: "rory@linear.example" },
  { id: "zoe", name: "Zoë Ferrand", email: "zoe@linear.example" },
  { id: "nikos", name: "Νίκος Παπάς", email: "nikos@linear.example" },
  { id: "ayse", name: "Ayşe İnce", email: "ayse@linear.example" },
];

/**
 * A word with no joint in it, and runs of every mark a name is read across; then long text
 * outside ASCII, which takes the full fold: with a Turkish "\u0130", and with a letter Unicode
 * added after 15.0, which the fold reads from its list with translate().
 */
const HOSTILE = [
  "a".repeat(100_000),
  `a${"-".repeat(100_000)}`,
  `a${"_".repeat(100_000)}`,
  `a${" ".repeat(100_000)}`,
  "ab".repeat(50_000),
  "1".repeat(100_000),
  `${"\u00e4".repeat(100_000)}\u0130`,
  `${"\u00e4".repeat(100_000)}\ua7ce`,
];

describe.skipIf(!QA_URL || process.env.WILLDER_PERF_TESTS !== "1")(
  "performance: a person erasure on hostile text",
  () => {
    let db: PrismaClient;
    const admin: AccessContext = { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" };
    const written = new Date(Date.now() - 24 * 3600 * 1000);

    async function wipe() {
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
      await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
      await db.contact.deleteMany({ where: { orgId: ORG } });
      await db.auditLog.deleteMany({ where: { orgId: ORG } });
      await db.grant.deleteMany({ where: { orgId: ORG } });
      await db.scope.deleteMany({ where: { orgId: ORG } });
      await db.user.deleteMany({ where: { orgId: ORG } });
    }

    beforeAll(async () => {
      process.env.DATABASE_URL = QA_URL;
      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
      await wipe();
      await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
      const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
      await db.user.create({
        data: { id: ADMIN, orgId: ORG, email: "admin@linear.test", role: "admin", clerkId: "clerk-linear-admin" },
      });
      await db.grant.create({
        data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
      });
    }, 60_000);

    afterAll(async () => {
      if (!db) return;
      await wipe();
      await db.$disconnect();
    });

    it("erases each person in under 2 s and reads each 100,000-character text in under 1 s", async () => {
      const { erasePerson } = await import("./person-erasure");
      const { loadErasedContentFilter } = await import("./erasure-suppression");
      const vector = `[${[1, ...Array(DIMENSIONS - 1).fill(0)].join(",")}]`;
      for (const [i, text] of HOSTILE.entries()) {
        await db.$executeRaw`
        INSERT INTO memory_chunks ("id","orgId","content","source","actorType","entityName","scopePath","embedding","createdAt")
        VALUES (${`hostile-${i}`}, ${ORG}, ${text}, 'mcp', 'agent', 'Pricing', ${ROOT}, ${vector}::vector, ${written})
      `;
      }
      for (const person of PEOPLE) await db.contact.create({ data: { ...person, orgId: ORG } });

      const erasures: number[] = [];
      for (const person of PEOPLE) {
        const started = performance.now();
        await erasePerson(admin, { contactId: person.id });
        erasures.push(performance.now() - started);
      }
      const erased = await loadErasedContentFilter(ORG);
      const reads = HOSTILE.map((text) => {
        const started = performance.now();
        erased(text, written, "Pricing");
        return performance.now() - started;
      });
      console.info(
        `erasure per person: ${erasures.map((ms) => ms.toFixed(0)).join(", ")} ms; digest rule per text: ${reads.map((ms) => ms.toFixed(0)).join(", ")} ms`,
      );
      expect(Math.max(...erasures)).toBeLessThan(2_000);
      expect(Math.max(...reads)).toBeLessThan(1_000);
    }, 120_000);
  },
);
