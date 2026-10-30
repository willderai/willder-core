// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The dependency graph's read side against real rows: what reads as stale and why, what a
// change invalidates, the relations of one record, and the rule that holds across all
// three: one audited check() on the scope asked about, only rows recorded inside it, no
// retired brief, no other tenant's rows, and no id that reads as erased. The three routes
// are driven too, with only the signed-in identity stubbed.
//
// Set QA_DATABASE_URL to an ISOLATED test database, never the inherited DATABASE_URL.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { ChangeOp, FactEdgeKind } from "@/lib/generated/prisma/enums";
import type { AccessContext } from "@/services/access";
import { seedMember } from "@/services/access/member.testsupport";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

const QA_URL = process.env.QA_DATABASE_URL;
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ORG = `deps${RUN}`;
const OTHER_ORG = `depsother${RUN}`;
const ROOT = `org_${ORG}`;
const ENG = `${ROOT}.eng`;
/** Shares ENG's prefix without being inside it. */
const ENGX = `${ROOT}.engx`;
/** `_` is a LIKE wildcard; unescaped, this scope would match ENG's rows. */
const E_G = `${ROOT}.e_g`;
const OTHER_ROOT = `org_${OTHER_ORG}`;
const ADMIN = `u-deps-admin-${RUN}`;
const READER = `u-deps-reader-${RUN}`;
const OUTSIDER = `u-deps-outsider-${RUN}`;

const T0 = new Date(Date.UTC(2026, 9, 16, 10, 0, 0));
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const human = (id: string, orgId = ORG): AccessContext => ({
  orgId,
  actor: { type: "human", id, role: "member" },
  origin: "app",
});

describe.skipIf(!QA_URL)("the dependency graph's read side, real Postgres", () => {
  let db: PrismaClient;
  let deps: typeof import("./dependencies");
  let AccessDeniedError: (typeof import("@/services/access"))["AccessDeniedError"];
  let recordErasedVersions: (typeof import("./erasure-suppression"))["recordErasedVersions"];
  let recordSuppressions: (typeof import("./erasure-suppression"))["recordSuppressions"];
  let recordErasedRules: (typeof import("./erasure-suppression"))["recordErasedRules"];
  let seq = 0;

  const brief = (id: string, scopePath: string, createdAt: Date, orgId = ORG) =>
    db.brief.create({
      data: { id, orgId, type: "handoff", scopePath, title: `brief ${id}`, summary: "s", sections: [], createdAt },
    });
  const cite = (briefId: string, factId: string, createdAt: Date, sectionIndex = 0) =>
    db.briefCitation.create({ data: { briefId, factId, sectionIndex, factText: `text of ${factId}`, createdAt } });
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
  const version = (id: string, scopePath: string, content: string, createdAt: Date) =>
    db.memoryChunk.create({ data: { id, orgId: ORG, content, scopePath, createdAt, factVersion: true } });
  /** Place records in a scope the way a removed version still is: by its `create` announcement. */
  const announced = async (scopePath: string, ...ids: string[]) => {
    for (const id of ids) await event(id, "create", scopePath, at(0));
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    deps = await import("./dependencies");
    ({ AccessDeniedError } = await import("@/services/access"));
    ({ recordErasedVersions, recordSuppressions, recordErasedRules } = await import("./erasure-suppression"));

    for (const id of [ORG, OTHER_ORG]) await db.org.create({ data: { id, name: id } });
    const scopes = new Map<string, string>();
    for (const [orgId, path] of [
      [ORG, ROOT],
      [ORG, ENG],
      [ORG, ENGX],
      [ORG, E_G],
      [OTHER_ORG, OTHER_ROOT],
    ] as const) {
      scopes.set(path, (await db.scope.create({ data: { orgId, path, name: path } })).id);
    }
    for (const userId of [ADMIN, READER, OUTSIDER]) await seedMember(db, { orgId: ORG, userId });
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
      await db.convention.deleteMany({ where: { orgId } });
      await db.erasureSuppression.deleteMany({ where: { orgId } });
      await db.auditLog.deleteMany({ where: { orgId } });
    }
  });

  afterAll(async () => {
    if (!QA_URL) return;
    for (const id of [ORG, OTHER_ORG]) {
      await db.auditLog.deleteMany({ where: { orgId: id } });
      await db.org.deleteMany({ where: { id } });
    }
    await db.user.deleteMany({ where: { id: { in: [ADMIN, READER, OUTSIDER] } } });
    await db.$disconnect();
  });

  describe("staleReport", () => {
    it("lists a brief whose cited fact was replaced, naming the replacement, and one whose fact was deleted after it was built", async () => {
      await brief("b-replaced", ENG, at(10));
      await cite("b-replaced", "f-old", at(10));
      await edge("f-new", "f-old", "supersedes", ENG, at(20));
      await announced(ENG, "f-new");
      await brief("b-deleted", ENG, at(10));
      await cite("b-deleted", "f-gone", at(10));
      await event("f-gone", "delete", ENG, at(30));
      await brief("b-fresh", ENG, at(10));
      await cite("b-fresh", "f-fresh", at(10));
      await event("f-fresh", "update", ENG, at(5)); // before the brief: not a change to it

      const report = await deps.staleReport(human(READER), ENG, 10);

      expect(report.stale).toEqual(
        expect.arrayContaining([
          {
            recordId: "b-replaced",
            sourceId: "f-old",
            kind: "cites",
            reason: { kind: "superseded", at: at(20), byId: "f-new" },
          },
          {
            recordId: "b-deleted",
            sourceId: "f-gone",
            kind: "cites",
            reason: { kind: "changed", at: at(30), op: "delete" },
          },
        ]),
      );
      expect(report.stale).toHaveLength(2);
      expect(report.recommend.map((r) => r.recordId)).toEqual(["b-deleted", "b-replaced"]);
      expect(report.truncated).toBe(false);
    });

    it("lists a brief built while a long transaction was open, when that transaction then changes its source", async () => {
      // The change event is dated when it is written, not when its transaction began
      // (services/memory/change-events.ts): dated by the start, it would read as older than the
      // brief and the brief would never read as stale.
      const { recordChangeEvent } = await import("./change-events");
      let briefBuilt: () => void = () => {};
      const built = new Promise<void>((resolve) => {
        briefBuilt = resolve;
      });
      const change = db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 AS opened`;
          await built;
          await recordChangeEvent(tx, {
            orgId: ORG,
            scopePath: ENG,
            recordType: "fact",
            recordId: "f-late",
            op: "update",
            actorId: "agent-1",
            actorType: "agent",
            origin: "mcp",
            title: "late change",
          });
        },
        { timeout: 30_000 },
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      await brief("b-late", ENG, new Date());
      await cite("b-late", "f-late", new Date());
      await new Promise((resolve) => setTimeout(resolve, 50));
      briefBuilt();
      await change;

      const report = await deps.staleReport(human(READER), ENG, 10);

      expect(report.stale).toEqual([
        {
          recordId: "b-late",
          sourceId: "f-late",
          kind: "cites",
          reason: { kind: "changed", at: expect.any(Date), op: "update" },
        },
      ]);
    });

    it("reads one brief citing a fact in several sections as one dependency", async () => {
      await brief("b-many", ENG, at(10));
      for (const section of [0, 1, 2]) await cite("b-many", "f-old", at(10), section);
      await edge("f-new", "f-old", "supersedes", ENG, at(20));
      await announced(ENG, "f-new");

      const report = await deps.staleReport(human(READER), ENG);
      expect(report.stale).toHaveLength(1);
      expect(report.recommend).toEqual([expect.objectContaining({ recordId: "b-many", staleSources: 1 })]);
    });

    it("ranks the record most rested on first", async () => {
      await version("r-base", ENG, "base", at(1));
      await edge("r-base", "f-old", "dependsOn", ENG, at(5));
      await edge("r-top", "r-base", "dependsOn", ENG, at(6));
      await edge("r-top2", "r-base", "dependsOn", ENG, at(6));
      await announced(ENG, "r-top", "r-top2");
      await brief("b-newer", ENG, at(10));
      await cite("b-newer", "f-other", at(10));
      await event("f-old", "supersede", ENG, at(40));
      await event("f-other", "delete", ENG, at(50));

      const { recommend } = await deps.staleReport(human(READER), ENG);
      expect(recommend.map((r) => [r.recordId, r.dependents])).toEqual([
        ["r-base", 2],
        ["b-newer", 0],
      ]);
    });

    it("never reads another tenant's rows, a sibling scope's, an underscore-wildcard match or a retired brief", async () => {
      await brief("b-mine", ENG, at(10));
      await cite("b-mine", "f-shared-id", at(10));
      // Another org replaced and deleted a fact with the same id: no evidence about this org.
      await edge("f-theirs", "f-shared-id", "supersedes", OTHER_ROOT, at(20), OTHER_ORG);
      await event("f-shared-id", "delete", OTHER_ROOT, at(30), "fact", OTHER_ORG);
      await brief("b-sibling", ENGX, at(10));
      await cite("b-sibling", "f-sib", at(10));
      await edge("f-sib-new", "f-sib", "supersedes", ENGX, at(20));
      await announced(ENGX, "f-sib-new");
      await brief("b-retired", ENG, at(10));
      await cite("b-retired", "f-old", at(10));
      await db.briefRetirement.create({ data: { briefId: "b-retired", sourceId: "src-1", reason: "source_moved" } });
      await edge("f-new", "f-old", "supersedes", ENG, at(20));
      await announced(ENG, "f-new");

      // A sibling's brief and another tenant's brief citing a fact this scope did replace.
      await brief("b-sibling-cites-eng", ENGX, at(10));
      await cite("b-sibling-cites-eng", "f-old", at(10));
      await brief("b-theirs", OTHER_ROOT, at(10), OTHER_ORG);
      await cite("b-theirs", "f-old", at(10));
      await brief("b-theirs-at-our-path", ENG, at(10), OTHER_ORG);
      await cite("b-theirs-at-our-path", "f-old", at(10));
      // Another tenant's rows written under this org's scope path, between records this org
      // placed there, so only the row's own org leaves them out: never this org's.
      await announced(ENG, "r-theirs", "f-old", "f-their-new", "f-shared-id");
      await edge("r-theirs", "f-old", "dependsOn", ENG, at(11), OTHER_ORG);
      await edge("f-their-new", "f-shared-id", "supersedes", ENG, at(21), OTHER_ORG);
      await event("f-shared-id", "delete", ENG, at(31), "fact", OTHER_ORG);

      expect((await deps.staleReport(human(READER), ENG)).stale).toEqual([]);
      expect((await deps.staleReport(human(ADMIN), E_G)).stale).toEqual([]);
      // Another tenant's edge onto a record this org placed in ENG is not a dependent of it.
      await announced(ENG, "f-placed", "r-their-dep");
      await edge("r-their-dep", "f-placed", "dependsOn", ENG, at(12), OTHER_ORG);
      expect((await deps.whatToChange(human(READER), "f-placed", ENG)).items).toEqual([]);
      // The sibling's brief is real and stale: the admin reading its own scope sees it.
      expect((await deps.staleReport(human(ADMIN), ENGX)).stale.map((s) => s.recordId)).toEqual(["b-sibling"]);
    });

    it("never reads a replacement or a change recorded outside the scope as evidence", async () => {
      await brief("b-eng", ENG, at(10));
      await cite("b-eng", "f-old", at(10));
      await edge("f-new", "f-old", "supersedes", ENGX, at(20));
      await event("f-old", "delete", ENGX, at(30));
      expect((await deps.staleReport(human(READER), ENG)).stale).toEqual([]);
    });

    it("does not read a declared share's derivedFrom edge, which names a scope, as a dependency", async () => {
      const engScope = await db.scope.findFirstOrThrow({ where: { orgId: ORG, path: ENG } });
      await edge("v-shared", engScope.id, "derivedFrom", ENG, at(1));
      await edge("v-shared2", ENGX, "derivedFrom", ENG, at(1));
      // Both `from` ends are placed, so only the `to` end, a scope, keeps the edges out.
      await announced(ENG, "v-shared", "v-shared2");
      // The scope's own change, and the scope row deleted afterwards, still make neither a record.
      await event(engScope.id, "delete", ENG, at(5), "scope");
      await event(ENGX, "delete", ENG, at(5), "scope");
      expect((await deps.staleReport(human(READER), ENG)).stale).toEqual([]);
      expect((await deps.edgesOf(human(READER), "v-shared", ENG)).outgoing).toEqual([]);
    });

    it("counts a change only on a fact or rule record", async () => {
      await brief("b", ENG, at(10));
      await cite("b", "id-reused", at(10));
      await event("id-reused", "delete", ENG, at(30), "note");
      expect((await deps.staleReport(human(READER), ENG)).stale).toEqual([]);
      await event("id-reused", "delete", ENG, at(31), "convention");
      expect((await deps.staleReport(human(READER), ENG)).stale).toHaveLength(1);
    });

    it("never names an erased version: as a source, a dependent or a replacement", async () => {
      await brief("b-erased-source", ENG, at(10));
      await cite("b-erased-source", "f-erased", at(10));
      await event("f-erased", "delete", ENG, at(30));
      await version("r-erased", ENG, "derived", at(1));
      await edge("r-erased", "f-plain", "dependsOn", ENG, at(5));
      await event("f-plain", "update", ENG, at(30));
      await brief("b-erased-replacement", ENG, at(10));
      await cite("b-erased-replacement", "f-old", at(10));
      await edge("f-erased-new", "f-old", "supersedes", ENG, at(20));
      await announced(ENG, "f-erased-new");
      await db.$transaction((tx) => recordErasedVersions(tx, ORG, "req-1", ["f-erased", "r-erased", "f-erased-new"]));

      const report = await deps.staleReport(human(READER), ENG);
      // A replacement that reads as erased is not counted: its id and its time stay unsaid.
      expect(report.stale).toEqual([]);
      expect(JSON.stringify(report)).not.toMatch(/f-erased|r-erased|b-erased-replacement/);
    });

    it("names the live replacement when a newer one reads as erased", async () => {
      await brief("b", ENG, at(10));
      await cite("b", "f-old", at(10));
      await edge("f-live", "f-old", "supersedes", ENG, at(20));
      await edge("f-erased", "f-old", "supersedes", ENG, at(30));
      // Both replacements are placed: erasure alone leaves the newer one out.
      await announced(ENG, "f-live", "f-erased");
      await db.$transaction((tx) => recordErasedVersions(tx, ORG, "req-rt4", ["f-erased"]));
      expect((await deps.staleReport(human(READER), ENG)).stale.map((x) => x.reason)).toEqual([
        { kind: "superseded", at: at(20), byId: "f-live" },
      ]);
    });

    it("lists a brief whose cited fact was replaced before the brief was built: it quotes a version no longer current", async () => {
      await brief("b-late", ENG, at(10));
      await cite("b-late", "f-old", at(10));
      await edge("f-new", "f-old", "supersedes", ENG, at(5));
      await announced(ENG, "f-new");
      expect((await deps.staleReport(human(READER), ENG)).stale.map((x) => x.reason)).toEqual([
        { kind: "superseded", at: at(5), byId: "f-new" },
      ]);
    });

    it("never names a rule an erasure redacted, as a source, an edge end or a root", async () => {
      await version("r-dep", ENG, "rests on the refund rule", at(1));
      await edge("r-dep", "rule-redacted", "dependsOn", ENG, at(5));
      await event("rule-redacted", "create", ENG, at(2), "convention");
      await db.$transaction((tx) => recordErasedRules(tx, ORG, "req-rt2", ["rule-redacted"]));
      await event("rule-redacted", "delete", ENG, at(30), "convention");
      expect(JSON.stringify(await deps.staleReport(human(READER), ENG))).not.toContain("rule-redacted");
      expect(JSON.stringify(await deps.edgesOf(human(READER), "r-dep", ENG))).not.toContain("rule-redacted");
      expect((await deps.whatToChange(human(READER), "rule-redacted", ENG)).items).toEqual([]);
    });

    it("leaves out a rule whose text names an erased person", async () => {
      await version("r-dep", ENG, "rests on the refund rule", at(1));
      await db.convention.create({
        data: {
          id: "rule-names-her",
          orgId: ORG,
          scopePath: ENG,
          kind: "convention",
          subject: "refunds",
          text: "Orla Brennick approves refunds",
          actorId: ADMIN,
          createdAt: at(1),
        },
      });
      await edge("r-dep", "rule-names-her", "dependsOn", ENG, at(5));
      await event("rule-names-her", "update", ENG, at(30), "convention");
      await recordSuppressions(db, ORG, "req-rule", { emails: [], names: ["Orla Brennick"], contactIds: [] });
      expect(JSON.stringify(await deps.staleReport(human(READER), ENG))).not.toContain("rule-names-her");
    });

    it("does not count an erased dependent toward a record's dependents", async () => {
      await version("r-base", ENG, "base", at(1));
      await edge("r-base", "f-old", "dependsOn", ENG, at(5));
      await event("f-old", "delete", ENG, at(40));
      await edge("r-live", "r-base", "dependsOn", ENG, at(6));
      await edge("r-gone", "r-base", "dependsOn", ENG, at(6));
      // Both dependents are placed: erasure alone leaves r-gone uncounted.
      await announced(ENG, "r-live", "r-gone");
      await db.$transaction((tx) => recordErasedVersions(tx, ORG, "req-dep", ["r-gone"]));
      expect((await deps.staleReport(human(READER), ENG)).recommend.map((r) => [r.recordId, r.dependents])).toEqual([
        ["r-base", 1],
      ]);
    });

    it("leaves out a version whose text names an erased person, as every read does", async () => {
      await version("f-names-her", ENG, "Orla Brennick owns the renewal", at(1));
      await brief("b", ENG, at(10));
      await cite("b", "f-names-her", at(10));
      await event("f-names-her", "update", ENG, at(30));
      await recordSuppressions(db, ORG, "req-2", { emails: [], names: ["Orla Brennick"], contactIds: [] });
      expect((await deps.staleReport(human(READER), ENG)).stale).toEqual([]);
    });

    it("says truncated when a query finds more rows than it reads", async () => {
      await brief("b-big", ENG, at(10));
      await db.briefCitation.createMany({
        data: Array.from({ length: deps.MAX_ROWS_PER_QUERY + 1 }, (_, i) => ({
          briefId: "b-big",
          factId: `f-${i}`,
          sectionIndex: 0,
          factText: "t",
          createdAt: at(10),
        })),
      });
      expect((await deps.staleReport(human(READER), ENG)).truncated).toBe(true);
    });

    it("says truncated only past the bound: exactly the bound is complete", async () => {
      await brief("b-full", ENG, at(10));
      await db.briefCitation.createMany({
        data: Array.from({ length: deps.MAX_ROWS_PER_QUERY }, (_, i) => ({
          briefId: "b-full",
          factId: `f-${i}`,
          sectionIndex: 0,
          factText: "t",
          createdAt: at(10),
        })),
      });
      const edges = await deps.edgesOf(human(READER), "b-full", ENG);
      expect(edges.outgoing).toHaveLength(deps.MAX_ROWS_PER_QUERY);
      expect(edges.truncated).toBe(false);
    });
  });

  describe("whatToChange", () => {
    it("walks everything resting on a record, nearest first, through briefs' citations and edges", async () => {
      await version("r-mid", ENG, "mid", at(1));
      await announced(ENG, "f-root");
      await cite((await brief("b-direct", ENG, at(10))).id, "f-root", at(10));
      await cite((await brief("b-sibling", ENGX, at(10))).id, "f-root", at(10));
      await edge("r-mid", "f-root", "dependsOn", ENG, at(5));
      await edge("r-far", "r-mid", "derivedFrom", ENG, at(6));
      await edge("r-elsewhere", "f-root", "dependsOn", ENGX, at(7));
      await edge("f-newer", "f-root", "supersedes", ENG, at(8));
      await announced(ENG, "r-far", "f-newer");
      await announced(ENGX, "r-elsewhere");

      const { items, truncated } = await deps.whatToChange(human(READER), "f-root", ENG);
      expect(items.map((i) => [i.recordId, i.distance])).toEqual([
        ["b-direct", 1],
        ["r-mid", 1],
        ["r-far", 2],
      ]);
      expect(items[2]!.path.map((e) => `${e.fromId}>${e.toId}:${e.kind}`)).toEqual([
        "r-mid>f-root:dependsOn",
        "r-far>r-mid:derivedFrom",
      ]);
      expect(truncated).toBe(false);
    });

    it("answers nothing for an erased record, and leaves out an erased dependent and what rests only on it", async () => {
      await announced(ENG, "f-root", "r-erased");
      await edge("r-erased", "f-root", "dependsOn", ENG, at(5));
      await edge("r-behind", "r-erased", "dependsOn", ENG, at(6));
      await edge("r-kept", "f-root", "dependsOn", ENG, at(7));
      await announced(ENG, "r-behind", "r-kept");
      await db.$transaction((tx) => recordErasedVersions(tx, ORG, "req-3", ["r-erased"]));
      expect((await deps.whatToChange(human(READER), "f-root", ENG)).items.map((i) => i.recordId)).toEqual(["r-kept"]);

      await db.$transaction((tx) => recordErasedVersions(tx, ORG, "req-4", ["f-root"]));
      expect(await deps.whatToChange(human(READER), "f-root", ENG)).toEqual({ items: [], truncated: false });
    });
  });

  describe("edgesOf", () => {
    it("lists both directions inside the scope, and nothing touching an erased version", async () => {
      await announced(ENG, "f-v1", "f-v2");
      await edge("f-v2", "f-v1", "supersedes", ENG, at(1));
      await edge("f-v3", "f-v2", "supersedes", ENG, at(2));
      await cite((await brief("b", ENG, at(3))).id, "f-v2", at(3));
      await edge("r-x", "f-v2", "dependsOn", ENGX, at(4));
      await announced(ENG, "f-v3");
      await announced(ENGX, "r-x");

      const edges = await deps.edgesOf(human(READER), "f-v2", ENG);
      expect(edges.outgoing.map((e) => `${e.fromId}>${e.toId}:${e.kind}`)).toEqual(["f-v2>f-v1:supersedes"]);
      expect(edges.incoming.map((e) => `${e.fromId}>${e.toId}:${e.kind}`)).toEqual([
        "b>f-v2:cites",
        "f-v3>f-v2:supersedes",
      ]);

      await db.$transaction((tx) => recordErasedVersions(tx, ORG, "req-5", ["f-v1"]));
      expect((await deps.edgesOf(human(READER), "f-v2", ENG)).outgoing).toEqual([]);
      expect((await deps.edgesOf(human(READER), "f-v1", ENG)).incoming).toEqual([]);
    });

    it("lists what a brief cites from the brief's side", async () => {
      await cite((await brief("b", ENG, at(3))).id, "f-1", at(3));
      expect((await deps.edgesOf(human(READER), "b", ENG)).outgoing).toEqual([
        expect.objectContaining({ fromId: "b", toId: "f-1", kind: "cites", scopePath: ENG }),
      ]);
    });
  });

  describe("both ends placed inside the scope", () => {
    it("never names a replacement stored only in a sibling scope, whatever scope its edge row carries", async () => {
      await brief("b", ENG, at(10));
      await cite("b", "f-old", at(10));
      await version("f-sibling-new", ENGX, "engx only", at(15));
      await edge("f-sibling-new", "f-old", "supersedes", ENG, at(20));
      await announced(ENG, "f-old");
      expect((await deps.staleReport(human(READER), ENG)).stale).toEqual([]);
      expect(JSON.stringify(await deps.edgesOf(human(READER), "f-old", ENG))).not.toContain("f-sibling-new");
      // Placed in ENG as well, the same replacement is named.
      await announced(ENG, "f-sibling-new");
      expect((await deps.staleReport(human(READER), ENG)).stale.map((x) => x.reason)).toEqual([
        { kind: "superseded", at: at(20), byId: "f-sibling-new" },
      ]);
    });

    it("never hands a reader the id of a record stored only in a sibling scope", async () => {
      await version("r-hidden", ENGX, "engx only", at(1));
      await version("r-eng", ENG, "eng", at(2));
      await edge("r-eng", "r-hidden", "dependsOn", ENG, at(3));
      await event("r-hidden", "update", ENG.replace(".eng", ".engx"), at(9));
      expect(JSON.stringify(await deps.edgesOf(human(READER), "r-eng", ENG))).not.toContain("r-hidden");
      expect(JSON.stringify(await deps.staleReport(human(READER), ENG))).not.toContain("r-hidden");
      expect(await deps.edgesOf(human(READER), "r-hidden", ENG)).toEqual(
        await deps.edgesOf(human(READER), "never-issued", ENG),
      );
      // The admin reading the org root sees the edge, the record being placed there.
      expect((await deps.edgesOf(human(ADMIN), "r-eng", ROOT)).outgoing.map((e) => e.toId)).toEqual(["r-hidden"]);
    });

    it("places a record by its row, its rule, its brief or its announcement", async () => {
      await version("to-row", ENG, "row", at(1));
      await db.convention.create({
        data: {
          id: "to-rule",
          orgId: ORG,
          scopePath: ENG,
          kind: "convention",
          subject: "refunds",
          text: "within 30 days",
          actorId: ADMIN,
        },
      });
      await brief("to-brief", ENG, at(1));
      await announced(ENG, "to-removed");
      await version("r-from", ENG, "from", at(1));
      for (const to of ["to-row", "to-rule", "to-brief", "to-removed", "to-nowhere"])
        await edge("r-from", to, "dependsOn", ENG, at(2));
      expect((await deps.edgesOf(human(READER), "r-from", ENG)).outgoing.map((e) => e.toId).sort()).toEqual([
        "to-brief",
        "to-removed",
        "to-row",
        "to-rule",
      ]);
    });

    it("does not place a record by another tenant's rule or brief stored under this org's path", async () => {
      await version("r-from", ENG, "from", at(1));
      await db.convention.create({
        data: {
          id: "to-their-rule",
          orgId: OTHER_ORG,
          scopePath: ENG,
          kind: "convention",
          subject: "refunds",
          text: "theirs",
          actorId: ADMIN,
          createdAt: at(1),
        },
      });
      await brief("to-their-brief", ENG, at(1), OTHER_ORG);
      await edge("r-from", "to-their-rule", "dependsOn", ENG, at(2));
      await edge("r-from", "to-their-brief", "dependsOn", ENG, at(2));
      expect((await deps.edgesOf(human(READER), "r-from", ENG)).outgoing).toEqual([]);
    });

    it("does not place a record by a rule stored only in a sibling scope", async () => {
      await version("r-eng", ENG, "eng", at(1));
      await db.convention.create({
        data: {
          id: "rule-engx",
          orgId: ORG,
          scopePath: ENGX,
          kind: "convention",
          subject: "refunds",
          text: "engx only",
          actorId: ADMIN,
          createdAt: at(1),
        },
      });
      await edge("r-eng", "rule-engx", "dependsOn", ENG, at(2));
      expect((await deps.edgesOf(human(READER), "r-eng", ENG)).outgoing).toEqual([]);
    });

    it("does not read an edge recorded in a sibling scope, even with both ends placed here", async () => {
      await version("r-eng", ENG, "eng", at(1));
      await version("f-eng", ENG, "eng", at(1));
      await edge("r-eng", "f-eng", "dependsOn", ENGX, at(2));
      expect(await deps.edgesOf(human(READER), "f-eng", ENG)).toEqual({ outgoing: [], incoming: [], truncated: false });
      // A replacement recorded in the sibling is no evidence here either, its ends placed or not.
      await brief("b", ENG, at(10));
      await cite("b", "f-old", at(10));
      await version("f-new", ENG, "new", at(20));
      await edge("f-new", "f-old", "supersedes", ENGX, at(20));
      expect((await deps.staleReport(human(READER), ENG)).stale).toEqual([]);
    });

    it("does not place a record by a retired brief or an untagged row below the root", async () => {
      await brief("to-retired", ENG, at(1));
      await db.briefRetirement.create({ data: { briefId: "to-retired", sourceId: "src-1", reason: "source_moved" } });
      await db.memoryChunk.create({ data: { id: "to-untagged", orgId: ORG, content: "untagged", createdAt: at(1) } });
      await version("r-from", ENG, "from", at(1));
      await version("r-root", ROOT, "root", at(1));
      await edge("r-from", "to-retired", "dependsOn", ENG, at(2));
      await edge("r-from", "to-untagged", "dependsOn", ENG, at(2));
      expect((await deps.edgesOf(human(READER), "r-from", ENG)).outgoing).toEqual([]);
      await edge("r-root", "to-untagged", "dependsOn", ROOT, at(2));
      expect((await deps.edgesOf(human(ADMIN), "r-root", ROOT)).outgoing.map((e) => e.toId)).toEqual(["to-untagged"]);
    });

    it("never reads a declared share's edge, even once the scope it names is deleted", async () => {
      const shared = await db.scope.create({ data: { orgId: ORG, path: `${ROOT}.shared`, name: "shared" } });
      await edge("v-shared", shared.id, "derivedFrom", ENG, at(1));
      await edge("v-path", `${ROOT}.e_g`, "derivedFrom", ENG, at(1));
      await edge("v-root", ROOT, "derivedFrom", ENG, at(1));
      await announced(ENG, "v-shared", "v-path", "v-root");
      await db.scope.delete({ where: { id: shared.id } });
      for (const id of ["v-shared", "v-path", "v-root"])
        expect((await deps.edgesOf(human(READER), id, ENG)).outgoing).toEqual([]);
      expect((await deps.whatToChange(human(READER), shared.id, ENG)).items).toEqual([]);
    });

    it("says truncated when the depth bound stops the walk with dependents left", async () => {
      let to = "f-root";
      await announced(ENG, to);
      for (let i = 1; i <= deps.MAX_WALK_DEPTH + 2; i++) {
        await version(`r-${i}`, ENG, `r-${i}`, at(i));
        await edge(`r-${i}`, to, "dependsOn", ENG, at(i));
        to = `r-${i}`;
      }
      const deep = await deps.whatToChange(human(READER), "f-root", ENG);
      expect(deep.items).toHaveLength(deps.MAX_WALK_DEPTH);
      expect(deep.truncated).toBe(true);
      // Exactly the bound deep: nothing left unvisited, so not truncated.
      expect((await deps.whatToChange(human(READER), "r-2", ENG)).truncated).toBe(false);
    });
  });

  // Each test here writes more rows than both reads of a query cover (SECOND_READ_ROWS, 2,004),
  // which takes 0.3 to 1.6 s on a quiet machine and timed out at the 5 s default on a loaded CI
  // runner. The rows are what these tests prove, so the bound is sized to their setup instead.
  describe(
    "an erased relation answers as one never recorded, in the list and in truncated",
    { timeout: 30_000 },
    () => {
      /** As many rows as the second, widest read of a query returns: only SQL can leave them all out. */
      const BEYOND_READS = () => deps.SECOND_READ_ROWS;
      const ids = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}-${i}`);
      const edgesTo = (fromIds: string[], toId: string, kind: FactEdgeKind, createdAt: Date) =>
        db.factEdge.createMany({
          data: fromIds.map((fromId) => ({
            orgId: ORG,
            fromId,
            toId,
            kind,
            scopePath: ENG,
            actorType: "agent" as const,
            actorId: "agent-1",
            createdAt,
          })),
        });
      /** What a finished erasure leaves of versions: no row, a blank announcement placing it in ENG, its id on the list. */
      const erasedById = async (versionIds: string[]) => {
        await db.changeEvent.createMany({
          data: versionIds.map((recordId) => ({
            orgId: ORG,
            seq: BigInt(++seq),
            scopePath: ENG,
            recordType: "fact",
            recordId,
            op: "create" as const,
            actorId: "agent-1",
            summary: "",
            createdAt: at(0),
          })),
        });
        await db.$transaction((tx) => recordErasedVersions(tx, ORG, `req-${versionIds[0]}`, versionIds));
      };
      /** Stored versions naming a person erased since, ids not on the list: what a restore puts back before its re-apply. */
      const namingErased = async (versionIds: string[]) => {
        await db.memoryChunk.createMany({
          data: versionIds.map((id) => ({
            id,
            orgId: ORG,
            content: `Orla Brennick signed ${id}`,
            scopePath: ENG,
            createdAt: at(1),
            factVersion: true,
          })),
        });
        await recordSuppressions(db, ORG, `req-${versionIds[0]}`, {
          emails: [],
          names: ["Orla Brennick"],
          contactIds: [],
        });
      };

      it("lists a live dependent behind more erased ones than both reads cover, untruncated", async () => {
        await version("f-src", ENG, "src", at(1));
        await version("r-live", ENG, "live", at(1));
        await edge("r-live", "f-src", "dependsOn", ENG, at(2));
        const gone = ids("r-gone", BEYOND_READS());
        await erasedById(gone);
        await edgesTo(gone, "f-src", "dependsOn", at(3));
        expect(await deps.edgesOf(human(READER), "f-src", ENG)).toEqual({
          outgoing: [],
          incoming: [expect.objectContaining({ fromId: "r-live", toId: "f-src" })],
          truncated: false,
        });
        expect(await deps.whatToChange(human(READER), "f-src", ENG)).toEqual({
          items: [expect.objectContaining({ recordId: "r-live" })],
          truncated: false,
        });
      });

      it("lists a source a brief cites behind more erased cited facts than both reads cover", async () => {
        await version("f-live", ENG, "live", at(1));
        await brief("b", ENG, at(1));
        await cite("b", "f-live", at(2));
        const gone = ids("f-gone", BEYOND_READS());
        await erasedById(gone);
        await db.briefCitation.createMany({
          data: gone.map((factId) => ({ briefId: "b", factId, sectionIndex: 0, factText: "t", createdAt: at(3) })),
        });
        expect(await deps.edgesOf(human(READER), "b", ENG)).toEqual({
          outgoing: [expect.objectContaining({ toId: "f-live" })],
          incoming: [],
          truncated: false,
        });
      });

      it("answers nothing for a record that reads as erased by its text, however many relations it has", async () => {
        await namingErased(["r-root"]);
        const dependents = ids("r-on-root", BEYOND_READS());
        await db.memoryChunk.createMany({
          data: dependents.map((id) => ({
            id,
            orgId: ORG,
            content: id,
            scopePath: ENG,
            createdAt: at(1),
            factVersion: true,
          })),
        });
        await edgesTo(dependents, "r-root", "dependsOn", at(3));
        expect(await deps.edgesOf(human(READER), "r-root", ENG)).toEqual({
          outgoing: [],
          incoming: [],
          truncated: false,
        });
        expect(await deps.whatToChange(human(READER), "r-root", ENG)).toEqual({ items: [], truncated: false });
      });

      it("lists a live dependent behind more redacted rules than both reads cover", async () => {
        await version("f-src", ENG, "src", at(1));
        await version("r-live", ENG, "live", at(1));
        await edge("r-live", "f-src", "dependsOn", ENG, at(2));
        const redacted = ids("rule-gone", BEYOND_READS());
        await db.convention.createMany({
          data: redacted.map((id) => ({
            id,
            orgId: ORG,
            scopePath: ENG,
            kind: "convention" as const,
            subject: "redacted",
            text: "redacted",
            actorId: ADMIN,
            createdAt: at(1),
          })),
        });
        await db.$transaction((tx) => recordErasedRules(tx, ORG, "req-rules", redacted));
        await edgesTo(redacted, "f-src", "dependsOn", at(3));
        expect(await deps.edgesOf(human(READER), "f-src", ENG)).toEqual({
          outgoing: [],
          incoming: [expect.objectContaining({ fromId: "r-live" })],
          truncated: false,
        });
      });

      it("names a live replacement behind more erased replacements than both reads cover", async () => {
        await version("f-old", ENG, "old", at(1));
        await version("f-new", ENG, "new", at(1));
        await version("r-dep", ENG, "dep", at(1));
        await edge("r-dep", "f-old", "dependsOn", ENG, at(2));
        await edge("f-new", "f-old", "supersedes", ENG, at(3));
        const gone = ids("f-gone-new", BEYOND_READS());
        await erasedById(gone);
        await edgesTo(gone, "f-old", "supersedes", at(4));
        expect(await deps.staleReport(human(READER), ENG)).toEqual({
          stale: [
            {
              recordId: "r-dep",
              sourceId: "f-old",
              kind: "dependsOn",
              reason: { kind: "superseded", at: at(3), byId: "f-new" },
            },
          ],
          recommend: [expect.objectContaining({ recordId: "r-dep" })],
          truncated: false,
        });
      });

      it("lists a live stale dependent behind more dependents of erased sources than both reads cover", async () => {
        await version("f-src", ENG, "src", at(1));
        await version("r-live", ENG, "live", at(1));
        await edge("r-live", "f-src", "dependsOn", ENG, at(2));
        await event("f-src", "update", ENG, at(10));
        const gone = ids("f-gone-src", BEYOND_READS());
        await erasedById(gone);
        const dependents = ids("r-on-gone", gone.length);
        await db.memoryChunk.createMany({
          data: dependents.map((id) => ({
            id,
            orgId: ORG,
            content: id,
            scopePath: ENG,
            createdAt: at(1),
            factVersion: true,
          })),
        });
        await db.factEdge.createMany({
          data: dependents.map((fromId, i) => ({
            orgId: ORG,
            fromId,
            toId: gone[i]!,
            kind: "dependsOn" as const,
            scopePath: ENG,
            actorType: "agent" as const,
            actorId: "agent-1",
            createdAt: at(3),
          })),
        });
        expect(await deps.staleReport(human(READER), ENG)).toEqual({
          stale: [expect.objectContaining({ recordId: "r-live", sourceId: "f-src" })],
          recommend: [expect.objectContaining({ recordId: "r-live" })],
          truncated: false,
        });
      });

      it("reads again past stored copies that name an erased person, so they do not fill the bound", async () => {
        await version("f-src", ENG, "src", at(1));
        await version("r-live", ENG, "live", at(1));
        await edge("r-live", "f-src", "dependsOn", ENG, at(2));
        const copies = ids("r-copy", deps.MAX_ROWS_PER_QUERY + 1);
        await namingErased(copies);
        await edgesTo(copies, "f-src", "dependsOn", at(3));
        expect(await deps.edgesOf(human(READER), "f-src", ENG)).toEqual({
          outgoing: [],
          incoming: [expect.objectContaining({ fromId: "r-live" })],
          truncated: false,
        });
      });

      it("lists exactly the bound of live dependents behind newer such copies, untruncated", async () => {
        await version("f-src", ENG, "src", at(1));
        const live = ids("r-live", deps.MAX_ROWS_PER_QUERY);
        await db.memoryChunk.createMany({
          data: live.map((id) => ({
            id,
            orgId: ORG,
            content: id,
            scopePath: ENG,
            createdAt: at(1),
            factVersion: true,
          })),
        });
        await edgesTo(live, "f-src", "dependsOn", at(2));
        const copies = ids("r-copy", 20);
        await namingErased(copies);
        await edgesTo(copies, "f-src", "dependsOn", at(3));
        const { incoming, truncated } = await deps.edgesOf(human(READER), "f-src", ENG);
        expect({
          listed: incoming.length,
          named: incoming.filter((e) => e.fromId.startsWith("r-copy")),
          truncated,
        }).toEqual({
          listed: deps.MAX_ROWS_PER_QUERY,
          named: [],
          truncated: false,
        });
      });

      // The documented limit: a copy found only by its text is left out after a read, and the
      // second read reaches SECOND_READ_ROWS rows, no further.
      it("says truncated when the second read holds only such copies, newer than a live dependent", async () => {
        await version("f-src", ENG, "src", at(1));
        await version("r-live", ENG, "live", at(1));
        await edge("r-live", "f-src", "dependsOn", ENG, at(2));
        const copies = ids("r-copy", BEYOND_READS());
        await namingErased(copies);
        await edgesTo(copies, "f-src", "dependsOn", at(3));
        expect(await deps.edgesOf(human(READER), "f-src", ENG)).toEqual({
          outgoing: [],
          incoming: [],
          truncated: true,
        });
      });
    },
  );

  describe("access", () => {
    it.each([
      ["staleReport", OUTSIDER, () => deps.staleReport(human(OUTSIDER), ENG)],
      ["whatToChange", OUTSIDER, () => deps.whatToChange(human(OUTSIDER), "f", ENG)],
      ["edgesOf", OUTSIDER, () => deps.edgesOf(human(OUTSIDER), "f", ENG)],
      ["staleReport above the grant", READER, () => deps.staleReport(human(READER), ROOT)],
      ["staleReport in another org", READER, () => deps.staleReport(human(READER, OTHER_ORG), OTHER_ROOT)],
    ])("%s refuses a caller without memory.read on the scope, with one deny row", async (_name, actorId, run) => {
      await brief("b", ENG, at(10));
      await cite("b", "f", at(10));
      await event("f", "delete", ENG, at(20));
      await expect(run()).rejects.toThrow(AccessDeniedError);
      expect(await db.auditLog.count({ where: { actorId, action: "memory.read", decision: "deny" } })).toBe(1);
      expect(await db.auditLog.count({ where: { actorId, decision: "allow" } })).toBe(0);
    });

    it("records one allowed read decision per call", async () => {
      await deps.staleReport(human(READER), ENG);
      expect(
        await db.auditLog.count({ where: { orgId: ORG, actorId: READER, action: "memory.read", decision: "allow" } }),
      ).toBe(1);
    });
  });

  describe("routes", () => {
    let signIn: (userId: string | null) => Promise<void>;
    let routes: {
      stale: (req: Request) => Promise<Response>;
      edges: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
      whatToChange: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
    };
    const get = (path: string) => new Request(`http://test${path}`);
    const id = (value: string) => ({ params: Promise.resolve({ id: value }) });

    beforeAll(async () => {
      routes = {
        stale: (await import("@/app/api/memory/scopes/stale/route")).GET,
        edges: (await import("@/app/api/memory/facts/[id]/edges/route")).GET,
        whatToChange: (await import("@/app/api/memory/facts/[id]/what-to-change/route")).GET,
      };
      const { requireAccessContext } = await import("@/lib/access-context");
      signIn = async (userId) => {
        if (!userId) return void vi.mocked(requireAccessContext).mockResolvedValue(null as never);
        vi.mocked(requireAccessContext).mockResolvedValue({
          org: await db.org.findUniqueOrThrow({ where: { id: ORG } }),
          user: await db.user.findUniqueOrThrow({ where: { id: userId } }),
          ctx: human(userId),
        } as never);
      };
    });

    it("answers 401 signed out", async () => {
      await signIn(null);
      expect((await routes.stale(get("/api/memory/scopes/stale"))).status).toBe(401);
      expect((await routes.edges(get("/api/memory/facts/f/edges"), id("f"))).status).toBe(401);
      expect((await routes.whatToChange(get("/api/memory/facts/f/what-to-change"), id("f"))).status).toBe(401);
    });

    it("reads at the org root when no scope is sent, and at the trimmed scope when one is", async () => {
      await signIn(ADMIN);
      expect(await (await routes.stale(get("/api/memory/scopes/stale"))).json()).toEqual({
        scope: ROOT,
        stale: [],
        recommend: [],
        truncated: false,
      });
      const res = await routes.whatToChange(get(`/api/memory/facts/f/what-to-change?scope=%20${ENG}%20`), id("f"));
      expect(await res.json()).toEqual({ scope: ENG, recordId: "f", items: [], truncated: false });
      expect(await (await routes.edges(get(`/api/memory/facts/f/edges?scope=${ENG}`), id("f"))).json()).toEqual({
        scope: ENG,
        recordId: "f",
        outgoing: [],
        incoming: [],
        truncated: false,
      });
    });

    it("refuses a malformed scope with an audited 403 and reads nothing", async () => {
      await signIn(ADMIN);
      const res = await routes.stale(get(`/api/memory/scopes/stale?scope=${encodeURIComponent(`${ENG}..x`)}`));
      expect(res.status).toBe(403);
      const rows = await db.auditLog.findMany({ where: { orgId: ORG, actorId: ADMIN } });
      expect(rows.map((r) => r.decision)).toEqual(["deny"]);
    });

    it("answers 403 for a scope the caller cannot read", async () => {
      await signIn(READER);
      expect((await routes.stale(get(`/api/memory/scopes/stale?scope=${ENGX}`))).status).toBe(403);
      expect((await routes.edges(get(`/api/memory/facts/f/edges?scope=${ROOT}`), id("f"))).status).toBe(403);
    });

    it.each(["0", "21", "abc", "2.5", "-1", "", " 3", "1e1"])(
      "refuses limit=%j with a 400 and no read",
      async (limit) => {
        await signIn(READER);
        const res = await routes.stale(get(`/api/memory/scopes/stale?scope=${ENG}&limit=${encodeURIComponent(limit)}`));
        expect(res.status).toBe(400);
        expect(await db.auditLog.count({ where: { orgId: ORG, actorId: READER, action: "memory.read" } })).toBe(0);
      },
    );

    it("serves the report with its recommendation limit", async () => {
      await signIn(READER);
      for (const n of [1, 2, 3]) {
        await cite((await brief(`b${n}`, ENG, at(10))).id, `f${n}`, at(10));
        await event(`f${n}`, "delete", ENG, at(20 + n));
      }
      const body = await (await routes.stale(get(`/api/memory/scopes/stale?scope=${ENG}&limit=2`))).json();
      expect(body.stale).toHaveLength(3);
      expect(body.recommend.map((r: { recordId: string }) => r.recordId)).toEqual(["b3", "b2"]);
      expect(body.recommend[0].latest.reason).toEqual({ kind: "changed", at: at(23).toISOString(), op: "delete" });
    });
  });
});
