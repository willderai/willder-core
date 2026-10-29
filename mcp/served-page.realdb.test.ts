// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The page memory_query serves when the graph holds a verbatim copy of a stored write and
// facts extracted from it. Everything below the checked read is real except the graph
// store and the embedding service: check() runs against a live capability, the hybrid
// store routes the read, pgvector's scoped SQL runs on Postgres, and the lines are
// rendered by formatCitedFacts against the same database.
//
// The rules under test: a page never repeats a stored write (its graph copy and its
// paraphrases are served as the write itself), and no line is dated later than the stored
// writes it came from, however late the graph extracted it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import type { MemoryStore } from "@/services/memory/memory-store";
import type { MemoryFact } from "@/types/memory";

vi.mock("@/services/memory/store", () => ({ memory: {} }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "servedpage";
const ROOT = `org_${ORG}`;
const SCHEDULE = `${ROOT}.schedule`;
const DIMENSIONS = 384;
const QUERY_VECTOR = `[${[1, ...Array(DIMENSIONS - 1).fill(0)].join(",")}]`;

/** When the graph extracted everything below: long after the turns it read. */
const GRAPH_CLOCK = "2026-10-12T06:59:29.127960+00:00";

const BOOKED =
  "[t063 2026-03-03T11:21] Jules (scheduler): Imaging is booked for Monday, March 9 at 9:00 AM in Suite 2.";
const MOVED =
  "[t080 2026-03-05T10:02] Jules (scheduler): Monday's 9:00 AM slot is canceled; imaging moved to Friday, March 6 at 11:20 AM.";
const BOOKED_AT = "2026-03-03T11:21:00.000Z";
const MOVED_AT = "2026-03-05T10:02:00.000Z";

function graphFact(
  uuid: string,
  fact: string,
  chunkIds: string[],
  actorType: MemoryFact["actorType"] = "agent",
): MemoryFact {
  return { uuid, fact, validAt: GRAPH_CLOCK, actorType, store: "graph", chunkIds };
}

/** What the graph returns for the schedule scope: a verbatim copy of the booking, what it extracted from it, and one fact two writes assert. */
const GRAPH_FACTS: MemoryFact[] = [
  graphFact("g-booked-verbatim", BOOKED, ["c-booked"]),
  graphFact("g-booked-paraphrase", "The imaging appointment is scheduled for Monday, March 9 at 9:00 AM.", [
    "c-booked",
  ]),
  graphFact("g-booked-seed", "Suite 2: the imaging room the scan is booked in.", ["c-booked"], "extraction"),
  graphFact("g-both", "Imaging for the patient is handled by Jules.", ["c-booked", "c-moved"]),
];

describe.skipIf(!QA_URL)("the page memory_query serves from a graph copy and its paraphrases, on a real read", () => {
  let db: PrismaClient;
  let GuardedMemoryStore: (typeof import("@/services/memory/guarded-store"))["GuardedMemoryStore"];
  let HybridMemoryStore: (typeof import("@/services/memory/hybrid-store"))["HybridMemoryStore"];
  let PgvectorMemoryStore: (typeof import("@/services/memory/pgvector-store"))["PgvectorMemoryStore"];
  let formatCitedFacts: (typeof import("./fact-citation"))["formatCitedFacts"];

  const graph = {
    retrieve: vi.fn(async (input: { groupId: string }) => ({
      facts: input.groupId.endsWith(".schedule") ? GRAPH_FACTS : [],
      storesRead: [{ store: "graph" as const }],
    })),
  } as unknown as MemoryStore;

  const insertChunk = (id: string, content: string, occurredAt: string) =>
    db.$executeRawUnsafe(
      `INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorName","scopePath","embedding","occurredAt","createdAt")
       VALUES ($1, $2, $3, 'text', 'agent', 'recorder', $4, $5::vector, $6::timestamp, (NOW() AT TIME ZONE 'UTC'))`,
      id,
      ORG,
      content,
      SCHEDULE,
      QUERY_VECTOR,
      occurredAt.replace("Z", ""),
    );

  async function scheduleReader(): Promise<AccessContext> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: "scheduler-reader",
        tokenHash: hashCapabilityToken(token),
        scopePath: SCHEDULE,
        permission: "read",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return { orgId: ORG, actor: { type: "agent", id: "scheduler-reader", capabilityToken: token }, origin: "mcp" };
  }

  /** The lines memory_query would answer with, read through the guarded hybrid store. */
  async function servedLines(): Promise<string[]> {
    const reader = new GuardedMemoryStore(
      new HybridMemoryStore(graph, new PgvectorMemoryStore()),
      async () => "enterprise",
    );
    const { facts } = await reader.retrieve(
      await scheduleReader(),
      { groupId: ORG, query: "when is imaging", limit: 20 },
      SCHEDULE,
    );
    return (await formatCitedFacts(ORG, facts)).split("\n");
  }

  async function clear() {
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
  }

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GuardedMemoryStore } = await import("@/services/memory/guarded-store"));
    ({ HybridMemoryStore } = await import("@/services/memory/hybrid-store"));
    ({ PgvectorMemoryStore } = await import("@/services/memory/pgvector-store"));
    ({ formatCitedFacts } = await import("./fact-citation"));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await clear();
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ embedding: [1, ...Array(DIMENSIONS - 1).fill(0)] }), { status: 200 }),
      ),
    );
    await clear();
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    for (const path of [ROOT, SCHEDULE]) await db.scope.create({ data: { orgId: ORG, path, name: path } });
    await insertChunk("c-booked", BOOKED, BOOKED_AT);
    await insertChunk("c-moved", MOVED, MOVED_AT);
  });

  it("serves a stored write once: not beside its graph copy, its paraphrase, or the entity seeded from it", async () => {
    const lines = await servedLines();

    const naming = (text: string) => lines.filter((l) => l.includes(text));
    expect(naming("booked for Monday, March 9")).toHaveLength(1);
    expect(naming("· version c-booked")).toEqual([
      `• ${BOOKED} (as of ${BOOKED_AT}) — from: recorder (agent) · version c-booked`,
    ]);
    expect(naming("scheduled for Monday")).toEqual([]);
    expect(naming("Suite 2: the imaging room")).toEqual([]);
    // A fact two writes assert says what neither says alone, so it stays.
    expect(naming("handled by Jules")).toHaveLength(1);
    expect(lines).toHaveLength(3);
  });

  it("dates every line by the writes it came from, never by when the graph extracted it", async () => {
    const lines = await servedLines();

    expect(lines.join("\n")).not.toContain(GRAPH_CLOCK);
    expect(lines.find((l) => l.includes("handled by Jules"))).toContain(`(as of ${MOVED_AT})`);
    expect(lines.find((l) => l.includes("slot is canceled"))).toContain(`(as of ${MOVED_AT})`);
  });
});
