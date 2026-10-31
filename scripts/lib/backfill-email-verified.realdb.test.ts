// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The one-time `User.emailVerified` backfill against a real database and a fake
// Clerk directory: a dry run writes nothing, `--apply` writes only rows that are
// still unset and never overwrites a value, a rerun after an interruption picks up
// where the last one stopped, a 429 waits and retries, a user Clerk no longer knows
// stays unset, and no email address reaches the output. One test drives the real
// @clerk/backend client against a local HTTP fake of Clerk, so the request
// it sends and the 429 error it throws are the client's own, not a guess at them.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createClerkClient } from "@clerk/backend";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { backfillEmailVerified, type ClerkUserDirectory, type ClerkDirectoryUser } from "./backfill-email-verified";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "qa-backfill-email-verified";

interface Seed {
  id: string;
  email: string;
  emailVerified: boolean | null;
}

// Internal ids sort in this order, so pages are predictable.
const SEEDS: Seed[] = [
  { id: "bev-01-verified", email: "ada@backfill.test", emailVerified: null },
  { id: "bev-02-unverified", email: "bob@backfill.test", emailVerified: null },
  { id: "bev-03-other-verified", email: "cyd@backfill.test", emailVerified: null },
  { id: "bev-04-gone", email: "dee@backfill.test", emailVerified: null },
  { id: "bev-05-set-false", email: "eve@backfill.test", emailVerified: false },
  { id: "bev-06-set-true", email: "fay@backfill.test", emailVerified: true },
  { id: "bev-07-verified", email: "gus@backfill.test", emailVerified: null },
];

/** What Clerk holds for each seeded user; `bev-04-gone` is absent: deleted at Clerk. */
const CLERK: Record<string, ClerkDirectoryUser["emailAddresses"]> = {
  "bev-01-verified": [{ emailAddress: "Ada@Backfill.test", verification: { status: "verified" } }],
  "bev-02-unverified": [{ emailAddress: "bob@backfill.test", verification: { status: "unverified" } }],
  // Verified, but a different address than the one Willder stores: not a match.
  "bev-03-other-verified": [
    { emailAddress: "cyd@backfill.test", verification: null },
    { emailAddress: "cyd@elsewhere.test", verification: { status: "verified" } },
  ],
  // Clerk now says the opposite of what is stored; the stored value must survive.
  "bev-05-set-false": [{ emailAddress: "eve@backfill.test", verification: { status: "verified" } }],
  "bev-06-set-true": [{ emailAddress: "fay@backfill.test", verification: { status: "unverified" } }],
  "bev-07-verified": [{ emailAddress: "gus@backfill.test", verification: { status: "verified" } }],
};

const clerkIdOf = (id: string) => `clerk-${id}`;

/** A Clerk directory serving CLERK, recording each request's ids, with optional scripted failures. */
function fakeClerk(failures: (Error | null)[] = []): ClerkUserDirectory & { requests: string[][] } {
  const requests: string[][] = [];
  return {
    requests,
    users: {
      async getUserList({ userId }) {
        requests.push([...userId]);
        const failure = failures.shift();
        if (failure) throw failure;
        const data = userId.flatMap((clerkId) => {
          const id = clerkId.replace(/^clerk-/, "");
          const emailAddresses = CLERK[id];
          return emailAddresses ? [{ id: clerkId, emailAddresses }] : [];
        });
        return { data };
      },
    },
  };
}

/** The shape of the error the Clerk Backend client throws on a 429. */
function rateLimited(retryAfter?: number): Error {
  return Object.assign(new Error("Too Many Requests"), { status: 429, retryAfter });
}

describe.skipIf(!QA_URL)("backfillEmailVerified against a real database", () => {
  let db: PrismaClient;
  let lines: string[];
  let sleeps: number[];
  const log = (line: string) => lines.push(line);
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };

  async function stored(): Promise<Record<string, boolean | null>> {
    const rows = await db.user.findMany({ where: { orgId: ORG }, select: { id: true, emailVerified: true } });
    return Object.fromEntries(rows.map((r) => [r.id, r.emailVerified]));
  }

  async function wipe() {
    await db.user.deleteMany({ where: { orgId: ORG } });
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
  }

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
  });

  beforeEach(async () => {
    lines = [];
    sleeps = [];
    await wipe();
    await db.org.create({ data: { id: ORG, name: "QA backfill emailVerified" } });
    for (const s of SEEDS) {
      await db.user.create({
        data: {
          id: s.id,
          orgId: ORG,
          clerkId: clerkIdOf(s.id),
          email: s.email,
          emailVerified: s.emailVerified,
          role: "member",
        },
      });
    }
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  it("a dry run reports what it would write and writes nothing", async () => {
    const before = await stored();
    const summary = await backfillEmailVerified(db, fakeClerk(), { apply: false, pageSize: 2, orgId: ORG, log, sleep });

    expect(await stored()).toEqual(before);
    expect(summary).toMatchObject({
      apply: false,
      scanned: 5,
      verified: 2,
      unverified: 2,
      unknownToClerk: 1,
      written: 0,
      alreadySet: 0,
    });
  });

  it("--apply writes only unset rows, with the same rule sign-in uses, and never overwrites a value", async () => {
    const summary = await backfillEmailVerified(db, fakeClerk(), { apply: true, pageSize: 2, orgId: ORG, log, sleep });

    expect(await stored()).toEqual({
      "bev-01-verified": true,
      "bev-02-unverified": false,
      "bev-03-other-verified": false,
      "bev-04-gone": null,
      "bev-05-set-false": false,
      "bev-06-set-true": true,
      "bev-07-verified": true,
    });
    expect(summary).toMatchObject({ apply: true, scanned: 5, written: 4, unknownToClerk: 1, alreadySet: 0 });
  });

  it("--org leaves every other org's users unread and unwritten", async () => {
    const other = `${ORG}-other`;
    await db.org.create({ data: { id: other, name: "QA backfill emailVerified, another org" } });
    try {
      // Unset, so an unscoped run would read it and ask Clerk about it.
      await db.user.create({
        data: {
          id: "bev-00-other-org",
          orgId: other,
          clerkId: clerkIdOf("bev-00-other-org"),
          email: "hal@backfill.test",
          role: "member",
        },
      });
      const clerk = fakeClerk();

      const summary = await backfillEmailVerified(db, clerk, { apply: true, pageSize: 100, orgId: ORG, log, sleep });

      expect((await db.user.findUniqueOrThrow({ where: { id: "bev-00-other-org" } })).emailVerified).toBeNull();
      expect(summary).toMatchObject({ scanned: 5, written: 4 });
      expect(clerk.requests.flat()).not.toContain(clerkIdOf("bev-00-other-org"));
    } finally {
      await db.user.deleteMany({ where: { orgId: other } });
      await deleteOrgsWithRetry(db, { where: { id: other } });
    }
  });

  it("never overwrites a value set between reading a page and writing it", async () => {
    const clerk = fakeClerk();
    const racing: ClerkUserDirectory = {
      users: {
        async getUserList(params) {
          // A sign-in or webhook records a value while Clerk is being asked.
          await db.user.update({ where: { id: "bev-01-verified" }, data: { emailVerified: false } });
          return clerk.users.getUserList(params);
        },
      },
    };
    const summary = await backfillEmailVerified(db, racing, { apply: true, pageSize: 10, orgId: ORG, log, sleep });

    expect((await stored())["bev-01-verified"]).toBe(false);
    expect(summary).toMatchObject({ written: 3, alreadySet: 1 });
  });

  it("does not write a value computed for an address the row no longer holds", async () => {
    const clerk = fakeClerk();
    const racing: ClerkUserDirectory = {
      users: {
        async getUserList(params) {
          // The stored address changes, still unset, while Clerk is being asked about
          // the old one. Clerk verified the old address, not this one.
          await db.user.update({ where: { id: "bev-01-verified" }, data: { email: "ada-new@backfill.test" } });
          return clerk.users.getUserList(params);
        },
      },
    };
    const summary = await backfillEmailVerified(db, racing, { apply: true, pageSize: 10, orgId: ORG, log, sleep });

    expect((await stored())["bev-01-verified"]).toBeNull();
    expect(summary).toMatchObject({ written: 3, alreadySet: 1 });
  });

  it("resumes after an interruption without asking Clerk again about finished users", async () => {
    const boom = Object.assign(new Error("Service Unavailable"), { status: 503 });
    await expect(
      backfillEmailVerified(db, fakeClerk([null, boom]), { apply: true, pageSize: 2, orgId: ORG, log, sleep }),
    ).rejects.toThrow();
    const partial = await stored();
    expect(partial["bev-01-verified"]).toBe(true);
    expect(partial["bev-02-unverified"]).toBe(false);
    expect(partial["bev-03-other-verified"]).toBeNull();

    const rerun = fakeClerk();
    const summary = await backfillEmailVerified(db, rerun, { apply: true, pageSize: 2, orgId: ORG, log, sleep });

    expect(rerun.requests.flat()).not.toContain(clerkIdOf("bev-01-verified"));
    expect(rerun.requests.flat()).not.toContain(clerkIdOf("bev-02-unverified"));
    expect(summary).toMatchObject({ scanned: 3, written: 2, unknownToClerk: 1 });
    expect(await stored()).toMatchObject({
      "bev-03-other-verified": false,
      "bev-07-verified": true,
      "bev-04-gone": null,
    });
  });

  it("waits out a 429 for the Retry-After Clerk sent, then retries the same page", async () => {
    const clerk = fakeClerk([rateLimited(3), rateLimited()]);
    const summary = await backfillEmailVerified(db, clerk, { apply: true, pageSize: 10, orgId: ORG, log, sleep });

    expect(sleeps[0]).toBe(3_000);
    expect(sleeps[1]).toBeGreaterThan(0);
    expect(clerk.requests).toHaveLength(3);
    expect(summary).toMatchObject({ written: 4, rateLimitWaits: 2 });
  });

  it("gives up after the retry limit with nothing half-written", async () => {
    const clerk = fakeClerk(Array.from({ length: 10 }, () => rateLimited(1)));
    await expect(
      backfillEmailVerified(db, clerk, { apply: true, pageSize: 10, orgId: ORG, log, sleep, maxRetries: 2 }),
    ).rejects.toThrow(/rate limit/i);
    expect(clerk.requests).toHaveLength(3);
    expect((await stored())["bev-01-verified"]).toBeNull();
  });

  it("stops instead of sleeping when Clerk asks for a wait longer than the cap", async () => {
    const clerk = fakeClerk([rateLimited(86_400)]);
    await expect(
      backfillEmailVerified(db, clerk, { apply: true, pageSize: 10, orgId: ORG, log, sleep }),
    ).rejects.toThrow(/86400s.*rerun/);
    expect(sleeps).toEqual([]);
    expect(clerk.requests).toHaveLength(1);
  });

  it("leaves a user Clerk no longer knows unset, and a rerun counts it again rather than looping", async () => {
    await backfillEmailVerified(db, fakeClerk(), { apply: true, pageSize: 1, orgId: ORG, log, sleep });
    const again = await backfillEmailVerified(db, fakeClerk(), { apply: true, pageSize: 1, orgId: ORG, log, sleep });

    expect((await stored())["bev-04-gone"]).toBeNull();
    expect(again).toMatchObject({ scanned: 1, unknownToClerk: 1, written: 0 });
  });

  it("never prints an email address, only counts and internal ids", async () => {
    const summary = await backfillEmailVerified(db, fakeClerk([rateLimited(1)]), {
      apply: true,
      pageSize: 2,
      orgId: ORG,
      log,
      sleep,
    });
    const output = [...lines, JSON.stringify(summary)].join("\n");

    expect(lines.length).toBeGreaterThan(0);
    expect(output).not.toMatch(/@/);
  });

  it("works through the real @clerk/backend client, including its 429 error", async () => {
    const seen: string[][] = [];
    let listCalls = 0;
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const ids = url.searchParams.getAll("user_id");
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "Content-Type": "application/json", ...headers });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === "/v1/users/count") return json(200, { object: "total_count", total_count: ids.length });
      if (url.pathname !== "/v1/users") return json(404, { errors: [{ code: "not_found", message: "not found" }] });
      if (++listCalls === 1) {
        return json(
          429,
          { errors: [{ code: "too_many_requests", message: "Too many requests" }] },
          { "Retry-After": "2" },
        );
      }
      seen.push(ids);
      json(
        200,
        ids.flatMap((clerkId) => {
          const emails = CLERK[clerkId.replace(/^clerk-/, "")];
          if (!emails) return [];
          return [
            {
              object: "user",
              id: clerkId,
              email_addresses: emails.map((e, i) => ({
                object: "email_address",
                id: `idn_${i}`,
                email_address: e.emailAddress,
                verification: e.verification
                  ? { object: "verification", status: e.verification.status, strategy: "email_code" }
                  : null,
                linked_to: [],
              })),
            },
          ];
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const clerk = createClerkClient({ secretKey: "sk_" + "test_localstandin", apiUrl: `http://127.0.0.1:${port}` });
      const summary = await backfillEmailVerified(db, clerk, { apply: true, pageSize: 10, orgId: ORG, log, sleep });

      expect(sleeps).toEqual([2_000]);
      expect(seen).toEqual([SEEDS.filter((s) => s.emailVerified === null).map((s) => clerkIdOf(s.id))]);
      expect(summary).toMatchObject({
        scanned: 5,
        verified: 2,
        unverified: 2,
        unknownToClerk: 1,
        written: 4,
        rateLimitWaits: 1,
      });
      expect(await stored()).toMatchObject({
        "bev-01-verified": true,
        "bev-03-other-verified": false,
        "bev-04-gone": null,
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
