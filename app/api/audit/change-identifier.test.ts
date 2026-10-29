// GET /api/audit returns the change each visible `memory.write`/`memory.delete`
// authorization produced, as that row's `changeId`.
//
// Why the field exists: `memory.write.applied` and `memory.delete.applied` carry
// `visibility: "never"` (services/audit/audit-actions.ts), so no audit reader returns them.
// Without this link, a reader of the visible audit log cannot say which change a write
// authorization produced.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/access", () => ({ check: vi.fn() }));
vi.mock("@/services/access/audit-query", () => ({ queryAuditLog: vi.fn() }));
vi.mock("@/services/audit/actor-names", () => ({
  resolveUserNames: vi.fn().mockResolvedValue({}),
  resolveActorNames: vi.fn().mockResolvedValue({}),
  fallbackAgentName: (id: string) => id,
  isConnectorSyncActor: (actorId: string) => /^[a-z]+-sync:/.test(actorId),
}));
vi.mock("@/lib/db", () => ({ db: { changeEvent: { findMany: vi.fn() } } }));

import { requireAccessContext } from "@/lib/access-context";
import { check } from "@/services/access";
import { queryAuditLog } from "@/services/access/audit-query";
import { db } from "@/lib/db";
import { GET } from "./route";

const ROWS = [
  {
    id: "row-write",
    orgId: "org1",
    actorType: "agent",
    actorId: "writer",
    action: "memory.write",
    target: "org_org1.demo/ingest",
    decision: "allow",
    reason: "",
    metadata: {},
    at: new Date("2026-10-05T10:00:00Z"),
  },
  {
    id: "row-read",
    orgId: "org1",
    actorType: "agent",
    actorId: "reader",
    action: "memory.read",
    target: "org_org1.demo/query:x",
    decision: "allow",
    reason: "",
    metadata: {},
    at: new Date("2026-10-05T10:01:00Z"),
  },
];

beforeEach(() => {
  vi.mocked(requireAccessContext).mockResolvedValue({
    org: { id: "org1" },
    user: { id: "u1" },
    ctx: { orgId: "org1", actor: { type: "human", id: "u1", role: "admin" } },
  } as never);
  vi.mocked(check).mockResolvedValue({ allowed: true, reason: "admin" } as never);
  vi.mocked(queryAuditLog).mockResolvedValue({ total: ROWS.length, entries: ROWS } as never);
  vi.mocked(db.changeEvent.findMany).mockReset();
});

async function entries(): Promise<{ id: string; changeIds: string[] }[]> {
  const res = await GET(new Request("http://t/api/audit"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { entries: { id: string; changeIds: string[] }[] };
  return body.entries;
}

describe("GET /api/audit changeIds", () => {
  it("names the change a write authorization produced, and nothing for a row that produced none", async () => {
    vi.mocked(db.changeEvent.findMany).mockResolvedValue([{ id: "change-1", authorizedById: "row-write" }] as never);
    expect(await entries()).toEqual([
      expect.objectContaining({ id: "row-write", changeIds: ["change-1"] }),
      expect.objectContaining({ id: "row-read", changeIds: [] }),
    ]);
  });

  // One edit is one audit row: the delete decision supersedes the old version and writes
  // the corrected one, so its row names both changes.
  it("names both changes of a correction, in the order they were recorded", async () => {
    vi.mocked(db.changeEvent.findMany).mockResolvedValue([
      { id: "change-supersede", authorizedById: "row-write" },
      { id: "change-create", authorizedById: "row-write" },
    ] as never);
    expect((await entries())[0]!.changeIds).toEqual(["change-supersede", "change-create"]);
    expect(vi.mocked(db.changeEvent.findMany).mock.calls[0]![0]).toMatchObject({ orderBy: { seq: "asc" } });
  });

  it("asks only for this page's rows, inside the caller's own org", async () => {
    vi.mocked(db.changeEvent.findMany).mockResolvedValue([] as never);
    await entries();
    expect(vi.mocked(db.changeEvent.findMany).mock.calls[0]![0]).toMatchObject({
      where: { orgId: "org1", authorizedById: { in: ["row-write", "row-read"] } },
    });
  });

  it("is empty, never another row's change, when the link points at a row not on this page", async () => {
    vi.mocked(db.changeEvent.findMany).mockResolvedValue([
      { id: "change-9", authorizedById: "row-elsewhere" },
    ] as never);
    expect((await entries()).map((e) => e.changeIds)).toEqual([[], []]);
  });
});
