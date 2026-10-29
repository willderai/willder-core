import { beforeEach, describe, expect, it, vi } from "vitest";

// GET /api/audit scope containment. GET /api/audit is the access.manage-gated
// audit trail itself, so a scope-prefix leak here exposes actor identity and
// deny reasons cross-scope, not just the staleness route's minimal
// changed/target shape.
//
// Containment has two halves. A bare prefix match swallows sibling scopes
// that merely share leading characters (the separator half). A Prisma
// `startsWith` closes that but compiles to an unescaped LIKE, and `_` is a
// LIKE wildcard that every scope path this product mints contains
// (ScopePicker segments are `slug_hexhash`): the wildcard half.
// scope-containment-realdb.qa.test.ts is the actual authority on whether the
// SQL this route issues is correct against a real database.
//
// This file cannot re-run real Postgres, so it does not re-decide that
// question. Instead it drives the real route against `db.$queryRaw` mocked
// with a real Postgres `LIKE ... ESCAPE '\'` interpreter (below), applied to
// a fixture row set -- guard-removal style: reverting the escaping in
// services/access/audit-query.ts (back to a bare `startsWith`-shaped
// pattern) makes the wildcard-sibling cases below fail. A JS
// `.startsWith()` re-implementation of containment could not catch that
// class, because it has no wildcard semantics at all.
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/access", () => ({ check: vi.fn() }));
vi.mock("@/services/audit/actor-names", () => ({
  resolveUserNames: vi.fn().mockResolvedValue({}),
  resolveActorNames: vi.fn().mockResolvedValue({}),
  fallbackAgentName: (id: string) => id,
}));
vi.mock("@/lib/db", () => ({
  // changeEvent: GET /api/audit resolves each row's changeId through
  // changeIdsByAuthorizingRow(); these cases are about the scope filter, not the link.
  db: { $queryRaw: vi.fn(), changeEvent: { findMany: vi.fn().mockResolvedValue([]) } },
}));

import { requireAccessContext } from "@/lib/access-context";
import { check } from "@/services/access";
import { db } from "@/lib/db";
import { GET } from "./route";
import {
  VISIBILITY_VALUE_COUNT,
  assertAllValuesDecoded,
  parseVisibilityValues,
  rowIsVisible,
  sqlLike,
} from "./sql-like.testsupport";

type Row = {
  id: string;
  orgId: string;
  actorType: string;
  actorId: string;
  action: string;
  target: string;
  decision: "allow" | "deny";
  reason: string | null;
  metadata: null;
  at: Date;
};

const AT = new Date("2026-09-18T00:00:00Z");

function row(id: string, target: string, decision: "allow" | "deny" = "allow"): Row {
  return {
    id,
    orgId: "org_1",
    actorType: "human",
    actorId: "user_1",
    action: "memory.read",
    target,
    decision,
    reason: decision === "deny" ? "not a scope admin" : null,
    metadata: null,
    at: AT,
  };
}

// Two sibling scopes that share a character prefix, plus a real descendant of
// the first, plus a sibling differing only at the underscore the bare
// `startsWith` fix could not distinguish from a wildcard.
// The last row is another tenant's, and its target collides exactly with the
// scope this org asks for. `?scope=` is caller-supplied text, so nothing stops
// a request naming a path that reads like a row in some other org; the
// `"orgId" = ` leg is the only predicate in this query that keeps the answer
// inside the caller's own tenant, and without a row only it can exclude, that
// leg is untested here.
const ROWS: Row[] = [
  row("a1", "acme_eng/fact:in-scope"),
  row("a2", "acme_eng.backend/fact:descendant"),
  row("a3", "acme_engineering/fact:other-team-roadmap", "deny"),
  row("a4", "acme_engineering.secrets/fact:credentials", "deny"),
  row("a5", "acmeXeng/fact:wildcard-sibling", "deny"),
  { ...row("b1", "acme_eng/fact:other-tenant-secret"), orgId: "org_2" },
];

/** Parses the bound values out of a flattenSql()-shaped db.$queryRaw call.
 * Positional, matching services/access/audit-query.ts's fixed condition
 * order (orgId, visibility, [scope: exact/dot/slash], [actorId+actorType],
 * [decision]) -- distinguishing substrings are chosen so they can only appear
 * in the WHERE clause they name. The decision filter is bound only on the
 * entries query (`"decision" = ?`); the count query's own `'allow'`/`'deny'`
 * FILTER literals bind nothing. */
function parseCall(call: unknown[]) {
  const [strings, ...values] = call as [string[], ...unknown[]];
  const sql = strings.join("?");
  let i = 0;
  // Read like every other leg below: only when the statement actually carries
  // it. Consuming a value unconditionally would both invent an org filter the
  // query never asked for -- hiding the loss of the real one -- and shift every
  // later leg's offset by one.
  const orgId = sql.includes('"orgId" = ') ? (values[i++] as string) : undefined;
  const visibility = parseVisibilityValues(values, i);
  i += VISIBILITY_VALUE_COUNT;
  // The visibility fragment always emits LIKE legs of its own, so the scope
  // filter is read from its own distinctive `"target" = ` equality leg, which
  // nothing else in this query emits. It emits one such leg, with one (exact,
  // dot, slash) triple of bound values, per namespace the requested scope is
  // matched in: the scope path itself, plus its untagged group_id counterpart
  // when the scope is inside this org's own tree. Counted from the statement
  // rather than assumed, so the decoder follows the predicate.
  const partitionLegs = sql.split('"target" = ').length - 1;
  const scope = partitionLegs
    ? Array.from({ length: partitionLegs }, () => ({
        exact: values[i++] as string,
        dotPattern: values[i++] as string,
        slashPattern: values[i++] as string,
      }))
    : undefined;
  const actorFilter = sql.includes('"actorId" = ')
    ? { actorId: values[i++] as string, actorType: values[i++] as string }
    : undefined;
  const decision = sql.includes('"decision" = ?') ? (values[i++] as string) : undefined;
  // The entries query binds its own pageSize and offset last; the count query
  // binds neither.
  if (sql.includes("LIMIT ")) i += 2;
  assertAllValuesDecoded(i, values);
  return { orgId, visibility, decision, scope, actorFilter, isCount: sql.includes("COUNT(") };
}

function matches(r: Row, q: ReturnType<typeof parseCall>): boolean {
  if (q.orgId !== undefined && r.orgId !== q.orgId) return false;
  if (!rowIsVisible(r, q.visibility)) return false;
  if (q.decision !== undefined && r.decision !== q.decision) return false;
  if (q.scope) {
    const inScope = q.scope.some(
      (leg) => r.target === leg.exact || sqlLike(r.target, leg.dotPattern) || sqlLike(r.target, leg.slashPattern),
    );
    if (!inScope) return false;
  }
  if (q.actorFilter && (r.actorId !== q.actorFilter.actorId || r.actorType !== q.actorFilter.actorType)) {
    return false;
  }
  return true;
}

function arrange(rows: Row[]) {
  vi.mocked(db.$queryRaw).mockImplementation((async (...call: unknown[]) => {
    const q = parseCall(call);
    const matched = rows.filter((r) => matches(r, q));
    if (!q.isCount) return matched;
    const count = (decision: string) => matched.filter((r) => r.decision === decision).length;
    return [{ allowed: count("allow"), denied: count("deny") }];
  }) as never);
}

async function auditTargets(scope: string, rows: Row[]): Promise<string[]> {
  arrange(rows);
  const res = await GET(new Request(`http://t/api/audit?scope=${encodeURIComponent(scope)}`));
  const body = (await res.json()) as { entries: { target: string }[] };
  return body.entries.map((e) => e.target);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue({
    org: { id: "org_1" },
    user: { id: "user_1" },
    ctx: { orgId: "org_1", actor: { type: "human", id: "user_1" } },
  } as never);
  vi.mocked(check).mockResolvedValue({ allowed: true } as never);
});

describe("GET /api/audit — scope containment", () => {
  it("returns rows that are genuinely inside the requested scope", async () => {
    const targets = await auditTargets("acme_eng", ROWS);
    expect(targets).toContain("acme_eng/fact:in-scope");
    expect(targets).toContain("acme_eng.backend/fact:descendant");
  });

  it("does not disclose rows in a sibling scope that merely shares a name prefix", async () => {
    const targets = await auditTargets("acme_eng", ROWS);
    expect(targets).not.toContain("acme_engineering/fact:other-team-roadmap");
    expect(targets).not.toContain("acme_engineering.secrets/fact:credentials");
  });

  // `_` is a LIKE wildcard, so an unescaped prefix matches ANY character at
  // that position, not just literal `_`.
  it("does not disclose a sibling scope differing only at the underscore (the LIKE-wildcard leak)", async () => {
    const targets = await auditTargets("acme_eng", ROWS);
    expect(targets).not.toContain("acmeXeng/fact:wildcard-sibling");
  });

  // Every other row above is excluded by the scope predicate, so this is the
  // only case that can fail when the `"orgId" = ` leg goes missing from
  // queryAuditLog() -- and before the stand-in filtered the way Prisma does,
  // losing that leg made the decoder read an org filter nothing matched, so
  // this case would have passed on an empty answer instead.
  it("does not disclose another tenant's row whose target collides with the requested scope", async () => {
    const targets = await auditTargets("acme_eng", ROWS);
    expect(targets).not.toContain("acme_eng/fact:other-tenant-secret");
  });

  it("reports zero total when the only matching rows are in a sibling scope", async () => {
    arrange(ROWS.filter((r) => r.target.startsWith("acme_engineering")));
    const res = await GET(new Request("http://t/api/audit?scope=acme_eng"));
    const body = (await res.json()) as { total: number; entries: unknown[] };
    expect(body.total).toBe(0);
    expect(body.entries).toEqual([]);
  });
});

// Visibility: "access.manage" is visible only for a real admin mutation
// (grants:create:/grants:revoke:/fact_dispute:), not for the high-volume
// grants:list / fact_disputes probe reads. This route takes the SQL form of
// that rule (its scope filter needs a LIKE ... ESCAPE clause Prisma's typed
// API cannot express at all). These cases pin that BOTH guards hold: the
// visibility rule and the scope containment, composed, neither one masking
// the other.
function manageRow(id: string, target: string): Row {
  return { ...row(id, target), action: "access.manage" };
}

describe("GET /api/audit — target-aware access.manage visibility", () => {
  it("shows a real access.manage mutation inside the requested scope", async () => {
    const targets = await auditTargets("acme_eng", [
      manageRow("m1", "acme_eng/grants:create:acme_eng.backend"),
      manageRow("m2", "acme_eng/grants:revoke:cap_123"),
      manageRow("m3", "acme_eng/fact_dispute:d_9"),
    ]);
    expect(targets).toEqual([
      "acme_eng/grants:create:acme_eng.backend",
      "acme_eng/grants:revoke:cap_123",
      "acme_eng/fact_dispute:d_9",
    ]);
  });

  it("hides the access.manage probe/list reads that would drown the mutations out", async () => {
    const targets = await auditTargets("acme_eng", [
      manageRow("m1", "acme_eng/grants:create:acme_eng.backend"),
      manageRow("p1", "acme_eng/grants:list"),
      manageRow("p2", "acme_eng/fact_disputes"),
    ]);
    expect(targets).toEqual(["acme_eng/grants:create:acme_eng.backend"]);
  });

  // The markers are matched with LIKE too, and "fact_dispute:" contains an
  // `_`. Unescaped, its pattern would also match a target reading
  // "factXdispute:" -- the same wildcard class as the scope leak this PR
  // exists to close, one condition further along the same WHERE clause.
  // Guard-removal: dropping escapeLikePrefix() from visibleAuditRowSql()
  // fails this and nothing else.
  it("does not treat a wildcard sibling of a mutation marker as a mutation", async () => {
    const targets = await auditTargets("acme_eng", [
      manageRow("m1", "acme_eng/fact_dispute:d_9"),
      manageRow("x1", "acme_eng/factXdispute:d_9"),
    ]);
    expect(targets).toEqual(["acme_eng/fact_dispute:d_9"]);
  });

  // Both guards apply as separate ANDed conditions on the same column: a row
  // that passes visibility still has to be inside the requested scope.
  it("still hides a visible access.manage mutation that belongs to a sibling scope", async () => {
    const targets = await auditTargets("acme_eng", [
      manageRow("m1", "acme_eng/grants:create:acme_eng.backend"),
      manageRow("s1", "acme_engineering/grants:create:acme_engineering.secrets"),
      manageRow("s2", "acmeXeng/grants:create:acmeXeng.secrets"),
    ]);
    expect(targets).toEqual(["acme_eng/grants:create:acme_eng.backend"]);
  });
});

// A page-scoped "Denied 0" beside an all-pages record total reads as "no
// denials". The summary's allowed and denied counts come from the server
// across all pages, at the same scope and identity as the list, and ignore
// the decision filter.
describe("GET /api/audit — decision counts share the list's scope", () => {
  async function counts(query: string, rows: Row[]) {
    arrange(rows);
    const res = await GET(new Request(`http://t/api/audit?${query}`));
    return (await res.json()) as { total: number; counts: { allowed: number; denied: number } };
  }

  it("counts denials past the first page instead of reporting only the rows it returned", async () => {
    const rows = [
      ...Array.from({ length: 60 }, (_, i) => row(`al${i}`, "acme_eng/fact:read")),
      ...Array.from({ length: 3 }, (_, i) => row(`dn${i}`, "acme_eng/fact:denied", "deny")),
    ];
    const body = await counts("scope=acme_eng", rows);
    expect(body.total).toBe(63);
    expect(body.counts).toEqual({ allowed: 60, denied: 3 });
  });

  it("scopes the counts exactly like the list: no sibling, wildcard-sibling or other-tenant rows", async () => {
    const body = await counts("scope=acme_eng", ROWS);
    expect(body.counts).toEqual({ allowed: 2, denied: 0 });
    expect(body.total).toBe(2);
  });

  it("keeps both counts when the list is filtered to one decision", async () => {
    const body = await counts(
      "decision=deny",
      ROWS.filter((r) => r.orgId === "org_1"),
    );
    expect(body.total).toBe(3);
    expect(body.counts).toEqual({ allowed: 2, denied: 3 });
  });

  it("reads the page and both counts in two queries, one of them a single count scan", async () => {
    await counts("scope=acme_eng&decision=deny", ROWS);
    const calls = vi.mocked(db.$queryRaw).mock.calls.map((call) => parseCall(call));
    expect(calls.map((q) => q.isCount)).toEqual([true, false]);
  });

  it("applies the identity filter to the counts", async () => {
    const other = { ...row("x1", "acme_eng/fact:other-actor", "deny"), actorId: "user_2" };
    const body = await counts("actorType=human&actorId=user_1", [...ROWS, other]);
    expect(body.counts).toEqual({ allowed: 2, denied: 3 });
  });

  it("names the capability token on a row written for one", async () => {
    arrange([
      {
        ...row("c1", "acme_eng", "deny"),
        action: "capability.refused",
        metadata: { capabilityId: "cmg0abcd00001xyzrandom12" } as never,
      },
    ]);
    const res = await GET(new Request("http://t/api/audit"));
    const body = (await res.json()) as { entries: { capabilityId?: string }[] };
    expect(body.entries.map((e) => e.capabilityId)).toEqual(["cmg0abcd00001xyzrandom12"]);
  });

  it("carries a person erasure's per-store counts, numbers only, and no other row's metadata", async () => {
    const stores = {
      graph: { episodes: 2, nodes: 3, edges: 4, summaries: 1 },
      vector: { chunks: 5 },
      contacts: { contacts: 1, ledgerSnapshots: 0 },
      changeFeed: { summariesBlanked: 2 },
      briefs: { briefs: 0 },
    };
    // A value smuggled into the metadata is dropped: only counts leave the route.
    const tampered = { ...stores, vector: { chunks: 5, matched: "dana@acme.example" } };
    arrange([
      {
        ...row("e1", "acme_eng/person_erasure:req-1"),
        action: "person.erased",
        metadata: { requestId: "req-1", stores: tampered } as never,
      },
      { ...row("e2", "acme_eng/fact:x"), metadata: { stores } as never },
    ]);
    const res = await GET(new Request("http://t/api/audit"));
    const body = (await res.json()) as { entries: { id: string; erasureCounts?: unknown }[] };
    expect(body.entries.find((e) => e.id === "e1")?.erasureCounts).toEqual(stores);
    expect(body.entries.find((e) => e.id === "e2")).not.toHaveProperty("erasureCounts");
    expect(JSON.stringify(body)).not.toContain("dana@acme.example");
  });
});

// A write-effect row names the partition a destructive write really executed
// against, and when the caller passed no scope that partition is in the
// group_id namespace, `group:<orgId>[.<sub>]/<tag>`, never a scope path
// (services/audit/audit-target.ts). A filter matching scope paths only hides
// exactly the row that says where the write landed, under the scope check()
// authorized, which is the one place a reviewer looks for it.
//
// The fixtures above cannot be reused: a scope path's group_id counterpart is
// derived from the org's own root path (`org_<orgId>`), so an org whose id is
// unrelated to its scope paths cannot exercise the translation at all.
const EFFECT_ORG = "acme";
const EFFECT_ROOT = `org_${EFFECT_ORG}`;

/** A write-effect row in the org whose scope paths really are rooted at its own id. */
function effectRow(id: string, target: string, orgId: string = EFFECT_ORG): Row {
  return { ...row(id, target), orgId, action: "memory.delete.effect" };
}

describe("GET /api/audit — scope containment over untagged partitions", () => {
  beforeEach(() => {
    vi.mocked(requireAccessContext).mockResolvedValue({
      org: { id: EFFECT_ORG },
      user: { id: "user_1" },
      ctx: { orgId: EFFECT_ORG, actor: { type: "human", id: "user_1" } },
    } as never);
  });

  // check() authorized the org root and the delete ran against the untagged
  // partition. Both halves have to arrive under the same filter or the
  // divergence reads as an ordinary in-scope delete.
  it("shows the untagged partition's effect row beside the authorization row it diverges from", async () => {
    const targets = await auditTargets(EFFECT_ROOT, [
      { ...row("d1", `${EFFECT_ROOT}/fact:f1`), orgId: EFFECT_ORG, action: "memory.delete" },
      effectRow("e1", `group:${EFFECT_ORG}/fact:f1`),
    ]);
    expect(targets).toEqual([`${EFFECT_ROOT}/fact:f1`, `group:${EFFECT_ORG}/fact:f1`]);
  });

  it("shows an untagged sub-partition's effect row under the matching sub-scope", async () => {
    const targets = await auditTargets(`${EFFECT_ROOT}.sales`, [effectRow("e2", `group:${EFFECT_ORG}.sales/fact:f2`)]);
    expect(targets).toEqual([`group:${EFFECT_ORG}.sales/fact:f2`]);
  });

  it("shows a sub-partition's effect row under an ancestor scope, as a scope path's own descendants are", async () => {
    const targets = await auditTargets(EFFECT_ROOT, [effectRow("e2", `group:${EFFECT_ORG}.sales/fact:f2`)]);
    expect(targets).toEqual([`group:${EFFECT_ORG}.sales/fact:f2`]);
  });

  it("does not disclose a sibling untagged partition, nor the parent one, under a sub-scope", async () => {
    const targets = await auditTargets(`${EFFECT_ROOT}.sales`, [
      effectRow("e2", `group:${EFFECT_ORG}.sales/fact:f2`),
      effectRow("e3", `group:${EFFECT_ORG}.marketing/fact:f3`),
      effectRow("e4", `group:${EFFECT_ORG}/fact:f4`),
    ]);
    expect(targets).toEqual([`group:${EFFECT_ORG}.sales/fact:f2`]);
  });

  // The untagged leg goes through the same escaped LIKE predicate as the scope
  // path, so it inherits the same wildcard exposure rather than being exempt
  // from it. Guard removal: dropping escapeLikePrefix() fails this case and its
  // scope-path twin above.
  it("does not disclose an untagged partition differing only at the underscore", async () => {
    const targets = await auditTargets(`${EFFECT_ROOT}.dept_sales`, [
      effectRow("e5", `group:${EFFECT_ORG}.dept_sales/fact:f5`),
      effectRow("e6", `group:${EFFECT_ORG}.deptXsales/fact:f6`),
    ]);
    expect(targets).toEqual([`group:${EFFECT_ORG}.dept_sales/fact:f5`]);
  });

  it("does not disclose another tenant's group-marked row whose partition collides with this org's", async () => {
    const targets = await auditTargets(EFFECT_ROOT, [
      effectRow("e1", `group:${EFFECT_ORG}/fact:f1`),
      effectRow("x1", `group:${EFFECT_ORG}/fact:other-tenant-secret`, "org_other"),
    ]);
    expect(targets).toEqual([`group:${EFFECT_ORG}/fact:f1`]);
  });

  // `?scope=` is caller-supplied text and nothing stops it naming a path
  // outside this org's tree. Such a path has no group_id counterpart, so no
  // untagged leg is emitted. Guard removal: deriving the counterpart by
  // stripping an optional `org_` prefix off the request, instead of requiring
  // this org's own root path, matches `group:acme/...` here.
  it("mints no untagged leg from a scope outside the org's own tree", async () => {
    const targets = await auditTargets(EFFECT_ORG, [effectRow("e1", `group:${EFFECT_ORG}/fact:f1`)]);
    expect(targets).toEqual([]);
  });

  // The summary counts come from a second statement; it has to carry the same
  // two-namespace filter, or the summary disagrees with the list beside it.
  it("counts untagged rows under the same filter as the list", async () => {
    arrange([
      { ...row("d1", `${EFFECT_ROOT}/fact:f1`), orgId: EFFECT_ORG, action: "memory.delete" },
      effectRow("e1", `group:${EFFECT_ORG}/fact:f1`),
      effectRow("e3", `group:${EFFECT_ORG}.marketing/fact:f3`, EFFECT_ORG),
      effectRow("x1", `group:${EFFECT_ORG}/fact:other-tenant-secret`, "org_other"),
    ]);
    const res = await GET(new Request(`http://t/api/audit?scope=${encodeURIComponent(EFFECT_ROOT)}`));
    const body = (await res.json()) as { total: number; counts: { allowed: number; denied: number } };
    expect(body).toMatchObject({ total: 3, counts: { allowed: 3, denied: 0 } });
    const sub = await GET(new Request(`http://t/api/audit?scope=${encodeURIComponent(`${EFFECT_ROOT}.sales`)}`));
    expect(((await sub.json()) as { total: number }).total).toBe(0);
  });

  it("mints no untagged leg from a scope that only shares the org root's leading characters", async () => {
    const targets = await auditTargets(`${EFFECT_ROOT}corp`, [effectRow("e1", `group:${EFFECT_ORG}corp/fact:f1`)]);
    expect(targets).toEqual([]);
  });
});
