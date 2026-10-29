// The quickstart in README.md and its long form in docs/quickstart.md show a stranger what
// memory_ingest and memory_query send back. A cold run on 2026-10-14 found both showing
// replies the product no longer sends, and a hand-written memory_ingest call missing its
// required `name`. So every memory_ingest call the two documents show must pass the tool's
// registered schema, and every reply they quote must be what the real handler and formatter
// produce, with the documents' placeholders standing for the values a real call fills in.
// The token prompt they show is the one the docs pages use (lib/docs.ts), which
// lib/docs-claude-code.test.ts runs in bash, zsh and sh: `read -p` means something else in
// zsh, the macOS default shell.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// The derived-write rule is tested on Postgres (mcp/derived-write.realdb.test.ts); off here.
vi.mock("@/services/access/derived-writes", () => import("@/services/access/derived-writes.testsupport"));
vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: vi.fn(),
    // Records the version the reply names as served to the writer.
    $executeRaw: vi.fn().mockResolvedValue(1),
    auditLog: { create: vi.fn(), update: vi.fn() },
    agent: { findMany: vi.fn().mockResolvedValue([]) },
    source: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));
vi.mock("@/services/memory/store", () => ({ memory: {}, graphitiStore: {} }));
vi.mock("@/services/signals", () => ({ recordFeedback: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn() }));
vi.mock("@/mcp/change-notices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/change-notices")>()),
  toolCallNotice: vi.fn().mockResolvedValue(null),
}));

import { db } from "@/lib/db";
import { ingestMemory } from "@/lib/inngest";
import { formatCitedFacts } from "@/mcp/fact-citation";
import { fallbackAgentName } from "@/services/audit/actor-names";
import { registerWillderTools } from "@/mcp/tools";
import { LOAD_TOKEN_COMMAND } from "@/lib/docs";
import { FIRST_PROMPT, parseArgs } from "./cli/willder.mjs";

const DOCS = ["README.md", "docs/quickstart.md"] as const;
const read = (file: string) => readFileSync(resolve(__dirname, file), "utf8");
/** `read -p` is a coprocess read in zsh, so a prompt written with it hangs there. */
const BASH_ONLY_PROMPT = /read\s+(-\w+\s+)*-\w*p/;

/** The values a real call fills in where the documents print a placeholder. */
const VERSION_ID = "cmquickstartversion0001";
const STORED_AT = "2026-10-14T01:36:52.000Z";
const AGENT_NAME = "coding_agent";
const PLACEHOLDERS: [string, string][] = [
  [VERSION_ID, "<version id>"],
  [STORED_AT, "<when it was stored>"],
  [AGENT_NAME, "<agent name>"],
];
const asDocumented = (text: string) =>
  PLACEHOLDERS.reduce((out, [value, placeholder]) => out.replaceAll(value, placeholder), text);

const ORG = "org_quickstart";
type Handler = (
  args: Record<string, unknown>,
) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;

function registeredMemoryIngest(): { schema: z.ZodRawShape; handler: Handler } {
  vi.mocked(db.$queryRaw).mockResolvedValue([{ permission: "write", createdBy: null, agentId: AGENT_NAME }] as never);
  const tools = new Map<string, { schema: z.ZodRawShape; handler: Handler }>();
  const server = {
    registerTool: (name: string, config: { inputSchema: z.ZodRawShape }, handler: Handler) =>
      void tools.set(name, { schema: config.inputSchema, handler }),
  };
  registerWillderTools(
    server as unknown as McpServer,
    { orgId: ORG, actor: { type: "agent", id: AGENT_NAME, capabilityToken: "wcap_quickstart" }, origin: "mcp" },
    { orgId: ORG, agentId: AGENT_NAME, scopePath: ORG },
  );
  return tools.get("memory_ingest")!;
}

/** The arguments of every memory_ingest tools/call a document's commands send. */
function documentedIngestCalls(doc: string): Record<string, unknown>[] {
  return [...doc.matchAll(/--data '(\{.*?\})'/g)]
    .map(
      (m) => JSON.parse(m[1]!) as { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } },
    )
    .filter((body) => body.method === "tools/call" && body.params?.name === "memory_ingest")
    .map((body) => body.params!.arguments!);
}

/** The lines of every fenced block in a document whose line starts with `prefix`. */
const quotedLines = (doc: string, prefix: string) =>
  [...doc.matchAll(/```[a-z]*\n([\s\S]*?)```/g)]
    .flatMap((m) => m[1]!.split("\n"))
    .filter((line) => line.startsWith(prefix));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit-1" } as never);
});

describe.each(DOCS)("%s quickstart against the MCP tools", (file) => {
  const doc = read(file);

  it("quotes the reply memory_ingest sends for a write readable at once", async () => {
    vi.mocked(ingestMemory).mockResolvedValue({ readableNow: true, versionId: VERSION_ID } as never);
    const { handler } = registeredMemoryIngest();
    const result = await handler({
      content: "we store sessions in Postgres, not Redis, so they survive a restart.",
      name: "session storage",
    });

    expect(result.isError).not.toBe(true);
    const reply = asDocumented(result.content[0]!.text);
    expect(quotedLines(doc, "Stored and readable now")).toEqual([reply]);
  });

  it("quotes the bullet memory_query serves for that write", async () => {
    const served = await formatCitedFacts(ORG, [
      {
        uuid: VERSION_ID,
        fact: "we store sessions in Postgres, not Redis, so they survive a restart.",
        validAt: STORED_AT,
        store: "semantic",
        actorType: "agent",
        // The README runs locally, where an agent with only a self-host token is named by it.
        actorName: file === "README.md" ? fallbackAgentName("claude-code") : AGENT_NAME,
      },
    ]);
    expect(quotedLines(doc, "• ")).toEqual([asDocumented(served)]);
  });
});

describe("README.md against the CLI and the tool schema", () => {
  it("shows memory_ingest calls the tool's schema accepts, each naming the required name", () => {
    const { schema } = registeredMemoryIngest();
    const strict = z.object(schema).strict();
    // The README runs locally over stdio, so it shows no hand-written HTTP call; any document
    // that does must send one the schema accepts.
    const calls = [...DOCS, "mcp/README.md"].flatMap((file) => documentedIngestCalls(read(file)));
    for (const args of calls) {
      expect(strict.safeParse(args).success, JSON.stringify(args)).toBe(true);
      const { name: _name, ...withoutName } = args;
      expect(strict.safeParse(withoutName).success, "name is required, so the documents must show it").toBe(false);
    }
  });

  it("quotes the sentence willder init prints for the first write and read", () => {
    expect(read("README.md")).toContain(`\`${FIRST_PROMPT}\``);
  });

  it("runs the CLI with arguments it accepts, from the path the clone puts it at", () => {
    const command = /git clone --depth 1 \S+ (\S+) && node (\S+)\/cli\/willder\.mjs ([^\n]*)\n/.exec(
      read("docs/quickstart.md"),
    );
    expect(command, "the hosted quickstart's one-line clone and init").not.toBeNull();
    expect(command![2]).toBe(command![1]);
    expect(() => parseArgs(command![3]!.split(" "))).not.toThrow();
  });
});

describe.each([...DOCS, "mcp/README.md"])("%s token prompt", (file) => {
  it("is the one every shell runs, never bash's read -p", () => {
    const doc = read(file);
    if (file !== "mcp/README.md") expect(doc).toContain(LOAD_TOKEN_COMMAND);
    expect(doc).toContain("stty -echo; read -r WILLDER_TOKEN; stty echo");
    expect(doc).not.toMatch(BASH_ONLY_PROMPT);
  });
});
