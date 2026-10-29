// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A person erasure reaches the session key a change event records (services/memory/person-erasure.ts).
//
// The key is a label the writer's client chose (`willder/session`), so it can name a person. It
// only links a claim to the run its own session captured (services/memory/claim-status.ts); an
// erasure clears a key that names the person, in the erased org only, and leaves every other key.
//
// Real: Postgres, check() against a live admin grant, the erasure's statements and its
// suppression list. Stand-in: the graph store, which erases nothing.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";

vi.mock("./store", () => ({
  memory: {},
  graphitiStore: {
    removeGroupFacts: async () => ({ removedCount: 0 }),
    planPersonErasure: async () => [],
    erasePerson: async () => ({ episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] }),
  },
}));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_session_key_erasure";
const OTHER_ORG = "qa_session_key_erasure_other";
const ROOT = `org_${ORG}`;
const ADMIN = "qa_session_key_erasure_admin";
const ERASED_NAME = "Orla Brennick";

describe.skipIf(!QA_URL)("a person erasure clears the session keys that name them, real Postgres", () => {
  let db: PrismaClient;
  let erasePerson: (typeof import("./person-erasure"))["erasePerson"];
  const admin: AccessContext = { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" };

  async function event(orgId: string, seq: number, sessionKey: string): Promise<string> {
    const created = await db.changeEvent.create({
      data: {
        orgId,
        seq: BigInt(seq),
        scopePath: `org_${orgId}`,
        recordType: "fact",
        recordId: `fact-${orgId}-${seq}`,
        op: "create",
        actorId: "agent-a",
        actorType: "agent",
        origin: "mcp",
        summary: "Plan: gate the redirect.",
        task: "T-1",
        sessionKey,
      },
    });
    return created.id;
  }

  async function wipe() {
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.changeEvent.deleteMany({ where: { orgId } });
      await db.erasureSuppression.deleteMany({ where: { orgId } });
      await db.contact.deleteMany({ where: { orgId } });
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.grant.deleteMany({ where: { orgId } });
      await db.scope.deleteMany({ where: { orgId } });
      await db.user.deleteMany({ where: { orgId } });
    }
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ erasePerson } = await import("./person-erasure"));
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await wipe();
    for (const orgId of [ORG, OTHER_ORG])
      await db.org.upsert({ where: { id: orgId }, update: {}, create: { id: orgId, name: orgId } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
    await db.user.create({
      data: {
        id: ADMIN,
        orgId: ORG,
        email: "admin@session-key-erasure.test",
        role: "admin",
        clerkId: "clerk-session-key-erasure-admin",
      },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    await db.contact.create({ data: { id: "orla", orgId: ORG, name: ERASED_NAME, email: "orla@brennick.example" } });
  });

  it("clears a key naming the person and keeps every other key, and the other org's", async () => {
    const naming = await event(ORG, 1, `pairing with ${ERASED_NAME} on the redirects`);
    const plain = await event(ORG, 2, "cli-session-7f3a");
    const otherOrg = await event(OTHER_ORG, 1, `pairing with ${ERASED_NAME} on the redirects`);

    await erasePerson(admin, { contactId: "orla" });

    const keyOf = async (id: string) => (await db.changeEvent.findUniqueOrThrow({ where: { id } })).sessionKey;
    expect(await keyOf(naming)).toBeNull();
    expect(await keyOf(plain)).toBe("cli-session-7f3a");
    expect(await keyOf(otherOrg)).toBe(`pairing with ${ERASED_NAME} on the redirects`);
    const keys = await db.changeEvent.findMany({ where: { orgId: ORG }, select: { sessionKey: true } });
    expect(keys.filter((e) => e.sessionKey?.includes(ERASED_NAME))).toEqual([]);
  });

  // The same matcher as every other erased column (services/memory/person-name-characters.ts): a
  // dash continues a word, so "OrlaBrennick-Barnes" and "Orla Brennickson" are other people's.
  it("clears a key under every spelling the erasure matches a name in, and keeps another person's", async () => {
    const spellings = [
      "orla_brennick-run",
      "OrlaBrennick redirects",
      "pairing with orla%20brennick",
      "pairing with \uFF2Frla \uFF22rennick",
      "Brennick, Orla",
      "brennick orla",
    ];
    const naming = await Promise.all(spellings.map((key, i) => event(ORG, 10 + i, key)));
    const others = ["pairing with Orla Brennickson", "OrlaBrennick-Barnes review"];
    const kept = await Promise.all(others.map((key, i) => event(ORG, 30 + i, key)));

    await erasePerson(admin, { contactId: "orla" });

    const keyOf = async (id: string) => (await db.changeEvent.findUniqueOrThrow({ where: { id } })).sessionKey;
    expect(await Promise.all(naming.map(keyOf))).toEqual(spellings.map(() => null));
    expect(await Promise.all(kept.map(keyOf))).toEqual(others);
  });
});
