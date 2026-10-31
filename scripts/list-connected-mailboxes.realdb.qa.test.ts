// scripts/list-connected-mailboxes.ts run as the operator runs it, against a real
// database: it lists only mailbox connections that still hold a grant, names them by
// internal id and never by address, and writes nothing.
//
// The unit tests cover the formatting helpers; the query that picks the rows is
// only exercised here. A listing that also counted disconnected or token-less rows
// would overstate what is left to revoke.
//
// Set QA_DATABASE_URL to an isolated test database (never the inherited
// DATABASE_URL); the suite skips without it.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "listmailboxesqa";
const run = promisify(execFile);

describe.skipIf(!QA_URL)("list-connected-mailboxes against a real database", () => {
  let db: PrismaClient;

  async function clearTenant() {
    await db.integration.deleteMany({ where: { orgId: ORG } });
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
  }

  async function snapshot() {
    return db.integration.findMany({ where: { orgId: ORG }, orderBy: { id: "asc" } });
  }

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
    await clearTenant();
    await db.org.create({ data: { id: ORG, name: "List mailboxes QA" } });
    const live = Date.now() + 3 * 24 * 3600 * 1000;
    await db.integration.createMany({
      data: [
        {
          id: "lm_gmail_live",
          orgId: ORG,
          provider: "gmail",
          status: "connected",
          externalAccountId: "g1",
          encryptedTokens: "sealed",
          meta: { email: "sales@acme.example", gmailWatchExpires: String(live) },
        },
        {
          id: "lm_outlook_nowatch",
          orgId: ORG,
          provider: "outlook",
          status: "connected",
          externalAccountId: "o1",
          encryptedTokens: "sealed",
          meta: { email: "ops@acme.example" },
        },
        {
          id: "lm_gmail_disconnected",
          orgId: ORG,
          provider: "gmail",
          status: "disconnected",
          externalAccountId: null,
          encryptedTokens: null,
          meta: { email: "old@acme.example" },
        },
        {
          id: "lm_gmail_pending",
          orgId: ORG,
          provider: "gmail",
          status: "pending",
          externalAccountId: null,
          encryptedTokens: null,
          meta: {},
        },
        {
          id: "lm_gmail_connected_no_token",
          orgId: ORG,
          provider: "gmail",
          status: "connected",
          externalAccountId: "g2",
          encryptedTokens: null,
          meta: {},
        },
        {
          id: "lm_slack",
          orgId: ORG,
          provider: "slack",
          status: "connected",
          externalAccountId: "T1",
          encryptedTokens: "sealed",
          meta: {},
        },
      ],
    });
  });

  afterAll(async () => {
    await clearTenant();
    await db.$disconnect();
  });

  it("lists only connected mailboxes that hold a token, by id, and writes nothing", async () => {
    const before = await snapshot();
    const { stdout } = await run("npx", ["tsx", "scripts/list-connected-mailboxes.ts"], {
      env: { ...process.env, DATABASE_URL: QA_URL },
    });
    const ours = stdout.split("\n").filter((line) => line.includes(`org ${ORG}`));

    expect(ours.map((line) => line.split("\t")[1]).sort()).toEqual(["lm_gmail_live", "lm_outlook_nowatch"]);
    expect(ours.find((line) => line.includes("lm_gmail_live"))).toMatch(/watch live until /);
    expect(ours.find((line) => line.includes("lm_outlook_nowatch"))).toMatch(/no watch recorded/);
    expect(stdout).not.toMatch(/acme\.example/);
    expect(await snapshot()).toEqual(before);
  });

  it("refuses arguments rather than doing anything but list", async () => {
    await expect(
      run("npx", ["tsx", "scripts/list-connected-mailboxes.ts", "--revoke"], {
        env: { ...process.env, DATABASE_URL: QA_URL },
      }),
    ).rejects.toMatchObject({ stderr: expect.stringMatching(/takes no arguments/) });
  });
});
