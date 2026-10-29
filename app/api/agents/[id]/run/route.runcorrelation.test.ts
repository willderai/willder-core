import { beforeEach, describe, expect, it, vi } from "vitest";

// The TOP hop of the run-correlation chain: this route creating an AgentRun and
// handing that row's own id to runCopyAgent as agentRunId.
//
// services/agents/run-correlation.test.ts covers everything below this point
// (runCopyAgent -> buildRuntimeContext -> RuntimeContext ->
// agentContextFromRuntime -> AccessContext.runId). Without this file, deleting
// `agentRunId: agentRun.id` here leaves the whole suite green while every audit
// row silently goes back to runId: null — the exact ambiguity run correlation
// exists to remove, and a false-EMPTY trail for the audit route.
//
// The assertion deliberately compares against the id the mocked
// db.agentRun.create actually returned rather than a literal, so it also fails
// if the route ever forwards *a* run id that is not *this run's* — passing the
// wrong run's id would be worse than passing none, since it attributes one
// run's memory access to another.

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
// The route is gated on check(); stubbed open here because this file is about
// run correlation, not the gate.
vi.mock("@/services/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/access")>();
  return { ...actual, check: vi.fn() };
});
vi.mock("@/lib/copy-agent", () => ({ provisionCopyAgentCapability: vi.fn() }));
vi.mock("@/services/agents/runner", () => ({ runCopyAgent: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    agent: { findFirst: vi.fn() },
    contact: { findFirst: vi.fn() },
    agentRun: { create: vi.fn(), update: vi.fn() },
  },
}));

import { requireAccessContext } from "@/lib/access-context";
import { check } from "@/services/access";
import { provisionCopyAgentCapability } from "@/lib/copy-agent";
import { runCopyAgent } from "@/services/agents/runner";
import { db } from "@/lib/db";

import { POST } from "./route";

const member = {
  org: { id: "org_1", name: "Acme" },
  user: { id: "user_42", role: "member" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "member" } },
};

const req = (body: unknown) =>
  new Request("http://t/api/agents/agent_1/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const params = { params: Promise.resolve({ id: "agent_1" }) };

/** The route does its real work inside the SSE stream's start(), so nothing
 *  runs until the body is actually consumed. */
async function drain(res: Response) {
  const reader = res.body!.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(member as never);
  vi.mocked(check).mockResolvedValue({ allowed: true, reason: "test: gate open" } as never);
  vi.mocked(db.agent.findFirst).mockResolvedValue({ id: "agent_1", active: true, settings: {} } as never);
  vi.mocked(db.contact.findFirst).mockResolvedValue({
    id: "contact_1",
    name: "Jane Doe",
    account: { name: "Acme", domain: "acme.com" },
  } as never);
  vi.mocked(db.agentRun.create).mockResolvedValue({ id: "run_created_by_this_route" } as never);
  vi.mocked(db.agentRun.update).mockResolvedValue({} as never);
  vi.mocked(provisionCopyAgentCapability).mockResolvedValue("wcap_test" as never);
  vi.mocked(runCopyAgent).mockResolvedValue({ subject: "s", body: "b" } as never);
});

describe("POST /api/agents/:id/run — run-correlation id", () => {
  it("passes the AgentRun row's own id to runCopyAgent as agentRunId", async () => {
    await drain(await POST(req({ contactId: "contact_1" }), params));

    const createdId = (await vi.mocked(db.agentRun.create).mock.results[0].value).id;
    expect(runCopyAgent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runCopyAgent).mock.calls[0][0]).toMatchObject({
      agentRunId: createdId,
      orgId: "org_1",
    });
  });

  it("creates the AgentRun before invoking the agent, so there is always a real id to attribute to", async () => {
    // Ordering matters: if the run row were created after the agent call, the
    // route would have nothing to pass and runId would be null for the very
    // reads the run performs. Asserted through observable call order rather
    // than by reading the source.
    const order: string[] = [];
    vi.mocked(db.agentRun.create).mockImplementation((async () => {
      order.push("create");
      return { id: "run_created_by_this_route" };
    }) as never);
    vi.mocked(runCopyAgent).mockImplementation((async () => {
      order.push("runCopyAgent");
      return { subject: "s", body: "b" };
    }) as never);

    await drain(await POST(req({ contactId: "contact_1" }), params));

    expect(order).toEqual(["create", "runCopyAgent"]);
  });

  it("never invokes the agent at all when the request is rejected, so no unattributed run can start", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null as never);
    const res = await POST(req({ contactId: "contact_1" }), params);
    expect(res.status).toBe(401);
    expect(db.agentRun.create).not.toHaveBeenCalled();
    expect(runCopyAgent).not.toHaveBeenCalled();
  });
});
