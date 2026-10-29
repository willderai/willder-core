import { beforeEach, describe, expect, it, vi } from "vitest";

// Staleness scope containment, with real LIKE semantics.
//
// The route's own route.test.ts asserts the query it was WRITTEN with, so it
// cannot catch a wrong predicate. These tests instead apply the route's own
// raw-SQL `WHERE` clause to a fixture row set with real Postgres `LIKE ...
// ESCAPE` semantics (not JS `String.prototype.startsWith`), and assert on
// what a caller actually receives.
//
// Scope paths in this codebase are dot-delimited ltree paths (Brief.scopePath
// is AUTHORIZATION-BEARING, prisma/schema.prisma), and an audit row's target is
// `${targetPath}` or `${targetPath}/${req.target}` (services/access/check.ts
// recordAudit). So a row is genuinely under a brief's scope only when its
// target equals the scope, continues with "." (a descendant scope) or with "/"
// (a label on that exact scope). A bare prefix match also swallows sibling
// scopes whose name merely starts with the same characters — the containment
// bug services/access/scope-containment.ts exists to prevent.
//
// Prisma's own `startsWith` cannot express those legs safely: Postgres LIKE
// treats a literal `_` in a scope label as "any single character", a class of
// leak a JS `String.prototype.startsWith` re-implementation cannot see at
// all. The route goes through `db.$queryRaw` with `escapeLikePrefix()`
// (services/access/scope-containment.ts) and a real `ESCAPE '\\'` clause, and
// this file's differential applies genuine SQL LIKE semantics (via
// `likeMatch` below) instead of JS `startsWith`, so it can catch that class.
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    brief: { findFirst: vi.fn() },
    // No provenance row: the scope fallback (services/memory/brief-staleness.ts) these tests pin.
    briefProvenance: { findUnique: vi.fn(async () => null) },
    $queryRaw: vi.fn(),
    source: { findMany: vi.fn() },
    grant: { findMany: vi.fn() },
  },
}));
// Real pathCovers (this file's own subject for the source-visibility half);
// only check() is mocked, same as route.test.ts.
vi.mock("@/services/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/access")>()),
  check: vi.fn(),
  // The scan cache's stamp has its own SQL and its own realdb test
  // (scan-cache-coherence.realdb.test.ts); this file inspects the change query alone.
  scopeCacheStamp: vi.fn(async () => ({ erasureEpoch: "0", changeCount: "0" })),
}));
// Any non-empty change set triggers the route's contradiction scan, which
// otherwise calls the memory service over HTTP (20s timeout) and then an LLM.
// Unmocked, this unit test reached whatever GRAPHITI_SERVICE_URL the shell
// held and timed out at vitest's 5s whenever that service was slow. The scan
// is route.test.ts's subject; this file only asserts containment.
vi.mock("@/services/facts/conflicts", () => ({ findScopeContradictions: vi.fn() }));
vi.mock("@/services/memory/scope-dispute-scan", () => ({ fileSameTierScopeDisputes: vi.fn() }));
vi.mock("@/services/memory/brief-citations", () => ({ checkBriefCitations: vi.fn(async () => []) }));

import { requireAccessContext } from "@/lib/access-context";
import { db } from "@/lib/db";
import { check } from "@/services/access";
import { findScopeContradictions } from "@/services/facts/conflicts";
import { fileSameTierScopeDisputes } from "@/services/memory/scope-dispute-scan";
import { GET } from "./route";

type Row = { orgId: string; action: string; decision: string; target: string; at: Date };

const BRIEF_CREATED_AT = new Date("2026-09-15T00:00:00Z");
const AFTER = new Date("2026-09-16T00:00:00Z");

// Two sibling scopes that share a character prefix, plus a real descendant of
// the first. Only the first two rows are inside `acme.eng`.
const ROWS: Row[] = [
  { orgId: "org_1", action: "memory.write", decision: "allow", target: "acme.eng/fact:in-scope", at: AFTER },
  { orgId: "org_1", action: "memory.write", decision: "allow", target: "acme.eng.backend/fact:descendant", at: AFTER },
  {
    orgId: "org_1",
    action: "memory.write",
    decision: "allow",
    target: "acme.engineering/fact:other-team-roadmap",
    at: AFTER,
  },
  {
    orgId: "org_1",
    action: "memory.delete",
    decision: "allow",
    target: "acme.engineering.secrets/fact:credentials",
    at: AFTER,
  },
];

/** Real Postgres `LIKE ... ESCAPE '\\'` semantics: `%` = any sequence,
 * `_` = any single character, `\%`/`\_`/`\\` = the literal char — applied
 * against a JS string rather than a live database, so this file stays a
 * fast unit differential while still being sensitive to the exact
 * metacharacter class the route's own defect was in. */
function likeMatch(value: string, pattern: string): boolean {
  let regex = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) {
      regex += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (c === "%") {
      regex += ".*";
    } else if (c === "_") {
      regex += ".";
    } else {
      regex += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  regex += "$";
  return new RegExp(regex).test(value);
}

/** Apply the route's own raw-SQL `WHERE` clause: `orgId`, action IN (...),
 * decision = 'allow', at > createdAt, containment (exact / two escaped LIKE
 * legs) minus the self-write exclusion. Positional, matching route.ts's
 * fixed interpolation order — real bound values from a real `$queryRaw`
 * call, not a re-typed guess at Prisma filter shape. */
function applyStalenessWhere(rows: Row[], values: [string, Date, string, string, string, string, number]): Row[] {
  const [orgId, createdAt, exactTarget, dotPattern, slashPattern, selfWriteTarget, limit] = values;
  const matched = rows
    .filter((r) => r.orgId === orgId)
    .filter((r) => r.action === "memory.write" || r.action === "memory.delete")
    .filter((r) => r.decision === "allow")
    .filter((r) => r.at > createdAt)
    .filter((r) => r.target === exactTarget || likeMatch(r.target, dotPattern) || likeMatch(r.target, slashPattern))
    .filter((r) => r.target !== selfWriteTarget)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  return matched.slice(0, limit);
}

const rc = {
  org: { id: "org_1" },
  user: { id: "user_1" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_1" } },
};
const params = (id: string) => ({ params: Promise.resolve({ id }) });

function arrangeBrief(scopePath: string, rows: Row[]) {
  vi.mocked(db.brief.findFirst).mockResolvedValue({
    scopePath,
    createdAt: BRIEF_CREATED_AT,
  } as never);
  vi.mocked(db.$queryRaw).mockImplementation((async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    const matched = applyStalenessWhere(rows, values as [string, Date, string, string, string, string, number]);
    return matched.map((r) => ({ action: r.action, target: r.target, at: r.at }));
  }) as never);
}

async function stalenessTargets(scopePath: string, rows: Row[]): Promise<string[]> {
  arrangeBrief(scopePath, rows);
  const res = await GET(new Request("http://t"), params("brief_1"));
  const body = (await res.json()) as { changed: boolean; changes: { target: string }[] };
  return body.changes.map((c) => c.target);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
  // Source visibility (surfaces #1/#2) is out of scope for this file's own
  // containment assertions — route.test.ts covers it directly.
  vi.mocked(db.source.findMany).mockResolvedValue([] as never);
  vi.mocked(check).mockResolvedValue({ allowed: true, reason: "ok" } as never);
  vi.mocked(db.grant.findMany).mockResolvedValue([] as never);
  vi.mocked(findScopeContradictions).mockResolvedValue([]);
  vi.mocked(fileSameTierScopeDisputes).mockResolvedValue([]);
});

describe("GET /api/briefs/:id/staleness — scope containment", () => {
  it("returns changes that are genuinely inside the brief's scope", async () => {
    const targets = await stalenessTargets("acme.eng", ROWS);
    expect(targets).toContain("acme.eng/fact:in-scope");
    expect(targets).toContain("acme.eng.backend/fact:descendant");
  });

  it("does not disclose writes in a sibling scope that merely shares a name prefix", async () => {
    const targets = await stalenessTargets("acme.eng", ROWS);
    expect(targets).not.toContain("acme.engineering/fact:other-team-roadmap");
    expect(targets).not.toContain("acme.engineering.secrets/fact:credentials");
  });

  it("does not flag a brief as stale when the only changes are in a sibling scope", async () => {
    const siblingOnly = ROWS.filter((r) => r.target.startsWith("acme.engineering"));
    arrangeBrief("acme.eng", siblingOnly);
    const res = await GET(new Request("http://t"), params("brief_1"));
    const body = (await res.json()) as { changed: boolean };
    expect(body.changed).toBe(false);
  });
});

// Postgres LIKE treats `_` as "any single character",
// and isValidLtreePath() (services/access/check.ts) permits `_` in an
// ordinary scope label, so an unescaped prefix pattern leaks a sibling scope
// differing only at an `_`/`-` position. Needs no attacker: both characters
// are valid label chars, so an org that happens to hold both `dept-sales`
// and `dept_sales` leaks one into the other's brief.
describe("GET /api/briefs/:id/staleness — LIKE wildcard in a scope label", () => {
  it("does not disclose a sibling scope differing from the brief's own scope only at an underscore", async () => {
    const rows: Row[] = [
      { orgId: "org_1", action: "memory.write", decision: "allow", target: "org_1.deptXsales.secret", at: AFTER },
    ];
    const targets = await stalenessTargets("org_1.dept_sales", rows);
    expect(targets).toEqual([]);
  });

  it("does not disclose the realistic hyphen/underscore naming-collision sibling", async () => {
    const rows: Row[] = [
      { orgId: "org_1", action: "memory.write", decision: "allow", target: "org_1.dept-sales.secret", at: AFTER },
    ];
    const targets = await stalenessTargets("org_1.dept_sales", rows);
    expect(targets).toEqual([]);
  });

  it("still surfaces a genuine descendant of a scope containing an underscore", async () => {
    const rows: Row[] = [
      { orgId: "org_1", action: "memory.write", decision: "allow", target: "org_1.dept_sales.secret", at: AFTER },
    ];
    const targets = await stalenessTargets("org_1.dept_sales", rows);
    expect(targets).toContain("org_1.dept_sales.secret");
  });
});

describe("GET /api/briefs/:id/staleness — the brief's own persist must not flag itself", () => {
  // Writes caused by the brief's own persist/correct actions are excluded, so
  // accepting/correcting the very brief being viewed cannot flag itself.
  // POST /api/briefs/:id/persist check()s
  // memory.write at the brief's own scopePath with target `brief:${id}`, so
  // recordAudit writes `${scopePath}/brief:${id}` — after brief.createdAt.
  it("ignores the audit rows the brief's own accept/correct wrote", async () => {
    const ownWrites: Row[] = [
      { orgId: "org_1", action: "memory.write", decision: "allow", target: "acme.eng/brief:brief_1", at: AFTER },
    ];
    arrangeBrief("acme.eng", ownWrites);
    const res = await GET(new Request("http://t"), params("brief_1"));
    const body = (await res.json()) as { changed: boolean; changes: unknown[] };
    expect(body.changed).toBe(false);
    expect(body.changes).toEqual([]);
  });
});
