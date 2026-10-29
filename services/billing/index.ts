// Billing service — PAYG.
//   - No subscription/tiers. A single prepaid CREDIT BALANCE per org (welcome grant +
//     purchased packs), drawn down by ACCEPTED artifacts.
//   - Top-ups are one-time Stripe Checkout payments for a credit pack; the paid webhook
//     credits the balance.
//   - When an accepted artifact takes the balance below zero, the deficit is best-effort
//     reported to Stripe as a metered event (optional; prepaid-only otherwise).
//
// Everything is guarded on Stripe being configured (getStripe()) — with no keys, the
// local credit accounting still runs (source of truth for the UI) and Stripe calls no-op.
// Nothing here ever throws into the agent pipeline: usage recording is best-effort.
import type Stripe from "stripe";
import { db } from "@/lib/db";
import { readableUsageCredits, readableUsageRows, readsWholeOrg, type UsageRow } from "@/services/access";
import { getStripe, stripeConfigured } from "@/lib/stripe";
import {
  creditsFor,
  creditPack,
  paymentsEnabled,
  OVERAGE_METER_EVENT_ENV,
  WELCOME_BONUS_CREDITS,
  USD_PER_CREDIT,
} from "./plans";

// --- Stripe customer -------------------------------------------------------

/** Ensure the org has a Stripe customer; returns the id (or null if Stripe unconfigured). */
async function ensureStripeCustomer(orgId: string): Promise<string | null> {
  const stripe = getStripe();
  if (!stripe) return null;

  const org = await db.org.findUnique({
    where: { id: orgId },
    select: { id: true, name: true, stripeCustomerId: true },
  });
  if (!org) return null;
  if (org.stripeCustomerId) return org.stripeCustomerId;

  const customer = await stripe.customers.create({
    name: org.name,
    metadata: { orgId: org.id },
  });
  await db.org.update({ where: { id: orgId }, data: { stripeCustomerId: customer.id } });
  return customer.id;
}

// --- Checkout / portal -----------------------------------------------------

/** Start a one-time Checkout to buy a credit pack. Returns the hosted URL or null. */
export async function createCheckoutSession(
  orgId: string,
  packId: string,
  urls: { successUrl: string; cancelUrl: string },
): Promise<string | null> {
  if (!paymentsEnabled()) return null; // Free beta: no payments taken.
  const stripe = getStripe();
  if (!stripe) return null;

  const pack = creditPack(packId);
  if (!pack) return null;
  const priceId = process.env[pack.stripePriceEnv];
  if (!priceId) return null; // pack price id not configured

  const customerId = await ensureStripeCustomer(orgId);
  if (!customerId) return null;

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: urls.successUrl,
    cancel_url: urls.cancelUrl,
    // Credits to grant ride the metadata so the paid webhook is self-describing.
    metadata: { orgId, packId: pack.id, credits: String(pack.credits) },
    payment_intent_data: { metadata: { orgId, packId: pack.id, credits: String(pack.credits) } },
  });
  return session.url;
}

/** Open the Customer Portal (payment methods, invoices, receipts). */
export async function createPortalSession(orgId: string, returnUrl: string): Promise<string | null> {
  if (!paymentsEnabled()) return null; // Free beta: nothing to manage yet.
  const stripe = getStripe();
  if (!stripe) return null;
  const customerId = await ensureStripeCustomer(orgId);
  if (!customerId) return null;
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  return session.url;
}

// --- Accepted-artifact metering -------------------------------------------

export interface ArtifactUsageInput {
  orgId: string;
  artifactType: string; // "handoff" | "architecture_plan" | "qa_review" | "draft"
  briefId?: string;
  draftId?: string;
  scopePath?: string | null;
  actorId?: string | null;
}

/**
 * Record one ACCEPTED artifact as consumption. Decrements the org's credit balance,
 * writes an ArtifactUsage row, and (for any portion that takes the balance below zero)
 * best-effort reports metered overage to Stripe. Never throws — a billing hiccup must
 * not fail an agent run.
 */
export async function recordArtifactUsage(input: ArtifactUsageInput): Promise<void> {
  const credits = creditsFor(input.artifactType);
  try {
    const org = await db.org.findUnique({
      where: { id: input.orgId },
      select: { creditBalance: true, stripeCustomerId: true },
    });
    if (!org) return;

    // Any credits that push the balance below zero are billed as metered overage.
    const before = org.creditBalance;
    const after = before - credits;
    const overageCredits = Math.max(0, -after) - Math.max(0, -before);
    const isOverage = overageCredits > 0;

    const usage = await db.artifactUsage.create({
      data: {
        orgId: input.orgId,
        artifactType: input.artifactType,
        briefId: input.briefId ?? null,
        draftId: input.draftId ?? null,
        credits,
        scopePath: input.scopePath ?? null,
        actorId: input.actorId ?? null,
        overage: isOverage,
      },
    });
    await db.org.update({
      where: { id: input.orgId },
      data: { creditBalance: { decrement: credits } },
    });

    if (isOverage) {
      const reported = await reportOverage(org.stripeCustomerId, overageCredits);
      if (reported) {
        await db.artifactUsage.update({ where: { id: usage.id }, data: { stripeReported: true } });
      }
    }
  } catch (e) {
    console.warn("[billing] usage record skipped:", e instanceof Error ? e.message : e);
  }
}

async function reportOverage(customerId: string | null, credits: number): Promise<boolean> {
  if (!paymentsEnabled()) return false; // Free beta: never bill overage.
  const stripe = getStripe();
  const eventName = process.env[OVERAGE_METER_EVENT_ENV];
  if (!stripe || !customerId || !eventName) return false;
  try {
    await stripe.billing.meterEvents.create({
      event_name: eventName,
      payload: { stripe_customer_id: customerId, value: String(credits) },
    });
    return true;
  } catch (e) {
    console.warn("[billing] overage report skipped:", e instanceof Error ? e.message : e);
    return false;
  }
}

/** Add purchased credits to an org's balance. Idempotent-safe callers should dedupe upstream. */
async function grantCredits(orgId: string, credits: number): Promise<void> {
  if (credits <= 0) return;
  await db.org.update({ where: { id: orgId }, data: { creditBalance: { increment: credits } } });
}

// --- Webhook handling ------------------------------------------------------

/** Apply a verified Stripe event to org billing state. */
export async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode !== "payment" || session.payment_status !== "paid") return;
      const orgId = session.metadata?.orgId;
      const credits = Number(session.metadata?.credits ?? 0);
      if (!orgId || !Number.isFinite(credits) || credits <= 0) return;
      await grantCredits(orgId, credits);
      break;
    }
    default:
      break;
  }
}

// --- Read model for the billing page --------------------------------------

/**
 * One usage row as the billing page lists it. `overage` says whether the org balance
 * had run out when the row was spent, which spend in every scope decides, so it is
 * null for a caller who may not read the whole org.
 */
type BillingUsageRow = Omit<UsageRow, "overage"> & { overage: boolean | null };

/** Credits spent from `since` (an ISO instant) on, in the scopes the caller may read. */
interface ReadableSpend {
  credits: number;
  since: string;
}

export interface BillingSummary {
  /** The org's prepaid balance, or null for a caller whose grants do not cover the org root. */
  creditBalance: number | null;
  /** What was spent this calendar month (UTC) in the scopes the caller may read. */
  spentInReadableScopes: ReadableSpend;
  welcomeGrant: number;
  usdPerCredit: number;
  stripeConfigured: boolean;
  paymentsEnabled: boolean;
  /** The newest usage rows in scopes the caller may read; see getBillingSummary. */
  recent: BillingUsageRow[];
}

/** How many usage rows the billing page lists. */
const RECENT_USAGE_ROWS = 10;

/** The first instant of `now`'s calendar month in UTC: where "this month" starts on the billing page. */
function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * The billing page's read model for one caller. The configuration is the org's;
 * every figure about spend is only what the caller's grants allow.
 *
 * `readablePaths` are the caller's granted scopes, from readableScopePaths(). A usage
 * row names its scope and what was spent there, so listing a row from a scope the
 * caller cannot read would tell them that scope exists and how busy it is: the
 * disclosure scoped access exists to prevent. A row with no scope is the org root's
 * and is listed only for a grant covering the root, which owners and admins hold.
 * The filter runs in the query, so readable rows behind newer hidden ones are found.
 *
 * The credit balance is drawn down by spend in every scope, so watching it move would
 * tell a caller what is spent where they cannot read. It is returned only to a caller
 * whose grants cover the org root; anyone else gets null, and so does each row's
 * `overage` flag, which records whether that balance had run out. Every caller gets
 * `spentInReadableScopes`, the credits spent this month in the scopes they read: the
 * whole org's spend for a root grant, their own scopes' for anyone else.
 */
export async function getBillingSummary(
  orgId: string,
  readablePaths: string[],
  now: Date = new Date(),
): Promise<BillingSummary | null> {
  const org = await db.org.findUnique({
    where: { id: orgId },
    select: { creditBalance: true },
  });
  if (!org) return null;

  const wholeOrg = readsWholeOrg(orgId, readablePaths);
  const since = startOfUtcMonth(now);
  const [credits, rows] = await Promise.all([
    readableUsageCredits(orgId, readablePaths, since),
    readableUsageRows(orgId, readablePaths, RECENT_USAGE_ROWS),
  ]);

  return {
    creditBalance: wholeOrg ? org.creditBalance : null,
    spentInReadableScopes: { credits, since: since.toISOString() },
    welcomeGrant: WELCOME_BONUS_CREDITS,
    usdPerCredit: USD_PER_CREDIT,
    stripeConfigured: stripeConfigured(),
    paymentsEnabled: paymentsEnabled(),
    recent: wholeOrg ? rows : rows.map((row) => ({ ...row, overage: null })),
  };
}
