// Feedback signal capture (Phase F). Every significant human judgment on a draft
// (edit, approve, reject) and every outcome (reply) is recorded as an append-only
// FeedbackEvent row. These are training signals: diffs, decisions, and outcomes
// for future prompt-tuning passes. Fire-and-forget — never block the main action.
import { db } from "@/lib/db";
import type { FeedbackEventType } from "@/lib/generated/prisma/client";

interface FeedbackBase {
  orgId: string;
  draftId?: string;
  actorId?: string;
  meta?: Record<string, unknown>;
}

interface EditedSignal extends FeedbackBase {
  eventType: "edited";
  originalBody: string;
  editedBody: string;
}

interface SimpleSignal extends FeedbackBase {
  eventType: "approved" | "rejected" | "replied" | "booked";
}

export type FeedbackSignal = EditedSignal | SimpleSignal;

/** Record a feedback event. Swallows errors so a DB hiccup never blocks the route. */
export async function recordFeedback(signal: FeedbackSignal): Promise<void> {
  try {
    await db.feedbackEvent.create({
      data: {
        orgId: signal.orgId,
        draftId: signal.draftId ?? null,
        eventType: signal.eventType as FeedbackEventType,
        originalBody: "originalBody" in signal ? signal.originalBody : null,
        editedBody: "editedBody" in signal ? signal.editedBody : null,
        actorId: signal.actorId ?? null,
        meta: (signal.meta ?? {}) as object,
      },
    });
  } catch {
    // signals are best-effort; never throw
  }
}
