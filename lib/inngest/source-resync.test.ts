// The scheduled re-sync's event ids: one per source per half-hour slot, so a
// retried or doubled schedule run queues each source once. No database needed;
// the selection itself is covered by inngest.scheduled-resync.realdb.test.ts.
import { describe, expect, it } from "vitest";
import { RESYNC_INTERVAL_MS, scheduledResyncEvents } from "./source-resync";
import { SOURCE_SYNC_EVENT } from "./connector-sync";

const sources = [
  { id: "src-a", orgId: "org-1" },
  { id: "src-b", orgId: "org-2" },
];
const slotStart = new Date(Date.UTC(2026, 9, 8, 17, 0, 0));

describe("scheduledResyncEvents", () => {
  it("queues one source-sync event per source with its own org and no credential", () => {
    expect(scheduledResyncEvents(sources, slotStart).map(({ name, data }) => ({ name, data }))).toEqual([
      { name: SOURCE_SYNC_EVENT, data: { sourceId: "src-a", orgId: "org-1" } },
      { name: SOURCE_SYNC_EVENT, data: { sourceId: "src-b", orgId: "org-2" } },
    ]);
  });

  it("gives a source the same event id anywhere in one slot", () => {
    const late = new Date(slotStart.getTime() + RESYNC_INTERVAL_MS - 1);
    expect(scheduledResyncEvents(sources, late).map((e) => e.id)).toEqual(
      scheduledResyncEvents(sources, slotStart).map((e) => e.id),
    );
  });

  it("gives a source a new event id in the next slot", () => {
    const next = new Date(slotStart.getTime() + RESYNC_INTERVAL_MS);
    const [now] = scheduledResyncEvents(sources, slotStart);
    const [later] = scheduledResyncEvents(sources, next);
    expect(later.id).not.toBe(now.id);
  });

  it("gives two sources different event ids in the same slot", () => {
    const [a, b] = scheduledResyncEvents(sources, slotStart);
    expect(a.id).not.toBe(b.id);
  });
});
