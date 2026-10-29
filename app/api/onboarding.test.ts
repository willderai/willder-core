import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    orgPreference: { findUnique: vi.fn(), upsert: vi.fn() },
    account: { findFirst: vi.fn(), create: vi.fn() },
  },
}));
vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn().mockResolvedValue({}) }));
vi.mock("@/services/access", () => ({ check: vi.fn() }));

import { requireAccessContext } from "@/lib/access-context";
import { db } from "@/lib/db";
import { ingestMemory } from "@/lib/inngest";
import { check } from "@/services/access";
import { GET, POST } from "./onboarding/route";

const rc = {
  org: { id: "org_1", name: "Acme" },
  user: { id: "user_1", name: "Jane", email: "jane@acme.com" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_1", role: "admin" } },
};

function postReq(body: unknown) {
  return new Request("http://t/api/onboarding", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
  vi.mocked(db.orgPreference.upsert).mockResolvedValue({} as never);
  vi.mocked(db.orgPreference.findUnique).mockResolvedValue(null);
  vi.mocked(check).mockResolvedValue({ allowed: true, reason: "granted", auditLogId: "audit_1" } as never);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
});

// ---------------------------------------------------------------------------
// GET /api/onboarding
// ---------------------------------------------------------------------------

describe("GET /api/onboarding", () => {
  it("401 without access context", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it("done=false when no preference row exists", async () => {
    vi.mocked(db.orgPreference.findUnique).mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { done: boolean };
    expect(body.done).toBe(false);
  });

  it("done=false when onboardingDone is false", async () => {
    vi.mocked(db.orgPreference.findUnique).mockResolvedValue({ onboardingDone: false } as never);
    const body = (await (await GET()).json()) as { done: boolean };
    expect(body.done).toBe(false);
  });

  it("done=true when onboardingDone is true", async () => {
    vi.mocked(db.orgPreference.findUnique).mockResolvedValue({ onboardingDone: true } as never);
    const body = (await (await GET()).json()) as { done: boolean };
    expect(body.done).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/onboarding
// ---------------------------------------------------------------------------

describe("POST /api/onboarding", () => {
  it("401 without access context", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null);
    expect((await POST(postReq({}))).status).toBe(401);
  });

  it("403 without memory.write at the org root, before anything is written", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "no write grant" } as never);
    const res = await POST(postReq({ companyDescription: "We sell freight software." }));
    expect(res.status).toBe(403);
    expect(vi.mocked(check)).toHaveBeenCalledWith(rc.ctx, { action: "memory.write", target: "onboarding" });
    expect(vi.mocked(ingestMemory)).not.toHaveBeenCalled();
    expect(vi.mocked(db.orgPreference.upsert)).not.toHaveBeenCalled();
  });

  it("marks onboardingDone=true on empty submit (skip)", async () => {
    await POST(postReq({}));
    expect(vi.mocked(db.orgPreference.upsert)).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ onboardingDone: true }) }),
    );
  });

  it("ingests companyDescription as a memory episode", async () => {
    await POST(postReq({ companyDescription: "We sell widgets" }));
    expect(vi.mocked(ingestMemory)).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("We sell widgets") }),
    );
  });

  it("ingests icp and valueProp as separate episodes", async () => {
    await POST(postReq({ icp: "VP Sales", valueProp: "Save 60% time" }));
    const calls = vi.mocked(ingestMemory).mock.calls;
    expect(calls.some((c) => c[0].content.includes("VP Sales"))).toBe(true);
    expect(calls.some((c) => c[0].content.includes("Save 60% time"))).toBe(true);
  });

  it("saves tone to toneOverride in preferences", async () => {
    await POST(postReq({ tone: "warm and direct" }));
    expect(vi.mocked(db.orgPreference.upsert)).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ toneOverride: "warm and direct" }) }),
    );
  });

  it("does not ingest empty fields", async () => {
    await POST(postReq({ companyDescription: "", icp: "", valueProp: "" }));
    expect(vi.mocked(ingestMemory)).not.toHaveBeenCalled();
  });
});
