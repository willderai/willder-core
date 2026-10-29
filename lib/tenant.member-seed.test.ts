// When a signed-in person first appears in an org, ensureTenant() queues an ingest
// that seeds memory with their membership. Inngest does not type an event's payload,
// so the compiler cannot require that ingest to say where it came from; this test does.
// The request behind it is the person's own session, so its origin is "app".
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send, findOrg, findUser, updateUser } = vi.hoisted(() => ({
  send: vi.fn(),
  findOrg: vi.fn(),
  findUser: vi.fn(),
  updateUser: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ userId: "clerk-user-1", orgId: "clerk-org-1", orgRole: "org:member" })),
  clerkClient: vi.fn(),
  currentUser: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    org: { findUnique: findOrg },
    user: { findUnique: findUser, update: updateUser },
    // Every built-in agent already exists, so the fast path seeds no agents.
    agent: { count: vi.fn(async () => Number.MAX_SAFE_INTEGER) },
  },
}));
vi.mock("@/lib/inngest", () => ({ inngest: { send }, MEMORY_INGEST_EVENT: "memory/ingest.requested" }));
// Membership is recorded with raw SQL, proven against real Postgres in
// services/access/org-membership.realdb.test.ts; here the person is a live member.
vi.mock("@/services/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/access")>()),
  recordMembership: vi.fn(async ({ role }: { role: string }) => ({ role, removedAt: null })),
}));

import { ensureTenant } from "./tenant";

describe("ensureTenant's membership seed", () => {
  beforeEach(() => {
    send.mockReset().mockResolvedValue({ ids: ["evt-1"] });
    findOrg.mockResolvedValue({ id: "org-new", name: "Acme", clerkOrgId: "clerk-org-1" });
    findUser.mockResolvedValue({
      id: "user-1",
      clerkId: "clerk-user-1",
      orgId: "org-old",
      role: "member",
      name: "Ada",
      email: "ada@example.com",
    });
    updateUser.mockResolvedValue({});
  });

  it("records the person's session as the ingest's origin", async () => {
    await ensureTenant();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({
      name: "memory/ingest.requested",
      data: { groupId: "org-new", actorType: "extraction", origin: "app" },
    });
  });
});
