// Architecture cron selection (UC10 nightly sweep) — live check.
// Run with: npm run architecture-cron:check
//
// The nightly Inngest function `architectureNightly` calls selectCronArchitectureAgents()
// then runs each returned agent. The LLM + memory-service side is unverifiable offline, so
// this check exercises the PURE, verifiable core: the DB selection. Against real Neon it
// creates a throwaway org with a spread of agents — an architecture agent opted into cron
// with a scope, one enabled but with no scope, one disabled, one with no cron config, and
// a non-architecture (research) agent that IS cron-enabled — then asserts the selection
// returns exactly the one valid architecture agent (right id + scope). No LLM, no
// memory-service: selection is pure DB.
//
// Exits non-zero on any failure. Cleans up its throwaway org on completion.
import { db } from "@/lib/db";
import { selectCronArchitectureAgents } from "@/services/agents/cron";

let passed = 0;
let failed = 0;
function ok(msg: string) {
  console.log(`  ✓ ${msg}`);
  passed++;
}
function fail(msg: string) {
  console.log(`  ✗ ${msg}`);
  failed++;
}
function assert(cond: boolean, msg: string) {
  if (cond) ok(msg);
  else fail(msg);
}

async function main() {
  console.log("\n  ARCHITECTURE CRON SELECTION CHECK (UC10 nightly sweep)\n");

  const org = await db.org.create({ data: { name: "__architecture_cron_check__" } });

  try {
    console.log("Seeding architecture agents with varied cron settings...");

    // The one valid pick: architecture, active, cron enabled, non-empty scope.
    const valid = await db.agent.create({
      data: {
        orgId: org.id,
        agentKey: "arch-cron-valid",
        name: "Nightly architect",
        role: "architecture",
        active: true,
        settings: { cron: { enabled: true, scope: `org_${org.id}.engineering` } },
      },
    });

    // Enabled but no scope → excluded (the sweep has nothing to scope the run to).
    await db.agent.create({
      data: {
        orgId: org.id,
        agentKey: "arch-cron-noscope",
        name: "Enabled no-scope",
        role: "architecture",
        active: true,
        settings: { cron: { enabled: true } },
      },
    });

    // Cron present but disabled → excluded.
    await db.agent.create({
      data: {
        orgId: org.id,
        agentKey: "arch-cron-disabled",
        name: "Disabled cron",
        role: "architecture",
        active: true,
        settings: { cron: { enabled: false, scope: `org_${org.id}.sales` } },
      },
    });

    // No cron config at all → excluded.
    await db.agent.create({
      data: {
        orgId: org.id,
        agentKey: "arch-cron-none",
        name: "No cron",
        role: "architecture",
        active: true,
        settings: { memoryScope: `org_${org.id}.product` },
      },
    });

    // Inactive architecture agent, cron enabled + scope → excluded (active: true filter).
    await db.agent.create({
      data: {
        orgId: org.id,
        agentKey: "arch-cron-inactive",
        name: "Inactive architect",
        role: "architecture",
        active: false,
        settings: { cron: { enabled: true, scope: `org_${org.id}.inactive` } },
      },
    });

    // A cron-enabled RESEARCH agent → excluded (role filter — only architecture is swept).
    await db.agent.create({
      data: {
        orgId: org.id,
        agentKey: "research-cron",
        name: "Cron research",
        role: "research",
        active: true,
        settings: { cron: { enabled: true, scope: `org_${org.id}.research` } },
      },
    });

    console.log("\nSelection against real Neon...");
    const selected = await selectCronArchitectureAgents(org.id);

    assert(selected.length === 1, `exactly one agent is selected (got ${selected.length})`);
    assert(selected[0]?.id === valid.id, "the selected agent is the valid cron-enabled + scoped architecture agent");
    assert(
      selected[0]?.scope === `org_${org.id}.engineering`,
      "the selection carries the scope pulled from settings.cron.scope",
    );
    assert(selected[0]?.orgId === org.id, "the selection carries the agent's orgId");
    assert(selected[0]?.agentRow?.role === "architecture", "the mapped agentRow is the architecture agent");
    assert(
      selected[0]?.agentRow?.agentKey === "arch-cron-valid",
      "the mapped agentRow carries the agent's business key",
    );

    // Sanity: the enabled-no-scope, disabled, no-cron, inactive, and research agents are all absent.
    const ids = new Set(selected.map((s) => s.id));
    assert(!ids.has(""), "no empty-id selections leaked");
    assert(
      selected.every((s) => s.scope && s.scope.length > 0),
      "every selection has a non-empty scope",
    );
  } finally {
    await db.org.delete({ where: { id: org.id } });
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
