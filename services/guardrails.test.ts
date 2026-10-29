import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit tests for services/guardrails.ts. The DB is fully mocked so we test the
// decision logic in isolation: cap arithmetic, status checks, cooldown window,
// and filter set operations.
vi.mock("@/lib/db", () => ({
  db: {
    orgPreference: { findUnique: vi.fn() },
    message: { count: vi.fn(), findFirst: vi.fn() },
    contact: { findFirst: vi.fn(), findMany: vi.fn() },
  },
}));

import { db } from "@/lib/db";
import { checkSendCap, checkContactGuardrails, filterSendableContacts } from "./guardrails";

beforeEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// checkSendCap
// ---------------------------------------------------------------------------

describe("checkSendCap", () => {
  it("passes when sent count is below the cap", async () => {
    vi.mocked(db.orgPreference.findUnique).mockResolvedValue({ maxDraftsPerDay: 200, maxSendsPerDay: 100 } as never);
    vi.mocked(db.message.count).mockResolvedValue(50);
    await expect(checkSendCap("org_1")).resolves.toBeUndefined();
  });

  it("throws send_cap_exceeded when count equals the cap", async () => {
    vi.mocked(db.orgPreference.findUnique).mockResolvedValue({ maxDraftsPerDay: 200, maxSendsPerDay: 100 } as never);
    vi.mocked(db.message.count).mockResolvedValue(100);
    await expect(checkSendCap("org_1")).rejects.toMatchObject({ code: "send_cap_exceeded" });
  });

  it("throws when count exceeds the cap", async () => {
    vi.mocked(db.orgPreference.findUnique).mockResolvedValue({ maxDraftsPerDay: 200, maxSendsPerDay: 50 } as never);
    vi.mocked(db.message.count).mockResolvedValue(51);
    await expect(checkSendCap("org_1")).rejects.toMatchObject({ code: "send_cap_exceeded" });
  });

  it("defaults to 100 sends/day when no preference row exists", async () => {
    vi.mocked(db.orgPreference.findUnique).mockResolvedValue(null);
    vi.mocked(db.message.count).mockResolvedValue(99);
    await expect(checkSendCap("org_1")).resolves.toBeUndefined();
  });

  it("default cap of 100: throws when count is exactly 100", async () => {
    vi.mocked(db.orgPreference.findUnique).mockResolvedValue(null);
    vi.mocked(db.message.count).mockResolvedValue(100);
    await expect(checkSendCap("org_1")).rejects.toMatchObject({ code: "send_cap_exceeded" });
  });

  it("passes when count is 0 (no sends today)", async () => {
    vi.mocked(db.orgPreference.findUnique).mockResolvedValue({ maxDraftsPerDay: 200, maxSendsPerDay: 10 } as never);
    vi.mocked(db.message.count).mockResolvedValue(0);
    await expect(checkSendCap("org_1")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// checkContactGuardrails
// ---------------------------------------------------------------------------

describe("checkContactGuardrails", () => {
  it("returns silently when the contact is not found in the org", async () => {
    vi.mocked(db.contact.findFirst).mockResolvedValue(null);
    await expect(checkContactGuardrails("org_1", "c_missing")).resolves.toBeUndefined();
    expect(db.message.findFirst).not.toHaveBeenCalled();
  });

  it("throws contact_unsubscribed when status is unsubscribed", async () => {
    vi.mocked(db.contact.findFirst).mockResolvedValue({ status: "unsubscribed" } as never);
    await expect(checkContactGuardrails("org_1", "c1")).rejects.toMatchObject({
      code: "contact_unsubscribed",
    });
    expect(db.message.findFirst).not.toHaveBeenCalled();
  });

  it("throws contact_bounced when status is bounced", async () => {
    vi.mocked(db.contact.findFirst).mockResolvedValue({ status: "bounced" } as never);
    await expect(checkContactGuardrails("org_1", "c1")).rejects.toMatchObject({
      code: "contact_bounced",
    });
  });

  it("throws send_cooldown when a message was sent within 24 hours", async () => {
    vi.mocked(db.contact.findFirst).mockResolvedValue({ status: "active" } as never);
    vi.mocked(db.message.findFirst).mockResolvedValue({ id: "m1" } as never);
    await expect(checkContactGuardrails("org_1", "c1")).rejects.toMatchObject({
      code: "send_cooldown",
    });
  });

  it("passes for an active contact with no recent send", async () => {
    vi.mocked(db.contact.findFirst).mockResolvedValue({ status: "active" } as never);
    vi.mocked(db.message.findFirst).mockResolvedValue(null);
    await expect(checkContactGuardrails("org_1", "c1")).resolves.toBeUndefined();
  });

  it("passes for a contact with status 'prospect' (not blocked)", async () => {
    vi.mocked(db.contact.findFirst).mockResolvedValue({ status: "prospect" } as never);
    vi.mocked(db.message.findFirst).mockResolvedValue(null);
    await expect(checkContactGuardrails("org_1", "c1")).resolves.toBeUndefined();
  });

  it("the cooldown query is scoped to the org and direction:out", async () => {
    vi.mocked(db.contact.findFirst).mockResolvedValue({ status: "active" } as never);
    vi.mocked(db.message.findFirst).mockResolvedValue(null);
    await checkContactGuardrails("org_1", "c1");
    expect(db.message.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          orgId: "org_1",
          direction: "out",
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// filterSendableContacts
// ---------------------------------------------------------------------------

describe("filterSendableContacts", () => {
  it("returns an empty array immediately when given an empty list", async () => {
    const result = await filterSendableContacts("org_1", []);
    expect(result).toEqual([]);
    expect(db.contact.findMany).not.toHaveBeenCalled();
  });

  it("filters out unsubscribed and bounced contacts", async () => {
    vi.mocked(db.contact.findMany).mockResolvedValue([{ id: "c_unsub" }, { id: "c_bounce" }] as never);
    const result = await filterSendableContacts("org_1", ["c_good", "c_unsub", "c_bounce"]);
    expect(result).toEqual(["c_good"]);
  });

  it("returns all contacts when none are bad", async () => {
    vi.mocked(db.contact.findMany).mockResolvedValue([] as never);
    const result = await filterSendableContacts("org_1", ["c1", "c2", "c3"]);
    expect(result).toEqual(["c1", "c2", "c3"]);
  });

  it("returns an empty array when all contacts are bad", async () => {
    vi.mocked(db.contact.findMany).mockResolvedValue([{ id: "c1" }, { id: "c2" }] as never);
    const result = await filterSendableContacts("org_1", ["c1", "c2"]);
    expect(result).toEqual([]);
  });

  it("only queries for unsubscribed/bounced statuses (not all statuses)", async () => {
    vi.mocked(db.contact.findMany).mockResolvedValue([] as never);
    await filterSendableContacts("org_1", ["c1"]);
    expect(db.contact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["unsubscribed", "bounced"] },
          orgId: "org_1",
        }),
      }),
    );
  });

  it("preserves original order of the good contacts", async () => {
    vi.mocked(db.contact.findMany).mockResolvedValue([{ id: "c2" }] as never);
    const result = await filterSendableContacts("org_1", ["c1", "c2", "c3", "c4"]);
    expect(result).toEqual(["c1", "c3", "c4"]);
  });

  it("handles a large list efficiently (200 contacts, half bad)", async () => {
    const bad = Array.from({ length: 100 }, (_, i) => ({ id: `bad_${i}` }));
    vi.mocked(db.contact.findMany).mockResolvedValue(bad as never);
    const all = [
      ...Array.from({ length: 100 }, (_, i) => `good_${i}`),
      ...Array.from({ length: 100 }, (_, i) => `bad_${i}`),
    ];
    const result = await filterSendableContacts("org_1", all);
    expect(result).toHaveLength(100);
    expect(result.every((id) => id.startsWith("good_"))).toBe(true);
  });
});
