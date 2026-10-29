// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A person erasure reaches the rules (conventions and decisions) that name the person
// (services/memory/erasure-rules.ts): in every scope of the org, by their name, address or a
// registered alias, and every rule version written in place of one, with the fact each rule's
// text was also stored as. Rules elsewhere stay as they were: in another org, naming another
// person whose name contains hers, and a version an erased rule merely beat in a race. After a
// backup taken before the erasure is restored, re-applying erasures redacts the restored rules
// again, and leaves a rule naming her written after the erasure.
//
// Real: Postgres, check(), recordConvention, the erasure, the suppression list, the task-start
// read and the re-apply. Stand-in: the graph store, a spy (its own rule is proven on Neo4j in
// memory-service/tests/test_person_erasure_integration.py).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";

const removeChunkFacts = vi.fn();
vi.mock("./store", () => ({
  memory: {},
  graphitiStore: {
    planPersonErasure: async () => [],
    erasePerson: async () => ({ episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] }),
    removeChunkFacts: (...a: unknown[]) => removeChunkFacts(...a),
    removeEpisode: async () => ({ removed: true }),
  },
}));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_erasure_rules";
const OTHER_ORG = "qa_erasure_rules_other";
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.sales`;
const SUPPORT = `${ROOT}.support`;
const OTHER_ROOT = `org_${OTHER_ORG}`;
const ADMIN = "qa_erasure_rules_admin";
const OTHER_ADMIN = "qa_erasure_rules_other_admin";
const DIMENSIONS = 384;

const NAME = "Dana Whitfield";
const EMAIL = "dana.w@acme.example";
/** Registered for her contact in the alias registry: a name, an address and a one-word nickname. */
const ALIAS = "Dee Whitfield";
const ALIAS_EMAIL = "dee@personal.example";
const NICKNAME = "Dee";
const MARKERS = [NAME, EMAIL, ALIAS, ALIAS_EMAIL];

/** Which markers `value` holds, outside the bystander's own name, which contains hers. */
const markersIn = (value: unknown) => {
  const text = JSON.stringify(value, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v))
    .replaceAll(`${NAME}-Barnes`, "")
    .toLowerCase();
  return MARKERS.filter((m) => text.includes(m.toLowerCase()));
};

describe.skipIf(!QA_URL)("a person erasure redacts the rules that name the person, and what replaced them", () => {
  let db: PrismaClient;
  let erasePerson: (typeof import("./person-erasure"))["erasePerson"];
  let reapplyErasures: (typeof import("./erasure-reapply"))["reapplyErasures"];
  let recordConvention: (typeof import("./conventions"))["recordConvention"];
  let recordChangeEvent: (typeof import("./change-events"))["recordChangeEvent"];
  let readTaskStartUnchecked: (typeof import("./task-start"))["readTaskStartUnchecked"];

  const admin: AccessContext = { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" };
  const otherAdmin: AccessContext = {
    orgId: OTHER_ORG,
    actor: { type: "human", id: OTHER_ADMIN, role: "admin" },
    origin: "app",
  };

  /** Rule ids by role in the fixture. */
  let rules: Record<string, string>;

  async function wipe() {
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.taskStartServedItem.deleteMany({ where: { orgId } });
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${orgId}`;
      await db.factEdge.deleteMany({ where: { orgId } });
      // Newest first: a rule's replacement holds a reference to it.
      for (const rule of await db.convention.findMany({
        where: { orgId },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      })) {
        await db.convention.updateMany({ where: { orgId, supersedesId: rule.id }, data: { supersedesId: null } });
      }
      await db.convention.deleteMany({ where: { orgId } });
      await db.changeEvent.deleteMany({ where: { orgId } });
      await db.erasureSuppression.deleteMany({ where: { orgId } });
      await db.entityAlias.deleteMany({ where: { orgId } });
      await db.contact.deleteMany({ where: { orgId } });
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.grant.deleteMany({ where: { orgId } });
      await db.scope.deleteMany({ where: { orgId } });
      await db.user.deleteMany({ where: { orgId } });
    }
  }

  async function seedOrg(orgId: string, root: string, adminId: string, scopes: string[]) {
    await db.org.upsert({ where: { id: orgId }, update: {}, create: { id: orgId, name: orgId } });
    const rootScope = await db.scope.create({ data: { orgId, path: root, name: "root" } });
    for (const path of scopes) await db.scope.create({ data: { orgId, path, name: path.split(".").pop()! } });
    await db.user.create({
      data: { id: adminId, orgId, email: `${adminId}@rules.test`, role: "admin", clerkId: `clerk-${adminId}` },
    });
    await db.grant.create({
      data: { orgId, scopeId: rootScope.id, granteeType: "user", granteeId: adminId, permission: "admin" },
    });
  }

  async function rule(ctx: AccessContext, scopePath: string, subject: string, text: string, supersedes?: string) {
    return recordConvention(ctx, { kind: "convention", subject, text, scopePath, supersedes });
  }

  /** The fact memory_ingest stores a rule's text as, announced under the decision that admitted the rule. */
  async function factCopy(ruleId: string, chunkId: string) {
    const r = await db.convention.findUniqueOrThrow({ where: { id: ruleId } });
    const created = await db.changeEvent.findFirstOrThrow({
      where: { orgId: r.orgId, recordType: "convention", recordId: ruleId, op: "create" },
    });
    expect(created.authorizedById).not.toBeNull();
    await db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","entityName","scopePath","embedding")
      VALUES (${chunkId}, ${r.orgId}, ${r.text}, 'text', 'agent', ${r.subject}, ${r.scopePath},
              ${`[${[1, ...Array(DIMENSIONS - 1).fill(0)].join(",")}]`}::vector)
    `;
    await db.$transaction((tx) =>
      recordChangeEvent(tx, {
        orgId: r.orgId,
        scopePath: r.scopePath,
        recordType: "fact",
        recordId: chunkId,
        op: "create",
        actorId: "agent-ingest",
        actorType: "agent",
        origin: "mcp",
        title: `${r.subject}: ${r.text}`,
        authorizedById: created.authorizedById!,
      }),
    );
  }

  /** The rules the task-start read serves in `scopePath`, by id. */
  async function served(scopePath: string): Promise<string[]> {
    return (await readTaskStartUnchecked(admin, scopePath, "", "")).context.rules.map((r) => r.id).sort();
  }

  const redacted = async (id: string) => {
    const r = await db.convention.findUniqueOrThrow({ where: { id } });
    return r.subject === "" && r.text === "" && r.retiredAt !== null;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ erasePerson } = await import("./person-erasure"));
    ({ reapplyErasures } = await import("./erasure-reapply"));
    ({ recordConvention } = await import("./conventions"));
    ({ recordChangeEvent } = await import("./change-events"));
    ({ readTaskStartUnchecked } = await import("./task-start"));
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  beforeEach(async () => {
    removeChunkFacts.mockReset();
    removeChunkFacts.mockResolvedValue(undefined);
    await wipe();
    await seedOrg(ORG, ROOT, ADMIN, [SALES, SUPPORT]);
    await seedOrg(OTHER_ORG, OTHER_ROOT, OTHER_ADMIN, []);

    await db.contact.create({ data: { id: "dana", orgId: ORG, name: NAME, email: EMAIL } });
    await db.contact.create({ data: { id: "dana-other", orgId: OTHER_ORG, name: NAME, email: EMAIL } });
    await db.entityAlias.create({
      data: {
        orgId: ORG,
        entityType: "contact",
        entityId: "dana",
        canonicalName: NAME,
        aliases: [ALIAS, ALIAS_EMAIL, NICKNAME],
      },
    });
    await db.entityAlias.create({
      data: { orgId: OTHER_ORG, entityType: "contact", entityId: "dana-other", canonicalName: NAME, aliases: [ALIAS] },
    });

    rules = {};
    // Naming her, in sibling scopes: by name, by address, by a registered alias and its address,
    // and as the whole subject, surname first.
    rules.byName = await rule(admin, SALES, "Renewals", `${NAME} approves renewals over $50k.`);
    rules.byEmail = await rule(admin, SUPPORT, "Escalations", `Page ${EMAIL} for P1 incidents.`);
    rules.byAlias = await rule(admin, SUPPORT, "Refund sign-off", `${ALIAS} signs off on refunds.`);
    rules.byAliasEmail = await rule(admin, SALES, "Contracts", `Send redlines to ${ALIAS_EMAIL}.`);
    rules.bySubject = await rule(admin, SALES, "Whitfield, Dana", "Prefers written updates.");
    // A chain: a rule naming nobody, replaced by one naming her, replaced by one naming nobody.
    rules.before = await rule(admin, SALES, "Discounts", "Discounts need two approvals.");
    rules.naming = await rule(admin, SALES, "Discounts", `${NAME} approves discounts.`, rules.before);
    rules.after = await rule(admin, SALES, "Discounts", "Finance approves discounts.", rules.naming);
    // A race: the winner names nobody; the version it beat names her.
    rules.raced = await rule(admin, SUPPORT, "On-call", "Support rotates on-call weekly.");
    rules.winner = await rule(admin, SUPPORT, "On-call", "Support rotates on-call daily.", rules.raced);
    const loser = await db.convention.create({
      data: {
        orgId: ORG,
        scopePath: SUPPORT,
        kind: "convention",
        subject: "On-call",
        text: `${NAME} is always on call.`,
        actorId: ADMIN,
        supersededById: rules.winner,
      },
    });
    rules.loser = loser.id;
    // Other people: a longer name containing hers, and a one-word nickname, which names too many people.
    rules.barnes = await rule(admin, SALES, "Procurement", `${NAME}-Barnes owns procurement.`);
    rules.nickname = await rule(admin, SUPPORT, "Billing", `${NICKNAME} owns billing.`);
    // Another org's rule, naming someone with her name and address.
    rules.otherOrg = await rule(otherAdmin, OTHER_ROOT, "Renewals", `${NAME} (${EMAIL}) approves renewals.`);

    await factCopy(rules.byName, "fact-by-name");
    await factCopy(rules.after, "fact-after");
    await factCopy(rules.barnes, "fact-barnes");
    await factCopy(rules.otherOrg, "fact-other-org");

    // A served block named the rule naming her, and one naming a bystander.
    for (const [position, itemId] of [rules.byName, rules.barnes].entries()) {
      await db.taskStartServedItem.create({
        data: {
          orgId: ORG,
          agentId: "agent-sales",
          sessionKey: "s1",
          scopePath: SALES,
          taskKey: "",
          servingId: "serving-1",
          position: position + 1,
          lineCount: 2,
          itemType: "convention",
          itemId,
          namedId: itemId,
        },
      });
    }

    // Positive controls: before the erasure, every rule naming her is served where it lives.
    expect(await served(SALES)).toEqual(
      [rules.after, rules.barnes, rules.byAliasEmail, rules.byName, rules.bySubject].sort(),
    );
    expect(await served(SUPPORT)).toEqual([rules.byAlias, rules.byEmail, rules.nickname, rules.winner].sort());
  });

  const ERASED = ["byName", "byEmail", "byAlias", "byAliasEmail", "bySubject", "naming", "after", "loser"];
  const KEPT = ["before", "raced", "winner", "barnes", "nickname"];

  it("redacts and retires every rule naming her in every scope, and every version written in place of one", async () => {
    const result = await erasePerson(admin, { contactId: "dana" });

    expect(result.rulesRedacted).toBe(ERASED.length);
    for (const role of ERASED) expect([role, await redacted(rules[role])]).toEqual([role, true]);
    for (const role of KEPT) expect([role, await redacted(rules[role])]).toEqual([role, false]);

    // Nothing she was named in is served; the version the erased chain replaced stays out of
    // service, since the redacted rows still replace it.
    expect(await served(SALES)).toEqual([rules.barnes]);
    expect(await served(SUPPORT)).toEqual([rules.nickname, rules.winner].sort());

    // The rows hold nothing she was named in, and neither does the feed.
    expect(markersIn(await db.convention.findMany({ where: { orgId: ORG } }))).toEqual([]);
    expect(markersIn(await db.changeEvent.findMany({ where: { orgId: ORG } }))).toEqual([]);
    // Each rule that was in force is announced as gone, with no text.
    const deletes = await db.changeEvent.findMany({ where: { orgId: ORG, recordType: "convention", op: "delete" } });
    expect(deletes.map((e) => e.recordId).sort()).toEqual(
      ["byName", "byEmail", "byAlias", "byAliasEmail", "bySubject", "after"].map((role) => rules[role]).sort(),
    );
    expect(deletes.every((e) => e.summary === "")).toBe(true);
    // Every event about a redacted rule is blank, the replacement's too, whose text named nobody.
    const about = await db.changeEvent.findMany({
      where: { orgId: ORG, recordType: "convention", recordId: { in: ERASED.map((role) => rules[role]) } },
    });
    expect(about.filter((e) => e.summary !== "").map((e) => e.recordId)).toEqual([]);
    expect(about.some((e) => e.recordId === rules.after && e.op === "create")).toBe(true);

    // The facts their text was stored as went, the bystander's stayed. The one naming her went
    // with the chunks that name her; the replacement's, whose text names nobody, through its
    // rule; each with its graph copy first.
    const facts = await db.$queryRaw<{ id: string }[]>`SELECT id FROM memory_chunks WHERE "orgId" = ${ORG} ORDER BY id`;
    expect(facts.map((f) => f.id)).toEqual(["fact-barnes"]);
    expect(removeChunkFacts.mock.calls.map(([arg]) => (arg as { chunkId: string }).chunkId)).toEqual([
      "fact-by-name",
      "fact-after",
    ]);

    // The task-start log forgot the rule naming her, and kept the bystander's line.
    expect((await db.taskStartServedItem.findMany({ where: { orgId: ORG } })).map((r) => r.itemId)).toEqual([
      rules.barnes,
    ]);
    // Her aliases left the registry.
    expect(await db.entityAlias.count({ where: { orgId: ORG } })).toBe(0);

    // The audit row counts the rules, and names nothing.
    const [row] = await db.auditLog.findMany({ where: { orgId: ORG, action: "person.erased" } });
    expect((row!.metadata as { stores: { rules: unknown } }).stores.rules).toEqual({ rules: ERASED.length });
    expect(markersIn(row)).toEqual([]);
  });

  it("touches nothing in another org", async () => {
    await erasePerson(admin, { contactId: "dana" });

    const other = await db.convention.findUniqueOrThrow({ where: { id: rules.otherOrg } });
    expect([other.text, other.retiredAt]).toEqual([`${NAME} (${EMAIL}) approves renewals.`, null]);
    expect(await db.$queryRaw`SELECT id FROM memory_chunks WHERE "orgId" = ${OTHER_ORG}`).toEqual([
      { id: "fact-other-org" },
    ]);
    expect(await db.entityAlias.count({ where: { orgId: OTHER_ORG } })).toBe(1);
    expect(markersIn(await db.changeEvent.findMany({ where: { orgId: OTHER_ORG } }))).toEqual(MARKERS.slice(0, 2));
  });

  it("finds them by email alone, once the request names no contact", async () => {
    await db.entityAlias.deleteMany({ where: { orgId: ORG } });
    await db.contact.deleteMany({ where: { orgId: ORG } });

    const result = await erasePerson(admin, { email: EMAIL });

    // Without the contact there is no name and no alias to go by: only what names her address
    // goes, with the version written in place of nothing.
    expect(result.rulesRedacted).toBe(1);
    expect(await redacted(rules.byEmail)).toBe(true);
    expect(await redacted(rules.byName)).toBe(false);
  });

  it("redacts a rule written naming her, and a replacement of an erased one, while the request ran", async () => {
    // The graph copies of the rules' facts are removed outside any transaction, after the rules
    // step has chosen its rules: two writes land there.
    removeChunkFacts.mockImplementationOnce(async () => {
      await rule(admin, SUPPORT, "Vendors", `${NAME} picks vendors.`);
      await db.convention.create({
        data: {
          orgId: ORG,
          scopePath: SALES,
          kind: "convention",
          subject: "Discounts",
          text: "Sales approves discounts.",
          actorId: ADMIN,
          supersedesId: rules.after,
        },
      });
    });

    const result = await erasePerson(admin, { contactId: "dana" });

    expect(result.rulesRedacted).toBe(ERASED.length + 2);
    expect(markersIn(await db.convention.findMany({ where: { orgId: ORG } }))).toEqual([]);
    expect(await served(SALES)).toEqual([rules.barnes]);
    expect(await db.convention.count({ where: { orgId: ORG, text: "Sales approves discounts." } })).toBe(0);
  });

  it("redacts nothing twice when the request is sent again", async () => {
    await erasePerson(admin, { contactId: "dana" });
    const before = await db.convention.findMany({ where: { orgId: ORG }, orderBy: { id: "asc" } });

    const again = await erasePerson(admin, { email: EMAIL });

    expect(again.rulesRedacted).toBe(0);
    expect(await db.convention.findMany({ where: { orgId: ORG }, orderBy: { id: "asc" } })).toEqual(before);
  });

  it("after a backup from before the erasure is restored, re-applying redacts the restored rules again", async () => {
    const backup = await db.convention.findMany({ where: { orgId: ORG } });
    await erasePerson(admin, { contactId: "dana" });
    // Written naming her after the erasure: a deliberate act, not the old copy coming back.
    const later = await rule(admin, SALES, "Partners", `${NAME} rejoined as a partner.`);

    // A restore of the rules table from the backup, with the suppression list kept.
    for (const r of backup)
      await db.convention.update({
        where: { id: r.id },
        data: { subject: r.subject, text: r.text, retiredAt: r.retiredAt, retiredBy: r.retiredBy },
      });
    expect(markersIn(await db.convention.findMany({ where: { orgId: ORG, id: { not: later } } }))).toEqual(MARKERS);

    const result = await reapplyErasures(admin);

    // Found by their text (her name, address, alias and alias address, as the suppression list
    // keeps them), and the replacement that names nobody by its id.
    expect(result.rulesRedacted).toBe(ERASED.length);
    for (const role of ERASED) expect([role, await redacted(rules[role])]).toEqual([role, true]);
    for (const role of KEPT) expect([role, await redacted(rules[role])]).toEqual([role, false]);
    expect(await redacted(later)).toBe(false);
    expect(await served(SALES)).toEqual([rules.barnes, later].sort());

    // A second run finds nothing.
    expect((await reapplyErasures(admin)).rulesRedacted).toBe(0);
  });
});
