import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the firecrawl default-export client (a class) so we test success/error
// mapping + the markdown clip, with no network. vi.hoisted shares the spy with the
// hoisted vi.mock factory; the default must be newable, hence a class.
const { scrapeUrl } = vi.hoisted(() => ({ scrapeUrl: vi.fn() }));
vi.mock("@mendable/firecrawl-js", () => ({
  default: class FirecrawlApp {
    scrapeUrl = scrapeUrl;
  },
}));

import { scrapeSite, siteUrl } from "./firecrawl";

beforeEach(() => {
  process.env.FIRECRAWL_API_KEY = "test-key";
  scrapeUrl.mockReset();
});

describe("siteUrl", () => {
  it("adds https:// when missing and leaves explicit URLs alone", () => {
    expect(siteUrl("acme.com")).toBe("https://acme.com");
    expect(siteUrl("http://acme.com")).toBe("http://acme.com");
    expect(siteUrl("https://acme.com")).toBe("https://acme.com");
  });
});

describe("scrapeSite", () => {
  it("returns labeled markdown on success", async () => {
    scrapeUrl.mockResolvedValue({ success: true, markdown: "We build great CRMs." });
    const text = await scrapeSite("https://acme.com");
    expect(scrapeUrl).toHaveBeenCalledWith(
      "https://acme.com",
      expect.objectContaining({ formats: ["markdown"], onlyMainContent: true }),
    );
    expect(text).toContain("Company website (Firecrawl, https://acme.com)");
    expect(text).toContain("We build great CRMs.");
  });

  it("clips very long markdown with an ellipsis", async () => {
    scrapeUrl.mockResolvedValue({ success: true, markdown: "x".repeat(5000) });
    const text = await scrapeSite("https://acme.com");
    expect(text.endsWith("…")).toBe(true);
    expect(text.length).toBeLessThan(4200); // header + 4000 clip + ellipsis
  });

  it("throws when Firecrawl reports failure", async () => {
    scrapeUrl.mockResolvedValue({ success: false, error: "blocked" });
    await expect(scrapeSite("https://acme.com")).rejects.toThrow(/blocked/);
  });

  it("throws when the content is empty", async () => {
    scrapeUrl.mockResolvedValue({ success: true, markdown: "   " });
    await expect(scrapeSite("https://acme.com")).rejects.toThrow(/no content/);
  });
});
