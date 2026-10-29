// Mocked end to end: needs no database; runs in every environment.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The connect's widening gate has its own tests (app/api/sources/route.widening.realdb.test.ts). Here the
// source reports no one beyond the scope, so these tests stay on what they cover.
vi.mock("@/services/connectors/source-readers", () => ({
  readersAtSource: vi.fn(async () => ({ kind: "known", readers: [{ kind: "everyone" }] })),
}));
vi.mock("@/services/access/source-widening", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/access/source-widening")>()),
  scopeAudience: vi.fn(async () => ({ people: [], agents: [] })),
}));

// The Slack/Figma token a connect supplies must be sealed onto the row.
//
// `POST /api/sources` requires the token in production; if it validated
// `body.token` and then let it fall out of scope, `encryptedTokens` would
// stay unset for every slack/figma connect. The FIRST sync would still work
// (the connect route forwards `body.token` straight into that sync's own
// Inngest event), but a customer's second, manual re-sync has no client-held
// token to resend and no stored one to fall back to, and
// app/api/sources/[id]/sync/route.ts would forward an empty string, throwing
// deep inside listChannelMessages/listFileComments. This pins that the token
// is actually sealed onto the row, matching what posthog's apiKey does.

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

function req(body: unknown) {
  return new Request("http://test/api/sources", { method: "POST", body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
  vi.mocked(check).mockResolvedValue({ allowed: true } as never);
  vi.mocked(db.source.findUnique).mockResolvedValue(null as never);
  vi.mocked(db.$transaction).mockImplementation(((fn: (tx: unknown) => unknown) =>
    fn({
      source: db.source,
      $executeRaw: vi.fn(),
      scope: { create: vi.fn().mockResolvedValue({ id: "scope_1" }) },
      grant: { create: vi.fn().mockResolvedValue({ id: "grant_1" }) },
    })) as never);
  vi.mocked(db.source.upsert).mockResolvedValue({
    id: "src_1",
    type: "slack",
    name: "#general",
    scopePath: "org_1.general",
    status: "active",
  } as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/sources — slack/figma token persistence", () => {
  it("seals a supplied slack token onto encryptedTokens, not just past validation", async () => {
    const res = await POST(req({ type: "slack", channelId: "C123", channelName: "#general", token: "xoxb-real" }));
    expect(res.status).toBe(201);

    expect(vi.mocked(db.source.upsert)).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ encryptedTokens: 'sealed:{"token":"xoxb-real"}' }),
        update: expect.objectContaining({ encryptedTokens: 'sealed:{"token":"xoxb-real"}' }),
      }),
    );
  });

  it("seals a supplied figma token the same way", async () => {
    vi.mocked(db.source.upsert).mockResolvedValue({
      id: "src_2",
      type: "figma",
      name: "Design System",
      scopePath: "org_1.design_system",
      status: "active",
    } as never);

    const res = await POST(req({ type: "figma", fileKey: "F123", fileName: "Design System", token: "figd-real" }));
    expect(res.status).toBe(201);

    expect(vi.mocked(db.source.upsert)).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ encryptedTokens: 'sealed:{"token":"figd-real"}' }),
      }),
    );
  });

  it("leaves encryptedTokens undefined (column untouched) when no token is supplied", async () => {
    // SLACK_MOCK is on outside production, so this is a legal tokenless dev connect.
    await POST(req({ type: "slack", channelId: "C123", channelName: "#general" }));

    expect(vi.mocked(db.source.upsert)).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ encryptedTokens: undefined }),
        update: expect.objectContaining({ encryptedTokens: undefined }),
      }),
    );
  });
});
