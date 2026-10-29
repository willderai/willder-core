import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Mock the DB + Stripe so we exercise the PAYG credit accounting in isolation.
const org = { creditBalance: 0, stripeCustomerId: null as string | null };
const created: Array<Record<string, unknown>> = [];

vi.mock("@/lib/db", () => ({
  db: {
    org: {
      findUnique: vi.fn(async () => ({ ...org })),
      update: vi.fn(async ({ data }: { data: { creditBalance?: { decrement?: number; increment?: number } } }) => {
        if (data.creditBalance?.decrement) org.creditBalance -= data.creditBalance.decrement;
        if (data.creditBalance?.increment) org.creditBalance += data.creditBalance.increment;
        return {};
      }),
    },
    artifactUsage: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `u${created.length}`, ...data };
        created.push(row);
        return row;
      }),
      update: vi.fn(async () => ({})),
    },
  },
}));

vi.mock("@/lib/stripe", () => ({ getStripe: () => null, stripeConfigured: () => false }));

// The spend reads are the access layer's; here only the window they are asked for matters.
const { readableUsageCredits } = vi.hoisted(() => ({ readableUsageCredits: vi.fn(async () => 0) }));
vi.mock("@/services/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/access")>()),
  readableUsageCredits,
  readableUsageRows: vi.fn(async () => []),
}));

import {
  recordArtifactUsage,
  handleStripeEvent,
  createCheckoutSession,
  createPortalSession,
  getBillingSummary,
} from "./index";
import { creditsFor, ARTIFACT_CREDITS, paymentsEnabled } from "./plans";

beforeEach(() => {
  org.creditBalance = 0;
  org.stripeCustomerId = null;
  created.length = 0;
});

describe("creditsFor — value tiering by artifact type", () => {
  it("charges heavier synthesis more; unknown types default to 1", () => {
    expect(creditsFor("architecture_plan")).toBe(ARTIFACT_CREDITS.architecture_plan);
    expect(creditsFor("qa_review")).toBe(5);
    expect(creditsFor("handoff")).toBe(3);
    expect(creditsFor("draft")).toBe(1);
    expect(creditsFor("something_new")).toBe(1);
  });
});

describe("recordArtifactUsage — PAYG balance accounting", () => {
  it("decrements the balance by the artifact's credits; no metered flag while in the black", async () => {
    org.creditBalance = 50;
    await recordArtifactUsage({ orgId: "o1", artifactType: "handoff" }); // 3 credits
    expect(created).toHaveLength(1);
    expect(created[0].credits).toBe(3);
    expect(created[0].overage).toBe(false);
    expect(org.creditBalance).toBe(47);
  });

  it("flags only the portion that crosses zero as metered overage", async () => {
    org.creditBalance = 2; // 2 left before going negative
    await recordArtifactUsage({ orgId: "o1", artifactType: "qa_review" }); // 5 credits → 2→-3
    // overageCredits = max(0,3) - max(0,-2) = 3 - 0 = 3 (>0) → flagged
    expect(created[0].overage).toBe(true);
    expect(created[0].credits).toBe(5);
    expect(org.creditBalance).toBe(-3);
  });

  it("flags artifacts spent while already negative as fully metered", async () => {
    org.creditBalance = -10; // already in the red
    await recordArtifactUsage({ orgId: "o1", artifactType: "draft" }); // 1 credit, entirely metered
    expect(created[0].overage).toBe(true);
    expect(org.creditBalance).toBe(-11);
  });

  it("spends the welcome grant like any other credits (balance only)", async () => {
    org.creditBalance = 5; // one welcome grant
    await recordArtifactUsage({ orgId: "o1", artifactType: "qa_review" }); // 5 credits, exactly covered
    expect(org.creditBalance).toBe(0);
    expect(created[0].overage).toBe(false);
  });

  it("never throws when the org is missing (best-effort, must not fail an agent run)", async () => {
    const { db } = await import("@/lib/db");
    vi.mocked(db.org.findUnique).mockResolvedValueOnce(null as never);
    await expect(recordArtifactUsage({ orgId: "missing", artifactType: "handoff" })).resolves.toBeUndefined();
  });
});

describe("handleStripeEvent — credit-pack top-up", () => {
  it("grants credits on a paid one-time checkout session", async () => {
    org.creditBalance = 0;
    await handleStripeEvent({
      type: "checkout.session.completed",
      data: {
        object: {
          mode: "payment",
          payment_status: "paid",
          metadata: { orgId: "o1", packId: "builder", credits: "200" },
        },
      },
    } as never);
    expect(org.creditBalance).toBe(200);
  });

  it("ignores unpaid or non-payment sessions", async () => {
    org.creditBalance = 0;
    await handleStripeEvent({
      type: "checkout.session.completed",
      data: { object: { mode: "payment", payment_status: "unpaid", metadata: { orgId: "o1", credits: "200" } } },
    } as never);
    expect(org.creditBalance).toBe(0);
  });
});

describe("paymentsEnabled — free beta gate (off by default)", () => {
  const prev = process.env.PAYMENTS_ENABLED;
  afterEach(() => {
    if (prev === undefined) delete process.env.PAYMENTS_ENABLED;
    else process.env.PAYMENTS_ENABLED = prev;
  });

  it("is OFF unless explicitly enabled", () => {
    delete process.env.PAYMENTS_ENABLED;
    expect(paymentsEnabled()).toBe(false);
    process.env.PAYMENTS_ENABLED = "false";
    expect(paymentsEnabled()).toBe(false);
    process.env.PAYMENTS_ENABLED = "0";
    expect(paymentsEnabled()).toBe(false);
    for (const on of ["true", "1", "on", "yes", "TRUE"]) {
      process.env.PAYMENTS_ENABLED = on;
      expect(paymentsEnabled()).toBe(true);
    }
  });

  it("no checkout or portal session is created while payments are disabled", async () => {
    delete process.env.PAYMENTS_ENABLED;
    const checkout = await createCheckoutSession("o1", "builder", {
      successUrl: "https://willder.ai/billing?checkout=success",
      cancelUrl: "https://willder.ai/billing?checkout=cancelled",
    });
    const portal = await createPortalSession("o1", "https://willder.ai/billing");
    expect(checkout).toBeNull();
    expect(portal).toBeNull();
  });
});

describe("getBillingSummary — this month's spend window", () => {
  const processTimeZone = process.env.TZ;
  afterEach(() => {
    if (processTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = processTimeZone;
  });

  // CI runs in UTC, where a local-time month start is indistinguishable from the UTC one.
  // In Los Angeles, 03:00Z on October 1 is still September 30, so a local month start
  // would reach back to September 1.
  it("starts at the first of the month in UTC whatever the server's time zone", async () => {
    process.env.TZ = "America/Los_Angeles";
    const summary = await getBillingSummary("org1", ["org1"], new Date("2026-10-01T03:00:00Z"));

    expect(summary?.spentInReadableScopes.since).toBe("2026-10-01T00:00:00.000Z");
    expect(readableUsageCredits).toHaveBeenCalledWith("org1", ["org1"], new Date("2026-10-01T00:00:00Z"));
  });
});
