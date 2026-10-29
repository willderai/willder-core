// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A relation whose record reads as erased answers
// exactly like one never recorded, in the list and in `truncated`. Each test builds the
// state a person erasure leaves behind (the version's row gone, its announcement blanked,
// its id on the suppression list, the edge row still there), reads, then deletes the
// erased relations outright and reads again: the two answers must match. When erased rows
// fill the 500-row bound, a first read that said `truncated: true` and listed fewer rows
// would tell a reader that erased records exist and roughly how many.
//
// Set QA_DATABASE_URL to an ISOLATED test database, never the inherited DATABASE_URL.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";
import { seedMember } from "@/services/access/member.testsupport";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

const QA_URL = process.env.QA_DATABASE_URL;
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ORG = `depsqaerased${RUN}`;
const ROOT = `org_${ORG}`;
const ENG = `${ROOT}.eng`;
const READER = `u-depsqaerased-reader-${RUN}`;
/** MAX_ROWS_PER_QUERY (dependencies.ts), needed before the module is imported in beforeAll. */
const BOUND = 500;

const T0 = new Date(Date.UTC(2026, 9, 16, 10, 0, 0));
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const reader = (): AccessContext => ({
  orgId: ORG,
  actor: { type: "human", id: READER, role: "member" },
  origin: "app",
});

describe.skipIf(!QA_URL)("dependency graph: an erased relation answers like one never recorded", () => {
  let db: PrismaClient;
  let deps: typeof import("./dependencies");
  let recordErasedVersions: (typeof import("./erasure-suppression"))["recordErasedVersions"];
  let seq = 0;

  /** Live fact versions stored in ENG, each resting on `toId`, recorded at minute `minute`. */
  async function liveDependents(prefix: string, count: number, toId: string, minute: number) {
    const ids = Array.from({ length: count }, (_, i) => `${prefix}-${i}`);
    await db.memoryChunk.createMany({
      data: ids.map((id) => ({
        id,
        orgId: ORG,
        content: `content ${id}`,
        scopePath: ENG,
        createdAt: at(0),
        factVersion: true,
      })),
    });
    await db.factEdge.createMany({
      data: ids.map((fromId) => ({
        orgId: ORG,
        fromId,
        toId,
        kind: "dependsOn" as const,
        scopePath: ENG,
        actorType: "agent" as const,
        actorId: "a",
        createdAt: at(minute),
      })),
    });
    return ids;
  }

  /** What an erasure leaves of `count` versions resting on `toId`: a blank announcement, a suppressed id, the edge row. */
  async function erasedDependents(prefix: string, count: number, toId: string, minute: number) {
    const ids = Array.from({ length: count }, (_, i) => `${prefix}-${i}`);
    await db.changeEvent.createMany({
      data: ids.map((recordId) => ({
        orgId: ORG,
        seq: BigInt(++seq),
        scopePath: ENG,
        recordType: "fact",
        recordId,
        op: "create" as const,
        actorId: "a",
        summary: "",
        createdAt: at(0),
      })),
    });
    await db.factEdge.createMany({
      data: ids.map((fromId) => ({
        orgId: ORG,
        fromId,
        toId,
        kind: "dependsOn" as const,
        scopePath: ENG,
        actorType: "agent" as const,
        actorId: "a",
        createdAt: at(minute),
      })),
    });
    await db.$transaction((tx) => recordErasedVersions(tx, ORG, `req-${prefix}`, ids));
    return ids;
  }

  /** The same org as if the erased versions had never been written. */
  async function forgetEntirely(ids: string[]) {
    await db.factEdge.deleteMany({ where: { orgId: ORG, fromId: { in: ids } } });
    await db.changeEvent.deleteMany({ where: { orgId: ORG, recordId: { in: ids } } });
    await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    deps = await import("./dependencies");
    ({ recordErasedVersions } = await import("./erasure-suppression"));
    expect(deps.MAX_ROWS_PER_QUERY).toBe(BOUND);
    await db.org.create({ data: { id: ORG, name: ORG } });
    const scopes = new Map<string, string>();
    for (const path of [ROOT, ENG])
      scopes.set(path, (await db.scope.create({ data: { orgId: ORG, path, name: path } })).id);
    await seedMember(db, { orgId: ORG, userId: READER });
    await db.grant.create({
      data: { orgId: ORG, scopeId: scopes.get(ENG)!, granteeType: "user", granteeId: READER, permission: "read" },
    });
  });

  beforeEach(async () => {
    await db.factEdge.deleteMany({ where: { orgId: ORG } });
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.memoryChunk.deleteMany({ where: { orgId: ORG } });
    await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
  });

  afterAll(async () => {
    if (!QA_URL) return;
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
    await db.user.deleteMany({ where: { id: READER } });
    await db.$disconnect();
  });

  it("edgesOf: more than 500 erased dependents do not hide a live one or set truncated", async () => {
    await db.memoryChunk.create({
      data: { id: "f-src", orgId: ORG, content: "src", scopePath: ENG, createdAt: at(0), factVersion: true },
    });
    await liveDependents("r-live", 1, "f-src", 2);
    const gone = await erasedDependents("r-gone", BOUND + 1, "f-src", 3);

    const afterErasure = await deps.edgesOf(reader(), "f-src", ENG);
    await forgetEntirely(gone);
    const neverWritten = await deps.edgesOf(reader(), "f-src", ENG);

    expect(neverWritten.incoming.map((e) => e.fromId)).toEqual(["r-live-0"]);
    expect(neverWritten.truncated).toBe(false);
    expect(afterErasure).toEqual(neverWritten);
  });

  it("edgesOf: erased dependents ahead of exactly 500 live ones are not counted, so the list does not shrink below the bound", async () => {
    await db.memoryChunk.create({
      data: { id: "f-src", orgId: ORG, content: "src", scopePath: ENG, createdAt: at(0), factVersion: true },
    });
    await liveDependents("r-live", BOUND, "f-src", 2);
    const gone = await erasedDependents("r-gone", 20, "f-src", 3);

    const afterErasure = await deps.edgesOf(reader(), "f-src", ENG);
    await forgetEntirely(gone);
    const neverWritten = await deps.edgesOf(reader(), "f-src", ENG);

    expect(neverWritten.incoming).toHaveLength(BOUND);
    expect(neverWritten.truncated).toBe(false);
    // Counting erased versions would list 480 with truncated true: 20 erased versions shown to the reader.
    expect({ listed: afterErasure.incoming.length, truncated: afterErasure.truncated }).toEqual({
      listed: BOUND,
      truncated: false,
    });
  });

  it("whatToChange: more than 500 erased dependents do not hide a live one or set truncated", async () => {
    await db.memoryChunk.create({
      data: { id: "f-src", orgId: ORG, content: "src", scopePath: ENG, createdAt: at(0), factVersion: true },
    });
    await liveDependents("r-live", 1, "f-src", 2);
    const gone = await erasedDependents("r-gone", BOUND + 1, "f-src", 3);

    const afterErasure = await deps.whatToChange(reader(), "f-src", ENG);
    await forgetEntirely(gone);
    const neverWritten = await deps.whatToChange(reader(), "f-src", ENG);

    expect(neverWritten).toEqual({
      items: [expect.objectContaining({ recordId: "r-live-0", distance: 1 })],
      truncated: false,
    });
    expect(afterErasure).toEqual(neverWritten);
  });

  it("staleReport: more than 500 erased stale dependents do not hide a live one or set truncated", async () => {
    await db.memoryChunk.create({
      data: { id: "f-src", orgId: ORG, content: "src", scopePath: ENG, createdAt: at(0), factVersion: true },
    });
    await liveDependents("r-live", 1, "f-src", 2);
    const gone = await erasedDependents("r-gone", BOUND + 1, "f-src", 3);
    await db.changeEvent.create({
      data: {
        orgId: ORG,
        seq: BigInt(++seq),
        scopePath: ENG,
        recordType: "fact",
        recordId: "f-src",
        op: "update",
        actorId: "a",
        summary: "s",
        createdAt: at(10),
      },
    });

    const afterErasure = await deps.staleReport(reader(), ENG);
    await forgetEntirely(gone);
    const neverWritten = await deps.staleReport(reader(), ENG);

    expect(neverWritten.stale.map((s) => s.recordId)).toEqual(["r-live-0"]);
    expect(neverWritten.truncated).toBe(false);
    expect(afterErasure).toEqual(neverWritten);
  });
});
