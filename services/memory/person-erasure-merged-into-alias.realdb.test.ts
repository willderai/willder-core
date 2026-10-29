// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Person erasure follows an alias row in the other direction from
// person-erasure-merged-alias.realdb.qa.test.ts: her name was merged INTO another canonical
// name (the row's aliases hold her name, its canonicalName is the name the resolver now writes
// where she was meant). Erasing her must then erase by that canonical name too, in rules and in
// chunks, and remove the row; another person's merge row and what names them stay.
//
// Real: Postgres, check(), recordConvention, the erasure. Stand-in: the graph store.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";

vi.mock("./store", () => ({
  memory: {},
  graphitiStore: {
    planPersonErasure: async () => [],
    erasePerson: async () => ({ episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] }),
    removeChunkFacts: async () => undefined,
    removeEpisode: async () => ({ removed: true }),
  },
}));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_erasure_merged_into";
const ROOT = `org_${ORG}`;
const ADMIN = "qa_erasure_merged_into_admin";
const DIMENSIONS = 384;

const NAME = "Dana Whitfield";
const EMAIL = "dana.w@acme.example";
/** The name hers was merged into: the resolver writes this where she was meant. */
const MERGED_INTO = "Dana Grey";
/** Someone else's merge: a different person, with names that never name her. */
const OTHER_CANONICAL = "Pat Lee";
const OTHER_MERGED_AWAY = "Patrick Lee";

describe.skipIf(!QA_URL)(
  "person erasure follows an alias row her name was merged into, by that row's canonical name",
  () => {
    let db: PrismaClient;
    let erasePerson: (typeof import("./person-erasure"))["erasePerson"];
    let recordConvention: (typeof import("./conventions"))["recordConvention"];

    const admin: AccessContext = { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" };

    async function wipe() {
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
      await db.taskStartServedItem.deleteMany({ where: { orgId: ORG } });
      await db.convention.deleteMany({ where: { orgId: ORG } });
      await db.changeEvent.deleteMany({ where: { orgId: ORG } });
      await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
      await db.entityAlias.deleteMany({ where: { orgId: ORG } });
      await db.contact.deleteMany({ where: { orgId: ORG } });
      await db.auditLog.deleteMany({ where: { orgId: ORG } });
      await db.grant.deleteMany({ where: { orgId: ORG } });
      await db.scope.deleteMany({ where: { orgId: ORG } });
      await db.user.deleteMany({ where: { orgId: ORG } });
    }

    async function chunk(id: string, content: string) {
      await db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","scopePath","embedding")
      VALUES (${id}, ${ORG}, ${content}, 'text', 'agent', ${ROOT},
              ${`[${[1, ...Array(DIMENSIONS - 1).fill(0)].join(",")}]`}::vector)
    `;
    }

    const ruleText = async (id: string) => {
      const r = await db.convention.findUniqueOrThrow({ where: { id } });
      return { text: r.text, retired: r.retiredAt !== null };
    };

    beforeAll(async () => {
      process.env.DATABASE_URL = QA_URL;
      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
      ({ erasePerson } = await import("./person-erasure"));
      ({ recordConvention } = await import("./conventions"));
    });

    afterAll(async () => {
      if (!db) return;
      await wipe();
      await db.$disconnect();
    });

    let herRule: string;
    let otherRule: string;

    beforeEach(async () => {
      await wipe();
      await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
      const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
      await db.user.create({
        data: { id: ADMIN, orgId: ORG, email: `${ADMIN}@alias.test`, role: "admin", clerkId: `clerk-${ADMIN}` },
      });
      await db.grant.create({
        data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
      });

      await db.contact.create({ data: { id: "dana", orgId: ORG, name: NAME, email: EMAIL } });
      // Exactly what upsertAlias(org, `merge:${fromName}`, "user", toName, [fromName], ...) stores
      // when her name is the one merged away.
      await db.entityAlias.create({
        data: {
          orgId: ORG,
          entityType: "user",
          entityId: `merge:${NAME}`,
          canonicalName: MERGED_INTO,
          aliases: [NAME],
          createdBy: ADMIN,
        },
      });
      await db.entityAlias.create({
        data: {
          orgId: ORG,
          entityType: "user",
          entityId: `merge:${OTHER_MERGED_AWAY}`,
          canonicalName: OTHER_CANONICAL,
          aliases: [OTHER_MERGED_AWAY],
          createdBy: ADMIN,
        },
      });

      herRule = await recordConvention(admin, {
        kind: "convention",
        subject: "Refunds",
        text: `${MERGED_INTO} signs off on refunds.`,
        scopePath: ROOT,
      });
      otherRule = await recordConvention(admin, {
        kind: "convention",
        subject: "Vendors",
        text: `${OTHER_MERGED_AWAY} picks vendors.`,
        scopePath: ROOT,
      });
      await chunk("chunk-her", `Ask ${MERGED_INTO} before refunding.`);
      await chunk("chunk-other", `Ask ${OTHER_MERGED_AWAY} about vendors.`);
    });

    it("erases by the canonical name hers was merged into and removes that row; the other person's row and text stay", async () => {
      const result = await erasePerson(admin, { contactId: "dana" });

      expect(result.rulesRedacted).toBe(1);
      expect(await ruleText(herRule)).toEqual({ text: "", retired: true });
      expect(await ruleText(otherRule)).toEqual({ text: `${OTHER_MERGED_AWAY} picks vendors.`, retired: false });

      const chunks = await db.$queryRaw<
        { id: string }[]
      >`SELECT id FROM memory_chunks WHERE "orgId" = ${ORG} ORDER BY id`;
      expect(chunks.map((c) => c.id)).toEqual(["chunk-other"]);

      const aliases = await db.entityAlias.findMany({ where: { orgId: ORG }, select: { canonicalName: true } });
      expect(aliases).toEqual([{ canonicalName: OTHER_CANONICAL }]);
    });

    it.each([
      ["her name in another case and spacing", "  dana   WHITFIELD "],
      ["her email address", EMAIL.toUpperCase()],
    ])("follows the row when the alias is %s", async (_label, alias) => {
      await db.entityAlias.update({
        where: { orgId_entityId: { orgId: ORG, entityId: `merge:${NAME}` } },
        data: { aliases: [alias] },
      });

      await erasePerson(admin, { contactId: "dana" });

      expect(await ruleText(herRule)).toEqual({ text: "", retired: true });
      const chunks = await db.$queryRaw<
        { id: string }[]
      >`SELECT id FROM memory_chunks WHERE "orgId" = ${ORG} ORDER BY id`;
      expect(chunks.map((c) => c.id)).toEqual(["chunk-other"]);
    });

    it("does not follow a row whose only link to her is her one-word first name", async () => {
      // "Dana" names too many people: a merge of "Dana" into "Dana Fox" is someone else's.
      await db.entityAlias.create({
        data: {
          orgId: ORG,
          entityType: "user",
          entityId: "merge:Dana",
          canonicalName: "Dana Fox",
          aliases: ["Dana"],
          createdBy: ADMIN,
        },
      });
      const foxRule = await recordConvention(admin, {
        kind: "convention",
        subject: "Payroll",
        text: "Dana Fox runs payroll.",
        scopePath: ROOT,
      });

      await erasePerson(admin, { contactId: "dana" });

      expect(await ruleText(foxRule)).toEqual({ text: "Dana Fox runs payroll.", retired: false });
      const aliases = await db.entityAlias.findMany({
        where: { orgId: ORG },
        select: { canonicalName: true },
        orderBy: { canonicalName: "asc" },
      });
      expect(aliases).toEqual([{ canonicalName: "Dana Fox" }, { canonicalName: OTHER_CANONICAL }]);
    });

    it("does not follow a row whose alias is the erased contact's own one-word name", async () => {
      // Her whole contact name is "Dana": still too common to tie a merge row to her.
      await db.contact.create({ data: { id: "dana-one-word", orgId: ORG, name: "Dana", email: "dana@other.example" } });
      await db.entityAlias.create({
        data: {
          orgId: ORG,
          entityType: "user",
          entityId: "merge:Dana",
          canonicalName: "Dana Fox",
          aliases: ["Dana"],
          createdBy: ADMIN,
        },
      });
      const foxRule = await recordConvention(admin, {
        kind: "convention",
        subject: "Payroll",
        text: "Dana Fox runs payroll.",
        scopePath: ROOT,
      });

      await erasePerson(admin, { contactId: "dana-one-word" });

      expect(await ruleText(foxRule)).toEqual({ text: "Dana Fox runs payroll.", retired: false });
      const aliases = await db.entityAlias.findMany({
        where: { orgId: ORG },
        select: { canonicalName: true },
        orderBy: { canonicalName: "asc" },
      });
      expect(aliases.map((a) => a.canonicalName)).toEqual(["Dana Fox", MERGED_INTO, OTHER_CANONICAL]);
    });
  },
);
