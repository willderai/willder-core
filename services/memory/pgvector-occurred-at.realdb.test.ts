// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A stored chunk's event time, on a real database. A write that says when its content
// happened (IngestInput.occurredAt) is stored with that instant, never later than the
// moment it is written, and served with it as its date; a write that says nothing is
// served with its store time, as before. A post-dated note therefore cannot be served as
// newer than a write that came after it. Erasure
// still judges a chunk by when it was stored, never by the time its writer claims: a
// writer cannot date content past an erasure to bring it back, nor before one to have it
// hidden. Only the embedding HTTP call is stubbed. The session time zone is set west of
// UTC so an offset slip in the `timestamp without time zone` column would show.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { IngestInput } from "@/types/memory";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "occurredat";
const ROOT = `org_${ORG}`;
const EMBEDDING = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));

function write(content: string, occurredAt?: string): IngestInput {
  return {
    groupId: ORG,
    content,
    actorType: "agent",
    actorId: "writer",
    origin: "mcp",
    scopePath: ROOT,
    ...(occurredAt === undefined ? {} : { occurredAt }),
  };
}

describe.skipIf(!QA_URL)("a chunk's event time on a real database", () => {
  let db: PrismaClient;
  let PgvectorMemoryStore: (typeof import("./pgvector-store"))["PgvectorMemoryStore"];

  const served = async (id: string) => {
    const { facts } = await new PgvectorMemoryStore().retrieve({
      groupId: ORG,
      tenantId: ORG,
      query: "q",
      scopePath: ROOT,
      includeUntagged: true,
    });
    return facts.find((f) => f.uuid === id);
  };
  const servedDate = async (id: string) => (await served(id))?.validAt;
  const storedAt = async (id: string) =>
    (await db.memoryChunk.findUniqueOrThrow({ where: { id }, select: { createdAt: true } })).createdAt.toISOString();

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    const url = new URL(QA_URL!);
    url.searchParams.set("options", "-c TimeZone=America/Los_Angeles");
    process.env.DATABASE_URL = url.toString();
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ PgvectorMemoryStore } = await import("./pgvector-store"));
  });

  beforeEach(async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ embedding: EMBEDDING }), { status: 200 })),
    );
    await db.memoryChunk.deleteMany({ where: { orgId: ORG } });
    await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await db.memoryChunk.deleteMany({ where: { orgId: ORG } });
    await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
    await db.$disconnect();
  });

  it("stores the writer's event time and serves it as the chunk's date", async () => {
    const { episodeId } = await new PgvectorMemoryStore().ingest(
      write("Follow-up moved to Friday", "2026-03-13T08:00:00-07:00"),
    );

    expect(await servedDate(episodeId)).toBe("2026-03-13T15:00:00.000Z");
    expect((await served(episodeId))?.validAtSource).toBe("occurred");
    const row = await db.memoryChunk.findUniqueOrThrow({ where: { id: episodeId }, select: { occurredAt: true } });
    expect(row.occurredAt?.toISOString()).toBe("2026-03-13T15:00:00.000Z");
  });

  it("stores the event time through the write-once path memory_ingest uses", async () => {
    const { episodeId } = await new PgvectorMemoryStore().ingestOnce({
      ...write("Portal access enabled", "2026-02-01"),
      name: "Portal",
    });

    expect(await servedDate(episodeId)).toBe("2026-02-01T00:00:00.000Z");
  });

  it("serves a write that gives no event time with its store time, as before the column existed", async () => {
    const { episodeId } = await new PgvectorMemoryStore().ingest(write("Release moved to Friday"));

    expect(await servedDate(episodeId)).toBe(await storedAt(episodeId));
    expect((await served(episodeId))?.validAtSource).toBe("stored");
  });

  it("stores no event time for a value that is not a date, and serves the store time", async () => {
    const { episodeId } = await new PgvectorMemoryStore().ingest(write("Garbled date", "not a date"));

    expect(await servedDate(episodeId)).toBe(await storedAt(episodeId));
  });

  it("clamps a post-dated event time to the moment the row is written", async () => {
    const ahead = new Date(Date.now() + 4 * 60_000).toISOString();
    const { episodeId } = await new PgvectorMemoryStore().ingest(write("Post-dated note", ahead));

    expect(await servedDate(episodeId)).toBe(await storedAt(episodeId));
  });

  it("never serves a post-dated note as newer than a write that came after it", async () => {
    const early = await new PgvectorMemoryStore().ingest(
      write("Written first, dated ahead", new Date(Date.now() + 4 * 60_000).toISOString()),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const later = await new PgvectorMemoryStore().ingest(write("Written second, undated"));

    expect(Date.parse((await servedDate(later.episodeId))!)).toBeGreaterThan(
      Date.parse((await servedDate(early.episodeId))!),
    );
  });

  it("keeps a backdated event time as given", async () => {
    const { episodeId } = await new PgvectorMemoryStore().ingest(
      write("Imported from last year", "2025-04-01T09:30:00Z"),
    );

    expect(await servedDate(episodeId)).toBe("2025-04-01T09:30:00.000Z");
  });

  it("does not date a row by the graph's reference time: only occurredAt fills the column", async () => {
    const { episodeId } = await new PgvectorMemoryStore().ingest({
      ...write("Synced message"),
      referenceTime: "2024-01-01T00:00:00Z",
    });

    expect(await servedDate(episodeId)).toBe(await storedAt(episodeId));
  });

  it("keeps erasure on store time: content stored before an erasure stays hidden whatever date its writer gave it", async () => {
    const { episodeId } = await new PgvectorMemoryStore().ingest(
      write("Dana Whitfield asked to move the renewal call", new Date(Date.now() + 60_000).toISOString()),
    );
    const { recordSuppressions } = await import("./erasure-suppression");
    await recordSuppressions(db, ORG, "occurred-at-erasure", { emails: [], names: ["Dana Whitfield"], contactIds: [] });

    expect(await servedDate(episodeId)).toBeUndefined();
  });

  it("keeps erasure on store time: content stored after an erasure is served even when dated before it", async () => {
    const { recordSuppressions } = await import("./erasure-suppression");
    await recordSuppressions(db, ORG, "occurred-at-erasure", { emails: [], names: ["Dana Whitfield"], contactIds: [] });
    // Suppression rows are stamped at millisecond precision; store strictly after.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const { episodeId } = await new PgvectorMemoryStore().ingest(
      write("Dana Whitfield rejoined as a new contact", "2020-01-01"),
    );

    expect(await servedDate(episodeId)).toBe("2020-01-01T00:00:00.000Z");
  });
});
