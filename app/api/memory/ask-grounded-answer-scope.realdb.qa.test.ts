// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Ask's grounded answer is built only from facts the caller may read.
//
// The grounding added for the fabricated-citation defect numbers every fact served in a
// turn and checks each sentence against them, so its guarantee is only as narrow as what
// was served. Here the fact that answers the question exists, but in a scope the caller
// holds no grant on, and in another organization. The model writes the answer citing it
// anyway: Ask must say it found nothing, and neither the cards it shows nor the search
// result it hands the model may hold that fact. With the same fact stored inside the
// caller's grant, the cited answer goes through, so the denial is a scope decision and not
// an answer Ask could never give.
//
// Real: Postgres, the route, check(), member grants, the guarded and hybrid stores and
// pgvector's SQL. Doubles: the session, the embedding service, the graph service (no
// facts) and the model, which searches and then writes what each test gives it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { seedMember } from "@/services/access/member.testsupport";
import { stubMemoryService, textEmbedding } from "@/tests/support/memory-service-double.testsupport";

const session = vi.hoisted(() => ({ current: null as unknown }));
/** Every search result the model was handed this turn. */
const handed = vi.hoisted(() => ({ results: [] as string[] }));

vi.mock("@/lib/access-context", () => ({ requireAccessContext: async () => session.current }));
vi.mock("@/services/memory/store", async () => {
  const { HybridMemoryStore } = await import("@/services/memory/hybrid-store");
  const { PgvectorMemoryStore } = await import("@/services/memory/pgvector-store");
  const graph = { retrieve: async () => ({ facts: [] }) };
  return { graphitiStore: graph, memory: new HybridMemoryStore(graph as never, new PgvectorMemoryStore()) };
});
vi.mock("@/lib/llm", () => {
  async function* stream(chunks: unknown[]) {
    for (const chunk of chunks) yield chunk;
  }
  return {
    LLM_MODEL_EXTRACT: "test-model",
    LLM_MODEL_ORCHESTRATOR: "test-model",
    createLLMClient: () => ({
      chat: {
        completions: {
          create: async (params: { messages: { role: string; content?: unknown }[] }) => {
            const toolResult = params.messages.find((m) => m.role === "tool");
            if (toolResult) {
              handed.results.push(String(toolResult.content));
              // A confident answer, citing the Bokaro card when it was handed one and the first
              // card otherwise, as the production model did.
              const line = String(toolResult.content)
                .split("\n")
                .find((l) => /^\[\d+\].*Bokaro/.test(l));
              const n = line ? /^\[(\d+)\]/.exec(line)![1] : "1";
              return stream([
                {
                  choices: [
                    {
                      delta: {
                        content: `The Bokaro Torromi release ships on November 5, 2026 [${n}]. It ships from the main line [${n}].`,
                      },
                    },
                  ],
                },
              ]);
            }
            const args = JSON.stringify({ query: QUESTION });
            return stream([
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        { index: 0, id: "call_search", function: { name: "search_memory", arguments: args } },
                      ],
                    },
                  },
                ],
              },
            ]);
          },
        },
      },
    }),
  };
});

const QUESTION = "When does the Bokaro Torromi release ship?";
const ANSWER_FACT = "The Bokaro Torromi release ships on November 5, 2026 from the main line.";
const UNRELATED = ["The release train leaves on Tuesday.", "Severity is currently ship-before-users at zero users."];

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "askgroundscopeqa";
const OTHER_ORG = "askgroundscopeqaother";
const ROOT = `org_${ORG}`;
const GRANTED = `${ROOT}.team_a`;
const UNGRANTED = `${ROOT}.team_b`;
const MEMBER = "askgroundscopeqa_member";

interface StreamEvent {
  type: string;
  text?: string;
  facts?: { fact: string }[];
}

describe.skipIf(!QA_URL)("Ask grounds its answer only in facts the caller may read", () => {
  let db: PrismaClient;
  let chatRoute: (typeof import("@/app/api/memory/chat/route"))["POST"];

  const store = async (id: string, orgId: string, scopePath: string, content: string) => {
    const vector = `[${textEmbedding(content).join(",")}]`;
    await db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","scopePath","embedding","createdAt")
      VALUES (${id}, ${orgId}, ${content}, 'text', 'human', ${scopePath}, ${vector}::vector, NOW())`;
  };

  const ask = async (scope?: string): Promise<StreamEvent[]> => {
    handed.results = [];
    const res = await chatRoute(
      new Request("http://t/api/memory/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: QUESTION, mode: "ask", disambiguated: true, ...(scope ? { scope } : {}) }),
      }),
    );
    return (await res.text())
      .split("\n\n")
      .filter((chunk) => chunk.startsWith("data: "))
      .map((chunk) => JSON.parse(chunk.slice(6)) as StreamEvent);
  };
  const answerOf = (events: StreamEvent[]) =>
    events
      .filter((e) => e.type === "delta")
      .map((e) => e.text)
      .join("");
  const cardsOf = (events: StreamEvent[]) =>
    events
      .filter((e) => e.type === "facts")
      .flatMap((e) => e.facts ?? [])
      .map((f) => f.fact);

  const cleanup = async () => {
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${orgId}`;
      await db.$executeRaw`DELETE FROM audit_log WHERE "orgId" = ${orgId}`;
      await db.org.deleteMany({ where: { id: orgId } });
    }
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
    stubMemoryService();
    ({ POST: chatRoute } = await import("@/app/api/memory/chat/route"));
  });

  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    await cleanup();
    await db.org.create({ data: { id: ORG, name: "Ask grounding scope QA" } });
    await db.org.create({ data: { id: OTHER_ORG, name: "Ask grounding scope QA other" } });
    for (const path of [ROOT, GRANTED, UNGRANTED]) await db.scope.create({ data: { orgId: ORG, path, name: path } });
    await db.scope.create({ data: { orgId: OTHER_ORG, path: `org_${OTHER_ORG}`, name: "other root" } });
    await seedMember(db, { orgId: ORG, userId: MEMBER });
    const granted = await db.scope.findFirstOrThrow({ where: { orgId: ORG, path: GRANTED } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: granted.id, granteeType: "user", granteeId: MEMBER, permission: "read" },
    });
    const ctx = { orgId: ORG, actor: { type: "human", id: MEMBER, role: "member" }, origin: "app" };
    session.current = {
      org: { id: ORG, name: "Ask grounding scope QA" },
      user: { id: MEMBER, role: "member", name: "Member", email: `${MEMBER}@member.test` },
      ctx,
    };

    for (const [i, text] of UNRELATED.entries()) await store(`askgroundscopeqa-unrelated-${i}`, ORG, GRANTED, text);
    // The answer exists, but only where this member may not read.
    await store("askgroundscopeqa-ungranted", ORG, UNGRANTED, ANSWER_FACT);
    await store("askgroundscopeqa-otherorg", OTHER_ORG, `org_${OTHER_ORG}`, ANSWER_FACT);
    // Another organization's row carrying this org's granted path: only the tenant filter,
    // not scope containment, keeps it out.
    await store("askgroundscopeqa-otherorg-samepath", OTHER_ORG, GRANTED, ANSWER_FACT);
  });

  it("says it found nothing when the answer is only outside the caller's grant", async () => {
    const events = await ask(GRANTED);

    expect(answerOf(events)).toBe(
      "I found nothing about this in your org's memory. The search returned 2 facts on other subjects, so none is cited.",
    );
    expect(cardsOf(events)).toEqual(expect.arrayContaining(UNRELATED));
    expect(cardsOf(events).some((card) => card.includes("Bokaro"))).toBe(false);
    expect(handed.results.join("\n")).not.toContain(ANSWER_FACT);
    expect(events.some((e) => e.type === "no_data")).toBe(true);
  });

  // Org-wide, a member granted one team cannot read the root, so the search is denied and
  // nothing is served. The answer must then cite nothing and state no date: the model never
  // saw a fact, from this org or another.
  it("serves nothing and cites nothing org-wide for a member granted one team", async () => {
    const events = await ask();

    const answer = answerOf(events);
    expect(cardsOf(events)).toEqual([]);
    expect(handed.results.join("\n")).not.toContain(ANSWER_FACT);
    expect(answer).not.toMatch(/\[\d+\]|November|2026/);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("sends the cited answer once the same fact is stored inside the caller's grant", async () => {
    await store("askgroundscopeqa-granted-answer", ORG, GRANTED, ANSWER_FACT);

    const events = await ask(GRANTED);

    // The cards are numbered as the model was handed them, and the answer citing the Bokaro
    // card goes through whole.
    const cards = cardsOf(events);
    const n = cards.findIndex((card) => card.includes("Bokaro")) + 1;
    expect(n).toBeGreaterThan(0);
    expect(cards.filter((card) => card.includes("Bokaro"))).toHaveLength(1);
    expect(handed.results.join("\n")).toContain(`[${n}] ${ANSWER_FACT}`);
    expect(answerOf(events)).toBe(
      `The Bokaro Torromi release ships on November 5, 2026 [${n}]. It ships from the main line [${n}].`,
    );
  });
});
