// recordServedFacts: which versions a page of served facts records as read and which
// only as sighted (services/memory/fact-reads.ts). The end-to-end race, an agent writing
// past a version it saw only as an excerpt, runs on Postgres in
// services/memory/excerpt-is-not-a-read.realdb.qa.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryFact } from "@/types/memory";

const recorded = vi.hoisted(() => ({ read: [] as string[], sighted: [] as string[], scopes: [] as string[] }));

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/services/memory/fact-reads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/fact-reads")>()),
  recordVersionsRead: async (_client: unknown, input: { versionIds: readonly string[] }) => {
    recorded.read.push(...input.versionIds);
  },
  recordVersionsSighted: async (_client: unknown, input: { versionIds: readonly string[] }) => {
    recorded.sighted.push(...input.versionIds);
  },
}));
vi.mock("@/services/access/derived-writes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/access/derived-writes")>()),
  recordScopesRead: async (_client: unknown, _who: unknown, scopePaths: readonly string[]) => {
    recorded.scopes.push(...scopePaths);
  },
}));

const { recordServedFacts } = await import("./tool-context");

const cap = { orgId: "org", agentId: "agent", scopePath: "org_org" };
const chunk = (uuid: string, excerptOfChars?: number): MemoryFact => ({
  uuid,
  fact: "text",
  validAt: null,
  store: "semantic",
  ...(excerptOfChars ? { excerptOfChars } : {}),
});
const graphFact = (uuid: string, chunkIds: string[]): MemoryFact => ({
  uuid,
  fact: "text",
  validAt: null,
  store: "graph",
  chunkIds,
});

describe("recordServedFacts", () => {
  beforeEach(() => {
    recorded.read.length = 0;
    recorded.sighted.length = 0;
    recorded.scopes.length = 0;
  });

  it("records a fact served whole as a read and one served as an excerpt as a sighting", async () => {
    await recordServedFacts(cap, [chunk("v1"), chunk("v2", 67_716)], "org_org.team");
    expect(recorded.read).toEqual(["v1"]);
    expect(recorded.sighted).toEqual(["v2"]);
  });

  it("keeps an excerpted version a sighting when a whole graph fact on the page derives from it", async () => {
    await recordServedFacts(cap, [graphFact("g1", ["v2", "v3"]), chunk("v2", 67_716)], "org_org.team");
    expect(recorded.read).toEqual(["v3"]);
    expect(recorded.sighted).toEqual(["v2"]);
  });

  it("records the versions behind an excerpted graph fact as sightings", async () => {
    await recordServedFacts(cap, [{ ...graphFact("g1", ["v4"]), excerptOfChars: 9_000 }], "org_org.team");
    expect(recorded.read).toEqual([]);
    expect(recorded.sighted).toEqual(["v4"]);
  });

  it("adds no scope of its own when every fact has a stored version behind it", async () => {
    await recordServedFacts(cap, [chunk("v1"), graphFact("g1", ["v2"])], "org_org.team");
    expect(recorded.scopes).toEqual([]);
  });

  it("records the read's scope for a fact with no stored version behind it, so its content still taints the session", async () => {
    await recordServedFacts(cap, [chunk("v1"), graphFact("g1", [])], "org_org.team");
    expect(recorded.scopes).toEqual(["org_org.team"]);
    expect(recorded.read).toEqual(["v1"]);
  });
});
