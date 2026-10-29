// The audit hits search returns name their writers exactly as the audit list does: one
// resolver (resolveActorNames), so a connector sync reads as "<source> sync" and never as
// its raw `<type>-sync:<sourceId>` id.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    user: { findMany: vi.fn() },
    agent: { findMany: vi.fn() },
    source: { findMany: vi.fn() },
    auditLog: { findMany: vi.fn() },
  },
}));

import { db } from "@/lib/db";
import { ALWAYS_VISIBLE_ACTIONS } from "@/services/audit/audit-actions";
import { fallbackAgentName } from "@/services/audit/actor-names";
import { searchAudit } from "./access-search";

const SYNC_ACTOR = "github-sync:src_1";

beforeEach(() => {
  vi.mocked(db.user.findMany)
    .mockReset()
    .mockResolvedValue([] as never);
  vi.mocked(db.agent.findMany)
    .mockReset()
    .mockResolvedValue([] as never);
  vi.mocked(db.source.findMany)
    .mockReset()
    .mockResolvedValue([{ id: "src_1", name: "Platform repo" }] as never);
  vi.mocked(db.auditLog.findMany)
    .mockReset()
    .mockResolvedValue([
      {
        id: "a1",
        actorType: "agent",
        actorId: SYNC_ACTOR,
        action: ALWAYS_VISIBLE_ACTIONS[0],
        target: null,
        decision: "allow",
        reason: null,
        metadata: null,
        at: new Date("2026-10-06T00:00:00Z"),
      },
    ] as never);
});

describe("searchAudit writer names", () => {
  it("names a connector sync by its source, as the audit list does", async () => {
    const { items } = await searchAudit("org1", "platform", 10);
    expect(items.map((i) => i.actorName)).toEqual(["Platform repo sync"]);
    expect(items[0]!.actorName).not.toBe(fallbackAgentName(SYNC_ACTOR));
    expect(vi.mocked(db.source.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId: "org1", id: { in: ["src_1"] } } }),
    );
  });
});
