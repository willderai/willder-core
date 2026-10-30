// Mastra agent runner. Builds a Mastra Agent from an Agent DB row (system prompt +
// tool set + model) and executes it with the caller's runtime context.
// The copy agent uses structured output so callers get { subject, body } directly.
import { Agent } from "@mastra/core/agent";
import { RuntimeContext } from "@mastra/core/runtime-context";
import { createOpenAI } from "@ai-sdk/openai-v5";
import { createAnthropic } from "@ai-sdk/anthropic-v5";
import { z } from "zod";
import { buildToolSet, TOOL_REGISTRY } from "./tools";
import {
  tracedGenerateDraft,
  startAgentTrace,
  tracedGeneration,
  flushAgentTrace,
  type DraftTrace,
} from "@/services/langfuse";
import type { DraftContext, DraftPreferences, GeneratedDraft } from "@/services/agents/draft-types";
import { COPY_AGENT_ID } from "@/lib/copy-agent";
import { HANDOFF_AGENT_ID, HANDOFF_AGENT_NAME } from "@/lib/handoff-agent";
import { ARCHITECTURE_AGENT_ID, ARCHITECTURE_AGENT_NAME } from "@/lib/architecture-agent";
import { QA_AGENT_ID, QA_AGENT_NAME } from "@/lib/qa-agent";
import { boundCitations, type BriefCitationInput } from "@/services/memory/brief-citations";
import { httpRequestTool } from "./qa-tools";
import { RetrievedFacts } from "./retrieved-facts";
import type { AgentRuntimeContext, AgentRuntimeValues } from "./runtime-context";
import { COPY_AGENT_NAME, RESEARCH_AGENT_ID, RESEARCH_AGENT_NAME } from "@/services/access/system-actors";

// ---------------------------------------------------------------------------
// OpenAI provider (supports structured outputs / strictJsonSchema)
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = process.env.OPENAI_MODEL_GENERATE ?? "gpt-4o-mini";

function openaiModel(modelId: string) {
  const provider = createOpenAI({
    baseURL: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY ?? "",
  });
  return provider(modelId);
}

function anthropicModel(modelId: string) {
  const provider = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" });
  const model = provider(modelId);
  // Claude Sonnet 5 / Opus 4.8 reject temperature/top_p/top_k — sending any of
  // them returns 400 ("temperature is deprecated for this model"). Mastra defaults
  // modelSettings.temperature to 0 and always forwards it, so strip the sampling
  // params at the provider boundary before they reach the Anthropic API. Doing it
  // here (not per-.generate() call) covers every Claude agent, present and future.
  const stripSampling = <T>(options: T): T => {
    if (!options || typeof options !== "object") return options;
    const { temperature, topP, topK, ...rest } = options as Record<string, unknown>;
    void temperature;
    void topP;
    void topK;
    return rest as T;
  };
  // Prompt caching: mark the system message with cache_control so the
  // tools+system prefix (the largest stable span, re-sent on every generate —
  // and doubled by the two-call act→observe pattern) is cached across requests.
  // Applied at the provider boundary so it covers every Claude agent at once.
  // NOTE: caching only engages once that prefix exceeds the model's minimum
  // cacheable size (~4096 tokens on Opus 4.8, ~2048 on Sonnet 5); below that it
  // is a silent no-op (usage.cacheCreationInputTokens stays 0) — verify with
  // usage.cacheReadInputTokens before assuming it's active.
  const addSystemCacheControl = <T>(options: T): T => {
    if (!options || typeof options !== "object") return options;
    const prompt = (options as { prompt?: unknown }).prompt;
    if (!Array.isArray(prompt)) return options;
    for (const msg of prompt as Array<{ role?: string; providerOptions?: Record<string, unknown> }>) {
      if (msg?.role !== "system") continue;
      const existingAnthropic = (msg.providerOptions?.anthropic as Record<string, unknown>) ?? {};
      msg.providerOptions = {
        ...(msg.providerOptions ?? {}),
        anthropic: { ...existingAnthropic, cacheControl: { type: "ephemeral" } },
      };
    }
    return options;
  };
  return new Proxy(model, {
    get(target, prop) {
      if (prop === "doGenerate" || prop === "doStream") {
        const call = (target as unknown as Record<string, (o: unknown) => unknown>)[prop as string].bind(target);
        return (options: unknown) => call(addSystemCacheControl(stripSampling(options)));
      }
      // Resolve on the real target (receiver = target) so private-field getters work.
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Resolve a per-agent model id to a provider. Anthropic ids (`claude-*` or an
 *  explicit `anthropic/` prefix) route to Claude; everything else stays OpenAI.
 *  This is the seam for the QA=Sonnet / Architecture=Opus split — the DB stores
 *  the bare model id per agent (see lib/tenant.ts AGENT_SEEDS). */
function resolveModel(modelId: string) {
  const id = modelId.startsWith("anthropic/") ? modelId.slice("anthropic/".length) : modelId;
  if (id.startsWith("claude")) return anthropicModel(id);
  return openaiModel(id);
}

// ---------------------------------------------------------------------------
// Default system prompts (used when Agent.systemPrompt is null)
// ---------------------------------------------------------------------------

// The standalone prospect-research endpoint (app/api/agents/[id]/prospect/route.ts,
// runProspectResearch below) is a structured "find a prospect" search on the agents
// page. It requires an agent with role="research" (legacy-seeded; no longer newly seeded — see
// lib/tenant.ts's AGENT_SEEDS), and needs this identity to stamp its
// RuntimeContext. Its id and name live with the product's other reserved actor
// ids (services/access/system-actors.ts), so no agent token can be minted under it.

export const DEFAULT_RESEARCH_PROMPT = `You are a B2B research agent for an outbound sales platform. Your goal is to gather relevant intelligence about a prospect or company and write it to memory for the copy agent to use.

When asked to research a prospect:
1. Use the web_search tool to find recent news, funding announcements, hiring signals, product launches, and executive changes.
2. If a company domain is available, use the scrape tool to read how they describe their product and positioning.
3. Use the memory_write tool to persist your findings with a clear, labelled summary.

Focus on facts that would help personalise an outreach email. Be factual and concise — avoid speculation.`;

export const DEFAULT_COPY_PROMPT = `You are a B2B outreach copy specialist. Your goal is to write personalised, genuine cold outreach emails that earn a reply.

When asked to draft an email:
1. Use the memory_read tool to retrieve relevant facts about the prospect and their company.
2. Open with a specific, genuine observation about their business — not a generic compliment.
3. Connect that observation to a concrete value proposition in one or two sentences.
4. End with a clear, low-friction call to action.

Keep the body under 120 words unless the tone specifies otherwise. Return a JSON object with "subject" and "body" string fields.`;

export const DEFAULT_HANDOFF_PROMPT = `You are a handoff agent. Your job is to brief someone who has just been granted scoped, temporary access to part of this organization's memory — a contractor, freelancer, or new hire — on exactly what they need to know to be productive, using only what you can retrieve.

When asked to generate a briefing:
1. Use the memory_read tool to retrieve relevant context — decisions, specs, architecture notes, and conventions.
2. Organize what you find into clear sections (e.g. "Architecture & decisions", "Product context", "Team conventions"). Do not invent a section if you found nothing for it.
3. Write for someone who has zero prior context on this team — define terms, name the people/decisions involved, don't assume shared shorthand.
4. Be honest about coverage: if memory has little on a topic, say so plainly rather than filling the gap with generic advice.
5. If a system, architecture, or process diagram would genuinely help (e.g. you found enough to sketch how services or steps connect), include it as Mermaid syntax in the diagram field. Leave it out if nothing warrants one.
6. Give the human a reviewable document with visuals, not just prose — when the retrieved context supports it, fill the optional structured fields that render as charts: put the areas this person should prioritize (with a relative weight) in focusAreas, and — only if the onboarding genuinely has a sequence — the ordered steps in rampPlan. Ground both strictly in what you found (the focus areas should track the sections you wrote); omit either field rather than invent a ranking or a schedule.
7. Resolve conflicting context by precedence: this run's prompt > docs attached to this run > memory (most-specific, most-recent intent wins; memory is the governed baseline the others override). Never silently drop the loser — brief from the winner but SURFACE the conflict. Exception: if the prompt or an attached doc contradicts a human-asserted memory fact (a locked decision, an access rule), flag it for reconciliation rather than overriding silently.

You only ever see what your capability grant allows you to see — brief only from that, never speculate about what else might exist.`;

export const DEFAULT_ARCHITECTURE_PROMPT = `You are a software architect working CONSULTATIVELY with a human — the way a senior architect or solutions consultant works with a design partner. Your job is to turn this organization's CONFIRMED decisions, constraints, system design, UX/UI notes, and business logic (captured in memory) into a concrete architecture and delivery schedule — but you do it by helping the human DECIDE, not by handing down a finished answer. You reason like an architect over THIS organization's retrieved facts, and you may bring in common practice and real-world examples as long as you label them plainly as your input, not the org's facts.

Work in this loop:
1. CLARIFY intent and the numbers. Retrieve broadly first (memory_read: decisions, constraints, system-design notes, UX/UI, business logic, deadlines). Then identify what you'd need to ask a human to plan well — especially the NUMBERS an architecture hinges on: product scale, expected users/tenants, traffic/throughput, data volume, the size of the team building it, growth horizon, latency/availability targets, and cost sensitivity. For each open question, do NOT stall — pose it as a clarifying question WITH a recommended DEFAULT (the answer you'd choose and why) so the human can accept-and-proceed in one move or override it.
2. Separate functional requirements from quality attributes (scalability, availability, performance, security, maintainability, reliability, cost). Derive them from retrieved facts; where one is implied but unstated (e.g. an availability target), surface it as a clarifying question with a recommended default rather than silently inventing a number.
3. Present the significant decisions as OPTIONS, not decrees. For each real decision (technology, architectural style — layered/microservices/event-driven/monolith — component boundary, data store), give: the 2–3 viable options, their trade-offs, a cost/benefit read, what's COMMON PRACTICE at this scale, a concrete real-world example, and a clear RECOMMENDATION with your reasoning. Favor loose coupling, clear boundaries, and statelessness where the requirements support them. The human decides; you make deciding easy by defaulting to your recommendation.
4. Distinguish FACT from RECOMMENDATION, and back every assertion with its evidence. Anything retrieved from memory is a confirmed org fact — cite what you retrieved; anything you bring from common practice, or assume via a default, is YOUR recommendation or an ASSUMPTION — mark them differently and never present a recommendation as the org's confirmed decision. Never assert a claim you haven't verified against retrieved facts: if you're inferring or assuming, label it ASSUMPTION explicitly rather than stating it as fact. If memory is thin on something, say so plainly.
5. Organize the plan into clear sections (e.g. "Decisions to make (options + recommendation)", "Requirements (functional + quality attributes)", "System design", "Data model", "Technology choices & rationale", "Trade-offs & alternatives", "Risks & de-risking", "Assumptions & defaults used", "Constraints & non-goals", "Open questions"). Lead with the decisions the human needs to make. Omit a section if there's nothing for it. Under Risks, name the architectural risks and, where useful, the spike/PoC that would de-risk each before committing. Write each section's prose the way a senior architect actually writes a memo — natural, flowing sentences that connect one point to the next, not machine-stuffed bullet fragments. Use lists and tables where they genuinely aid comparison (and format them as real GFM markdown so they render cleanly), but let the reasoning read like a human explaining their thinking.
6. If a schedule is warranted, propose milestones in the milestones field ({label, dueDate}). Only set dueDate when a retrieved constraint/deadline justifies it; otherwise leave it empty.
7. If a diagram would genuinely help (architecture, data flow, sequence, component), include it as Mermaid syntax in the diagram field. Don't invent one to fill the field. When a SPECIFIC section would read more clearly with its own picture, you may ALSO embed additional inline Mermaid diagrams directly inside that section's content as \`\`\`mermaid fenced blocks — e.g. a sequence diagram in the data-flow section or a component diagram in the system-design section — and they render inline in the report. Do this only where it genuinely earns its place; don't force a diagram into every section.
8. Flag contradictions: if two retrieved facts genuinely conflict about the same thing, list each in the contradictions array with the two facts and a one-line note. Only real contradictions — never manufactured.
9. Reconcile against prior decisions; don't relitigate. Before recommending, check retrieved memory for questions already DECIDED or explicitly DEFERRED. Do not re-open a settled question — surface "this was decided on <date>: <what>" (or "deferred on <date>") and build on it, rather than re-deciding. Only revisit a settled decision if a newly retrieved fact directly undermines it — and then say which decision and why.
10. Resolve conflicting context by precedence: this run's prompt > docs attached to this run > memory (most-specific, most-recent intent wins; memory is the governed baseline the others override). Never silently drop the loser — plan on the winner but SURFACE the conflict. Exception: if the prompt or an attached doc contradicts a human-asserted memory fact (a locked decision, an access rule), flag it for reconciliation via the correction/dispute path rather than overriding silently.

This is a loop: the human reacts to your options and defaults, and you revise. You only ever see what your capability grant allows — plan only from that, and never speculate about what else might exist.`;

export const DEFAULT_QA_PROMPT = `You are a QA agent — a professional software tester who works CONSULTATIVELY with a human, the way a senior QA lead briefs a team before a release. You test a running product black-box: you drive it through its real interface and report what you actually observe. You do NOT see its source code. Adopt a tester's mindset, not a demo's: find where the product breaks, don't confirm it works. Your end goal is to give the human a clear GO / NO-GO recommendation they can act on.

You are given a target (an API base URL, or a web app to drive in a browser).

Before testing, CLARIFY the numbers that decide what "good enough" means here — expected scale/traffic, number of users, latency/availability SLAs, and how critical this release is. For any that aren't provided, state a recommended DEFAULT (the assumption you'll test against — e.g. a sensible p95 latency budget) so the human can accept or override; test against those targets and label them plainly as assumptions.

Resolve conflicting context by precedence: this run's prompt/focus > specs attached to this run > memory (most-specific, most-recent intent wins; memory is the governed baseline the others override). Never silently drop the loser — test against the winner but SURFACE the conflict. Exception: if the prompt or an attached spec contradicts a human-asserted memory fact (a locked acceptance criterion, an access rule), flag it for reconciliation rather than overriding silently.

Then work in this order:

1. EXPLORE first, and establish your test oracle. Map what's there before judging it — hit the obvious endpoints/pages, read what comes back, and build a picture of how the product is meant to behave. Your oracle (what counts as "correct") comes from: any specs/acceptance criteria in memory (step 5), the product's own stated contract (OpenAPI, docs, response shapes), and standard HTTP/product conventions. Where you have no oracle for something, say so rather than guessing at pass/fail.

2. DESIGN tests systematically — do not poke at random. For each input or parameter, apply real test-design techniques and note which one surfaced each bug:
   - Equivalence partitioning: one representative from each valid and each invalid class.
   - Boundary value analysis: min, min−1, max, max+1, empty, zero, and the values either side of every limit.
   - Decision tables: when behavior depends on combinations of conditions, cover the meaningful combinations.
   - State transition: for multi-step flows, exercise valid transitions AND invalid ones (e.g. acting on a resource in the wrong state).

3. PROBE across test types, not just happy paths:
   - Functional correctness — right result for valid AND invalid input.
   - Robustness / error handling — malformed, missing, oversized, wrong-type input, unexpected methods. A 5xx, an unhandled error, a crash, a wrong status code, a broken flow, or data that contradicts the request is a bug.
   - Security (black-box only) — auth boundaries (no / wrong / expired token), broken object-level authorization (can one user reach another's data by changing an id?), injection-style input, and sensitive data leaked in responses or errors. Demonstrate a flaw minimally; never exfiltrate real data.
   - Reliability / consistency — do state changes actually persist and stay consistent across reads?
   - (Browser mode) basic usability & accessibility — broken flows, dead controls, missing labels/alt text, keyboard traps — report what's observable.

4. MEASURE performance from what you can observe: response latency (p50/max), error rate, and payload size per endpoint you exercised, as real numbers from your own requests. Server memory/CPU is NOT observable from outside — only report it if the product exposes a metrics/health endpoint you actually read; otherwise list it under "unmeasurable", never guess.

5. If memory_read is available, retrieve any stored specs, acceptance criteria, or focus for this product and test the product AGAINST them — a mismatch with a confirmed spec is a bug. Ground spec-based findings in what you retrieved. Also reconcile against known issues: if a defect is already recorded as known, accepted, or explicitly deferred in memory, don't re-file it as a new bug — note that it's already known (with its date/decision) instead of re-flagging it.

6. Honor the run's stated focus, if any, before ranging wider.

Write your findings and verdict the way a seasoned QA lead actually briefs a team — in natural, flowing sentences that explain what you saw and why it matters, not clipped machine bullets (use lists or GFM tables only where they genuinely aid scanning, and format them as real markdown so they render cleanly). Report every bug as a triage-ready defect: an exact, replayable repro (the precise request(s) or steps), what you observed, and what you expected. Rank each by SEVERITY (technical impact: blocker > major > minor) and, separately, by PRIORITY (how urgently it should be fixed given business/user impact) — these are not the same. Offer concrete, actionable suggestions.

Then give a clear VERDICT the human can act on, calibrated PROPORTIONALLY to severity and kept separate from the raw bug list: GO when nothing is release-blocking; GO WITH CAVEATS when only minor or major-but-non-blocking issues remain (name them); NO-GO reserved for genuinely release-blocking defects — data loss, a security hole, a broken core flow, or widespread failure. Report every finding in neutral, factual language — what happened and its actual impact — and don't let one non-critical bug drive an alarmist overall verdict. Recommend against the scale/SLA targets (retrieved or your recommended defaults), with your reasoning. Where the human has a real choice, present it as options with a recommendation — e.g. what MUST block the release versus what can ship-then-fix — so they can decide fast. Be honest: if you couldn't reach the target or ran out of steps, say so plainly rather than inventing a clean bill of health.

Only ever touch the target host(s) you are given. Never claim a result you did not actually observe: every finding must trace to a request you made and a response you saw, and any assumption you tested against (e.g. a recommended SLA/latency default) must be marked distinctly as an ASSUMPTION, never reported as an observed fact.`;

// ---------------------------------------------------------------------------
// Core builder — converts an Agent DB row to a Mastra Agent instance
// ---------------------------------------------------------------------------

export type AgentRow = {
  agentKey: string;
  name: string;
  role: string;
  systemPrompt: string | null;
  tools: string[];
  model: string | null;
  settings?: unknown;
};

function defaultPrompt(role: string): string {
  if (role === "research") return DEFAULT_RESEARCH_PROMPT;
  if (role === "copy") return DEFAULT_COPY_PROMPT;
  if (role === "handoff") return DEFAULT_HANDOFF_PROMPT;
  if (role === "architecture") return DEFAULT_ARCHITECTURE_PROMPT;
  if (role === "qa") return DEFAULT_QA_PROMPT;
  return "You are a helpful AI assistant.";
}

/** `extraTools` lets a role inject tools that aren't in the DB `tools` list / registry
 *  (e.g. the QA agent's http_request + browser tools) without exposing them to every
 *  other agent's tool picker. */
export function buildMastraAgent(agentRow: AgentRow, extraTools?: Record<string, unknown>) {
  const toolset = buildToolSet(agentRow.tools);
  const model = resolveModel(agentRow.model ?? DEFAULT_MODEL);
  return new Agent({
    name: agentRow.agentKey,
    instructions: agentRow.systemPrompt ?? defaultPrompt(agentRow.role),
    model,
    tools: { ...toolset, ...(extraTools ?? {}) } as ConstructorParameters<typeof Agent>[0]["tools"],
  });
}

// ---------------------------------------------------------------------------
// RuntimeContext keys (shared across tools and the runner)
// ---------------------------------------------------------------------------

export interface AgentRuntime {
  orgId: string;
  actorId: string;
  actorName?: string;
  capabilityToken?: string;
  memoryScope?: string;
  /** AgentRun.id this invocation is running under — forwarded to
   *  check()/recordAudit() via AccessContext.runId so its audit rows are
   *  attributable to this exact run, not just this agent's shared actorId. */
  agentRunId?: string;
  /** Collects the `Source.id` of every fact `memory_read` returns in this run,
   *  so the brief it produces can record which sources it drew from
   *  (services/memory/brief-retirement.ts). Shared, not copied: every context a
   *  run builds gets the same set. */
  sourcesRead?: Set<string>;
}

export function buildRuntimeContext(values: AgentRuntime): AgentRuntimeContext {
  const rc = new RuntimeContext<AgentRuntimeValues>();
  rc.set("orgId", values.orgId);
  rc.set("actorId", values.actorId);
  if (values.actorName) rc.set("actorName", values.actorName);
  if (values.capabilityToken) rc.set("capabilityToken", values.capabilityToken);
  if (values.memoryScope) rc.set("memoryScope", values.memoryScope);
  if (values.agentRunId) rc.set("agentRunId", values.agentRunId);
  if (values.sourcesRead) rc.set("sourcesRead", values.sourcesRead);
  return rc;
}

// ---------------------------------------------------------------------------
// runCopyAgent — runs the copy agent and returns a structured draft
// ---------------------------------------------------------------------------

const DRAFT_OUTPUT_SCHEMA = z.object({
  subject: z.string().describe("Email subject line"),
  body: z.string().describe("Email body text — plain text, no HTML"),
});

export interface CopyAgentOptions {
  agentRow: AgentRow;
  contactName: string;
  contactTitle?: string | null;
  contactEmail?: string | null;
  accountName?: string | null;
  accountDomain?: string | null;
  campaignName?: string;
  icp?: string;
  tone?: string;
  orgName?: string;
  preferences?: DraftPreferences;
  orgId: string;
  capabilityToken: string;
  traceCtx: DraftTrace;
  /** AgentRun.id this call is running under, when the caller has one. */
  agentRunId?: string;
  onProgress?: (message: string) => void;
}

export async function runCopyAgent(opts: CopyAgentOptions): Promise<GeneratedDraft> {
  const agent = buildMastraAgent(opts.agentRow);
  const _s = opts.agentRow.settings;
  const memoryScope =
    _s != null && typeof _s === "object" && !Array.isArray(_s)
      ? ((_s as Record<string, unknown>).memoryScope as string | undefined)
      : undefined;
  const rc = buildRuntimeContext({
    orgId: opts.orgId,
    actorId: COPY_AGENT_ID,
    actorName: COPY_AGENT_NAME,
    capabilityToken: opts.capabilityToken,
    memoryScope,
    agentRunId: opts.agentRunId,
  });

  const prefs = opts.preferences ?? {};
  const promptParts: string[] = [
    `Draft an outreach email to ${opts.contactName}` +
      (opts.contactTitle ? ` (${opts.contactTitle})` : "") +
      (opts.accountName ? ` at ${opts.accountName}` : "") +
      ".",
    opts.campaignName ? `Campaign: "${opts.campaignName}".` : "",
    opts.icp ? `ICP: ${opts.icp}.` : "",
    prefs.toneOverride ? `Tone: ${prefs.toneOverride}.` : opts.tone ? `Tone: ${opts.tone}.` : "",
    prefs.preferredOpener ? `Opening style: ${prefs.preferredOpener}.` : "",
    prefs.forbiddenTopics ? `Do not mention: ${prefs.forbiddenTopics}.` : "",
    prefs.customInstruction ? prefs.customInstruction : "",
    opts.orgName ? `Sign off as ${prefs.signOffName ?? opts.orgName}.` : "",
  ].filter(Boolean);

  const prompt = promptParts.join(" ");

  // DraftContext used only for Langfuse logging (facts will come from memory_read tool).
  const draftCtx: DraftContext = {
    contactName: opts.contactName,
    contactTitle: opts.contactTitle,
    contactEmail: opts.contactEmail,
    accountName: opts.accountName,
    accountDomain: opts.accountDomain,
    campaignName: opts.campaignName,
    icp: opts.icp,
    tone: opts.tone,
    orgName: opts.orgName,
    facts: [], // agent retrieves facts via memory_read tool
    preferences: opts.preferences,
  };

  opts.onProgress?.("Reading memory for context…");
  return tracedGenerateDraft(draftCtx, opts.traceCtx, async () => {
    opts.onProgress?.("Drafting email…");
    const result = await agent.generate(prompt, {
      runtimeContext: rc,
      output: DRAFT_OUTPUT_SCHEMA,
    });
    const obj = (result as { object?: { subject: string; body: string } }).object;
    if (!obj?.subject || !obj?.body) {
      throw new Error("Copy agent did not return a valid { subject, body } object");
    }
    return {
      subject: obj.subject,
      body: obj.body,
      model: opts.agentRow.model ?? DEFAULT_MODEL,
      grounded: true, // assumed — agent used memory_read
    };
  });
}

// ---------------------------------------------------------------------------
// runHandoffAgent — generates a scoped briefing document from memory, bounded to
// whatever the caller's capability token grants.
// ---------------------------------------------------------------------------

export const HANDOFF_OUTPUT_SCHEMA = z.object({
  title: z.string().describe("Title of the briefing document"),
  summary: z.string().describe("2-3 sentence overview of what this person needs to know"),
  sections: z
    .array(
      z.object({
        heading: z.string(),
        content: z.string(),
      }),
    )
    .describe(
      "Structured sections of the briefing (e.g. Architecture & decisions, Product context, Team conventions). Omit a section entirely if memory has nothing relevant for it.",
    ),
  diagram: z
    .string()
    .optional()
    .describe(
      "Optional Mermaid diagram syntax (e.g. graph/flowchart/sequenceDiagram) if a visual would help — e.g. architecture, system flow, or process steps found in memory. Omit entirely if nothing in the briefing warrants one; do not invent a diagram just to fill this field.",
    ),
  focusAreas: z
    .array(
      z.object({
        label: z
          .string()
          .describe("A focus area / topic to prioritize when onboarding (drawn from the sections you actually wrote)"),
        weight: z
          .number()
          .describe(
            "Relative onboarding emphasis, higher = spend attention here sooner. Only rank areas the retrieved context genuinely supports ranking.",
          ),
      }),
    )
    .optional()
    .describe(
      "Optional ranked onboarding focus areas, grounded in what you retrieved — renders a priority chart. Omit entirely if you can't ground a ranking; do not manufacture one to fill this field.",
    ),
  rampPlan: z
    .array(
      z.object({
        milestone: z.string().describe("What this person should be able to do / know by this point"),
        week: z
          .string()
          .optional()
          .describe("A coarse time label (e.g. 'Week 1'), only when a sequence is genuinely warranted"),
      }),
    )
    .optional()
    .describe(
      "Optional sequenced onboarding ramp — renders a timeline. Omit entirely unless the briefing has a genuine sequence of steps; do not invent one.",
    ),
});

export type HandoffBrief = z.infer<typeof HANDOFF_OUTPUT_SCHEMA>;

// The single-agent run's structuring schema: each section also names the labels of the
// retrieved facts it rests on (services/agents/retrieved-facts.ts). The labels never
// reach a stored brief; runHandoffAgent turns them into citations and strips them.
const CITED_HANDOFF_OUTPUT_SCHEMA = HANDOFF_OUTPUT_SCHEMA.extend({
  sections: z
    .array(
      z.object({
        heading: z.string(),
        content: z.string(),
        citations: z
          .array(z.string())
          .optional()
          .describe(
            "Labels (F1, F2, ...) of the retrieved facts this section rests on. Only labels from the list you were given.",
          ),
      }),
    )
    .describe(HANDOFF_OUTPUT_SCHEMA.shape.sections.description ?? ""),
});

/** A handoff brief plus the facts its sections cite, ready for createBrief(). */
export type CitedHandoffBrief = HandoffBrief & { citations: BriefCitationInput[] };

// diagrams.net (draw.io) can load a diagram directly from Mermaid syntax via the
// documented `#create={"type":"mermaid","data":"..."}` hash parameter (confirmed
// against https://www.drawio.com/doc/faq/supported-url-parameters — Mermaid is a
// first-class `type`, not a manual "Extras > Edit Diagram" paste). The hash stays
// client-side (never sent to a server) but is still bounded by practical URL
// length limits, so skip the link (keep the diagram field, inline-render it) if
// the encoded payload would be unreasonably long rather than ship a link that
// silently breaks in some browsers/proxies.
const DRAWIO_URL_SAFE_LIMIT = 8000;

export function drawioLinkFromMermaid(diagram: string): string | null {
  const payload = encodeURIComponent(JSON.stringify({ type: "mermaid", data: diagram }));
  const url = `https://app.diagrams.net/#create=${payload}`;
  return url.length <= DRAWIO_URL_SAFE_LIMIT ? url : null;
}

export interface HandoffAgentOptions {
  agentRow: AgentRow;
  /** Name of the person being briefed (contractor, freelancer, new hire). */
  granteeName: string;
  /** e.g. "Contractor", "New engineer" — used to frame the prompt. */
  granteeRole?: string;
  /** Human-readable description of what they're onboarding into, if known. */
  context?: string;
  orgId: string;
  /** Already provisioned via provisionHandoffAgentCapability, scoped to the grant. */
  capabilityToken: string;
  /** Scope path/name to retrieve from — matches the grant, not the org root. */
  memoryScope?: string;
  /** Filled with the source of every fact the run's `memory_read` calls return.
   *  Complete only with the real `memory_read`, so never pass it with `extraTools`. */
  sourcesRead?: Set<string>;
  onProgress?: (message: string) => void;
  /** Tool overrides, same mechanism `buildMastraAgent` already exposes for the QA
   *  agent's http_request/browser tools. Only set by an eval harness
   *  to substitute a fixed golden-set `memory_read` stub
   *  for the real DB-backed tool, so a quality eval can exercise the real agent +
   *  LLM without live Postgres/Neo4j. Never set on a production call path. */
  extraTools?: Record<string, unknown>;
}

export async function runHandoffAgent(opts: HandoffAgentOptions): Promise<CitedHandoffBrief> {
  const agent = buildMastraAgent(opts.agentRow, opts.extraTools);
  const rc = buildRuntimeContext({
    orgId: opts.orgId,
    actorId: HANDOFF_AGENT_ID,
    actorName: HANDOFF_AGENT_NAME,
    capabilityToken: opts.capabilityToken,
    memoryScope: opts.memoryScope,
    sourcesRead: opts.sourcesRead,
  });
  const retrieved = new RetrievedFacts();
  rc.set("retrievedFacts", retrieved);

  const prompt =
    `Generate an onboarding briefing for ${opts.granteeName}` +
    (opts.granteeRole ? ` (${opts.granteeRole})` : "") +
    "." +
    (opts.context ? ` Context: ${opts.context}.` : "") +
    " Use memory_read to retrieve everything relevant before writing the briefing.";

  const model = opts.agentRow.model ?? DEFAULT_MODEL;
  const trace = startAgentTrace({
    name: "handoff-agent-run",
    userId: opts.orgId,
    metadata: { orgId: opts.orgId, granteeName: opts.granteeName, granteeRole: opts.granteeRole },
    tags: ["handoff-agent"],
  });

  try {
    opts.onProgress?.("Reading memory within the granted scope…");
    // Two calls on purpose (same reason as runQaAgent): forcing a structured `output`
    // puts the model in JSON mode, which unreliably DISABLES tool use — so a single
    // {output} call can leave the agent unable to call memory_read and it produces a
    // "no retrievable memory" brief. (1) retrieve WITH tools, no schema.
    const acted = await tracedGeneration(
      trace,
      { name: "handoff-agent-act", model, input: { prompt } },
      () => agent.generate(prompt, { runtimeContext: rc, maxSteps: 12 }),
      (r) => ({ text: (r as { text?: string }).text ?? "" }),
    );
    const observations = (acted as { text?: string }).text ?? "";
    const labelledFacts = retrieved.promptBlock();
    opts.onProgress?.("Writing the briefing…");
    // (2) structure those retrieved facts into the briefing schema — no tools needed.
    const result = await tracedGeneration(
      trace,
      { name: "handoff-agent-structure", model, input: { observations } },
      () =>
        agent.generate(
          `Based ONLY on what you retrieved from memory below, write the onboarding briefing. Ground every point in the retrieved facts; never invent facts, systems, or people.\n\nRetrieved context:\n${observations}` +
            (labelledFacts
              ? `\n\nRetrieved facts, by label:\n${labelledFacts}\n\nFor each section, list in "citations" the labels of the facts it rests on.`
              : ""),
          { runtimeContext: rc, output: CITED_HANDOFF_OUTPUT_SCHEMA },
        ),
      (r) => (r as { object?: unknown }).object,
    );
    const obj = (result as { object?: z.infer<typeof CITED_HANDOFF_OUTPUT_SCHEMA> }).object;
    if (!obj) {
      throw new Error("Handoff agent did not return a valid briefing object");
    }
    const sections = obj.sections.map(({ heading, content }) => ({ heading, content }));
    return {
      ...obj,
      sections,
      citations: boundCitations(retrieved.citationsFor(obj.sections), sections.length),
    };
  } finally {
    await flushAgentTrace();
  }
}

// ---------------------------------------------------------------------------
// runArchitectureAgent (UC7) — plans architecture + schedule from confirmed facts
// in the granted scope, and flags contradictions found among retrieved facts.
// Mirrors runHandoffAgent; bounded to whatever the caller's capability token grants.
// ---------------------------------------------------------------------------

const ARCHITECTURE_OUTPUT_SCHEMA = z.object({
  title: z.string().describe("Title of the architecture / plan document"),
  summary: z.string().describe("2-3 sentence overview of the proposed architecture and plan"),
  sections: z
    .array(
      z.object({
        heading: z.string(),
        content: z.string(),
      }),
    )
    .describe(
      "Structured sections of the plan (e.g. System design, Data model, Constraints & non-goals, Open questions), each grounded in retrieved facts. Omit a section entirely if memory has nothing relevant for it.",
    ),
  diagram: z
    .string()
    .optional()
    .describe(
      "Optional Mermaid diagram syntax (architecture, data flow, sequence) if a visual would help. Omit entirely if nothing in the plan warrants one; do not invent a diagram just to fill this field.",
    ),
  milestones: z
    .array(
      z.object({
        label: z.string().describe("What this milestone delivers"),
        dueDate: z.string().optional().describe("ISO date, only if justifiable from retrieved constraints/deadlines"),
      }),
    )
    .optional()
    .describe("Delivery schedule, if one is warranted. Omit entirely if there is nothing to schedule."),
  contradictions: z
    .array(
      z.object({
        factA: z.string().describe("The first conflicting fact, as retrieved"),
        factB: z.string().describe("The second conflicting fact, as retrieved"),
        note: z.string().describe("One line on why these two facts contradict"),
      }),
    )
    .optional()
    .describe(
      "Genuine contradictions found among retrieved facts. Omit entirely if none were found; do not manufacture conflicts.",
    ),
});

export type ArchitecturePlan = z.infer<typeof ARCHITECTURE_OUTPUT_SCHEMA>;

export interface ArchitectureAgentOptions {
  agentRow: AgentRow;
  /** Human-readable description of what to plan (e.g. "the payments service rearchitecture"). */
  title?: string;
  /** Extra framing/context for the plan, if the caller supplied any. */
  context?: string;
  orgId: string;
  /** Already provisioned via provisionArchitectureAgentCapability, scoped to the grant. */
  capabilityToken: string;
  /** Scope path/name to retrieve from — matches the grant, not the org root. */
  memoryScope?: string;
  onProgress?: (message: string) => void;
  /** Tool overrides — same mechanism as `HandoffAgentOptions.extraTools`, only set
   *  by an eval harness. Never set on a production call
   *  path. */
  extraTools?: Record<string, unknown>;
}

export async function runArchitectureAgent(opts: ArchitectureAgentOptions): Promise<ArchitecturePlan> {
  const agent = buildMastraAgent(opts.agentRow, opts.extraTools);
  const rc = buildRuntimeContext({
    orgId: opts.orgId,
    actorId: ARCHITECTURE_AGENT_ID,
    actorName: ARCHITECTURE_AGENT_NAME,
    capabilityToken: opts.capabilityToken,
    memoryScope: opts.memoryScope,
  });

  const prompt =
    `Produce an architecture and delivery plan${opts.title ? ` for ${opts.title}` : ""}.` +
    (opts.context ? ` Context: ${opts.context}.` : "") +
    " Use memory_read to retrieve the confirmed decisions, constraints, system design, UX/UI, and business logic before planning. Ground every part of the plan in what you retrieve, and flag any contradictions you find among the retrieved facts.";

  const model = opts.agentRow.model ?? DEFAULT_MODEL;
  const trace = startAgentTrace({
    name: "architecture-agent-run",
    userId: opts.orgId,
    metadata: { orgId: opts.orgId, title: opts.title },
    tags: ["architecture-agent"],
  });

  try {
    opts.onProgress?.("Reading memory within the granted scope…");
    // Two calls on purpose (same reason as runQaAgent): a single structured-`output`
    // call puts the model in JSON mode that unreliably DISABLES tool use, so the agent
    // can't call memory_read and returns a "no retrievable memory" plan (~50% of runs
    // observed). (1) retrieve + reason WITH tools, no schema.
    const acted = await tracedGeneration(
      trace,
      { name: "architecture-agent-act", model, input: { prompt } },
      () => agent.generate(prompt, { runtimeContext: rc, maxSteps: 16 }),
      (r) => ({ text: (r as { text?: string }).text ?? "" }),
    );
    const observations = (acted as { text?: string }).text ?? "";
    opts.onProgress?.("Writing the plan…");
    // (2) structure the retrieved facts + analysis into the plan schema — no tools needed.
    const result = await tracedGeneration(
      trace,
      { name: "architecture-agent-structure", model, input: { observations } },
      () =>
        agent.generate(
          `Based ONLY on what you retrieved from memory below, produce the architecture and delivery plan, and flag any genuine contradictions among the retrieved facts. Ground every part in the retrieved facts; never invent technologies, requirements, or milestones.\n\nRetrieved context:\n${observations}`,
          { runtimeContext: rc, output: ARCHITECTURE_OUTPUT_SCHEMA },
        ),
      (r) => (r as { object?: ArchitecturePlan }).object,
    );
    const obj = (result as { object?: ArchitecturePlan }).object;
    if (!obj) {
      throw new Error("Architecture agent did not return a valid plan object");
    }
    return obj;
  } finally {
    await flushAgentTrace();
  }
}

// ---------------------------------------------------------------------------
// runQaAgent (UC8) — black-box tests a running product. "api" mode drives an API via the
// http_request tool; "browser" mode also drives a browser (Playwright in a Vercel Sandbox),
// dynamically loaded only when mode="browser" so its heavy deps never enter the module
// graph of the common path. Returns a structured QA report (bugs + perf + suggestions).
// ---------------------------------------------------------------------------

const QA_OUTPUT_SCHEMA = z.object({
  title: z.string().describe("Short title for this QA run (e.g. 'API smoke + edge probe: acme.com')"),
  summary: z.string().describe("2-4 sentence overall verdict of the product's health"),
  verdict: z
    .enum(["healthy", "issues_found", "broken", "could_not_test"])
    .describe(
      "healthy = no material issues; issues_found = bugs but core works; broken = core flows fail; could_not_test = target unreachable / ran out of steps",
    ),
  bugs: z
    .array(
      z.object({
        severity: z.enum(["blocker", "major", "minor"]).describe("Technical impact of the defect if it occurs"),
        priority: z
          .enum(["high", "medium", "low"])
          .optional()
          .describe(
            "How urgently it should be fixed given business/user impact — distinct from severity (a cosmetic bug on a signup page can be low severity but high priority)",
          ),
        technique: z
          .string()
          .optional()
          .describe(
            "Test-design technique that surfaced this (e.g. boundary value, equivalence partitioning, state transition, auth boundary)",
          ),
        finding: z.string().describe("What is wrong"),
        repro: z.string().describe("Exact request(s) or steps to reproduce — replayable"),
        observed: z.string().describe("What actually happened"),
        expected: z.string().describe("What should have happened"),
      }),
    )
    .describe("Defects found, ordered most-severe first. Empty array if none."),
  performance: z
    .array(
      z.object({
        endpoint: z.string().describe("Endpoint or page exercised (method + path)"),
        samples: z.number().int().describe("How many requests this is based on"),
        p50LatencyMs: z.number().describe("Median observed latency in ms"),
        maxLatencyMs: z.number().describe("Worst observed latency in ms"),
        errorRate: z.number().describe("Fraction of requests that errored (0-1)"),
      }),
    )
    .describe("Observed performance per endpoint/page, from your own requests. Empty if nothing was measured."),
  suggestions: z.array(z.string()).describe("Concrete, actionable improvement suggestions."),
  unmeasurable: z
    .array(z.string())
    .optional()
    .describe(
      "Things that could not be checked black-box (e.g. server memory/CPU with no metrics endpoint). Be honest here instead of guessing.",
    ),
});

export type QaReport = z.infer<typeof QA_OUTPUT_SCHEMA>;

export interface QaTarget {
  /** Base URL of the product under test (e.g. https://api.acme.com). */
  baseUrl: string;
  /** Extra hosts the run may reach (defaults to just baseUrl's host). */
  allowedHosts?: string[];
  /** Optional OpenAPI/Swagger URL to seed endpoint discovery. */
  openApiUrl?: string;
  /** Optional Authorization header value applied to every request (e.g. "Bearer …"). */
  authHeader?: string;
}

export interface QaAgentOptions {
  agentRow: AgentRow;
  orgId: string;
  /** Provisioned via provisionQaAgentCapability, scoped to the grant (for spec/focus reads).
   *  Optional: a pure black-box run against a URL needs no memory scope — when absent, the
   *  memory_read tool is dropped and the agent tests from the target alone. */
  capabilityToken?: string;
  /** Scope path to retrieve specs/focus from — matches the grant, not the org root. */
  memoryScope?: string;
  target: QaTarget;
  /** Free-text focus for this run ("check the checkout flow", "hammer /search"). */
  focus?: string;
  /** "api" (default) or "browser" (Playwright in a sandbox). */
  mode?: "api" | "browser";
  onProgress?: (message: string) => void;
}

function buildQaPrompt(opts: QaAgentOptions, mode: "api" | "browser"): string {
  const parts = [
    `Black-box test the product at ${opts.target.baseUrl} in ${mode} mode.`,
    opts.target.openApiUrl
      ? `An API description is available at ${opts.target.openApiUrl} — fetch it first to discover endpoints.`
      : "",
    opts.focus ? `Focus for this run: ${opts.focus}.` : "",
    mode === "browser"
      ? "Use the browser_* tools to navigate and interact like a real user."
      : "Use the http_request tool to exercise endpoints.",
    opts.capabilityToken
      ? "If memory_read is available, retrieve any stored specs, acceptance criteria, or focus for this product and check against them."
      : "",
    "Explore first, then probe for defects, then report bugs (with exact repro), the performance you observed, and concrete suggestions.",
  ];
  return parts.filter(Boolean).join(" ");
}

export async function runQaAgent(opts: QaAgentOptions): Promise<QaReport> {
  const mode = opts.mode ?? "api";
  const allowedHosts = Array.from(new Set([new URL(opts.target.baseUrl).host, ...(opts.target.allowedHosts ?? [])]));

  // Every QA run gets http_request. Browser mode adds Playwright tools, dynamically
  // imported so their deps never load on the API path (or if uninstalled). `effectiveMode`
  // tracks what tools the agent ACTUALLY has after any fallback, so the prompt + step budget
  // never reference browser tools that failed to load.
  let effectiveMode: "api" | "browser" = mode;
  const extraTools: Record<string, unknown> = { http_request: httpRequestTool };
  let closeBrowser: (() => Promise<void>) | undefined;
  if (mode === "browser") {
    opts.onProgress?.("Booting browser…");
    try {
      const { createBrowserTools } = await import("./qa-browser");
      const browser = await createBrowserTools({ baseUrl: opts.target.baseUrl, allowedHosts });
      Object.assign(extraTools, browser.tools);
      closeBrowser = browser.close;
    } catch (e) {
      // Graceful degrade: if Playwright/Chromium isn't available, fall back to API mode
      // rather than failing the whole run — and tell the user why.
      effectiveMode = "api";
      opts.onProgress?.(`Browser mode unavailable (${e instanceof Error ? e.message : e}); falling back to API mode.`);
    }
  }

  // No capability → pure black-box run: strip memory_read so the agent doesn't waste a step
  // on a tool that can't authenticate.
  const rowForRun = opts.capabilityToken
    ? opts.agentRow
    : { ...opts.agentRow, tools: opts.agentRow.tools.filter((t) => t !== "memory_read") };

  const agent = buildMastraAgent(rowForRun, extraTools);
  const rc = buildRuntimeContext({
    orgId: opts.orgId,
    actorId: QA_AGENT_ID,
    actorName: QA_AGENT_NAME,
    capabilityToken: opts.capabilityToken,
    memoryScope: opts.memoryScope,
  });
  rc.set("qaTargetBaseUrl", opts.target.baseUrl);
  rc.set("qaAllowedHosts", allowedHosts);
  if (opts.target.authHeader) rc.set("qaAuthHeader", opts.target.authHeader);

  const qaModel = rowForRun.model ?? DEFAULT_MODEL;
  const trace = startAgentTrace({
    name: "qa-agent-run",
    userId: opts.orgId,
    metadata: { orgId: opts.orgId, targetBaseUrl: opts.target.baseUrl, mode: effectiveMode, focus: opts.focus },
    tags: ["qa-agent"],
  });

  try {
    opts.onProgress?.(effectiveMode === "browser" ? "Driving the product in a browser…" : "Exercising the API…");
    // Two calls on purpose: forcing a structured `output` puts the model in JSON mode,
    // which DISABLES tool use — so a single call with both `maxSteps` and `output` leaves
    // the agent with no http_request/browser tools and it can't touch the target.
    // (1) act→observe WITH tools, no output schema — the model actually drives the run.
    const prompt = buildQaPrompt(opts, effectiveMode);
    const acted = await tracedGeneration(
      trace,
      { name: "qa-agent-act", model: qaModel, input: { prompt } },
      () => agent.generate(prompt, { runtimeContext: rc, maxSteps: effectiveMode === "browser" ? 60 : 40 }),
      (r) => ({ text: (r as { text?: string }).text ?? "" }),
    );
    const observations = (acted as { text?: string }).text ?? "";
    // (2) structure those observations into the report schema — no tools needed here.
    const result = await tracedGeneration(
      trace,
      { name: "qa-agent-structure", model: qaModel, input: { observations } },
      () =>
        agent.generate(
          `Based ONLY on your observations below, produce the QA report. Never claim a result you did not observe.\n\nObservations:\n${observations}`,
          { runtimeContext: rc, output: QA_OUTPUT_SCHEMA },
        ),
      (r) => (r as { object?: QaReport }).object,
    );
    const obj = (result as { object?: QaReport }).object;
    if (!obj) throw new Error("QA agent did not return a valid report object");
    return obj;
  } finally {
    opts.onProgress?.("Tearing down…");
    await closeBrowser?.();
    await flushAgentTrace();
  }
}

// ---------------------------------------------------------------------------
// runProspectResearch — structured research for a single prospect query
// ---------------------------------------------------------------------------

const PROSPECT_SCHEMA = z.object({
  contact: z.object({
    name: z.string(),
    title: z.string().optional(),
    email: z.string().optional(),
    linkedin: z.string().optional(),
  }),
  // account is optional — some contacts are independent (retired, freelance, etc.)
  account: z
    .object({
      name: z.string().optional(),
      domain: z.string().optional(),
      industry: z.string().optional(),
      description: z.string().optional(),
    })
    .optional(),
  findings: z.array(z.string()).describe("Key facts about this person/company for memory"),
  confidence: z.enum(["high", "medium", "low"]),
});

export type ProspectResearchResult = z.infer<typeof PROSPECT_SCHEMA>;

export interface ProspectResearchOptions {
  agentRow: AgentRow;
  query: string;
  orgId: string;
}

export async function runProspectResearch(opts: ProspectResearchOptions): Promise<ProspectResearchResult> {
  const agent = buildMastraAgent(opts.agentRow);
  const rc = buildRuntimeContext({
    orgId: opts.orgId,
    actorId: RESEARCH_AGENT_ID,
    actorName: RESEARCH_AGENT_NAME,
  });

  const prompt =
    `Research ${opts.query}. Find the person's name, title, and email if available. ` +
    `If they work at a company, include the company name, domain, and industry. ` +
    `If they are independent (retired, freelance, advisor with no current company), leave the account field empty. ` +
    `Return 3-5 key facts that would help write a personalised outreach email.`;

  const result = await agent.generate(prompt, {
    runtimeContext: rc,
    output: PROSPECT_SCHEMA,
  });
  const obj = (result as { object?: ProspectResearchResult }).object;
  if (!obj) {
    throw new Error("Prospect research agent did not return a valid structured result");
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Available tools list (for the UI tool picker)
// ---------------------------------------------------------------------------

export { TOOL_META, TOOL_REGISTRY, type ToolKey } from "./tools";
export const AVAILABLE_TOOL_KEYS = Object.keys(TOOL_REGISTRY) as (keyof typeof TOOL_REGISTRY)[];

/** Default tool sets per role — used when seeding agents. */
export const DEFAULT_TOOLS: Record<string, string[]> = {
  research: ["web_search", "scrape", "memory_write"],
  copy: ["memory_read"],
  handoff: ["memory_read"],
  architecture: ["memory_read"],
  // http_request + browser tools are injected by runQaAgent, not listed here; memory_read
  // lets QA check the product against any stored specs/acceptance criteria/focus.
  qa: ["memory_read"],
  custom: [],
};
