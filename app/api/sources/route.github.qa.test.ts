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

// The GitHub branch of POST /api/sources. The connector module has its own
// unit tests; these pin the route's boundary: the pasted token is sealed and
// never forwarded in the sync event or echoed back, the repository is the
// row's identity, malformed input is refused before any write, and the scope
// write check still gates the connect.

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
vi.mock("@/services/memory/source-change-event", () => ({ recordSourceChange: vi.fn() }));
vi.mock("@/services/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/access")>();
  return { ...actual, check: vi.fn() };
});
vi.mock("@/lib/crypto", () => ({ sealSecret: vi.fn((v: unknown) => `sealed:${JSON.stringify(v)}`) }));

import { requireAccessContext } from "@/lib/access-context";
import { db } from "@/lib/db";
import { inngest } from "@/lib/inngest";
import { check } from "@/services/access";
import { sealSecret } from "@/lib/crypto";
import { POST } from "./route";

const TOKEN = "github_pat_qa_secret_value";

const rc = {
  org: { id: "org_1" },
  user: { id: "user_42" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "member" } },
};

function req(body: unknown) {
  return new Request("http://test/api/sources", { method: "POST", body: JSON.stringify(body) });
}

/** GitHub's answer to the connect's read of the repository itself. */
function gitHubAnswers(status: number, body: unknown) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

beforeEach(() => {
  vi.clearAllMocks();
  gitHubAnswers(200, { full_name: "acme/widgets", default_branch: "main" });
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
    id: "src_gh",
    type: "github",
    name: "acme/widgets",
    scopePath: "org_1.acme_widgets",
    status: "active",
  } as never);
});

afterEach(() => vi.unstubAllGlobals());

describe("POST /api/sources — github (verifier QA)", () => {
  it("seals the token, keys the row on owner/name, and never forwards or echoes the token", async () => {
    const res = await POST(req({ type: "github", repo: " acme/widgets ", token: TOKEN }));
    expect(res.status).toBe(201);
    expect(JSON.stringify(await res.json())).not.toContain(TOKEN);

    expect(vi.mocked(sealSecret)).toHaveBeenCalledWith({ token: TOKEN });
    const [[upsert]] = vi.mocked(db.source.upsert).mock.calls;
    expect(upsert.where).toEqual({
      orgId_type_externalId: { orgId: "org_1", type: "github", externalId: "acme/widgets" },
    });
    expect(upsert.create).toMatchObject({ type: "github", externalId: "acme/widgets", name: "acme/widgets" });
    expect(upsert.update).toMatchObject({ encryptedTokens: `sealed:${JSON.stringify({ token: TOKEN })}` });

    const [[event]] = vi.mocked(inngest.send).mock.calls as unknown as [[{ data: Record<string, unknown> }]];
    expect(event.data).toEqual({ sourceId: expect.any(String), orgId: "org_1", syncRequestId: expect.any(String) });
    expect(JSON.stringify(vi.mocked(inngest.send).mock.calls)).not.toContain(TOKEN);
  });

  it.each([
    [{ type: "github", token: TOKEN }, /repo \(owner\/name\) is required/],
    [{ type: "github", repo: "acme/widgets" }, /token is required/],
    [{ type: "github", repo: "acme/widgets", token: "   " }, /token is required/],
    [{ type: "github", repo: "https://github.com/acme/widgets", token: TOKEN }, /owner\/name/],
    [{ type: "github", repo: "acme/widgets/issues", token: TOKEN }, /owner\/name/],
    [{ type: "github", repo: ["acme/widgets"], token: TOKEN }, /repo \(owner\/name\) is required/],
  ])("400s before any write or sync on %j", async (body, message) => {
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(message);
    expect(vi.mocked(sealSecret)).not.toHaveBeenCalled();
    expect(vi.mocked(db.source.upsert)).not.toHaveBeenCalled();
    expect(vi.mocked(inngest.send)).not.toHaveBeenCalled();
  });

  // GitHub answers 404, not 403, to a token that cannot see a private
  // repository. Connected anyway, the source synced nothing and read as empty.
  it.each([
    [
      "a 404 (private, not granted)",
      400,
      404,
      { message: "Not Found" },
      /can't read acme\/widgets.*Grant the token access to acme\/widgets/,
    ],
    [
      "a permission 403",
      400,
      403,
      { message: "Resource not accessible by personal access token" },
      /can't read acme\/widgets/,
    ],
    [
      "an SSO 403",
      400,
      403,
      { message: "Resource protected by organization SAML enforcement." },
      /can't read acme\/widgets/,
    ],
    ["a 401 (rejected token)", 400, 401, { message: "Bad credentials" }, /rejected this token.*paste it again/],
    ["a rate limit", 502, 403, { message: "API rate limit exceeded for user ID 1." }, /did not answer.*Try again/],
    ["a 5xx", 502, 503, { message: "Service Unavailable" }, /did not answer.*Try again/],
  ])(
    "refuses a token GitHub answers with %s, creating, storing and syncing nothing",
    async (_case, status, gitHubStatus, body, message) => {
      gitHubAnswers(gitHubStatus, body);
      const res = await POST(req({ type: "github", repo: "acme/widgets", token: TOKEN }));
      expect(res.status).toBe(status);
      const json = await res.json();
      expect(json.error).toMatch(message);
      expect(JSON.stringify(json)).not.toContain(TOKEN);
      expect(vi.mocked(db.$transaction)).not.toHaveBeenCalled();
      expect(vi.mocked(db.source.upsert)).not.toHaveBeenCalled();
      expect(vi.mocked(inngest.send)).not.toHaveBeenCalled();
    },
  );

  it("403s a caller without memory.write on the target scope, storing and syncing nothing", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "no grant" } as never);
    const fetch = gitHubAnswers(200, { full_name: "acme/widgets" });
    const res = await POST(req({ type: "github", repo: "acme/widgets", token: TOKEN, scopePath: "org_1.eng" }));
    expect(res.status).toBe(403);
    // Authorized before GitHub is asked anything with the pasted token.
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.mocked(check)).toHaveBeenCalledWith(
      rc.ctx,
      expect.objectContaining({ action: "memory.write", scope: "org_1.eng" }),
    );
    expect(vi.mocked(db.source.upsert)).not.toHaveBeenCalled();
    expect(vi.mocked(inngest.send)).not.toHaveBeenCalled();
  });
});
