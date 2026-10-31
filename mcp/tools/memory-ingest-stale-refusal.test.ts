// A stale refusal records a version as read only when the reply really shows it: a read that
// fails after the version was found must not leave the writer marked as having read it.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/access/derived-writes", () => import("@/services/access/derived-writes.testsupport"));
vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn().mockResolvedValue(1),
    auditLog: { create: vi.fn(), update: vi.fn() },
    agent: { findMany: vi.fn().mockResolvedValue([]) },
    source: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));
vi.mock("@/services/memory/store", () => ({ memory: {}, graphitiStore: {} }));
vi.mock("@/services/signals", () => ({ recordFeedback: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn() }));
vi.mock("@/services/memory/versions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/versions")>()),
  readMemoryVersion: vi.fn(),
}));
vi.mock("../derived-write", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../derived-write")>()),
  derivedMarkersFor: vi.fn(),
}));
vi.mock("@/services/memory/conventions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/conventions")>()),
  recordAuthorizedConvention: vi.fn().mockResolvedValue({ id: "rule-1", authorizedById: "audit-1" }),
}));
vi.mock("./memory-version", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./memory-version")>()),
  describeVersion: (version: { id: string }) => `version ${version.id}, whole`,
}));
vi.mock("./tool-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tool-context")>()),
  recordServedVersions: vi.fn().mockResolvedValue(undefined),
}));

import { db } from "@/lib/db";
import { ingestMemory } from "@/lib/inngest";
import { StaleBaseVersionError } from "@/services/memory/fact-update";
import { readMemoryVersion } from "@/services/memory/versions";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { derivedMarkersFor } from "../derived-write";
import { registerWillderTools } from "../tools";
import { BASE_VERSION_HEADING, CURRENT_VERSION_HEADING } from "./memory-ingest";
import { recordServedVersions } from "./tool-context";

type Handler = (
  args: Record<string, unknown>,
  extra?: unknown,
) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;

const ORG = "org_stale";
const VERSION = {
  id: "v2",
  kind: "fact",
  text: "The freeze starts Thursday.",
  status: "current",
  scopePath: ORG,
  entityName: "freeze",
};

function ingestTool(): Handler {
  vi.mocked(db.$queryRaw).mockResolvedValue([{ permission: "write", createdBy: null, agentId: "writer" }] as never);
  const tools = new Map<string, Handler>();
  const server = {
    registerTool: vi.fn((name: string, _config: unknown, handler: Handler) => void tools.set(name, handler)),
  };
  registerWillderTools(
    server as unknown as McpServer,
    { orgId: ORG, actor: { type: "agent", id: "writer", capabilityToken: "wcap_xyz" }, origin: "mcp" },
    { orgId: ORG, agentId: "writer", scopePath: ORG },
  );
  return tools.get("memory_ingest")!;
}

const write = (tool: Handler) =>
  tool(
    { name: "freeze", content: "The freeze starts Friday.", baseVersion: "v1" },
    { _meta: { "willder/session": "s-1", "willder/task": "T" } },
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit-1" } as never);
  vi.mocked(ingestMemory).mockRejectedValue(
    new StaleBaseVersionError({ entity: "freeze" } as never, { baseVersionId: "v1", currentVersionId: "v2" }),
  );
  vi.mocked(readMemoryVersion).mockResolvedValue(VERSION as never);
});

describe("a stale refusal", () => {
  it("records the version it shows", async () => {
    vi.mocked(derivedMarkersFor).mockResolvedValue(new Map());
    const reply = await write(ingestTool());
    expect(reply.content[0]!.text).toContain(CURRENT_VERSION_HEADING);
    expect(recordServedVersions).toHaveBeenCalledWith(expect.anything(), ["v2"]);
  });

  it("shows the version the write was based on after the current one, and records only the current one", async () => {
    vi.mocked(derivedMarkersFor).mockResolvedValue(new Map());
    vi.mocked(readMemoryVersion).mockImplementation(async (_ctx, id) => ({ ...VERSION, id }) as never);
    const text = (await write(ingestTool())).content[0]!.text;
    expect(text).toContain(
      `${CURRENT_VERSION_HEADING}\nversion v2, whole\n\n${BASE_VERSION_HEADING}\nversion v1, whole`,
    );
    expect(recordServedVersions).toHaveBeenCalledTimes(1);
    expect(recordServedVersions).toHaveBeenCalledWith(expect.anything(), ["v2"]);
  });

  it("keeps the current version when the base version cannot be shown", async () => {
    vi.mocked(derivedMarkersFor).mockResolvedValue(new Map());
    for (const failure of [async () => null, async () => Promise.reject(new Error("read failed"))]) {
      vi.mocked(recordServedVersions).mockClear();
      vi.mocked(readMemoryVersion).mockImplementation(async (_ctx, id) => (id === "v1" ? failure() : VERSION) as never);
      const text = (await write(ingestTool())).content[0]!.text;
      expect(text).toContain(`${CURRENT_VERSION_HEADING}\nversion v2, whole`);
      expect(text).not.toContain(BASE_VERSION_HEADING);
      expect(recordServedVersions).toHaveBeenCalledWith(expect.anything(), ["v2"]);
    }
  });

  it("leaves the settling to the writer, in words that hold on their own", async () => {
    vi.mocked(derivedMarkersFor).mockResolvedValue(new Map());
    const text = (await write(ingestTool())).content[0]!.text;
    expect(text).toContain(
      "Your change is yours to settle: if it still applies, write it again with baseVersion v2, keeping what v2 added; if v2 already covers it, leave v2 as it stands.",
    );
    expect(text).toContain(
      "A rewrite leaves v2 readable by id, and the replacement shows in this scope's change feed.",
    );
    expect(text).toContain("say in one sentence which you did: I redid my change on v2, or I left v2 as it stands.");
  });

  it("claims nothing this refusal cannot know", async () => {
    vi.mocked(derivedMarkersFor).mockResolvedValue(new Map());
    const text = (await write(ingestTool())).content[0]!.text;
    // The current version can be the fact copy of a decision a person confirmed, and this text is
    // written with no sight of that, so it says nothing of approval or of who needs to hear.
    expect(text).not.toMatch(/approve|raise it with|nobody|loses nothing/i);
    // Delivery varies (compact notices, a burst, a person who makes no calls), and the current
    // version's writer can be the caller, so it names neither a moment nor that writer.
    expect(text).not.toMatch(/next call|its writer/i);
    // Detected and notified, never resolved.
    expect(text).not.toMatch(/\bresolved\b/i);
  });

  it("leaves the bare refusal and records nothing when the derived markers throw", async () => {
    vi.mocked(derivedMarkersFor).mockRejectedValue(new Error("markers unavailable"));
    const reply = await write(ingestTool());
    expect(reply.isError).toBe(true);
    expect(reply.content[0]!.text).not.toContain(CURRENT_VERSION_HEADING);
    expect(recordServedVersions).not.toHaveBeenCalled();
  });
});

describe("a rule whose fact copy names a stale base", () => {
  const rule = (tool: Handler) =>
    tool(
      { name: "freeze", content: "The freeze starts Friday.", baseVersion: "v1", kind: "decision" },
      { _meta: { "willder/session": "s-1", "willder/task": "T" } },
    );

  it("says the rule was recorded and how to store the copy, without the plain refusal", async () => {
    const reply = await rule(ingestTool());
    const text = reply.content[0]!.text;
    expect(reply.isError).toBeFalsy();
    expect(text).toContain("Recorded decision rule-1");
    // The rule is stored and a person is asked to confirm it, so the refusal's words do not hold.
    expect(text).not.toMatch(/Nothing was stored|yours to settle|stale_version/);
    expect(text).toContain("baseVersion v1 is out of date: v2 replaced it");
    expect(text).toContain("Do not send this call again");
    expect(text).toContain(
      "send memory_ingest with the same content, name and scopePath, baseVersion v2, and without kind or supersedes",
    );
  });

  it("says where the copy went when it raced the newer version and was stored", async () => {
    vi.mocked(ingestMemory).mockRejectedValue(
      new StaleBaseVersionError({ entity: "freeze" } as never, {
        baseVersionId: "v1",
        currentVersionId: "v2",
        storedVersionId: "v3",
      }),
    );
    const text = (await rule(ingestTool())).content[0]!.text;
    expect(text).toContain("Recorded decision rule-1");
    expect(text).toContain("its fact copy was stored as v3, but v2 replaced it first");
    expect(text).not.toMatch(/not stored|Nothing was stored/);
  });
});
