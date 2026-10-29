// GET /api/memory/stores?list=: one page of one store, searched, filtered and
// ordered, against a real Postgres.
//
// A search, filter or count reaches only the rows inside the scope check() allowed:
// never a sibling scope that differs from it at an `_`, never another org, never an
// org-wide row (an untagged chunk, a contact) below the org root, never a retired
// brief, and never an erased person's restored copy. A hidden row never shortens a
// page. Only what a page shows is searchable: not a brief's body, not a source's
// stored token or settings.
//
// Runs the shipping route against a real database with the real check(), so each
// caller's grants (to them, to their role, to everyone, expired) decide the scope.
// Authentication is mocked. Set QA_DATABASE_URL to an isolated test database; the
// suite skips without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { StorePage } from "@/types/memory";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "storepg";
const OTHER_ORG = "storepgother";
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.dept_sales`;
const SALES_EU = `${SALES}.eu`;
// Differs from SALES only where SALES has `_`: matched by an unescaped LIKE.
const IMPOSTOR = `${ROOT}.deptXsales`;
const OPS = `${ROOT}.ops`;
const OTHER_ROOT = `org_${OTHER_ORG}`;

const ROOT_READER = "u-sp-root";
const SALES_READER = "u-sp-sales";
const ROLE_READER = "u-sp-role";
const EXPIRED = "u-sp-expired";
const OUTSIDER = "u-sp-outsider";

const SECRET = "Renewal floor is 160k";
const TOKEN = "sk-live-qa-secret";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

describe.skipIf(!QA_URL)("a store page reaches only rows inside the scope check() allowed", { timeout: 30_000 }, () => {
  let db: PrismaClient;
  let requireAccessContext: ReturnType<typeof vi.fn>;
  let GET: (typeof import("./route"))["GET"];
  let minutesAgo = 10_000;
  const at = () => new Date(Date.now() - (minutesAgo -= 1) * 60_000);

  function actAs(orgId: string, userId: string) {
    requireAccessContext.mockResolvedValue({
      org: { id: orgId },
      user: { id: userId },
      ctx: { orgId, actor: { type: "human", id: userId, role: "member" } },
    } as never);
  }

  async function request(query: string): Promise<Response> {
    return GET(new Request(`http://t/api/memory/stores?${query}`));
  }

  async function page(query: string): Promise<StorePage> {
    const res = await request(query);
    expect(res.status).toBe(200);
    return (await res.json()) as StorePage;
  }

  const titles = (p: StorePage) =>
    p.items.map((item) =>
      "title" in item
        ? item.title
        : "snippet" in item
          ? item.snippet
          : "subject" in item
            ? item.subject
            : "task" in item
              ? item.task
              : item.externalFileId,
    );

  async function chunk(orgId: string, scopePath: string | null, content: string, extra: Record<string, unknown> = {}) {
    return (await db.memoryChunk.create({ data: { orgId, scopePath, content, createdAt: at(), ...extra } })).id;
  }

  async function clear() {
    for (const org of [ORG, OTHER_ORG]) {
      await db.erasureSuppression.deleteMany({ where: { orgId: org } });
      await db.factEdge.deleteMany({ where: { orgId: org } });
      await db.memoryChunk.deleteMany({ where: { orgId: org } });
      await db.sourceFile.deleteMany({ where: { source: { orgId: org } } });
      await db.source.deleteMany({ where: { orgId: org } });
      await db.brief.deleteMany({ where: { orgId: org } });
      await db.contact.deleteMany({ where: { orgId: org } });
      await db.convention.deleteMany({ where: { orgId: org } });
      await db.workingNote.deleteMany({ where: { orgId: org } });
      for (const t of ["auditLog", "grant", "orgMembership", "scope"] as const) {
        await (db[t] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { orgId: org } });
      }
      await db.user.deleteMany({ where: { orgId: org } });
      await db.org.deleteMany({ where: { id: org } });
    }
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    requireAccessContext = vi.mocked((await import("@/lib/access-context")).requireAccessContext);
    ({ GET } = await import("./route"));
  });

  beforeEach(async () => {
    await clear();
    minutesAgo = 10_000;
    for (const org of [ORG, OTHER_ORG]) await db.org.create({ data: { id: org, name: org } });
    const scopes: Record<string, string> = {};
    for (const [orgId, path] of [
      [ORG, ROOT],
      [ORG, SALES],
      [ORG, SALES_EU],
      [ORG, IMPOSTOR],
      [ORG, OPS],
      [OTHER_ORG, OTHER_ROOT],
      [OTHER_ORG, `${OTHER_ROOT}.dept_sales`],
    ]) {
      scopes[path] = (await db.scope.create({ data: { orgId, path, name: path } })).id;
    }
    const people: [string, string, "admin" | "member"][] = [
      [ROOT_READER, ORG, "member"],
      [SALES_READER, ORG, "member"],
      [ROLE_READER, ORG, "admin"],
      [EXPIRED, ORG, "member"],
      [OUTSIDER, OTHER_ORG, "member"],
    ];
    for (const [id, orgId, role] of people) {
      await db.user.create({ data: { id, orgId, email: `${id}@sp.test`, role, clerkId: `c-${id}` } });
    }
    const grant = (
      path: string,
      granteeType: "user" | "role" | "everyone",
      granteeId: string,
      expiresAt: Date | null = null,
    ) =>
      db.grant.create({
        data: {
          orgId: path.startsWith(OTHER_ROOT) ? OTHER_ORG : ORG,
          scopeId: scopes[path],
          granteeType,
          granteeId,
          permission: "read",
          expiresAt,
        },
      });
    await grant(ROOT, "user", ROOT_READER);
    await grant(SALES, "user", SALES_READER);
    await grant(SALES, "role", "admin");
    await grant(SALES, "user", EXPIRED, new Date(Date.now() - 60_000));
    await grant(OPS, "everyone", "everyone");
    await grant(OTHER_ROOT, "user", OUTSIDER);

    // One brief, rule, working note, source, file and chunk per scope in each org, every title holding "Acme".
    for (const [orgId, paths] of [
      [ORG, [SALES, SALES_EU, IMPOSTOR, OPS]],
      [OTHER_ORG, [`${OTHER_ROOT}.dept_sales`]],
    ] as const) {
      for (const path of paths) {
        await db.brief.create({
          data: {
            orgId,
            type: "handoff",
            scopePath: path,
            title: `Acme brief ${path}`,
            summary: SECRET,
            sections: [],
            createdAt: at(),
          },
        });
        await db.convention.create({
          data: {
            orgId,
            scopePath: path,
            kind: "decision",
            subject: `Acme rule ${path}`,
            text: "Ship weekly",
            actorId: "u",
            createdAt: at(),
          },
        });
        await db.workingNote.create({
          data: {
            orgId,
            scopePath: path,
            agentId: "agent-sp",
            task: `Acme note ${path}`,
            kind: "claim",
            body: "On it",
            expiresAt: new Date(Date.now() + 3_600_000),
            createdAt: at(),
          },
        });
        const source = await db.source.create({
          data: {
            orgId,
            type: "website",
            externalId: `${orgId}-${path}`,
            name: `Acme source ${path}`,
            scopePath: path,
            encryptedTokens: TOKEN,
            meta: { note: SECRET },
          },
        });
        await db.sourceFile.create({
          data: {
            sourceId: source.id,
            externalFileId: `acme-${path}.pdf`,
            checksum: "c",
            chunkIds: ["x", "y"],
            syncedAt: at(),
          },
        });
        await chunk(orgId, path, `Acme chunk ${path}`);
      }
      await chunk(orgId, null, `Acme untagged ${orgId}`);
      await db.contact.create({ data: { orgId, name: `Acme contact ${orgId}`, updatedAt: at() } });
    }
  });

  afterAll(async () => {
    await clear();
    await db.$disconnect();
  });

  it("a sales reader's search lists and counts only sales records, never the `_` sibling or org-wide contacts", async () => {
    actAs(ORG, SALES_READER);
    const records = await page(`scope=${SALES}&list=records&q=acme`);
    expect(titles(records).sort()).toEqual([`Acme source ${SALES}`, `Acme source ${SALES_EU}`].sort());
    expect(records.total).toBe(2);
    for (const [list, noun] of [
      ["briefs", "brief"],
      ["rules", "rule"],
      ["notes", "note"],
    ] as const) {
      const found = await page(`scope=${SALES}&list=${list}&q=acme`);
      expect(titles(found).sort()).toEqual([`Acme ${noun} ${SALES}`, `Acme ${noun} ${SALES_EU}`].sort());
      expect(found.total).toBe(2);
    }
    expect(await page(`scope=${SALES}&list=records&kind=contact`)).toMatchObject({ items: [], total: 0 });

    actAs(ORG, ROOT_READER);
    const root = await page("list=records&q=acme&kind=contact");
    expect(titles(root)).toEqual([`Acme contact ${ORG}`]);
    expect((await page("list=records&q=acme")).total).toBe(5);
    expect((await page("list=rules&q=acme")).total).toBe(4);
  });

  it("a sales reader's chunk and file searches never include untagged, sibling or other-org rows", async () => {
    actAs(ORG, SALES_READER);
    const chunks = await page(`scope=${SALES}&list=chunks&q=acme`);
    expect(titles(chunks).sort()).toEqual([`Acme chunk ${SALES}`, `Acme chunk ${SALES_EU}`].sort());
    expect(chunks.total).toBe(2);
    const files = await page(`scope=${SALES}&list=files&q=acme&type=website`);
    expect(titles(files).sort()).toEqual([`acme-${SALES}.pdf`, `acme-${SALES_EU}.pdf`].sort());
    expect(files.total).toBe(2);
    expect(await page(`scope=${SALES}&list=files&type=gdrive`)).toMatchObject({ items: [], total: 0 });

    actAs(ORG, ROOT_READER);
    expect((await page("list=chunks&q=untagged")).total).toBe(1);
  });

  it("each grant kind decides the scope before any search: role and everyone allow, expired and outsiders are refused", async () => {
    actAs(ORG, ROLE_READER);
    expect((await page(`scope=${SALES}&list=chunks&q=acme`)).total).toBe(2);
    actAs(ORG, SALES_READER);
    expect((await page(`scope=${OPS}&list=chunks&q=acme`)).total).toBe(1);
    for (const scope of [ROOT, IMPOSTOR]) {
      const res = await request(`scope=${scope}&list=records&q=acme`);
      expect(res.status).toBe(403);
      expect(JSON.stringify(await res.json())).not.toContain("Acme");
    }
    actAs(ORG, EXPIRED);
    expect((await request(`scope=${SALES}&list=records&q=acme`)).status).toBe(403);
    actAs(OTHER_ORG, OUTSIDER);
    expect((await request(`scope=${SALES}&list=records&q=acme`)).status).toBe(403);
  });

  it("another org's reader finds only its own rows under the same names", async () => {
    actAs(OTHER_ORG, OUTSIDER);
    const records = await page("list=records&q=acme");
    expect(titles(records).every((t) => t.includes(OTHER_ORG))).toBe(true);
    expect(records.total).toBe(2);
    const rules = await page("list=rules&q=acme");
    expect(titles(rules)).toEqual([`Acme rule ${OTHER_ROOT}.dept_sales`]);
  });

  it("newer hidden matches never push a visible match off a page", async () => {
    await chunk(ORG, SALES, "Zephyr old sales note");
    for (let i = 0; i < 55; i += 1) await chunk(ORG, IMPOSTOR, `Zephyr hidden ${i}`);

    actAs(ORG, SALES_READER);
    const found = await page(`scope=${SALES}&list=chunks&q=zephyr`);
    expect(titles(found)).toEqual(["Zephyr old sales note"]);
    expect(found.total).toBe(1);
  });

  it("never searches a brief's body or a source's stored token and settings", async () => {
    actAs(ORG, ROOT_READER);
    for (const list of ["records", "briefs", "files", "chunks"]) {
      for (const secret of [SECRET, "160k", TOKEN, "qa-secret"]) {
        expect(await page(`list=${list}&q=${encodeURIComponent(secret)}`)).toMatchObject({ items: [], total: 0 });
      }
    }
  });

  it("a retired brief is neither listed nor counted", async () => {
    const retired = await db.brief.findFirstOrThrow({ where: { orgId: ORG, scopePath: SALES } });
    await db.briefRetirement.create({ data: { briefId: retired.id, sourceId: "gone", reason: "source_disconnected" } });

    actAs(ORG, SALES_READER);
    const briefs = await page(`scope=${SALES}&list=briefs&type=handoff&q=acme`);
    expect(titles(briefs)).toEqual([`Acme brief ${SALES_EU}`]);
    expect(briefs.total).toBe(1);
  });

  it("a chunk search never lists or counts an erased person's restored copy", async () => {
    const { recordSuppressions } = await import("@/services/memory/erasure-suppression");
    await chunk(ORG, SALES, "Dana Whitfield asked for the renewal floor");
    await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
    await recordSuppressions(db as never, ORG, "erasure-1", { emails: [], names: ["Dana Whitfield"], contactIds: [] });
    // Written after the erasure: a deliberate new mention, listed as usual.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const later = await db.memoryChunk.create({
      data: {
        orgId: ORG,
        scopePath: SALES,
        content: "Dana Whitfield rejoined as an advisor",
        createdAt: new Date(Date.now() + 60_000),
      },
    });

    actAs(ORG, SALES_READER);
    const found = await page(`scope=${SALES}&list=chunks&q=whitfield`);
    expect(found.items.map((c) => c.id)).toEqual([later.id]);
    expect(found.total).toBe(1);
    expect(found.capped).toBe(false);
  });

  it("a filtered chunk list never counts an erased person's restored copy, even with no search", async () => {
    const { recordSuppressions } = await import("@/services/memory/erasure-suppression");
    await chunk(ORG, SALES, "Dana Whitfield asked for the renewal floor");
    await recordSuppressions(db as never, ORG, "erasure-2", { emails: [], names: ["Dana Whitfield"], contactIds: [] });

    actAs(ORG, SALES_READER);
    for (const version of ["current", "superseded"]) {
      const listed = await page(`scope=${SALES}&list=chunks&version=${version}`);
      expect(listed.total).toBe(listed.items.length);
      expect(listed.items.some((c) => "snippet" in c && c.snippet.includes("Whitfield"))).toBe(false);
    }
  });

  it("a rule list never lists or counts an erased person's restored rule, in the overview or a search", async () => {
    const { recordSuppressions } = await import("@/services/memory/erasure-suppression");
    await db.convention.create({
      data: {
        orgId: ORG,
        scopePath: SALES,
        kind: "convention",
        subject: "Renewals",
        text: "Ask Dana Whitfield first",
        actorId: "u",
        createdAt: at(),
      },
    });
    await recordSuppressions(db as never, ORG, "erasure-r", { emails: [], names: ["Dana Whitfield"], contactIds: [] });

    actAs(ORG, SALES_READER);
    const overview = (await (await request(`scope=${SALES}`)).json()) as {
      counts: { rules: number };
      rules: { subject: string }[];
    };
    expect(overview.rules.map((r) => r.subject).sort()).toEqual([`Acme rule ${SALES}`, `Acme rule ${SALES_EU}`].sort());
    expect(overview.counts.rules).toBe(2);
    expect(await page(`scope=${SALES}&list=rules&q=whitfield`)).toMatchObject({ items: [], total: 0, capped: false });
  });

  it("the overview lists rules, notes and briefs in the order their pages continue, ties included", async () => {
    const createdAt = new Date("2026-10-01T00:00:00Z");
    await db.convention.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        orgId: ORG,
        scopePath: SALES,
        kind: "convention" as const,
        subject: `Tie ${i}`,
        text: "t",
        actorId: "u",
        createdAt,
      })),
    });
    await db.workingNote.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        orgId: ORG,
        scopePath: SALES,
        agentId: "a",
        task: `Tie ${i}`,
        kind: "status" as const,
        body: "b",
        expiresAt: createdAt,
        createdAt,
      })),
    });
    await db.brief.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        orgId: ORG,
        scopePath: SALES,
        type: "handoff" as const,
        title: `Tie ${i}`,
        summary: "s",
        sections: [],
        createdAt,
      })),
    });
    actAs(ORG, SALES_READER);
    const overview = (await (await request(`scope=${SALES}`)).json()) as Record<
      "rules" | "notes" | "briefs",
      { id: string }[]
    >;
    for (const list of ["rules", "notes", "briefs"] as const) {
      const first = await page(`scope=${SALES}&list=${list}`);
      expect(overview[list].map((r) => r.id)).toEqual(first.items.map((r) => r.id));
      expect(first.items).toHaveLength(50);
    }
  });

  it("the overview lists a store's first rows in the order its pages continue", async () => {
    const createdAt = new Date("2026-10-01T00:00:00Z");
    await db.memoryChunk.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        orgId: ORG,
        scopePath: SALES,
        content: `Same instant ${i}`,
        createdAt,
      })),
    });
    actAs(ORG, SALES_READER);
    const overview = (await (await request(`scope=${SALES}`)).json()) as { chunks: { id: string }[] };
    const first = await page(`scope=${SALES}&list=chunks`);
    expect(overview.chunks.map((c) => c.id)).toEqual(first.items.map((c) => c.id));
  });

  it("treats % and _ as literal characters and folds case", async () => {
    await chunk(ORG, SALES, "Rate went 10% up");
    await chunk(ORG, SALES, "İstanbul office opened");

    actAs(ORG, SALES_READER);
    expect(titles(await page(`scope=${SALES}&list=chunks&q=${encodeURIComponent("10%")}`))).toEqual([
      "Rate went 10% up",
    ]);
    expect(await page(`scope=${SALES}&list=chunks&q=${encodeURIComponent("1_%")}`)).toMatchObject({
      items: [],
      total: 0,
    });
    expect((await page(`scope=${SALES}&list=files&q=dept_sales`)).total).toBe(2);
    expect((await page(`scope=${SALES}&list=files&q=deptXsales`)).total).toBe(0);
    expect((await page(`scope=${SALES}&list=files&q=${encodeURIComponent("dept\\_sales")}`)).total).toBe(0);
    expect(titles(await page(`scope=${SALES}&list=chunks&q=${encodeURIComponent("İstanbul")}`))).toEqual([
      "İstanbul office opened",
    ]);
    expect(titles(await page(`scope=${SALES}&list=chunks&q=ACME%20CHUNK`)).length).toBe(2);
  });

  it("pages exactly: a full page, then the remainder, then nothing", async () => {
    for (let i = 0; i < 49; i += 1) await chunk(ORG, SALES, `Paged note ${i}`);
    actAs(ORG, SALES_READER);
    // 49 notes plus the seeded sales chunk and its .eu child's: 51 in all.
    const first = await page(`scope=${SALES}&list=chunks`);
    expect(first.items).toHaveLength(50);
    expect(first.total).toBe(51);
    const second = await page(`scope=${SALES}&list=chunks&page=2`);
    expect(second.items).toHaveLength(1);
    expect(new Set([...first.items, ...second.items].map((c) => c.id)).size).toBe(51);
    expect(await page(`scope=${SALES}&list=chunks&page=3`)).toMatchObject({ items: [], total: 51 });

    const exact = await page(`scope=${SALES}&list=chunks&q=paged%20note`);
    expect(exact.items).toHaveLength(49);
    expect(exact.total).toBe(49);
    const oldest = await page(`scope=${SALES}&list=chunks&q=paged%20note&order=asc`);
    expect(titles(oldest)[0]).toBe("Paged note 0");
  });

  it("pages chunks written in the same instant without repeating or skipping one", async () => {
    const createdAt = new Date("2026-10-01T00:00:00Z");
    await db.memoryChunk.createMany({
      data: Array.from({ length: 55 }, (_, i) => ({
        orgId: ORG,
        scopePath: SALES,
        content: `Tied note ${i}`,
        createdAt,
      })),
    });
    actAs(ORG, SALES_READER);
    for (const order of ["desc", "asc"]) {
      const first = await page(`scope=${SALES}&list=chunks&q=tied%20note&order=${order}`);
      const second = await page(`scope=${SALES}&list=chunks&q=tied%20note&order=${order}&page=2`);
      expect(new Set([...first.items, ...second.items].map((c) => c.id)).size).toBe(55);
    }
  });

  it("orders records by title and files by chunk count on request", async () => {
    actAs(ORG, SALES_READER);
    const byTitle = await page(`scope=${SALES}&list=records&sort=title&order=asc`);
    expect(titles(byTitle)).toEqual(
      [...titles(byTitle)].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
    );
    const file = await db.sourceFile.findFirstOrThrow({ where: { externalFileId: `acme-${SALES_EU}.pdf` } });
    await db.sourceFile.update({ where: { id: file.id }, data: { chunkIds: ["a", "b", "c", "d", "e"] } });
    expect(titles(await page(`scope=${SALES}&list=files&sort=chunks`))[0]).toBe(`acme-${SALES_EU}.pdf`);
  });

  it("marks each stored rule version in force, replaced or retired, and filters rules by kind", async () => {
    const old = await db.convention.findFirstOrThrow({ where: { orgId: ORG, scopePath: SALES } });
    await db.convention.create({
      data: {
        orgId: ORG,
        scopePath: SALES,
        kind: "decision",
        subject: "Acme rule v2",
        text: "Ship daily",
        actorId: "u",
        supersedesId: old.id,
        createdAt: at(),
      },
    });
    await db.convention.updateMany({
      where: { orgId: ORG, scopePath: SALES_EU },
      data: { retiredAt: new Date(), retiredBy: "u" },
    });
    await db.convention.create({
      data: {
        orgId: ORG,
        scopePath: SALES,
        kind: "convention",
        subject: "Acme house style",
        text: "Plain words",
        actorId: "u",
        createdAt: at(),
      },
    });

    actAs(ORG, SALES_READER);
    const rules = await page(`scope=${SALES}&list=rules&q=acme`);
    const status = Object.fromEntries(
      rules.items.map((r) => ["subject" in r ? r.subject : "", "status" in r ? r.status : ""]),
    );
    expect(status).toEqual({
      [`Acme rule ${SALES}`]: "replaced",
      "Acme rule v2": "in_force",
      [`Acme rule ${SALES_EU}`]: "retired",
      "Acme house style": "in_force",
    });
    expect(titles(await page(`scope=${SALES}&list=rules&kind=convention`))).toEqual(["Acme house style"]);
  });

  it("refuses a value the list does not offer with a message naming the accepted ones", async () => {
    actAs(ORG, SALES_READER);
    for (const [query, message] of [
      ["list=bogus", "list must be one of records, briefs, rules, notes, chunks, files"],
      ["list=chunks&sort=title", "sort must be one of created for chunks"],
      ["list=records&kind=person", "kind must be one of source, contact for records"],
      ["list=rules&kind=claim", "kind must be one of convention, decision for rules"],
      ["list=files&order=sideways", "order must be asc or desc"],
      ["list=files&page=0", "page must be a whole number from 1 to 100000"],
      ["list=files&page=1.5", "page must be a whole number from 1 to 100000"],
      ["list=files&page=1e9", "page must be a whole number from 1 to 100000"],
      [`list=files&q=${"a".repeat(101)}`, "q must be at most 100 characters"],
      ["list=files&q=a%00b", "q must not contain a NUL character"],
    ] as const) {
      const res = await request(`scope=${SALES}&${query}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(message);
    }
  });
});
