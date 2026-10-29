// Pins the typed-RuntimeContext contract.
//
// Every `runtimeContext.get(key)` goes through a real generic
// (`RuntimeContext<AgentRuntimeValues>`), never an `as string | undefined`
// cast, so a renamed, misspelled or wrongly-typed key is a compile error on the
// write side AND the read side. That guarantee is load-bearing for the audit
// trail rather than cosmetic: an `agentRunId` that silently arrives `undefined`
// at the audit row renders an EMPTY trail, which reads as a correctly-scoped
// result rather than a broken one.
//
// Nothing else pins the guarantee: adding `[key: string]: unknown` to
// `AgentRuntimeValues` — an ordinary-looking change, e.g. to let a caller stash
// an ad-hoc value — widens `keyof AgentRuntimeValues` back to `string`, removes
// the key check at every call site, and leaves BOTH `tsc --noEmit` and the
// full suite green.
//
// The `@ts-expect-error` directives below are that pin. Each one fails
// `tsc --noEmit` with "Unused '@ts-expect-error' directive" the moment the key
// check stops rejecting what it is supposed to reject. This is therefore a
// COMPILE-TIME test: `npx tsc --noEmit` is what actually executes it, and a
// green `vitest` run alone does not. The runtime block at the bottom is the
// separate, ordinary half — it keeps the file honest that the real values still
// round-trip, since a type that type-checks is not the same as a value that
// arrives.
import { describe, expect, it } from "vitest";
import { buildRuntimeContext } from "./runner";
import type { AgentRuntimeContext } from "./runtime-context";

describe("AgentRuntimeContext key contract (compile-time)", () => {
  it("rejects an unknown key on the write side", () => {
    const rc: AgentRuntimeContext = buildRuntimeContext({ orgId: "org_1", actorId: "actor_1" });

    // @ts-expect-error — a misspelled/renamed key must not be settable: the
    // producer half of the gap, runner.ts writing a key that nothing reads.
    rc.set("agentRunIdd", "run_1");

    expect(rc.get("agentRunId")).toBeUndefined();
  });

  it("rejects an unknown key on the read side", () => {
    const rc: AgentRuntimeContext = buildRuntimeContext({
      orgId: "org_1",
      actorId: "actor_1",
      agentRunId: "run_1",
    });

    // @ts-expect-error — the consumer half: tools.ts reading a key nobody writes,
    // which is what silently produced a null runId on the audit row.
    rc.get("agentRunIdd");

    expect(rc.get("agentRunId")).toBe("run_1");
  });

  it("rejects a wrong value type on a known key", () => {
    const rc: AgentRuntimeContext = buildRuntimeContext({ orgId: "org_1", actorId: "actor_1" });

    // @ts-expect-error — qaAllowedHosts is string[], not string. A bare string
    // would make qa-tools.ts's host allow-list iterate characters instead of hosts.
    rc.set("qaAllowedHosts", "api.acme.com");

    // @ts-expect-error — capabilityToken is a string, not an object.
    rc.set("capabilityToken", { token: "cap_1" });

    expect(rc.get("qaAllowedHosts")).toBe("api.acme.com");
  });
});

describe("AgentRuntimeContext values (runtime)", () => {
  it("round-trips every identity key buildRuntimeContext sets", () => {
    const rc = buildRuntimeContext({
      orgId: "org_1",
      actorId: "actor_1",
      actorName: "Research Agent",
      capabilityToken: "cap_1",
      memoryScope: "scope_1",
      agentRunId: "run_1",
    });

    expect(rc.get("orgId")).toBe("org_1");
    expect(rc.get("actorId")).toBe("actor_1");
    expect(rc.get("actorName")).toBe("Research Agent");
    expect(rc.get("capabilityToken")).toBe("cap_1");
    expect(rc.get("memoryScope")).toBe("scope_1");
    expect(rc.get("agentRunId")).toBe("run_1");
  });

  it("leaves an omitted optional key genuinely unset rather than empty-string", () => {
    // buildRuntimeContext guards every optional with `if (values.x)`, so an
    // omitted key must be absent, not present-and-falsy. agentContextFromRuntime
    // forwards this straight into AccessContext.runId, and `""` would be stamped
    // onto the audit row as a real-looking run id that matches no AgentRun.
    const rc = buildRuntimeContext({ orgId: "org_1", actorId: "actor_1" });

    expect(rc.get("agentRunId")).toBeUndefined();
    expect(rc.get("capabilityToken")).toBeUndefined();
    expect(rc.get("memoryScope")).toBeUndefined();
    expect(rc.has("agentRunId")).toBe(false);
  });

  it("does not silently coerce an empty agentRunId into the context", () => {
    // Same falsy-guard path from the other direction: an explicitly empty run id
    // must not land as `""`. Audit rows key off this exact value.
    const rc = buildRuntimeContext({ orgId: "org_1", actorId: "actor_1", agentRunId: "" });

    expect(rc.get("agentRunId")).toBeUndefined();
    expect(rc.has("agentRunId")).toBe(false);
  });
});
