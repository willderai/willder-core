import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the exa-js default-export client (a class) so we test query shaping + result
// composition (no network). vi.hoisted shares the spy with the hoisted vi.mock
// factory; the default must be newable, hence a class.
const { searchAndContents } = vi.hoisted(() => ({ searchAndContents: vi.fn() }));
vi.mock("exa-js", () => ({
  default: class Exa {
    searchAndContents = searchAndContents;
  },
}));

import { researchCompany } from "./exa";

beforeEach(() => {
  process.env.EXA_API_KEY = "test-key";
  searchAndContents.mockReset();
});

describe("researchCompany", () => {
  it("queries with the company name + domain and composes title/date/blurb/url lines", async () => {
    searchAndContents.mockResolvedValue({
      results: [
        {
          title: "Acme raises $10M",
          url: "https://news/acme",
          publishedDate: "2026-05-01T00:00:00Z",
          summary: "Acme closed a Series A.",
        },
        { title: "No blurb", url: "https://x", text: "" }, // dropped: empty blurb
      ],
    });

    const text = await researchCompany("Acme", "acme.com");

    expect(searchAndContents).toHaveBeenCalledWith(
      expect.stringContaining("Acme"),
      expect.objectContaining({ numResults: 5, summary: true }),
    );
    expect(searchAndContents.mock.calls[0][0]).toContain("acme.com");
    expect(text).toContain("Recent web signals (Exa)");
    expect(text).toContain("Acme raises $10M (2026-05-01): Acme closed a Series A.");
    expect(text).toContain("https://news/acme");
    expect(text).not.toContain("No blurb");
  });

  it("throws when there are no usable results", async () => {
    searchAndContents.mockResolvedValue({ results: [] });
    await expect(researchCompany("Acme")).rejects.toThrow(/no web signals/);
  });

  it("throws when the key is missing", async () => {
    delete process.env.EXA_API_KEY;
    await expect(researchCompany("Acme")).rejects.toThrow(/EXA_API_KEY/);
  });
});
