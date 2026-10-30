import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Unit tests for services/guardrails.ts. The DB is fully mocked so we test the
// decision logic in isolation: cap arithmetic, status checks, cooldown window,
// and filter set operations.
vi.mock("@/lib/db", () => ({
  db: {
    org: { findUnique: vi.fn() },
    orgPreference: { findUnique: vi.fn() },
    message: { count: vi.fn(), findFirst: vi.fn() },
    contact: { findFirst: vi.fn(), findMany: vi.fn() },
  },
}));

import { db } from "@/lib/db";
import { checkEpisodeCap, checkSendCap, checkContactGuardrails, filterSendableContacts } from "./guardrails";

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

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

// ---------------------------------------------------------------------------
// checkEpisodeCap: hosted free orgs are capped; self-hosted/local install orgs are not
// ---------------------------------------------------------------------------

describe("checkEpisodeCap", () => {
  const HOSTED_MARKERS = ["VERCEL", "VERCEL_ENV", "CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"];
  /** A process with no hosted-deployment marker, as a self-hosted install's is. */
  function selfHostedProcess() {
    for (const name of HOSTED_MARKERS) vi.stubEnv(name, "");
  }
  function org(fields: { plan?: string; episodeCount: number; clerkOrgId: string | null }) {
    vi.mocked(db.org.findUnique).mockResolvedValue({ plan: "free", episodeCapIncluded: 1000, ...fields } as never);
  }
  const CAP_MESSAGE = "Free plan memory cap (1000 episodes) reached — upgrade to keep adding memory";

  it("reads the org's clerkOrgId with the counters", async () => {
    org({ episodeCount: 0, clerkOrgId: "org_2abc" });
    await checkEpisodeCap("o1");
    expect(db.org.findUnique).toHaveBeenCalledWith({
      where: { id: "o1" },
      select: { plan: true, episodeCount: true, episodeCapIncluded: true, clerkOrgId: true },
    });
  });

  describe("a hosted free org (Clerk-synced) is unchanged", () => {
    beforeEach(selfHostedProcess);
    it("passes at 999", async () => {
      org({ episodeCount: 999, clerkOrgId: "org_2abc" });
      await expect(checkEpisodeCap("o1")).resolves.toBeUndefined();
    });
    it("refuses write #1001 with the same code and message as before", async () => {
      org({ episodeCount: 1000, clerkOrgId: "org_2abc" });
      await expect(checkEpisodeCap("o1")).rejects.toMatchObject({
        name: "GuardrailError",
        code: "episode_cap_exceeded",
        message: CAP_MESSAGE,
      });
    });
    it("refuses an org with no clerkOrgId", async () => {
      org({ episodeCount: 1000, clerkOrgId: null });
      await expect(checkEpisodeCap("o1")).rejects.toMatchObject({ code: "episode_cap_exceeded", message: CAP_MESSAGE });
    });
    it("refuses an org whose key only resembles a self-host key", async () => {
      for (const clerkOrgId of ["Self-Hosted", "self-hosted ", "org_self-hosted", "local-dev-2", ""]) {
        org({ episodeCount: 1000, clerkOrgId });
        await expect(checkEpisodeCap("o1")).rejects.toMatchObject({ code: "episode_cap_exceeded" });
      }
    });
    it("still never gates a paid plan", async () => {
      org({ plan: "founder", episodeCount: 50_000, clerkOrgId: "org_2abc" });
      await expect(checkEpisodeCap("o1")).resolves.toBeUndefined();
    });
  });

  describe("a self-hosted or local install's org", () => {
    it.each(["self-hosted", "self-hosted-smoke", "local-dev"])(
      "%s on the free plan accepts write #1001 and beyond",
      async (clerkOrgId) => {
        selfHostedProcess();
        org({ episodeCount: 1000, clerkOrgId });
        await expect(checkEpisodeCap("o1")).resolves.toBeUndefined();
        org({ episodeCount: 250_000, clerkOrgId });
        await expect(checkEpisodeCap("o1")).resolves.toBeUndefined();
      },
    );

    it.each([
      ["VERCEL", "1"],
      ["VERCEL_ENV", "production"],
      ["VERCEL_ENV", "preview"],
      ["CLERK_SECRET_KEY", "sk_live_x"],
      ["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", " pk_live_x"],
    ])("is capped again on a hosted deployment (%s=%s): fails closed", async (name, value) => {
      selfHostedProcess();
      vi.stubEnv(name, value);
      org({ episodeCount: 1000, clerkOrgId: "self-hosted" });
      await expect(checkEpisodeCap("o1")).rejects.toMatchObject({ code: "episode_cap_exceeded", message: CAP_MESSAGE });
    });

    it("is not capped by a test-mode Clerk key", async () => {
      selfHostedProcess();
      vi.stubEnv("CLERK_SECRET_KEY", "sk_test_x");
      vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "pk_test_x");
      org({ episodeCount: 1000, clerkOrgId: "self-hosted" });
      await expect(checkEpisodeCap("o1")).resolves.toBeUndefined();
    });
  });
});
