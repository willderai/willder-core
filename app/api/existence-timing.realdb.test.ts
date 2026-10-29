// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Existence probes, the timing half. existence-probes.realdb
// .qa.test.ts proves a member gets the same status and body for a never-issued id and
// for a real record at a scope they cannot read. This file proves the two also take the
// same time, for the routes that look a record up before deciding on its scope. Before
// the absent path did the same authorization work as the hidden one, an absent id was
// answered after one lookup and a hidden record after the lookup, a grant evaluation,
// an audit write and a read probe, so the 404 could be timed to find real ids.
//
// Each route is called with the hidden id and the absent id in back-to-back pairs, so
// drift in the machine's load lands on both sides alike, and the median difference per
// pair is compared with a bound. Only authentication and calls that would leave the
// process are stubbed; the handlers, check() and the audit writes run against Postgres.
// briefs/[id]/existence-timing.realdb.test.ts does the same for the brief routes.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

const QA_URL = process.env.QA_DATABASE_URL;
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ORG = `org-timing-${RUN}`;
const ROOT = `org_${ORG}`;
/** The scope the member reads. */
const SIBLING = `${ROOT}.sales`;
/** The scope the records live at, which the member cannot read. */
const SECRET = `${ROOT}.secret`;
const MEMBER = `user-timing-member-${RUN}`;
const ABSENT_ID = `never-issued-${RUN}`;

const WARMUP = 20;
const SAMPLES = 150;

/**
 * The largest median difference allowed between a hidden and an absent call: a tenth
 * of the median call, and never under 0.2 ms. The same bound as the brief routes' test:
 * one extra indexed query costs about 0.5 ms locally, so it catches a path that skips
 * even one of the decision's queries, and being relative it does not fail on noise
 * alone on a loaded runner where every call is several times slower.
 */
function allowedGapMs(medianCallMs: number): number {
  return Math.max(0.2, medianCallMs / 10);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

interface Route {
  name: string;
  module: string;
  method: "POST" | "DELETE";
  body?: unknown;
}

const ROUTES: Route[] = [
  { name: "grant revoke", module: "./access/grants/[id]/route", method: "DELETE" },
  { name: "capability revoke", module: "./access/capabilities/[id]/route", method: "DELETE" },
  { name: "scope delete", module: "./access/scopes/[id]/route", method: "DELETE" },
  { name: "source disconnect", module: "./sources/[id]/route", method: "DELETE" },
  { name: "convention retire", module: "./memory/conventions/[id]/route", method: "DELETE" },
  {
    name: "dispute resolve",
    module: "./facts/disputes/[id]/resolve/route",
    method: "POST",
    body: { resolution: "existing" },
  },
];

describe.skipIf(!QA_URL)("look-up-first routes take as long to refuse a hidden record as an absent id", () => {
  let db: PrismaClient;
  const hidden: Record<string, string> = {};

  async function timeCall(route: Route, id: string): Promise<number> {
    const handler = ((await import(route.module)) as Record<string, Handler>)[route.method];
    const req = new Request(`http://t/api/${id}`, {
      method: route.method,
      ...(route.body === undefined
        ? {}
        : { body: JSON.stringify(route.body), headers: { "content-type": "application/json" } }),
    });
    const started = performance.now();
    const res = await handler(req, { params: Promise.resolve({ id }) });
    await res.text();
    const elapsed = performance.now() - started;
    expect(res.status, `${route.name} ${id}`).toBe(404);
    return elapsed;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    await db.org.create({ data: { id: ORG, name: "Existence timing" } });
    await db.user.create({
      data: { id: MEMBER, orgId: ORG, email: `${MEMBER}@timing.test`, role: "member", clerkId: `clerk-${MEMBER}` },
    });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "Org" } });
    const sibling = await db.scope.create({ data: { orgId: ORG, path: SIBLING, name: "Sales" } });
    const secret = await db.scope.create({ data: { orgId: ORG, path: SECRET, name: "Secret" } });
    // The tenant default (lib/tenant.ts), plus a read grant elsewhere, so the member's
    // decision evaluates real grants rather than an empty set.
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "role", granteeId: "admin", permission: "admin" },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: sibling.id, granteeType: "user", granteeId: MEMBER, permission: "read" },
    });

    hidden["grant revoke"] = (
      await db.grant.create({
        data: { orgId: ORG, scopeId: secret.id, granteeType: "user", granteeId: "someone", permission: "read" },
      })
    ).id;
    hidden["capability revoke"] = (
      await db.capability.create({
        data: {
          orgId: ORG,
          agentId: "handoff",
          tokenHash: `hash-${RUN}`,
          scopePath: SECRET,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      })
    ).id;
    hidden["scope delete"] = (await db.scope.create({ data: { orgId: ORG, path: `${SECRET}.leaf`, name: "Leaf" } })).id;
    hidden["source disconnect"] = (
      await db.source.create({
        data: { orgId: ORG, type: "posthog", externalId: `src-${RUN}`, name: "src", scopePath: SECRET },
      })
    ).id;
    hidden["convention retire"] = (
      await db.convention.create({
        data: { orgId: ORG, scopePath: SECRET, kind: "convention", subject: "s", text: "t", actorId: MEMBER },
      })
    ).id;
    hidden["dispute resolve"] = (
      await db.factDispute.create({
        data: {
          orgId: ORG,
          scopePath: SECRET,
          graphitiFactUuid: `fact-${RUN}`,
          proposerActorType: "human",
          proposerActorId: MEMBER,
          existingActorType: "human",
          existingActorId: MEMBER,
        },
      })
    ).id;

    const { requireAccessContext } = await import("@/lib/access-context");
    const org = await db.org.findUniqueOrThrow({ where: { id: ORG } });
    const user = await db.user.findUniqueOrThrow({ where: { id: MEMBER } });
    vi.mocked(requireAccessContext).mockResolvedValue({
      org,
      user,
      ctx: { orgId: ORG, actor: { type: "human", id: MEMBER, role: "member" }, origin: "app" },
    } as never);
  });

  afterAll(async () => {
    // Deleting the org removes its rows, audit rows included, through the cascades.
    await db.user.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
  });

  /**
   * Time `route` on its hidden record and on an absent id in back-to-back pairs, and
   * compare them by the median of the per-pair differences, alternating which side goes
   * first so neither always runs on a warmer pool.
   */
  it.each(ROUTES)(
    "$name: the median refusal time does not depend on whether the record exists",
    async (route) => {
      const hiddenId = hidden[route.name];
      for (let i = 0; i < WARMUP; i++) {
        await timeCall(route, hiddenId);
        await timeCall(route, ABSENT_ID);
      }
      const differences: number[] = [];
      const all: number[] = [];
      for (let i = 0; i < SAMPLES; i++) {
        let hiddenMs: number;
        let absentMs: number;
        if (i % 2) {
          hiddenMs = await timeCall(route, hiddenId);
          absentMs = await timeCall(route, ABSENT_ID);
        } else {
          absentMs = await timeCall(route, ABSENT_ID);
          hiddenMs = await timeCall(route, hiddenId);
        }
        differences.push(hiddenMs - absentMs);
        all.push(hiddenMs, absentMs);
      }
      const gap = median(differences);
      const bound = allowedGapMs(median(all));
      console.info(
        `${route.name}: hidden minus absent ${gap.toFixed(2)} ms, median call ${median(all).toFixed(2)} ms, bound ${bound.toFixed(2)} ms`,
      );
      expect(Math.abs(gap), `hidden minus absent, median per pair: ${gap.toFixed(2)} ms`).toBeLessThanOrEqual(bound);
    },
    60_000,
  );
});
