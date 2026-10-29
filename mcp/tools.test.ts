// A refusal never discloses what it refused.
//
// Two leaks live on this seam. check() resolves a request into a target scope
// path whose ltree labels are entity names, and it names the real owner of a
// misused capability token — both of which belong in the audit row and in
// neither case in the reply to the caller who was refused. AccessDecision.reason
// is the client-safe half (services/access/deny-reason.ts); auditReason carries
// the resolved path to audit_log.
//
// These run end to end through registerWillderTools and the real
// check()/guardedMemory chain (only @/lib/db and the raw store mocked, the same
// boundary services/access/check.test.ts uses), and assert on the response body
// and on the persisted audit row, so a regression anywhere in the real wiring
// fails here — not only in one helper.
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

vi.mock("@/lib/db", () => ({
  db: {
    // guardedMemory reads the org's account tier after check() allows a read; no tier recorded means the default.
    org: { findUnique: async () => ({ settings: {} }) },
    $queryRaw: vi.fn(),
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_test" }), update: vi.fn() },
    // get_my_brief resolves a caller-supplied briefId to the brief's OWN scope.
    brief: { findFirst: vi.fn() },
  },
}));
vi.mock("@/services/access/scope-registry", () => ({ strictDescendantScopePaths: vi.fn(async () => []) }));
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
import { NO_DRIFT, toolListDrift } from "./tool-list-drift.testsupport";
import type { AccessContext } from "@/services/access";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type Handler = (
  a: Record<string, unknown>,
) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;

function fakeMcpServer() {
  const tools = new Map<string, Handler>();
  return {
    registerTool: vi.fn((name: string, _c: unknown, handler: Handler) => {
      tools.set(name, handler);
    }),
    tools,
  };
}

const ORG = "org_tools_test";

/** Register the real handlers against a context claiming actor "agent_1". */
function handlers(scopePath = ORG) {
  const ctx: AccessContext = {
    orgId: ORG,
    actor: { type: "agent", id: "agent_1", capabilityToken: "wcap_xyz" },
    origin: "mcp",
  };
  const server = fakeMcpServer();
  registerWillderTools(server as unknown as McpServer, ctx, { orgId: ORG, agentId: "agent_1", scopePath });
  return server.tools;
}

/** The ltree label a refusal must never contain. In every test below it reaches
 * check() only because the SERVER resolved it — from the token, or from a brief
 * the caller named by id — never because the caller typed it. */
const SUBJECT_LABEL = "Northwind_Holdings";
const RESOLVED_SCOPE = `${ORG}.${SUBJECT_LABEL}.detail`;

/** The text of a tool reply, as one string. */
const replyText = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join("\n");

/** The reason persisted by the last audit row check() wrote. */
function lastAuditRow() {
  const call = vi.mocked(db.auditLog.create).mock.calls.at(-1)?.[0] as {
    data: { decision: string; target: string; reason: string };
  };
  return call.data;
}

describe("registerWillderTools — capability-owner mismatch deny, end to end", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test" } as never);
  });

  it("memory_query denies a claimed-vs-token-owner mismatch with a generic reason, while the audited row still gets the real owner", async () => {
    // The token's own capability row was issued to a different agent than
    // the one this call's context claims — check()'s real evaluate() must
    // deny this exact way (services/access/check.test.ts pins the same
    // scenario against evaluate() directly; this drives it through the real
    // MCP tool response instead).
    vi.mocked(db.$queryRaw).mockResolvedValue([
      { permission: "read", createdBy: null, agentId: "agent_someone_else" },
    ] as never);

    const memoryQuery = handlers().get("memory_query")!;
    const result = await memoryQuery({ query: "what do we know about Acme?" });

    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toMatch(/Access denied/i);
    expect(text).toMatch(/agentId mismatch/i);
    // The leak this fix closes: the real token owner must never appear in
    // what the caller who presented the mismatched claim gets back.
    expect(text).not.toMatch(/agent_someone_else/);

    // But the audit row (what services/access/check.ts's recordAudit wrote)
    // keeps the full claimed-vs-actual pair — asserted on the actual mocked
    // persistence call, not just on an intermediate value.
    const auditCall = vi.mocked(db.auditLog.create).mock.calls.at(-1)?.[0] as {
      data: { decision: string; actorId: string; reason: string };
    };
    expect(auditCall.data.decision).toBe("deny");
    expect(auditCall.data.actorId).toBe("agent_1");
    expect(auditCall.data.reason).toMatch(/agent_someone_else/);
    expect(auditCall.data.reason).toMatch(/agent_1/);
  });

  it("memory_query still denies (and logs the real reason to the client) for an ordinary no-capability deny — unaffected by the mismatch fix", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValue([]);

    const memoryQuery = handlers().get("memory_query")!;
    const result = await memoryQuery({ query: "what do we know about Acme?" });

    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toMatch(/Access denied/i);
    expect(text).toMatch(/no valid capability/i);
  });
});

// ---------------------------------------------------------------------------
// A whitespace-only or empty-string caller-supplied scopePath is truthy for
// `??`, so a bare `scopePath ?? cap.scopePath ?? orgRootPath(...)` never falls
// back and hands check()'s evaluate() a value that fails the real `::ltree`
// cast in Postgres, throwing before recordAudit ever runs (an unaudited failed
// access attempt with a raw DB error handed back via toolError).
// normalizeScopePath runs first, so an empty or whitespace scopePath is treated
// as "not given" and falls back to the token's own cap.scopePath — a real,
// valid ltree value — same as omitting scopePath entirely.
// ---------------------------------------------------------------------------

describe("memory_query / memory_entity — a whitespace-only or empty caller scopePath must never reach check() unnormalized", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test" } as never);
    vi.mocked(db.$queryRaw).mockResolvedValue([{ permission: "read", createdBy: null, agentId: "agent_1" }] as never);
  });

  it("memory_query: a whitespace-only scopePath falls back to the token's own scope instead of reaching check()'s ltree cast raw", async () => {
    const memoryQuery = handlers().get("memory_query")!;
    const result = await memoryQuery({ query: "anything", scopePath: "   " });

    expect(result.isError).not.toBe(true);
    // check()'s only DB call here is the capability/grant lookup — its bound
    // ltree target must be the normalized fallback (cap.scopePath === ORG,
    // handlers()'s own capability scope), never the raw whitespace string a
    // real Postgres `::ltree` cast would reject.
    const values = vi.mocked(db.$queryRaw).mock.calls.flatMap((call) => call.slice(1));
    expect(values).not.toContain("   ");
    expect(values).toContain(ORG);
  });

  it("memory_entity: an empty-string scopePath falls back the same way", async () => {
    const memoryEntity = handlers().get("memory_entity")!;
    const result = await memoryEntity({ entityId: "e1", scopePath: "" });

    expect(result.isError).not.toBe(true);
    const values = vi.mocked(db.$queryRaw).mock.calls.flatMap((call) => call.slice(1));
    expect(values).not.toContain("");
    expect(values).toContain(ORG);
  });
});

// ---------------------------------------------------------------------------
// The label-existence leak: a refusal that echoes the scope path the server
// resolved tells a caller who was just refused that the subject in that path
// exists. Echoing a scope the CALLER supplied is fine — they already knew it —
// so each test here puts the label somewhere only the server could have found.
// ---------------------------------------------------------------------------

describe("a refusal never names the scope path the server resolved", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test" } as never);
    // No capability row covers the action: the ordinary default deny.
    vi.mocked(db.$queryRaw).mockResolvedValue([] as never);
  });

  it("memory_query: the token's own resolved scope stays out of the reply and in the audit row", async () => {
    // The caller passes no scopePath, so the target is resolved from the token.
    const memoryQuery = handlers(RESOLVED_SCOPE).get("memory_query")!;
    const result = await memoryQuery({ query: "what do we know about them?" });

    expect(result.isError).toBe(true);
    const text = replyText(result);
    expect(text).not.toContain(SUBJECT_LABEL);
    // Still says what was missing and how to fix it (CONTRIBUTING.md's bar for
    // an error message), without naming the target.
    expect(text).toMatch(/no valid capability/i);
    expect(text).toMatch(/read/);
    expect(text).toMatch(/ask an org admin/i);

    const row = lastAuditRow();
    expect(row.decision).toBe("deny");
    expect(row.target).toContain(RESOLVED_SCOPE);
    expect(row.reason).toContain(RESOLVED_SCOPE);
  });

  it("get_my_brief: a brief named by id is authorized against the brief's own scope, which the refusal does not disclose", async () => {
    vi.mocked(db.brief.findFirst).mockResolvedValue({
      id: "brief_1",
      title: "Handoff",
      summary: "",
      sections: [],
      granteeName: null,
      scopePath: RESOLVED_SCOPE,
      scopeLabel: null,
      googleDocUrl: null,
      createdAt: new Date(),
    } as never);

    const getMyBrief = handlers().get("get_my_brief")!;
    const result = await getMyBrief({ briefId: "brief_1" });

    expect(result.isError).toBe(true);
    const text = replyText(result);
    // The caller supplied only an id. Learning the scope label from the refusal
    // would turn this tool into an existence oracle for whatever that brief is about.
    expect(text).not.toContain(SUBJECT_LABEL);
    expect(text).toMatch(/no valid capability/i);

    const row = lastAuditRow();
    expect(row.decision).toBe("deny");
    expect(row.reason).toContain(RESOLVED_SCOPE);
  });

  it("memory_query: a scope the CALLER supplied is still echoed — that is theirs to know", async () => {
    const memoryQuery = handlers().get("memory_query")!;
    const result = await memoryQuery({ query: "anything?", scopePath: "not a valid ltree!" });

    expect(result.isError).toBe(true);
    // The read direction falls back instead of refusing a malformed scopePath,
    // so the refusal here is the ordinary deny; what matters is that an
    // invalid-scope refusal on the WRITE direction quotes the caller's value.
    const ingest = handlers().get("memory_ingest")!;
    const written = await ingest({ content: "x", name: "y", scopePath: "not a valid ltree!" });
    expect(replyText(written)).toContain("not a valid ltree!");
  });

  // The regression guard: every registered tool, refused, checked against the
  // resolved label. A new tool that interpolates a resolved path into its own
  // error text fails here without anyone remembering to write a test for it,
  // and a tool added without a row in MINIMAL_ARGS fails too.
  const MINIMAL_ARGS: Record<string, Record<string, unknown>> = {
    memory_query: { query: "q" },
    memory_entity: { entityId: "e_1" },
    memory_version: { versionId: "v_1" },
    memory_ingest: { content: "c", name: "n" },
    fact_link_source: { graphitiFactUuid: "u", sourceType: "pr", sourceRef: "r" },
    get_my_brief: {},
    memory_stale: {},
    memory_changes: {},
    memory_note: { kind: "claim", task: "t", body: "b" },
    contact_search: {},
    contact_read: { contactId: "c_1" },
    contact_upsert: { idempotencyKey: "k", name: "n" },
    send_feedback: { kind: "bug", message: "m" },
  };

  it("no registered tool's refusal contains the resolved scope label", async () => {
    const tools = handlers(RESOLVED_SCOPE);
    expect(
      toolListDrift(tools.keys(), Object.keys(MINIMAL_ARGS)),
      "Give each unlisted tool its smallest valid arguments in MINIMAL_ARGS (mcp/tools.test.ts), and delete each stale entry",
    ).toEqual(NO_DRIFT);

    for (const [name, handler] of tools) {
      const result = await handler(MINIMAL_ARGS[name]).catch((e: unknown) => ({
        content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
      }));
      expect(replyText(result), `${name} disclosed the resolved scope label`).not.toContain(SUBJECT_LABEL);
    }
  });
});
