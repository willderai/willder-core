// PAYG pricing config.
// No subscription/tiers. Credits are a PREPAID BALANCE — a one-time welcome grant plus
// purchased packs — drawn down by ACCEPTED artifacts. All prices here are provisional
// TEST-MODE anchors; swap for real numbers + real Stripe price ids (via env) before going live.

// --- Value-tier: credits an accepted artifact costs, by type ---
// Heavier synthesis costs more (architecture/QA > handoff > draft). Tune freely.
export const ARTIFACT_CREDITS: Record<string, number> = {
  handoff: 3,
  architecture_plan: 5,
  qa_review: 5,
  draft: 1,
};

export function creditsFor(artifactType: string): number {
  return ARTIFACT_CREDITS[artifactType] ?? 1;
}

// One-time welcome grant on org creation — a taste before paying (enough for ~one
// flagship artifact: a Handoff = 3, or an Architecture/QA = 5).
export const WELCOME_BONUS_CREDITS = 5;

// Provisional per-credit anchor (USD) — COGS-plus, ~$0.30/credit. Used for display only;
// actual charges go through the Stripe prices below.
export const USD_PER_CREDIT = 0.3;

// --- Prepaid credit packs (one-time Stripe payments) ---
// Volume discount vs the raw per-credit anchor. Each maps to a one-time Stripe Price id
// via its env var. Provisional sizing/pricing.
export interface CreditPack {
  id: string;
  label: string;
  credits: number;
  priceUsd: number; // display price
  /** Env var holding the one-time Stripe price id for this pack. */
  stripePriceEnv: string;
}

export const CREDIT_PACKS: CreditPack[] = [
  { id: "starter", label: "Starter", credits: 50, priceUsd: 15, stripePriceEnv: "STRIPE_PRICE_PACK_STARTER" },
  { id: "builder", label: "Builder", credits: 200, priceUsd: 50, stripePriceEnv: "STRIPE_PRICE_PACK_BUILDER" },
  { id: "scale", label: "Scale", credits: 500, priceUsd: 110, stripePriceEnv: "STRIPE_PRICE_PACK_SCALE" },
];

export function creditPack(id: string): CreditPack | undefined {
  return CREDIT_PACKS.find((p) => p.id === id);
}

// Optional metered overage: when an accepted artifact takes the balance below zero, the
// deficit is reported to Stripe as billing meter events. The meter's event_name lives in
// this env var (unset → prepaid-only, balance simply goes negative until topped up).
export const OVERAGE_METER_EVENT_ENV = "STRIPE_OVERAGE_METER_EVENT";

// --- Payment gating ---------------------------------------------------------
// While PAYMENTS_ENABLED is off (free beta), Willder takes NO
// payments — no checkout, no portal, no metered overage — regardless of Stripe config.
// This is an EXPLICIT switch, not merely "are Stripe keys present?", so wiring Stripe for
// testing (or the overage meter) can never silently start charging real customers.
// Default OFF; set to any of true/1/on/yes to open payments.
export function paymentsEnabled(): boolean {
  const v = process.env.PAYMENTS_ENABLED?.toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "yes";
}
