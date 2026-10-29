// Mocked end to end: needs no database; runs in every environment.

import { beforeEach, describe, expect, it, vi } from "vitest";

// QA — item98-resync-broken-production-20260923. A Slack/Figma re-sync used
// to forward `body.token ?? ""` straight to the sync job with no fallback,
// so once the client's own one-time token was gone (there is no OAuth flow
// yet to reissue one), every manual re-sync sent an empty string into
// listChannelMessages/listFileComments, which throw on it in production.
// This pins that the route now falls back to the token sealed at connect
// time (app/api/sources/route.ts), and refuses to fire a job with neither.

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
  unsealSecret: vi.fn((sealed: string) => JSON.parse(sealed.replace(/^sealed:/, ""))),
  sealSecret: vi.fn((value: Record<string, unknown>) => `sealed:${JSON.stringify(value)}`),
}));

import { requireAccessContext } from "@/lib/access-context";
import { db } from "@/lib/db";
import { check } from "@/services/access";
import { inngest } from "@/lib/inngest";
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

describe("POST /api/sources/:id/sync — slack/figma token fallback", () => {
  it("re-syncs on the token stored at connect time, leaving it on the row for the job", async () => {
    vi.mocked(db.source.findFirst).mockResolvedValue({
      id: "src_1",
      type: "slack",
      status: "active",
      encryptedTokens: 'sealed:{"token":"xoxb-stored"}',
    } as never);

    const res = await callSync("src_1");
    expect(res.status).toBe(202);
    expect(vi.mocked(inngest.send)).toHaveBeenCalledWith({
      name: "source/sync.requested",
      data: { sourceId: "src_1", orgId: expect.any(String) },
    });
  });

  it("prefers a fresh request token over the stored one", async () => {
    vi.mocked(db.source.findFirst).mockResolvedValue({
      id: "src_1",
      type: "figma",
      status: "active",
      encryptedTokens: 'sealed:{"token":"figd-stored"}',
    } as never);

    const res = await callSync("src_1", { token: "figd-fresh" });
    expect(res.status).toBe(202);
    expect(vi.mocked(inngest.send)).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ sealedToken: 'sealed:{"token":"figd-fresh"}' }) }),
    );
  });

  it("400s instead of firing a job with an empty token when nothing is stored either", async () => {
    vi.mocked(db.source.findFirst).mockResolvedValue({
      id: "src_1",
      type: "slack",
      status: "active",
      encryptedTokens: null,
    } as never);

    const res = await callSync("src_1");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/no stored token/i);
    expect(vi.mocked(inngest.send)).not.toHaveBeenCalled();
  });

  it("posthog needs no token here at all — the job still fires, carrying none", async () => {
    vi.mocked(db.source.findFirst).mockResolvedValue({
      id: "src_1",
      type: "posthog",
      status: "active",
      encryptedTokens: 'sealed:{"apiKey":"phx_real"}',
    } as never);

    const res = await callSync("src_1");
    expect(res.status).toBe(202);
    expect(vi.mocked(inngest.send)).toHaveBeenCalledWith(
      expect.objectContaining({ data: { sourceId: "src_1", orgId: expect.any(String) } }),
    );
  });

  it("still requires a fresh token for gdrive — no fallback exists for it", async () => {
    vi.mocked(db.source.findFirst).mockResolvedValue({
      id: "src_1",
      type: "gdrive",
      status: "active",
      encryptedTokens: null,
    } as never);

    const res = await callSync("src_1");
    expect(res.status).toBe(400);
    expect(vi.mocked(inngest.send)).not.toHaveBeenCalled();
  });
});
