// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The alias half of person erasure (services/memory/person-erasure.ts,
// resolveTargets): an alias row in the shape the entity merge route writes
// (app/api/memory/entities/merge/route.ts: entityType "user", entityId "merge:<old name>",
// canonicalName the name it was merged into) is tied to no contact id, so only its canonical
// name links it to the person. Erasing her must then erase by the merged-away name too, in rules
// and in chunks, and remove that registry row; another person's merge row and what names them
// stay.
//
// Real: Postgres, check(), recordConvention, the erasure. Fake: the graph store.
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

const ORG = "qa_erasure_merged_alias";
const ROOT = `org_${ORG}`;
const ADMIN = "qa_erasure_merged_alias_admin";
const DIMENSIONS = 384;

const NAME = "Dana Whitfield";
const EMAIL = "dana.w@acme.example";
/** A name merged into hers in the graph, recorded the way the merge route records it. */
const MERGED_AWAY = "Dee Whitfield";
/** Someone else's merge: a different person, with names that never name her. */
const OTHER_CANONICAL = "Pat Lee";
const OTHER_MERGED_AWAY = "Patrick Lee";

describe.skipIf(!QA_URL)("person erasure follows an alias row the merge route wrote, by its canonical name", () => {
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
    // Exactly what upsertAlias(org, `merge:${fromName}`, "user", toName, [fromName], ...) stores.
    await db.entityAlias.create({
      data: {
        orgId: ORG,
        entityType: "user",
        entityId: `merge:${MERGED_AWAY}`,
        canonicalName: NAME,
        aliases: [MERGED_AWAY],
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
      text: `${MERGED_AWAY} signs off on refunds.`,
      scopePath: ROOT,
    });
    otherRule = await recordConvention(admin, {
      kind: "convention",
      subject: "Vendors",
      text: `${OTHER_MERGED_AWAY} picks vendors.`,
      scopePath: ROOT,
    });
    await chunk("chunk-her", `Ask ${MERGED_AWAY} before refunding.`);
    await chunk("chunk-other", `Ask ${OTHER_MERGED_AWAY} about vendors.`);
  });

  it("erases by the merged-away name and removes her merge row; the other person's row and text stay", async () => {
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
});
