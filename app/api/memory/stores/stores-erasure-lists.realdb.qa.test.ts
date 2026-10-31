// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Explore's Working notes and Briefs lists, after a person is erased: a row written at
// or before the erasure that names the person is neither listed nor counted, in the
// overview or a search, the same as Rules and Text passages. A row written after the
// erasure is a deliberate new mention and is listed. Scope containment is checked
// alongside: a sub-scope reader never sees a sibling's row, erased or not.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { StorePage } from "@/types/memory";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "storeerase";
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.sales`;
const OPS = `${ROOT}.ops`;
const READER = "u-se-sales";
const NAME = "Dana Whitfield";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

describe.skipIf(!QA_URL)(
  "Explore's notes and briefs lists never show an erased person's earlier rows",
  { timeout: 30_000 },
  () => {
    let db: PrismaClient;
    let GET: (typeof import("./route"))["GET"];

    async function page(query: string): Promise<StorePage> {
      const res = await GET(new Request(`http://t/api/memory/stores?${query}`));
      expect(res.status).toBe(200);
      return (await res.json()) as StorePage;
    }

    async function clear() {
      await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
      await db.brief.deleteMany({ where: { orgId: ORG } });
      await db.workingNote.deleteMany({ where: { orgId: ORG } });
      for (const t of ["auditLog", "grant", "orgMembership", "scope"] as const) {
        await (db[t] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { orgId: ORG } });
      }
      await db.user.deleteMany({ where: { orgId: ORG } });
      await deleteOrgsWithRetry(db, { where: { id: ORG } });
    }

    const note = (scopePath: string, task: string, body: string, createdAt: Date) =>
      db.workingNote.create({
        data: {
          orgId: ORG,
          scopePath,
          agentId: "agent-se",
          task,
          kind: "claim",
          body,
          expiresAt: new Date(Date.now() + 3_600_000),
          createdAt,
        },
      });
    const brief = (scopePath: string, title: string, createdAt: Date) =>
      db.brief.create({
        data: { orgId: ORG, type: "handoff", scopePath, title, summary: "s", sections: [], createdAt },
      });

    beforeAll(async () => {
      process.env.DATABASE_URL = QA_URL;
      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
      const { requireAccessContext } = await import("@/lib/access-context");
      vi.mocked(requireAccessContext).mockResolvedValue({
        org: { id: ORG },
        user: { id: READER },
        ctx: { orgId: ORG, actor: { type: "human", id: READER, role: "member" } },
      } as never);
      ({ GET } = await import("./route"));
    });

    beforeEach(async () => {
      await clear();
      await db.org.create({ data: { id: ORG, name: ORG } });
      const ids: Record<string, string> = {};
      for (const path of [ROOT, SALES, OPS])
        ids[path] = (await db.scope.create({ data: { orgId: ORG, path, name: path } })).id;
      await db.user.create({
        data: { id: READER, orgId: ORG, email: `${READER}@se.test`, role: "member", clerkId: `c-${READER}` },
      });
      await db.grant.create({
        data: { orgId: ORG, scopeId: ids[SALES], granteeType: "user", granteeId: READER, permission: "read" },
      });

      const before = new Date(Date.now() - 60_000);
      await note(SALES, "Renewal call", `Ask ${NAME} for the floor`, before);
      await note(SALES, "Pricing", "Keep the floor at 160k", before);
      await note(OPS, `Ops note naming ${NAME}`, "sibling", before);
      await brief(SALES, `Handoff: ${NAME} renewal`, before);
      await brief(SALES, "Handoff: pricing", before);
      await brief(OPS, `Ops brief naming ${NAME}`, before);

      const { recordSuppressions } = await import("@/services/memory/erasure-suppression");
      await recordSuppressions(db as never, ORG, "erasure-se", { emails: [], names: [NAME], contactIds: [] });
    });

    afterAll(async () => {
      await clear();
      await db.$disconnect();
    });

    it("a working note written before the erasure that names the person is not listed, counted or found", async () => {
      const listed = await page(`scope=${SALES}&list=notes`);
      expect(listed.items.map((n) => ("task" in n ? n.task : ""))).toEqual(["Pricing"]);
      expect(listed.total).toBe(1);
      expect(await page(`scope=${SALES}&list=notes&q=whitfield`)).toMatchObject({ items: [], total: 0 });
    });

    it("a brief written before the erasure whose title names the person is not listed, counted or found", async () => {
      const listed = await page(`scope=${SALES}&list=briefs`);
      expect(listed.items.map((b) => ("title" in b ? b.title : ""))).toEqual(["Handoff: pricing"]);
      expect(listed.total).toBe(1);
      expect(await page(`scope=${SALES}&list=briefs&q=whitfield`)).toMatchObject({ items: [], total: 0 });
    });

    it("the overview neither lists nor counts them", async () => {
      const res = await GET(new Request(`http://t/api/memory/stores?scope=${SALES}`));
      const overview = (await res.json()) as {
        counts: { notes: number; briefs: number };
        notes: { task: string; body: string }[];
        briefs: { title: string }[];
      };
      expect(JSON.stringify([overview.notes, overview.briefs])).not.toContain("Whitfield");
      expect(overview.counts.notes).toBe(1);
      expect(overview.counts.briefs).toBe(1);
    });

    it("a note and a brief written after the erasure are listed: a deliberate new mention", async () => {
      const after = new Date(Date.now() + 60_000);
      await note(SALES, "Advisor", `${NAME} rejoined as an advisor`, after);
      await brief(SALES, `Handoff: ${NAME} as advisor`, after);
      expect((await page(`scope=${SALES}&list=notes&q=whitfield`)).total).toBe(1);
      expect((await page(`scope=${SALES}&list=briefs&q=whitfield`)).total).toBe(1);
    });

    it("a sales reader never sees the ops sibling's rows, and is refused the ops scope", async () => {
      for (const list of ["notes", "briefs"]) {
        const listed = await page(`scope=${SALES}&list=${list}&q=ops`);
        expect(listed).toMatchObject({ items: [], total: 0 });
      }
      const res = await GET(new Request(`http://t/api/memory/stores?scope=${OPS}&list=notes`));
      expect(res.status).toBe(403);
    });
  },
);
