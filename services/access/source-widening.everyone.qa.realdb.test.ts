// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Two widening cases the route suite does not reach:
// - An `everyone` grant on an ancestor makes every person in the org a reader of
//   the scope, including one with no grant of their own. Dropping that branch of
//   scopeReaders() under-counts the widening, the one direction it must never err.
// - The no-email placeholder never matches a source reader, even if the row were
//   somehow marked verified: it names no real account.
//
// Real: scopeAudience() against Postgres, computeWidening() on its result.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "qawidenall";
const ROOT = `org_${ORG}`;
const SCOPE = `${ROOT}.open`;
const CONNECTOR = "u-all-connector";
const NOGRANT = "u-all-nogrant";
const PLACEHOLDER = "u-all-placeholder";
const OTHER_ORG = "qawidenall2";
const FOREIGN = "u-all-foreign";

describe.skipIf(!QA_URL)("source widening with an everyone grant, real Postgres", () => {
  let db: PrismaClient;
  let access: typeof import("@/services/access");

  async function wipe() {
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.grant.deleteMany({ where: { orgId } });
      await db.scope.deleteMany({ where: { orgId } });
      await db.user.deleteMany({ where: { orgId } });
      await db.org.deleteMany({ where: { id: orgId } });
    }
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    access = await import("@/services/access");
    await wipe();
    await db.org.create({ data: { id: ORG, name: "QA widening everyone" } });
    await db.org.create({ data: { id: OTHER_ORG, name: "QA widening other org" } });
    const users: [string, string, string, boolean][] = [
      [CONNECTOR, ORG, `${CONNECTOR}@all.test`, true],
      [NOGRANT, ORG, `${NOGRANT}@all.test`, true],
      // Marked verified on purpose: the placeholder must still never match.
      [PLACEHOLDER, ORG, `${PLACEHOLDER}@no-email.local`, true],
      [FOREIGN, OTHER_ORG, `${FOREIGN}@all.test`, true],
    ];
    for (const [id, orgId, email, emailVerified] of users) {
      await db.user.create({
        data: { id, orgId, email, emailVerified, role: "member", clerkId: `clerk-${id}`, name: id },
      });
    }
    const root = (await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } })).id;
    await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "open" } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root, granteeType: "everyone", granteeId: "*", permission: "read" },
    });
  }, 60_000);

  afterAll(async () => {
    await wipe();
    await db.$disconnect();
  });

  it("counts a person with no grant of their own when everyone can read an ancestor, and only this org's people", async () => {
    const audience = await access.scopeAudience(ORG, SCOPE);
    expect(audience.people.map((p) => p.id).sort()).toEqual([CONNECTOR, NOGRANT, PLACEHOLDER].sort());

    const widening = access.computeWidening(audience, CONNECTOR, {
      kind: "known",
      readers: [{ kind: "email", email: `${CONNECTOR}@all.test` }],
    });
    expect(widening).toEqual({ status: "known", people: 2, agents: 0 });
  });

  it("never matches the no-email placeholder, even marked verified and listed at the source", async () => {
    const audience = await access.scopeAudience(ORG, SCOPE);
    const widening = access.computeWidening(audience, CONNECTOR, {
      kind: "known",
      readers: [
        { kind: "email", email: `${NOGRANT}@all.test` },
        { kind: "email", email: `${PLACEHOLDER}@no-email.local` },
        { kind: "domain", domain: "no-email.local" },
      ],
    });
    expect(widening).toEqual({ status: "known", people: 1, agents: 0 });
    expect(access.decideWidening(widening, undefined)).toEqual({
      proceed: false,
      acknowledge: { people: 1, agents: 0 },
    });
  });
});
