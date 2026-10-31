// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Probes of the dependency graph's read side, beside dependencies.realdb.test.ts: an
// edge's `from` end held to the same placement as its `to` end (a retired brief or a record stored only in a sibling scope is
// never named as a dependent), each placement and org filter held on its own, `truncated`
// never moved by a sibling scope's or another tenant's rows (rows that read as erased:
// dependencies.erased-bound.qa.realdb.test.ts), one audit row per route call, and the
// read cost on a scope holding thousands of relations.
//
// Set QA_DATABASE_URL to an ISOLATED test database, never the inherited DATABASE_URL.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { ChangeOp, FactEdgeKind } from "@/lib/generated/prisma/enums";
import type { AccessContext } from "@/services/access";
import { seedMember } from "@/services/access/member.testsupport";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

const QA_URL = process.env.QA_DATABASE_URL;
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ORG = `depsqa${RUN}`;
const OTHER_ORG = `depsqaother${RUN}`;
const ROOT = `org_${ORG}`;
const ENG = `${ROOT}.eng`;
const ENGX = `${ROOT}.engx`;
const OTHER_ROOT = `org_${OTHER_ORG}`;
const ADMIN = `u-depsqa-admin-${RUN}`;
const READER = `u-depsqa-reader-${RUN}`;

/** MAX_ROWS_PER_QUERY (dependencies.ts), needed before the module is imported in beforeAll. */
const deps_MAX = 500;

const T0 = new Date(Date.UTC(2026, 9, 16, 10, 0, 0));
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const human = (id: string, orgId = ORG): AccessContext => ({
  orgId,
  actor: { type: "human", id, role: "member" },
  origin: "app",
});

describe.skipIf(!QA_URL)("dependency graph read side, real database", () => {
  let db: PrismaClient;
  let deps: typeof import("./dependencies");
  let seq = 0;

  const brief = (id: string, scopePath: string, createdAt: Date, orgId = ORG) =>
    db.brief.create({
      data: { id, orgId, type: "handoff", scopePath, title: `brief ${id}`, summary: "s", sections: [], createdAt },
    });
  const edge = (fromId: string, toId: string, kind: FactEdgeKind, scopePath: string, createdAt: Date, orgId = ORG) =>
    db.factEdge.create({
      data: { orgId, fromId, toId, kind, scopePath, actorType: "agent", actorId: "agent-1", createdAt },
    });
  const event = (
    recordId: string,
    op: ChangeOp,
    scopePath: string,
    createdAt: Date,
    recordType = "fact",
    orgId = ORG,
  ) =>
    db.changeEvent.create({
      data: {
        orgId,
        seq: BigInt(++seq),
        scopePath,
        recordType,
        recordId,
        op,
        actorId: "agent-1",
        summary: "s",
        createdAt,
      },
    });
  const version = (id: string, scopePath: string, createdAt: Date, orgId = ORG) =>
    db.memoryChunk.create({ data: { id, orgId, content: `content ${id}`, scopePath, createdAt, factVersion: true } });

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    deps = await import("./dependencies");
    for (const id of [ORG, OTHER_ORG]) await db.org.create({ data: { id, name: id } });
    const scopes = new Map<string, string>();
    for (const [orgId, path] of [
      [ORG, ROOT],
      [ORG, ENG],
      [ORG, ENGX],
      [OTHER_ORG, OTHER_ROOT],
    ] as const) {
      scopes.set(path, (await db.scope.create({ data: { orgId, path, name: path } })).id);
    }
    for (const userId of [ADMIN, READER]) await seedMember(db, { orgId: ORG, userId });
    await db.grant.createMany({
      data: [
        { orgId: ORG, scopeId: scopes.get(ROOT)!, granteeType: "user", granteeId: ADMIN, permission: "read" },
        { orgId: ORG, scopeId: scopes.get(ENG)!, granteeType: "user", granteeId: READER, permission: "read" },
      ],
    });
  });

  beforeEach(async () => {
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.brief.deleteMany({ where: { orgId } });
      await db.factEdge.deleteMany({ where: { orgId } });
      await db.changeEvent.deleteMany({ where: { orgId } });
      await db.memoryChunk.deleteMany({ where: { orgId } });
      await db.erasureSuppression.deleteMany({ where: { orgId } });
      await db.auditLog.deleteMany({ where: { orgId } });
    }
  });

  afterAll(async () => {
    if (!QA_URL) return;
    for (const id of [ORG, OTHER_ORG]) {
      await db.auditLog.deleteMany({ where: { orgId: id } });
      await deleteOrgsWithRetry(db, { where: { id } });
    }
    await db.user.deleteMany({ where: { id: { in: [ADMIN, READER] } } });
    await db.$disconnect();
  });

  describe("an edge's from end is placed like its to end", () => {
    it("never names a retired brief as a dependent through an edge", async () => {
      await version("f-src", ENG, at(1));
      await brief("b-retired", ENG, at(2));
      await db.briefRetirement.create({ data: { briefId: "b-retired", sourceId: "src-1", reason: "source_moved" } });
      await edge("b-retired", "f-src", "derivedFrom", ENG, at(3));
      await event("f-src", "update", ENG, at(10));

      expect(JSON.stringify(await deps.edgesOf(human(READER), "f-src", ENG))).not.toContain("b-retired");
      expect((await deps.whatToChange(human(READER), "f-src", ENG)).items).toEqual([]);
      expect(JSON.stringify(await deps.staleReport(human(READER), ENG))).not.toContain("b-retired");
    });

    it("never names a record stored only in a sibling scope as a dependent, whatever scope its edge row carries", async () => {
      await version("f-src", ENG, at(1));
      await version("r-sibling", ENGX, at(2));
      await edge("r-sibling", "f-src", "dependsOn", ENG, at(3));
      await event("f-src", "update", ENG, at(10));

      expect(JSON.stringify(await deps.edgesOf(human(READER), "f-src", ENG))).not.toContain("r-sibling");
      expect((await deps.whatToChange(human(READER), "f-src", ENG)).items).toEqual([]);
      expect(JSON.stringify(await deps.staleReport(human(READER), ENG))).not.toContain("r-sibling");
    });
  });

  describe("placement is per tenant", () => {
    // Kills the mutant that drops `m."orgId"` from placedWithin: at the org root an untagged
    // row counts as placed, so another tenant's untagged row with the same id would place it.
    it("does not place a to end by another tenant's untagged row at the root", async () => {
      await version("r-root", ROOT, at(1));
      await db.memoryChunk.create({
        data: { id: "x-other-untagged", orgId: OTHER_ORG, content: "theirs", createdAt: at(1) },
      });
      await edge("r-root", "x-other-untagged", "dependsOn", ROOT, at(2));
      expect((await deps.edgesOf(human(ADMIN), "r-root", ROOT)).outgoing).toEqual([]);
    });

    // Kills the mutant that drops `ev."orgId"` from placedWithin.
    it("does not place a to end by another tenant's announcement under this org's path", async () => {
      await version("r-eng", ENG, at(1));
      await event("x-other-announced", "create", ENG, at(1), "fact", OTHER_ORG);
      await edge("r-eng", "x-other-announced", "dependsOn", ENG, at(2));
      expect((await deps.edgesOf(human(READER), "r-eng", ENG)).outgoing).toEqual([]);
    });

    // Kills the mutant that drops `e."orgId"` from edgesInScope. Both ends are this org's own
    // records, so placement alone cannot leave the row out: only the edge's own org can.
    it("does not read another tenant's edge row between two of this org's records", async () => {
      await version("f-src", ENG, at(1));
      await version("r-ours", ENG, at(1));
      await edge("r-ours", "f-src", "dependsOn", ENG, at(2), OTHER_ORG);
      expect((await deps.edgesOf(human(READER), "f-src", ENG)).incoming).toEqual([]);
      expect((await deps.whatToChange(human(READER), "f-src", ENG)).items).toEqual([]);
    });

    // Kills the mutant that drops `e."orgId"` from supersedesInto, the same way.
    it("does not count another tenant's supersedes row between two of this org's records", async () => {
      await version("f-old", ENG, at(1));
      await version("f-new", ENG, at(1));
      await version("r-dep", ENG, at(1));
      await edge("r-dep", "f-old", "dependsOn", ENG, at(2));
      await edge("f-new", "f-old", "supersedes", ENG, at(3), OTHER_ORG);
      expect((await deps.staleReport(human(READER), ENG)).stale).toEqual([]);
    });
  });

  describe("a brief is placed only in its own scope", () => {
    // Kills the mutant that drops the brief's scope from placedWithin: a brief stored only in
    // a sibling scope must not be named, as an id the reader cannot see.
    it("never names a brief stored only in a sibling scope, whatever scope its edge row carries", async () => {
      await version("f-src", ENG, at(1));
      await brief("b-sibling", ENGX, at(2));
      await edge("b-sibling", "f-src", "derivedFrom", ENG, at(3));
      await event("f-src", "update", ENG, at(10));
      expect(JSON.stringify(await deps.edgesOf(human(READER), "f-src", ENG))).not.toContain("b-sibling");
      expect((await deps.whatToChange(human(READER), "f-src", ENG)).items).toEqual([]);
      expect(JSON.stringify(await deps.staleReport(human(READER), ENG))).not.toContain("b-sibling");
    });
  });

  describe("truncated moves only with rows the reader may see", () => {
    const many = deps_MAX + 5;

    it("is not set by a sibling scope's or another tenant's rows", async () => {
      await version("f-hub", ENG, at(1));
      await version("f-hub-x", ENGX, at(1));
      await event("f-hub", "update", ENG, at(100));
      await db.factEdge.createMany({
        data: Array.from({ length: many }, (_, i) => [
          {
            orgId: ORG,
            fromId: `x-${i}`,
            toId: "f-hub-x",
            kind: "dependsOn" as const,
            scopePath: ENGX,
            actorType: "agent" as const,
            actorId: "a",
            createdAt: at(2),
          },
          {
            orgId: OTHER_ORG,
            fromId: `o-${i}`,
            toId: "f-hub",
            kind: "dependsOn" as const,
            scopePath: ENG,
            actorType: "agent" as const,
            actorId: "a",
            createdAt: at(2),
          },
        ]).flat(),
      });
      // Placed in their own scopes, so the rows are real there.
      await db.memoryChunk.createMany({
        data: Array.from({ length: many }, (_, i) => ({
          id: `x-${i}`,
          orgId: ORG,
          content: "x",
          scopePath: ENGX,
          createdAt: at(1),
          factVersion: true,
        })),
      });
      await brief("b-x", ENGX, at(2));
      await db.briefCitation.createMany({
        data: Array.from({ length: many }, (_, i) => ({
          briefId: "b-x",
          factId: `fx-${i}`,
          sectionIndex: 0,
          factText: "t",
          createdAt: at(2),
        })),
      });

      expect(await deps.staleReport(human(READER), ENG)).toEqual({ stale: [], recommend: [], truncated: false });
      expect(await deps.whatToChange(human(READER), "f-hub", ENG)).toEqual({ items: [], truncated: false });
      expect(await deps.edgesOf(human(READER), "f-hub", ENG)).toEqual({ outgoing: [], incoming: [], truncated: false });
      // The admin reading the sibling sees its rows were cut.
      expect((await deps.whatToChange(human(ADMIN), "f-hub-x", ENGX)).truncated).toBe(true);
    });
  });

  describe("audit", () => {
    it("writes exactly one memory.read row per route call", async () => {
      const { requireAccessContext } = await import("@/lib/access-context");
      vi.mocked(requireAccessContext).mockResolvedValue({
        org: await db.org.findUniqueOrThrow({ where: { id: ORG } }),
        user: await db.user.findUniqueOrThrow({ where: { id: READER } }),
        ctx: human(READER),
      } as never);
      const stale = (await import("@/app/api/memory/scopes/stale/route")).GET;
      const edges = (await import("@/app/api/memory/facts/[id]/edges/route")).GET;
      const wtc = (await import("@/app/api/memory/facts/[id]/what-to-change/route")).GET;
      const id = { params: Promise.resolve({ id: "f" }) };
      const counts: number[] = [];
      for (const call of [
        () => stale(new Request(`http://t/api/memory/scopes/stale?scope=${ENG}`)),
        () => edges(new Request(`http://t/api/memory/facts/f/edges?scope=${ENG}`), id),
        () => wtc(new Request(`http://t/api/memory/facts/f/what-to-change?scope=${ENG}`), id),
        () => stale(new Request(`http://t/api/memory/scopes/stale?scope=${ENGX}`)),
      ]) {
        await db.auditLog.deleteMany({ where: { orgId: ORG } });
        await call();
        counts.push(await db.auditLog.count({ where: { orgId: ORG, actorId: READER } }));
      }
      expect(counts).toEqual([1, 1, 1, 1]);
    });
  });

  describe("read cost on a large scope", () => {
    it("answers within the read budget with thousands of relations in scope", async () => {
      // 4,000 versions in ENG; 400 briefs each citing 10 of them; a 4-wide, 8-deep tree of
      // dependsOn edges under one hub, plus 3,000 flat dependsOn edges; change events on 500 sources.
      const N = 4000;
      await db.memoryChunk.createMany({
        data: Array.from({ length: N }, (_, i) => ({
          id: `v-${i}`,
          orgId: ORG,
          content: `v ${i}`,
          scopePath: ENG,
          createdAt: at(1),
          factVersion: true,
        })),
      });
      await db.brief.createMany({
        data: Array.from({ length: 400 }, (_, i) => ({
          id: `bb-${i}`,
          orgId: ORG,
          type: "handoff",
          scopePath: ENG,
          title: "t",
          summary: "s",
          sections: [],
          createdAt: at(5),
        })),
      });
      await db.briefCitation.createMany({
        data: Array.from({ length: 4000 }, (_, i) => ({
          briefId: `bb-${i % 400}`,
          factId: `v-${i}`,
          sectionIndex: 0,
          factText: "t",
          createdAt: at(5),
        })),
      });
      const tree: { fromId: string; toId: string }[] = [];
      let level = ["v-0"];
      let next = 1;
      for (let d = 0; d < 9 && next < N; d++) {
        const nextLevel: string[] = [];
        for (const parent of level)
          for (let k = 0; k < 4 && next < N; k++) {
            const child = `v-${next++}`;
            tree.push({ fromId: child, toId: parent });
            nextLevel.push(child);
          }
        level = nextLevel.slice(0, 64);
      }
      const flat = Array.from({ length: 3000 }, (_, i) => ({
        fromId: `v-${(i * 7) % N}`,
        toId: `v-${(i * 13 + 1) % N}`,
      }));
      await db.factEdge.createMany({
        data: [...tree, ...flat].map((e, i) => ({
          orgId: ORG,
          ...e,
          kind: "dependsOn" as const,
          scopePath: ENG,
          actorType: "agent" as const,
          actorId: "a",
          createdAt: new Date(at(6).getTime() + i),
        })),
        skipDuplicates: true,
      });
      for (let i = 0; i < 500; i++) await event(`v-${i}`, "update", ENG, at(50));

      const timed = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
        const t = performance.now();
        const r = await fn();
        return [r, performance.now() - t];
      };
      const [report, staleMs] = await timed(() => deps.staleReport(human(READER), ENG));
      const [walk, walkMs] = await timed(() => deps.whatToChange(human(READER), "v-0", ENG));
      const [rels, edgesMs] = await timed(() => deps.edgesOf(human(READER), "v-0", ENG));
      console.log(
        `[qa] large scope: staleReport ${staleMs.toFixed(0)} ms (stale=${report.stale.length}, truncated=${report.truncated}); ` +
          `whatToChange ${walkMs.toFixed(0)} ms (items=${walk.items.length}, maxDistance=${Math.max(...walk.items.map((i) => i.distance))}, truncated=${walk.truncated}); ` +
          `edgesOf ${edgesMs.toFixed(0)} ms (in=${rels.incoming.length})`,
      );
      expect(walk.items.length).toBeLessThanOrEqual(deps.MAX_INVALIDATED);
      expect(Math.max(...walk.items.map((i) => i.distance))).toBeLessThanOrEqual(deps.MAX_WALK_DEPTH);
      for (const ms of [staleMs, walkMs, edgesMs]) expect(ms).toBeLessThan(3000);
    }, 120_000);
  });
});
