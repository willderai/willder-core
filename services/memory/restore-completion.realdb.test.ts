// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A backup restore completes itself (docs/consent-deletion-suite.md, "Restore procedure"):
// copying the live suppression list back into a restored database marks each org it adds
// entries to as due for a re-apply (migration 20261019100000_erasure_reapply_due). While an
// org is due, check() refuses everything in it but access.manage, and the connector sync
// writes nothing; the restore-completion job (lib/inngest/person-erasure.ts) re-applies the
// org's erasures and ends the due row, and reads work again without the erased person.
//
// The restore is played as person-erasure-restore.realdb.test.ts plays it: the person's rows
// are copied before the erasure and written back after it, and the restored database's list
// is the backup's (empty). The copy-back is the procedure's own SQL, through a staging table,
// on a plain connection, as an operator's psql runs it.
//
// Real: Postgres, check(), the erasure, the re-apply, the list trigger, contact_search, the
// sync job and the completion job with a stand-in step runner. Stand-in: the graph store.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";
import { seedMember } from "@/services/access/member.testsupport";

vi.mock("./store", () => ({
  memory: { ingest: vi.fn() },
  graphitiStore: {
    planPersonErasure: async () => [],
    erasePerson: async () => ({ episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] }),
    removeEpisode: async () => ({ removed: true }),
    removeChunkFacts: async () => {},
  },
}));
vi.mock("@/services/guardrails", () => ({ checkEpisodeCap: vi.fn(), recordEpisode: vi.fn() }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_restore_due";
const FRESH = "qa_restore_due_fresh";
const ROOT = `org_${ORG}`;
const FRESH_ROOT = `org_${FRESH}`;
const ADMIN = "qa_restore_due_admin";
const READER = "qa_restore_due_reader";
const FRESH_READER = "qa_restore_due_fresh_reader";
const FRESH_ADMIN = "qa_restore_due_fresh_admin";
const AGENT = "qa-restore-due-agent";
const TOKEN = "qa-restore-due-token";

const NAME = "Talvi Quenmor";
const EMAIL = "talvi.quenmor@restore.example";

describe.skipIf(!QA_URL)(
  "a restore completes itself: a copied-back list refuses the org until its erasures are re-applied",
  () => {
    let db: PrismaClient;
    let check: (typeof import("@/services/access"))["check"];
    let AccessDeniedError: (typeof import("@/services/access"))["AccessDeniedError"];
    let searchContacts: (typeof import("@/services/contacts/agent-contacts"))["searchContacts"];
    let erasePerson: (typeof import("./person-erasure"))["erasePerson"];
    let completeRestore: (typeof import("./erasure-reapply"))["completeRestore"];
    let reapplyDue: (typeof import("./erasure-suppression"))["reapplyDue"];
    let erasuresApplied: (typeof import("./erasure-suppression"))["erasuresApplied"];
    let recordErasedVersions: (typeof import("./erasure-suppression"))["recordErasedVersions"];
    type Job = { fn: (ctx: unknown) => Promise<Record<string, unknown>> };
    let restoreCompletion: Job;
    let sourceSync: Job;

    const admin: AccessContext = { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" };
    const reader: AccessContext = { orgId: ORG, actor: { type: "human", id: READER, role: "member" }, origin: "app" };
    const agent: AccessContext = {
      orgId: ORG,
      actor: { type: "agent", id: AGENT, capabilityToken: TOKEN },
      origin: "mcp",
    };
    const freshReader: AccessContext = {
      orgId: FRESH,
      actor: { type: "human", id: FRESH_READER, role: "member" },
      origin: "app",
    };
    const longAgo = new Date(Date.now() - 24 * 3600 * 1000);
    /** One stand-in step runner: runs each step and records its name. */
    const stepRunner = (steps: string[]) => ({
      run: async (name: string, fn: () => unknown) => (steps.push(name), fn()),
    });

    /** The names contact_search returns for `query`, or the refusal's reason. */
    async function contactsFound(ctx: AccessContext, query: string): Promise<string[] | string> {
      try {
        return (await searchContacts(ctx, { query, limit: 50 })).map((c) => c.name).sort();
      } catch (e) {
        if (e instanceof AccessDeniedError) return e.decision.reason;
        throw e;
      }
    }

    async function wipe() {
      for (const orgId of [ORG, FRESH]) {
        await db.$executeRaw`DELETE FROM orgs WHERE id = ${orgId}`;
        await db.auditLog.deleteMany({ where: { orgId } });
        await db.$executeRaw`DELETE FROM users WHERE "orgId" = ${orgId}`;
      }
    }

    /** The procedure's step 2, as an operator's psql runs it: a staging table, then one insert. */
    async function copyBackList(
      rows: {
        id: string;
        orgId: string;
        kind: string;
        digest: string;
        wordCount: number | null;
        requestId: string;
        createdAt: Date;
      }[],
    ) {
      const client = new pg.Client({ connectionString: QA_URL });
      await client.connect();
      try {
        await client.query("BEGIN");
        await client.query("CREATE TEMP TABLE staging (LIKE erasure_suppressions) ON COMMIT DROP");
        for (const r of rows) {
          await client.query(
            `INSERT INTO staging (id, "orgId", kind, digest, "wordCount", "requestId", "createdAt") VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [r.id, r.orgId, r.kind, r.digest, r.wordCount, r.requestId, r.createdAt],
          );
        }
        await client.query(
          `INSERT INTO erasure_suppressions SELECT * FROM staging ON CONFLICT ("orgId", kind, digest) DO NOTHING`,
        );
        await client.query("COMMIT");
      } finally {
        await client.end();
      }
    }

    /** One list entry inserted on its own connection after `setup`, as a restore tool's session runs it. */
    async function insertOnPlainConnection(setup: string, r: Parameters<typeof copyBackList>[0][number]) {
      const client = new pg.Client({ connectionString: QA_URL });
      await client.connect();
      try {
        await client.query(setup);
        await client.query(
          `INSERT INTO public.erasure_suppressions (id, "orgId", kind, digest, "wordCount", "requestId", "createdAt") VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [r.id, r.orgId, r.kind, r.digest, r.wordCount, r.requestId, r.createdAt],
        );
      } finally {
        await client.end();
      }
    }

    /**
     * Erase the person, then restore the backup taken before it: her contact comes back, the
     * restored list and markers are the backup's (none), and the live list is copied back.
     */
    async function eraseThenRestore() {
      const contact = await db.contact.findUniqueOrThrow({
        where: { id: "talvi" },
        select: { id: true, orgId: true, name: true, email: true, createdAt: true },
      });
      await erasePerson(admin, { contactId: "talvi" });
      expect(await reapplyDue(ORG)).toBe(false);
      const live = await db.erasureSuppression.findMany({ where: { orgId: ORG } });
      expect(live.length).toBeGreaterThan(0);
      await db.contact.create({ data: contact });
      await db.erasureSuppressionApplied.deleteMany({ where: { orgId: ORG } });
      await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
      await copyBackList(live);
    }

    beforeAll(async () => {
      process.env.DATABASE_URL = QA_URL;
      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
      ({ check, AccessDeniedError } = await import("@/services/access"));
      ({ searchContacts } = await import("@/services/contacts/agent-contacts"));
      ({ erasePerson } = await import("./person-erasure"));
      ({ completeRestore } = await import("./erasure-reapply"));
      ({ reapplyDue, erasuresApplied, recordErasedVersions } = await import("./erasure-suppression"));
      restoreCompletion = (await import("@/lib/inngest/person-erasure")).restoreCompletion as unknown as Job;
      sourceSync = (await import("@/lib/inngest")).sourceSync as unknown as Job;
    });

    afterAll(async () => {
      if (!db) return;
      await wipe();
      await db.$disconnect();
    });

    beforeEach(async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await wipe();
      const { hashCapabilityToken } = await import("@/services/access/capabilities");
      for (const [orgId, root] of [
        [ORG, ROOT],
        [FRESH, FRESH_ROOT],
      ] as const) {
        await db.org.create({ data: { id: orgId, name: orgId } });
        await db.scope.create({ data: { orgId, path: root, name: "root" } });
      }
      const root = await db.scope.findFirstOrThrow({ where: { orgId: ORG, path: ROOT } });
      const freshRoot = await db.scope.findFirstOrThrow({ where: { orgId: FRESH, path: FRESH_ROOT } });
      await seedMember(db, { orgId: ORG, userId: ADMIN, role: "admin" });
      await seedMember(db, { orgId: ORG, userId: READER });
      await seedMember(db, { orgId: FRESH, userId: FRESH_READER });
      await seedMember(db, { orgId: FRESH, userId: FRESH_ADMIN, role: "admin" });
      await db.grant.createMany({
        data: [
          { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
          { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: READER, permission: "read" },
          { orgId: FRESH, scopeId: freshRoot.id, granteeType: "user", granteeId: FRESH_READER, permission: "read" },
          { orgId: FRESH, scopeId: freshRoot.id, granteeType: "user", granteeId: FRESH_ADMIN, permission: "admin" },
        ],
      });
      await db.capability.create({
        data: {
          orgId: ORG,
          agentId: AGENT,
          tokenHash: hashCapabilityToken(TOKEN),
          scopePath: ROOT,
          permission: "read",
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      await db.contact.createMany({
        data: [
          { id: "talvi", orgId: ORG, name: NAME, email: EMAIL, createdAt: longAgo },
          { id: "kenji", orgId: ORG, name: "Kenji Sato", email: "kenji@acme.example", createdAt: longAgo },
          { id: "fresh-talvi", orgId: FRESH, name: NAME, email: EMAIL, createdAt: longAgo },
        ],
      });
    });

    it("refuses every reader of the restored org, naming the fix, and never serves the erased person", async () => {
      await eraseThenRestore();
      expect(await reapplyDue(ORG)).toBe(true);
      const refusal = /restored from a backup.*scripts\/complete-restore\.ts/;
      for (const ctx of [reader, agent, admin]) {
        expect(await contactsFound(ctx, NAME)).toMatch(refusal);
        expect(await contactsFound(ctx, "Kenji")).toMatch(refusal);
        expect(await check(ctx, { action: "memory.read", scope: ROOT })).toMatchObject({
          allowed: false,
          reason: expect.stringMatching(refusal),
        });
      }
      expect(await check(admin, { action: "memory.write", scope: ROOT })).toMatchObject({
        allowed: false,
        reason: expect.stringMatching(refusal),
      });
      // The re-apply's own access stays open; another org is untouched.
      expect((await check(admin, { action: "access.manage", target: "person_erasure:reapply" })).allowed).toBe(true);
      expect(await contactsFound(freshReader, NAME)).toEqual([NAME]);
    });

    // The procedure's form (a staging table) and a plain insert both mark the org due; COPY fires
    // the same row trigger. Only the org the copy adds an entry to is marked.
    it.each([
      ["through a staging table", (row: Parameters<typeof copyBackList>[0][number]) => copyBackList([row])],
      [
        "by a plain insert",
        async (row: Parameters<typeof copyBackList>[0][number]) => {
          await db.$executeRaw`INSERT INTO erasure_suppressions (id, "orgId", kind, digest, "wordCount", "requestId", "createdAt")
        VALUES (${row.id}, ${row.orgId}, ${row.kind}, ${row.digest}, NULL, ${row.requestId}, ${row.createdAt})`;
        },
      ],
      // pg_restore --data-only, and psql running pg_dump's output, empty search_path
      // before loading. The trigger's unqualified "erasure_reapply_due" then fails the copy, and
      // pg_restore goes on ("errors ignored on restore"), leaving the list not copied back at all.
      [
        "as pg_dump's output loads it, with an empty search_path",
        (row: Parameters<typeof copyBackList>[0][number]) =>
          insertOnPlainConnection("SELECT pg_catalog.set_config('search_path', '', false)", row),
      ],
      // Replication-based copy tools load with session_replication_role = replica,
      // which skips an ordinary trigger (ENABLE ALWAYS TRIGGER fires there too).
      [
        "under session_replication_role = replica, as replication-based copy tools load",
        (row: Parameters<typeof copyBackList>[0][number]) =>
          insertOnPlainConnection("SET session_replication_role = replica", row),
      ],
    ] as const)("a list entry copied in %s marks only its org due", async (_, copyIn) => {
      await copyIn({
        id: "copied-entry",
        orgId: FRESH,
        kind: "email",
        digest: "copied-digest",
        wordCount: null,
        requestId: "req-copied",
        createdAt: longAgo,
      });
      expect(await db.erasureReapplyDue.findMany({ select: { orgId: true } })).toEqual([{ orgId: FRESH }]);
      expect(await contactsFound(freshReader, NAME)).toMatch(/restored from a backup/);
      expect(await contactsFound(reader, "Kenji")).toEqual(["Kenji Sato"]);
    });

    it("a copy-back of an entry the backup already holds, from an erasure running at backup time, marks its org due", async () => {
      const entry = {
        id: "inflight-entry",
        orgId: FRESH,
        kind: "email",
        digest: "inflight-digest",
        wordCount: null,
        requestId: "req-inflight",
        createdAt: longAgo,
      };
      // In the backup: listed by the app, never marked applied.
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.erasure_listing', 'on', true) AS listing`;
        await tx.erasureSuppression.create({ data: entry });
      });
      expect(await reapplyDue(FRESH)).toBe(false);
      await copyBackList([entry]);
      expect(await reapplyDue(FRESH)).toBe(true);
    });

    it("an agent the org switched off is told so, not that the restore is incomplete", async () => {
      await db.agent.create({
        data: { orgId: ORG, agentKey: AGENT, name: "Restore agent", role: "research", active: false },
      });
      await eraseThenRestore();
      expect(await contactsFound(agent, "Kenji")).toMatch(/deactivated/);
    });

    it("the copy-back trigger fires in every session role and resolves no name through the session's search_path", async () => {
      const [fn] = await db.$queryRaw<{ config: string[] | null; enabled: string }[]>`
      SELECT p.proconfig AS config, t.tgenabled::text AS enabled
      FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgname = 'erasure_suppressions_copied_in'`;
      // 'A': ENABLE ALWAYS. Pinned to pg_catalog, pg_temp: no schema a role can create in is on the path.
      expect(fn).toEqual({ config: ["search_path=pg_catalog, pg_temp"], enabled: "A" });
    });

    it("the sync job writes nothing for a due org and leaves the source as it was", async () => {
      await db.source.create({
        data: {
          id: "src-due",
          orgId: ORG,
          type: "github",
          externalId: "acme/sales",
          name: "acme/sales",
          scopePath: ROOT,
          status: "active",
        },
      });
      await eraseThenRestore();
      const steps: string[] = [];
      const result = await sourceSync.fn({
        event: { data: { sourceId: "src-due", orgId: ORG } },
        step: stepRunner(steps),
      });
      expect(result).toMatchObject({ restoreIncomplete: true, synced: 0 });
      expect(steps).toEqual(["check-restore-complete"]);
      expect((await db.source.findUniqueOrThrow({ where: { id: "src-due" } })).status).toBe("active");
    });

    it("the completion job re-applies the erasures, ends the due row, and reads work without the person", async () => {
      await eraseThenRestore();
      const result = await restoreCompletion.fn({ step: stepRunner([]) });
      expect(result).toEqual({ orgs: 1, notApplied: [] });
      expect(await reapplyDue(ORG)).toBe(false);
      expect(await erasuresApplied(ORG)).toBe(true);
      expect(await db.contact.count({ where: { orgId: ORG, id: "talvi" } })).toBe(0);
      for (const ctx of [reader, agent]) {
        expect(await contactsFound(ctx, NAME)).toEqual([]);
        expect(await contactsFound(ctx, "Kenji")).toEqual(["Kenji Sato"]);
      }
      // Run again: nothing due, nothing read beyond the one check, nothing removed.
      expect(await restoreCompletion.fn({ step: stepRunner([]) })).toEqual({ orgs: 0, notApplied: [] });
      expect(await completeRestore()).toContainEqual({ orgId: ORG, applied: true });
    });

    it("an org that never had a restore is never due: the app's own list writes mark nothing", async () => {
      await erasePerson(
        { orgId: FRESH, actor: { type: "human", id: FRESH_ADMIN, role: "admin" }, origin: "app" },
        { contactId: "fresh-talvi" },
      );
      expect(await contactsFound(freshReader, NAME)).toEqual([]);
      await db.$transaction((tx) => recordErasedVersions(tx, FRESH, "req-fresh", ["v-fresh"]));
      await db.$transaction((tx) => recordErasedVersions(tx, ORG, "req-org", ["v-org"]));
      expect(await db.erasureReapplyDue.count()).toBe(0);
      expect(await contactsFound(reader, "Kenji")).toEqual(["Kenji Sato"]);
      expect(await contactsFound(agent, "Kenji")).toEqual(["Kenji Sato"]);
      expect(await restoreCompletion.fn({ step: stepRunner([]) })).toEqual({ orgs: 0, notApplied: [] });
    });

    it("two completions and reads at once: every read is refused or clean, and the org ends applied and not due", async () => {
      await eraseThenRestore();
      const reads = Array.from({ length: 6 }, (_, i) => contactsFound(i % 2 ? reader : agent, NAME));
      const [first, second, ...answers] = await Promise.all([
        completeRestore({ only: "due" }),
        completeRestore({ only: "due" }),
        ...reads,
      ]);
      // A read before the re-apply commits is refused; one after it finds no one by her name.
      for (const answer of answers) {
        if (typeof answer === "string") expect(answer).toMatch(/restored from a backup/);
        else expect(answer).toEqual([]);
      }
      expect([...first, ...second].filter((c) => c.orgId === ORG).some((c) => c.applied)).toBe(true);
      expect(await reapplyDue(ORG)).toBe(false);
      expect(await erasuresApplied(ORG)).toBe(true);
      expect(await contactsFound(reader, NAME)).toEqual([]);
      // Idempotent: nothing is due, and a full run leaves the org applied without re-applying it.
      expect(await completeRestore({ only: "due" })).toEqual([]);
      expect(await completeRestore()).toContainEqual({ orgId: ORG, applied: true });
    });

    it("an entry copied back while the re-apply runs keeps the org due until the next run covers it", async () => {
      await eraseThenRestore();
      const late = new pg.Client({ connectionString: QA_URL });
      await late.connect();
      try {
        // A second copy-back, held open: its trigger holds the org's applied-markers lock.
        await late.query("BEGIN");
        await late.query(
          `INSERT INTO erasure_suppressions (id, "orgId", kind, digest, "wordCount", "requestId", "createdAt") VALUES ('late-entry', $1, 'email', 'late-digest', NULL, 'req-late', $2)`,
          [ORG, longAgo],
        );
        const running = completeRestore({ only: "due" });
        // The re-apply listed the org before the late entry committed; wait until it is blocked on the lock.
        for (let polls = 0, waiting = 0; waiting === 0; polls++) {
          if (polls === 500) throw new Error("the re-apply never waited on the open copy-back's lock");
          if (polls > 0) await new Promise((resolve) => setTimeout(resolve, 20));
          waiting = (
            await late.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM pg_locks
             WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
            )
          ).rows[0]!.n;
        }
        await late.query("COMMIT");
        expect(await running).toEqual([expect.objectContaining({ orgId: ORG, applied: false })]);
        expect(await reapplyDue(ORG)).toBe(true);
        expect(await contactsFound(reader, "Kenji")).toMatch(/restored from a backup/);
      } finally {
        await late.end();
      }
      expect(await completeRestore({ only: "due" })).toEqual([expect.objectContaining({ orgId: ORG, applied: true })]);
      expect(await reapplyDue(ORG)).toBe(false);
    });

    describe("the steady-state read sends Postgres no more statements than before the gate", () => {
      /** How many statements `run` sends Postgres, counted at the driver every client shares. */
      async function statementsSent(run: () => Promise<unknown>): Promise<number> {
        const sent = vi.spyOn(pg.Client.prototype, "query");
        try {
          await run();
          return sent.mock.calls.length;
        } finally {
          sent.mockRestore();
        }
      }

      // Counted before this change, with this file's fixture: the
      // grants (or token) lookup, then the audit row's statements.
      it.each([
        ["a person", () => reader, 2],
        ["an agent", () => agent, 2],
      ] as const)("check() for %s's read", async (_, ctx, before) => {
        await check(ctx(), { action: "memory.read", scope: ROOT });
        expect(await statementsSent(() => check(ctx(), { action: "memory.read", scope: ROOT }))).toBe(before);
      });
    });
  },
);
