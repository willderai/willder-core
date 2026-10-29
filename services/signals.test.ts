import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit tests for services/signals.ts. The key behaviours to pin:
// (1) every signal type writes the right fields to FeedbackEvent.
// (2) the function never throws even when the DB fails.
vi.mock("@/lib/db", () => ({
  db: { feedbackEvent: { create: vi.fn() } },
}));

import { db } from "@/lib/db";
import { recordFeedback } from "./signals";

beforeEach(() => vi.clearAllMocks());

describe("recordFeedback — field mapping", () => {
  it("writes an edited signal with originalBody and editedBody", async () => {
    vi.mocked(db.feedbackEvent.create).mockResolvedValue({} as never);
    await recordFeedback({
      eventType: "edited",
      orgId: "org_1",
      draftId: "d1",
      actorId: "u1",
      originalBody: "old body",
      editedBody: "new body",
    });
    expect(db.feedbackEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orgId: "org_1",
        draftId: "d1",
        actorId: "u1",
        eventType: "edited",
        originalBody: "old body",
        editedBody: "new body",
      }),
    });
  });

  it("writes an approved signal with null body fields", async () => {
    vi.mocked(db.feedbackEvent.create).mockResolvedValue({} as never);
    await recordFeedback({ eventType: "approved", orgId: "org_1", draftId: "d2", actorId: "u1" });
    expect(db.feedbackEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "approved",
        originalBody: null,
        editedBody: null,
      }),
    });
  });

  it("writes a rejected signal", async () => {
    vi.mocked(db.feedbackEvent.create).mockResolvedValue({} as never);
    await recordFeedback({ eventType: "rejected", orgId: "org_1" });
    expect(db.feedbackEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ eventType: "rejected" }),
    });
  });

  it("writes a replied signal", async () => {
    vi.mocked(db.feedbackEvent.create).mockResolvedValue({} as never);
    await recordFeedback({ eventType: "replied", orgId: "org_1", draftId: "d3" });
    expect(db.feedbackEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ eventType: "replied", draftId: "d3" }),
    });
  });

  it("writes a booked signal", async () => {
    vi.mocked(db.feedbackEvent.create).mockResolvedValue({} as never);
    await recordFeedback({ eventType: "booked", orgId: "org_1" });
    expect(db.feedbackEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ eventType: "booked" }),
    });
  });

  it("stores meta when provided", async () => {
    vi.mocked(db.feedbackEvent.create).mockResolvedValue({} as never);
    await recordFeedback({
      eventType: "approved",
      orgId: "org_1",
      meta: { campaignId: "camp_1", score: 9 },
    });
    expect(db.feedbackEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ meta: { campaignId: "camp_1", score: 9 } }),
    });
  });

  it("defaults meta to {} when not provided", async () => {
    vi.mocked(db.feedbackEvent.create).mockResolvedValue({} as never);
    await recordFeedback({ eventType: "approved", orgId: "org_1" });
    expect(db.feedbackEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ meta: {} }),
    });
  });

  it("null-coalesces optional draftId and actorId", async () => {
    vi.mocked(db.feedbackEvent.create).mockResolvedValue({} as never);
    await recordFeedback({ eventType: "approved", orgId: "org_1" });
    const data = vi.mocked(db.feedbackEvent.create).mock.calls[0][0].data;
    expect(data.draftId).toBeNull();
    expect(data.actorId).toBeNull();
  });
});

describe("recordFeedback — error swallowing", () => {
  it("swallows a DB error and never throws", async () => {
    vi.mocked(db.feedbackEvent.create).mockRejectedValue(new Error("db down"));
    await expect(recordFeedback({ eventType: "approved", orgId: "org_1", draftId: "d1" })).resolves.toBeUndefined();
  });

  it("swallows a network-level rejection", async () => {
    vi.mocked(db.feedbackEvent.create).mockRejectedValue(new TypeError("network error"));
    await expect(recordFeedback({ eventType: "rejected", orgId: "org_1" })).resolves.toBeUndefined();
  });

  it("still resolves after the error (does not leave a dangling promise)", async () => {
    vi.mocked(db.feedbackEvent.create).mockRejectedValue(new Error("fail"));
    const start = Date.now();
    await recordFeedback({ eventType: "booked", orgId: "org_1" });
    expect(Date.now() - start).toBeLessThan(500);
  });
});
