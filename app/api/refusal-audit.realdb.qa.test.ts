// Every authorization refusal an API route makes leaves exactly one deny row.
//
// One audit row per refusal, naming the principal and the decision. check() writes one for every decision it makes, and requireOrgRole()
// (lib/org-role.ts) one for every org-role refusal. That routes refuse only through
// those two is a lint rule (eslint.refusal-gate.mjs); this file proves, route by
// route against Postgres, that each refusal really leaves its one row.
//
// It needs QA_DATABASE_URL naming an isolated, migrated test Postgres; without it the
// tests are skipped, not failed. Only the signed-in identity is stubbed: the gates,
// check() and the audit writer all run against Postgres.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
// Routes that authenticate with the Clerk sign-in alone (org deletion's, which work after
// the org is gone) see the same member.
vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: `clerk-${RUN}` }) }));

const ROOT = resolve(__dirname, "../..");
const API = join(ROOT, "app/api");

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return name === "route.ts" ? [path] : [];
  });
}

const ROUTES = routeFiles(API).map((path) => ({
  path,
  name: relative(ROOT, path),
  source: readFileSync(path, "utf8"),
}));

/** The operations a route passes to requireOrgRole, read from its source. */
function orgRoleOperations(source: string): string[] {
  const constants = new Map([...source.matchAll(/const (\w+) = "([^"]+)";/g)].map((m) => [m[1], m[2]] as const));
  return [...source.matchAll(/requireOrgRole\(\s*rc,\s*\w+,\s*(?:"([^"]+)"|(\w+))\s*\)/g)].map(
    (m) => m[1] ?? constants.get(m[2]) ?? `<unresolved ${m[2]}>`,
  );
}

const QA_URL = process.env.QA_DATABASE_URL;
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ORG = `org-qa-refusals-${RUN}`;
const MEMBER = `user-qa-refusals-${RUN}`;

/** Routes whose refusals this file drives: every org-role gate and every
 * access.manage gate, the two kinds of refusal this file exists for. */
const GATED = ROUTES.filter(
  (r) => r.source.includes("requireOrgRole(") || r.source.includes('action: "access.manage"'),
);

/**
 * Gated routes a request with placeholder input cannot reach the gate of, and why.
 * Each still has every response it gives checked below; its refusal is driven with
 * real input by its own tests.
 */
const GATE_NEEDS_REAL_INPUT: Record<string, string> = {
  "app/api/access/capabilities/[id]/route.ts": "loads the token by id first; an unknown id is a 404",
  "app/api/access/grants/[id]/route.ts": "loads the grant by id first; an unknown id is a 404",
  "app/api/access/scopes/[id]/route.ts": "loads the scope by id first; an unknown id is a 404",
  "app/api/access/scopes/[id]/readers/route.ts": "loads the scope by id first; an unknown id is a 404",
  "app/api/access/search/route.ts": "validates the query before deciding",
  "app/api/audit/export/route.ts": "validates the format and date range before deciding",
  "app/api/briefs/[id]/retirement/route.ts": "loads the brief by id first; an unknown id is a 404",
  "app/api/org-deletion/[id]/cancel/route.ts": "loads the deletion by id first; an unknown id is a 404",
};

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** Dynamic segments for every route shape: a plain id, and the providers the
 * integration callback dispatches on. */
const PARAM_VARIANTS = [
  { id: "x", runId: "x", changeId: "x" },
  { id: "gmail", runId: "x", changeId: "x" },
  { id: "slack", runId: "x", changeId: "x" },
];

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

describe.skipIf(!QA_URL)("each refusal leaves exactly one deny row (real database)", () => {
  let db: PrismaClient;

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    await db.org.create({ data: { id: ORG, name: "Refusal audit QA" } });
    await db.user.create({
      data: { id: MEMBER, orgId: ORG, email: `${RUN}@refusals.test`, role: "member", clerkId: `clerk-${RUN}` },
    });
    const { orgRootPath } = await import("@/services/access");
    await db.scope.create({ data: { orgId: ORG, path: orgRootPath(ORG), name: "Org" } });
    const { requireAccessContext } = await import("@/lib/access-context");
    vi.mocked(requireAccessContext).mockResolvedValue({
      org: await db.org.findUniqueOrThrow({ where: { id: ORG } }),
      user: await db.user.findUniqueOrThrow({ where: { id: MEMBER } }),
      ctx: { orgId: ORG, actor: { type: "human", id: MEMBER, role: "member" }, origin: "app" },
    } as never);
  });

  afterAll(async () => {
    // Deleting the org removes its audit rows through the one cascade the
    // append-only trigger allows.
    await db.user.deleteMany({ where: { id: MEMBER } });
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
  });

  const denyRows = () =>
    db.auditLog.findMany({ where: { orgId: ORG, decision: "deny" }, orderBy: { chainSeq: "asc" } });

  it("discovers the gated routes, and every listed exception is still one of them", () => {
    expect(ROUTES.length).toBeGreaterThan(50);
    expect(GATED.length).toBeGreaterThanOrEqual(20);
    // The operations below are read from each route's source to know which refusals
    // to expect. The lint gate requires each to be a literal or a module-level const,
    // so every call must resolve; one that does not would silently go unchecked.
    for (const route of GATED) {
      const operations = orgRoleOperations(route.source);
      expect(operations, route.name).toHaveLength(route.source.match(/requireOrgRole\(/g)?.length ?? 0);
      expect(
        operations.filter((op) => op.startsWith("<unresolved")),
        route.name,
      ).toEqual([]);
    }
    const gated = new Set(GATED.map((r) => r.name));
    expect(Object.keys(GATE_NEEDS_REAL_INPUT).filter((name) => !gated.has(name))).toEqual([]);
  });

  for (const route of GATED) {
    it(`${route.name}: a member's 403 leaves one deny row naming them, and nothing else does`, async () => {
      const mod = (await import(route.path)) as Partial<Record<(typeof METHODS)[number], Handler>>;
      const refusedTargets: string[] = [];
      let refusals = 0;
      for (const method of METHODS) {
        const handler = mod[method];
        if (!handler) continue;
        for (const params of PARAM_VARIANTS) {
          const before = (await denyRows()).length;
          const req = new Request("http://t/api/route?state=x&code=x", {
            method,
            ...(method === "GET" ? {} : { body: "{}", headers: { "content-type": "application/json" } }),
          });
          const res = await handler(req, { params: Promise.resolve(params) });
          const added = (await denyRows()).slice(before);
          const label = `${route.name} ${method} ${JSON.stringify(params)} -> ${res.status}`;
          if (res.status === 403) {
            refusals++;
            expect(added, label).toHaveLength(1);
            expect(added[0], label).toMatchObject({ actorType: "human", actorId: MEMBER, decision: "deny" });
            expect(added[0].target, label).toMatch(new RegExp(`^org_${ORG}`.replace(/-/g, "\\-")));
            refusedTargets.push(added[0].target ?? "");
          } else {
            // A refusal answered as a 404 so it reveals nothing may still record its
            // one decision; no response records more than one.
            expect(added.length, label).toBeLessThanOrEqual(res.status === 404 ? 1 : 0);
          }
        }
      }
      if (!(route.name in GATE_NEEDS_REAL_INPUT)) {
        expect(refusals, `${route.name} refused no request from a member`).toBeGreaterThan(0);
      }
      for (const operation of orgRoleOperations(route.source)) {
        expect(refusedTargets, `${route.name}: ${operation} was never reached`).toContain(`org_${ORG}/${operation}`);
      }
    });
  }
});
