// Org-wide (untagged) memory must stay reachable for a token whose checked scope
// covers org root, and stay invisible to a narrower one. Guards the bare-org
// fallback leg in GuardedMemoryStore.retrieve against both failure directions.
import { beforeEach, describe, expect, it, vi } from "vitest";
// These tests assert on merge, ranking and scope behaviour, not on conflict resolution,
// so the supersession record a guarded read consults
// (services/memory/superseded-facts.ts) is empty here. That a conflicted fact reads as
// one current answer is proven against persisted records in
// services/memory/conflict-read.realdb.test.ts.
// The derived-write rule is tested on Postgres (mcp/derived-write.realdb.test.ts); off here.
vi.mock("@/services/memory/rule-copies", () => import("@/services/memory/rule-copies.testsupport"));
vi.mock("@/services/access/derived-writes", () => import("@/services/access/derived-writes.testsupport"));
vi.mock("@/services/memory/superseded-facts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/superseded-facts")>()),
  loadSupersededVersions: async () => ({ byId: new Map(), byText: new Map() }),
}));
// Graph facts here are stand-ins with no stored rows behind them, so the serve-time source
// check (services/memory/graph-fact-sources.ts) serves them as they are; it is proven against
// real rows in services/memory/graph-fact-sources.realdb.test.ts.
vi.mock("@/services/memory/graph-fact-sources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/graph-fact-sources")>()),
  loadGraphSources: async () => ({ supports: () => true }),
}));
// The caller's own not-yet-extracted versions are read from Postgres and covered by
// mcp/graph-read-your-writes.realdb.test.ts; this file's db mock answers every query alike.
vi.mock("@/services/memory/own-pending-facts", () => ({ loadOwnPendingFacts: async () => [] }));

// Companion to access-leakage-eval.test.ts's MCP read-side scope enforcement
// cases. That file proves the leak half — a Deal A-scoped token never sees
// Deal B's Drive content — using a fixture store whose retrieve() filters on
// `input.scopePath` alone. That fixture is a faithful proxy for pgvector's
// WHERE clause and a blind spot for everything else: it ignores
// `input.groupId` entirely, so it cannot observe that scope enforcement ALSO
// rewrites the group id the Graphiti backend partitions on.
//
// This file models the other half of the real stack, the half that partition
// actually lives in:
//
//   • Graphiti (services/memory/graphiti-store.ts) writes under
//     `group_id: toGid(input.scopePath ?? input.groupId)` (ingest, L162) and
//     reads a SINGLE exact group — `group_id=toGid(input.groupId)` (retrieve
//     L200, entity L218). No containment, no fallback to the bare org group.
//   • GuardedMemoryStore hands it `groupId: scope ?? input.groupId`
//     (guarded-store.ts retrieve L~50 / entity L~78), so the caller's scope
//     becomes Graphiti's partition key.
//   • Hybrid (hybrid-store.ts) sends entity lookups to Graphiti ONLY
//     (pgvector's entity() is a hard `return null`, pgvector-store.ts L156),
//     and excludes `actorType: "extraction"` content from pgvector at ingest
//     (hybrid-store.ts L68-69) — so extraction-tier facts live in Graphiti
//     and nowhere else.
//
// Consequence under test: several ingest paths write with NO scopePath at all
// (app/api/memory/upload, app/api/onboarding, app/api/accounts/[id],
// app/api/contacts/from-research, services/outbound/
// send.ts), so their episodes sit in Graphiti under the BARE org id. An MCP
// handler that passes no scope keeps `groupId` at the bare org id and reaches
// those records. A root-scoped token that reads under `orgRootPath(orgId)` =
// `org_<orgId>` — a different Graphiti group — makes them silently disappear.
// For memory_entity, which has no pgvector fallback at all, they disappear
// completely.
//
// These two cases assert the BEHAVIOR that must hold regardless of mechanism
// (backfill the scope-less rows, query both groups, or keep the bare org id as
// the Graphiti partition for root-scoped reads): a root-scoped capability can
// still read its own org's scope-less, org-wide memory through MCP.

vi.mock("@/lib/db", () => ({
  db: {
    // guardedMemory reads the org's account tier after check() allows a read; no tier recorded means the default.
    org: { findUnique: async () => ({ settings: {} }) },
    $queryRaw: vi.fn(),
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: "audit_test_id" }),
      update: vi.fn(),
    },
  },
}));
vi.mock("@/services/access/scope-registry", () => ({ strictDescendantScopePaths: vi.fn(async () => []) }));

vi.mock("./store", () => ({
  memory: {
    retrieve: vi.fn(),
    entity: vi.fn(),
    ingest: vi.fn(),
    graph: vi.fn(),
    removeFact: vi.fn(),
    removeEntity: vi.fn(),
    transferEntity: vi.fn(),
  },
}));
vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn() }));

import { db } from "@/lib/db";
import { memory } from "./store";
import { toGid } from "./graphiti-store";
import { registerWillderTools } from "@/mcp/tools";
import { orgRootPath, type AccessContext } from "@/services/access";
import type { EntityLookup, MemoryEntity, SearchInput } from "@/types/memory";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const ORG_ID = "org_1";

// ---------------------------------------------------------------------------
// Fixture: one org's real ingest history, as the two backends actually store it
// ---------------------------------------------------------------------------

interface Episode {
  uuid: string;
  fact: string;
  /** What the ingest call passed (or didn't) as scopePath. */
  scopePath: string | null;
  /** Excluded from pgvector at ingest when "extraction" (hybrid-store L68-69). */
  actorType: "human" | "agent" | "extraction";
  /** Entity seeds are graph nodes; only these are reachable via entity(). */
  entityId?: string;
  entityName?: string;
}

const EPISODES: Episode[] = [
  // Scope-less, extraction-tier entity seed — exactly what app/api/accounts/[id]
  // writes on create (no scopePath, actorType
  // "extraction"). Graphiti-only, under the BARE org id.
  {
    uuid: "e-acme-seed",
    fact: "Acme Corp is an enterprise account, ARR $240k",
    scopePath: null,
    actorType: "extraction",
    entityId: "ent-acme",
    entityName: "Acme Corp",
  },
  // Scope-less human onboarding fact (app/api/onboarding/route.ts).
  {
    uuid: "e-onboarding",
    fact: "Willder sells to RevOps leaders at Series B companies",
    scopePath: null,
    actorType: "human",
  },
  // Root-scoped fact (lib/inngest.ts L777/L1031 stamp orgRootPath explicitly).
  {
    uuid: "e-root",
    fact: "Company-wide hiring freeze through Q4",
    scopePath: orgRootPath(ORG_ID),
    actorType: "human",
  },
];

/**
 * A MemoryStore that partitions the way the real hybrid stack does, rather than
 * filtering on scopePath alone:
 *
 *   Graphiti leg — exact group match on toGid(groupId), no containment.
 *   pgvector leg — scopePath containment (or NULL = org-wide), keyed on the
 *                  bare tenant id, and never holds extraction-tier content.
 *
 * entity() is Graphiti-only, mirroring hybrid-store.ts's delegation and
 * pgvector-store.ts's `return null`.
 */
function partitionedHybridStore() {
  const graphitiGroupOf = (e: Episode) => toGid(e.scopePath ?? ORG_ID);

  const retrieve = async (input: SearchInput & { tenantId?: string; scopePath?: string }) => {
    // Graphiti leg: one exact group, whatever the guard put in groupId.
    const graphitiHits = EPISODES.filter((e) => graphitiGroupOf(e) === toGid(input.groupId));

    // pgvector leg: bare tenant id + scope containment, extraction excluded.
    const scope = input.scopePath;
    const pgHits = EPISODES.filter((e) => {
      if (e.actorType === "extraction") return false;
      if (!scope) return true;
      if (e.scopePath === null) return true;
      if (e.scopePath === scope) return true;
      return e.scopePath.startsWith(`${scope}.`);
    });

    const merged = new Map<string, Episode>();
    for (const e of [...graphitiHits, ...pgHits]) merged.set(e.uuid, e);
    return {
      facts: [...merged.values()].map((e) => ({ uuid: e.uuid, fact: e.fact, validAt: null })),
    };
  };

  const entity = async (input: EntityLookup): Promise<MemoryEntity | null> => {
    const hit = EPISODES.find((e) => e.entityId === input.entityId && graphitiGroupOf(e) === toGid(input.groupId));
    if (!hit) return null;
    return {
      uuid: hit.entityId!,
      name: hit.entityName!,
      type: "company",
      summary: null,
      facts: [{ uuid: hit.uuid, fact: hit.fact, validAt: null }],
    } as unknown as MemoryEntity;
  };

  return { retrieve, entity };
}

/** check() allows: a root-scoped capability covering the requested target. */
function allowRootCapability() {
  vi.mocked(db.$queryRaw).mockResolvedValue([
    { permission: "read", createdBy: "user_1", agentId: "handoff-agent" },
  ] as never);
}

function fakeMcpServer() {
  const tools = new Map<
    string,
    (args: Record<string, unknown>) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>
  >();
  return {
    registerTool: vi.fn(
      (
        name: string,
        _config: unknown,
        handler: (
          args: Record<string, unknown>,
        ) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>,
      ) => {
        tools.set(name, handler);
      },
    ),
    tools,
  };
}

// ---------------------------------------------------------------------------

describe("MCP read scope — org-wide (scope-less) memory must stay reachable for a root-scoped token", () => {
  const ctx: AccessContext = {
    orgId: ORG_ID,
    actor: { type: "agent", id: "handoff-agent", capabilityToken: "wcap_root" },
    origin: "mcp",
  };

  let tools: ReturnType<typeof fakeMcpServer>["tools"];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test_id" } as never);
    allowRootCapability();

    const store = partitionedHybridStore();
    vi.mocked(memory.retrieve).mockImplementation(store.retrieve as never);
    vi.mocked(memory.entity).mockImplementation(store.entity as never);

    const server = fakeMcpServer();
    registerWillderTools(server as unknown as McpServer, ctx, {
      orgId: ORG_ID,
      agentId: "handoff-agent",
      // A root-scoped capability: the ordinary admin/agent token shape.
      scopePath: orgRootPath(ORG_ID),
    });
    tools = server.tools;
  });

  it("memory_entity still finds an org-wide entity seed ingested without a scopePath", async () => {
    const memoryEntity = tools.get("memory_entity")!;

    const result = await memoryEntity({ entityId: "ent-acme" });
    const text = result.content.map((c) => c.text).join(" | ");

    // Graphiti holds this seed under the BARE org group (no scopePath at
    // ingest). Reading under orgRootPath() queries a different group, and
    // entity() has no pgvector fallback, so the account vanishes entirely.
    expect(result.isError).not.toBe(true);
    expect(text).not.toContain("Entity not found");
    expect(text).toContain("Acme Corp");
    expect(text).toContain("ARR $240k");
  });

  it("memory_query still returns extraction-tier facts that live only in Graphiti's bare-org group", async () => {
    const memoryQuery = tools.get("memory_query")!;

    const result = await memoryQuery({ query: "what do we know about Acme" });
    const text = result.content.map((c) => c.text).join(" | ");

    expect(result.isError).not.toBe(true);
    // Root-scoped and scope-less-but-pgvector-backed content is fine either way;
    // the extraction seed is the one with no second home to fall back to.
    expect(text).toContain("Acme Corp is an enterprise account");
  });
});
