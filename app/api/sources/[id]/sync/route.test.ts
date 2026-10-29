import { beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/sources/:id/sync: a stored token that cannot be unsealed is a 400,
// not an uncaught 500, and a website source never falls into the Drive branch.

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/access")>();
  return { ...actual, check: vi.fn() };
});
vi.mock("@/lib/inngest", () => ({
  SOURCE_SYNC_EVENT: "source/sync.requested",
  inngest: { send: vi.fn().mockResolvedValue({ ids: ["job_1"] }) },
}));
vi.mock("@/lib/db", () => ({
  db: { source: { findFirst: vi.fn() } },
}));
vi.mock("@/lib/crypto", () => ({
  unsealSecret: vi.fn(),
  sealSecret: vi.fn((v: Record<string, unknown>) => `sealed:${JSON.stringify(v)}`),
}));

import { requireAccessContext } from "@/lib/access-context";
import { db } from "@/lib/db";
import { check } from "@/services/access";
import { inngest } from "@/lib/inngest";
import { unsealSecret } from "@/lib/crypto";
import { POST } from "./route";

const rc = {
  org: { id: "org_1" },
  user: { id: "user_42" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "member" } },
};

function callSync(id: string, body?: unknown) {
  return POST(
    new Request(`http://test/api/sources/${id}/sync`, {
      method: "POST",
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
  vi.mocked(check).mockResolvedValue({ allowed: true } as never);
});

describe("POST /api/sources/:id/sync — a corrupt/rotated key 400s instead of 500 (item98-unsealsecret-uncaught-throw-500-20260923)", () => {
  it("400s with the same message as a missing stored token when unsealSecret throws", async () => {
    vi.mocked(db.source.findFirst).mockResolvedValue({
      id: "src_1",
      type: "slack",
      status: "active",
      encryptedTokens: "corrupted-ciphertext",
    } as never);
    vi.mocked(unsealSecret).mockImplementation(() => {
      throw new Error("Unsupported state or unable to authenticate data");
    });

    const res = await callSync("src_1");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/no stored token/i);
    expect(vi.mocked(inngest.send)).not.toHaveBeenCalled();
  });

  it("logs the unseal failure, since it is a server fault the 400 alone would hide", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("Unsupported state or unable to authenticate data");
    vi.mocked(db.source.findFirst).mockResolvedValue({
      id: "src_1",
      type: "slack",
      status: "active",
      encryptedTokens: "corrupted-ciphertext",
    } as never);
    vi.mocked(unsealSecret).mockImplementation(() => {
      throw failure;
    });

    const res = await callSync("src_1");
    expect(res.status).toBe(400);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/^\[sources\/sync\].*src_1/), failure);
    errorSpy.mockRestore();
  });

  it("does not log when a fresh request token means nothing is unsealed", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(db.source.findFirst).mockResolvedValue({
      id: "src_3",
      type: "slack",
      status: "active",
      encryptedTokens: "corrupted-ciphertext",
    } as never);

    const res = await callSync("src_3", { token: "xoxb-fresh" });
    expect(res.status).toBe(202);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("same 400 for figma", async () => {
    vi.mocked(db.source.findFirst).mockResolvedValue({
      id: "src_2",
      type: "figma",
      status: "active",
      encryptedTokens: "corrupted-ciphertext",
    } as never);
    vi.mocked(unsealSecret).mockImplementation(() => {
      throw new Error("APP_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)");
    });

    const res = await callSync("src_2");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/no stored token/i);
    expect(vi.mocked(inngest.send)).not.toHaveBeenCalled();
  });

  it("a fresh request token still bypasses the stored, corrupted one entirely", async () => {
    vi.mocked(db.source.findFirst).mockResolvedValue({
      id: "src_3",
      type: "slack",
      status: "active",
      encryptedTokens: "corrupted-ciphertext",
    } as never);

    const res = await callSync("src_3", { token: "xoxb-fresh" });
    expect(res.status).toBe(202);
    expect(vi.mocked(unsealSecret)).not.toHaveBeenCalled();
    expect(vi.mocked(inngest.send)).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ sealedToken: 'sealed:{"token":"xoxb-fresh"}' }) }),
    );
  });
});

describe("POST /api/sources/:id/sync — website is rejected explicitly (item98-sync-website-source-wrong-branch-20260923)", () => {
  it("400s a website source instead of silently routing it into the Drive branch", async () => {
    vi.mocked(db.source.findFirst).mockResolvedValue({
      id: "src_4",
      type: "website",
      status: "active",
      encryptedTokens: null,
    } as never);

    const res = await callSync("src_4");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/website sources are not syncable/i);
    expect(vi.mocked(inngest.send)).not.toHaveBeenCalled();
  });

  it("still fires the Drive branch normally for an actual gdrive source", async () => {
    vi.mocked(db.source.findFirst).mockResolvedValue({
      id: "src_5",
      type: "gdrive",
      status: "active",
      encryptedTokens: null,
    } as never);

    const res = await callSync("src_5", { token: "gdrive-tok" });
    expect(res.status).toBe(202);
    expect(vi.mocked(inngest.send)).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ sealedToken: 'sealed:{"token":"gdrive-tok"}' }) }),
    );
  });
});
