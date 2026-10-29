// A provenance row must not be mintable against a fact uuid the caller merely
// asserts.
//
// The seam under test is recordFactProvenance -> GuardedMemoryStore.findFact:
// one real check() deciding whether this caller may read the scope being
// written to, and one real store lookup deciding whether the uuid names a fact
// that actually lives there. Both halves run for real here. The store is a fake
// only in the sense that it holds its facts in a Map instead of Neo4j/Postgres;
// it partitions them by group exactly as the real backends do (`MATCH (:Entity
// {group_id})-[r:RELATES_TO {uuid, group_id}]->(:Entity {group_id})` and
// `WHERE id = $1 AND "orgId" = $2 AND <scope containment>`), so a refusal here
// comes from the partitioning, never from a mock that returns null for
// everything. The last test exists to prove exactly that: the same code path
// that refuses a cross-scope uuid still accepts a legitimate one.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: vi.fn(),
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_test_id" }), update: vi.fn() },
    factProvenance: { create: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  },
}));

/** Facts by the group they live in, the one partition the real backends key on.
 *  Hoisted so the module mock below can close over it. */
const { factStore } = vi.hoisted(() => {
  const factsByGroup: Record<string, Record<string, string>> = {
    "org_1.deal_a": { fact_in_a: "Acme signed the pilot" },
    "org_1.deal_b": { fact_in_b: "Globex churned in Q3" },
    // The bare org id, where the six ingest paths that write no scopePath put
    // their facts. Not an ltree scope path, which is exactly why Graphiti's
    // exact-groupId partitioning cannot reach it from `org_org_1`.
    org_1: { fact_untagged: "The job queue uses SQS" },
  };
  const unreachable = () => {
    throw new Error("resolution must not touch any other memory operation");
  };
  return {
    factStore: {
      async findFactById(input: { groupId: string; factId: string }) {
        const fact = factsByGroup[input.groupId]?.[input.factId];
        return fact ? { uuid: input.factId, fact } : null;
      },
      ingest: unreachable,
      retrieve: unreachable,
      entity: unreachable,
      graph: unreachable,
      removeFact: unreachable,
      removeEntity: unreachable,
      transferEntity: unreachable,
    },
  };
});

// Replace only the guarded singleton, with a real GuardedMemoryStore over that
// backend — the access gate itself is what is being tested, so it is never
// stubbed.
vi.mock("@/services/memory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/memory")>();
  return { ...actual, guardedMemory: new actual.GuardedMemoryStore(factStore as never) };
});

import { db } from "@/lib/db";
import { AccessDeniedError, orgRootPath, type AccessContext } from "@/services/access";
import { recordFactProvenance, UnresolvedFactError } from "./fact-provenance";

const human = (): AccessContext => ({
  orgId: "org_1",
  actor: { type: "human", id: "user_1", role: "member" },
  origin: "app",
});

/** check()'s grant lookup returns one row per matching grant. */
const grantRow = (permission: "read" | "write" | "admin") => [{ permission }];
const noGrant = () => [];

const linkInput = (scopePath: string, graphitiFactUuid: string) => ({
  orgId: "org_1",
  scopePath,
  graphitiFactUuid,
  sourceType: "pr" as const,
  sourceRef: "github.com/acme/app/pull/42",
  recordedRevision: "sha_old",
  ownerId: "user_1",
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test_id" } as never);
  vi.mocked(db.factProvenance.create).mockResolvedValue({ id: "prov_1" } as never);
});

describe("recordFactProvenance resolves the fact before writing", () => {
  it("refuses a forged uuid that names no fact anywhere", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValue(grantRow("write") as never);

    await expect(recordFactProvenance(human(), linkInput("org_1.deal_a", "fact_forged"))).rejects.toThrow(
      UnresolvedFactError,
    );
    expect(db.factProvenance.create).not.toHaveBeenCalled();
  });

  // The finding itself: a caller who legitimately writes to deal_a naming a
  // real fact that lives in deal_b. The write is authorized; the fact is not
  // theirs. Before this fix the row was created anyway.
  it("refuses a real fact from a scope the caller is not writing to", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValue(grantRow("write") as never);

    await expect(recordFactProvenance(human(), linkInput("org_1.deal_a", "fact_in_b"))).rejects.toThrow(
      UnresolvedFactError,
    );
    expect(db.factProvenance.create).not.toHaveBeenCalled();
  });

  it("reports a cross-scope uuid exactly as an unknown one, so neither confirms the fact is real", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValue(grantRow("write") as never);

    const crossScope = await recordFactProvenance(human(), linkInput("org_1.deal_a", "fact_in_b")).catch(
      (e: Error) => e,
    );
    const unknown = await recordFactProvenance(human(), linkInput("org_1.deal_a", "fact_forged")).catch(
      (e: Error) => e,
    );

    expect(crossScope).toBeInstanceOf(UnresolvedFactError);
    expect(unknown).toBeInstanceOf(UnresolvedFactError);
    expect((crossScope as Error).message).toBe((unknown as Error).message);
  });

  it("refuses when the caller holds no grant on the scope at all", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValue(noGrant() as never);

    await expect(recordFactProvenance(human(), linkInput("org_1.deal_a", "fact_in_a"))).rejects.toThrow(
      AccessDeniedError,
    );
    expect(db.factProvenance.create).not.toHaveBeenCalled();
  });

  // Guards against the refusals above passing for the wrong reason: if the
  // resolution simply failed closed on everything, this case would fail too.
  it("records the link when the fact really lives in the scope being written to", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValue(grantRow("write") as never);

    await recordFactProvenance(human(), linkInput("org_1.deal_a", "fact_in_a"));

    expect(db.factProvenance.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orgId: "org_1",
        scopePath: "org_1.deal_a",
        graphitiFactUuid: "fact_in_a",
        sourceRef: "github.com/acme/app/pull/42",
        status: "fresh",
      }),
    });
  });

  // Untagged content is ordinary org content, so an org-root write must still
  // resolve it — the same bare-org leg retrieve() has always carried. Without
  // it the route's own default scope would refuse the most common case.
  it("resolves an untagged fact for a caller writing at org root", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValue(grantRow("write") as never);

    await recordFactProvenance(human(), linkInput(orgRootPath("org_1"), "fact_untagged"));

    expect(db.factProvenance.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        scopePath: orgRootPath("org_1"),
        graphitiFactUuid: "fact_untagged",
      }),
    });
  });

  // ...and only at org root. A grant on one deal must not reach the untagged
  // partition, which Graphiti cannot filter by scope at all.
  it("refuses the same untagged fact for a caller writing to a single scope", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValue(grantRow("write") as never);

    await expect(recordFactProvenance(human(), linkInput("org_1.deal_a", "fact_untagged"))).rejects.toThrow(
      UnresolvedFactError,
    );
    expect(db.factProvenance.create).not.toHaveBeenCalled();
  });

  it("records a fact in deal_b for a caller writing to deal_b, not only deal_a", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValue(grantRow("write") as never);

    await recordFactProvenance(human(), linkInput("org_1.deal_b", "fact_in_b"));

    expect(db.factProvenance.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ scopePath: "org_1.deal_b", graphitiFactUuid: "fact_in_b" }),
    });
  });
});
