import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// No mock-mode suite here (unlike slack.test.ts/figma.test.ts) — posthog.ts
// has no fixture branch, so every test exercises the real fetch call against
// a stubbed global fetch.

describe("normalizePostHogHost", () => {
  it("accepts the known PostHog hosts", async () => {
    const { normalizePostHogHost } = await import("./posthog");
    expect(normalizePostHogHost("https://us.posthog.com")).toBe("https://us.posthog.com");
    expect(normalizePostHogHost("https://eu.posthog.com/")).toBe("https://eu.posthog.com");
  });

  it("rejects a host outside the allowlist", async () => {
    const { normalizePostHogHost } = await import("./posthog");
    expect(() => normalizePostHogHost("https://evil.example.com")).toThrow(/must be one of/i);
  });

  it("rejects a non-https URL, a path, or embedded credentials", async () => {
    const { normalizePostHogHost } = await import("./posthog");
    expect(() => normalizePostHogHost("http://us.posthog.com")).toThrow();
    expect(() => normalizePostHogHost("https://us.posthog.com/api")).toThrow();
    expect(() => normalizePostHogHost("https://user:pass@us.posthog.com")).toThrow();
  });
});

describe("fetchInsightSnapshot", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("fetches GET .../insights/:id/ with a bearer token, never a write or raw-event endpoint", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        name: "Weekly signups",
        description: "New orgs per week",
        result: [{ week: 1, count: 42 }],
        last_refresh: "2026-09-20T00:00:00.000Z",
      }),
    } as Response);

    const { fetchInsightSnapshot } = await import("./posthog");
    const items = await fetchInsightSnapshot("123", "456", "phx_real_key");

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toBe("https://us.posthog.com/api/projects/123/insights/456/");
    expect((init as RequestInit)?.method ?? "GET").toBe("GET");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer phx_real_key" });

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("insight-456");
    expect(items[0].author).toBe("PostHog");
    expect(items[0].createdAt).toBe("2026-09-20T00:00:00.000Z");
    expect(items[0].text).toContain("Weekly signups");
    expect(items[0].text).toContain("New orgs per week");
    expect(items[0].text).toContain("42");
  });

  it("never dumps a result past the size guard", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ name: "Huge", result: Array.from({ length: 10_000 }, (_, i) => ({ i })) }),
    } as Response);
    const { fetchInsightSnapshot } = await import("./posthog");
    const [item] = await fetchInsightSnapshot("1", "1", "k");
    expect(item.text.length).toBeLessThan(4_200);
  });

  it("produces a stable, content-derived checksum", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ name: "Same", result: 1 }),
    } as Response);
    const { fetchInsightSnapshot } = await import("./posthog");
    const [a] = await fetchInsightSnapshot("1", "1", "k");
    const [b] = await fetchInsightSnapshot("1", "1", "k");
    expect(a.checksum).toBe(b.checksum);
  });

  // The insight's own 404 cannot tell a deleted insight from a key that lost the
  // project; the project's answer can.
  it.each([
    ["answers", 200, "gone"],
    ["is not found", 404, "access lost"],
    ["is forbidden", 403, "access lost"],
    ["rejects the key", 401, "access lost"],
    ["fails", 502, "error"],
  ])("on an insight 404 whose project %s, reads it as %s", async (_case, projectStatus, outcome) => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false, status: 404, statusText: "Not Found", text: async () => "" } as Response)
      .mockResolvedValueOnce({
        ok: projectStatus === 200,
        status: projectStatus,
        json: async () => ({ id: 1 }),
        text: async () => "",
      } as Response);
    const { fetchInsightSnapshot } = await import("./posthog");
    const { SourceAccessError } = await import("./source-access");
    const snapshot = fetchInsightSnapshot("1", "1", "k");
    if (outcome === "gone") await expect(snapshot).resolves.toEqual([]);
    if (outcome === "access lost") await expect(snapshot).rejects.toThrow(SourceAccessError);
    if (outcome === "error") {
      await expect(snapshot).rejects.toThrow(/project check failed: 502/);
      await expect(snapshot).rejects.not.toThrow(SourceAccessError);
    }
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe("https://us.posthog.com/api/projects/1/");
  });

  it("reads a 403 for the insight itself as lost access, never as a deleted insight", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      text: async () => "You don't have access to the project.",
    } as Response);
    const { fetchInsightSnapshot } = await import("./posthog");
    const { SourceAccessError } = await import("./source-access");
    await expect(fetchInsightSnapshot("1", "1", "k")).rejects.toThrow(SourceAccessError);
  });

  it("returns an empty list when PostHog reports the insight deleted", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200, json: async () => ({ deleted: true }) } as Response);
    const { fetchInsightSnapshot } = await import("./posthog");
    await expect(fetchInsightSnapshot("1", "1", "k")).resolves.toEqual([]);
  });

  it("throws (never silently empties) on a real upstream failure — a bad/revoked key must not look like deletion", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "invalid key",
    } as Response);
    const { fetchInsightSnapshot } = await import("./posthog");
    await expect(fetchInsightSnapshot("1", "1", "bad_key")).rejects.toThrow(/401/);
  });

  it("throws on a 5xx instead of treating it as absence", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "",
    } as Response);
    const { fetchInsightSnapshot } = await import("./posthog");
    await expect(fetchInsightSnapshot("1", "1", "k")).rejects.toThrow();
  });

  it("requires an api key", async () => {
    const { fetchInsightSnapshot } = await import("./posthog");
    await expect(fetchInsightSnapshot("1", "1", "")).rejects.toThrow(/api key is required/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects non-numeric project or insight ids without ever calling PostHog", async () => {
    const { fetchInsightSnapshot } = await import("./posthog");
    await expect(fetchInsightSnapshot("not-a-number", "1", "k")).rejects.toThrow(/numeric/i);
    await expect(fetchInsightSnapshot("1", "not-a-number", "k")).rejects.toThrow(/numeric/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a disallowed host without ever calling fetch", async () => {
    const { fetchInsightSnapshot } = await import("./posthog");
    await expect(fetchInsightSnapshot("1", "1", "k", "https://evil.example.com")).rejects.toThrow(/must be one of/i);
    expect(fetch).not.toHaveBeenCalled();
  });
});
