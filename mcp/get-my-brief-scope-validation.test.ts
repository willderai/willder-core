// get_my_brief's non-briefId branch: a caller-supplied scopePath goes through the
// shared resolveCallerScopePath() helper (services/access/check.ts) in read-side
// ("fallback") mode, the same direction memory_query and memory_entity use, so an
// unguarded string never reaches check()'s ::ltree cast raw (see
// mcp/read-scope-validation.test.ts and mcp/ingest-scope-validation.test.ts for
// the read/write siblings of this file).
//
// Two things pinned: the check() target never sees the raw malformed string, and
// the db.brief.findFirst query's own scopePath filter uses the SAME resolved
// value, so the query and the check() target cannot disagree.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: vi.fn(),
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_test" }), update: vi.fn() },
    brief: { findFirst: vi.fn() },
  },
}));
vi.mock("@/services/memory/store", () => ({
  memory: {
    retrieve: vi.fn().mockResolvedValue({ facts: [] }),
    entity: vi.fn(),
    ingest: vi.fn(),
    graph: vi.fn(),
    removeFact: vi.fn(),
    removeEntity: vi.fn(),
    transferEntity: vi.fn(),
  },
  graphitiStore: {},
}));
vi.mock("@/services/signals", () => ({ recordFeedback: vi.fn().mockResolvedValue(undefined) }));

import { db } from "@/lib/db";
import { registerWillderTools } from "./tools";
import type { AccessContext } from "@/services/access";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type Handler = (
  a: Record<string, unknown>,
) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;

const ORG = "org_brief_scope_test";

function handlers(capScopePath: string = ORG) {
  const ctx: AccessContext = {
    orgId: ORG,
    actor: { type: "agent", id: "agent_1", capabilityToken: "wcap_xyz" },
    origin: "mcp",
  };
  const tools = new Map<string, Handler>();
  const server = {
    registerTool: vi.fn((name: string, _c: unknown, handler: Handler) => {
      tools.set(name, handler);
    }),
  };
  registerWillderTools(server as unknown as McpServer, ctx, {
    orgId: ORG,
    agentId: "agent_1",
    scopePath: capScopePath,
  });
  return tools;
}

/** Every value bound into any check() query this call made. */
function boundValues(): unknown[] {
  return vi.mocked(db.$queryRaw).mock.calls.flatMap((call) => call.slice(1));
}

describe("get_my_brief (no briefId) — a malformed or empty caller scopePath must never reach check()'s ltree cast raw", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test" } as never);
    vi.mocked(db.$queryRaw).mockResolvedValue([{ permission: "read", createdBy: null, agentId: "agent_1" }] as never);
    vi.mocked(db.brief.findFirst).mockResolvedValue(null);
  });

  // A space is invalid ltree syntax (42601) on Postgres; a hyphen is legal. Same
  // exemplar read-scope-validation.test.ts and ingest-scope-validation.test.ts use.
  const MALFORMED = `${ORG}.deal A`;

  it("a malformed (space-containing) scopePath is not handed to check() verbatim — falls back to the token's own scope", async () => {
    const getMyBrief = handlers().get("get_my_brief")!;
    const result = await getMyBrief({ scopePath: MALFORMED });

    expect(boundValues()).not.toContain(MALFORMED);
    expect(boundValues()).toContain(ORG);
    // Read-side: falls back rather than erroring, so no raw Postgres error
    // ever reaches the caller.
    expect(result.isError).not.toBe(true);
  });

  it("the db query is gated on the SAME resolved scope check() used, not the raw malformed input", async () => {
    const getMyBrief = handlers().get("get_my_brief")!;
    await getMyBrief({ scopePath: MALFORMED });

    const where = vi.mocked(db.brief.findFirst).mock.calls.at(-1)?.[0] as { where: { scopePath?: string } } | undefined;
    expect(where?.where.scopePath).toBe(ORG);
  });

  it("an empty-string scopePath falls back to the token's own scope instead of surviving `??`", async () => {
    const getMyBrief = handlers().get("get_my_brief")!;
    await getMyBrief({ scopePath: "" });

    expect(boundValues()).not.toContain("");
    expect(boundValues()).toContain(ORG);
  });

  it("a whitespace-only scopePath does the same", async () => {
    const getMyBrief = handlers().get("get_my_brief")!;
    await getMyBrief({ scopePath: "   " });

    expect(boundValues()).not.toContain("   ");
    expect(boundValues()).toContain(ORG);
  });

  it("a well-formed caller scopePath is still honored — the guard must not swallow valid narrowing", async () => {
    const VALID = `${ORG}.dealA`;
    const getMyBrief = handlers().get("get_my_brief")!;
    await getMyBrief({ scopePath: VALID });

    expect(boundValues()).toContain(VALID);
    const where = vi.mocked(db.brief.findFirst).mock.calls.at(-1)?.[0] as { where: { scopePath?: string } } | undefined;
    expect(where?.where.scopePath).toBe(VALID);
  });

  it("a padded but otherwise valid scopePath is trimmed and honored, not treated as malformed", async () => {
    const VALID = `${ORG}.dealA`;
    const getMyBrief = handlers().get("get_my_brief")!;
    await getMyBrief({ scopePath: `  ${VALID}  ` });

    expect(boundValues()).toContain(VALID);
    expect(boundValues()).not.toContain(`  ${VALID}  `);
  });
});
