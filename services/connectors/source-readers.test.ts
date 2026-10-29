// Who each connector says can read a source at the source. The provider calls
// are stubbed at fetch; the mapping from provider answer to readers is real.
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

function stubFetch(...responses: { status: number; body: unknown }[]) {
  const fetch = vi.fn();
  for (const r of responses) {
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(r.body), { status: r.status }));
  }
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

async function readers() {
  return (await import("./source-readers")).readersAtSource;
}

describe("Drive", () => {
  it("maps a folder's sharing list, page by page", async () => {
    vi.stubEnv("GDRIVE_MOCK", "false");
    const fetch = stubFetch(
      {
        status: 200,
        body: {
          nextPageToken: "p2",
          permissions: [
            { type: "user", emailAddress: "ana@acme.test" },
            { type: "user", emailAddress: "gone@acme.test", deleted: true },
            { type: "group", emailAddress: "team@acme.test" },
          ],
        },
      },
      {
        status: 200,
        body: {
          permissions: [
            { type: "domain", domain: "acme.test", allowFileDiscovery: true },
            { type: "domain", domain: "link.test", allowFileDiscovery: false },
            { type: "anyone", allowFileDiscovery: false },
          ],
        },
      },
    );
    const result = await (await readers())({ type: "gdrive", externalId: "folder1", token: "t" });
    expect(result).toEqual({
      kind: "known",
      readers: [
        { kind: "email", email: "ana@acme.test" },
        { kind: "unmappable" },
        { kind: "unmappable" },
        { kind: "domain", domain: "acme.test" },
        { kind: "unmappable" },
        { kind: "unmappable" },
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("a discoverable public share is everyone", async () => {
    vi.stubEnv("GDRIVE_MOCK", "false");
    stubFetch({ status: 200, body: { permissions: [{ type: "anyone", allowFileDiscovery: true }] } });
    expect(await (await readers())({ type: "gdrive", externalId: "f", token: "t" })).toEqual({
      kind: "known",
      readers: [{ kind: "everyone" }],
    });
  });

  it("a refused or failed sharing-list read is unknown, never an empty list", async () => {
    vi.stubEnv("GDRIVE_MOCK", "false");
    stubFetch({ status: 403, body: { error: "insufficientPermissions" } });
    expect((await (await readers())({ type: "gdrive", externalId: "f", token: "t" })).kind).toBe("unknown");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect((await (await readers())({ type: "gdrive", externalId: "f", token: "t" })).kind).toBe("unknown");
  });

  it("fixture mode has no real sharing list, so it is unknown", async () => {
    vi.stubEnv("GDRIVE_MOCK", "true");
    expect((await (await readers())({ type: "gdrive", externalId: "f", token: "t" })).kind).toBe("unknown");
  });
});

describe("GitHub", () => {
  it("a public repository is readable by everyone", async () => {
    stubFetch({ status: 200, body: { private: false, visibility: "public" } });
    expect(await (await readers())({ type: "github", externalId: "acme/site", token: "t" })).toEqual({
      kind: "known",
      readers: [{ kind: "everyone" }],
    });
  });

  it("a private or internal repository is unknown", async () => {
    stubFetch({ status: 200, body: { private: true, visibility: "private" } });
    expect((await (await readers())({ type: "github", externalId: "acme/app", token: "t" })).kind).toBe("unknown");
    stubFetch({ status: 200, body: { private: false, visibility: "internal" } });
    expect((await (await readers())({ type: "github", externalId: "acme/app", token: "t" })).kind).toBe("unknown");
  });

  it("a failed visibility read is unknown", async () => {
    stubFetch({ status: 401, body: { message: "Bad credentials" } });
    expect((await (await readers())({ type: "github", externalId: "acme/app", token: "bad" })).kind).toBe("unknown");
  });
});

describe("connectors that cannot report readers", () => {
  it.each(["slack", "figma", "posthog"] as const)("%s is unknown", async (type) => {
    expect((await (await readers())({ type, externalId: "x" })).kind).toBe("unknown");
  });

  it("a website is public", async () => {
    expect(await (await readers())({ type: "website", externalId: "acme.test" })).toEqual({
      kind: "known",
      readers: [{ kind: "everyone" }],
    });
  });
});
