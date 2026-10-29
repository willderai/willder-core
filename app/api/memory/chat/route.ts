import { NextResponse, after } from "next/server";
import OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { createLLMClient, LLM_MODEL_ORCHESTRATOR, LLM_MODEL_EXTRACT } from "@/lib/llm";
import { requireAccessContext } from "@/lib/access-context";
import { guardedMemory } from "@/services/memory";
import { excerptMarker } from "@/services/memory/query-excerpt";
import { ruleLabelOf, settledRuleCopiesFirst } from "@/services/memory/rule-copies";
import {
  AnswerGrounder,
  isAboutTheQuestion,
  questionTerms,
  servedFactTerms,
  type ServedFactTerms,
} from "@/services/memory/answer-grounding";
import { incompleteReadNotes } from "@/mcp/read-notes";
import { ingestMemory } from "@/lib/inngest";
import { unstorableText } from "@/lib/unstorable-text";
import { check, AccessDeniedError, orgRootPath, resolveCallerScopePath } from "@/services/access";
import { isRateLimited, per } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import { sanitizeForLLM, LIMITS } from "@/lib/sanitize";
import type { AccessContext, AccessDecision } from "@/services/access";
import type { IngestInput, MemoryFact } from "@/types/memory";

// POST /api/memory/chat — orchestrator-style chatbot over business memory.
//
// Architecture: single orchestrator LLM with two tools (search_memory, save_memory).
// The model decides when to call them; the route executes and feeds results back.
//
// Flow:
//   1. Orchestrator streams a response, calling tools as needed
//   2. search_memory → execute retrieve, check disambiguation, feed facts back,
//                      numbered across every search of the turn
//   3. save_memory   → if not confirmed: send confirm event + stop
//                      if confirmed: access check + ingest, feed result back
//   4. After tools, the orchestrator writes the final answer, streamed a sentence at a
//      time as each is checked (services/memory/answer-grounding.ts): a citation to a fact
//      not served is removed, and so is a sentence stating a date or figure its facts do not
//      hold. If no served fact is about the question, Ask says it found nothing instead.
//
// Body: { query, history?, confirmed? }

export type ChatIntent = "read" | "write" | "chat";
export type ChatMode = "chat" | "ask" | "write";

type HistoryMessage = { role: "user" | "assistant"; content: string };

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

function sseStream(fn: (send: (obj: unknown) => void) => Promise<void> | void): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      await fn(send);
      controller.close();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

// ---------------------------------------------------------------------------
// Streaming tag stripper — removes <think>, <tools>, and <function> blocks
// that some models (Qwen3, llama variants) leak into response text.
// ---------------------------------------------------------------------------

const STRIP_TAGS: Array<{ open: string; close: string }> = [
  { open: "<think>", close: "</think>" },
  { open: "<tools>", close: "</tools>" },
  { open: "<function>", close: "</function>" },
];

function createThinkStripper(): (chunk: string) => string {
  let activeClose: string | null = null;
  return (text: string): string => {
    let result = "";
    let remaining = text;
    while (remaining.length > 0) {
      if (activeClose) {
        const end = remaining.indexOf(activeClose);
        if (end === -1) {
          remaining = "";
          break;
        }
        remaining = remaining.slice(end + activeClose.length);
        if (remaining.startsWith("\n")) remaining = remaining.slice(1);
        activeClose = null;
      } else {
        // Find the earliest opening tag.
        let earliest = -1;
        let matchedTag = STRIP_TAGS[0];
        for (const tag of STRIP_TAGS) {
          const idx = remaining.indexOf(tag.open);
          if (idx !== -1 && (earliest === -1 || idx < earliest)) {
            earliest = idx;
            matchedTag = tag;
          }
        }
        if (earliest === -1) {
          result += remaining;
          break;
        }
        result += remaining.slice(0, earliest);
        activeClose = matchedTag.close;
        remaining = remaining.slice(earliest + matchedTag.open.length);
      }
    }
    return result;
  };
}

// ---------------------------------------------------------------------------
// Orchestrator tools
// ---------------------------------------------------------------------------

const TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_memory",
      description:
        "Search the organization's memory for facts about people, companies, or past events. " +
        "Call this whenever the user asks about stored information or business context.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language search query" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_memory",
      description:
        "Save a fact to memory. Call this when the user explicitly states information to remember, " +
        "including when they say 'save that', 'remember this', 'store that in memory'. " +
        "Resolve any pronoun references ('that', 'this', 'it') to the actual fact from context.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The exact fact to save as a clear declarative statement (resolved from context if needed)",
          },
          subject: { type: "string", description: "Short topic label, e.g. 'Amy - relationship'" },
        },
        required: ["content"],
      },
    },
  },
];

// Shared rule injected into every mode — reading org roles is fine, mutations are not.
const CONFIG_BOUNDARY =
  "- You may answer questions about org roles and entity aliases from memory search results. " +
  "You must never create, modify, or delete them — those are admin configuration managed in " +
  "Settings → Org Roles / Aliases. If asked to add, change, or remove an org role or alias, " +
  "respond: 'Org roles and aliases are configuration — manage them in Settings, not here.'";

// Mode-scoped system prompts — the mode constrains what tools exist, and the
// prompt reinforces that constraint so the model doesn't drift.
const SYSTEM_BY_MODE: Record<ChatMode, string> = {
  chat:
    "You are Willder's operations interface. No memory tools are available in this mode.\n\n" +
    "Rules:\n" +
    "- Answer conversationally from your own knowledge and the conversation history.\n" +
    "- If the user asks about stored business data, explain that Ask or Write mode gives memory access.\n" +
    `${CONFIG_BOUNDARY}\n` +
    "- Be direct. No filler. No hedging.",

  ask:
    "You are Willder's operations intelligence with read-only access to organization memory.\n\n" +
    "Rules:\n" +
    "- Always call search_memory first. Never answer before searching.\n" +
    "- Answer from the search results only, citing each statement inline with the number of the fact that states it [1][2]. Cite a fact only for what that fact itself says.\n" +
    "- Never state a date, number, name or amount that is not written in a fact you cite. If you count or compute from facts, cite the facts you used.\n" +
    "- If no fact answers the question, say plainly that memory does not say, and stop. Do not guess and do not add general knowledge.\n" +
    "- Never invent citations, example facts, or hypothetical org data. Only cite numbers that correspond to actual search results.\n" +
    `${CONFIG_BOUNDARY}\n` +
    "- Be direct. No filler. No hedging.\n" +
    "- You cannot write to memory in this mode. If asked to save something, tell the user to switch to Write mode.",

  write:
    "You are Willder's operations intelligence with full read/write access to organization memory.\n\n" +
    "Rules:\n" +
    "- If the user's message is a STATEMENT OF FACT (not a question), call save_memory IMMEDIATELY. " +
    "  Do NOT search first. Do NOT ask 'would you like to save?' — the confirmation panel handles that. " +
    "  Just call save_memory with the fact as-is.\n" +
    "- Only call search_memory if the user explicitly ASKS a question about stored information.\n" +
    "- Resolve pronoun references before saving: if they say 'store that' after 'Amy is our top client', save 'Amy is our top client'.\n" +
    "- After saving, confirm briefly: 'Saved.' Nothing else.\n" +
    `${CONFIG_BOUNDARY}\n` +
    "- Be direct. No filler. No hedging. Never ask permission to save in Write mode.",
};

// ---------------------------------------------------------------------------
// Disambiguation — checks if any entity name maps to multiple distinct entities
// ---------------------------------------------------------------------------

interface DisambiguationResult {
  name: string;
  options: string[];
}

async function findAmbiguousEntity(
  entities: string[],
  ctx: AccessContext,
  groupId: string,
  llm: OpenAI,
): Promise<DisambiguationResult | null> {
  for (const entityName of entities) {
    let facts: MemoryFact[];
    try {
      const result = await guardedMemory.retrieve(ctx, { groupId, query: entityName, limit: 10 });
      facts = result.facts;
    } catch {
      continue;
    }
    if (facts.length < 2) continue;

    try {
      const res = await llm.chat.completions.create({
        model: LLM_MODEL_EXTRACT,
        messages: [
          {
            role: "system",
            content:
              `Given these memory facts, does "${entityName}" refer to two or more COMPLETELY DIFFERENT ` +
              `people or companies — NOT the same individual with multiple relationships?\n\n` +
              `Only mark ambiguous=true when the facts describe genuinely different individuals ` +
              `(e.g. one works at Company A, another at Company B; two people with the same name but different roles).\n` +
              `NEVER mark ambiguous=true if all facts can plausibly be about the same person from different angles ` +
              `(e.g. "Alex is Jordan's manager" + "Alex is Sam's neighbor" = same person, NOT ambiguous).\n\n` +
              `If ambiguous, give a brief identifying label for each distinct individual.\n` +
              `Output JSON: { "ambiguous": true|false, "options": ["label 1", "label 2"] }\n` +
              `"options" must have ≥2 entries when ambiguous is true; empty array otherwise.`,
          },
          { role: "user", content: facts.map((f) => `- ${f.fact}${excerptMarker(f)}`).join("\n") },
        ],
        response_format: { type: "json_object" },
        max_tokens: 200,
        temperature: 0,
      });
      const parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}");
      if (parsed.ambiguous === true && Array.isArray(parsed.options) && parsed.options.length >= 2) {
        return {
          name: entityName,
          options: parsed.options.filter((o: unknown): o is string => typeof o === "string"),
        };
      }
    } catch {
      continue;
    }
  }
  return null;
}

// Simple regex entity extraction for disambiguation pre-check (no LLM needed)
function extractEntities(text: string): string[] {
  const matches = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g) ?? [];
  return [...new Set(matches)].filter((e) => e.length > 1);
}

/**
 * The ingest for a save the person confirmed, written as theirs. `decision` is the
 * allowed `memory.write` that gated it: its audit row id rides onto the change event,
 * which is how the visible audit log names the change this authorization produced.
 */
function confirmedSave(
  rc: { org: { id: string }; user: { id: string }; ctx: AccessContext },
  save: { content: string; name: string; actorName: string; scopePath: string; decision: AccessDecision },
): IngestInput {
  return {
    groupId: rc.org.id,
    content: save.content,
    source: "chat",
    name: save.name,
    actorType: "human",
    origin: rc.ctx.origin,
    actorId: rc.user.id,
    actorName: save.actorName,
    scopePath: save.scopePath,
    authorizedById: save.decision.auditLogId,
  };
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (isRateLimited(`memory:chat:${rc.org.id}`, 30, per.hour)) {
    return NextResponse.json({ error: "rate limit exceeded" }, { status: 429 });
  }

  let body: {
    query?: string;
    history?: HistoryMessage[];
    confirmed?: boolean;
    pendingContent?: string;
    disambiguated?: boolean;
    mode?: ChatMode;
    scope?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }
  console.log(
    "[chat] body:",
    JSON.stringify({
      confirmed: body.confirmed,
      hasPending: !!body.pendingContent,
      mode: body.mode,
      queryLen: body.query?.length,
    }),
  );
  const { safe: query, injectionDetected } = sanitizeForLLM(body.query, LIMITS.chatQuery);
  if (!query) return NextResponse.json({ error: "query is required" }, { status: 400 });
  if (injectionDetected) return NextResponse.json({ error: "query contains disallowed patterns" }, { status: 400 });

  const mode: ChatMode = (["chat", "ask", "write"] as ChatMode[]).includes(body.mode as ChatMode)
    ? (body.mode as ChatMode)
    : "ask";
  // A malformed scope is refused by name, with one deny row, before anything is read or
  // saved at it: unchecked, it either threw in check()'s `::ltree` cast mid-stream or
  // was saved at a path no read accepts. An absent scope is the org root.
  let scope: string;
  try {
    scope = await resolveCallerScopePath(
      rc.ctx,
      body.scope,
      { scopePath: orgRootPath(rc.org.id) },
      {
        onInvalid: "refuse",
        action: mode === "write" || body.confirmed ? "memory.write" : "memory.read",
        field: "scope",
      },
    );
  } catch (e) {
    if (e instanceof AccessDeniedError) return NextResponse.json({ error: e.decision.reason }, { status: 403 });
    throw e;
  }

  const history: HistoryMessage[] = Array.isArray(body.history)
    ? body.history.slice(-10).filter((m) => m.role && m.content)
    : [];

  const llm = createLLMClient();
  const prefs = await db.orgPreference.findUnique({
    where: { orgId: rc.org.id },
    select: { memoryChatName: true },
  });
  const actorName = prefs?.memoryChatName?.trim() || rc.user.name || rc.user.email.split("@")[0] || "the user";

  // Fast path: long Write-mode input with no search intent — skip LLM and go
  // straight to confirmation. Mirrors how ChatGPT handles pasted documents:
  // the user clearly wants to save, not query, so don't waste a model call.
  const LONG_WRITE_THRESHOLD = 500;
  const isLongWritePaste =
    mode === "write" && !body.confirmed && query.length > LONG_WRITE_THRESHOLD && !/[?]/.test(query);

  if (isLongWritePaste) {
    return sseStream(async (send) => {
      send({ type: "intent", intent: "write" });
      send({ type: "confirm", summary: query, episode: `${actorName}: ${query}`, pendingContent: query });
      send({ type: "done" });
    });
  }

  // Fast path: confirmed save with known content — skip LLM entirely.
  if (body.confirmed && body.pendingContent) {
    // The save below is answered "Saved." and stored later, in after(), so a NUL (which
    // Postgres cannot store) has to be refused here, while the answer can still say so.
    const unstorable = unstorableText({ pendingContent: body.pendingContent });
    if (unstorable) return NextResponse.json({ error: unstorable.message }, { status: 400 });
    const content = body.pendingContent.trim();
    return sseStream(async (send) => {
      send({ type: "intent", intent: "write" });
      const decision = await check(rc.ctx, { action: "memory.write", scope, target: "chat:user-fact" });
      if (!decision.allowed) {
        send({ type: "error", error: "Access denied." });
        send({ type: "done" });
        return;
      }
      const ingestData = confirmedSave(rc, { content, name: "user fact", actorName, scopePath: scope, decision });
      console.log("[chat] confirmed save, scheduling ingest for:", ingestData.content.slice(0, 60));
      after(async () => {
        console.log("[chat] after() running ingest");
        try {
          await ingestMemory(ingestData);
          console.log("[chat] ingest done");
        } catch (e) {
          console.error("[chat/confirm-save] ingest failed:", e);
        }
      });
      send({ type: "delta", text: "Saved." });
      send({ type: "done" });
    });
  }

  return sseStream(async (send) => {
    const strip = createThinkStripper();

    const userContext =
      `\nContext: You are speaking with ${actorName}.` +
      (scope ? ` Active memory scope: ${scope}.` : "") +
      ` When referring to the person you are talking to, use their name (${actorName}), not "Willder".`;

    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_BY_MODE[mode] + userContext },
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: query },
    ];

    // Tools available per mode: chat = none, ask = search only, write = both.
    const activeTools =
      mode === "chat"
        ? []
        : mode === "ask"
          ? TOOLS.filter((t) => (t as { function?: { name?: string } }).function?.name === "search_memory")
          : TOOLS;

    let intentSent = false;
    const sendIntent = (intent: ChatIntent) => {
      if (!intentSent) {
        send({ type: "intent", intent });
        intentSent = true;
      }
    };

    // Every fact served this turn, numbered as Ask cites them: fact n is served[n - 1], across
    // every search the model makes. With memory tools the answer goes through `grounder`;
    // `held` keeps what the model wrote while no served fact is about the question yet.
    const served: MemoryFact[] = [];
    const servedTerms: ServedFactTerms[] = [];
    const questionWordings = [questionTerms(query)];
    let searchesAnswered = 0;
    let anyFactAboutTheQuestion = false;
    let lastReadNotes: string[] = [];
    const grounder = new AnswerGrounder(servedTerms, query);
    let held = "";
    const sendText = (text: string) => {
      if (text) send({ type: "delta", text });
    };

    // Agentic loop — single streaming call per iteration. llama-3.1-70b-versatile
    // handles streaming tool calls correctly (unlike llama-3.3-70b-versatile which
    // emits <function=...> XML and causes tool_use_failed 400s).
    const MODEL = LLM_MODEL_ORCHESTRATOR;

    for (let iter = 0; iter < 4; iter++) {
      let completion: AsyncIterable<ChatCompletionChunk>;
      try {
        completion = await llm.chat.completions.create({
          model: MODEL,
          messages,
          ...(activeTools.length > 0
            ? {
                tools: activeTools,
                // Ask + Write modes: first iteration forces a tool call so the model
                // can't skip memory access by streaming text directly. Write mode forces
                // save_memory (or search_memory for questions), guaranteeing the
                // confirmation panel always appears before any write lands.
                tool_choice: iter === 0 && mode !== "chat" ? "required" : "auto",
              }
            : {}),
          stream: true,
          // iter 0 must fit <think> tokens + full tool call args (long facts need room).
          // Final text iterations are short so 600 is fine there.
          max_tokens: iter === 0 ? 2048 : 600,
          temperature: 0.2,
        });
      } catch (e) {
        console.error("[chat/generate] OpenAI error (iter %d):", iter, e);
        send({ type: "error", error: "generation failed" });
        return;
      }

      const tcAccum: Record<number, { id: string; name: string; args: string }> = {};

      try {
        for await (const chunk of completion) {
          const delta = chunk.choices[0]?.delta;

          if (delta?.content) {
            const text = strip(delta.content);
            if (text) {
              sendIntent("chat");
              // With memory tools, an answer may cite what a search served, so each
              // sentence is checked before it is sent; Chat mode reads no memory.
              if (activeTools.length === 0) send({ type: "delta", text });
              else if (searchesAnswered > 0 && !anyFactAboutTheQuestion) held += text;
              else sendText(grounder.push(text));
            }
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (!tcAccum[tc.index]) tcAccum[tc.index] = { id: "", name: "", args: "" };
              if (tc.id) tcAccum[tc.index].id = tc.id;
              if (tc.function?.name) tcAccum[tc.index].name += tc.function.name;
              if (tc.function?.arguments) tcAccum[tc.index].args += tc.function.arguments;
            }
          }
        }
      } catch (e) {
        console.error("[chat/stream] OpenAI stream error (iter %d):", iter, e);
        send({ type: "error", error: "generation failed" });
        return;
      }

      const toolCalls = Object.values(tcAccum);
      if (toolCalls.length === 0) break;

      messages.push({
        role: "assistant",
        content: null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.args },
        })),
      });

      let interrupted = false;
      for (const tc of toolCalls) {
        let args: Record<string, string>;
        try {
          args = JSON.parse(tc.args);
        } catch {
          messages.push({ role: "tool", tool_call_id: tc.id, content: "Error: invalid arguments." });
          continue;
        }

        // ── search_memory ────────────────────────────────────────────────
        if (tc.name === "search_memory") {
          sendIntent("read");
          const searchQuery = (args.query ?? query).trim();

          const entities = extractEntities(searchQuery);
          if (entities.length > 0 && !body.disambiguated && mode !== "write") {
            const ambiguity = await findAmbiguousEntity(entities, rc.ctx, rc.org.id, llm);
            if (ambiguity) {
              send({ type: "disambiguate", name: ambiguity.name, options: ambiguity.options });
              send({ type: "done" });
              interrupted = true;
              break;
            }
          }

          try {
            const result = await guardedMemory.retrieve(
              rc.ctx,
              {
                groupId: rc.org.id,
                query: searchQuery,
                limit: 15,
              },
              scope,
            );
            searchesAnswered++;
            // A rule's text stored as a fact is served in the rule's standing, settled rules first.
            const ruled = await settledRuleCopiesFirst(rc.org.id, result.facts);
            const numbered = ruled.map((fact) => {
              let index = served.findIndex((s) => s.uuid === fact.uuid);
              if (index === -1) {
                served.push(fact);
                servedTerms.push(servedFactTerms(fact.fact));
                index = served.length - 1;
              }
              return { fact, number: index + 1 };
            });
            send({ type: "facts", facts: served, breakdown: result.breakdown });
            // A read that did not search everything says so, or the model answers an
            // incomplete (or empty) result as if it were the whole of memory.
            lastReadNotes = incompleteReadNotes(result);
            const notes = lastReadNotes.map((note) => `\n\n${note}`).join("");
            questionWordings.push(questionTerms(searchQuery));
            const about = numbered.filter(({ fact, number }) =>
              isAboutTheQuestion(questionWordings, {
                terms: servedTerms[number - 1]!.terms,
                similarity: fact.similarity,
              }),
            );
            if (about.length > 0 && !anyFactAboutTheQuestion) {
              anyFactAboutTheQuestion = true;
              sendText(grounder.push(held));
              held = "";
            }

            if (numbered.length === 0) {
              messages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: `No facts found in memory for "${searchQuery}".${notes}`,
              });
            } else if (about.length === 0) {
              // Handed facts on other subjects, a model answers from them anyway.
              messages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: `None of the ${numbered.length} facts found is about "${searchQuery}"; memory has nothing on it.${notes}`,
              });
            } else {
              messages.push({
                role: "tool",
                tool_call_id: tc.id,
                content:
                  numbered
                    .map(
                      ({ fact, number }) =>
                        `[${number}] ${ruleLabelOf(fact) ? `${ruleLabelOf(fact)} ` : ""}${fact.fact}${excerptMarker(fact)}`,
                    )
                    .join("\n") + notes,
              });
            }
          } catch (e) {
            const msg = e instanceof AccessDeniedError ? "Access denied to memory." : "Memory search failed.";
            messages.push({ role: "tool", tool_call_id: tc.id, content: msg });
          }
        }

        // ── save_memory ──────────────────────────────────────────────────
        else if (tc.name === "save_memory") {
          if (mode !== "write") {
            messages.push({ role: "tool", tool_call_id: tc.id, content: "Write mode is not active." });
            continue;
          }
          sendIntent("write");
          const content = (args.content ?? query).trim();
          const unstorable = unstorableText({ content, subject: args.subject });
          if (unstorable) {
            messages.push({ role: "tool", tool_call_id: tc.id, content: `Not saved: ${unstorable.message}` });
            continue;
          }

          if (!body.confirmed) {
            send({ type: "confirm", summary: content, episode: `${actorName}: ${content}`, pendingContent: content });
            send({ type: "done" });
            interrupted = true;
            break;
          }

          const decision = await check(rc.ctx, {
            action: "memory.write",
            scope,
            target: `chat:${args.subject ?? "user-fact"}`,
          });
          if (!decision.allowed) {
            messages.push({ role: "tool", tool_call_id: tc.id, content: `Access denied: ${decision.reason}` });
            continue;
          }

          const ingestData = confirmedSave(rc, {
            content,
            name: args.subject ?? "user fact",
            actorName,
            scopePath: scope,
            decision,
          });
          after(() => ingestMemory(ingestData).catch((e) => console.error("[chat/save_memory] ingest failed:", e)));
          messages.push({ role: "tool", tool_call_id: tc.id, content: "Saved to memory." });
        }
      }

      if (interrupted) return;
    }

    if (!intentSent) sendIntent("chat");
    const orgWide = scope === orgRootPath(rc.org.id);
    if (searchesAnswered > 0 && !anyFactAboutTheQuestion) {
      // Nothing served is about the question, so there is nothing to answer from: say so
      // rather than send whatever the model wrote.
      send({ type: "no_data", entities: extractEntities(query) });
      send({ type: "delta", text: nothingFoundAnswer(served.length, orgWide, lastReadNotes) });
    } else if (activeTools.length > 0) {
      sendText(grounder.end());
      const removed = grounder.removedSentences;
      if (removed > 0) {
        const note =
          removed === 1
            ? "Removed 1 statement: its date or figure is not in the memory it cites."
            : `Removed ${removed} statements: their dates or figures are not in the memory they cite.`;
        sendText(
          grounder.sentAnything
            ? `\n\n${note}`
            : `I found nothing in your org's memory that supports an answer to this.\n\n${note}`,
        );
      }
    }
    send({ type: "done" });
  });
}

/** What the person is told to try when an organization-wide ask found nothing. */
const ASK_WITHIN_A_SCOPE =
  "If it should be in a connected source or a team's memory, choose that scope under Search within and ask again.";

/**
 * Ask's answer when no fact a search served is about the question: plainly that memory has
 * nothing on it, how many facts on other subjects were left uncited, where else to ask, and
 * any note that the search itself was incomplete.
 */
function nothingFoundAnswer(returned: number, orgWide: boolean, readNotes: readonly string[]): string {
  const parts = ["I found nothing about this in your org's memory."];
  if (returned > 0)
    parts.push(
      `The search returned ${returned} ${returned === 1 ? "fact" : "facts"} on other subjects, so none is cited.`,
    );
  if (orgWide) parts.push(ASK_WITHIN_A_SCOPE);
  return [parts.join(" "), ...readNotes].join("\n\n");
}
