// A small, free retrieval fixture for two read-path rules: an extracted fact is served
// as its source chunk when the chunk is a candidate, and recency breaks the tie between
// versions of one fact on a page served in relevance order. It drives the real GuardedMemoryStore.retrieve(); the
// store fake returns what the hybrid store returns (graph facts in the graph's
// order, then vector hits by similarity), so the page selection, the vector reserve, the
// token budget and the served order are all the product's.
//
// The episodes are hand-built in the shape of two public benchmarks' failures, not
// samples of them: a clinic episode where a follow-up was rescheduled (stale over fresh)
// and where a chunk's paraphrases crowd the page (GateMem), and a long chat where a value
// was updated (BEAM knowledge update). The numbers they produce show the mechanism; they
// are not a forecast of either benchmark's score. Set RETRIEVAL_FIXTURE_REPORT=1 to print
// recall@k and the first gold rank per question.
import { describe, expect, it, vi } from "vitest";
vi.mock("@/services/memory/superseded-facts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/superseded-facts")>()),
  loadSupersededVersions: async () => ({ byId: new Map(), byText: new Map() }),
}));
// Graph facts here are stand-ins with no stored rows behind them, so the serve-time source
// check (services/memory/graph-fact-sources.ts) serves them as they are; it is proven against
// real rows in services/memory/graph-fact-sources.realdb.test.ts.
vi.mock("@/services/memory/graph-fact-sources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/graph-fact-sources")>()),
  loadGraphSources: async () => ({ supports: () => true }),
}));

vi.mock("@/services/access", async () => ({
  check: vi.fn().mockResolvedValue({ allowed: true }),
  recordReadFactIds: vi.fn(),
  pathCovers: (coveringPath: string, targetPath: string) =>
    targetPath === coveringPath || targetPath.startsWith(`${coveringPath}.`),
  descendantScopePaths: vi.fn().mockResolvedValue({ paths: [], unsearched: [], partial: false }),
  orgRootPath: vi.fn((orgId: string) => `org_${orgId}`),
  resolveExecutedPartition: (await vi.importActual<typeof import("@/services/access/check")>("@/services/access/check"))
    .resolveExecutedPartition,
  AccessDeniedError: class AccessDeniedError extends Error {},
}));

import { GuardedMemoryStore } from "./guarded-store";
import type { MemoryStore } from "./memory-store";
import type { MemoryFact } from "@/types/memory";
import type { AccessContext } from "@/services/access";

const ctx = { orgId: "org_1" } as AccessContext;

/** A stored chunk: raw text, dated by when it was written (benchmarks write in event order). */
interface Chunk {
  id: string;
  day: number;
  text: string;
  similarity: number;
  /** The information units this chunk states, by name. */
  states: string[];
}

/** An extracted graph fact, undated as the pilot's were, naming the chunk it came from. */
interface Extracted {
  id: string;
  from: string;
  text: string;
  states: string[];
}

interface Question {
  name: string;
  query: string;
  limit: number;
  /** Graph facts in the graph's own (relevance) order. */
  graph: Extracted[];
  chunks: Chunk[];
  /** Information units a correct answer needs. */
  gold: string[];
  /** Information units a correct answer must not lead with: the replaced value. */
  stale: string[];
  /**
   * Whether the harness names every write the same, so every chunk is a version of one
   * fact: GateMem names each write by its scope's label; BEAM names each pair apart.
   */
  oneSubject: boolean;
}

const dated = (day: number) => new Date(Date.UTC(2026, 2, 1 + day)).toISOString();

/** What each store returns, best first: graph facts in the graph's order, chunks by similarity. */
function storePages(q: Question): { graph: MemoryFact[]; vector: MemoryFact[] } {
  const graph: MemoryFact[] = q.graph.map((g) => ({
    uuid: g.id,
    fact: g.text,
    validAt: null,
    actorType: "agent",
    store: "graph",
    chunkIds: [g.from],
  }));
  const vector: MemoryFact[] = [...q.chunks]
    .sort((a, b) => b.similarity - a.similarity)
    .map((c) => ({
      uuid: c.id,
      fact: c.text,
      validAt: dated(c.day),
      actorType: "agent",
      store: "semantic",
      similarity: c.similarity,
      subject: q.oneSubject ? "episode label" : c.id,
    }));
  return { graph, vector };
}

/** The hybrid store's answer: each store cut at the asked limit, graph facts first, then vector hits. */
function storeFor({ graph, vector }: { graph: MemoryFact[]; vector: MemoryFact[] }): MemoryStore {
  return {
    retrieve: vi.fn().mockImplementation(async (input: { limit?: number }) => ({
      facts: [...graph.slice(0, input.limit), ...vector.slice(0, input.limit)],
      storesRead: [{ store: "graph" }, { store: "semantic" }],
    })),
  } as unknown as MemoryStore;
}

interface Score {
  recall: number;
  firstGoldRank: number | null;
  freshBeforeStale: boolean | null;
  servedLines: number;
}

function score(q: Question, served: MemoryFact[]): Score {
  const unitsOf = new Map<string, string[]>([
    ...q.chunks.map((c) => [c.id, c.states] as const),
    ...q.graph.map((g) => [g.id, g.states] as const),
  ]);
  const rankOf = (unit: string) => {
    const i = served.findIndex((f) => unitsOf.get(f.uuid)?.includes(unit));
    return i === -1 ? null : i + 1;
  };
  const goldRanks = q.gold.map(rankOf);
  const found = goldRanks.filter((r): r is number => r !== null);
  const staleRanks = q.stale.map(rankOf).filter((r): r is number => r !== null);
  const firstGoldRank = found.length ? Math.min(...found) : null;
  return {
    recall: found.length / q.gold.length,
    firstGoldRank,
    freshBeforeStale:
      q.stale.length === 0
        ? null
        : firstGoldRank !== null && (staleRanks.length === 0 || firstGoldRank < Math.min(...staleRanks)),
    servedLines: served.length,
  };
}

/** Background chunks and their paraphrases: other topics in the same episode. */
function background(prefix: string, topics: string[], firstDay: number, similarity: (i: number) => number) {
  const chunks: Chunk[] = topics.map((topic, i) => ({
    id: `${prefix}-c${i}`,
    day: firstDay + i,
    text: topic,
    similarity: similarity(i),
    states: [`${prefix}-${i}`],
  }));
  const graph: Extracted[] = topics.map((topic, i) => ({
    id: `${prefix}-g${i}`,
    from: `${prefix}-c${i}`,
    text: `Extracted: ${topic.split(".")[0]}`,
    states: [`${prefix}-${i}`],
  }));
  return { chunks, graph };
}

const CLINIC_TOPICS = [
  "Intake: knee pain for three weeks, referred to orthopedics.",
  "Insurance verified: the plan covers 80% of outpatient visits.",
  "Medication list: ibuprofen 400 mg as needed, no known allergies.",
  "Parking validation is available at the front desk.",
  "Imaging: X-ray of the left knee ordered, no fracture expected.",
  "Billing: copay of $35 collected at check-in.",
  "Pharmacy on file: Main Street pharmacy, refills by phone.",
  "Physical therapy referral sent, twice weekly for four weeks.",
  "Emergency contact: spouse, phone number on file.",
  "Interpreter not needed; preferred language English.",
  "Work note issued for two days of rest.",
  "Clinic hours: Monday to Friday, 8 AM to 5 PM.",
];

/** GateMem ckpt_06 shape: the follow-up was rescheduled; the graph only holds the old plan. */
function clinicFollowUp(): Question {
  const bg = background("clinic", CLINIC_TOPICS, 0, (i) => 0.42 - i * 0.01);
  return {
    name: "GateMem-like ckpt_06: rescheduled follow-up",
    query: "What is the patient's follow-up plan?",
    limit: 20,
    graph: [
      {
        id: "g-follow-up",
        from: "c-old-plan",
        text: "Patient has a follow-up appointment with Dr. Lee",
        states: ["old-plan"],
      },
      { id: "g-wednesday", from: "c-old-plan", text: "Follow-up appointment is on Wednesday", states: ["old-plan"] },
      ...bg.graph,
      {
        id: "g-orthopedics",
        from: "clinic-c0",
        text: "Patient was referred to orthopedics for follow-up care",
        states: ["clinic-0"],
      },
      {
        id: "g-therapy-plan",
        from: "clinic-c7",
        text: "Physical therapy is part of the treatment plan",
        states: ["clinic-7"],
      },
    ],
    chunks: [
      ...bg.chunks,
      {
        id: "c-old-plan",
        day: 3,
        text: "Follow-up scheduled Wednesday March 11 at 3:10 PM with Dr. Lee.",
        similarity: 0.62,
        states: ["old-plan"],
      },
      {
        id: "c-new-plan",
        day: 9,
        text: "Rescheduled at the patient's request: the follow-up moves from Wednesday March 11 to Friday March 13 at 9:00 AM with Dr. Lee.",
        similarity: 0.49,
        states: ["new-plan"],
      },
    ],
    gold: ["new-plan"],
    stale: ["old-plan"],
    oneSubject: true,
  };
}

/** GateMem ckpt_05 shape: the portal answer is one chunk whose paraphrases sit deep in the graph's order. */
function clinicPortal(): Question {
  const bg = background("clinic", CLINIC_TOPICS, 0, (i) => 0.44 - i * 0.01);
  return {
    name: "GateMem-like ckpt_05: portal facts ranked out",
    query: "What can the patient do in the patient portal?",
    limit: 10,
    graph: [
      ...bg.graph.slice(0, 9),
      {
        id: "g-portal-results",
        from: "c-portal",
        text: "Lab results appear in the portal after clinician release",
        states: ["portal-results"],
      },
      ...bg.graph.slice(9),
      {
        id: "g-portal-messages",
        from: "c-portal",
        text: "Portal messages are answered within two business days",
        states: ["portal-messages"],
      },
    ],
    chunks: [
      ...bg.chunks,
      {
        id: "c-portal",
        day: 2,
        text: "Patient portal: account created; lab results visible after clinician release; messages answered within 2 business days; refill requests accepted.",
        similarity: 0.46,
        states: ["portal-account", "portal-results", "portal-messages", "portal-refills"],
      },
    ],
    gold: ["portal-account", "portal-results", "portal-messages", "portal-refills"],
    stale: [],
    oneSubject: true,
  };
}

const CHAT_TOPICS = Array.from(
  { length: 24 },
  (_, i) =>
    `Session ${i + 1}: talked about ${["recipes", "a work deadline", "sleep", "a trip to Lisbon", "a new laptop", "stretching"][i % 6]}.`,
);

/** BEAM knowledge-update shape: weekly mileage went from 20 to 35, both stored, both retrieved. */
function chatMileage(): Question {
  const bg = background("chat", CHAT_TOPICS, 0, (i) => 0.4 - (i % 7) * 0.02);
  return {
    name: "BEAM-like KU: weekly mileage updated",
    query: "How many miles am I running per week now?",
    limit: 10,
    graph: [
      { id: "g-miles-20", from: "c-miles-20", text: "User runs 20 miles per week", states: ["miles-20"] },
      ...bg.graph.slice(0, 3),
      { id: "g-miles-35", from: "c-miles-35", text: "User's weekly mileage is 35 miles", states: ["miles-35"] },
      ...bg.graph.slice(3),
    ],
    chunks: [
      ...bg.chunks,
      {
        id: "c-miles-20",
        day: 3,
        text: "I'm training for a half marathon, running about 20 miles a week.",
        similarity: 0.71,
        states: ["miles-20"],
      },
      {
        id: "c-miles-35",
        day: 21,
        text: "Update: I bumped my weekly mileage up to 35 since the race is close.",
        similarity: 0.58,
        states: ["miles-35"],
      },
    ],
    gold: ["miles-35"],
    stale: ["miles-20"],
    oneSubject: false,
  };
}

/** BEAM knowledge-update shape this change does not reach: the update ranks last in both stores. */
function chatAddressRankedOut(): Question {
  const bg = background("chat", CHAT_TOPICS, 0, (i) => 0.62 - (i % 7) * 0.01);
  return {
    name: "BEAM-like KU: update ranked out (not addressed here)",
    query: "Where do I live now?",
    limit: 10,
    graph: [
      { id: "g-denver", from: "c-denver", text: "User lives in Denver", states: ["denver"] },
      ...bg.graph,
      { id: "g-austin", from: "c-austin", text: "User moved to Austin", states: ["austin"] },
    ],
    chunks: [
      ...bg.chunks,
      { id: "c-denver", day: 2, text: "I live in Denver with my two cats.", similarity: 0.66, states: ["denver"] },
      {
        id: "c-austin",
        day: 20,
        text: "Big news, the move is done, unpacking boxes in Austin all week.",
        similarity: 0.31,
        states: ["austin"],
      },
    ],
    gold: ["austin"],
    stale: ["denver"],
    oneSubject: false,
  };
}

async function run(q: Question): Promise<Score> {
  const store = new GuardedMemoryStore(storeFor(storePages(q)));
  const { facts } = await store.retrieve(ctx, { groupId: "org_1", query: q.query, limit: q.limit });
  return score(q, facts);
}

describe("retrieval fixture: collapse into source chunks, newest first within a tier", () => {
  it("scores each question", async () => {
    const questions = [clinicFollowUp(), clinicPortal(), chatMileage(), chatAddressRankedOut()];
    const scores = await Promise.all(questions.map(run));
    if (process.env.RETRIEVAL_FIXTURE_REPORT === "1") {
      console.log(
        ["| question | k | recall@k | first gold rank | fresh before stale |", "|---|---|---|---|---|"]
          .concat(
            questions.map(
              (q, i) =>
                `| ${q.name} | ${q.limit} | ${scores[i].recall.toFixed(2)} | ${scores[i].firstGoldRank ?? "absent"} | ${scores[i].freshBeforeStale ?? "n/a"} |`,
            ),
          )
          .join("\n"),
      );
    }
    const [followUp, portal, mileage, rankedOut] = scores;

    expect(followUp).toMatchObject({ recall: 1, freshBeforeStale: true });
    expect(portal.recall).toBe(1);
    // BEAM names every pair apart, so the two answers are different facts and relevance
    // keeps its order: the update is served, behind the better-matching old value.
    expect(mileage).toMatchObject({ recall: 1, freshBeforeStale: false });
    // Out of reach for this change: the update ranks below the page cut in both stores.
    expect(rankedOut.recall).toBe(0);
  });
});
