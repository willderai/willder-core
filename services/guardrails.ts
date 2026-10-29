// Operational guardrails (Phase F). Volume-based spend caps and contact-level
// sending guardrails. Called before the campaign fan-out and before each send so
// we never exceed the org's self-imposed daily limits or email a contact who opted
// out / was emailed too recently.
import { db } from "@/lib/db";

/** Thrown when a cap or guardrail is violated so routes can map it to a 429 / 409. */
export class GuardrailError extends Error {
  constructor(
    readonly code: GuardrailCode,
    message: string,
  ) {
    super(message);
    this.name = "GuardrailError";
  }
}

export type GuardrailCode =
  | "send_cap_exceeded"
  | "contact_unsubscribed"
  | "contact_bounced"
  | "send_cooldown"
  | "episode_cap_exceeded";

/** UTC start of the current calendar day. */
function todayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Fetch (or default) the org's preference row. Gracefully defaults if absent. */
async function getCaps(orgId: string): Promise<{ maxDraftsPerDay: number; maxSendsPerDay: number }> {
  const pref = await db.orgPreference.findUnique({ where: { orgId } });
  return {
    maxDraftsPerDay: pref?.maxDraftsPerDay ?? 200,
    maxSendsPerDay: pref?.maxSendsPerDay ?? 100,
  };
}

/**
 * Throw if a free-plan org has reached its lifetime memory episode cap. Paid
 * plans (founder/standard) are not gated here — their overage is billed, not
 * blocked. Call before dispatching the ingest so we don't do work we'll discard.
 */
export async function checkEpisodeCap(orgId: string): Promise<void> {
  const org = await db.org.findUnique({
    where: { id: orgId },
    select: { plan: true, episodeCount: true, episodeCapIncluded: true },
  });
  if (!org || org.plan !== "free") return;
  if (org.episodeCount >= org.episodeCapIncluded) {
    throw new GuardrailError(
      "episode_cap_exceeded",
      `Free plan memory cap (${org.episodeCapIncluded} episodes) reached — upgrade to keep adding memory`,
    );
  }
}

/** Increment the org's lifetime episode counter after a successful ingest. */
export async function recordEpisode(orgId: string): Promise<void> {
  await db.org.update({
    where: { id: orgId },
    data: { episodeCount: { increment: 1 } },
  });
}

/**
 * Throw if the org has already sent `maxSendsPerDay` emails today.
 * Call before sendDraft so the route returns 429 before touching the mailbox.
 */
export async function checkSendCap(orgId: string): Promise<void> {
  const { maxSendsPerDay } = await getCaps(orgId);
  const today = todayUtc();
  const count = await db.message.count({
    where: { orgId, direction: "out", sentAt: { gte: today } },
  });
  if (count >= maxSendsPerDay) {
    throw new GuardrailError(
      "send_cap_exceeded",
      `Daily send cap (${maxSendsPerDay}) reached — ${count} emails sent today`,
    );
  }
}

/**
 * Throw if the contact has unsubscribed/bounced or was emailed within the cooldown
 * window (24 h). Call before sendDraft.
 */
export async function checkContactGuardrails(orgId: string, contactId: string): Promise<void> {
  const contact = await db.contact.findFirst({
    where: { id: contactId, orgId },
    select: { status: true },
  });
  if (!contact) return;
  if (contact.status === "unsubscribed") {
    throw new GuardrailError("contact_unsubscribed", "Contact has unsubscribed");
  }
  if (contact.status === "bounced") {
    throw new GuardrailError("contact_bounced", "Contact email has bounced");
  }

  // 24-hour cooldown: reject if we sent something to this contact within the last day.
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentSend = await db.message.findFirst({
    where: {
      orgId,
      direction: "out",
      sentAt: { gte: cutoff },
      conversation: { contactId },
    },
    select: { id: true },
  });
  if (recentSend) {
    throw new GuardrailError("send_cooldown", "A message was already sent to this contact within the last 24 hours");
  }
}

/**
 * Filter a list of contact IDs to those safe to enqueue (not unsubscribed/bounced).
 * Used by campaignStart to skip opted-out contacts before fan-out.
 */
export async function filterSendableContacts(orgId: string, contactIds: string[]): Promise<string[]> {
  if (contactIds.length === 0) return [];
  const bad = await db.contact.findMany({
    where: { orgId, id: { in: contactIds }, status: { in: ["unsubscribed", "bounced"] } },
    select: { id: true },
  });
  const badSet = new Set(bad.map((c) => c.id));
  return contactIds.filter((id) => !badSet.has(id));
}
