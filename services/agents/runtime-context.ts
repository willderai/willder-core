// The typed contract for every key that rides an agent's Mastra RuntimeContext —
// both the caller identity buildRuntimeContext() (runner.ts) sets, and the
// QA-specific values manager.ts/manager-arch.ts/run-loop.ts add afterward for
// qa-tools.ts's http_request tool.
//
// Mastra's own RuntimeContext<Values> checks .get()/.set() keys and value types
// against Values at compile time (see @mastra/core's runtime-context/index.d.ts).
// Every call site uses this typed context, never the untyped default
// (`RuntimeContext`, i.e. `RuntimeContext<unknown>`), whose .get() returns
// `unknown` and invites an `as string | undefined` cast: a rename or typo on
// either side of such a cast compiles clean and silently produces a null value
// at the audit row. With the typed contract a missing or renamed key is a
// compile error, on the read side or the write side, for every key.
//
// This does NOT replace the behavioral tests
// (services/agents/run-correlation.test.ts,
// app/api/agents/[id]/run/route.runcorrelation.test.ts) — a typed key proves
// the two sides agree on a name and a shape, not that a real run's value
// actually reaches the audit row. Both kinds of test stay.
import { RuntimeContext } from "@mastra/core/runtime-context";
import type { RetrievedFacts } from "./retrieved-facts";
import type { AgentRuntime } from "./runner";

// AgentRuntime (runner.ts) is the *construction*-time contract: buildRuntimeContext()
// requires orgId/actorId as arguments and always calls rc.set() for both, no `if` guard.
// AgentRuntimeValues is the *read*-time contract instead — what a consumer's
// runtimeContext.get() can actually come back with — and those aren't the same
// guarantee: Mastra's RuntimeContext.get() returns undefined for any key nothing has
// set, regardless of the declared Values type, so a context that didn't go through
// buildRuntimeContext (or one read before it runs) makes orgId/actorId absent too.
// Typing AgentRuntimeValues as a plain `extends AgentRuntime` would make orgId/actorId
// non-optional here and tell the compiler a guarantee only one specific caller upholds —
// so the `if (!orgId || !capabilityToken)` guard in tools.ts's consumers would look like
// dead code to any cleanup, even though it is genuinely load-bearing at runtime.
// `Partial<AgentRuntime>` makes every key here optional, the same pattern as the QA keys
// below, so the read side does not overclaim.
export interface AgentRuntimeValues extends Partial<AgentRuntime> {
  /** QA-agent black-box target, set by manager.ts/manager-arch.ts/run-loop.ts
   *  after buildRuntimeContext(), read by qa-tools.ts's http_request tool. */
  qaTargetBaseUrl?: string;
  qaAllowedHosts?: string[];
  qaAuthHeader?: string;
  /** Where tools.ts's memory_read records what it returned, set by a run that cites
   *  its facts (runner.ts runHandoffAgent). Absent on every other run. */
  retrievedFacts?: RetrievedFacts;
}

/** The typed RuntimeContext every agent call site uses in place of a bare
 *  `RuntimeContext` from "@mastra/core/runtime-context". */
export type AgentRuntimeContext = RuntimeContext<AgentRuntimeValues>;
