// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The passage backfill (services/memory/passage-backfill.ts) against real
// Postgres: it gives every long row stored before passages existed the passages an
// ingest would have written, never touches a short row or one that has them, can be
// stopped and rerun, survives a row deleted under it, and paces its embedding calls.
// The embedding service is a stub that counts its calls.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "passbackfill";
const OTHER_ORG = "passbackfill2";
const DIMENSIONS = 384;
const unit = `[${[1, ...Array(DIMENSIONS - 1).fill(0)].join(",")}]`;

/** About 4,000 characters: several passages. */
const LONG = Array.from({ length: 70 }, (_, i) => `Line ${i} of a long transcript, kept for the record.`).join(" ");

describe.skipIf(!QA_URL)("backfillPassages, real Postgres", () => {
  let db: PrismaClient;
  let backfillPassages: (typeof import("./passage-backfill"))["backfillPassages"];
  let BYTES_PER_PASSAGE: number;
  let splitPassages: (typeof import("./passages"))["splitPassages"];
  let embedCalls: number;
  let onEmbed: (() => Promise<void>) | null;

  /** A row as an ingest before passages stored it: its own embedding, no passages. */
  const legacyRow = (id: string, content: string, orgId = ORG) => db.$executeRaw`
    INSERT INTO memory_chunks ("id","orgId","content","source","actorType","embedding","createdAt")
    VALUES (${id}, ${orgId}, ${content}, 'text', 'human', ${unit}::vector, NOW())
  `;

  const passages = async () =>
    db.$queryRaw<{ chunkId: string; n: number }[]>`
      SELECT p."chunkId", COUNT(*)::int AS n FROM memory_chunk_passages p
      JOIN memory_chunks c ON c.id = p."chunkId" WHERE c."orgId" IN (${ORG}, ${OTHER_ORG})
      GROUP BY p."chunkId" ORDER BY p."chunkId"
    `;

  const options = { log: () => {}, sleep: async () => {} };

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ backfillPassages, BYTES_PER_PASSAGE } = await import("./passage-backfill"));
    ({ splitPassages } = await import("./passages"));
    for (const id of [ORG, OTHER_ORG]) await db.org.upsert({ where: { id }, update: {}, create: { id, name: id } });
  });

  beforeEach(async () => {
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" IN (${ORG}, ${OTHER_ORG})`;
    embedCalls = 0;
    onEmbed = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        embedCalls++;
        await onEmbed?.();
        const { texts } = JSON.parse(init.body) as { texts: string[] };
        return new Response(JSON.stringify({ embeddings: texts.map(() => Array(DIMENSIONS).fill(0.05)) }), {
          status: 200,
        });
      }),
    );
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (!db) return;
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" IN (${ORG}, ${OTHER_ORG})`;
    await db.$disconnect();
  });

  it("counts on a dry run and writes nothing", async () => {
    await legacyRow("a", LONG);
    await legacyRow("short", "A short fact.");

    const summary = await backfillPassages(db, { apply: false, orgId: ORG, ...options });

    expect(summary).toMatchObject({ apply: false, rowsNeedingPassages: 1, passagesWritten: 0, rowsFilled: 0 });
    expect(summary.passagesPlanned).toBe(splitPassages(LONG).length);
    expect(summary.estimatedStorageBytes).toBe(summary.passagesPlanned * BYTES_PER_PASSAGE);
    expect(embedCalls).toBe(0);
    expect(await passages()).toEqual([]);
  });

  it("gives each long row the passages an ingest writes, and a rerun changes nothing", async () => {
    await legacyRow("a", LONG);
    await legacyRow("b", `${LONG} And one more line.`);
    await legacyRow("short", "A short fact.");
    const expected = splitPassages(LONG).length;

    const first = await backfillPassages(db, { apply: true, orgId: ORG, ...options });
    expect(first).toMatchObject({ rowsFilled: 2, passagesWritten: expected * 2 });
    expect(await passages()).toEqual([
      { chunkId: "a", n: expected },
      { chunkId: "b", n: expected },
    ]);
    const stored = await db.$queryRaw<{ ordinal: number }[]>`
      SELECT ordinal FROM memory_chunk_passages WHERE "chunkId" = 'a' ORDER BY ordinal
    `;
    expect(stored).toEqual(splitPassages(LONG).map((_, ordinal) => ({ ordinal })));

    embedCalls = 0;
    const second = await backfillPassages(db, { apply: true, orgId: ORG, ...options });
    expect(second).toMatchObject({ rowsNeedingPassages: 0, rowsFilled: 0, passagesWritten: 0 });
    expect(embedCalls).toBe(0);
  });

  it("stops after maxRows and a rerun finishes the rest", async () => {
    for (const id of ["a", "b", "c"]) await legacyRow(id, LONG);

    expect(await backfillPassages(db, { apply: true, orgId: ORG, maxRows: 1, ...options })).toMatchObject({
      rowsFilled: 1,
      lastRowId: "a",
    });
    expect(await backfillPassages(db, { apply: true, orgId: ORG, ...options })).toMatchObject({
      rowsFilled: 2,
      lastRowId: "c",
    });
    expect((await passages()).map((p) => p.chunkId)).toEqual(["a", "b", "c"]);
  });

  it("skips a row deleted while its passages were being embedded, and carries on", async () => {
    await legacyRow("a", LONG);
    await legacyRow("b", LONG);
    onEmbed = async () => {
      onEmbed = null;
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG} AND id = 'a'`;
    };

    const summary = await backfillPassages(db, { apply: true, orgId: ORG, ...options });

    expect(summary).toMatchObject({ rowsFilled: 1, rowsGone: 1 });
    expect(await passages()).toEqual([{ chunkId: "b", n: splitPassages(LONG).length }]);
  });

  it("only reads the org it is given", async () => {
    await legacyRow("mine", LONG);
    await legacyRow("theirs", LONG, OTHER_ORG);

    await backfillPassages(db, { apply: true, orgId: ORG, ...options });

    expect((await passages()).map((p) => p.chunkId)).toEqual(["mine"]);
  });

  it("waits between rows so embeddings stay under the rate it is given", async () => {
    for (const id of ["a", "b"]) await legacyRow(id, LONG);
    let clock = 0;
    const waits: number[] = [];

    await backfillPassages(db, {
      apply: true,
      orgId: ORG,
      maxEmbeddingsPerSecond: 2,
      log: () => {},
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });

    // Each row's passage embeddings, at two a second, take half a second each.
    const perRow = (splitPassages(LONG).length / 2) * 1_000;
    expect(waits).toEqual([perRow, perRow]);
  });
});
