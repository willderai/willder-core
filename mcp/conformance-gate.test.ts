// Who may be served the conformance suite's fixtures, and whose reply a pending client request
// takes. Pure: no database.
//  - conformanceFixturesAllowed: only an org/agent pair MCP_CONFORMANCE_AGENTS lists; unset or
//    empty means nobody, so production serves no fixture unless an operator names an agent;
//  - credentialKeyOf: the relay binds a request to the token that asked, so another token of the
//    same agent (another scope, another app) cannot answer it; the raw token is never stored.
import { describe, expect, it } from "vitest";
import { conformanceFixturesAllowed } from "./conformance-fixtures";
import { credentialKeyOf } from "./client-requests";

describe("conformanceFixturesAllowed", () => {
  const caller = { orgId: "org1", agentId: "g5" };

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["only separators", " , ,"],
  ])("allows nobody when MCP_CONFORMANCE_AGENTS is %s", (_, value) => {
    expect(conformanceFixturesAllowed(caller, { MCP_CONFORMANCE_AGENTS: value })).toBe(false);
  });

  it("allows a listed org/agent pair, among others and with spaces around it", () => {
    expect(conformanceFixturesAllowed(caller, { MCP_CONFORMANCE_AGENTS: "org2/x, org1/g5 ,org3/y" })).toBe(true);
  });

  it.each([
    ["the same agent in another org", { orgId: "org2", agentId: "g5" }],
    ["another agent in the org", { orgId: "org1", agentId: "g6" }],
    ["an agent whose id only starts with a listed one", { orgId: "org1", agentId: "g" }],
    ["a pair that only matches across the slash", { orgId: "org1/g5", agentId: "" }],
  ])("refuses %s", (_, other) => {
    expect(conformanceFixturesAllowed(other, { MCP_CONFORMANCE_AGENTS: "org1/g5" })).toBe(false);
  });

  it("reads the environment of the process by default", () => {
    const before = process.env.MCP_CONFORMANCE_AGENTS;
    try {
      delete process.env.MCP_CONFORMANCE_AGENTS;
      expect(conformanceFixturesAllowed(caller)).toBe(false);
      process.env.MCP_CONFORMANCE_AGENTS = "org1/g5";
      expect(conformanceFixturesAllowed(caller)).toBe(true);
    } finally {
      if (before === undefined) delete process.env.MCP_CONFORMANCE_AGENTS;
      else process.env.MCP_CONFORMANCE_AGENTS = before;
    }
  });
});

describe("credentialKeyOf", () => {
  it("gives two bearer tokens of one agent different keys, and one token the same key each time", () => {
    const a = credentialKeyOf({ capabilityToken: "wcap_one" });
    const b = credentialKeyOf({ capabilityToken: "wcap_two" });
    expect(a).not.toEqual(b);
    expect(credentialKeyOf({ capabilityToken: "wcap_one" })).toEqual(a);
  });

  it("never holds the raw token", () => {
    expect(credentialKeyOf({ capabilityToken: "wcap_secret_value" })).not.toContain("wcap_secret_value");
  });

  it("keys an OAuth caller by the capability it was issued for, apart from any bearer token", () => {
    const oauth = credentialKeyOf({ capabilityId: "cap1" });
    expect(oauth).toEqual(credentialKeyOf({ capabilityId: "cap1" }));
    expect(oauth).not.toEqual(credentialKeyOf({ capabilityId: "cap2" }));
    expect(oauth).not.toEqual(credentialKeyOf({ capabilityToken: "cap1" }));
  });
});
