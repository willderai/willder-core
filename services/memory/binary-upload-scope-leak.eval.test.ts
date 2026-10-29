// Leakage eval for uploaded binary content: a file ingested under one scope must
// not reach a token scoped elsewhere, and the in-scope token must still get it,
// so the test fails on an over-broad filter as well as on a leak.
import { beforeEach, describe, expect, it, vi } from "vitest";
// These tests assert on merge, ranking and scope behaviour, not on conflict resolution,
// so the supersession record a guarded read consults
// (services/memory/superseded-facts.ts) is empty here. That a conflicted fact reads as
// one current answer is proven against persisted records in
// services/memory/conflict-read.realdb.test.ts.
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

// Read-side counterpart to app/api/memory/upload-route-scope-guard.test.ts: that
// file pins the WRITE side (the route threads the caller-selected scope into the
// ingest legs instead of leaving scopePath undefined). This file proves the end
// result — a binary upload correctly tagged with a scope is NOT readable by an
// out-of-scope capability token — through the leak-scenario convention in
// access-leakage-eval.test.ts (real GuardedMemoryStore against a fixture, not a
// hand-rolled containment check), with the opposite-direction completeness pairing
// SCOPE_COMPLETENESS.md calls for: the same it() also asserts the in-scope token
// DOES see it, so a narrowing regression can't sail through green just because
// nothing leaked.
//
// The fixture content below is shaped exactly like what the upload route's
// PRODUCTION path (the Blob leg, lib/inngest.ts's fileIngest) produces, which is
// the leg a scopePath-IS-NULL leak lives on: route.ts's inngest.send payload never
// sets `actorType`, so fileIngest's `input.actorType ?? "human"` defaults it to
// `"human"`, not `"extraction"` — and fileIngest writes every chunk DIRECTLY to
// `pgvectorStore.ingest`, bypassing hybrid-store.ts's actorType-based
// extraction/pgvector split entirely. (Only the dev/no-Blob leg's `ingestMemory`
// call in route.ts stamps `actorType: "extraction"` — a real but separate code
// path this fixture is not modeling.) `source: "document"`, tagged with the scope
// the human selected at upload time.
//
// `actorType: "human"` is load-bearing: a fixture tagged `"extraction"` is
// excluded from the pgvector leg by visibleFacts() below (mirroring hybrid-store's
// real split), so pgHits is always empty and the leak assertion rides entirely on
// the Graphiti leg's exact-groupId match, never exercising pgvector's `scopePath
// IS NULL` containment logic, which is where the leak lives.

vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: vi.fn(),
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_test_id" }), update: vi.fn() },
  },
}));
vi.mock("@/services/access/scope-registry", () => ({ strictDescendantScopePaths: vi.fn(async () => []) }));

import { db } from "@/lib/db";
import { GuardedMemoryStore } from "./guarded-store";
import { orgRootPath, type AccessContext } from "@/services/access";
import type { MemoryStore } from "./memory-store";
import type { MemoryFact, SearchInput } from "@/types/memory";

const ORG_ID = "org_1";

interface FixtureFact extends MemoryFact {
  scopePath: string | null;
}

// One org, two sibling deals, each holding a binary-upload-shaped fact (what the
// fixed route now ingests) tagged at the scope the uploader actually selected.
const UPLOAD_GRAPH: FixtureFact[] = [
  {
    uuid: "f-dealA-upload",
    fact: "Deal A: MSA extracted from uploaded contract.pdf, term is 24 months",
    validAt: null,
    actorType: "human",
    scopePath: "org_1.dealA",
  },
  {
    uuid: "f-dealB-upload",
    fact: "Deal B: MSA extracted from uploaded contract.pdf, term is 12 months",
    validAt: null,
    actorType: "human",
    scopePath: "org_1.dealB",
  },
];

/** graphiti-store.ts's real ingest partition key: `group_id: toGid(input.scopePath ?? input.groupId)`. */
function graphitiGroupOf(f: FixtureFact): string {
  return f.scopePath ?? ORG_ID;
}

/** Same two-leg shape as access-leakage-eval.test.ts's visibleFacts(): a Graphiti leg
 * keyed on an exact groupId match, a pgvector leg keyed on scopePath containment
 * (exact, descendant, or NULL = org-wide). `actorType: "extraction"` content only
 * ever lands in Graphiti (hybrid-store.ts's ingest split), never pgvector — modeled
 * here the same way so an extraction-tagged fact can't accidentally "leak visible"
 * through the pgvector leg's own NULL-scope fallback. */
function visibleFacts(graph: FixtureFact[], input: { groupId: string; scopePath?: string }): FixtureFact[] {
  const graphitiHits = graph.filter((f) => graphitiGroupOf(f) === input.groupId);

  const scope = input.scopePath;
  const pgHits = graph.filter((f) => {
    if (f.actorType === "extraction") return false;
    if (!scope) return true;
    if (f.scopePath === null) return true;
    if (f.scopePath === scope) return true;
    return f.scopePath.startsWith(scope + ".");
  });

  const seen = new Set<string>();
  const merged: FixtureFact[] = [];
  for (const f of [...graphitiHits, ...pgHits]) {
    if (!seen.has(f.uuid)) {
      seen.add(f.uuid);
      merged.push(f);
    }
  }
  return merged;
}

function fixtureScopedStore(graph: FixtureFact[]): MemoryStore {
  const retrieve = vi.fn(async (input: SearchInput) => ({
    facts: visibleFacts(graph, input).map((f) => ({
      uuid: f.uuid,
      fact: f.fact,
      validAt: f.validAt,
      actorType: f.actorType,
    })),
  }));
  return {
    ingest: vi.fn(),
    retrieve,
    entity: vi.fn().mockResolvedValue(null),
    graph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
    removeFact: vi.fn(),
    removeEntity: vi.fn(),
    transferEntity: vi.fn(),
  } as unknown as MemoryStore;
}

const allow = (permission: "read" | "write" | "admin" = "read", agentId?: string) =>
  vi.mocked(db.$queryRaw).mockResolvedValue([{ permission, agentId }] as never);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test_id" } as never);
});

describe("binary upload scope leak — an upload's tagged content stays inside its scope", () => {
  it("a Deal B-scoped capability token never sees a Deal A binary upload, but a Deal A-scoped token does (leak + completeness, same seam)", async () => {
    const guarded = new GuardedMemoryStore(fixtureScopedStore(UPLOAD_GRAPH));

    // Out-of-scope: an agent capability token scoped to the sibling deal — the
    // narrow-agent-capability-token shape that is the real exposure.
    const dealBCtx: AccessContext = {
      orgId: ORG_ID,
      actor: { type: "agent", id: "handoff-agent", capabilityToken: "wcap_test_dealB" },
      origin: "mcp",
    };
    allow("read", "handoff-agent");
    const { facts: dealBView } = await guarded.retrieve(
      dealBCtx,
      { groupId: ORG_ID, query: "what should the contractor know" },
      "org_1.dealB",
    );
    expect(dealBView.map((f) => f.uuid)).not.toContain("f-dealA-upload");
    expect(dealBView.map((f) => f.fact).join(" | ")).not.toContain("24 months");

    // In-scope: the same content IS visible to a token actually scoped to Deal A —
    // proves the assertion above is a real scope boundary, not an empty-graph
    // false negative (the completeness pairing).
    const dealACtx: AccessContext = {
      orgId: ORG_ID,
      actor: { type: "agent", id: "handoff-agent", capabilityToken: "wcap_test_dealA" },
      origin: "mcp",
    };
    const { facts: dealAView } = await guarded.retrieve(
      dealACtx,
      { groupId: ORG_ID, query: "what should the contractor know" },
      "org_1.dealA",
    );
    expect(dealAView.map((f) => f.uuid)).toContain("f-dealA-upload");
  });

  it("control: an UNTAGGED binary upload (scopePath undefined) leaks org-wide", async () => {
    // Not a test of the route (that content is always tagged, per
    // upload-route-scope-guard.test.ts) — this documents why tagging is
    // necessary: with scopePath undefined, pgvector-store.ts's `scopePath IS
    // NULL` clause treats the row as org-wide-visible to every scoped caller.
    // Modeled directly against the pgvector leg of visibleFacts (not the Graphiti
    // leg, which extraction-tagged content skips entirely) since that
    // NULL-fallback is exactly pgvector-store.ts's own clause.
    const untaggedGraph: FixtureFact[] = [
      {
        uuid: "f-untagged-upload",
        fact: "Untagged upload: would leak org-wide pre-fix",
        validAt: null,
        scopePath: null,
      },
    ];
    const guarded = new GuardedMemoryStore(fixtureScopedStore(untaggedGraph));
    const dealBCtx: AccessContext = {
      orgId: ORG_ID,
      actor: { type: "agent", id: "handoff-agent", capabilityToken: "wcap_test_dealB" },
      origin: "mcp",
    };
    allow("read", "handoff-agent");

    const { facts } = await guarded.retrieve(dealBCtx, { groupId: ORG_ID, query: "anything" }, "org_1.dealB");

    expect(facts.map((f) => f.uuid)).toContain("f-untagged-upload");
  });

  it("an explicit org-root scope (the fallback for 'no scope selected') is not the same as null — it does not leak into a narrower deal scope either", async () => {
    // Parity check with the write-side fallback (upload-route-scope-guard.test.ts's
    // "no scope selected" case): resolveCallerScopePath falls back to orgRootPath(),
    // never to a bare/null scope, and orgRootPath content must obey ordinary ltree
    // containment (visible to a root-or-above read) rather than the NULL-is-org-wide
    // special case.
    const rootGraph: FixtureFact[] = [
      {
        uuid: "f-root-upload",
        fact: "Root-scoped upload (no scope was selected)",
        validAt: null,
        scopePath: orgRootPath(ORG_ID),
      },
    ];
    const guarded = new GuardedMemoryStore(fixtureScopedStore(rootGraph));
    const dealBCtx: AccessContext = {
      orgId: ORG_ID,
      actor: { type: "agent", id: "handoff-agent", capabilityToken: "wcap_test_dealB" },
      origin: "mcp",
    };
    allow("read", "handoff-agent");

    const { facts } = await guarded.retrieve(dealBCtx, { groupId: ORG_ID, query: "anything" }, "org_1.dealB");

    expect(facts.map((f) => f.uuid)).not.toContain("f-root-upload");
  });
});
