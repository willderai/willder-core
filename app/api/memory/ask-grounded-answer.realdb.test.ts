// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Ask never sends a cited answer its served facts do not support.
//
// An organization-wide ask whose memory held nothing about the question was answered
// "The Bokaro Torromi release ship is scheduled to leave on November 5, 2023 [1].", citing a
// fact about something else, with the date taken from a third. Here the store holds only
// unrelated facts and the model writes exactly that answer: Ask must say it found nothing
// and cite nothing. With the fact that answers it stored too, the cited answer goes through.
//
// Real: Postgres, the route, check(), the guarded and hybrid stores, pgvector's SQL, and the
// grounding (services/memory/answer-grounding.ts).
// Doubles: the signed-in session; the embedding service, by a deterministic text embedding;
// the graph service, which answers with no facts; and the model, which searches and then
// writes what each test gives it, citing by the numbers in the search result it was handed.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { stubMemoryService, textEmbedding } from "@/tests/support/memory-service-double.testsupport";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

/** The signed-in person the route sees. */
const session = vi.hoisted(() => ({ current: null as unknown }));
/** What the model writes after its search, given the search result it was handed. */
const model = vi.hoisted(() => ({ answer: (_toolResult: string): string => "" }));

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
            if (toolResult)
              return stream([{ choices: [{ delta: { content: model.answer(String(toolResult.content)) } }] }]);
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
const ANSWER_FACT = "Seeded test record 8196: the Bokaro Torromi release ships on day 18 of the cycle.";
const UNRELATED = [
  "severity is currently ship-before-users at zero users.",
  "Root files that ship are in every set.",
  "the release train leaves on Tuesday",
  "Date: November-05-2023\nUSER: Sounds good! I'll send her that message and see what she says.\n\nASSISTANT: Good luck, and I hope you both enjoy the book club together!",
  "The release train leaves on Wednesday.",
];
/** The answer Ask gave on 2026-10-12, citing the first fact it was handed. */
const MADE_UP = "The Bokaro Torromi release ship is scheduled to leave on November 5, 2023 [1].";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "askgroundedanswer";
const ROOT = `org_${ORG}`;

/** The number the search result handed to the model gave the line holding `text`. */
function numberOf(toolResult: string, text: string): number {
  const line = toolResult.split("\n").find((l) => l.includes(text));
  if (!line) throw new Error(`the search result did not hold "${text}":\n${toolResult}`);
  return Number(/^\[(\d+)\]/.exec(line)![1]);
}

/** The answer text Ask sent, joined from its delta events. */
function answerOf(sse: string): string {
  return sse
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice(6)) as { type: string; text?: string })
    .filter((event) => event.type === "delta")
    .map((event) => event.text)
    .join("");
}

describe.skipIf(!QA_URL)("Ask sends only answers its served facts support", () => {
  let db: PrismaClient;
  let chatRoute: (typeof import("@/app/api/memory/chat/route"))["POST"];

  const store = async (id: string, content: string) => {
    const vector = `[${textEmbedding(content).join(",")}]`;
    await db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","scopePath","embedding","createdAt")
      VALUES (${id}, ${ORG}, ${content}, 'text', 'human', ${ROOT}, ${vector}::vector, NOW())`;
  };
  const ask = async () =>
    answerOf(
      await (
        await chatRoute(
          new Request("http://t/api/memory/chat", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query: QUESTION, mode: "ask", disambiguated: true }),
          }),
        )
      ).text(),
    );

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
    stubMemoryService();
    ({ POST: chatRoute } = await import("@/app/api/memory/chat/route"));
  });

  afterAll(async () => {
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.$disconnect();
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: "Ask grounded answer" } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
    const person = await db.user.create({
      data: {
        orgId: ORG,
        clerkId: "clerk_askgroundedanswer",
        email: "owner@askgroundedanswer.test",
        name: "Owner",
        role: "admin",
      },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: person.id, permission: "admin" },
    });
    const ctx = { orgId: ORG, actor: { type: "human", id: person.id, role: "admin", name: "Owner" }, origin: "app" };
    session.current = { org: { id: ORG, name: "Ask grounded answer" }, user: person, ctx };
    for (const [i, text] of UNRELATED.entries()) await store(`askgroundedanswer-unrelated-${i}`, text);
  });

  it("says it found nothing and cites nothing when memory holds only unrelated facts", async () => {
    model.answer = () => MADE_UP;

    const answer = await ask();

    expect(answer).toMatch(
      /^I found nothing about this in your org's memory\. The search returned 5 facts on other subjects, so none is cited\./,
    );
    expect(answer).not.toMatch(/\[\d+\]/);
    expect(answer).not.toContain("November");
  });

  it("sends the cited answer when the fact that states it was served", async () => {
    await store("askgroundedanswer-answer", ANSWER_FACT);
    model.answer = (toolResult) =>
      `The Bokaro Torromi release ships on day 18 of the cycle [${numberOf(toolResult, "Bokaro")}].`;

    const answer = await ask();

    expect(answer).toMatch(/^The Bokaro Torromi release ships on day 18 of the cycle \[\d+\]\.$/);
  });

  it("removes the made-up sentence beside a supported one when the answering fact was served", async () => {
    await store("askgroundedanswer-answer", ANSWER_FACT);
    model.answer = (toolResult) =>
      `The Bokaro Torromi release ships on day 18 of the cycle [${numberOf(toolResult, "Bokaro")}]. ` +
      `It was first scheduled to leave on November 5, 2023 [${numberOf(toolResult, "release train leaves on Tuesday")}].`;

    const answer = await ask();

    expect(answer).toMatch(
      /^The Bokaro Torromi release ships on day 18 of the cycle \[\d+\]\.\n\nRemoved 1 statement: its date or figure is not in the memory it cites\.$/,
    );
  });
});
