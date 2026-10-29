import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedMember } from "@/services/access/member.testsupport";

// Every number the nav badge returns counts only records the caller may read.
//
// The defect this file pins: the badge counted memory chunks and running agent
// runs for the whole organisation, with no scope predicate and no gate, while the
// contact badge beside them was gated. A member granted read on one narrow scope
// therefore learned how much content was ingested, and how much agent work was
// running, inside scopes they cannot read — the existence of the work, if not its
// text, which is the fact a scoped-access product exists to withhold.
//
// Real Postgres, real grants, real ltree and the real route, because that is the
// only way to show WHO the counts admit: a mocked count can only return what the
// fixture is told to return, and the sibling-matching trap below is a property of
// the generated SQL, not of the handler's shape.
//
// The sibling trap: scope labels may contain `_`, which Postgres LIKE reads as
// "any single character". A count written with Prisma `startsWith` (an unescaped
// LIKE) therefore matches a sibling — a reader granted `dept_sales` would count
// `deptXsales` too. SIBLING below is exactly that scope, so this file fails if
// the escaping is ever dropped.
//
// Set QA_DATABASE_URL to an ISOLATED test database. It is assigned to
// DATABASE_URL because lib/db.ts reads that at import time — never point it at an
// inherited DATABASE_URL, which may be live. Skips cleanly when unset.
const QA_URL = process.env.QA_DATABASE_URL;
if (QA_URL) process.env.DATABASE_URL = QA_URL;

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

const ORG = "orgNavBadge";
const ROOT = `org_${ORG}`;
/** The granted scope. Its `_` is the sibling-matching trap an unescaped LIKE falls into. */
const GRANTED = `${ROOT}.dept_sales`;
/** A real sibling scope whose label differs from GRANTED only where the `_` is. */
const SIBLING = `${ROOT}.deptXsales`;
/** A descendant of that sibling: what an unescaped `dept_sales.%` LIKE pattern matches. */
const SIBLING_CHILD = `${SIBLING}.west`;
/** A sibling under no relation to the granted scope at all. */
const OTHER = `${ROOT}.eng`;
/** A descendant of the granted scope: genuinely readable through the grant. */
const CHILD = `${GRANTED}.west`;

const AGENT = "agentNavBadge";
const SINCE = "2026-01-01T00:00:00.000Z";

describe.skipIf(!QA_URL)("security-nav-badge-org-wide-count-20261005: GET /api/nav/badges", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let db: any, requireAccessContext: any;
  let badgesGET: any, agentsGET: any;

  /** A plain member with no org-wide role, so every decision comes from grants. */
  const as = (userId: string) => {
    vi.mocked(requireAccessContext).mockResolvedValue({
      org: { id: ORG, name: ORG },
      user: { id: userId, role: "member" },
      ctx: { orgId: ORG, actor: { type: "human", id: userId, role: "member" } },
    } as never);
  };

  const grant = async (userId: string, scopePath: string, permission = "read") => {
    await seedMember(db, { orgId: ORG, userId });
    return db.$executeRawUnsafe(
      `INSERT INTO "grants" ("id","orgId","scopeId","granteeType","granteeId","permission")
       VALUES ($1,$2,(SELECT "id" FROM "scopes" WHERE "orgId"=$2 AND "path"=$3),'user',$4,$5)`,
      `g_${userId}_${scopePath}`,
      ORG,
      scopePath,
      userId,
      permission,
    );
  };

  const chunk = (id: string, scopePath: string | null, createdAt = "2026-06-01T00:00:00Z") =>
    db.$executeRawUnsafe(
      `INSERT INTO "memory_chunks" ("id","orgId","content","scopePath","createdAt")
       VALUES ($1,$2,$3,$4,$5::timestamptz)`,
      id,
      ORG,
      `content ${id}`,
      scopePath,
      createdAt,
    );

  const run = (id: string, scopePath: string | null, status = "running") =>
    db.$executeRawUnsafe(
      `INSERT INTO "agent_runs" ("id","orgId","agentId","status","meta","startedAt")
       VALUES ($1,$2,$3,$4::"AgentRunStatus",$5::jsonb,NOW())`,
      id,
      ORG,
      AGENT,
      status,
      scopePath === null ? "{}" : JSON.stringify({ scopePath }),
    );

  const badges = async (userId: string, since: string | null = SINCE) => {
    as(userId);
    const qs = since ? `?since=${since}` : "";
    const res = await badgesGET(new Request(`http://t/api/nav/badges${qs}`));
    expect(res.status).toBe(200);
    return res.json();
  };

  beforeAll(async () => {
    ({ db } = await import("@/lib/db"));
    ({ requireAccessContext } = await import("@/lib/access-context"));
    ({ GET: badgesGET } = await import("./nav/badges/route"));
    ({ GET: agentsGET } = await import("./agents/route"));
    await db.$executeRawUnsafe(
      `INSERT INTO "orgs" ("id","name","updatedAt") VALUES ($1,$1,NOW()) ON CONFLICT ("id") DO NOTHING`,
      ORG,
    );
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    for (const table of ["audit_log", "grants", "memory_chunks", "agent_runs", "agents", "contacts", "scopes"]) {
      await db.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "orgId" = $1`, ORG);
    }
    for (const path of [ROOT, GRANTED, SIBLING, SIBLING_CHILD, OTHER, CHILD]) {
      await db.$executeRawUnsafe(
        `INSERT INTO "scopes" ("id","orgId","path","name") VALUES ($1,$2,$3,$3)`,
        `sc_${path}`,
        ORG,
        path,
      );
    }
    await db.$executeRawUnsafe(
      `INSERT INTO "agents" ("id","orgId","agentKey","name","role","updatedAt")
       VALUES ($1,$2,'research-agent','Research','research',NOW())`,
      AGENT,
      ORG,
    );

    // Four chunks the narrow reader may see (its own scope and a descendant) and
    // four it may not (two siblings, an unrelated scope, and an untagged row that
    // belongs to the org root).
    await chunk("ch_granted", GRANTED);
    await chunk("ch_child", CHILD);
    await chunk("ch_sibling", SIBLING);
    await chunk("ch_sibling_child", SIBLING_CHILD);
    await chunk("ch_other", OTHER);
    await chunk("ch_untagged", null);
    // One readable chunk from before the client's last visit: the badge counts new
    // activity, so this must stay out of the number even for the root reader.
    await chunk("ch_old", GRANTED, "2025-01-01T00:00:00Z");

    await run("run_granted", GRANTED);
    await run("run_child", CHILD);
    await run("run_sibling", SIBLING);
    await run("run_sibling_child", SIBLING_CHILD);
    await run("run_other", OTHER);
    await run("run_scopeless", null);
    await run("run_granted_done", GRANTED, "completed");
  });

  afterAll(async () => {
    for (const table of ["audit_log", "grants", "memory_chunks", "agent_runs", "agents", "contacts", "scopes"]) {
      await db.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "orgId" = $1`, ORG);
    }
    await db.org.deleteMany({ where: { id: ORG } });
    await db?.$disconnect?.();
  });

  describe("a member granted read on one narrow scope", () => {
    beforeEach(() => grant("user_narrow", GRANTED));

    it("counts new memory in that scope and its descendant, and nothing else", async () => {
      // ch_granted + ch_child. Not ch_sibling, ch_other, ch_untagged or ch_old.
      await expect(badges("user_narrow")).resolves.toMatchObject({ newMemoryChunks: 2 });
    });

    it("counts running runs in that scope and its descendant, and nothing else", async () => {
      // run_granted + run_child. Not the siblings, the org-root run, or the finished one.
      await expect(badges("user_narrow")).resolves.toMatchObject({ activeAgentRuns: 2 });
    });

    // The underscore trap, stated as its own case because it is the one failure an
    // otherwise-correct-looking implementation produces: `dept_sales` as an
    // unescaped LIKE pattern also matches `deptXsales`.
    it("does not count a sibling scope whose label differs only where the `_` is", async () => {
      // The two shapes the trap takes: a record at the sibling itself (which the
      // equality leg must not admit) and one under the sibling (which the LIKE
      // prefix leg matches unless the `_` in `dept_sales` is escaped).
      const narrow = await badges("user_narrow");
      await chunk("ch_sibling_3", SIBLING);
      await chunk("ch_sibling_child_3", SIBLING_CHILD);
      await run("run_sibling_3", SIBLING);
      await run("run_sibling_child_3", SIBLING_CHILD);
      await expect(badges("user_narrow")).resolves.toEqual(narrow);
    });

    it("learns no contact volume, since its grant does not cover the org root", async () => {
      await db.$executeRawUnsafe(
        `INSERT INTO "contacts" ("id","orgId","name","updatedAt") VALUES ($1,$2,'Jane Doe',NOW())`,
        "contactNavBadge",
        ORG,
      );
      await expect(badges("user_narrow")).resolves.toMatchObject({ newContacts: 0 });
    });
  });

  it("reports zeros to a member with no grant at all, though the org is busy", async () => {
    await expect(badges("user_nobody")).resolves.toEqual({
      activeAgentRuns: 0,
      newContacts: 0,
      newMemoryChunks: 0,
    });
  });

  describe("a member granted read at the org root", () => {
    beforeEach(() => grant("user_root", ROOT));

    it("counts every new chunk, including the untagged ones the root owns", async () => {
      // Every chunk above except ch_old, which predates the `since` cursor.
      await expect(badges("user_root")).resolves.toMatchObject({ newMemoryChunks: 6 });
    });

    it("counts every running run, including the one started without a scope", async () => {
      await expect(badges("user_root")).resolves.toMatchObject({ activeAgentRuns: 6 });
    });
  });

  it("counts no memory at all without a `since` cursor, for any reader", async () => {
    await grant("user_root", ROOT);
    await expect(badges("user_root", null)).resolves.toMatchObject({ newMemoryChunks: 0 });
  });

  // The same number on the agents page: "runs total" per agent card. The raw
  // relation count (`_count.runs`) covered every run in the org, and the card's
  // last run was the org's newest run whether or not the reader could open it.
  describe("GET /api/agents — the per-agent run total and last run", () => {
    const agents = async (userId: string) => {
      as(userId);
      const res = await agentsGET();
      expect(res.status).toBe(200);
      return (await res.json()).agents[0];
    };

    it("totals only the runs a narrow reader may open", async () => {
      await grant("user_narrow", GRANTED);
      // run_granted, run_child, run_granted_done. Not the siblings or the scopeless run.
      expect((await agents("user_narrow"))._count.runs).toBe(3);
    });

    it("totals every run for a root reader", async () => {
      await grant("user_root", ROOT);
      expect((await agents("user_root"))._count.runs).toBe(7);
    });

    it("reports no runs to a member with no grant, and shows them no last run", async () => {
      const agent = await agents("user_nobody");
      expect(agent._count.runs).toBe(0);
      expect(agent.runs).toEqual([]);
    });

    it("shows a narrow reader the newest run they may open, not the org's newest", async () => {
      await grant("user_narrow", GRANTED);
      await db.$executeRawUnsafe(
        `UPDATE "agent_runs" SET "startedAt" = NOW() + interval '1 hour' WHERE "id" = $1`,
        "run_sibling",
      );
      const agent = await agents("user_narrow");
      expect(agent.runs.map((r: { id: string }) => r.id)).not.toContain("run_sibling");
      expect(agent.runs).toHaveLength(1);
    });
  });
});
