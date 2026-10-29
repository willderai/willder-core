import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enrichOrganization, enrichPerson } from "./apollo";

// Apollo is a plain fetch wrapper; we stub global fetch to test request shaping,
// the labeled-block composition, and the error paths (no network).
const origFetch = globalThis.fetch;
const origKey = process.env.APOLLO_API_KEY;

const jsonResponse = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body }) as unknown as Response;

beforeEach(() => {
  process.env.APOLLO_API_KEY = "test-key";
  vi.restoreAllMocks();
});
afterEach(() => {
  globalThis.fetch = origFetch;
  process.env.APOLLO_API_KEY = origKey;
});

describe("enrichOrganization", () => {
  it("POSTs to /organizations/enrich with the domain + x-api-key, and labels the fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        organization: {
          name: "Acme",
          industry: "SaaS",
          estimated_num_employees: 200,
          short_description: "We build X",
          keywords: ["crm", "ai"],
        },
      }),
    );
    globalThis.fetch = fetchMock as never;

    const text = await enrichOrganization("acme.com");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/organizations/enrich");
    expect(String(url)).toContain("domain=acme.com");
    expect(init.method).toBe("POST");
    expect(init.headers["x-api-key"]).toBe("test-key");
    expect(text).toContain("Company firmographics (Apollo)");
    expect(text).toContain("Industry: SaaS");
    expect(text).toContain("Employees: 200");
    expect(text).toContain("Keywords: crm, ai");
  });

  it("throws on a non-OK response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}, false, 402)) as never;
    await expect(enrichOrganization("acme.com")).rejects.toThrow(/402/);
  });

  it("throws when Apollo returns no organization", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ organization: null })) as never;
    await expect(enrichOrganization("acme.com")).rejects.toThrow(/no organization/);
  });

  it("throws when the key is missing", async () => {
    delete process.env.APOLLO_API_KEY;
    await expect(enrichOrganization("acme.com")).rejects.toThrow(/APOLLO_API_KEY/);
  });
});

describe("enrichPerson", () => {
  it("POSTs to /people/match with the email and labels the profile", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        person: { name: "Jane", title: "VP Sales", organization: { name: "Acme" } },
      }),
    );
    globalThis.fetch = fetchMock as never;

    const text = await enrichPerson("jane@acme.com");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/people/match");
    expect(String(fetchMock.mock.calls[0][0])).toContain("email=jane%40acme.com");
    expect(text).toContain("Person profile (Apollo)");
    expect(text).toContain("Title: VP Sales");
    expect(text).toContain("Company: Acme");
  });
});
