// The seam is `createBrief`'s conversation with its transaction: both writes must go
// through the SAME transaction client, and the event must describe the row that was
// actually written. A double can pin both. Whether Postgres really rolls the Brief
// back when the event insert fails needs a database: create-brief.realdb.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { recordChangeEvent, tx } = vi.hoisted(() => ({
  recordChangeEvent: vi.fn(),
  tx: { brief: { create: vi.fn() } },
}));
vi.mock("@/services/memory/change-events", () => ({ recordChangeEvent }));
vi.mock("@/lib/db", () => ({
  db: { $transaction: vi.fn((fn: (client: typeof tx) => unknown) => fn(tx)) },
}));

import { createBrief } from "./create-brief";

const data = {
  orgId: "org-cuid-1",
  type: "handoff" as const,
  scopePath: "org_1.sales",
  title: "Handoff: EU renewals",
  summary: "What the new owner needs",
  sections: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  // The written row, as Postgres returns it: the request's fields plus a generated id.
  tx.brief.create.mockImplementation(async ({ data: row }: { data: typeof data }) => ({
    id: "brief-cuid-1",
    ...row,
  }));
});

describe("createBrief", () => {
  it("records a create event for the written brief, inside the same transaction", async () => {
    const brief = await createBrief(data, { actorType: "agent", actorId: "agent-cuid-1", origin: "agent-run" });

    expect(brief.id).toBe("brief-cuid-1");
    expect(tx.brief.create).toHaveBeenCalledWith({ data });
    expect(recordChangeEvent).toHaveBeenCalledTimes(1);
    expect(recordChangeEvent).toHaveBeenCalledWith(tx, {
      orgId: "org-cuid-1",
      scopePath: "org_1.sales",
      recordType: "brief",
      recordId: "brief-cuid-1",
      op: "create",
      actorId: "agent-cuid-1",
      actorType: "agent",
      origin: "agent-run",
      title: "Handoff: EU renewals",
    });
  });

  it("takes the event's scope and title from the stored row, not the request", async () => {
    // A stored row that differs from the request (a column default, a trigger) is
    // what a reader can open, so it is what the event must describe.
    tx.brief.create.mockResolvedValueOnce({
      ...data,
      id: "brief-cuid-2",
      scopePath: "org_1.sales.eu",
      title: "Stored title",
    });

    await createBrief(data, { actorType: "agent", actorId: "agent-cuid-1", origin: "agent-run" });

    expect(recordChangeEvent).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ scopePath: "org_1.sales.eu", title: "Stored title", recordId: "brief-cuid-2" }),
    );
  });

  it("fails the whole write when the event cannot be recorded", async () => {
    recordChangeEvent.mockRejectedValueOnce(new Error("change event needs a valid ltree scopePath"));

    await expect(
      createBrief(data, { actorType: "agent", actorId: "agent-cuid-1", origin: "agent-run" }),
    ).rejects.toThrow("valid ltree scopePath");
  });
});
