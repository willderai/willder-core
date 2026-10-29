import { beforeEach, describe, expect, it, vi } from "vitest";

// Marker escaping in the audit visibility rule.
//
// services/audit/visibility.ts's rule makes an `access.manage` row visible only
// when its target carries a real mutation marker -- `grants:create:`,
// `grants:revoke:` or `fact_dispute:`. The raw-SQL form of that rule,
// `visibleAuditRowSql()`, sends its markers through escapeLikePrefix() and an
// explicit `ESCAPE` clause, because `fact_dispute:` contains an `_` -- a LIKE
// wildcard -- and an unescaped pattern also matches a target reading
// `factXdispute:`.
//
// A Prisma typed `where` using `target: { contains: marker }` compiles to an
// unescaped `LIKE`, and Prisma's typed API has no `ESCAPE` clause to offer, so
// the rule cannot be expressed correctly in that form at all. Every consumer
// uses the raw-SQL form; this file is the test that the escaping is
// load-bearing on each of them.
//
// Method: mock `db.$queryRaw` and decode the patterns it binds with a real
// Postgres `LIKE ... ESCAPE '\'` interpreter (sql-like.testsupport.ts), rather
// than reproducing how escapeLikePrefix() builds one -- so the decoder cannot
// echo the encoder's bugs. Guard-removal: dropping escapeLikePrefix() from
// visibleAuditRowSql(), or reverting either route to the typed `contains`
// form, fails the "wildcard sibling" cases below (and the run-trail paging
// case, whose fixture carries a wildcard-sibling row) and nothing else in the
// suite.
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/access", () => ({ check: vi.fn() }));
vi.mock("@/services/audit/actor-names", () => ({
  resolveUserNames: vi.fn().mockResolvedValue({}),
  resolveActorNames: vi.fn().mockResolvedValue({}),
  fallbackAgentName: (id: string) => id,
}));
vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: vi.fn(),
    agentRun: { findFirst: vi.fn(), findMany: vi.fn() },
    agent: { findFirst: vi.fn() },
    // GET /api/audit resolves each row's changeId through changeIdsByAuthorizingRow();
    // these cases are about the visibility rule, not the link.
    changeEvent: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

import { requireAccessContext } from "@/lib/access-context";
import { check } from "@/services/access";
import { db } from "@/lib/db";
import { GET as actorsGET } from "./actors/route";
import { GET as runAuditGET } from "@/app/api/agents/[id]/runs/[runId]/audit/route";
import { ALWAYS_VISIBLE_ACTIONS, TARGET_CONDITIONAL_ACTIONS } from "@/services/audit/audit-actions";
import { RUN_TRAIL_PAGE_SIZE } from "@/lib/agent-lists";
import { encodeListCursor } from "@/lib/list-cursor";
import {
  VISIBILITY_VALUE_COUNT,
  assertAllValuesDecoded,
  parseVisibilityValues,
  rowIsVisible,
  sqlLike,
} from "./sql-like.testsupport";

type Row = {
  orgId: string;
  actorType: string;
  actorId: string;
  action: string;
  target: string | null;
};

const STARTED_AT = new Date("2026-09-21T10:00:00Z");
const FINISHED_AT = new Date("2026-09-21T10:05:00Z");

// `user_impostor`'s target differs from a real dispute-resolution marker only
// at the `_`. Under an unescaped LIKE it reads as one.
const ROWS: Row[] = [
  {
    orgId: "org_1",
    actorType: "human",
    actorId: "user_admin",
    action: "access.manage",
    target: "org_1.dept/fact_dispute:d_9",
  },
  {
    orgId: "org_1",
    actorType: "human",
    actorId: "user_impostor",
    action: "access.manage",
    target: "org_1.dept/factXdispute:d_9",
  },
  {
    orgId: "org_1",
    actorType: "human",
    actorId: "user_prober",
    action: "access.manage",
    target: "org_1/fact_disputes",
  },
  { orgId: "org_1", actorType: "agent", actorId: "qa-agent", action: "memory.read", target: "org_1/query:pricing" },
  {
    orgId: "org_2",
    actorType: "human",
    actorId: "user_other_org",
    action: "access.manage",
    target: "org_2/fact_dispute:d_1",
  },
];

// Both decoders below read each leg only when the statement actually carries
// it, and then check that nothing was left over. Reading `values[0]` as the
// org id unconditionally would invent an org filter the query never asked for
// -- so losing the real one would still look filtered here -- and would shift
// every later leg's offset by one besides.

/** The bound values of the distinct-actors query, in the order
 *  queryAuditActors() emits them. */
function parseActorsCall(call: unknown[]) {
  const [strings, ...values] = call as [string[], ...unknown[]];
  const sql = strings.join("?");
  let i = 0;
  const orgId = sql.includes('"orgId" = ') ? (values[i++] as string) : undefined;
  const visibility = parseVisibilityValues(values, i);
  i += VISIBILITY_VALUE_COUNT;
  assertAllValuesDecoded(i, values);
  return { sql, orgId, visibility };
}

/** The bound values of the run-entries query, in the order
 *  queryRunAuditEntries() emits them. */
function parseRunCall(call: unknown[]) {
  const [strings, ...values] = call as [string[], ...unknown[]];
  const sql = strings.join("?");
  let i = 0;
  const orgId = sql.includes('"orgId" = ') ? (values[i++] as string) : undefined;
  const actorId = sql.includes('"actorId" = ') ? (values[i++] as string) : undefined;
  const visibility = parseVisibilityValues(values, i);
  i += VISIBILITY_VALUE_COUNT;
  // The window is read with the comparison operators the statement actually
  // uses, so a bound turned exclusive (or a window dropped) changes what the
  // fake returns instead of being assumed.
  const window = /"at" (>=|>) \? AND "at" (<=|<) \?/.exec(sql);
  const from = window ? { op: window[1] as ">=" | ">", at: values[i++] as Date } : undefined;
  const to = window ? { op: window[2] as "<=" | "<", at: values[i++] as Date } : undefined;
  // The keyset predicate is present only on a page after the first, and only
  // ANDed onto the rest of the WHERE clause; LIMIT is on every page.
  const after = sql.includes('AND ("at", "id") > (')
    ? { at: values[i++] as Date, id: values[i++] as string }
    : undefined;
  const limit = /\bLIMIT \?/.test(sql) ? (values[i++] as number) : undefined;
  assertAllValuesDecoded(i, values);
  return { sql, orgId, actorId, visibility, from, to, after, limit };
}

/** A run-trail fixture row: the columns the run-entries query filters, orders and pages on. */
type RunRow = Row & { id: string; at: Date };

/** Postgres row comparison `(at, id) > (b.at, b.id)`, and the ORDER BY it pages along. */
function compareAtId(a: { at: Date; id: string }, b: { at: Date; id: string }): number {
  const byAt = a.at.getTime() - b.at.getTime();
  if (byAt !== 0) return byAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Runs the run-entries query against `rows` the way Postgres would, from what the
 *  statement actually bound: each WHERE leg only when the statement carries it, then
 *  the (at, id) order only when the statement asks for it (otherwise fixture order,
 *  which the callers shuffle), then the bound LIMIT. */
function runStandIn(rows: RunRow[]) {
  return async (...call: unknown[]) => {
    const q = parseRunCall(call);
    const agentOnly = /"actorType"\s*=\s*'agent'/.test(q.sql);
    const matched = rows.filter(
      (r) =>
        (q.orgId === undefined || r.orgId === q.orgId) &&
        (!agentOnly || r.actorType === "agent") &&
        (q.actorId === undefined || r.actorId === q.actorId) &&
        rowIsVisible(r, q.visibility) &&
        (q.from === undefined || (q.from.op === ">=" ? r.at >= q.from.at : r.at > q.from.at)) &&
        (q.to === undefined || (q.to.op === "<=" ? r.at <= q.to.at : r.at < q.to.at)) &&
        (q.after === undefined || compareAtId(r, q.after) > 0),
    );
    const ordered = /ORDER BY "at" ASC, "id" ASC/.test(q.sql) ? [...matched].sort(compareAtId) : matched;
    const page = q.limit === undefined ? ordered : ordered.slice(0, q.limit);
    return page.map(({ id, action, target, at }) => ({ id, action, target, decision: "allow", reason: null, at }));
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue({
    org: { id: "org_1" },
    user: { id: "user_42" },
    ctx: { orgId: "org_1", actor: { type: "human", id: "user_42" } },
  } as never);
  vi.mocked(check).mockResolvedValue({ allowed: true } as never);
});

describe("GET /api/audit/actors — marker escaping in the visible-row rule", () => {
  /** Runs the real query against ROWS, applying the visibility rule the way
   *  Postgres would from the patterns the query actually bound, then deduping
   *  server-side as `SELECT DISTINCT` does. */
  function arrange(rows: Row[]) {
    vi.mocked(db.$queryRaw).mockImplementation((async (...call: unknown[]) => {
      const q = parseActorsCall(call);
      const matched = rows.filter(
        (r) => (q.orgId === undefined || r.orgId === q.orgId) && rowIsVisible(r, q.visibility),
      );
      return [...new Map(matched.map((r) => [`${r.actorType}\u0000${r.actorId}`, r])).values()].map(
        ({ actorType, actorId }) => ({ actorType, actorId }),
      );
    }) as never);
  }

  async function actorIds(rows: Row[]): Promise<string[]> {
    arrange(rows);
    const res = await actorsGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { actors: { actorId: string }[] };
    return body.actors.map((a) => a.actorId);
  }

  it("lists an actor whose only visible activity is a real dispute-resolution mutation", async () => {
    expect(await actorIds(ROWS)).toContain("user_admin");
  });

  it("lists an actor seen only through an always-visible memory action", async () => {
    expect(await actorIds(ROWS)).toContain("qa-agent");
  });

  it("still hides the access.manage probe/list reads the rule exists to filter out", async () => {
    expect(await actorIds(ROWS)).not.toContain("user_prober");
  });

  // `user_other_org`'s only row is visible under the rule, so the `"orgId" = `
  // leg of queryAuditActors() is the one thing keeping them out of an admin
  // identity picker -- and it is a real detector of that leg only because the
  // decoder above stops filtering by org when the query stops asking.
  it("still scopes the picker to the caller's own org", async () => {
    expect(await actorIds(ROWS)).not.toContain("user_other_org");
  });

  // THE GUARD. Without escapeLikePrefix()/ESCAPE, `%fact_dispute:%` also
  // matches `factXdispute:`, so an actor whose every access.manage row is a
  // self-minted near-miss of a mutation marker is disclosed in the admin
  // identity picker as though they had resolved a dispute.
  it("does not list an actor whose marker is only a LIKE-wildcard sibling of a real one", async () => {
    expect(await actorIds(ROWS)).not.toContain("user_impostor");
  });
});

describe("GET /api/agents/:id/runs/:runId/audit — marker escaping in the visible-row rule", () => {
  beforeEach(() => {
    // The run lookup carries `id: runId`; the same-agent overlap probe carries
    // `id: { not }` and finds nothing, on every page of a walk.
    vi.mocked(db.agentRun.findFirst).mockImplementation((async (args: { where: { id: unknown } }) =>
      args.where.id === "run_1" ? RUN : null) as never);
    vi.mocked(db.agentRun.findMany).mockResolvedValue([] as never);
    vi.mocked(db.agent.findFirst).mockResolvedValue({ agentKey: "qa-agent", role: "qa" } as never);
    vi.mocked(db.$queryRaw).mockResolvedValue([] as never);
  });

  const RUN = {
    id: "run_1",
    agentId: "agent_1",
    triggeredBy: "user_42",
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT,
    meta: null,
  };

  async function runQuery(url = "http://t") {
    const res = await runAuditGET(new Request(url), {
      params: Promise.resolve({ id: "agent_1", runId: "run_1" }),
    });
    expect(res.status).toBe(200);
    return parseRunCall(vi.mocked(db.$queryRaw).mock.calls[0]!);
  }

  it("asks for this org, this run's actorId and the run's own window", async () => {
    const q = await runQuery();
    expect(q.orgId).toBe("org_1");
    expect(q.actorId).toBe("qa-agent");
    expect(q.from).toEqual({ op: ">=", at: STARTED_AT });
    expect(q.to).toEqual({ op: "<=", at: FINISHED_AT });
  });

  it("reads one row past a page, from the start, on the first page", async () => {
    const q = await runQuery();
    expect(q.limit).toBe(RUN_TRAIL_PAGE_SIZE + 1);
    expect(q.after).toBeUndefined();
  });

  it("binds the cursor it was given as the (at, id) keyset predicate", async () => {
    const cursor = { at: new Date("2026-09-21T10:02:00Z"), id: "e_0123" };
    const q = await runQuery(`http://t?cursor=${encodeURIComponent(encodeListCursor(cursor))}`);
    expect(q.after).toEqual(cursor);
    expect(q.sql).toMatch(/ORDER BY "at" ASC, "id" ASC/);
    expect(q.limit).toBe(RUN_TRAIL_PAGE_SIZE + 1);
  });

  // End to end through the fake: walking every page by `endCursor` returns
  // exactly the run's visible rows, once each, in (at, id) order -- including
  // rows that share a timestamp across a page boundary -- and the visibility
  // rule (wildcard sibling included) still decides which rows those are.
  // Two sizes: one that leaves a partial last page, and one that is an exact
  // multiple of the page size, where reading one row past the page is the only
  // way the last full page can say nothing follows it.
  it.each([
    { total: 2 * RUN_TRAIL_PAGE_SIZE + 50, pagesExpected: 3 },
    { total: 2 * RUN_TRAIL_PAGE_SIZE, pagesExpected: 2 },
  ])(
    "pages through exactly the visible rows of the run, once each, in (at, id) order ($total rows)",
    async ({ total, pagesExpected }) => {
      const at = (ms: number) => new Date(STARTED_AT.getTime() + ms);
      const agentRow = (id: string, ms: number, action: string, target: string): RunRow => ({
        orgId: "org_1",
        actorType: "agent",
        actorId: "qa-agent",
        action,
        target,
        id,
        at: at(ms),
      });
      // Three rows to a second, so ties on `at` fall on both page boundaries (200, 400).
      // Two named rows join the generated ones below, so generate two fewer than `total`.
      const visible = Array.from({ length: total - 2 }, (_, k) =>
        agentRow(`e_${String(k).padStart(4, "0")}`, Math.floor(k / 3) * 1000, "memory.read", `org_1/query:q${k}`),
      );
      visible.push(agentRow("e_last", FINISHED_AT.getTime() - STARTED_AT.getTime(), "memory.read", "org_1/query:end"));
      visible.push(agentRow("e_real_marker", 1000, "access.manage", "org_1.dept/fact_dispute:d_9"));
      const hidden: RunRow[] = [
        agentRow("h_wildcard_sibling", 2000, "access.manage", "org_1.dept/factXdispute:d_9"),
        agentRow("h_probe", 2000, "access.manage", "org_1/fact_disputes"),
        agentRow("h_after_window", FINISHED_AT.getTime() - STARTED_AT.getTime() + 1, "memory.read", "org_1/query:late"),
        agentRow("h_before_window", -1, "memory.read", "org_1/query:early"),
        { ...agentRow("h_other_agent", 3000, "memory.read", "org_1/query:x"), actorId: "copy-agent" },
        { ...agentRow("h_other_org", 3000, "memory.read", "org_2/query:x"), orgId: "org_2" },
        { ...agentRow("h_human", 3000, "memory.read", "org_1/query:x"), actorType: "human" },
      ];
      // Fixture order is reversed, so a page only comes out ordered if the statement orders it.
      vi.mocked(db.$queryRaw).mockImplementation(runStandIn([...visible, ...hidden].reverse()) as never);

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const url: string = cursor ? `http://t?cursor=${encodeURIComponent(cursor)}` : "http://t";
        const res = await runAuditGET(new Request(url), {
          params: Promise.resolve({ id: "agent_1", runId: "run_1" }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { entries: { id: string }[]; hasMore: boolean; endCursor: string | null };
        expect(body.entries.length).toBeLessThanOrEqual(RUN_TRAIL_PAGE_SIZE);
        seen.push(...body.entries.map((e) => e.id));
        cursor = body.hasMore ? body.endCursor : null;
        pages++;
      } while (cursor !== null && pages < 10);

      expect(pages).toBe(pagesExpected);
      expect(seen).toEqual([...visible].sort(compareAtId).map((r) => r.id));
    },
  );

  // Moved here from route.test.ts when the query moved into
  // services/access/audit-query.ts: the scoping is now part of the statement,
  // so it is asserted on the statement.
  it("scopes the trail to agent-written rows", async () => {
    expect((await runQuery()).sql).toMatch(/"actorType"\s*=\s*'agent'/);
  });

  it("applies the same visible-row rule as the rest of the audit surface", async () => {
    const q = await runQuery();
    expect(q.visibility.alwaysVisibleActions).toEqual([...ALWAYS_VISIBLE_ACTIONS]);
    expect(q.visibility.conditional.map((c) => c.action)).toEqual(TARGET_CONDITIONAL_ACTIONS.map((c) => c.action));
  });

  // THE GUARD, asserted on the emitted patterns rather than on the route's
  // output. Every access.manage row this product writes is stamped with a
  // human actor (check.ts's recordAudit takes ctx.actor.type, and all of the
  // access.manage call sites are human-session routes), so this route's own
  // `actorType = 'agent'` filter independently excludes the rows the marker
  // rule would decide on -- the escape is defence in depth here, not a
  // reachable disclosure.
  // The patterns are still checked for the same wildcard defect, because the
  // rule has to mean one thing across all three consumers: an actorType filter
  // is not what makes marker matching correct, and it is not this module's to
  // rely on.
  it("binds mutation markers that match the real marker and not its LIKE-wildcard sibling", async () => {
    const manage = (await runQuery()).visibility.conditional.find((c) => c.action === "access.manage");
    const [createPattern, revokePattern, disputePattern] = manage!.markerPatterns;

    expect(sqlLike("org_1.dept/fact_dispute:d_9", disputePattern!)).toBe(true);
    expect(sqlLike("org_1.dept/factXdispute:d_9", disputePattern!)).toBe(false);

    // The other two markers carry no wildcard, so they are unaffected either
    // way -- included so a failure above is attributable to the `_` and not to
    // the pattern shape in general.
    expect(sqlLike("org_1.dept/grants:create:org_1.dept", createPattern!)).toBe(true);
    expect(sqlLike("org_1.dept/grants:revoke:cap_1", revokePattern!)).toBe(true);
  });
});
