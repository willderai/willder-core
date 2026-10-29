// Fact governance (UC9 — the conflict-resolution / "fact PRs" mechanism) — live check.
// Run with: npm run fact-governance:check
//
// Structured like scripts/check-handoff.ts: the plumbing that needs no live LLM /
// memory-service always runs against real Neon; anything needing real contradiction
// detection or a correction round-trip is gated behind FACTGOV_LIVE=1.
//
//   PART A — Scope-admin authority + cross-org isolation (ALWAYS runs, live Neon).
//     Who may resolve a dispute is exactly "admin on the dispute's scope" — proven via
//     the real check() gate against real scopes/grants, with the same
//     scope/grant/user setup the other check scripts use. No fact_disputes table needed: this is the authorization
//     layer that governs resolution, independent of the row storage.
//
//   PART B — fact_disputes row lifecycle (runs only if the table has been migrated).
//     Insert a disputed row, assert the pending-in-scope query returns it while
//     status=disputed, assert each of the three resolutions transitions status + stamps
//     resolverId/resolvedAt, and that a dispute in org B is invisible/unresolvable from
//     org A. Uses raw SQL against the real table (the Prisma FactDispute model may not be
//     generated yet while Phase 2 is built in parallel), introspecting the status enum
//     type name so it survives whatever the migration names it.
//
//   PART C — Real contradiction detection + correction auto-merge (FACTGOV_LIVE=1 only;
//     needs memory-service + an LLM key). Written, not required to run this session.
//
// Exits non-zero on any failure. Cleans up its throwaway orgs on completion.
//
// Part B seeds and inspects `fact_disputes` rows directly: an operator diagnostic
// run by hand with the database owner's credentials, never on a request path, and
// listed in OPERATOR_SCRIPTS (eslint.memory-access.mjs) for that reason.
import { createId } from "@paralleldrive/cuid2";
import { db } from "@/lib/db";
import { check, orgRootPath } from "@/services/access";
import type { UserRole } from "@/types/domain";

const LIVE = process.env.FACTGOV_LIVE === "1";

let passed = 0;
let failed = 0;
function ok(msg: string) {
  console.log(`  ✓ ${msg}`);
  passed++;
}
function fail(msg: string) {
  console.log(`  ✗ ${msg}`);
  failed++;
}
function assert(cond: boolean, msg: string) {
  if (cond) ok(msg);
  else fail(msg);
}

/** Does the fact_disputes table exist in this database yet? */
async function factDisputesTable(): Promise<boolean> {
  const rows = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM information_schema.tables
    WHERE table_name = 'fact_disputes'`;
  return Number(rows[0]?.n ?? 0) > 0;
}

/** The Postgres enum type backing fact_disputes.status (Prisma names it, we don't guess). */
async function statusEnumType(): Promise<string> {
  const rows = await db.$queryRaw<{ udt_name: string }[]>`
    SELECT udt_name FROM information_schema.columns
    WHERE table_name = 'fact_disputes' AND column_name = 'status'`;
  return rows[0]?.udt_name ?? "DisputeStatus";
}

async function main() {
  console.log("\n  FACT GOVERNANCE CHECK (UC9 — conflict resolution / fact PRs)\n");

  // ── PART A ────────────────────────────────────────────────────────────────
  console.log("Scope-admin authority + cross-org isolation (live check(), no table needed)...");

  const orgA = await db.org.create({ data: { name: "__factgov_check_A__" } });
  const orgB = await db.org.create({ data: { name: "__factgov_check_B__" } });

  try {
    const rootA = orgRootPath(orgA.id);
    await db.scope.create({ data: { orgId: orgA.id, path: rootA, name: "Org A root" } });
    const engA = await db.scope.create({ data: { orgId: orgA.id, path: `${rootA}.engineering`, name: "Engineering" } });
    const salesA = await db.scope.create({ data: { orgId: orgA.id, path: `${rootA}.sales`, name: "Sales" } });

    const rootB = orgRootPath(orgB.id);
    await db.scope.create({ data: { orgId: orgB.id, path: rootB, name: "Org B root" } });

    // Users in org A: an admin on engineering (the resolver), a read-only member on
    // engineering (a participant, not a resolver), and a user scoped only to sales.
    const engAdmin = await db.user.create({
      data: { orgId: orgA.id, clerkId: `__fg_engadmin_${orgA.id}`, email: "engadmin@fg.test", role: "admin" },
    });
    await db.grant.create({
      data: { orgId: orgA.id, scopeId: engA.id, granteeType: "user", granteeId: engAdmin.id, permission: "admin" },
    });

    const engMember = await db.user.create({
      data: { orgId: orgA.id, clerkId: `__fg_engmember_${orgA.id}`, email: "engmember@fg.test", role: "member" },
    });
    await db.grant.create({
      data: { orgId: orgA.id, scopeId: engA.id, granteeType: "user", granteeId: engMember.id, permission: "read" },
    });

    const salesUser = await db.user.create({
      data: { orgId: orgA.id, clerkId: `__fg_sales_${orgA.id}`, email: "sales@fg.test", role: "member" },
    });
    await db.grant.create({
      data: { orgId: orgA.id, scopeId: salesA.id, granteeType: "user", granteeId: salesUser.id, permission: "admin" },
    });

    // An admin in org B — no grants in org A at all.
    const orgBAdmin = await db.user.create({
      data: { orgId: orgB.id, clerkId: `__fg_bcnetworkadmin_${orgB.id}`, email: "admin@fg-b.test", role: "admin" },
    });

    const ctx = (orgId: string, u: { id: string; role: UserRole }) => ({
      orgId,
      actor: { type: "human" as const, id: u.id, role: u.role },
      origin: "script" as const,
    });

    // access.manage on the dispute's scope is exactly the "scope-admin can resolve" rule.
    assert(
      (await check(ctx(orgA.id, engAdmin), { action: "access.manage", scope: engA.path })).allowed,
      "engineering admin MAY resolve disputes in the engineering scope (access.manage allowed)",
    );
    assert(
      !(await check(ctx(orgA.id, engMember), { action: "access.manage", scope: engA.path })).allowed,
      "a read-only engineering member may NOT resolve engineering disputes (no admin on scope)",
    );
    assert(
      !(await check(ctx(orgA.id, salesUser), { action: "access.manage", scope: engA.path })).allowed,
      "a sales admin may NOT resolve engineering disputes (admin is scope-local, not org-wide)",
    );
    assert(
      (await check(ctx(orgA.id, salesUser), { action: "access.manage", scope: salesA.path })).allowed,
      "the sales admin MAY resolve disputes in their own sales scope",
    );

    // Cross-org: org B's admin has zero authority over org A's scopes.
    assert(
      !(await check(ctx(orgB.id, orgBAdmin), { action: "access.manage", scope: engA.path })).allowed,
      "an admin in org B may NOT resolve a dispute in org A's engineering scope (cross-org isolation)",
    );

    // ── PART B ──────────────────────────────────────────────────────────────
    console.log("\nfact_disputes row lifecycle (raw SQL against the real table)...");
    const hasTable = await factDisputesTable();
    if (!hasTable) {
      console.log("  ⚠ fact_disputes table not migrated yet — skipping row-lifecycle assertions.");
      console.log("    (Phase 2 backend is built in parallel; this block activates once the");
      console.log("     migration lands, no change needed here.)");
    } else {
      const enumType = await statusEnumType();

      // Helper: the pending-disputes-in-scope query the GET route runs.
      const pendingInScope = (orgId: string, scopePath: string) =>
        db.$queryRawUnsafe<{ id: string; status: string }[]>(
          `SELECT id, status::text AS status FROM "fact_disputes"
           WHERE "orgId" = $1 AND status = 'disputed'::"${enumType}"
             AND "scopePath"::ltree <@ $2::ltree
           ORDER BY "createdAt" DESC`,
          orgId,
          scopePath,
        );

      async function insertDispute(orgId: string, scopePath: string): Promise<string> {
        const id = createId();
        await db.$executeRawUnsafe(
          `INSERT INTO "fact_disputes"
             ("id","orgId","scopePath","graphitiFactUuid",
              "proposerActorType","proposerActorId","existingActorType","existingActorId",
              "status","createdAt")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'disputed'::"${enumType}",(now() AT TIME ZONE 'UTC'))`,
          id,
          orgId,
          scopePath,
          `fact-${id}`,
          "human",
          "user_kenji",
          "human",
          "user_priya",
        );
        return id;
      }

      async function resolve(id: string, status: string, resolverId: string, value?: string) {
        await db.$executeRawUnsafe(
          `UPDATE "fact_disputes"
             SET "status" = $1::"${enumType}", "resolverId" = $2, "resolvedAt" = (now() AT TIME ZONE 'UTC'),
                 "resolvedValue" = $3
           WHERE id = $4`,
          status,
          resolverId,
          value ?? null,
          id,
        );
      }

      // 1. A disputed row in org A / engineering is returned by the pending-in-scope query.
      const dispId = await insertDispute(orgA.id, engA.path);
      let pending = await pendingInScope(orgA.id, rootA);
      assert(
        pending.some((d) => d.id === dispId),
        "a disputed row in engineering is returned by the pending-in-scope query (status=disputed)",
      );
      // It also shows when querying the engineering scope directly (containment).
      pending = await pendingInScope(orgA.id, engA.path);
      assert(
        pending.some((d) => d.id === dispId),
        "the same disputed row shows when scoped to engineering directly (ltree containment)",
      );

      // 2. Each of the three resolutions transitions status + stamps resolver/resolvedAt.
      const transitions: { resolution: string; status: string; value?: string }[] = [
        { resolution: "proposer", status: "resolved_proposer" },
        { resolution: "existing", status: "resolved_existing" },
        { resolution: "reconciled", status: "resolved_reconciled", value: "ltree only; closure table removed by Q3" },
      ];
      for (const t of transitions) {
        const id = await insertDispute(orgA.id, engA.path);
        await resolve(id, t.status, engAdmin.id, t.value);
        const [row] = await db.$queryRawUnsafe<
          { status: string; resolverId: string | null; resolvedAt: Date | null; resolvedValue: string | null }[]
        >(
          `SELECT status::text AS status, "resolverId", "resolvedAt", "resolvedValue" FROM "fact_disputes" WHERE id = $1`,
          id,
        );
        assert(row.status === t.status, `resolution "${t.resolution}" → status ${t.status}`);
        assert(row.resolverId === engAdmin.id, `resolution "${t.resolution}" stamps resolverId`);
        assert(row.resolvedAt instanceof Date, `resolution "${t.resolution}" stamps resolvedAt`);
        if (t.value !== undefined)
          assert(row.resolvedValue === t.value, `resolution "reconciled" stores the reconciled value`);
        // A resolved dispute drops out of the pending-in-scope query.
        const stillPending = await pendingInScope(orgA.id, engA.path);
        assert(!stillPending.some((d) => d.id === id), `a resolved dispute no longer appears as pending`);
      }

      // 3. Cross-org isolation: a dispute in org B is invisible / unresolvable from org A.
      const bScope = `${rootB}.engineering`;
      const orgBDisp = await insertDispute(orgB.id, bScope);
      const fromA = await pendingInScope(orgA.id, rootA);
      assert(!fromA.some((d) => d.id === orgBDisp), "org B's dispute is INVISIBLE to org A's pending-in-scope query");
      const scopedUpdate = await db.$executeRawUnsafe(
        `UPDATE "fact_disputes" SET "status" = 'resolved_existing'::"${enumType}", "resolverId" = $1, "resolvedAt" = (now() AT TIME ZONE 'UTC')
         WHERE id = $2 AND "orgId" = $3`,
        engAdmin.id,
        orgBDisp,
        orgA.id, // org-scoped WHERE (as the route does) — must match 0 rows
      );
      assert(
        Number(scopedUpdate) === 0,
        "an org-A-scoped resolve UPDATE matches 0 rows for org B's dispute (cross-org unresolvable)",
      );
    }

    // ── PART C ────────────────────────────────────────────────────────────────
    if (LIVE) {
      console.log("\nReal contradiction detection + correction auto-merge (FACTGOV_LIVE=1)...");
      const { memory } = await import("@/services/memory/store");
      // runArchitectureAgent is built in parallel; access defensively so tsc stays clean
      // whether or not the export exists yet.
      const runner = (await import("@/services/agents/runner")) as Record<string, unknown>;
      const runArchitectureAgent = runner.runArchitectureAgent as
        | ((opts: Record<string, unknown>) => Promise<{ title: string; summary: string; sections: unknown[] }>)
        | undefined;

      const rootA2 = orgRootPath(orgA.id);
      const engPath = `${rootA2}.engineering`;

      // Two decisions that genuinely conflict (mirrors docs/demo-seed/07_contradiction_demo.md):
      // an earlier "use SQS" decision and a later "we moved off SQS to Postgres queue" one.
      await memory.ingest({
        groupId: orgA.id,
        content: "Decision (Jun): the job queue runs on Amazon SQS for the outbound send pipeline.",
        source: "text",
        name: "Queue decision (old)",
        actorType: "human",
        origin: "script",
        actorId: "user_priya",
        actorName: "Priya",
        scopePath: engPath,
      });
      await memory.ingest({
        groupId: orgA.id,
        content:
          "Decision (Jul): we moved the job queue off SQS to a Postgres-backed queue; SQS cost and the extra infra weren't worth it at our volume.",
        source: "text",
        name: "Queue decision (new)",
        actorType: "human",
        origin: "script",
        actorId: "user_kenji",
        actorName: "Kenji",
        scopePath: engPath,
      });

      if (runArchitectureAgent) {
        const agentRow = await db.agent.create({
          data: { orgId: orgA.id, agentKey: "arch-factgov-check", name: "Architecture agent", role: "architecture" },
        });
        // The architecture route provisions a scoped capability; reuse the handoff
        // provisioner shape if the architecture one isn't exported yet.
        const { provisionHandoffAgentCapability } = await import("@/lib/handoff-agent");
        const token = await provisionHandoffAgentCapability(orgA.id, engPath, engAdmin.id);
        const plan = await runArchitectureAgent({
          agentRow,
          orgId: orgA.id,
          capabilityToken: token,
          memoryScope: engPath,
          title: "Outbound queue",
          context: "planning the send pipeline",
        });
        const text = JSON.stringify(plan).toLowerCase();
        assert(
          text.includes("sqs") || text.includes("postgres") || text.includes("queue"),
          "the architecture plan surfaces the queue decision area",
        );
        assert(
          text.includes("moved off") ||
            text.includes("contradict") ||
            text.includes("superseded") ||
            text.includes("postgres-backed"),
          "the plan reflects the LATER decision / flags the change (contradiction awareness)",
        );
      } else {
        console.log("  ⚠ runArchitectureAgent not exported yet — ingested the contradiction, skipped the agent run.");
      }
    } else {
      console.log("\n  (skipping real contradiction + correction round-trip — set FACTGOV_LIVE=1 to run it)");
    }
  } finally {
    await db.org.delete({ where: { id: orgA.id } });
    await db.org.delete({ where: { id: orgB.id } });
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
