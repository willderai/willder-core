// Mocked end to end: needs no database; runs in every environment.
//
// GET /api/sources never returns a stored credential.
//
// The PostHog connector stores a real customer credential on `Source`
// (`encryptedTokens`, sealed by lib/crypto). `POST /api/sources` already pins
// that the connect response never carries the key back (route.test.ts: "The
// response never carries the key back, sealed or otherwise"). `GET
// /api/sources` had no equivalent pin, and it returns its rows to the caller
// verbatim — so what that row contains is decided entirely by the handler's
// `select`.
//
// Measured, not assumed: adding `encryptedTokens: true` to that `select` leaks
// the sealed credential to every caller who can list sources, and the whole
// suite stays green (43/43 passed with the field added). Nothing failed,
// because nothing was watching the select.
//
// So this asserts the shape rather than one field name: the query must use an
// explicit allowlist `select`, and every key in it must be a known non-secret
// column. A future field added to the Source model — credential-bearing or
// not — fails here until it is deliberately added to SAFE_SOURCE_FIELDS, and
// dropping the `select` entirely (returning the full row, `encryptedTokens`
// included) fails too.
import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@/services/memory/source-page", () => ({
  pageSourceIds: vi.fn(async () => ({ ids: ["src_1"], total: 1, count: 1 })),
  pageOfSource: vi.fn(),
}));
vi.mock("@/services/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/access")>();
  return { ...actual, check: vi.fn() };
});
vi.mock("@/lib/crypto", () => ({ sealSecret: vi.fn((v: unknown) => `sealed:${JSON.stringify(v)}`) }));

import { requireAccessContext } from "@/lib/access-context";
import { db } from "@/lib/db";
import { check } from "@/services/access";
import { GET } from "./route";

/** The first page, as the panels ask for it. */
const LIST = new Request("http://localhost/api/sources?page=1");

/** Every column `GET /api/sources` is allowed to hand a caller. Deliberately a
 *  list, not a denylist: a new secret-bearing column must be unable to reach a
 *  response just because nobody remembered to exclude it. */
const SAFE_SOURCE_FIELDS = [
  "id",
  "type",
  "externalId",
  "name",
  "scopePath",
  "status",
  "meta",
  "createdAt",
  "updatedAt",
  "_count",
];

const rc = {
  org: { id: "org_1" },
  user: { id: "user_42" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "member" } },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
  vi.mocked(check).mockResolvedValue({ allowed: true } as never);
  vi.mocked(db.source.findMany).mockResolvedValue([] as never);
});

describe("GET /api/sources credential exposure", () => {
  it("selects an explicit allowlist of non-secret columns, never the sealed credential", async () => {
    const res = await GET(LIST);
    expect(res.status).toBe(200);

    const [[args]] = vi.mocked(db.source.findMany).mock.calls as unknown as [[{ select?: Record<string, unknown> }]];
    // No `select` at all would return the whole row, encryptedTokens included.
    expect(args.select).toBeDefined();
    expect(Object.keys(args.select!).sort()).toEqual([...SAFE_SOURCE_FIELDS].sort());
    expect(args.select).not.toHaveProperty("encryptedTokens");
  });

  it("selects the same allowlist without a page, the API clients' read", async () => {
    const res = await GET(new Request("http://localhost/api/sources"));
    expect(res.status).toBe(200);
    const [[args]] = vi.mocked(db.source.findMany).mock.calls as unknown as [[{ select?: Record<string, unknown> }]];
    expect(Object.keys(args.select!).sort()).toEqual([...SAFE_SOURCE_FIELDS].sort());
  });

  it("scopes the listing to the caller's own org", async () => {
    await GET(LIST);
    const [[args]] = vi.mocked(db.source.findMany).mock.calls as unknown as [[{ where?: { orgId?: string } }]];
    expect(args.where?.orgId).toBe("org_1");
  });
});
