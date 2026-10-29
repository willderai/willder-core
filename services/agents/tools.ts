// Mastra tool registry for Willder agents. Each tool wraps an existing service so
// agents can compose them via LLM tool-calling. Tools that touch memory read the
// caller's org context from the Mastra RuntimeContext rather than taking it as an
// explicit LLM-visible input parameter (avoids the model hallucinating org ids).
import { createTool } from "@mastra/core";
import { incompleteReadNotes } from "@/mcp/read-notes";
import type { AgentRuntimeContext } from "./runtime-context";
import { z } from "zod";
import { researchCompany } from "@/services/enrichment/exa";
import { scrapeSite } from "@/services/enrichment/firecrawl";
import { guardedMemory } from "@/services/memory";
import { excerptMarker } from "@/services/memory/query-excerpt";
import { ruleLabelOf, settledRuleCopiesFirst } from "@/services/memory/rule-copies";
import { check, type AccessContext } from "@/services/access";
import { ingestMemory } from "@/lib/inngest";
import { unstorableText } from "@/lib/unstorable-text";

/** Build the agent AccessContext from the caller's own runtime identity (set by
 *  buildRuntimeContext) rather than one specific agent's helper — so memory_read/
 *  memory_write authenticate and audit as whichever agent actually invoked the
 *  tool (research, copy, handoff, ...), not always "copy-agent". Also carries the
 *  AgentRun.id, when the caller set one, so check()/recordAudit() can
 *  stamp it on the audit row — disambiguates two overlapping runs of the same
 *  agent, which otherwise share both actorId and a nearby time window.
 *
 *  actorId is left as-is (possibly "") rather than defaulted to a plausible-
 *  looking name like "agent" — a missing actorId is a caller identity gap, not
 *  an identity, and check()'s actor-identity guard (services/access/check.ts)
 *  denies + audits on a falsy actor.id instead of silently attributing the call
 *  to a fabricated actor. */
function agentContextFromRuntime(
  runtimeContext: AgentRuntimeContext,
  orgId: string,
  capabilityToken: string,
): AccessContext {
  const actorId = runtimeContext.get("actorId") ?? "";
  const actorName = runtimeContext.get("actorName");
  const runId = runtimeContext.get("agentRunId");
  return { orgId, runId, actor: { type: "agent", id: actorId, capabilityToken, name: actorName }, origin: "agent-run" };
}

// ---------------------------------------------------------------------------
// Tool: web_search  (Exa semantic search)
// ---------------------------------------------------------------------------
export const webSearchTool = createTool({
  id: "web_search",
  description:
    "Search the web for recent news, signals, and information about a company or person. " +
    "Returns a list of relevant excerpts with URLs.",
  inputSchema: z.object({
    query: z.string().describe("The company name or person to research, optionally with a domain"),
    domain: z.string().optional().describe("Company domain (e.g. acme.com) for more precise results"),
  }),
  execute: async ({ context }) => {
    try {
      const text = await researchCompany(context.query, context.domain);
      return { results: text };
    } catch (e) {
      return { results: "", error: String(e) };
    }
  },
});

// ---------------------------------------------------------------------------
// Tool: scrape  (Firecrawl website scrape)
// ---------------------------------------------------------------------------
export const scrapeTool = createTool({
  id: "scrape",
  description:
    "Scrape and extract clean markdown content from a webpage. " +
    "Use for company websites, product pages, or blog posts.",
  inputSchema: z.object({
    url: z.string().describe("The URL to scrape"),
  }),
  execute: async ({ context }) => {
    try {
      const content = await scrapeSite(context.url);
      return { content };
    } catch (e) {
      return { content: "", error: String(e) };
    }
  },
});

// ---------------------------------------------------------------------------
// Tool: memory_read  (guarded memory retrieval — needs capabilityToken in ctx)
// ---------------------------------------------------------------------------
export const memoryReadTool = createTool({
  id: "memory_read",
  description:
    "Search the organisation's memory graph for relevant facts about a contact, account, or topic. " +
    "Returns scored facts from previous research and human-entered knowledge.",
  inputSchema: z.object({
    query: z.string().describe("What to look up in memory"),
    limit: z.number().int().min(1).max(30).optional().describe("Max facts to return (default 10)"),
  }),
  execute: async ({
    context,
    runtimeContext,
  }: {
    context: { query: string; limit?: number };
    runtimeContext: AgentRuntimeContext;
  }) => {
    const orgId = runtimeContext.get("orgId");
    const capabilityToken = runtimeContext.get("capabilityToken");
    const memoryScope = runtimeContext.get("memoryScope");
    if (!orgId || !capabilityToken) {
      return { facts: [], error: "memory_read requires orgId and capabilityToken in runtime context" };
    }
    try {
      const ctx = agentContextFromRuntime(runtimeContext, orgId, capabilityToken);
      const res = await guardedMemory.retrieve(
        ctx,
        {
          groupId: orgId,
          query: context.query,
          limit: context.limit ?? 10,
        },
        memoryScope,
      );
      // An excerpt carries its marker in its text, so neither this reply nor the run's
      // labelled fact list shows the model part of a fact as if it were all of it.
      // A rule's text stored as a fact is served in the rule's standing, settled rules first.
      // The standing is told to the model beside the fact, never folded into the fact's text,
      // which a brief quotes and later compares with what is stored (services/agents/brief-citations.ts).
      const facts = (await settledRuleCopiesFirst(orgId, res.facts)).map((f) => ({
        ...f,
        fact: `${f.fact}${excerptMarker(f)}`,
      }));
      runtimeContext.get("retrievedFacts")?.add(facts);
      const sourcesRead = runtimeContext.get("sourcesRead");
      for (const f of facts) {
        if (f.sourceId) sourcesRead?.add(f.sourceId);
      }
      const notes = incompleteReadNotes(res);
      return {
        facts: facts.map((f) => ({
          fact: f.fact,
          confidence: f.confidence,
          actorType: f.actorType,
          uuid: f.uuid,
          ...(ruleLabelOf(f) ? { rule: ruleLabelOf(f) } : {}),
        })),
        ...(notes.length > 0 ? { notes } : {}),
      };
    } catch (e) {
      return { facts: [], error: String(e) };
    }
  },
});

// ---------------------------------------------------------------------------
// Tool: memory_write  (direct memory ingest — for research agents)
// ---------------------------------------------------------------------------
export const memoryWriteTool = createTool({
  id: "memory_write",
  description:
    "Write new findings or facts to the organisation's memory graph. " +
    "Use after gathering research to persist it for future agent runs.",
  inputSchema: z.object({
    content: z.string().describe("The findings or facts to write to memory"),
    name: z.string().describe("A short label for this memory entry (e.g. company or person name)"),
  }),
  execute: async ({
    context,
    runtimeContext,
  }: {
    context: { content: string; name: string };
    runtimeContext: AgentRuntimeContext;
  }) => {
    const orgId = runtimeContext.get("orgId");
    const capabilityToken = runtimeContext.get("capabilityToken");
    const actorId = runtimeContext.get("actorId");
    const actorName = runtimeContext.get("actorName") ?? "Agent";
    const memoryScope = runtimeContext.get("memoryScope");
    if (!orgId || !capabilityToken || !actorId) {
      return { episodeId: null, error: "memory_write requires orgId, capabilityToken, and actorId in runtime context" };
    }
    // Refused before check(), whose audit target carries the name: Postgres cannot store a
    // NUL there or in the memory row. Same invalid_input prefix the MCP tools use.
    const unstorable = unstorableText({ content: context.content, name: context.name });
    if (unstorable) return { episodeId: null, error: `invalid_input: ${unstorable.message}` };
    try {
      // Gate + audit via check() — this is what creates the audit log entry.
      const ctx = agentContextFromRuntime(runtimeContext, orgId, capabilityToken);
      const decision = await check(ctx, {
        action: "memory.write",
        scope: memoryScope,
        target: `content:${context.name}`,
      });
      if (!decision.allowed) return { episodeId: null, error: `access denied: ${decision.reason}` };

      // Actual write goes through Inngest (async, distillation + resolver pipeline).
      await ingestMemory({
        groupId: orgId,
        content: context.content,
        source: "enrichment",
        name: context.name,
        actorType: "agent",
        origin: ctx.origin,
        actorId,
        actorName,
        scopePath: memoryScope,
        authorizedById: decision.auditLogId,
      });
      return { episodeId: "queued" };
    } catch (e) {
      return { episodeId: null, error: String(e) };
    }
  },
});

// ---------------------------------------------------------------------------
// Registry: key → tool mapping for the runner + UI
// ---------------------------------------------------------------------------
export const TOOL_REGISTRY = {
  web_search: webSearchTool,
  scrape: scrapeTool,
  memory_read: memoryReadTool,
  memory_write: memoryWriteTool,
} as const;

export type ToolKey = keyof typeof TOOL_REGISTRY;

/** Human-readable metadata for the UI tool picker. */
export const TOOL_META: Record<ToolKey, { label: string; description: string }> = {
  web_search: {
    label: "Web search",
    description: "Search the web for company news and signals (Exa)",
  },
  scrape: {
    label: "Web scrape",
    description: "Scrape and extract content from any URL (Firecrawl)",
  },
  memory_read: {
    label: "Memory read",
    description: "Retrieve relevant facts from the org's memory graph",
  },
  memory_write: {
    label: "Memory write",
    description: "Write research findings to the org's memory graph",
  },
};

/** Return only the tools whose keys appear in the agent's `tools` array. */
export function buildToolSet(keys: string[]): Partial<typeof TOOL_REGISTRY> {
  return Object.fromEntries(
    keys.filter((k): k is ToolKey => k in TOOL_REGISTRY).map((k) => [k, TOOL_REGISTRY[k]]),
  ) as Partial<typeof TOOL_REGISTRY>;
}
