import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/access", () => ({ check: vi.fn(), readableScopePaths: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { contact: { count: vi.fn() } } }));
vi.mock("@/services/memory/activity-counts", () => ({ countNewChunksInScopes: vi.fn() }));
vi.mock("@/services/agents/run-visibility", () => ({ countVisibleRunningRuns: vi.fn() }));

import { requireAccessContext } from "@/lib/access-context";
import { check, readableScopePaths } from "@/services/access";
import { db } from "@/lib/db";
import { countNewChunksInScopes } from "@/services/memory/activity-counts";
import { countVisibleRunningRuns } from "@/services/agents/run-visibility";
import { GET } from "./route";

const badges = () => GET(new Request("http://t/api/nav/badges?since=2026-10-01T00:00:00.000Z"));
const dbDown = () => Promise.reject(new Error("connection terminated"));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue({ org: { id: "org_1" }, ctx: {} } as never);
  vi.mocked(readableScopePaths).mockResolvedValue(["org_1"]);
  vi.mocked(check).mockResolvedValue({ allowed: true } as never);
  vi.mocked(countVisibleRunningRuns).mockResolvedValue(2);
  vi.mocked(db.contact.count).mockResolvedValue(5 as never);
  vi.mocked(countNewChunksInScopes).mockResolvedValue(4);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// A count that could not be run is not a quiet period. Answering 0 for it puts a
// wrong badge on screen and makes a failed read indistinguishable from a real
// answer for anyone measuring what this route discloses.
describe("GET /api/nav/badges when a count fails", () => {
  it("answers every count when the database answers", async () => {
    const res = await badges();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ activeAgentRuns: 2, newContacts: 5, newMemoryChunks: 4 });
  });

  it.each([
    ["activeAgentRuns", () => vi.mocked(countVisibleRunningRuns).mockImplementation(dbDown)],
    ["newContacts", () => vi.mocked(db.contact.count).mockImplementation(dbDown as never)],
    ["newMemoryChunks", () => vi.mocked(countNewChunksInScopes).mockImplementation(dbDown)],
  ] as const)("reports %s as null, not 0, keeps the other counts, and logs the failure", async (field, fail) => {
    fail();
    const res = await badges();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[field]).toBeNull();
    const others = { activeAgentRuns: 2, newContacts: 5, newMemoryChunks: 4 } as Record<string, number>;
    for (const [name, value] of Object.entries(others)) if (name !== field) expect(body[name]).toBe(value);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(field), expect.any(Error));
  });
});
