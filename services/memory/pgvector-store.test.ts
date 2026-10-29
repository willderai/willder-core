// A scoped delete must reach pgvector with the bare org id as its tenant key.
//
// GuardedMemoryStore.removeFact()/removeEntity() forward the caller's
// authorized SCOPE (an ltree path like "org_org_1.marketing") as `groupId`
// instead of the bare org id, so a genuinely narrow-scope delete lands at the
// right partition in Graphiti. But HybridMemoryStore.removeFact forwards that
// same `input` object verbatim to BOTH backends, and pgvector has no scope
// column at all — it isolates tenants on a bare `orgId` column
// (pgvector-store.ts's retrieve() handles this split via `tenantId`). Without
// `tenantId`, a scoped delete's pgvector leg filters `WHERE "orgId" = <scope
// path>`, which can never match a real row (every row's orgId is the bare org
// id) — the DELETE silently matches zero rows while the route still tells the
// caller `removed: true`.
//
// This file proves RemoveFactInput.tenantId (threaded through
// GuardedMemoryStore → HybridMemoryStore → PgvectorMemoryStore, the same split
// SearchInput.tenantId uses for retrieve) by exercising the REAL
// PgvectorMemoryStore against a fake in-memory `memory_chunks` table and
// checking the table's actual contents afterward — not just trusting the
// `removed` boolean the store hands back (backend-failure.eval.test.ts pins
// that boolean's fidelity; this file's point is independent of it).
import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = new Map<string, { id: string; orgId: string; scopePath: string | null }>();

vi.mock("@/lib/db", () => ({
  db: {
    // Fakes pgvector-store.ts's removeFact SQL:
    // `` DELETE FROM memory_chunks WHERE id = ${factId} AND "orgId" = ${tenantId} AND (containment) RETURNING "scopePath", "entityName" ``
    // built with Prisma.sql + scopeContainsSql and unpacked via flattenSql, so
    // the call still lands as (stringsArray, ...values) — factId and tenantId
    // first (the tenant-isolation tests rely on that position), then the
    // containment predicate's own bound values (scope path, LIKE prefix).
    // Modeling the real "within" containment rule here (not just id+orgId) is
    // what lets the scope-containment cases below mean anything: a fake that
    // checks only id+orgId cannot see a sibling-scope delete. It is still a
    // model of the rule, not the rule: pgvector-store.scope-containment.realdb.test.ts
    // runs the same cases through the real SQL against Postgres.
    // retrieve()'s SELECT goes through the same function; each of those tests sets its own
    // resolved rows, which take precedence over this fake.
    $queryRaw: vi.fn((strings: TemplateStringsArray, factId: string, orgId: string, path: string, _prefix: string) => {
      const sql = strings.join("");
      if (!sql.trimStart().startsWith("DELETE")) return Promise.resolve([]);
      const row = rows.get(factId);
      if (!row || row.orgId !== orgId) return Promise.resolve([]);
      const includeUntagged = sql.includes("IS NULL");
      const scopeOk =
        (includeUntagged && row.scopePath === null) ||
        row.scopePath === path ||
        (row.scopePath !== null && row.scopePath.startsWith(`${path}.`));
      if (!scopeOk) return Promise.resolve([]);
      rows.delete(factId);
      return Promise.resolve([{ scopePath: row.scopePath }]);
    }),
    // retrieve() sends its SELECT in one transaction with the index's probe count.
    $executeRawUnsafe: vi.fn(),
    $transaction: (queries: Promise<unknown>[]) => Promise.all(queries),
    // retrieve()'s erased-person filter: an org with no erasures.
    erasureSuppression: { findMany: vi.fn(async () => []) },
  },
}));

import { db } from "@/lib/db";
import { PgvectorMemoryStore } from "./pgvector-store";
import { HybridMemoryStore } from "./hybrid-store";
import type { MemoryStore } from "./memory-store";
import type { RemoveFactInput } from "@/types/memory";
import { orgRootPath } from "@/services/access";

const BARE_ORG_ID = "org_1";
const ORG_ROOT = orgRootPath(BARE_ORG_ID); // "org_org_1" — the real root scope, distinct from the bare id
const SCOPE_PATH = `${ORG_ROOT}.marketing`; // what a scoped caller's `groupId` becomes post-forwarding
const SIBLING_SCOPE_PATH = `${ORG_ROOT}.sales`; // same org, different (unauthorized) scope

function stubGraphiti(): MemoryStore {
  return {
    ingest: vi.fn(),
    retrieve: vi.fn(),
    entity: vi.fn(),
    graph: vi.fn(),
    // Graphiti's own leg is not under test here (guarded-store.test.ts pins its
    // forwarding) — always claims success so the hybrid result reflects
    // pgvector's leg on its own.
    removeFact: vi.fn().mockResolvedValue({ removed: true }),
    removeEntity: vi.fn(),
    transferEntity: vi.fn(),
  } as unknown as MemoryStore;
}

beforeEach(() => {
  rows.clear();
  rows.set("fact_1", { id: "fact_1", orgId: BARE_ORG_ID, scopePath: ORG_ROOT });
  vi.mocked(db.$queryRaw).mockClear();
});

describe("PgvectorMemoryStore.removeFact — tenant isolation on the bare org id", () => {
  it("a scoped delete (groupId = scope path, tenantId = bare org id) actually removes the row", async () => {
    rows.set("fact_1", { id: "fact_1", orgId: BARE_ORG_ID, scopePath: SCOPE_PATH });
    const input: RemoveFactInput = { groupId: SCOPE_PATH, factId: "fact_1", tenantId: BARE_ORG_ID };

    const res = await new PgvectorMemoryStore().removeFact(input);

    expect(res).toEqual({ removed: true, storedScopePath: SCOPE_PATH });
    // The positive proof: query the fake table directly, don't just trust the
    // boolean the store handed back.
    expect(rows.has("fact_1")).toBe(false);
  });

  it("REGRESSION: without tenantId, a scoped delete's groupId (the scope path) does NOT match any real row", async () => {
    rows.set("fact_1", { id: "fact_1", orgId: BARE_ORG_ID, scopePath: SCOPE_PATH });
    // The shape HybridMemoryStore forwards to pgvector without tenantId
    // threading — `groupId` already overwritten with the scope path, no
    // tenantId field to fall back to correctly.
    const input: RemoveFactInput = { groupId: SCOPE_PATH, factId: "fact_1" };

    const res = await new PgvectorMemoryStore().removeFact(input);

    // `tenantId` is undefined, so removeFact falls back to `input.groupId`
    // (the scope path) — which never equals a real row's bare-org `orgId`.
    expect(res).toEqual({ removed: false });
    // The fact is STILL in the table — a real, live customer's data.
    expect(rows.has("fact_1")).toBe(true);
  });

  it("an unscoped (org-root) delete still works, unchanged", async () => {
    const input: RemoveFactInput = { groupId: ORG_ROOT, factId: "fact_1", tenantId: BARE_ORG_ID };

    const res = await new PgvectorMemoryStore().removeFact(input);

    expect(res).toEqual({ removed: true, storedScopePath: ORG_ROOT });
    expect(rows.has("fact_1")).toBe(false);
  });
});

describe("PgvectorMemoryStore.removeFact — scope containment", () => {
  it("REGRESSION: a caller authorized on their OWN narrow scope cannot delete a sibling scope's fact by id, even in the same org", async () => {
    // The real leak this closes: check() already verified the caller can
    // memory.delete within SCOPE_PATH ("marketing"); nothing about that
    // authorizes touching a fact that actually lives under a different,
    // unauthorized sibling scope ("sales") just because they share a tenant.
    rows.set("fact_1", { id: "fact_1", orgId: BARE_ORG_ID, scopePath: SIBLING_SCOPE_PATH });
    const input: RemoveFactInput = { groupId: SCOPE_PATH, factId: "fact_1", tenantId: BARE_ORG_ID };

    const res = await new PgvectorMemoryStore().removeFact(input);

    expect(res).toEqual({ removed: false });
    expect(rows.has("fact_1")).toBe(true);
  });

  it("a scope-authorized delete DOES reach a real descendant of that scope", async () => {
    rows.set("fact_1", { id: "fact_1", orgId: BARE_ORG_ID, scopePath: `${SCOPE_PATH}.q3-campaign` });
    const input: RemoveFactInput = { groupId: SCOPE_PATH, factId: "fact_1", tenantId: BARE_ORG_ID };

    const res = await new PgvectorMemoryStore().removeFact(input);

    expect(res).toEqual({ removed: true, storedScopePath: `${SCOPE_PATH}.q3-campaign` });
    expect(rows.has("fact_1")).toBe(false);
  });

  it("a narrow (non-root) scope's delete cannot reach an untagged (scopePath IS NULL) row", async () => {
    rows.set("fact_1", { id: "fact_1", orgId: BARE_ORG_ID, scopePath: null });
    const input: RemoveFactInput = { groupId: SCOPE_PATH, factId: "fact_1", tenantId: BARE_ORG_ID };

    const res = await new PgvectorMemoryStore().removeFact(input);

    expect(res).toEqual({ removed: false });
    expect(rows.has("fact_1")).toBe(true);
  });

  it("an org-root-scoped delete DOES reach an untagged (scopePath IS NULL) row — root coverage is what justifies it", async () => {
    rows.set("fact_1", { id: "fact_1", orgId: BARE_ORG_ID, scopePath: null });
    const input: RemoveFactInput = { groupId: ORG_ROOT, factId: "fact_1", tenantId: BARE_ORG_ID };

    const res = await new PgvectorMemoryStore().removeFact(input);

    expect(res).toEqual({ removed: true, storedScopePath: null });
    expect(rows.has("fact_1")).toBe(false);
  });
});

describe("HybridMemoryStore.removeFact — end-to-end against the real PgvectorMemoryStore", () => {
  it("a scoped delete with tenantId threaded through actually removes the pgvector row", async () => {
    rows.set("fact_1", { id: "fact_1", orgId: BARE_ORG_ID, scopePath: SCOPE_PATH });
    const graphiti = stubGraphiti();
    const store = new HybridMemoryStore(graphiti, new PgvectorMemoryStore());

    // Exactly the shape GuardedMemoryStore.removeFact() produces: groupId
    // is the authorized scope for Graphiti, tenantId is the bare org id for
    // pgvector, both on the one forwarded input object.
    const res = await store.removeFact({ groupId: SCOPE_PATH, factId: "fact_1", tenantId: BARE_ORG_ID });

    expect(res).toEqual({ removed: true, storedScopePath: SCOPE_PATH, storedEntityName: null });
    expect(rows.has("fact_1")).toBe(false);
    expect(graphiti.removeFact).toHaveBeenCalledWith(expect.objectContaining({ groupId: SCOPE_PATH }));
  });
});

describe("PgvectorMemoryStore.retrieve — validAt format", () => {
  it("renders a row's createdAt as ISO-8601, the same shape the graph backend returns", async () => {
    // Prisma's $queryRaw hands a timestamp column back as a Date, not a string.
    const createdAt = new Date("2026-09-24T23:41:24.123Z");
    vi.mocked(db.$queryRaw).mockResolvedValueOnce([
      { id: "fact_1", content: "c", created_at: createdAt, actor_type: "human", actor_name: null, source_id: null },
    ] as never);
    const fetchStub = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ embedding: [0.1, 0.2] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchStub);

    try {
      const result = await new PgvectorMemoryStore().retrieve({ query: "q", groupId: BARE_ORG_ID });
      expect(result.facts[0].validAt).toBe("2026-09-24T23:41:24.123Z");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
