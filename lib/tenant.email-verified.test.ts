// ensureTenant records whether Clerk verified the email it stores for a user
// (User.emailVerified), which source-connect widening trusts before matching a
// person to a source's sharing list. Clerk and the database are mocked; the
// assertions are on what the user row is written with.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn(), clerkClient: vi.fn(), currentUser: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    orgDeletion: { findFirst: async () => null },
    org: { findUnique: vi.fn(), upsert: vi.fn() },
    user: { findUnique: vi.fn(), update: vi.fn(), upsert: vi.fn() },
    scope: { upsert: vi.fn(async () => ({ id: "scope_root" })) },
    grant: { upsert: vi.fn() },
    agent: { upsert: vi.fn(), count: vi.fn(async () => 99) },
  },
}));
vi.mock("@/lib/inngest", () => ({ MEMORY_INGEST_EVENT: "memory/ingest", inngest: { send: vi.fn(async () => ({})) } }));
// Membership is recorded with raw SQL, proven against real Postgres in
// services/access/org-membership.realdb.test.ts; here the person is a live member.
vi.mock("@/services/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/access")>()),
  recordMembership: vi.fn(async ({ role }: { role: string }) => ({ role, removedAt: null })),
}));
vi.mock("@/services/agents/runner", () => ({
  DEFAULT_TOOLS: { handoff: [], architecture: [], qa: [] },
  DEFAULT_HANDOFF_PROMPT: "",
  DEFAULT_ARCHITECTURE_PROMPT: "",
  DEFAULT_QA_PROMPT: "",
}));

import { auth, clerkClient, currentUser } from "@clerk/nextjs/server";
import { db } from "@/lib/db";
import { ensureTenant } from "./tenant";

const mocked = <T>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;
const users = db.user as unknown as Record<"findUnique" | "update" | "upsert", ReturnType<typeof vi.fn>>;
const orgs = db.org as unknown as Record<"findUnique" | "upsert", ReturnType<typeof vi.fn>>;

const ORG = { id: "org_1", name: "Acme", clerkOrgId: "org_clerk_1" };

function clerkUser(addresses: [string, string | null][], primary = addresses[0]?.[0]) {
  return {
    firstName: "Ada",
    lastName: null,
    primaryEmailAddress: primary ? { emailAddress: primary } : null,
    emailAddresses: addresses.map(([emailAddress, status]) => ({
      emailAddress,
      verification: status ? { status } : null,
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked(auth).mockResolvedValue({ userId: "user_1", orgId: "org_clerk_1", orgRole: "org:member" });
  mocked(clerkClient).mockResolvedValue({
    organizations: {
      getOrganization: vi.fn(async () => ({ name: "Acme" })),
      // A first sync asks Clerk whether the person is a member of the org now.
      getOrganizationMembershipList: vi.fn(async () => ({
        data: [{ role: "org:member", publicUserData: { userId: "user_1" } }],
      })),
    },
  });
  orgs.upsert.mockResolvedValue(ORG);
});

describe("a user's first sync", () => {
  beforeEach(() => {
    orgs.findUnique.mockResolvedValue(ORG);
    users.findUnique.mockResolvedValue(null);
  });

  it("stores true when Clerk verified the primary address", async () => {
    mocked(currentUser).mockResolvedValue(clerkUser([["ada@acme.test", "verified"]]));
    await ensureTenant();
    expect(users.upsert.mock.calls[0][0].create).toMatchObject({ email: "ada@acme.test", emailVerified: true });
    expect(users.upsert.mock.calls[0][0].update).toMatchObject({ email: "ada@acme.test", emailVerified: true });
  });

  it("stores false when the primary address is unverified, even if another is verified", async () => {
    mocked(currentUser).mockResolvedValue(
      clerkUser([
        ["ada@acme.test", "unverified"],
        ["ada@other.test", "verified"],
      ]),
    );
    await ensureTenant();
    expect(users.upsert.mock.calls[0][0].create).toMatchObject({ email: "ada@acme.test", emailVerified: false });
  });

  it("stores false for the no-email placeholder", async () => {
    mocked(currentUser).mockResolvedValue(clerkUser([]));
    await ensureTenant();
    expect(users.upsert.mock.calls[0][0].create).toMatchObject({
      email: "user_1@no-email.local",
      emailVerified: false,
    });
  });
});

describe("a user synced before verification was stored", () => {
  beforeEach(() => {
    orgs.findUnique.mockResolvedValue(ORG);
  });

  it("asks Clerk once and records the answer", async () => {
    users.findUnique.mockResolvedValue({ orgId: ORG.id, role: "member", email: "ada@acme.test", emailVerified: null });
    mocked(currentUser).mockResolvedValue(clerkUser([["ada@acme.test", "verified"]]));
    await ensureTenant();
    expect(users.update).toHaveBeenCalledWith({ where: { clerkId: "user_1" }, data: { emailVerified: true } });
  });

  it("stays unknown when Clerk cannot be asked", async () => {
    users.findUnique.mockResolvedValue({ orgId: ORG.id, role: "member", email: "ada@acme.test", emailVerified: null });
    mocked(currentUser).mockRejectedValue(new Error("clerk down"));
    await ensureTenant();
    expect(users.update).not.toHaveBeenCalled();
  });

  it("never asks Clerk again once verification is known", async () => {
    users.findUnique.mockResolvedValue({ orgId: ORG.id, role: "member", email: "ada@acme.test", emailVerified: false });
    await ensureTenant();
    expect(currentUser).not.toHaveBeenCalled();
    expect(users.update).not.toHaveBeenCalled();
  });
});
