// A session token carries the role the person had when it was issued. When Clerk
// has since reported a change through the webhook, the membership holds the newer
// role, and ensureTenant() shows that one on the user row, not the token's.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findOrg, findUser, updateUser, recordMembership } = vi.hoisted(() => ({
  findOrg: vi.fn(),
  findUser: vi.fn(),
  updateUser: vi.fn(),
  recordMembership: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  // The token still says admin.
  auth: vi.fn(async () => ({ userId: "clerk-user-1", orgId: "clerk-org-1", orgRole: "org:admin" })),
  clerkClient: vi.fn(),
  currentUser: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    org: { findUnique: findOrg },
    user: { findUnique: findUser, update: updateUser },
    agent: { count: vi.fn(async () => Number.MAX_SAFE_INTEGER) },
  },
}));
vi.mock("@/lib/inngest", () => ({ inngest: { send: vi.fn(async () => ({})) }, MEMORY_INGEST_EVENT: "memory/ingest" }));
vi.mock("@/services/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/access")>()),
  recordMembership,
}));

import { ensureTenant } from "./tenant";

describe("ensureTenant's role on a returning visit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findOrg.mockResolvedValue({ id: "org-1", name: "Acme", clerkOrgId: "clerk-org-1" });
    findUser.mockResolvedValue({
      id: "user-1",
      clerkId: "clerk-user-1",
      orgId: "org-1",
      role: "admin",
      name: "Ada",
      email: "ada@example.com",
      emailVerified: true,
    });
    updateUser.mockResolvedValue({});
  });

  it("shows the membership's newer role, not the one the session token asserts", async () => {
    // Clerk demoted the person after this token was issued.
    recordMembership.mockResolvedValue({ role: "member", removedAt: null });
    await ensureTenant();
    expect(recordMembership).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", userId: "user-1", role: "admin" }),
    );
    expect(updateUser).toHaveBeenCalledWith({ where: { clerkId: "clerk-user-1" }, data: { role: "member" } });
  });

  it("returns no org for a person whose membership was removed", async () => {
    recordMembership.mockResolvedValue({ role: "admin", removedAt: new Date("2026-10-09T00:00:00Z") });
    expect(await ensureTenant()).toBeNull();
    expect(updateUser).not.toHaveBeenCalled();
  });
});
