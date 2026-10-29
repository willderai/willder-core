import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: { source: { findFirst: vi.fn(), findMany: vi.fn() }, agent: { findMany: vi.fn() } },
}));

import { db } from "@/lib/db";
import {
  authorizationKindOf,
  fallbackAgentName,
  resolveActorNames,
  resolveAgentNames,
  resolveConnectorSource,
} from "./actor-names";

beforeEach(() => {
  vi.mocked(db.source.findFirst).mockReset();
  vi.mocked(db.source.findMany)
    .mockReset()
    .mockResolvedValue([] as never);
  vi.mocked(db.agent.findMany)
    .mockReset()
    .mockResolvedValue([] as never);
});

describe("resolveConnectorSource", () => {
  it("names the org's own source behind a sync actor, on one line", async () => {
    vi.mocked(db.source.findFirst).mockResolvedValueOnce({ name: "Acme\n  #eng", type: "slack" } as never);
    expect(await resolveConnectorSource("org1", "slack-sync:src_1")).toEqual({ name: "Acme #eng", type: "slack" });
    expect(vi.mocked(db.source.findFirst).mock.calls[0]![0]).toMatchObject({
      where: { orgId: "org1", id: "src_1", type: "slack" },
    });
  });

  it("is null for a source this org does not have, such as one since disconnected", async () => {
    vi.mocked(db.source.findFirst).mockResolvedValueOnce(null);
    expect(await resolveConnectorSource("org1", "figma-sync:gone")).toBeNull();
  });

  it("does not look up a writer that is not a connector sync", async () => {
    for (const actorId of ["agent_1", "user_1", "mailbox-sync:x", "slack-sync:"]) {
      expect(await resolveConnectorSource("org1", actorId)).toBeNull();
    }
    expect(db.source.findFirst).not.toHaveBeenCalled();
  });
});

// A connector sync's actor id has no Agent row, so the agent fallback alone rendered it as
// the prettified id — "Github Sync:Cmuhwy0or000b04jkiqq0uoum Agent". Every audit surface resolves names through here, so the
// audit list, the actors picker and the Timeline cannot disagree about who wrote something.
describe("resolveActorNames", () => {
  it("names a connector sync after the source it syncs, on one line", async () => {
    vi.mocked(db.source.findMany).mockResolvedValueOnce([{ id: "src_1", name: "acme-dev/acrue" }] as never);
    const names = await resolveActorNames("org1", ["github-sync:src_1"]);
    expect(names).toEqual({ "github-sync:src_1": "acme-dev/acrue sync" });
    expect(vi.mocked(db.source.findMany).mock.calls[0]![0]).toMatchObject({
      where: { orgId: "org1", id: { in: ["src_1"] } },
    });
  });

  it("prefers an agent's own name, and falls back to the quoted id for anything else", async () => {
    vi.mocked(db.agent.findMany).mockResolvedValueOnce([{ agentKey: "custom-1", name: "Billing" }] as never);
    expect(await resolveActorNames("org1", ["custom-1", "stranger"])).toEqual({
      "custom-1": "Billing Agent",
      stranger: '"stranger" (agent token)',
    });
  });

  it("falls back for a sync actor whose source this org does not have", async () => {
    expect(await resolveActorNames("org1", ["github-sync:gone"])).toEqual({
      "github-sync:gone": "Github Sync:Gone Agent",
    });
  });

  it("looks nothing up for an empty list", async () => {
    expect(await resolveActorNames("org1", [])).toEqual({});
    expect(db.agent.findMany).not.toHaveBeenCalled();
    expect(db.source.findMany).not.toHaveBeenCalled();
  });
});

// A person outside the team must be able to name a fact's writer from the interface alone.
// A capability's agent id is free text, so before this an id such as `qa_agent` rendered
// exactly like the built-in `qa-agent` ("Qa Agent Agent"), and an Agent row named "QA agent"
// exactly like the seeded QA agent's row. A product label now comes only from the product's
// own id, spelled exactly; anything else shows what it really is.
describe("a writer cannot borrow a product actor's label", () => {
  const PRODUCT_IDS = [
    "qa-agent",
    "copy-agent",
    "handoff-agent",
    "architecture-agent",
    "research-agent",
    "system",
    "unknown",
    "github-secret-scanning",
    "workflow:review",
    "github-sync:gone",
  ];
  const SPOOF_IDS = [
    "qa_agent",
    "research_agent",
    "copy_agent",
    "copy agent",
    "Copy-Agent",
    "QA Agent",
    "github_secret_scanning",
    "GitHub-Secret-Scanning",
    "System",
    "system ",
    "Unknown",
    "Workflow:review",
    "github_sync:gone",
    "Github Sync:Gone",
  ];
  // What a reader compares by eye: case, spacing and separators do not tell labels apart.
  const looksLike = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "");

  it("leaves every product actor's label as it was", () => {
    expect(PRODUCT_IDS.map(fallbackAgentName)).toEqual([
      "Qa Agent Agent",
      "Copy Agent Agent",
      "Handoff Agent Agent",
      "Architecture Agent Agent",
      "Research Agent Agent",
      "System Agent",
      "Unknown Agent",
      "Github Secret Scanning Agent",
      "Workflow:Review Agent",
      "Github Sync:Gone Agent",
    ]);
  });

  it("renders every free-text id as itself, marked as an agent token, never as a product label", () => {
    const real = new Set(PRODUCT_IDS.map((id) => looksLike(fallbackAgentName(id))));
    for (const id of SPOOF_IDS) {
      const label = fallbackAgentName(id);
      expect(label).toBe(`${JSON.stringify(id)} (agent token)`);
      expect(real.has(looksLike(label))).toBe(false);
    }
  });

  it("does so on every audit surface's resolver, with or without a lookup", async () => {
    const names = await resolveActorNames("org1", [...SPOOF_IDS, ...PRODUCT_IDS]);
    const real = new Set(PRODUCT_IDS.map((id) => looksLike(names[id]!)));
    for (const id of SPOOF_IDS) expect(real.has(looksLike(names[id]!))).toBe(false);
  });

  it("marks an Agent row whose name claims a product actor with its own key", async () => {
    const rows = [
      { agentKey: "qa-agent", name: "QA agent" },
      { agentKey: "custom-1", name: "QA agent" },
      { agentKey: "custom-2", name: "Outreach" },
      { agentKey: "custom-3", name: "System" },
      { agentKey: "custom-4", name: "GitHub secret scanning" },
      { agentKey: "custom-5", name: "Workflow:Review" },
      { agentKey: "custom-6", name: "Acme sync" },
      { agentKey: "custom-7", name: "Billing" },
    ];
    vi.mocked(db.agent.findMany).mockResolvedValueOnce(rows as never);
    const names = await resolveAgentNames(
      "org1",
      rows.map((r) => r.agentKey),
    );
    expect(names["qa-agent"]).toBe("QA agent Agent");
    expect(names["custom-1"]).toBe('QA agent Agent (agent key "custom-1")');
    expect(names["custom-2"]).toBe('Outreach Agent (agent key "custom-2")');
    expect(names["custom-3"]).toBe('System Agent (agent key "custom-3")');
    expect(names["custom-4"]).toBe('GitHub secret scanning Agent (agent key "custom-4")');
    expect(names["custom-5"]).toBe('Workflow:Review Agent (agent key "custom-5")');
    expect(names["custom-6"]).toBe('Acme sync Agent (agent key "custom-6")');
    expect(names["custom-7"]).toBe("Billing Agent");
  });
});

describe("authorizationKindOf", () => {
  const person = { actorType: "human", actorId: "u1" };
  const stamped = (actorId: string) => ({ authorizedById: "row1", actorId });

  it("is null when the change records no authorization", () => {
    expect(authorizationKindOf({ authorizedById: null, actorId: "u1" }, "human", person)).toBeNull();
  });
  it("is connect for a connector sync's write, whoever connected it", () => {
    expect(authorizationKindOf(stamped("slack-sync:src1"), "extraction", person)).toBe("connect");
  });
  it("is direct when the row's actor is the writer", () => {
    expect(authorizationKindOf(stamped("u1"), "human", person)).toBe("direct");
    expect(authorizationKindOf(stamped("agent_a"), "agent", { actorType: "agent", actorId: "agent_a" })).toBe("direct");
  });
  it("is accepted when a person's row authorized content another writer produced", () => {
    expect(authorizationKindOf(stamped("agent_a"), "agent", person)).toBe("accepted");
    // The system composed the text from the person's own edit: same id, different principal.
    expect(authorizationKindOf(stamped("u1"), "extraction", person)).toBe("accepted");
  });
  it("stays direct when an agent's row names another writer, so the measure reads it as wrong", () => {
    expect(authorizationKindOf(stamped("agent_b"), "agent", { actorType: "agent", actorId: "agent_a" })).toBe("direct");
  });
  it("stays direct when the named row cannot be read", () => {
    expect(authorizationKindOf(stamped("agent_a"), "agent", null)).toBe("direct");
  });
});
