// The account-tier gate for the readers of rows anchored on a graph uuid: FactDispute and FactProvenance lists,
// and the enrichment job's entity link. On a tier that does not read the graph, a row anchored
// on a graph edge is not served (the edge is not either); a row anchored on one of the org's
// raw rows still is. On enterprise, every org's tier today, nothing is filtered.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { settings } = vi.hoisted(() => ({ settings: { current: {} as Record<string, unknown> } }));
vi.mock("@/lib/db", () => ({
  db: {
    org: { findUnique: vi.fn(async () => ({ settings: settings.current })) },
    memoryChunk: { findMany: vi.fn() },
    factDispute: { findMany: vi.fn() },
    factProvenance: { findMany: vi.fn() },
    account: { update: vi.fn() },
    contact: { update: vi.fn() },
  },
}));
vi.mock("@/services/access", async () => {
  const actual = await vi.importActual<typeof import("@/services/access/check")>("@/services/access/check");
  return { check: vi.fn(async () => ({ allowed: true, reason: "grant" })), orgRootPath: actual.orgRootPath };
});
vi.mock("@/services/memory", () => ({ guardedMemory: {}, memory: { graph: vi.fn() } }));
vi.mock("@/services/enrichment", () => ({ enrich: vi.fn() }));
vi.mock("@/lib/inngest/client", () => ({ inngest: { createFunction: vi.fn() } }));

import { db } from "@/lib/db";
import { memory } from "@/services/memory";
import type { AccessContext } from "@/services/access";
import { listResolvableFactDisputes } from "./fact-disputes";
import { listReadableFactProvenance } from "./fact-provenance";
import { linkEntity } from "@/lib/inngest/enrichment";

const ctx: AccessContext = { orgId: "org_1", actor: { type: "human", id: "user_1", role: "owner" }, origin: "app" };
const row = (id: string, graphitiFactUuid: string) => ({
  id,
  orgId: "org_1",
  scopePath: "org_1.eng",
  graphitiFactUuid,
  status: "disputed",
});

beforeEach(() => {
  vi.clearAllMocks();
  settings.current = {};
  vi.mocked(db.memoryChunk.findMany).mockResolvedValue([{ id: "chunk_1" }] as never);
  vi.mocked(db.factDispute.findMany).mockResolvedValue([row("d_edge", "edge_1"), row("d_raw", "chunk_1")] as never);
  vi.mocked(db.factProvenance.findMany).mockResolvedValue([row("p_edge", "edge_1"), row("p_raw", "chunk_1")] as never);
  vi.mocked(memory.graph).mockResolvedValue({ nodes: [{ uuid: "n_acme", name: "Acme", type: "company" }], edges: [] });
});

describe("FactDispute: the resolvable list", () => {
  it("serves every dispute on enterprise, with no raw-row lookup", async () => {
    expect((await listResolvableFactDisputes(ctx)).map((d) => d.id)).toEqual(["d_edge", "d_raw"]);
    expect(db.memoryChunk.findMany).not.toHaveBeenCalled();
  });

  it("serves only disputes anchored on a raw row on a tier that does not read the graph", async () => {
    settings.current = { accountTier: "team" };
    expect((await listResolvableFactDisputes(ctx)).map((d) => d.id)).toEqual(["d_raw"]);
    expect(db.memoryChunk.findMany).toHaveBeenCalledWith({
      where: { orgId: "org_1", id: { in: ["edge_1", "chunk_1"] } },
      select: { id: true },
    });
  });
});

describe("FactProvenance: one fact's links", () => {
  it("serves every row on enterprise", async () => {
    expect((await listReadableFactProvenance(ctx, "edge_1")).map((p) => p.id)).toEqual(["p_edge", "p_raw"]);
  });

  it("serves only rows anchored on a raw row on starter", async () => {
    settings.current = { accountTier: "starter" };
    expect((await listReadableFactProvenance(ctx, "edge_1")).map((p) => p.id)).toEqual(["p_raw"]);
  });
});

describe("enrichment's entity link", () => {
  const input = {
    orgId: "org_1",
    target: { kind: "account" as const, name: "Acme" },
    recordId: "a1",
    actorId: "u1",
    origin: "app" as const,
  };

  it("links the graph entity on enterprise", async () => {
    expect(await linkEntity(input)).toBe("n_acme");
  });

  it("reads no graph and links nothing on team", async () => {
    settings.current = { accountTier: "team" };
    expect(await linkEntity(input)).toBeNull();
    expect(memory.graph).not.toHaveBeenCalled();
    expect(db.account.update).not.toHaveBeenCalled();
  });
});
