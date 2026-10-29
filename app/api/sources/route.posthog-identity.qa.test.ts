// Mocked end to end: needs no database; runs in every environment.

import { beforeEach, describe, expect, it, vi } from "vitest";

// The connect's widening gate has its own tests (app/api/sources/route.widening.realdb.test.ts). Here the
// source reports no one beyond the scope, so these tests stay on what they cover.
vi.mock("@/services/connectors/source-readers", () => ({
  readersAtSource: vi.fn(async () => ({ kind: "known", readers: [{ kind: "everyone" }] })),
}));
vi.mock("@/services/access/source-widening", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/access/source-widening")>()),
  scopeAudience: vi.fn(async () => ({ people: [], agents: [] })),
}));

// PostHog source identity.
//
// The PostHog connector stores a source's upstream identity in two places:
// `Source.externalId` and `Source.meta.projectId`. The schema's unique key is
// `@@unique([orgId, type, externalId])` and `POST /api/sources` upserts on
// `orgId_type_externalId`, so only `externalId` actually participates in the
// row's identity.
//
// A PostHog insight id is only unique inside its own project, so an org with
// two projects can legitimately own insight 42 in each. With `externalId` as
// the bare insight id, both projects' insight 42 would address the same row
// and the second connect would silently overwrite the first's project, name
// and sealed key, and inherit the first's scope (a grant-inheritance leak).
// `externalId` carries the project (`${projectId}:${insightId}`); these
// tests pin that non-colliding identity.

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: vi.fn(() => false), per: { hour: 3600 } }));
vi.mock("@/lib/inngest", () => ({
  SOURCE_SYNC_EVENT: "source/sync.requested",
  inngest: { send: vi.fn().mockResolvedValue({ ids: ["job_1"] }) },
}));
vi.mock("@/lib/db", () => ({
  db: {
    source: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() },
    scope: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));
// The change-feed event is covered by its own tests; here it only has to not throw.
vi.mock("@/services/memory/source-change-event", () => ({ recordSourceChange: vi.fn() }));
vi.mock("@/services/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/access")>();
  return { ...actual, check: vi.fn() };
});
vi.mock("@/lib/crypto", () => ({ sealSecret: vi.fn((v: unknown) => `sealed:${JSON.stringify(v)}`) }));

import { requireAccessContext } from "@/lib/access-context";
import { db } from "@/lib/db";
import { check } from "@/services/access";
import { POST } from "./route";

const rc = {
  org: { id: "org_1" },
  user: { id: "user_42" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "member" } },
};

function connectInsight(projectId: string, insightId: string, insightName: string) {
  return POST(
    new Request("http://test/api/sources", {
      method: "POST",
      body: JSON.stringify({ type: "posthog", projectId, insightId, insightName, apiKey: `phx_${projectId}` }),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
  vi.mocked(check).mockResolvedValue({ allowed: true } as never);
  vi.mocked(db.$transaction).mockImplementation(((fn: (tx: unknown) => unknown) =>
    fn({
      source: db.source,
      $executeRaw: vi.fn(),
      scope: { create: vi.fn().mockResolvedValue({ id: "scope_1" }) },
      grant: { create: vi.fn().mockResolvedValue({ id: "grant_1" }) },
    })) as never);
  vi.mocked(db.source.upsert).mockResolvedValue({
    id: "src_1",
    type: "posthog",
    name: "n",
    scopePath: "org_1.p",
    status: "active",
  } as never);
});

describe("POST /api/sources — posthog source identity across projects", () => {
  it("gives the same insight id in two different projects two distinct rows, not one", async () => {
    // Project 1's insight 42 — nothing connected yet.
    vi.mocked(db.source.findUnique).mockResolvedValue(null as never);
    await connectInsight("1", "42", "Weekly signups (project 1)");
    const first = vi.mocked(db.source.upsert).mock.calls[0][0] as {
      where: { orgId_type_externalId: { orgId: string; type: string; externalId: string } };
      create: { meta?: { projectId?: string } };
    };

    // Project 2's insight 42 — a different upstream object in the same org.
    // Its externalId carries project 2, so the scope-resolution lookup for
    // THIS externalId correctly finds nothing (not project 1's row).
    vi.mocked(db.source.upsert).mockClear();
    vi.mocked(db.source.findUnique).mockResolvedValue(null as never);
    await connectInsight("2", "42", "Checkout funnel (project 2)");
    const second = vi.mocked(db.source.upsert).mock.calls[0][0] as {
      where: { orgId_type_externalId: { orgId: string; type: string; externalId: string } };
      create: { name: string; meta?: { projectId?: string }; encryptedTokens?: string };
    };

    // Two different rows, not one — the fix for the collision.
    expect(first.where.orgId_type_externalId.externalId).toBe("1:42");
    expect(second.where.orgId_type_externalId.externalId).toBe("2:42");
    expect(second.where).not.toEqual(first.where);

    // ...so neither overwrites the other's project, name, or sealed key.
    expect(first.create.meta?.projectId).toBe("1");
    expect(second.create.meta?.projectId).toBe("2");
    expect(second.create.name).toBe("Checkout funnel (project 2)");
    expect(second.create.encryptedTokens).toBe(`sealed:${JSON.stringify({ apiKey: "phx_2" })}`);
  });

  it("reconnecting the SAME project+insight still reuses its own existing scope", async () => {
    // A Source row already exists for (org_1, posthog, "1:42") — a genuine
    // reconnect of the same upstream object, e.g. a key refresh.
    vi.mocked(db.source.findUnique).mockResolvedValue({ scopePath: "org_1.weekly_signups_ab12cd" } as never);

    await connectInsight("1", "42", "Weekly signups (refreshed)");

    const call = vi.mocked(db.source.upsert).mock.calls[0][0] as {
      where: { orgId_type_externalId: { externalId: string } };
      update: { scopePath: string };
    };
    expect(call.where.orgId_type_externalId.externalId).toBe("1:42");
    expect(call.update.scopePath).toBe("org_1.weekly_signups_ab12cd");
    // No new scope was minted for what is genuinely the same upstream object.
    // One transaction: the upsert and its change event. A new scope would be a second.
    expect(vi.mocked(db.$transaction)).toHaveBeenCalledTimes(1);
  });

  it("keeps two insights inside one project distinct — the id is what separates them", async () => {
    vi.mocked(db.source.findUnique).mockResolvedValue(null as never);
    await connectInsight("1", "42", "Weekly signups");
    await connectInsight("1", "43", "Checkout funnel");

    const calls = vi.mocked(db.source.upsert).mock.calls as unknown as Array<
      [{ where: { orgId_type_externalId: { externalId: string } } }]
    >;
    expect(calls[0][0].where.orgId_type_externalId.externalId).toBe("1:42");
    expect(calls[1][0].where.orgId_type_externalId.externalId).toBe("1:43");
  });
});
