// Langfuse observability singleton. Wraps every LLM generation any of the five
// agents (research/copy/handoff/architecture/qa) makes so they appear in the
// Langfuse dashboard under the org's tenant context. All three env vars are
// required for tracing to fire; if any are missing the helpers below no-op
// silently so the app doesn't crash in environments without Langfuse set up.
import Langfuse from "langfuse";
import type { DraftContext, GeneratedDraft } from "./agents/draft-types";

let _lf: Langfuse | null = null;
function getLangfuse(): Langfuse | null {
  if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) return null;
  if (!_lf) {
    _lf = new Langfuse({
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      baseUrl: process.env.LANGFUSE_BASEURL,
      flushAt: 1,
    });
  }
  return _lf;
}

export interface DraftTrace {
  orgId: string;
  campaignId?: string;
  contactId?: string;
}

// ---------------------------------------------------------------------------
// Shared trace/generation helpers — every agent role wraps its LLM call(s)
// through these two functions so tracing behaves identically across roles.
// ---------------------------------------------------------------------------

/** Opaque handle for one open Langfuse trace. Null when Langfuse isn't configured. */
export type AgentTrace = ReturnType<Langfuse["trace"]> | null;

export interface StartAgentTraceOptions {
  name: string;
  userId: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

/** Open one Langfuse trace to hang one or more generation spans off of.
 *  No-ops (returns null) if Langfuse is not configured. */
export function startAgentTrace(opts: StartAgentTraceOptions): AgentTrace {
  const lf = getLangfuse();
  if (!lf) return null;
  return lf.trace({ name: opts.name, userId: opts.userId, metadata: opts.metadata, tags: opts.tags });
}

export interface RecordGenerationOptions {
  name: string;
  model: string;
  input: unknown;
}

/**
 * Wrap one LLM call as a Langfuse generation span under `trace`. A no-op
 * passthrough (just calls `generate`) when `trace` is null, i.e. Langfuse
 * isn't configured. The generation is always ended — ERROR level with the
 * error message on throw, DEFAULT level with `toOutput(result)` on success —
 * and the underlying error is always rethrown.
 */
export async function tracedGeneration<T>(
  trace: AgentTrace,
  opts: RecordGenerationOptions,
  generate: () => Promise<T>,
  toOutput: (result: T) => unknown,
): Promise<T> {
  if (!trace) return generate();

  const generation = trace.generation({ name: opts.name, model: opts.model, input: opts.input });
  try {
    const result = await generate();
    await generation.end({ output: toOutput(result), level: "DEFAULT" });
    return result;
  } catch (err) {
    await generation.end({ level: "ERROR", statusMessage: String(err) });
    throw err;
  }
}

/**
 * Flush a trace's queued events before the caller returns.
 *
 * Deliberately calls the SDK's `shutdownAsync()`, not `flushAsync()`. With
 * `flushAt: 1` (this file's config), every individual event triggers its own
 * background HTTP flush whose in-flight promise is tracked only in the SDK's
 * internal `pendingIngestionPromises` map — and `flushAsync()` does not await
 * that map before resolving (verified live against the real Langfuse project
 * this file talks to: a bare `await lf.flushAsync()` can resolve while 3
 * ingestion requests are still in flight, and the events are lost if the
 * process exits before they land). `shutdownAsync()` explicitly awaits
 * `pendingIngestionPromises` — without it a deployment records zero traces:
 * on a Vercel serverless function, the execution can be frozen right after
 * the response
 * is sent, killing exactly those in-flight requests. `shutdownAsync()` is
 * safe to call repeatedly on the same cached singleton client — it does not
 * close the client or block later traces (verified: two traces emitted and
 * shut down back to back on one instance both landed).
 */
export async function flushAgentTrace(): Promise<void> {
  const lf = getLangfuse();
  if (lf) await lf.shutdownAsync();
}

/**
 * Wrap a draft generation call with a Langfuse trace.
 * Records the full prompt context as input and the generated draft as output.
 * No-ops if Langfuse is not configured.
 */
export async function tracedGenerateDraft(
  ctx: DraftContext,
  meta: DraftTrace,
  generate: () => Promise<GeneratedDraft>,
): Promise<GeneratedDraft> {
  const trace = startAgentTrace({
    name: "draft-generation",
    userId: meta.orgId,
    metadata: {
      orgId: meta.orgId,
      campaignId: meta.campaignId,
      contactId: meta.contactId,
      grounded: ctx.facts.length > 0,
      factCount: ctx.facts.length,
    },
    tags: ["copy-agent", "outreach-draft"],
  });

  try {
    return await tracedGeneration(
      trace,
      {
        name: "copy-agent-draft",
        model: process.env.OPENAI_MODEL_GENERATE ?? "gpt-4o-mini",
        input: {
          contactName: ctx.contactName,
          contactTitle: ctx.contactTitle,
          accountName: ctx.accountName,
          campaignName: ctx.campaignName,
          icp: ctx.icp,
          tone: ctx.tone,
          factCount: ctx.facts.length,
          facts: ctx.facts.map((f) => f.fact),
        },
      },
      generate,
      (result) => ({ subject: result.subject, body: result.body }),
    );
  } finally {
    await flushAgentTrace();
  }
}
