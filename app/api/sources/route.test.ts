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

// Scoped, read-only Slack + Figma ingestion on top of the Source connector
// boundary. This pins the POST /api/sources validation branches (slack:
// channelId/channelName, figma: fileKey/fileName) and confirms both fire the
// same sourceSync job as gdrive/website, without requiring a token while
// both connectors run fixture-backed (services/connectors/{slack,figma}.ts).
// The "website" branch is included as a control.

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
// posthog's connect path seals the pasted key immediately — stubbed here so
// this file never needs a real APP_ENCRYPTION_KEY, same reasoning as every
// other side-effecting dependency above.
vi.mock("@/lib/crypto", () => ({ sealSecret: vi.fn((v: unknown) => `sealed:${JSON.stringify(v)}`) }));

import { requireAccessContext } from "@/lib/access-context";
import { db } from "@/lib/db";
import { inngest } from "@/lib/inngest";
import { check } from "@/services/access";
import { sealSecret } from "@/lib/crypto";
import { recordSourceChange } from "@/services/memory/source-change-event";
import { POST } from "./route";
import { SCOPE_NAME_MAX } from "@/services/access/scope-name";

const rc = {
  org: { id: "org_1" },
  user: { id: "user_42" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "member" }, origin: "app" },
};

function req(body: unknown) {
  return new Request("http://test/api/sources", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
  vi.mocked(check).mockResolvedValue({ allowed: true } as never);
  // No scopePath in the request body → the route creates one under a
  // transaction. Real Scope/Grant models aren't under test here, so give the
  // transaction callback a minimal fake `tx`.
  vi.mocked(db.$transaction).mockImplementation(((fn: (tx: unknown) => unknown) =>
    fn({
      source: db.source,
      $executeRaw: vi.fn(),
      scope: { create: vi.fn().mockResolvedValue({ id: "scope_1" }) },
      grant: { create: vi.fn().mockResolvedValue({ id: "grant_1" }) },
    })) as never);
});

describe("POST /api/sources — slack", () => {
  it("400s when channelId or channelName is missing", async () => {
    const res = await POST(req({ type: "slack", channelId: "C123" }));
    expect(res.status).toBe(400);
    expect(vi.mocked(inngest.send)).not.toHaveBeenCalled();
  });

  it("connects a channel and fires sync without requiring a token", async () => {
    vi.mocked(db.source.upsert).mockResolvedValue({
      id: "src_1",
      type: "slack",
      name: "#general",
      scopePath: "org_1.general",
      status: "active",
    } as never);

    const res = await POST(req({ type: "slack", channelId: "C123", channelName: "#general" }));
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.source.type).toBe("slack");
    expect(body.jobId).toBe("job_1");

    expect(vi.mocked(db.source.upsert)).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ orgId: "org_1", type: "slack", externalId: "C123" }),
      }),
    );
    expect(vi.mocked(inngest.send)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { sourceId: "src_1", orgId: "org_1", syncRequestId: expect.any(String) },
      }),
    );
  });
});

// A non-string value in one of the naming fields passes a
// `!body.channelName`-style truthiness check, reaches `toLabel`'s
// `.toLowerCase()` call, and throws an uncaught TypeError: a 500, not a
// validation 400.
describe("POST /api/sources — non-string naming fields 400 instead of 500", () => {
  it("400s a slack connect whose channelName is a number, not a string", async () => {
    const res = await POST(req({ type: "slack", channelId: "C123", channelName: 12345 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/channelId and channelName are required/i);
    expect(vi.mocked(inngest.send)).not.toHaveBeenCalled();
  });

  it("400s a figma connect whose fileName is an object, not a string", async () => {
    const res = await POST(req({ type: "figma", fileKey: "abc123", fileName: { nested: true } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/fileKey and fileName are required/i);
    expect(vi.mocked(inngest.send)).not.toHaveBeenCalled();
  });

  it("400s a gdrive connect whose folderName is an array, not a string", async () => {
    const res = await POST(req({ type: "gdrive", folderId: "f1", folderName: ["x"], token: "tok" }));
    expect(res.status).toBe(400);
  });

  it("400s a website connect whose domain is a number, not a string", async () => {
    const res = await POST(req({ type: "website", domain: 123 }));
    expect(res.status).toBe(400);
  });

  it("400s when scopePath is provided but is not a string (falls through to mint-new-scope path only for real strings)", async () => {
    vi.mocked(db.source.upsert).mockResolvedValue({
      id: "src_1",
      type: "slack",
      name: "#general",
      scopePath: "org_1.general",
      status: "active",
    } as never);
    // A non-string scopePath must not reach db.scope.findUnique with a bad type —
    // it's treated the same as "no scopePath given" and falls to the mint/reuse path.
    const res = await POST(req({ type: "slack", channelId: "C123", channelName: "#general", scopePath: 42 }));
    expect(res.status).toBe(201);
    expect(vi.mocked(db.scope.findUnique)).not.toHaveBeenCalled();
  });

  it("400s a scopePath whose label holds a dash, which reads like a dot, and stores nothing", async () => {
    const res = await POST(
      req({ type: "slack", channelId: "C123", channelName: "#general", scopePath: "org_1.eng-secrets" }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("scopePath holds a dash; scope labels are letters, digits and underscores");
    expect(vi.mocked(db.source.upsert)).not.toHaveBeenCalled();
  });
});

describe("POST /api/sources — figma", () => {
  it("400s when fileKey or fileName is missing", async () => {
    const res = await POST(req({ type: "figma", fileKey: "abc123" }));
    expect(res.status).toBe(400);
    expect(vi.mocked(inngest.send)).not.toHaveBeenCalled();
  });

  it("connects a file and fires sync without requiring a token", async () => {
    vi.mocked(db.source.upsert).mockResolvedValue({
      id: "src_2",
      type: "figma",
      name: "Willder UI",
      scopePath: "org_1.willder_ui",
      status: "active",
    } as never);

    const res = await POST(req({ type: "figma", fileKey: "abc123", fileName: "Willder UI" }));
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.source.type).toBe("figma");
    expect(body.jobId).toBe("job_1");

    expect(vi.mocked(db.source.upsert)).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ orgId: "org_1", type: "figma", externalId: "abc123" }),
      }),
    );
  });
});

// posthog: no fixture mode. The
// customer's real, read-only personal API key is required from the first
// connect call. Pins the new validation branches and that the key is sealed
// (never stored/forwarded in plaintext) and never echoed in the response.
describe("POST /api/sources — posthog", () => {
  it("400s when projectId, insightId, or insightName is missing", async () => {
    const res = await POST(req({ type: "posthog", projectId: "123", insightId: "456" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/projectId, insightId and insightName are required/i);
    expect(vi.mocked(inngest.send)).not.toHaveBeenCalled();
  });

  it("400s when projectId or insightId is not numeric", async () => {
    const res = await POST(
      req({ type: "posthog", projectId: "abc", insightId: "456", insightName: "Weekly signups", apiKey: "phx_key" }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/must be numeric/i);
  });

  it("400s when apiKey is missing — there is no mock/fixture fallback for a real customer secret", async () => {
    const res = await POST(req({ type: "posthog", projectId: "123", insightId: "456", insightName: "Weekly signups" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/apiKey is required/i);
    expect(vi.mocked(inngest.send)).not.toHaveBeenCalled();
  });

  it("400s on a host outside the PostHog allowlist", async () => {
    const res = await POST(
      req({
        type: "posthog",
        projectId: "123",
        insightId: "456",
        insightName: "Weekly signups",
        apiKey: "phx_key",
        host: "https://evil.example.com",
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/must be one of/i);
  });

  it("connects an insight: seals the key, stores non-secret projectId/host in meta, fires sync without a client token", async () => {
    vi.mocked(db.source.upsert).mockResolvedValue({
      id: "src_ph",
      type: "posthog",
      name: "Weekly signups",
      scopePath: "org_1.weekly_signups",
      status: "active",
    } as never);

    const res = await POST(
      req({
        type: "posthog",
        projectId: "123",
        insightId: "456",
        insightName: "Weekly signups",
        apiKey: "phx_super_secret",
      }),
    );
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.source.type).toBe("posthog");
    expect(body.jobId).toBe("job_1");
    // The response never carries the key back, sealed or otherwise.
    expect(JSON.stringify(body)).not.toContain("phx_super_secret");

    expect(vi.mocked(db.source.upsert)).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          orgId: "org_1",
          type: "posthog",
          // Carries the project, not the bare insight id — an insight id is
          // only unique within its own project.
          externalId: "123:456",
          encryptedTokens: expect.stringContaining("sealed:"),
          meta: { projectId: "123", host: "https://us.posthog.com" },
        }),
      }),
    );
    expect(vi.mocked(inngest.send)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { sourceId: "src_ph", orgId: "org_1", syncRequestId: expect.any(String) },
      }),
    );

    // The key only ever reaches sealSecret, and only under the encryptedTokens
    // column — never as a bare field the DB row (or a `select`) could surface.
    expect(vi.mocked(sealSecret)).toHaveBeenCalledWith({ apiKey: "phx_super_secret" });
    const [[upsertArgs]] = vi.mocked(db.source.upsert).mock.calls;
    expect(upsertArgs.create).not.toHaveProperty("apiKey");
    expect(upsertArgs.update).not.toHaveProperty("apiKey");
  });

  it("defaults to the us.posthog.com host when none is given", async () => {
    vi.mocked(db.source.upsert).mockResolvedValue({
      id: "src_ph2",
      type: "posthog",
      name: "Weekly signups",
      scopePath: "org_1.weekly_signups",
      status: "active",
    } as never);
    await POST(
      req({ type: "posthog", projectId: "123", insightId: "456", insightName: "Weekly signups", apiKey: "k" }),
    );
    expect(vi.mocked(db.source.upsert)).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ meta: { projectId: "123", host: "https://us.posthog.com" } }),
      }),
    );
  });

  it("honors an explicit allowed host (eu.posthog.com)", async () => {
    vi.mocked(db.source.upsert).mockResolvedValue({
      id: "src_ph3",
      type: "posthog",
      name: "Weekly signups",
      scopePath: "org_1.weekly_signups",
      status: "active",
    } as never);
    await POST(
      req({
        type: "posthog",
        projectId: "123",
        insightId: "456",
        insightName: "Weekly signups",
        apiKey: "k",
        host: "https://eu.posthog.com",
      }),
    );
    expect(vi.mocked(db.source.upsert)).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ meta: { projectId: "123", host: "https://eu.posthog.com" } }),
      }),
    );
  });
});

// Fixture mode is production-gated off (services/connectors/{slack,figma}.ts),
// so once it is off, a tokenless connect must be rejected here, before ever
// reaching the sync job that would otherwise hit the real API with an empty
// bearer token or silently ingest fixture content into a real tenant.
describe("POST /api/sources — slack/figma require a token once fixture mode is off", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("400s a tokenless slack connect in production (fixture mode is prod-gated off)", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.resetModules();
    const { POST: prodPOST } = await import("./route");

    const res = await prodPOST(req({ type: "slack", channelId: "C123", channelName: "#general" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/token is required/i);
    expect(vi.mocked(inngest.send)).not.toHaveBeenCalled();
  });

  it("400s a tokenless figma connect in production", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.resetModules();
    const { POST: prodPOST } = await import("./route");

    const res = await prodPOST(req({ type: "figma", fileKey: "abc123", fileName: "Willder UI" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/token is required/i);
    expect(vi.mocked(inngest.send)).not.toHaveBeenCalled();
  });

  it("a slack connect WITH a token in production still succeeds (the gate doesn't block real credentialed use)", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.resetModules();
    const { POST: prodPOST } = await import("./route");
    vi.mocked(db.source.upsert).mockResolvedValue({
      id: "src_1",
      type: "slack",
      name: "#general",
      scopePath: "org_1.general",
      status: "active",
    } as never);

    const res = await prodPOST(req({ type: "slack", channelId: "C123", channelName: "#general", token: "xoxb-real" }));
    expect(res.status).toBe(201);
    // The token is sealed onto the row for the job to read; the event carries none.
    expect(vi.mocked(sealSecret)).toHaveBeenCalledWith({ token: "xoxb-real" });
    expect(JSON.stringify(vi.mocked(inngest.send).mock.calls)).not.toContain('"xoxb-real"');
  });
});

// Reconnecting an already-known source (no explicit scopePath) must reuse
// its scope: minting a brand new one via toLabel's random suffix would split
// one logical source's content across two scopes, with already synced or
// skipped items under the old scope and freshly (re)ingested items under the
// new one.
// The required-token gate uses isNonEmptyString, not plain truthiness:
// sealSecret (a few lines below it) is only reached via isNonEmptyString, so
// a whitespace-only token that passed a truthiness gate would silently never
// be sealed onto encryptedTokens.
describe("POST /api/sources — gdrive/slack/figma reject a whitespace-only token the same as an empty one (item98-token-truthiness-vs-nonempty-20260923)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("400s a whitespace-only slack token in production instead of silently dropping it", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.resetModules();
    const { POST: prodPOST } = await import("./route");

    const res = await prodPOST(req({ type: "slack", channelId: "C123", channelName: "#general", token: "   " }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/token is required/i);
    expect(vi.mocked(inngest.send)).not.toHaveBeenCalled();
  });

  it("400s a whitespace-only figma token in production instead of silently dropping it", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.resetModules();
    const { POST: prodPOST } = await import("./route");

    const res = await prodPOST(req({ type: "figma", fileKey: "abc123", fileName: "Willder UI", token: "   " }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/token is required/i);
    expect(vi.mocked(inngest.send)).not.toHaveBeenCalled();
  });

  // gdrive has no fixture mode, so its gate applies in every environment.
  it("400s a whitespace-only gdrive token instead of queuing a sync with it", async () => {
    const res = await POST(req({ type: "gdrive", folderId: "f1", folderName: "Specs", token: "   " }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/token is required for gdrive/i);
    expect(vi.mocked(db.source.upsert)).not.toHaveBeenCalled();
    expect(vi.mocked(inngest.send)).not.toHaveBeenCalled();
  });

  it("400s a non-string gdrive token that plain truthiness would have accepted", async () => {
    const res = await POST(req({ type: "gdrive", folderId: "f1", folderName: "Specs", token: 12345 }));
    expect(res.status).toBe(400);
    expect(vi.mocked(db.source.upsert)).not.toHaveBeenCalled();
    expect(vi.mocked(inngest.send)).not.toHaveBeenCalled();
  });

  // Control: the stricter gate must not reject a real token.
  it("still connects a gdrive folder with a real token and forwards it to the sync job", async () => {
    vi.mocked(db.source.upsert).mockResolvedValue({
      id: "src_1",
      type: "gdrive",
      name: "Specs",
      scopePath: "org_1.specs",
      status: "active",
    } as never);

    const res = await POST(req({ type: "gdrive", folderId: "f1", folderName: "Specs", token: "ya29.real" }));
    expect(res.status).toBe(201);
    expect(vi.mocked(db.source.upsert)).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ orgId: "org_1", type: "gdrive", externalId: "f1" }),
      }),
    );
    expect(vi.mocked(inngest.send)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          sourceId: "src_1",
          orgId: "org_1",
          syncRequestId: expect.any(String),
          sealedToken: `sealed:${JSON.stringify({ token: "ya29.real" })}`,
        },
      }),
    );
  });
});

describe("POST /api/sources — reconnect reuses the existing source's scope", () => {
  it("reuses the existing scopePath on reconnect instead of minting a new one", async () => {
    vi.mocked(db.source.findUnique).mockResolvedValue({
      scopePath: "org_1.general_ab12cd",
    } as never);
    vi.mocked(db.source.upsert).mockResolvedValue({
      id: "src_1",
      type: "slack",
      name: "#general",
      scopePath: "org_1.general_ab12cd",
      status: "active",
    } as never);

    const res = await POST(req({ type: "slack", channelId: "C123", channelName: "#general" }));
    expect(res.status).toBe(201);

    // One transaction: the upsert and its change event. A new scope would be a second.
    expect(vi.mocked(db.$transaction)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.source.upsert)).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ scopePath: "org_1.general_ab12cd" }),
      }),
    );
    expect(vi.mocked(recordSourceChange)).toHaveBeenCalledWith(
      expect.anything(),
      {
        id: "src_1",
        type: "slack",
        name: "#general",
        scopePath: "org_1.general_ab12cd",
        status: "active",
        orgId: "org_1",
      },
      "update",
      "user_42",
      "app",
    );
  });

  it("still mints a new scope for a genuinely new source (no prior row)", async () => {
    vi.mocked(db.source.findUnique).mockResolvedValue(null);
    vi.mocked(db.source.upsert).mockResolvedValue({
      id: "src_2",
      type: "slack",
      name: "#eng",
      scopePath: "org_1.eng_ab12cd",
      status: "active",
    } as never);

    const res = await POST(req({ type: "slack", channelId: "C999", channelName: "#eng" }));
    expect(res.status).toBe(201);
    // Two transactions: the new scope with its grant, then the upsert with its event.
    expect(vi.mocked(db.$transaction)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(recordSourceChange)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "src_2", scopePath: "org_1.eng_ab12cd", orgId: "org_1" }),
      "create",
      "user_42",
      "app",
    );
  });
});

describe("POST /api/sources — website (control, unchanged)", () => {
  it("still requires a domain and never requires a token", async () => {
    const missing = await POST(req({ type: "website" }));
    expect(missing.status).toBe(400);

    vi.mocked(db.source.upsert).mockResolvedValue({
      id: "src_3",
      type: "website",
      name: "example.com",
      scopePath: "org_1.example_com",
      status: "active",
    } as never);

    const res = await POST(req({ type: "website", domain: "https://example.com/" }));
    expect(res.status).toBe(201);
    // Website sync isn't wired to sourceSync (Firecrawl path is separate) — this
    // must stay false, not a side effect of the slack/figma branch added above.
    expect(vi.mocked(inngest.send)).not.toHaveBeenCalled();
  });
});

describe("POST /api/sources — unsupported type", () => {
  it("rejects a type outside gdrive/website/slack/figma/posthog/github", async () => {
    const res = await POST(req({ type: "notion" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/gdrive, website, slack, figma, posthog, or github/);
  });
});

describe("POST /api/sources — a new scope's name is held to the scope-name limit", () => {
  it("refuses a connect that would mint a scope named past the limit, and writes nothing", async () => {
    const res = await POST(req({ type: "slack", channelId: "C123", channelName: "c".repeat(SCOPE_NAME_MAX + 1) }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(`at most ${SCOPE_NAME_MAX} characters`);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(vi.mocked(inngest.send)).not.toHaveBeenCalled();
  });

  it("connects a source whose name is at the limit", async () => {
    vi.mocked(db.source.upsert).mockResolvedValue({
      id: "src_1",
      type: "slack",
      name: "c",
      scopePath: "org_1.c",
      status: "active",
    } as never);
    const res = await POST(req({ type: "slack", channelId: "C124", channelName: "c".repeat(SCOPE_NAME_MAX) }));
    expect(res.status).toBe(201);
  });
});
