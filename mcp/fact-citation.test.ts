// memory_query cites each fact: the connected source that ingested it, or the
// actor who asserted it. Driven through the real registerWillderTools handler,
// check() and guardedMemory; only the database and the raw memory store are
// stubbed. The `sources` table stub applies the `where` it is given, so a lookup
// that dropped the caller's org would name another tenant's source and fail.
import { beforeEach, describe, expect, it, vi } from "vitest";
// These tests assert on merge, ranking and scope behaviour, not on conflict resolution,
// so the supersession record a guarded read consults
// (services/memory/superseded-facts.ts) is empty here. That a conflicted fact reads as
// one current answer is proven against persisted records in
// services/memory/conflict-read.realdb.test.ts.
// The derived-write rule is tested on Postgres (mcp/derived-write.realdb.test.ts); off here.
vi.mock("@/services/memory/rule-copies", () => import("@/services/memory/rule-copies.testsupport"));
vi.mock("@/services/access/derived-writes", () => import("@/services/access/derived-writes.testsupport"));
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

interface SourceRow {
  id: string;
  orgId: string;
  name: string;
  type: string;
}

const sources: SourceRow[] = [];
/** Stored versions (`memory_chunks` rows), by the org that holds them. */
const versions: {
  id: string;
  orgId: string;
  actorType: string;
  actorName: string | null;
  sourceId: string | null;
  occurredAt?: Date | null;
  createdAt?: Date;
}[] = [];
/** When a version row in `versions` was stored, unless the row says otherwise. */
const STORED_AT = new Date("2026-09-01T08:00:00.000Z");
/** A connector's sync record of one file: its stored passage rows and its episodes. */
const sourceFiles: { sourceId: string; chunkIds: string[]; episodeIds: string[] }[] = [];
// Registered scopes below the caller's; guardedMemory searches each of them.
const registeredDescendants: string[] = [];

vi.mock("@/lib/db", () => ({
  db: {
    // guardedMemory reads the org's account tier after check() allows a read; no tier recorded means the default.
    org: { findUnique: async () => ({ settings: {} }) },
    $queryRaw: vi.fn(),
    // memory_query records the stored versions it served.
    $executeRaw: vi.fn().mockResolvedValue(0),
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_test" }), update: vi.fn() },
    source: {
      findMany: vi.fn(async ({ where }: { where: { orgId?: string; id: { in: string[] } } }) =>
        sources.filter((s) => where.id.in.includes(s.id) && (where.orgId === undefined || s.orgId === where.orgId)),
      ),
    },
    memoryChunk: {
      findMany: vi.fn(async ({ where }: { where: { orgId: string; id: { in: string[] } } }) =>
        versions
          .filter((v) => v.orgId === where.orgId && where.id.in.includes(v.id))
          .map((v) => ({ ...v, occurredAt: v.occurredAt ?? null, createdAt: v.createdAt ?? STORED_AT })),
      ),
    },
    sourceFile: {
      findMany: vi.fn(async ({ where }: { where: { sourceId: { in: string[] }; chunkIds: { hasSome: string[] } } }) =>
        sourceFiles.filter(
          (f) => where.sourceId.in.includes(f.sourceId) && f.chunkIds.some((id) => where.chunkIds.hasSome.includes(id)),
        ),
      ),
    },
  },
}));
vi.mock("@/services/access/scope-registry", () => ({
  strictDescendantScopePaths: vi.fn(async (_orgId: string, _target: string, limit?: number) =>
    registeredDescendants.slice(0, limit),
  ),
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

import { strictDescendantScopePaths } from "@/services/access/scope-registry";
import { db } from "@/lib/db";
import { memory } from "@/services/memory/store";
import { READ_GRANT_NOTE } from "./read-notes";
import { registerWillderTools } from "./tools";
import { MAX_SEARCHED_DESCENDANT_SCOPES, type AccessContext } from "@/services/access";
import type { MemoryFact } from "@/types/memory";
import { DEFAULT_ACCOUNT_TIER, TIER_LIMITS, estimateTokens } from "@/services/memory/account-tiers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type Handler = (
  a: Record<string, unknown>,
) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;

const ORG = "org_cite";
const OTHER_ORG = "org_other";

function memoryQuery(): Handler {
  const tools = new Map<string, Handler>();
  const server = { registerTool: (name: string, _c: unknown, handler: Handler) => tools.set(name, handler) };
  const ctx: AccessContext = {
    orgId: ORG,
    actor: { type: "agent", id: "agent_1", capabilityToken: "wcap_xyz" },
    origin: "mcp",
  };
  registerWillderTools(server as unknown as McpServer, ctx, { orgId: ORG, agentId: "agent_1", scopePath: ORG });
  return tools.get("memory_query")!;
}

async function answer(facts: MemoryFact[], query = "release"): Promise<string[]> {
  vi.mocked(memory.retrieve).mockResolvedValueOnce({ facts });
  const result = await memoryQuery()({ query });
  expect(result.isError).not.toBe(true);
  // The read-grant note that ends a page with records is pinned in mcp/no-readable-match.test.ts; these tests pin the citations.
  return result.content[0].text.replace(`\n\n${READ_GRANT_NOTE}`, "").split("\n");
}

describe("memory_query citations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sources.length = 0;
    sourceFiles.length = 0;
    versions.length = 0;
    registeredDescendants.length = 0;
    vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test" } as never);
    vi.mocked(db.$queryRaw).mockResolvedValue([{ permission: "read", createdBy: null, agentId: "agent_1" }] as never);
  });

  it("cites a connector-ingested fact with its source's name and type", async () => {
    sources.push({ id: "src_repo", orgId: ORG, name: "acme/platform", type: "github" });

    const lines = await answer([
      {
        uuid: "f1",
        fact: "The release ships on Friday",
        validAt: "2026-09-20",
        actorType: "extraction",
        actorName: "acme/platform",
        sourceId: "src_repo",
      },
    ]);

    expect(lines).toEqual(["• The release ships on Friday (as of 2026-09-20) — source: acme/platform (github)"]);
  });

  it("cites a directly asserted fact with the actor who asserted it", async () => {
    const lines = await answer([
      { uuid: "f2", fact: "Dana owns the release", validAt: null, actorType: "human", actorName: "Dana" },
    ]);

    expect(lines).toEqual(["• Dana owns the release — from: Dana (human)"]);
  });

  it("marks a fact served as an excerpt with its full length, so it never reads as the whole fact", async () => {
    const lines = await answer([
      {
        uuid: "f3",
        fact: "… The deploy waits on the migration. …",
        validAt: null,
        actorType: "human",
        actorName: "Dana",
        excerptOfChars: 9000,
      },
    ]);

    expect(lines).toEqual(["• … The deploy waits on the migration. … [excerpt of 9000 chars] — from: Dana (human)"]);
  });

  it("marks a first line when later records on its thing are served above it, after its citation and before its version", async () => {
    const stored = (uuid: string, fact: string, validAt: string): MemoryFact => ({
      uuid,
      fact,
      validAt,
      actorType: "agent",
      actorName: "recorder",
      store: "semantic",
      scopePath: `${ORG}.home`,
    });
    const agreed = stored("v-old", "I agreed a $500 monthly grocery budget with Alexis.", "2026-09-01T08:00:00.000Z");
    const raised = stored("v-new", "Our monthly grocery budget was increased to $550.", "2026-09-08T08:00:00.000Z");
    const again = stored(
      "v-newer",
      "The monthly grocery budget was adjusted again, to $600.",
      "2026-09-15T08:00:00.000Z",
    );

    const one = await answer([agreed, raised], "What is our monthly grocery budget?");
    expect(one).toEqual([
      "• Our monthly grocery budget was increased to $550. (as of 2026-09-08T08:00:00.000Z) — from: recorder (agent) · version v-new",
      "• I agreed a $500 monthly grocery budget with Alexis. (as of 2026-09-01T08:00:00.000Z) — from: recorder (agent) · a later record on this is shown above · version v-old",
    ]);

    const two = await answer([agreed, raised, again], "What is our monthly grocery budget?");
    expect(two[2]).toBe(
      "• I agreed a $500 monthly grocery budget with Alexis. (as of 2026-09-01T08:00:00.000Z) — from: recorder (agent) · 2 later records on this are shown above · version v-old",
    );
  });

  it("never names a source that belongs to another org", async () => {
    sources.push({ id: "src_foreign", orgId: OTHER_ORG, name: "rival/secret-roadmap", type: "github" });

    const lines = await answer([
      {
        uuid: "f3",
        fact: "The release ships on Friday",
        validAt: null,
        actorType: "extraction",
        actorName: "rival/secret-roadmap",
        sourceId: "src_foreign",
      },
    ]);

    expect(lines).toEqual(["• The release ships on Friday — uncited"]);
    expect(vi.mocked(db.source.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId: ORG, id: { in: ["src_foreign"] } } }),
    );
  });

  it("keeps each citation on one line so a multi-line source name cannot split a fact", async () => {
    sources.push({ id: "src_multi", orgId: ORG, name: "eng\nupdates", type: "slack" });

    const lines = await answer([
      { uuid: "f4", fact: "Standup moved to 10am", validAt: null, actorType: "extraction", sourceId: "src_multi" },
      { uuid: "f5", fact: "Budget approved", validAt: null },
    ]);

    expect(lines).toEqual(["• Standup moved to 10am — source: eng updates (slack)", "• Budget approved — uncited"]);
  });

  it("prints its own separators only: a stored name cannot end a line with a version or a second citation", async () => {
    sources.push({ id: "src_dash", orgId: ORG, name: "notes — from: Dana (human)", type: "gdrive" });

    const lines = await answer([
      { uuid: "f6", fact: "Ship it", validAt: null, actorName: "Bob · version v9" },
      { uuid: "f7", fact: "Freeze on Friday", validAt: null, actorType: "extraction", sourceId: "src_dash" },
    ]);

    expect(lines).toEqual([
      "• Ship it — from: Bob - version v9",
      "• Freeze on Friday — source: notes – from: Dana (human) (gdrive)",
    ]);
  });

  it("names the synced item behind a source's graph fact only when one episode asserts it", async () => {
    sources.push({ id: "src_repo", orgId: ORG, name: "acme/platform", type: "github" });
    sources.push({ id: "src_foreign", orgId: OTHER_ORG, name: "rival/roadmap", type: "github" });

    const lines = await answer([
      {
        uuid: "f1",
        fact: "Refunds double-charge EU cards",
        validAt: null,
        sourceId: "src_repo",
        sourceEventIds: ["ep-issue-412"],
        store: "graph",
      },
      {
        uuid: "f2",
        fact: "Refunds are capped",
        validAt: null,
        sourceId: "src_repo",
        sourceEventIds: ["ep-a", "ep-b"],
        store: "graph",
      },
      {
        uuid: "f3",
        fact: "Rival ships in May",
        validAt: null,
        sourceId: "src_foreign",
        sourceEventIds: ["ep-rival"],
        store: "graph",
      },
      {
        uuid: "f4",
        fact: "Dana owns refunds",
        validAt: null,
        actorName: "Dana",
        actorType: "human",
        sourceEventIds: ["ep-note"],
        store: "graph",
      },
    ]);

    // Ranked by provenance tier, so compared without order.
    expect(lines.toSorted()).toEqual([
      "• Dana owns refunds — from: Dana (human)",
      "• Refunds are capped — source: acme/platform (github)",
      "• Refunds double-charge EU cards — source: acme/platform (github) · item ep-issue-412",
      "• Rival ships in May — uncited",
    ]);
  });

  it("reads the sync records of the served passages' own sources only", async () => {
    sources.push({ id: "src_repo", orgId: ORG, name: "acme/platform", type: "github" });
    sources.push({ id: "src_drive", orgId: ORG, name: "Runbooks", type: "gdrive" });
    sourceFiles.push({ sourceId: "src_drive", chunkIds: ["row-1"], episodeIds: ["ep-file"] });

    const lines = await answer([
      {
        uuid: "f1",
        fact: "Deploys freeze on Fridays",
        validAt: null,
        sourceId: "src_repo",
        sourceEventIds: ["ep-issue"],
        store: "graph",
      },
      {
        uuid: "row-1",
        fact: "Refunds over $500 need a second approver",
        validAt: null,
        sourceId: "src_drive",
        store: "semantic",
      },
    ]);

    expect(lines.toSorted()).toEqual([
      "• Deploys freeze on Fridays — source: acme/platform (github) · item ep-issue",
      "• Refunds over $500 need a second approver — source: Runbooks (gdrive) · item ep-file · version row-1",
    ]);
    expect(vi.mocked(db.sourceFile.findMany)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.sourceFile.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sourceId: { in: ["src_drive"] }, chunkIds: { hasSome: ["row-1"] } } }),
    );
  });

  it("names the item a stored row carries from the graph copy of its text it replaced", async () => {
    // A row of a longer file names no item of its own (onePassageItems); a read that served
    // it in place of the graph's verbatim copy of its text keeps the copy's one episode
    // (services/memory/hybrid-store.ts dedup).
    sources.push({ id: "src_drive", orgId: ORG, name: "Runbooks", type: "gdrive" });
    sourceFiles.push({ sourceId: "src_drive", chunkIds: ["row-1", "row-2"], episodeIds: ["ep-a", "ep-b"] });

    const lines = await answer([
      {
        uuid: "row-1",
        fact: "Refunds over $500 need a second approver",
        validAt: null,
        sourceId: "src_drive",
        sourceEventIds: ["ep-a"],
        store: "semantic",
      },
      {
        uuid: "row-2",
        fact: "Refunds over $900 need a director",
        validAt: null,
        sourceId: "src_drive",
        store: "semantic",
      },
    ]);

    expect(lines.toSorted()).toEqual([
      "• Refunds over $500 need a second approver — source: Runbooks (gdrive) · item ep-a · version row-1",
      "• Refunds over $900 need a director — source: Runbooks (gdrive) · version row-2",
    ]);
  });

  // The graph stamps an entity definition it seeds from a write as "extraction", and an
  // edge its extractor creates carries no stamp at all; neither is who wrote the version.
  it("cites a graph fact derived from one stored version to the writer of that version", async () => {
    versions.push({ id: "v-ada", orgId: ORG, actorType: "agent", actorName: "Ada", sourceId: null });

    const lines = await answer([
      {
        uuid: "e1",
        fact: "Ticket #609 is a Project",
        validAt: null,
        actorType: "extraction",
        actorName: "Ada",
        chunkIds: ["v-ada"],
        store: "graph",
      },
      { uuid: "e2", fact: "Ada passed Ticket #609", validAt: null, chunkIds: ["v-ada"], store: "graph" },
    ]);

    expect(lines.toSorted()).toEqual([
      "• Ada passed Ticket #609 (as of 2026-09-01T08:00:00.000Z) — from: Ada (agent) · version v-ada",
      "• Ticket #609 is a Project (as of 2026-09-01T08:00:00.000Z) — from: Ada (agent) · version v-ada",
    ]);
  });

  // A fact longer than the whole read budget is served as an excerpt (account-tiers.ts
  // packWithinTokenBudget). Cutting its text must not cut its provenance: the line still
  // names the version's writer or the connected source, as a whole fact's line would.
  describe("a fact over the read's token budget", () => {
    const ANSWER = "The release waits on the payments migration.";
    const filler = Array.from({ length: 2_000 }, (_, i) => `Note ${i} covers office logistics in detail.`);
    const longText = [...filler.slice(0, 1_000), ANSWER, ...filler.slice(1_000)].join(" ");

    function expectExcerptLine(line: string, citationTail: string, asOf = ""): void {
      expect(estimateTokens(longText)).toBeGreaterThan(TIER_LIMITS[DEFAULT_ACCOUNT_TIER].tokenBudget);
      expect(line.startsWith("• … ")).toBe(true);
      expect(line).toContain(ANSWER);
      expect(line.endsWith(` [excerpt of ${longText.length} chars]${asOf} — ${citationTail}`)).toBe(true);
      expect(line.length).toBeLessThan(longText.length);
    }

    it("is served as a query-focused excerpt still cited to the writer of its version", async () => {
      versions.push({ id: "v-ben", orgId: ORG, actorType: "agent", actorName: "Ben", sourceId: null });

      const lines = await answer([
        { uuid: "e1", fact: longText, validAt: null, actorType: "extraction", chunkIds: ["v-ben"], store: "graph" },
      ]);

      expect(lines).toHaveLength(1);
      expectExcerptLine(lines[0], "from: Ben (agent) · version v-ben", " (as of 2026-09-01T08:00:00.000Z)");
    });

    it("is served as a query-focused excerpt still naming its source, item and version", async () => {
      sources.push({ id: "src_drive", orgId: ORG, name: "Runbooks", type: "gdrive" });
      sourceFiles.push({ sourceId: "src_drive", chunkIds: ["row-1"], episodeIds: ["ep-file"] });

      const lines = await answer([
        { uuid: "row-1", fact: longText, validAt: null, sourceId: "src_drive", store: "semantic" },
      ]);

      expect(lines).toHaveLength(1);
      expectExcerptLine(lines[0], "source: Runbooks (gdrive) · item ep-file · version row-1");
    });
  });

  it("keeps the graph's own citation when the version is another org's, unnamed, or one of several", async () => {
    versions.push({ id: "v-foreign", orgId: OTHER_ORG, actorType: "agent", actorName: "Rival", sourceId: null });
    versions.push({ id: "v-unnamed", orgId: ORG, actorType: "extraction", actorName: null, sourceId: null });
    versions.push({ id: "v-a", orgId: ORG, actorType: "agent", actorName: "Ada", sourceId: null });

    const lines = await answer([
      { uuid: "e1", fact: "Rival ships in May", validAt: null, chunkIds: ["v-foreign"], store: "graph" },
      {
        uuid: "e2",
        fact: "Acme is a Company",
        validAt: null,
        actorType: "extraction",
        chunkIds: ["v-unnamed"],
        store: "graph",
      },
      {
        uuid: "e3",
        fact: "Freeze on Friday",
        validAt: null,
        actorType: "human",
        actorName: "Dana",
        chunkIds: ["v-a", "v-b"],
        store: "graph",
      },
    ]);

    expect(lines.toSorted()).toEqual([
      "• Acme is a Company (as of 2026-09-01T08:00:00.000Z) — from: extraction · version v-unnamed",
      "• Freeze on Friday (as of 2026-09-01T08:00:00.000Z) — from: Dana (human)",
      "• Rival ships in May — uncited · version v-foreign",
    ]);
    // Every version behind a served graph fact is read for its date, in the caller's org only.
    const { where } = vi.mocked(db.memoryChunk.findMany).mock.calls[0][0] as {
      where: { orgId: string; id: { in: string[] } };
    };
    expect(where.orgId).toBe(ORG);
    expect(where.id.in.toSorted()).toEqual(["v-a", "v-b", "v-foreign", "v-unnamed"]);
  });

  it("never cites a graph fact to the writer of a version a connected source stored", async () => {
    // The row's writer is the sync, not someone who asserted the fact; the fact itself names
    // no source here, so it keeps the graph's own citation.
    versions.push({ id: "v-synced", orgId: ORG, actorType: "agent", actorName: "drive-sync", sourceId: "src_drive" });

    const lines = await answer([
      {
        uuid: "e1",
        fact: "Refunds are capped",
        validAt: null,
        actorType: "extraction",
        chunkIds: ["v-synced"],
        store: "graph",
      },
    ]);

    expect(lines).toEqual([
      "• Refunds are capped (as of 2026-09-01T08:00:00.000Z) — from: extraction · version v-synced",
    ]);
  });

  it("reads no stored version when no graph fact names one", async () => {
    await answer([
      {
        uuid: "row-1",
        fact: "Budget approved",
        validAt: null,
        actorType: "agent",
        actorName: "Ada",
        store: "semantic",
      },
      { uuid: "e1", fact: "Freeze on Friday", validAt: null, chunkIds: [], store: "graph" },
      { uuid: "e2", fact: "Deploys freeze on Fridays", validAt: null, store: "graph" },
    ]);

    expect(vi.mocked(db.memoryChunk.findMany)).not.toHaveBeenCalled();
  });

  // A graph fact is extracted after its write is stored, so the graph's own date for it is
  // the extraction's clock, or a date the extractor read in the text. Either can make a
  // restatement of an old write look newer than the writes that replaced it.
  describe("the date a graph fact is served with", () => {
    const GRAPH_CLOCK = "2026-10-12T07:00:00.000000+00:00";

    it("is the date of the stored version it was derived from: its writer's occurredAt", async () => {
      versions.push({
        id: "v-booked",
        orgId: ORG,
        actorType: "agent",
        actorName: "Recorder",
        sourceId: null,
        occurredAt: new Date("2026-03-03T11:15:00.000Z"),
        createdAt: new Date("2026-10-12T06:59:00.000Z"),
      });

      const lines = await answer([
        {
          uuid: "e1",
          fact: "The follow-up is scheduled for Wednesday at 3:10 PM",
          validAt: GRAPH_CLOCK,
          actorType: "agent",
          chunkIds: ["v-booked"],
          store: "graph",
        },
      ]);

      expect(lines).toEqual([
        "• The follow-up is scheduled for Wednesday at 3:10 PM (as of 2026-03-03T11:15:00.000Z) — from: Recorder (agent) · version v-booked",
      ]);
    });

    it("is the newest of the versions a fact several writes assert, and the version's storage time when it states no occurredAt", async () => {
      versions.push({
        id: "v-early",
        orgId: ORG,
        actorType: "agent",
        actorName: "A",
        sourceId: null,
        occurredAt: new Date("2026-03-01T00:00:00.000Z"),
      });
      versions.push({
        id: "v-late",
        orgId: ORG,
        actorType: "agent",
        actorName: "B",
        sourceId: null,
        createdAt: new Date("2026-03-05T12:00:00.000Z"),
      });

      const lines = await answer([
        {
          uuid: "e1",
          fact: "Imaging is in Suite 2",
          validAt: GRAPH_CLOCK,
          actorType: "agent",
          actorName: "B",
          chunkIds: ["v-early", "v-late"],
          store: "graph",
        },
      ]);

      expect(lines).toEqual(["• Imaging is in Suite 2 (as of 2026-03-05T12:00:00.000Z) — from: B (agent)"]);
    });

    it("is the version's date for a connected source's fact too, which still cites the source, not the row's writer", async () => {
      sources.push({ id: "src_repo", orgId: ORG, name: "acme/platform", type: "github" });
      versions.push({
        id: "v-synced",
        orgId: ORG,
        actorType: "extraction",
        actorName: "sync",
        sourceId: "src_repo",
        createdAt: new Date("2026-09-20T10:00:00.000Z"),
      });

      const lines = await answer([
        {
          uuid: "e1",
          fact: "Deploys freeze on Fridays",
          validAt: GRAPH_CLOCK,
          sourceId: "src_repo",
          chunkIds: ["v-synced"],
          store: "graph",
        },
      ]);

      expect(lines).toEqual([
        "• Deploys freeze on Fridays (as of 2026-09-20T10:00:00.000Z) — source: acme/platform (github) · version v-synced",
      ]);
    });

    it("stays the graph's own when no version it names is this org's", async () => {
      versions.push({
        id: "v-foreign",
        orgId: OTHER_ORG,
        actorType: "agent",
        actorName: "Rival",
        sourceId: null,
        occurredAt: new Date("2026-01-01T00:00:00.000Z"),
      });

      const lines = await answer([
        { uuid: "e1", fact: "Rival ships in May", validAt: GRAPH_CLOCK, chunkIds: ["v-foreign"], store: "graph" },
      ]);

      expect(lines).toEqual([`• Rival ships in May (as of ${GRAPH_CLOCK}) — uncited · version v-foreign`]);
    });
  });

  it("reads no sync record when no passage row is served", async () => {
    sources.push({ id: "src_repo", orgId: ORG, name: "acme/platform", type: "github" });

    await answer([
      {
        uuid: "f1",
        fact: "Deploys freeze on Fridays",
        validAt: null,
        sourceId: "src_repo",
        sourceEventIds: ["ep-issue"],
        store: "graph",
      },
    ]);

    expect(vi.mocked(db.sourceFile.findMany)).not.toHaveBeenCalled();
  });
});

// A read that could not search every scope under the caller's says
// so, instead of presenting a partial answer as complete.
describe("memory_query partial scope coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredDescendants.length = 0;
    vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test" } as never);
    vi.mocked(db.$queryRaw).mockResolvedValue([{ permission: "read", createdBy: null, agentId: "agent_1" }] as never);
  });

  const NOTE = /not every scope under yours was searched/;

  it("adds no note when every descendant scope was searched", async () => {
    registeredDescendants.push(`${ORG}.eng`);

    const lines = await answer([{ uuid: "f1", fact: "Budget approved", validAt: null }]);

    expect(lines).toEqual(["• Budget approved — uncited"]);
  });

  it("notes partial coverage, and names the scopes it skipped, past the per-read bound", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const team = (i: number) => `${ORG}.team${String(i).padStart(4, "0")}`;
    for (let i = 0; i < MAX_SEARCHED_DESCENDANT_SCOPES + 12; i++) registeredDescendants.push(team(i));

    const lines = await answer([{ uuid: "f1", fact: "Budget approved", validAt: null }]);

    expect(lines[0]).toBe("• Budget approved — uncited");
    expect(lines.join("\n")).toMatch(NOTE);
    const skipped = Array.from({ length: 10 }, (_, i) => team(MAX_SEARCHED_DESCENDANT_SCOPES + i)).join(", ");
    expect(lines.at(-1)).toBe(`Note: scopes under yours that were not searched: ${skipped} and 2 more.`);
  });

  it("notes partial coverage on an empty answer, so no facts is not read as none exist", async () => {
    vi.mocked(strictDescendantScopePaths).mockRejectedValueOnce(new Error("connection reset"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const text = (await answer([])).join("\n");

    expect(text).toMatch(/^No facts found\./);
    expect(text).toMatch(NOTE);
    warn.mockRestore();
  });
});
