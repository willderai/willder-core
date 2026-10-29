import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedMember } from "@/services/access/member.testsupport";

// A nav badge count the database cannot answer is reported as null, never 0.
//
// The unit tests beside the route and the two count services mock the failure. This
// file makes Postgres itself fail: it renames the one table a count reads, so the
// real SQL hits a real "relation does not exist" error, then checks the route and
// the service. The other two counts must still answer with their real numbers, and
// the failed one must come back null, not the 0 a quiet period would give.
//
// Renaming a table changes the whole database, so run this file on its own against
// an ISOLATED test database (QA_DATABASE_URL). Skips cleanly when unset.
const QA_URL = process.env.QA_DATABASE_URL;
if (QA_URL) process.env.DATABASE_URL = QA_URL;

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

const ORG = "orgNavBadgeDbError";
const ROOT = `org_${ORG}`;
const USER = "user_root_reader";
const SINCE = "2026-01-01T00:00:00.000Z";
const ANSWERED = { activeAgentRuns: 2, newContacts: 3, newMemoryChunks: 4 };

describe.skipIf(!QA_URL)("GET /api/nav/badges when Postgres cannot run one count", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let db: any, requireAccessContext: any, badgesGET: any;
  let countVisibleRunningRuns: any, countNewChunksInScopes: any;

  const badges = async () => {
    vi.mocked(requireAccessContext).mockResolvedValue({
      org: { id: ORG, name: ORG },
      user: { id: USER, role: "member" },
      ctx: { orgId: ORG, actor: { type: "human", id: USER, role: "member" } },
    } as never);
    const res = await badgesGET(new Request(`http://t/api/nav/badges?since=${SINCE}`));
    expect(res.status).toBe(200);
    return res.json();
  };

  /** Run `body` while `table` is missing, so every query on it fails in Postgres. */
  const withoutTable = async (table: string, body: () => Promise<void>) => {
    await db.$executeRawUnsafe(`ALTER TABLE "${table}" RENAME TO "${table}_qa_hidden"`);
    try {
      await body();
    } finally {
      await db.$executeRawUnsafe(`ALTER TABLE "${table}_qa_hidden" RENAME TO "${table}"`);
    }
  };

  const clean = async () => {
    for (const table of [
      "audit_log",
      "grants",
      "memory_chunks",
      "agent_runs",
      "agents",
      "contacts",
      "scopes",
      "org_memberships",
    ]) {
      await db.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "orgId" = $1`, ORG).catch(() => {});
    }
  };

  beforeAll(async () => {
    ({ db } = await import("@/lib/db"));
    ({ requireAccessContext } = await import("@/lib/access-context"));
    ({ GET: badgesGET } = await import("./nav/badges/route"));
    ({ countVisibleRunningRuns } = await import("@/services/agents/run-visibility"));
    ({ countNewChunksInScopes } = await import("@/services/memory/activity-counts"));
    await db.$executeRawUnsafe(
      `INSERT INTO "orgs" ("id","name","updatedAt") VALUES ($1,$1,NOW()) ON CONFLICT ("id") DO NOTHING`,
      ORG,
    );
    await clean();
    await db.$executeRawUnsafe(
      `INSERT INTO "scopes" ("id","orgId","path","name") VALUES ($1,$2,$3,$3)`,
      `sc_${ROOT}`,
      ORG,
      ROOT,
    );
    await seedMember(db, { orgId: ORG, userId: USER });
    await db.$executeRawUnsafe(
      `INSERT INTO "grants" ("id","orgId","scopeId","granteeType","granteeId","permission")
       VALUES ('g_root_reader',$1,(SELECT "id" FROM "scopes" WHERE "orgId"=$1 AND "path"=$2),'user',$3,'read')`,
      ORG,
      ROOT,
      USER,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "agents" ("id","orgId","agentKey","name","role","updatedAt") VALUES ('agentDbErr',$1,'qa','QA','qa',NOW())`,
      ORG,
    );
    for (let i = 0; i < ANSWERED.activeAgentRuns; i++) {
      await db.$executeRawUnsafe(
        `INSERT INTO "agent_runs" ("id","orgId","agentId","status","meta","startedAt")
         VALUES ($1,$2,'agentDbErr','running'::"AgentRunStatus",$3::jsonb,NOW())`,
        `run_dberr_${i}`,
        ORG,
        JSON.stringify({ scopePath: ROOT }),
      );
    }
    for (let i = 0; i < ANSWERED.newContacts; i++) {
      await db.$executeRawUnsafe(
        `INSERT INTO "contacts" ("id","orgId","name","updatedAt") VALUES ($1,$2,'Jane',NOW())`,
        `contact_dberr_${i}`,
        ORG,
      );
    }
    for (let i = 0; i < ANSWERED.newMemoryChunks; i++) {
      await db.$executeRawUnsafe(
        `INSERT INTO "memory_chunks" ("id","orgId","content","scopePath","createdAt") VALUES ($1,$2,'c',$3,NOW())`,
        `ch_dberr_${i}`,
        ORG,
        ROOT,
      );
    }
  });

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterAll(async () => {
    await clean();
    await db.org.deleteMany({ where: { id: ORG } });
    await db?.$disconnect?.();
  });

  it("answers all three counts when Postgres answers", async () => {
    await expect(badges()).resolves.toEqual(ANSWERED);
  });

  it.each([
    ["activeAgentRuns", "agent_runs"],
    ["newContacts", "contacts"],
    ["newMemoryChunks", "memory_chunks"],
  ] as const)(
    "reports %s as null when its table (%s) cannot be read, and still answers the others",
    async (field, table) => {
      await withoutTable(table, async () => {
        const body = await badges();
        expect(body).toEqual({ ...ANSWERED, [field]: null });
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining(field), expect.anything());
      });
      // Restored table: the count answers again, so null was the failure and nothing else.
      await expect(badges()).resolves.toEqual(ANSWERED);
    },
  );

  it("countVisibleRunningRuns rejects on a real Postgres error instead of answering 0", async () => {
    await withoutTable("agent_runs", async () => {
      await expect(countVisibleRunningRuns(ORG, [ROOT])).rejects.toThrow(/agent_runs/);
    });
  });

  it("countNewChunksInScopes rejects on a real Postgres error instead of answering 0", async () => {
    await withoutTable("memory_chunks", async () => {
      await expect(countNewChunksInScopes(ORG, [ROOT], new Date(SINCE))).rejects.toThrow(/memory_chunks/);
    });
  });
});
