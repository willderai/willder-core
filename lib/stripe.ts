// Stripe client singleton. Guarded: returns null when STRIPE_SECRET_KEY is unset so
// dev/CI (and any org that never touches billing) never crash — every caller checks.
// Mirrors the codebase's "degrade gracefully when a service isn't configured" posture
// (see pgvector-store, mailbox mock). Live requires STRIPE_SECRET_KEY (+ webhook secret
// + price ids); until then everything runs in test-mode / no-op.
import Stripe from "stripe";

let _stripe: Stripe | null = null;

export function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (!_stripe) _stripe = new Stripe(key);
  return _stripe;
}

export function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}
