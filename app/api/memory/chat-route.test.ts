import { beforeEach, describe, expect, it, vi } from "vitest";

// Tests for POST /api/memory/chat — orchestrator-based memory chatbot.
// Groq client, access gate, and memory service are mocked.
// We test auth, validation, and the SSE header contract.
// Tool execution paths (search_memory / save_memory) require the Groq mock
// to emit a tool-call delta, which the route executes and feeds back.
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: { orgPreference: { findUnique: vi.fn().mockResolvedValue(null) } },
}));
vi.mock("@/services/memory", () => {
  class FakeMemoryServiceError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.status = status;
    }
  }
  return {
    guardedMemory: { retrieve: vi.fn() },
    memory: { ingest: vi.fn() },
    MemoryServiceError: FakeMemoryServiceError,
  };
});
vi.mock("@/services/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/access")>();
  class FakeAccessDeniedError extends Error {
    constructor(readonly decision: { allowed: boolean; reason: string }) {
      super(decision.reason);
    }
  }
  return { ...actual, AccessDeniedError: FakeAccessDeniedError, check: vi.fn().mockResolvedValue({ allowed: true }) };
});
vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn() }));
vi.mock("@/services/memory/rule-copies", () => import("@/services/memory/rule-copies.testsupport"));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: vi.fn(() => false), per: { hour: 3_600_000 } }));

// Expose mockCreate so individual tests can override the LLM response.
const mockCreate = vi.fn();
vi.mock("@/lib/llm", () => ({
  createLLMClient: () => ({ chat: { completions: { create: mockCreate } } }),
  LLM_MODEL_ORCHESTRATOR: "gpt-4o-mini",
  LLM_MODEL_EXTRACT: "gpt-4o-mini",
}));
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: mockCreate } };
  },
}));

import { requireAccessContext } from "@/lib/access-context";
import { guardedMemory, MemoryServiceError } from "@/services/memory";
import { AccessDeniedError, check } from "@/services/access";
import { ingestMemory } from "@/lib/inngest";
import { isRateLimited } from "@/lib/rate-limit";

import { POST } from "./chat/route";

const rc = {
  org: { id: "org_1" },
  user: { id: "user_42", name: "Jane" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "admin" } },
};

const post = (body: unknown) =>
  new Request("http://t/api/memory/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// SSE streams are lazy — the start() callback only runs when the body is read.
// Call this after POST() to ensure tool executions inside the stream have run.
async function drainStream(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return text;
}

// Default Groq mock: plain text response, no tool calls.
const textStream = (text = "Hello world") => ({
  [Symbol.asyncIterator]: async function* () {
    yield { choices: [{ delta: { content: text } }] };
  },
});

// Groq mock that emits a search_memory tool call then on the next call, plain text.
const searchToolCall = (query: string) => ({
  [Symbol.asyncIterator]: async function* () {
    yield {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "tc_1",
                function: { name: "search_memory", arguments: JSON.stringify({ query }) },
              },
            ],
          },
        },
      ],
    };
  },
});

// Groq mock that emits a save_memory tool call.
const saveToolCall = (args: { content: string; subject?: string }) => ({
  [Symbol.asyncIterator]: async function* () {
    yield {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "tc_1", function: { name: "save_memory", arguments: JSON.stringify(args) } }],
          },
        },
      ],
    };
  },
});

const nulRefusal = (field: string) =>
  `${field} contains a NUL (\\u0000) character, which cannot be stored. Remove it and retry.`;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
  vi.mocked(isRateLimited).mockReturnValue(false);
  mockCreate.mockResolvedValue(textStream());
});

describe("POST /api/memory/chat", () => {
  it("401 when there is no access context", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null);
    expect((await POST(post({ query: "x" }))).status).toBe(401);
  });

  it("429 when rate limit is exceeded", async () => {
    vi.mocked(isRateLimited).mockReturnValue(true);
    expect((await POST(post({ query: "x" }))).status).toBe(429);
    expect(guardedMemory.retrieve).not.toHaveBeenCalled();
  });

  it("400 when the JSON body is malformed", async () => {
    const badReq = new Request("http://t", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect((await POST(badReq)).status).toBe(400);
  });

  it("400 when query is missing", async () => {
    expect((await POST(post({}))).status).toBe(400);
  });

  it("400 when query is an empty string after trimming", async () => {
    expect((await POST(post({ query: "   " }))).status).toBe(400);
  });

  it("returns a streaming SSE response with correct headers on success", async () => {
    const res = await POST(post({ query: "who is the CTO?" }));
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(res.body).not.toBeNull();
  });

  it("calls retrieve when orchestrator invokes search_memory tool", async () => {
    vi.mocked(guardedMemory.retrieve).mockResolvedValue({ facts: [] });
    // First call: tool call; second call: final text after tool result.
    mockCreate
      .mockResolvedValueOnce(searchToolCall("who is the CTO?"))
      .mockResolvedValueOnce(textStream("No info found."));

    const res = await POST(post({ query: "who is the CTO?" }));
    await drainStream(res); // consume stream so the tool execution runs

    expect(guardedMemory.retrieve).toHaveBeenCalledWith(
      rc.ctx,
      expect.objectContaining({ groupId: "org_1", query: "who is the CTO?" }),
      expect.anything(),
    );
  });

  it("sends the read's breakdown with its facts, so Ask can show where the answer came from", async () => {
    const breakdown = {
      stores: [
        { store: "graph", hits: 0 },
        { store: "semantic", hits: 1 },
      ],
      contextTokens: 6,
    };
    vi.mocked(guardedMemory.retrieve).mockResolvedValue({
      facts: [{ uuid: "c1", fact: "The CTO is Jane", validAt: null, store: "semantic", similarity: 0.9 }],
      breakdown,
    } as never);
    mockCreate.mockResolvedValueOnce(searchToolCall("who is the CTO?")).mockResolvedValueOnce(textStream("Jane [1]."));

    const text = await drainStream(await POST(post({ query: "who is the CTO?", disambiguated: true })));

    const factsEvent = text
      .split("\n\n")
      .filter((chunk) => chunk.startsWith("data: "))
      .map((chunk) => JSON.parse(chunk.slice(6)))
      .find((event) => event.type === "facts");
    expect(factsEvent.breakdown).toEqual(breakdown);
  });

  // The model must not answer from an excerpt as if it were the whole fact.
  it("marks a fact served as an excerpt in the tool text the model reads", async () => {
    vi.mocked(guardedMemory.retrieve).mockResolvedValue({
      facts: [
        { uuid: "c1", fact: "The CTO is Jane", validAt: null, store: "semantic" },
        { uuid: "c2", fact: "… Jane joined in May. …", validAt: null, store: "semantic", excerptOfChars: 67716 },
      ],
    } as never);
    mockCreate.mockResolvedValueOnce(searchToolCall("who is the CTO?")).mockResolvedValueOnce(textStream("Jane [1]."));

    await drainStream(await POST(post({ query: "who is the CTO?", disambiguated: true })));

    const toolReply = mockCreate.mock.calls[1][0].messages.find((m: { role: string }) => m.role === "tool");
    expect(toolReply.content).toBe("[1] The CTO is Jane\n[2] … Jane joined in May. … [excerpt of 67716 chars]");
  });

  it("marks an excerpt in the facts it asks the model to disambiguate", async () => {
    vi.mocked(guardedMemory.retrieve).mockResolvedValue({
      facts: [
        { uuid: "c1", fact: "Jane is the CTO", validAt: null, store: "semantic" },
        { uuid: "c2", fact: "… Jane joined in May. …", validAt: null, store: "semantic", excerptOfChars: 67716 },
      ],
    } as never);
    mockCreate
      .mockResolvedValueOnce(searchToolCall("Jane"))
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ ambiguous: false, options: [] }) } }] })
      .mockResolvedValueOnce(textStream("Jane [1]."));

    await drainStream(await POST(post({ query: "Jane" })));

    const asked = mockCreate.mock.calls[1][0].messages.find((m: { role: string }) => m.role === "user");
    expect(asked.content).toBe("- Jane is the CTO\n- … Jane joined in May. … [excerpt of 67716 chars]");
  });

  it("returns 200 SSE stream when retrieve throws AccessDeniedError", async () => {
    vi.mocked(guardedMemory.retrieve).mockRejectedValue(
      new AccessDeniedError({ allowed: false, reason: "no read grant" }),
    );
    mockCreate.mockResolvedValueOnce(searchToolCall("budget")).mockResolvedValueOnce(textStream("Access denied."));

    const res = await POST(post({ query: "budget" }));
    await drainStream(res);
    // Errors inside tool execution are in-stream tool results, not HTTP errors.
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
  });

  // The confirmed save answered "Saved." and stored later, in after(); ingestMemory's refusal
  // of a NUL there was only logged, so the user was told a write happened that never did.
  it("400 naming the fix when a confirmed save's pendingContent holds a NUL", async () => {
    const res = await POST(
      post({
        query: "save this",
        mode: "write",
        confirmed: true,
        pendingContent: "Refunds are owned\u0000 by payments.",
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(nulRefusal("pendingContent"));
    expect(check).not.toHaveBeenCalled();
    expect(ingestMemory).not.toHaveBeenCalled();
  });

  // The same false "Saved to memory." reached the model when its own save_memory arguments
  // held a NUL; it now gets the refusal to relay instead.
  it.each([
    ["content", { content: "Refunds are owned\u0000 by payments." }],
    ["subject", { content: "Refunds are owned by payments.", subject: "refund\u0000 owner" }],
  ])("a save_memory call whose %s holds a NUL is refused to the model, not saved", async (field, args) => {
    mockCreate.mockResolvedValueOnce(saveToolCall(args)).mockResolvedValueOnce(textStream("Could not save that."));

    await drainStream(await POST(post({ query: "remember who owns refunds", mode: "write", confirmed: true })));

    const toolReply = mockCreate.mock.calls[1][0].messages.find((m: { role: string }) => m.role === "tool");
    expect(toolReply.content).toBe(`Not saved: ${nulRefusal(field)}`);
    expect(check).not.toHaveBeenCalled();
    expect(ingestMemory).not.toHaveBeenCalled();
  });

  it("returns 200 SSE stream when memory service is unavailable", async () => {
    vi.mocked(guardedMemory.retrieve).mockRejectedValue(new MemoryServiceError("service down", 503));
    mockCreate.mockResolvedValueOnce(searchToolCall("x")).mockResolvedValueOnce(textStream("Service down."));

    const res = await POST(post({ query: "x" }));
    await drainStream(res);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
  });
});

// An org-wide ask whose memory held nothing about the question was answered "...November 5,
// 2023 [1]", citing a fact about something else. The answer is now grounded before it is sent
// (services/memory/answer-grounding.ts); the model here writes exactly that kind of answer.
describe("Ask sends only what the facts it served support", () => {
  const QUESTION = "When does the Bokaro Torromi release ship?";
  const MARKER = "Seeded test record 8196: the Bokaro Torromi release ships on day 18 of the cycle.";
  const UNRELATED = [
    "severity is currently ship-before-users at zero users.",
    "Root files that ship are in every set.",
    "the release train leaves on Tuesday",
    "Date: November-05-2023\nUSER: Sounds good! I'll send her that message and see what she says.",
  ];
  const facts = (texts: string[]) => texts.map((fact, i) => ({ uuid: `f${i}`, fact, validAt: null, store: "graph" }));
  const events = (sse: string) =>
    sse
      .split("\n\n")
      .filter((chunk) => chunk.startsWith("data: "))
      .map((chunk) => JSON.parse(chunk.slice(6)) as { type: string; text?: string; facts?: { fact: string }[] });
  const answerOf = (sse: string) =>
    events(sse)
      .filter((e) => e.type === "delta")
      .map((e) => e.text)
      .join("");
  const ask = async (served: string[], written: string, mode: "ask" | "chat" = "ask") => {
    vi.mocked(guardedMemory.retrieve).mockResolvedValue({ facts: facts(served) } as never);
    mockCreate.mockResolvedValueOnce(searchToolCall(QUESTION)).mockResolvedValueOnce(textStream(written));
    return drainStream(await POST(post({ query: QUESTION, mode, disambiguated: true })));
  };

  it("says it found nothing, and cites nothing, when no fact served is about the question", async () => {
    // The first sentence states no date, so only holding it back keeps it from being sent.
    const sse = await ask(
      UNRELATED,
      "The Bokaro Torromi release is on track. It is scheduled to leave on November 5, 2023 [1].",
    );

    const answer = answerOf(sse);
    expect(answer).toMatch(
      /^I found nothing about this in your org's memory\. The search returned 4 facts on other subjects, so none is cited\./,
    );
    expect(answer).toContain("choose that scope under Search within");
    expect(answer).not.toMatch(/\[\d+\]|November|2023|on track/);
    expect(events(sse).some((e) => e.type === "no_data")).toBe(true);
    const toolReply = mockCreate.mock.calls[1][0].messages.find((m: { role: string }) => m.role === "tool");
    expect(toolReply.content).toBe(`None of the 4 facts found is about "${QUESTION}"; memory has nothing on it.`);
  });

  it("says it found nothing when the search returned nothing, whatever the model wrote", async () => {
    const sse = await ask([], "It ships on November 5, 2023.");
    expect(answerOf(sse)).toBe(
      "I found nothing about this in your org's memory. If it should be in a connected source or a team's memory, choose that scope under Search within and ask again.",
    );
  });

  it("removes a sentence whose date its cited fact does not hold, and says one was removed", async () => {
    const sse = await ask(
      [...UNRELATED, MARKER],
      "The Bokaro Torromi release ships on day 18 of the cycle [5]. It was first planned to leave on November 5, 2023 [1].",
    );
    expect(answerOf(sse)).toBe(
      "The Bokaro Torromi release ships on day 18 of the cycle [5].\n\nRemoved 1 statement: its date or figure is not in the memory it cites.",
    );
  });

  it("streams the answer sentence by sentence as each is checked", async () => {
    vi.mocked(guardedMemory.retrieve).mockResolvedValue({ facts: facts([...UNRELATED, MARKER]) } as never);
    mockCreate.mockResolvedValueOnce(searchToolCall(QUESTION)).mockResolvedValueOnce({
      [Symbol.asyncIterator]: async function* () {
        for (const content of [
          "The Bokaro Torromi release ships on day 18 ",
          "of the cycle [5]. It ships",
          " from the main line [5].",
        ]) {
          yield { choices: [{ delta: { content } }] };
        }
      },
    });

    const sse = await drainStream(await POST(post({ query: QUESTION, mode: "ask", disambiguated: true })));

    expect(
      events(sse)
        .filter((e) => e.type === "delta")
        .map((e) => e.text),
    ).toEqual(["The Bokaro Torromi release ships on day 18 of the cycle [5].", " It ships from the main line [5]."]);
  });

  it("removes a citation to a fact that was not served", async () => {
    const sse = await ask([...UNRELATED, MARKER], "The Bokaro Torromi release ships on day 18 of the cycle [5][9].");
    expect(answerOf(sse)).toBe("The Bokaro Torromi release ships on day 18 of the cycle [5].");
  });

  it("sends an answer its cited fact supports as written", async () => {
    const sse = await ask([...UNRELATED, MARKER], "The Bokaro Torromi release ships on day 18 of the cycle [5].");
    expect(answerOf(sse)).toBe("The Bokaro Torromi release ships on day 18 of the cycle [5].");
  });

  it("numbers facts across searches, so a citation names the card Ask shows", async () => {
    vi.mocked(guardedMemory.retrieve)
      .mockResolvedValueOnce({ facts: facts(["the release train leaves on Tuesday"]) } as never)
      .mockResolvedValueOnce({
        facts: [
          { uuid: "f0", fact: "the release train leaves on Tuesday", validAt: null, store: "graph" },
          { uuid: "m", fact: MARKER, validAt: null, store: "graph" },
        ],
      } as never);
    mockCreate
      .mockResolvedValueOnce(searchToolCall("release train"))
      .mockResolvedValueOnce(searchToolCall(QUESTION))
      .mockResolvedValueOnce(textStream("The Bokaro Torromi release ships on day 18 of the cycle [2]."));

    const sse = await drainStream(await POST(post({ query: QUESTION, mode: "ask", disambiguated: true })));

    const secondReply = mockCreate.mock.calls[2][0].messages.filter((m: { role: string }) => m.role === "tool")[1];
    expect(secondReply.content).toBe(`[1] the release train leaves on Tuesday\n[2] ${MARKER}`);
    expect(
      events(sse)
        .filter((e) => e.type === "facts")
        .at(-1)
        ?.facts?.map((f) => f.fact),
    ).toEqual(["the release train leaves on Tuesday", MARKER]);
    expect(answerOf(sse)).toBe("The Bokaro Torromi release ships on day 18 of the cycle [2].");
  });

  it("holds what the model writes until a search serves a fact about the question, then sends it", async () => {
    vi.mocked(guardedMemory.retrieve)
      .mockResolvedValueOnce({ facts: facts(UNRELATED) } as never)
      .mockResolvedValueOnce({ facts: [{ uuid: "m", fact: MARKER, validAt: null, store: "graph" }] } as never);
    mockCreate
      .mockResolvedValueOnce(searchToolCall("Bokaro Torromi"))
      .mockResolvedValueOnce({
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: "Nothing yet, so I searched again. " } }] };
          yield {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "tc_2",
                      function: { name: "search_memory", arguments: JSON.stringify({ query: QUESTION }) },
                    },
                  ],
                },
              },
            ],
          };
        },
      })
      .mockResolvedValueOnce(textStream("The Bokaro Torromi release ships on day 18 of the cycle [5]."));

    const sse = await drainStream(await POST(post({ query: QUESTION, mode: "ask", disambiguated: true })));

    expect(answerOf(sse)).toBe(
      "Nothing yet, so I searched again. The Bokaro Torromi release ships on day 18 of the cycle [5].",
    );
  });

  it("leaves Chat mode, which reads no memory, streaming as written", async () => {
    mockCreate.mockResolvedValueOnce(textStream("It probably ships in 2023."));
    const sse = await drainStream(await POST(post({ query: QUESTION, mode: "chat" })));
    expect(answerOf(sse)).toBe("It probably ships in 2023.");
  });
});
