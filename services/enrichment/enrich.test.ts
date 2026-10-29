import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Unit-test the orchestrator's composition + resilience with the provider modules
// mocked (no network). The providers themselves are thin API wrappers tested live.
vi.mock("./apollo", () => ({ enrichOrganization: vi.fn(), enrichPerson: vi.fn() }));
vi.mock("./exa", () => ({ researchCompany: vi.fn() }));
vi.mock("./firecrawl", () => ({
  scrapeSite: vi.fn(),
  siteUrl: (d: string) => `https://${d}`,
}));

import { enrich } from "./index";
import { enrichOrganization, enrichPerson } from "./apollo";
import { researchCompany } from "./exa";
import { scrapeSite } from "./firecrawl";

const origApolloFlag = process.env.ENRICHMENT_APOLLO_ENABLED;
beforeEach(() => {
  vi.clearAllMocks();
  // Apollo is off by default (paid, per-credit). Tests that assert it ran opt in.
  process.env.ENRICHMENT_APOLLO_ENABLED = "1";
});
afterEach(() => {
  if (origApolloFlag === undefined) delete process.env.ENRICHMENT_APOLLO_ENABLED;
  else process.env.ENRICHMENT_APOLLO_ENABLED = origApolloFlag;
});

describe("enrich (account)", () => {
  it("runs apollo + firecrawl + exa and composes their blocks into one document", async () => {
    vi.mocked(enrichOrganization).mockResolvedValue("Company firmographics (Apollo):\n- Industry: SaaS");
    vi.mocked(scrapeSite).mockResolvedValue("Company website (Firecrawl, https://acme.com):\nWe build X");
    vi.mocked(researchCompany).mockResolvedValue("Recent web signals (Exa):\n- Raised $10M");

    const out = await enrich({ kind: "account", name: "Acme", domain: "acme.com" });

    expect(out.hasFindings).toBe(true);
    expect(out.results.every((r) => r.ok)).toBe(true);
    expect(out.content).toContain("Research findings for Acme (acme.com)");
    expect(out.content).toContain("Apollo");
    expect(out.content).toContain("Firecrawl");
    expect(out.content).toContain("Exa");
    expect(enrichOrganization).toHaveBeenCalledWith("acme.com");
    expect(scrapeSite).toHaveBeenCalledWith("https://acme.com");
  });

  it("records a provider failure but still ingests the others' findings", async () => {
    vi.mocked(enrichOrganization).mockRejectedValue(new Error("Apollo 402"));
    vi.mocked(scrapeSite).mockResolvedValue("Company website (Firecrawl): copy");
    vi.mocked(researchCompany).mockResolvedValue("Recent web signals (Exa): news");

    const out = await enrich({ kind: "account", name: "Acme", domain: "acme.com" });

    expect(out.hasFindings).toBe(true);
    const apollo = out.results.find((r) => r.provider === "apollo");
    expect(apollo).toMatchObject({ ok: false, error: "Apollo 402" });
    expect(out.content).toContain("Firecrawl");
    expect(out.content).not.toContain("firmographics");
  });

  it("hasFindings is false (empty content) when every provider fails", async () => {
    vi.mocked(enrichOrganization).mockRejectedValue(new Error("x"));
    vi.mocked(scrapeSite).mockRejectedValue(new Error("y"));
    vi.mocked(researchCompany).mockRejectedValue(new Error("z"));

    const out = await enrich({ kind: "account", name: "Acme", domain: "acme.com" });
    expect(out.hasFindings).toBe(false);
    expect(out.content).toBe("");
    expect(out.results).toHaveLength(3);
  });

  it("skips Apollo (records it, doesn't call it) when disabled — the default", async () => {
    delete process.env.ENRICHMENT_APOLLO_ENABLED; // off by default
    vi.mocked(scrapeSite).mockResolvedValue("Company website (Firecrawl): copy");
    vi.mocked(researchCompany).mockResolvedValue("Recent web signals (Exa): news");

    const out = await enrich({ kind: "account", name: "Acme", domain: "acme.com" });

    expect(enrichOrganization).not.toHaveBeenCalled();
    const apollo = out.results.find((r) => r.provider === "apollo");
    expect(apollo).toMatchObject({ ok: false, skipped: true });
    // The cheap providers still run and produce findings.
    expect(out.hasFindings).toBe(true);
    expect(out.content).toContain("Firecrawl");
    expect(out.content).toContain("Exa");
  });

  it("without a domain, only runs Exa (no firmographics/scrape)", async () => {
    vi.mocked(researchCompany).mockResolvedValue("Recent web signals (Exa): news");
    const out = await enrich({ kind: "account", name: "Acme" });
    expect(enrichOrganization).not.toHaveBeenCalled();
    expect(scrapeSite).not.toHaveBeenCalled();
    expect(researchCompany).toHaveBeenCalledWith("Acme", undefined);
    expect(out.hasFindings).toBe(true);
  });
});

describe("enrich (contact)", () => {
  it("matches the person by email via Apollo", async () => {
    vi.mocked(enrichPerson).mockResolvedValue("Person profile (Apollo):\n- Title: VP Sales");
    const out = await enrich({ kind: "contact", name: "Jane", email: "jane@acme.com" });
    expect(enrichPerson).toHaveBeenCalledWith("jane@acme.com");
    expect(out.content).toContain("Person profile");
    expect(out.hasFindings).toBe(true);
  });
});
