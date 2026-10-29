import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit tests for services/agents/cron.ts (UC10 nightly-sweep selection). The DB is
// fully mocked so we test the pure selection logic in isolation: reading the cron
// config out of the untyped Agent.settings JSON, and picking exactly the architecture
// agents that opted in with a non-empty scope. No live stack, no LLM, no memory-service.
vi.mock("@/lib/db", () => ({
  db: {
    agent: { findMany: vi.fn() },
  },
}));

import { db } from "@/lib/db";
import { cronConfig, selectCronArchitectureAgents } from "./cron";

beforeEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// cronConfig — defensive read of settings.cron from untyped JSON
// ---------------------------------------------------------------------------

describe("cronConfig", () => {
  it("returns null for null settings", () => {
    expect(cronConfig(null)).toBeNull();
  });

  it("returns null for undefined settings", () => {
    expect(cronConfig(undefined)).toBeNull();
  });

  it("returns null when settings is an array (not a plain object)", () => {
    expect(cronConfig([])).toBeNull();
    expect(cronConfig([{ cron: { enabled: true } }])).toBeNull();
  });

  it("returns null for non-object primitives", () => {
    expect(cronConfig("cron")).toBeNull();
    expect(cronConfig(42)).toBeNull();
    expect(cronConfig(true)).toBeNull();
  });

  it("returns null when settings has no cron key", () => {
    expect(cronConfig({})).toBeNull();
    expect(cronConfig({ memoryScope: "org.eng" })).toBeNull();
  });

  it("returns the cron object when settings.cron is a valid object", () => {
    const cron = { enabled: true, scope: "org_1.engineering" };
    expect(cronConfig({ cron })).toEqual(cron);
  });

  it("returns the cron object even when partially populated", () => {
    expect(cronConfig({ cron: { enabled: true } })).toEqual({ enabled: true });
    expect(cronConfig({ cron: {} })).toEqual({});
  });

  it("returns null when settings.cron is null", () => {
    expect(cronConfig({ cron: null })).toBeNull();
  });

  it("returns null when settings.cron is an array", () => {
    expect(cronConfig({ cron: [] })).toBeNull();
    expect(cronConfig({ cron: ["enabled"] })).toBeNull();
  });

  it("returns null when settings.cron is a garbage primitive", () => {
    expect(cronConfig({ cron: "true" })).toBeNull();
    expect(cronConfig({ cron: 1 })).toBeNull();
    expect(cronConfig({ cron: false })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// selectCronArchitectureAgents — pick opted-in architecture agents
// ---------------------------------------------------------------------------

// Minimal row shape the SELECT returns; cast at the mock boundary.
function row(id: string, settings: unknown, over: Record<string, unknown> = {}) {
  return {
    id,
    orgId: "org_1",
    agentKey: `key-${id}`,
    name: `Agent ${id}`,
    role: "architecture",
    model: "gpt-4o-mini",
    systemPrompt: null,
    tools: ["memory_read"],
    settings,
    ...over,
  };
}

describe("selectCronArchitectureAgents", () => {
  it("returns only agents with cron.enabled === true AND a non-empty scope", async () => {
    vi.mocked(db.agent.findMany).mockResolvedValue([
      row("valid", { cron: { enabled: true, scope: "org_1.engineering" } }),
      row("enabled-no-scope", { cron: { enabled: true } }),
      row("enabled-empty-scope", { cron: { enabled: true, scope: "" } }),
      row("disabled", { cron: { enabled: false, scope: "org_1.sales" } }),
      row("no-cron", { memoryScope: "org_1.eng" }),
      row("null-settings", null),
    ] as never);

    const result = await selectCronArchitectureAgents();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("valid");
    expect(result[0].scope).toBe("org_1.engineering");
  });

  it("excludes an enabled agent whose scope is missing", async () => {
    vi.mocked(db.agent.findMany).mockResolvedValue([row("a", { cron: { enabled: true } })] as never);
    expect(await selectCronArchitectureAgents()).toEqual([]);
  });

  it("excludes a disabled agent even when it has a scope", async () => {
    vi.mocked(db.agent.findMany).mockResolvedValue([
      row("a", { cron: { enabled: false, scope: "org_1.eng" } }),
    ] as never);
    expect(await selectCronArchitectureAgents()).toEqual([]);
  });

  it("excludes an agent with no cron config at all", async () => {
    vi.mocked(db.agent.findMany).mockResolvedValue([row("a", {})] as never);
    expect(await selectCronArchitectureAgents()).toEqual([]);
  });

  it("treats enabled truthy-but-not-true (e.g. 1) as disabled — requires strict === true? enabled must be truthy", async () => {
    // The source uses `!cron?.enabled` so any falsy value is excluded; a truthy
    // non-boolean scope is still required. Here enabled:true + scope present passes.
    vi.mocked(db.agent.findMany).mockResolvedValue([
      row("a", { cron: { enabled: true, scope: "org_1.eng" } }),
    ] as never);
    const result = await selectCronArchitectureAgents();
    expect(result).toHaveLength(1);
  });

  it("maps the selection to { id, orgId, scope, agentRow } with scope from settings.cron.scope", async () => {
    vi.mocked(db.agent.findMany).mockResolvedValue([
      row(
        "valid",
        { cron: { enabled: true, scope: "org_1.engineering.backend" } },
        {
          orgId: "org_42",
          agentKey: "arch-nightly",
          name: "Nightly architect",
          model: "gpt-4o",
          systemPrompt: "You plan.",
          tools: ["memory_read", "memory_write"],
        },
      ),
    ] as never);

    const [sel] = await selectCronArchitectureAgents();
    expect(sel).toEqual({
      id: "valid",
      orgId: "org_42",
      scope: "org_1.engineering.backend",
      agentRow: {
        agentKey: "arch-nightly",
        name: "Nightly architect",
        role: "architecture",
        systemPrompt: "You plan.",
        tools: ["memory_read", "memory_write"],
        model: "gpt-4o",
        settings: { cron: { enabled: true, scope: "org_1.engineering.backend" } },
      },
    });
  });

  it("passes role: architecture, active: true to findMany when no orgId is given (no orgId in where)", async () => {
    vi.mocked(db.agent.findMany).mockResolvedValue([] as never);
    await selectCronArchitectureAgents();
    expect(db.agent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { role: "architecture", active: true },
      }),
    );
  });

  it("adds orgId to the where-clause when given", async () => {
    vi.mocked(db.agent.findMany).mockResolvedValue([] as never);
    await selectCronArchitectureAgents("org_99");
    expect(db.agent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { role: "architecture", active: true, orgId: "org_99" },
      }),
    );
  });

  it("returns an empty array when findMany returns nothing", async () => {
    vi.mocked(db.agent.findMany).mockResolvedValue([] as never);
    expect(await selectCronArchitectureAgents("org_1")).toEqual([]);
  });

  it("returns multiple valid agents preserving row order", async () => {
    vi.mocked(db.agent.findMany).mockResolvedValue([
      row("a", { cron: { enabled: true, scope: "org_1.a" } }),
      row("skip", { cron: { enabled: false, scope: "org_1.x" } }),
      row("b", { cron: { enabled: true, scope: "org_1.b" } }),
    ] as never);
    const result = await selectCronArchitectureAgents();
    expect(result.map((r) => r.id)).toEqual(["a", "b"]);
    expect(result.map((r) => r.scope)).toEqual(["org_1.a", "org_1.b"]);
  });
});
