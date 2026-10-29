// The stores a write lands in, asked of the policy (absorb) instead of listed by each caller.
import { describe, expect, it } from "vitest";
import { ACCOUNT_TIERS } from "./account-tiers";
import { ABSORB_TABLE, CONTENT_SHAPES, absorb, storesWritten } from "./routing-policy";

describe("storesWritten", () => {
  it("is the chunk store always, and the graph exactly when the absorb plan is not none", () => {
    for (const tier of ACCOUNT_TIERS) {
      for (const recordType of [undefined, "document", "decision"] as const) {
        const row = { content: "a fact", recordType };
        const graph = absorb(row, tier).graph !== "none";
        expect(storesWritten(row, tier)).toEqual(graph ? ["graph", "semantic"] : ["semantic"]);
      }
    }
  });

  it("writes no graph for a handoff, whatever the tier", () => {
    expect(storesWritten({ content: "x", skipGraphExtraction: true }, "enterprise")).toEqual(["semantic"]);
  });

  it("reads the table, so every shape's plan decides", () => {
    expect(CONTENT_SHAPES.every((s) => ABSORB_TABLE.enterprise[s] === "none")).toBe(false);
  });
});
