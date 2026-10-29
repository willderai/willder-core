import { beforeEach, describe, expect, it, vi } from "vitest";

// GET/PATCH /api/settings/memory-chat: auth and role gating, org scoping, and how
// the name is normalized before memory chat reads it.
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    orgPreference: { findUnique: vi.fn(), upsert: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

import { requireAccessContext } from "@/lib/access-context";
import { db } from "@/lib/db";

import { GET, PATCH } from "./route";

const admin = {
  org: { id: "org_1" },
  user: { id: "user_42", role: "admin" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "admin" } },
};
const member = {
  ...admin,
  user: { ...admin.user, role: "member" },
  ctx: { ...admin.ctx, actor: { ...admin.ctx.actor, role: "member" } },
};

const patch = (body: unknown) =>
  new Request("http://t/api/settings/memory-chat", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(admin as never);
});

describe("GET /api/settings/memory-chat", () => {
  it("401 without access context", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null);
    expect((await GET(new Request("http://t"))).status).toBe(401);
  });

  it("returns the stored name", async () => {
    vi.mocked(db.orgPreference.findUnique).mockResolvedValue({ memoryChatName: "Jane" } as never);
    const res = await GET(new Request("http://t"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ memoryChatName: "Jane" });
  });

  it("returns null when the org has no preference row", async () => {
    vi.mocked(db.orgPreference.findUnique).mockResolvedValue(null);
    expect(await (await GET(new Request("http://t"))).json()).toEqual({ memoryChatName: null });
  });

  it("reads only the caller's org, and only the memory chat name", async () => {
    vi.mocked(db.orgPreference.findUnique).mockResolvedValue(null);
    await GET(new Request("http://t"));
    expect(db.orgPreference.findUnique).toHaveBeenCalledWith({
      where: { orgId: "org_1" },
      select: { memoryChatName: true },
    });
  });
});

describe("PATCH /api/settings/memory-chat", () => {
  it("401 without access context", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null);
    expect((await PATCH(patch({ memoryChatName: "x" }))).status).toBe(401);
  });

  it("403 for a member, and nothing is written", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(member as never);
    expect((await PATCH(patch({ memoryChatName: "x" }))).status).toBe(403);
    expect(db.orgPreference.upsert).not.toHaveBeenCalled();
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.auditLog.create).mock.calls[0][0].data).toMatchObject({
      actorId: "user_42",
      action: "access.refused",
      target: "org_org_1/settings:memory-chat:update",
      decision: "deny",
    });
  });

  it("400 on invalid JSON", async () => {
    expect((await PATCH(patch("{ bad json"))).status).toBe(400);
  });

  it("400 when memoryChatName is missing", async () => {
    expect((await PATCH(patch({ toneOverride: "warm" }))).status).toBe(400);
    expect(db.orgPreference.upsert).not.toHaveBeenCalled();
  });

  it("400 when memoryChatName is not a string or null", async () => {
    expect((await PATCH(patch({ memoryChatName: 42 }))).status).toBe(400);
  });

  it("400 when the name is longer than 100 characters", async () => {
    expect((await PATCH(patch({ memoryChatName: "a".repeat(101) }))).status).toBe(400);
    expect(db.orgPreference.upsert).not.toHaveBeenCalled();
  });

  it("trims the name and upserts it on the caller's org", async () => {
    vi.mocked(db.orgPreference.upsert).mockResolvedValue({ memoryChatName: "the Sales team" } as never);
    const res = await PATCH(patch({ memoryChatName: "  the Sales team  " }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ memoryChatName: "the Sales team" });
    expect(db.orgPreference.upsert).toHaveBeenCalledWith({
      where: { orgId: "org_1" },
      create: { orgId: "org_1", memoryChatName: "the Sales team" },
      update: { memoryChatName: "the Sales team" },
      select: { memoryChatName: true },
    });
  });

  it.each([[""], ["   "], [null]])("clears the name for %j", async (value) => {
    vi.mocked(db.orgPreference.upsert).mockResolvedValue({ memoryChatName: null } as never);
    await PATCH(patch({ memoryChatName: value }));
    expect(db.orgPreference.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { memoryChatName: null } }));
  });

  it("ignores retired drafting and cap fields sent alongside the name", async () => {
    vi.mocked(db.orgPreference.upsert).mockResolvedValue({ memoryChatName: "Jane" } as never);
    await PATCH(patch({ memoryChatName: "Jane", toneOverride: "warm", maxSendsPerDay: 5 }));
    expect(db.orgPreference.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { memoryChatName: "Jane" } }),
    );
  });
});
