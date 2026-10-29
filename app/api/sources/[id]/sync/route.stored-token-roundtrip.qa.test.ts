// Mocked end to end: needs no database; runs in every environment.
//
// The stored Slack/Figma token round trip: sealed on connect, unsealed on
// re-sync, inside one tenant.
//
// Two things the route's own tests leave open:
//
// 1. THE TENANT FILTER, and this is the one that matters. The sync route is
//    where a stored Slack/Figma credential gets decrypted, and its
//    `findFirst({ where: { id, orgId } })` is otherwise untested: a test that
//    hands the route a canned row rather than looking one up stays green when
//    `orgId` is dropped from that lookup, a real cross-tenant read of another
//    org's sealed token. The mock `db` below is instead a two-tenant table
//    that filters on whatever keys the `where` actually carries, so the same
//    mutation surfaces as what it is: another org's source answered with 202
//    and its credential unsealed.
//
// 2. The real `sealSecret`/`unsealSecret` pair never runs across these two
//    routes when each test stubs `@/lib/crypto` for its own half. The payload
//    KEY NAME is pinned by those stubs' literals, so this is the thinner of
//    the two gaps; what is left unexecuted is the composition itself, and the
//    plain property that what lands in the column is ciphertext rather than
//    the pasted token.
//
// It also holds the rule both routes share: a queued sync event never carries a
// token in clear. Inngest keeps every event outside the database, so the
// stored credential stays on the row and a client-supplied one travels sealed.
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

// A GitHub connect reads the repository with the pasted token first; that read has its own tests (route.github.qa.test.ts).
vi.mock("@/services/connectors/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/connectors/github")>()),
  assertRepositoryReadable: async () => undefined,
}));
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: vi.fn(() => false), per: { hour: 3600 } }));
vi.mock("@/lib/inngest", () => ({
  SOURCE_SYNC_EVENT: "source/sync.requested",
  inngest: { send: vi.fn().mockResolvedValue({ ids: ["job_1"] }) },
}));
vi.mock("@/services/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/access")>();
  return { ...actual, check: vi.fn() };
});

/** Rows the faithful `findFirst` below filters over: one source per tenant. */
type Row = { id: string; orgId: string; type: string; status: string; encryptedTokens: string | null };
const rows: Row[] = [];

vi.mock("@/lib/db", () => ({
  db: {
    source: {
      // Filters on whatever keys the caller's `where` actually carries, the
      // way Prisma does — NOT on a fixed (id, orgId) pair. A mock that always
      // demanded orgId would turn a dropped tenant filter into "no row found"
      // instead of the cross-tenant hit it really is, and the leak test would
      // then pass for the wrong reason.
      findFirst: vi.fn(
        async ({ where }: { where: Partial<Row> }) =>
          rows.find((r) => (Object.entries(where) as [keyof Row, Row[keyof Row]][]).every(([k, v]) => r[k] === v)) ??
          null,
      ),
      // The sync job's own credential read (loadScopedSourceCredential), same filter.
      findFirstOrThrow: vi.fn(async ({ where }: { where: Partial<Row> }) => {
        const row = rows.find((r) =>
          (Object.entries(where) as [keyof Row, Row[keyof Row]][]).every(([k, v]) => r[k] === v),
        );
        if (!row) throw new Error("no row");
        return row;
      }),
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn(),
    },
    scope: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(),
  },
}));
// The change-feed event is covered by its own tests; here it only has to not throw.
vi.mock("@/services/memory/source-change-event", () => ({ recordSourceChange: vi.fn() }));

import { requireAccessContext } from "@/lib/access-context";
import { db } from "@/lib/db";
import { inngest } from "@/lib/inngest";
import { check } from "@/services/access";
import { POST as connect } from "../../route";
import { POST as sync } from "./route";
import { slackOrFigmaToken, type SourceSyncInput } from "@/lib/inngest/connector-sync";

const ORG = "org_tenant_a";
const OTHER_ORG = "org_tenant_b";

function accessContextFor(orgId: string) {
  return {
    org: { id: orgId },
    user: { id: "user_42" },
    ctx: { orgId, actor: { type: "human", id: "user_42", role: "member" } },
  };
}

function syncRequest(id: string) {
  return sync(new Request(`http://test/api/sources/${id}/sync`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });
}

/** The data of the one sync event the route queued. */
function queuedEventData(): SourceSyncInput {
  expect(vi.mocked(inngest.send)).toHaveBeenCalledTimes(1);
  const [event] = vi.mocked(inngest.send).mock.calls[0] as unknown as [{ data: SourceSyncInput }];
  return event.data;
}

/** The token a connect request carries, as a customer would paste it. */
const PASTED_TOKEN = "xoxb-0000-not-a-real-slack-token";

beforeEach(() => {
  vi.clearAllMocks();
  rows.length = 0;
  vi.stubEnv("APP_ENCRYPTION_KEY", "a".repeat(64));
  vi.mocked(requireAccessContext).mockResolvedValue(accessContextFor(ORG) as never);
  vi.mocked(check).mockResolvedValue({ allowed: true } as never);
  vi.mocked(db.$transaction).mockImplementation(((fn: (tx: unknown) => unknown) =>
    fn({
      source: db.source,
      $executeRaw: vi.fn(),
      scope: { create: vi.fn().mockResolvedValue({ id: "scope_1" }) },
      grant: { create: vi.fn().mockResolvedValue({ id: "grant_1" }) },
    })) as never);
  vi.mocked(db.source.upsert).mockResolvedValue({
    id: "src_a",
    type: "slack",
    name: "#general",
    scopePath: `${ORG}.general`,
    status: "active",
  } as never);
});

/** Connect a slack source with a real token and return what was actually sealed. */
async function connectSlackAndReadSealedToken(): Promise<string> {
  const res = await connect(
    new Request("http://test/api/sources", {
      method: "POST",
      body: JSON.stringify({ type: "slack", channelId: "C123", channelName: "#general", token: PASTED_TOKEN }),
    }),
  );
  expect(res.status).toBe(201);
  const [{ create }] = vi.mocked(db.source.upsert).mock.calls[0] as [{ create: { encryptedTokens?: string } }];
  expect(create.encryptedTokens).toBeTypeOf("string");
  return create.encryptedTokens!;
}

describe("Slack re-sync — connect and sync agree on the sealed payload, with real crypto", () => {
  it("the stored value is ciphertext, not the pasted token", async () => {
    const sealed = await connectSlackAndReadSealedToken();
    expect(sealed).not.toContain(PASTED_TOKEN);
  });

  it("a later re-sync that carries no token queues no token, and the job opens the exact token the connect sealed", async () => {
    const sealed = await connectSlackAndReadSealedToken();
    rows.push({ id: "src_a", orgId: ORG, type: "slack", status: "active", encryptedTokens: sealed });
    vi.mocked(inngest.send).mockClear();

    const res = await syncRequest("src_a");

    expect(res.status).toBe(202);
    const data = queuedEventData();
    expect(data).toEqual({ sourceId: "src_a", orgId: ORG });
    expect(await slackOrFigmaToken({ id: "src_a", orgId: ORG }, data)).toBe(PASTED_TOKEN);
  });
});

describe("Slack re-sync — the stored credential stays inside its own tenant", () => {
  it("another org's source id is not reachable: 404, nothing unsealed, no job fired", async () => {
    const sealed = await connectSlackAndReadSealedToken();
    rows.push({ id: "src_b", orgId: OTHER_ORG, type: "slack", status: "active", encryptedTokens: sealed });
    vi.mocked(inngest.send).mockClear();

    const res = await syncRequest("src_b");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "source not found" });
    expect(vi.mocked(inngest.send)).not.toHaveBeenCalled();
  });

  it("the same id under the caller's own org is reachable, so the 404 above is the tenant filter", async () => {
    const sealed = await connectSlackAndReadSealedToken();
    rows.push({ id: "src_b", orgId: ORG, type: "slack", status: "active", encryptedTokens: sealed });
    vi.mocked(inngest.send).mockClear();

    const res = await syncRequest("src_b");

    expect(res.status).toBe(202);
  });
});

// ---------------------------------------------------------------------------
// A corrupt or wrongly keyed stored blob.
//
// The route's own test for the decrypt failure mocks `@/lib/crypto` and
// makes `unsealSecret` throw on command. That pins the route's handling of a
// throw, which is half the claim; it cannot show that a genuinely corrupt or
// wrongly-keyed stored blob is a throw in the first place rather than, say,
// garbage that decodes to an object with no `token`. The other half, seal a
// token then corrupt the stored ciphertext, is written here against the real
// sealSecret/unsealSecret pair, on top of the same connect-then-sync harness
// above.
// ---------------------------------------------------------------------------

/** Flip the last byte of a sealed blob: valid base64, failed GCM auth tag. */
function corruptCiphertext(sealed: string): string {
  const buf = Buffer.from(sealed, "base64");
  buf[buf.length - 1] ^= 0xff;
  return buf.toString("base64");
}

describe("Slack re-sync — a stored credential that will not decrypt", () => {
  it("a corrupt ciphertext answers 400, the same as having no stored token", async () => {
    const sealed = await connectSlackAndReadSealedToken();
    rows.push({
      id: "src_a",
      orgId: ORG,
      type: "slack",
      status: "active",
      encryptedTokens: corruptCiphertext(sealed),
    });
    vi.mocked(inngest.send).mockClear();

    const res = await syncRequest("src_a");

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no stored token/i);
    expect(vi.mocked(inngest.send)).not.toHaveBeenCalled();
  });

  it("a rotated APP_ENCRYPTION_KEY answers 400 too, not an uncaught throw", async () => {
    const sealed = await connectSlackAndReadSealedToken();
    rows.push({ id: "src_a", orgId: ORG, type: "slack", status: "active", encryptedTokens: sealed });
    // The blob is intact; the key that would open it is gone. This is the
    // rotation case, and it is the one a deploy can cause.
    vi.stubEnv("APP_ENCRYPTION_KEY", "b".repeat(64));
    vi.mocked(inngest.send).mockClear();

    const res = await syncRequest("src_a");

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no stored token/i);
    expect(vi.mocked(inngest.send)).not.toHaveBeenCalled();
  });

  it("an unreadable blob never reaches the sync job with an empty token", async () => {
    // The failure to prevent is a connector call made with "": assert on what
    // was sent, not only on the status code.
    const sealed = await connectSlackAndReadSealedToken();
    rows.push({
      id: "src_a",
      orgId: ORG,
      type: "slack",
      status: "active",
      encryptedTokens: corruptCiphertext(sealed),
    });
    vi.mocked(inngest.send).mockClear();

    await syncRequest("src_a");

    expect(vi.mocked(inngest.send)).not.toHaveBeenCalled();
  });

  it("a fresh token on the request still re-syncs a source whose stored blob is corrupt", async () => {
    // The recovery path the 400's own wording promises the user.
    const sealed = await connectSlackAndReadSealedToken();
    rows.push({
      id: "src_a",
      orgId: ORG,
      type: "slack",
      status: "active",
      encryptedTokens: corruptCiphertext(sealed),
    });
    vi.mocked(inngest.send).mockClear();

    const res = await sync(
      new Request("http://test/api/sources/src_a/sync", {
        method: "POST",
        body: JSON.stringify({ token: "xoxb-freshly-pasted" }),
      }),
      { params: Promise.resolve({ id: "src_a" }) },
    );

    expect(res.status).toBe(202);
    const data = queuedEventData();
    expect(JSON.stringify(data)).not.toContain("xoxb-freshly-pasted");
    expect(await slackOrFigmaToken({ id: "src_a", orgId: ORG }, data)).toBe("xoxb-freshly-pasted");
  });
});

describe("Re-sync — which source types the route will dispatch", () => {
  it("a website source is refused even when the caller supplies a token", async () => {
    // The PR's own test covers the bodyless call the UI would make. A website
    // source is mis-routed into the Drive branch by `sourceSync` whatever the
    // token is, so supplying one must not buy a way past the new check.
    rows.push({ id: "src_w", orgId: ORG, type: "website", status: "active", encryptedTokens: null });
    vi.mocked(inngest.send).mockClear();

    const res = await sync(
      new Request("http://test/api/sources/src_w/sync", {
        method: "POST",
        body: JSON.stringify({ token: "some-token" }),
      }),
      { params: Promise.resolve({ id: "src_w" }) },
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/website sources are not syncable/i);
    expect(vi.mocked(inngest.send)).not.toHaveBeenCalled();
  });

  it("a posthog source still dispatches with no token, which the website check must not disturb", async () => {
    // posthog is in TEXT_SOURCE_TYPES and reads its own sealed key inside
    // sourceSync, so it is the one type that legitimately syncs with no token
    // on the request and none resolved here. Nothing in this PR tests it.
    rows.push({ id: "src_p", orgId: ORG, type: "posthog", status: "active", encryptedTokens: "sealed-elsewhere" });
    vi.mocked(inngest.send).mockClear();

    const res = await syncRequest("src_p");

    expect(res.status).toBe(202);
    expect(vi.mocked(inngest.send)).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ sourceId: "src_p" }) }),
    );
  });
});

/** Any connector credential's own prefix: Slack, Figma, Google OAuth, GitHub, PostHog. */
const TOKEN_SHAPED = /xox[abposr]-|figd_|ya29\.|gh[pousr]_|github_pat_|ph[xc]_/;

/** Every event both routes queued, as Inngest would store it. */
function queuedEventsText(): string {
  return JSON.stringify(vi.mocked(inngest.send).mock.calls);
}

describe("No sync event carries a token in clear", () => {
  it.each([
    ["gdrive", { type: "gdrive", folderId: "f1", folderName: "Specs", token: "ya29.not-a-real-google-token" }],
    ["slack", { type: "slack", channelId: "C123", channelName: "#general", token: "xox" + "b-not-a-real-slack-token" }],
    ["figma", { type: "figma", fileKey: "fk1", fileName: "Designs", token: "figd_not-a-real-figma-token" }],
    [
      "posthog",
      { type: "posthog", projectId: "1", insightId: "2", insightName: "Signups", apiKey: "phx_not-a-real-posthog-key" },
    ],
    ["github", { type: "github", repo: "acme/widgets", token: "github_pat_not-a-real-github-token" }],
  ])("a %s connect queues its sync with no token-shaped value", async (_type, body) => {
    const res = await connect(new Request("http://test/api/sources", { method: "POST", body: JSON.stringify(body) }));

    expect(res.status).toBe(201);
    expect(vi.mocked(inngest.send)).toHaveBeenCalledTimes(1);
    expect(queuedEventsText()).not.toMatch(TOKEN_SHAPED);
  });

  it.each([
    ["gdrive", "ya29.not-a-real-google-token"],
    ["slack", "xox" + "b-not-a-real-slack-token"],
    ["figma", "figd_not-a-real-figma-token"],
  ])("a %s re-sync with a fresh token on the request queues it sealed", async (type, token) => {
    rows.push({ id: "src_f", orgId: ORG, type, status: "active", encryptedTokens: null });

    const res = await sync(
      new Request("http://test/api/sources/src_f/sync", { method: "POST", body: JSON.stringify({ token }) }),
      { params: Promise.resolve({ id: "src_f" }) },
    );

    expect(res.status).toBe(202);
    expect(queuedEventsText()).not.toMatch(TOKEN_SHAPED);
    expect(queuedEventData().sealedToken).toEqual(expect.any(String));
  });

  it("a slack re-sync on its stored token queues no token at all", async () => {
    rows.push({
      id: "src_s",
      orgId: ORG,
      type: "slack",
      status: "active",
      encryptedTokens: await connectSlackAndReadSealedToken(),
    });
    vi.mocked(inngest.send).mockClear();

    expect((await syncRequest("src_s")).status).toBe(202);
    expect(queuedEventsText()).not.toMatch(TOKEN_SHAPED);
    expect(queuedEventData()).toEqual({ sourceId: "src_s", orgId: ORG });
  });
});

describe("The sync job reads a stored Slack/Figma credential only inside its own tenant", () => {
  it("another org's source id, under this org's event, opens nothing", async () => {
    rows.push({
      id: "src_b",
      orgId: OTHER_ORG,
      type: "slack",
      status: "active",
      encryptedTokens: await connectSlackAndReadSealedToken(),
    });

    await expect(slackOrFigmaToken({ id: "src_b", orgId: ORG }, { sourceId: "src_b", orgId: ORG })).rejects.toThrow();
  });
});
