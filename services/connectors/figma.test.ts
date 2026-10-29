import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Same discipline as slack.test.ts — mock-mode fixture stability plus
// a real-branch check that this is strictly a read (GET .../comments), never a
// POST of a new comment/reply.

describe("services/connectors/figma — mock mode (default)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("returns fixture comments with stable, content-derived checksums", async () => {
    const { listFileComments } = await import("./figma");
    const a = await listFileComments("file_any", "unused-token");
    const b = await listFileComments("file_any", "unused-token");

    expect(a.length).toBeGreaterThan(0);
    for (const c of a) {
      expect(typeof c.text).toBe("string");
      expect(c.text.length).toBeGreaterThan(0);
      expect(c.checksum).toBe(a.find((x) => x.id === c.id)?.checksum);
    }
    expect(a).toEqual(b);
  });

  it("respects the limit option", async () => {
    const { listFileComments } = await import("./figma");
    const comments = await listFileComments("file_any", "unused-token", { limit: 1 });
    expect(comments).toHaveLength(1);
  });
});

describe("services/connectors/figma — real branch (FIGMA_MOCK=false)", () => {
  beforeEach(() => {
    vi.stubEnv("FIGMA_MOCK", "false");
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("only calls GET .../comments, never posts a new comment", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        comments: [
          { id: "c1", message: "nice work", user: { handle: "alex" }, created_at: "2026-09-05T12:00:00.000Z" },
        ],
      }),
    } as Response);

    const { listFileComments } = await import("./figma");
    const comments = await listFileComments("file_1", "tok_real");

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain("/files/file_1/comments");
    expect((init as RequestInit)?.method ?? "GET").toBe("GET");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok_real" });

    expect(comments).toEqual([
      {
        id: "c1",
        text: "nice work",
        author: "alex",
        createdAt: "2026-09-05T12:00:00.000Z",
        checksum: expect.any(String),
      },
    ]);
  });

  it("throws on a non-ok response instead of returning an empty list silently", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      text: async () => "no access",
    } as Response);

    const { listFileComments } = await import("./figma");
    await expect(listFileComments("file_bad", "tok")).rejects.toThrow();
  });

  it("throws instead of calling the real API when no token is given", async () => {
    const { listFileComments } = await import("./figma");
    await expect(listFileComments("file_1", "")).rejects.toThrow(/token is required/i);
    expect(fetch).not.toHaveBeenCalled();
  });
});

// Same production gate as slack.ts — see its test file for the rule.
describe("services/connectors/figma — production gate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("FIGMA_MOCK is false in production even when the env var says otherwise", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("FIGMA_MOCK", "true");
    const { FIGMA_MOCK } = await import("./figma");
    expect(FIGMA_MOCK).toBe(false);
  });

  it("a tokenless call in production throws rather than returning fabricated fixture content", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubGlobal("fetch", vi.fn());
    const { listFileComments } = await import("./figma");
    await expect(listFileComments("file_1", "")).rejects.toThrow(/token is required/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("FIGMA_MOCK still defaults true outside production (existing local/dev/test behavior preserved)", async () => {
    const { FIGMA_MOCK } = await import("./figma");
    expect(FIGMA_MOCK).toBe(true);
  });
});
