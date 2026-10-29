// loadOwnPendingFacts serves an agent's own not-yet-extracted versions; a person's entity
// page (GET /api/memory/entities/[id]) is unchanged. The agent case runs against a real
// database in mcp/graph-read-your-writes.realdb.test.ts.
import { describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { loadOwnPendingFacts } from "./own-pending-facts";

vi.mock("@/lib/db", () => ({
  db: { $queryRaw: vi.fn(async () => [{ id: "v1", content: "Acme renewed.", actor_name: null }]) },
}));

const lookup = { entityName: "Acme", partition: "org_acme.sales", alreadyHeld: new Set<string>() };

describe("loadOwnPendingFacts", () => {
  it("serves a person nothing and reads nothing", async () => {
    const facts = await loadOwnPendingFacts(
      { orgId: "acme", origin: "web", actor: { type: "human", id: "u1", role: "admin" } } as never,
      lookup,
    );

    expect(facts).toEqual([]);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("serves an agent its own rows", async () => {
    const facts = await loadOwnPendingFacts(
      { orgId: "acme", origin: "mcp", actor: { type: "agent", id: "a1" } } as never,
      lookup,
    );

    expect(facts.map((f) => f.fact)).toEqual(["Acme renewed."]);
  });
});
