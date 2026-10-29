import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedMember } from "@/services/access/member.testsupport";

// The scoped run counts: the single-agent view's
// `_count.runs`, which no other test drives, and the property every one of
// these numbers exists to hold — a reader's answer is the same whether the runs
// they cannot read are hidden from them or do not exist at all. Two tenants, so
// another org's activity is in the database too.
//
// Set QA_DATABASE_URL to an ISOLATED test database; skips cleanly when unset.
const QA_URL = process.env.QA_DATABASE_URL;
if (QA_URL) process.env.DATABASE_URL = QA_URL;

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

const ORG = "orgQaRunCount";
const ROOT = `org_${ORG}`;
const GRANTED = `${ROOT}.dept_sales`;
const SIBLING = `${ROOT}.deptXsales`;
const OTHER = `${ROOT}.eng`;
const AGENT = "agentQaRunCount";
const AGENT_SIBLING = "agentQaRunCountSibling";

const ORG_B = "orgQaRunCountB";
const ROOT_B = `org_${ORG_B}`;
const AGENT_B = "agentQaRunCountB";

describe.skipIf(!QA_URL)("scoped run counts: hidden answers like absent", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let db: any, requireAccessContext: any;
  let badgesGET: any, agentsGET: any, agentGET: any;

  const as = (orgId: string, userId: string) =>
    vi.mocked(requireAccessContext).mockResolvedValue({
      org: { id: orgId, name: orgId },
      user: { id: userId, role: "member" },
      ctx: { orgId, actor: { type: "human", id: userId, role: "member" } },
    } as never);

  const scope = (orgId: string, path: string) =>
    db.$executeRawUnsafe(
      `INSERT INTO "scopes" ("id","orgId","path","name") VALUES ($1,$2,$3,$3)`,
      `sc_${path}`,
      orgId,
      path,
    );

  const grant = async (orgId: string, userId: string, path: string) => {
    await seedMember(db, { orgId, userId });
    return db.$executeRawUnsafe(
      `INSERT INTO "grants" ("id","orgId","scopeId","granteeType","granteeId","permission")
       VALUES ($1,$2,(SELECT "id" FROM "scopes" WHERE "orgId"=$2 AND "path"=$3),'user',$4,'read')`,
      `g_${userId}_${path}`,
      orgId,
      path,
      userId,
    );
  };

  const agent = (orgId: string, id: string) =>
    db.$executeRawUnsafe(
      `INSERT INTO "agents" ("id","orgId","agentKey","name","role","updatedAt")
       VALUES ($1,$2,'research-agent','Research','research',NOW())`,
      id,
      orgId,
    );

  /** A run `minutesAgo` minutes old; scopeless when `path` is null. */
  const run = (
    orgId: string,
    agentId: string,
    id: string,
    path: string | null,
    minutesAgo: number,
    status = "completed",
  ) =>
    db.$executeRawUnsafe(
      `INSERT INTO "agent_runs" ("id","orgId","agentId","status","meta","startedAt")
       VALUES ($1,$2,$3,$4::"AgentRunStatus",$5::jsonb,NOW() - ($6 || ' minutes')::interval)`,
      id,
      orgId,
      agentId,
      status,
      path === null ? "{}" : JSON.stringify({ scopePath: path }),
      String(minutesAgo),
    );

  const chunk = (orgId: string, id: string, path: string | null) =>
    db.$executeRawUnsafe(
      `INSERT INTO "memory_chunks" ("id","orgId","content","scopePath","createdAt") VALUES ($1,$2,$3,$4,NOW())`,
      id,
      orgId,
      `content ${id}`,
      path,
    );

  /** Everything a narrow reader of ORG is told about agent activity. */
  const everything = async (userId: string) => {
    as(ORG, userId);
    const badges = await (await badgesGET(new Request("http://t/api/nav/badges?since=2026-01-01T00:00:00Z"))).json();
    const list = (await (await agentsGET()).json()).agents.map((a: any) => ({
      id: a.id,
      count: a._count.runs,
      runs: a.runs.map((r: any) => r.id),
    }));
    const detailRes = await agentGET(new Request(`http://t/api/agents/${AGENT}`), {
      params: Promise.resolve({ id: AGENT }),
    });
    const detail = (await detailRes.json()).agent;
    return {
      badges,
      list,
      detail: { status: detailRes.status, count: detail._count.runs, runs: detail.runs.map((r: any) => r.id) },
    };
  };

  /** Runs and chunks the narrow reader cannot read: siblings, another scope, the org root. */
  const addHidden = async () => {
    for (let i = 0; i < 6; i += 1) {
      await run(ORG, AGENT, `hidden_sib_${i}`, SIBLING, i, i % 2 ? "running" : "completed");
    }
    await run(ORG, AGENT, "hidden_other", OTHER, 1, "running");
    await run(ORG, AGENT, "hidden_root", null, 2, "running");
    await chunk(ORG, "hidden_chunk_sib", SIBLING);
    await chunk(ORG, "hidden_chunk_root", null);
  };

  const clean = async () => {
    for (const orgId of [ORG, ORG_B]) {
      for (const table of ["audit_log", "grants", "memory_chunks", "agent_runs", "agents", "contacts", "scopes"]) {
        await db.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "orgId" = $1`, orgId);
      }
    }
  };

  beforeAll(async () => {
    ({ db } = await import("@/lib/db"));
    ({ requireAccessContext } = await import("@/lib/access-context"));
    ({ GET: badgesGET } = await import("./nav/badges/route"));
    ({ GET: agentsGET } = await import("./agents/route"));
    ({ GET: agentGET } = await import("./agents/[id]/route"));
    for (const orgId of [ORG, ORG_B]) {
      await db.$executeRawUnsafe(
        `INSERT INTO "orgs" ("id","name","updatedAt") VALUES ($1,$1,NOW()) ON CONFLICT ("id") DO NOTHING`,
        orgId,
      );
    }
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await clean();
    for (const path of [ROOT, GRANTED, SIBLING, OTHER]) await scope(ORG, path);
    await scope(ORG_B, ROOT_B);
    await agent(ORG, AGENT);
    await agent(ORG_B, AGENT_B);
    await grant(ORG, "user_narrow", GRANTED);
    await grant(ORG, "user_root", ROOT);
    // Three runs the narrow reader may open, the newest still running.
    await run(ORG, AGENT, "mine_0", GRANTED, 30, "running");
    await run(ORG, AGENT, "mine_1", GRANTED, 40);
    await run(ORG, AGENT, "mine_2", `${GRANTED}.west`, 50);
    await chunk(ORG, "mine_chunk", GRANTED);
    // The other tenant is busy, with a reader granted its whole org.
    for (let i = 0; i < 4; i += 1) await run(ORG_B, AGENT_B, `b_${i}`, null, i, "running");
    await chunk(ORG_B, "b_chunk", null);
  });

  afterAll(async () => {
    await clean();
    await db.org.deleteMany({ where: { id: { in: [ORG, ORG_B] } } });
    await db?.$disconnect?.();
  });

  it("GET /api/agents/:id totals only the runs the caller may open", async () => {
    await addHidden();
    const narrow = await everything("user_narrow");
    expect(narrow.detail.count).toBe(3);
    const nobody = await everything("user_nobody");
    expect(nobody.detail.count).toBe(0);
    expect(nobody.detail.runs).toEqual([]);
    const root = await everything("user_root");
    expect(root.detail.count).toBe(11);
  });

  it("still answers a permitted reader in full", async () => {
    const narrow = await everything("user_narrow");
    expect(narrow.badges).toEqual({ activeAgentRuns: 1, newContacts: 0, newMemoryChunks: 1 });
    expect(narrow.list).toEqual([{ id: AGENT, count: 3, runs: ["mine_0"] }]);
    expect(narrow.detail).toEqual({ status: 200, count: 3, runs: ["mine_0", "mine_1", "mine_2"] });
  });

  // The detail view must take its newest five AFTER the visibility filter: taken
  // before it, newer hidden runs push readable ones out of the list while the
  // count stays 3, and the shorter list beside the count is the disclosure.
  it("tells a narrow reader the same thing whether the runs they cannot read are hidden or absent", async () => {
    const absent = await everything("user_narrow");
    await addHidden();
    const hidden = await everything("user_narrow");

    expect(hidden.badges).toEqual(absent.badges);
    expect(hidden.list).toEqual(absent.list);
    expect(hidden.detail).toEqual(absent.detail);
  });

  // The detail view lists one agent's runs. Another agent in the same org with
  // newer runs in the same readable scope must not take its place in the five,
  // nor move either agent's count: the visibility rule alone does not keep them apart.
  it("lists and counts only this agent's runs when a sibling agent is busier", async () => {
    const before = await everything("user_narrow");
    await db.$executeRawUnsafe(
      `INSERT INTO "agents" ("id","orgId","agentKey","name","role","updatedAt")
       VALUES ($1,$2,'qa-agent','QA','qa',NOW())`,
      AGENT_SIBLING,
      ORG,
    );
    for (let i = 0; i < 6; i += 1) await run(ORG, AGENT_SIBLING, `sibling_agent_${i}`, GRANTED, i);
    const after = await everything("user_narrow");

    expect(after.detail).toEqual(before.detail);
    expect(after.list).toEqual(
      expect.arrayContaining([
        { id: AGENT, count: 3, runs: ["mine_0"] },
        { id: AGENT_SIBLING, count: 6, runs: ["sibling_agent_0"] },
      ]),
    );
  });

  it("answers another tenant's agent id exactly like one never issued", async () => {
    as(ORG, "user_root");
    const foreign = await agentGET(new Request(`http://t/api/agents/${AGENT_B}`), {
      params: Promise.resolve({ id: AGENT_B }),
    });
    const absent = await agentGET(new Request("http://t/api/agents/agent_never"), {
      params: Promise.resolve({ id: "agent_never" }),
    });
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual(await absent.json());
  });

  it("counts none of another tenant's activity, even for an org-root reader", async () => {
    const root = await everything("user_root");
    expect(root.badges).toEqual({ activeAgentRuns: 1, newContacts: 0, newMemoryChunks: 1 });
    expect(root.list.map((a: { id: string }) => a.id)).toEqual([AGENT]);
  });
});
