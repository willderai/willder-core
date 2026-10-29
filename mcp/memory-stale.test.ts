// memory_stale: the scope it reads at (the token's own by default, never a malformed
// value), and the lines it answers with. What staleReport() itself reads, and its access
// rule, are proven against a real database in services/memory/dependencies.realdb.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: vi.fn(),
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_test" }), update: vi.fn() },
  },
}));
vi.mock("@/services/memory/store", () => ({ memory: {}, graphitiStore: {} }));
vi.mock("@/services/memory/dependencies", async (orig) => ({
  ...(await orig<typeof import("@/services/memory/dependencies")>()),
  staleReport: vi.fn(),
}));

import { AccessDeniedError, type AccessContext } from "@/services/access";
import { staleReport, type Recommendation } from "@/services/memory/dependencies";
import { registerWillderTools } from "./tools";
import { formatRecommendation } from "./tools/memory-stale";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type Handler = (
  a: Record<string, unknown>,
) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;

const ORG = "org_stale_test";
const CAP_SCOPE = `${ORG}.eng`;

function memoryStale(): Handler {
  const ctx: AccessContext = {
    orgId: ORG,
    actor: { type: "agent", id: "agent_1", capabilityToken: "wcap_xyz" },
    origin: "mcp",
  };
  const tools = new Map<string, Handler>();
  const server = { registerTool: vi.fn((name: string, _c: unknown, handler: Handler) => tools.set(name, handler)) };
  registerWillderTools(server as unknown as McpServer, ctx, { orgId: ORG, agentId: "agent_1", scopePath: CAP_SCOPE });
  return tools.get("memory_stale")!;
}

const at = new Date("2026-10-16T12:00:00.000Z");
const recommendation = (over: Partial<Recommendation> = {}): Recommendation => ({
  recordId: "brief_1",
  dependents: 0,
  staleSources: 1,
  latest: { sourceId: "fact_1", kind: "cites", reason: { kind: "superseded", at, byId: "fact_2" } },
  ...over,
});

/** The tool's own answer, without the change notice or task-start block that may ride after it. */
const answer = (result: Awaited<ReturnType<Handler>>) => result.content[0]!.text.split("\n\n")[0];

describe("memory_stale", () => {
  beforeEach(() => {
    vi.mocked(staleReport).mockReset();
    vi.mocked(staleReport).mockResolvedValue({ stale: [], recommend: [], truncated: false });
  });

  it("reads at the token's scope when none is sent, and when the one sent is malformed", async () => {
    for (const scopePath of [undefined, "", `${CAP_SCOPE}..x`, "not a path"]) {
      await memoryStale()({ scopePath });
    }
    expect(vi.mocked(staleReport).mock.calls.map((call) => call[1])).toEqual([
      CAP_SCOPE,
      CAP_SCOPE,
      CAP_SCOPE,
      CAP_SCOPE,
    ]);
  });

  it("reads at a narrower scope it is sent, with the limit", async () => {
    await memoryStale()({ scopePath: `${CAP_SCOPE}.api`, limit: 5 });
    expect(vi.mocked(staleReport).mock.calls[0]!.slice(1)).toEqual([`${CAP_SCOPE}.api`, 5]);
  });

  it("says when nothing is stale, and when the report was cut off", async () => {
    expect(answer(await memoryStale()({}))).toBe(`Nothing stale in ${CAP_SCOPE}.`);
    vi.mocked(staleReport).mockResolvedValue({ stale: [], recommend: [recommendation()], truncated: true });
    expect(answer(await memoryStale()({}))).toBe(
      [
        "• brief_1: cites fact_1, replaced by fact_2 at 2026-10-16T12:00:00.000Z; 0 records rest on it",
        `Only the newest 500 rows of each query were read; older records in ${CAP_SCOPE} were not checked.`,
      ].join("\n"),
    );
  });

  it("answers a refused read as a tool error", async () => {
    vi.mocked(staleReport).mockRejectedValue(
      new AccessDeniedError({ allowed: false, reason: "no grant covers this scope" }),
    );
    const result = await memoryStale()({});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/no grant covers this scope/);
  });
});

describe("formatRecommendation", () => {
  it.each([
    [{ kind: "changed" as const, at, op: "update" as const }, "updated"],
    [{ kind: "changed" as const, at, op: "delete" as const }, "deleted"],
    [{ kind: "changed" as const, at, op: "revoke" as const }, "revoked"],
    [{ kind: "changed" as const, at, op: "supersede" as const }, "superseded"],
  ])("names why the source moved on: %j", (reason, word) => {
    const line = formatRecommendation(recommendation({ latest: { sourceId: "fact_1", kind: "cites", reason } }));
    expect(line).toBe(`• brief_1: cites fact_1, ${word} at 2026-10-16T12:00:00.000Z; 0 records rest on it`);
  });

  it("says rests on for an edge, counts dependents and how many sources moved", () => {
    const line = formatRecommendation(
      recommendation({
        dependents: 1,
        staleSources: 3,
        latest: { sourceId: "f", kind: "dependsOn", reason: { kind: "changed", at, op: "delete" } },
      }),
    );
    expect(line).toBe(
      "• brief_1: rests on f, deleted at 2026-10-16T12:00:00.000Z (3 of its sources moved on); 1 record rests on it",
    );
  });
});
