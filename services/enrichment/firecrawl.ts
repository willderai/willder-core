// Firecrawl — clean scrape of the company's own website (the horse's mouth: how
// they describe themselves, products, positioning). Returns trimmed markdown to
// fold into the memory episode, or throws on a hard failure.
import FirecrawlApp from "@mendable/firecrawl-js";

const MAX_CHARS = 4000; // keep the episode small; extraction cost scales with length

export async function scrapeSite(url: string): Promise<string> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY is not set");
  const app = new FirecrawlApp({ apiKey });

  const res = await app.scrapeUrl(url, { formats: ["markdown"], onlyMainContent: true });
  if (!res.success) throw new Error(`Firecrawl failed for ${url}: ${res.error ?? "unknown"}`);

  const markdown = (res.markdown ?? "").trim();
  if (!markdown) throw new Error(`Firecrawl returned no content for ${url}`);
  const clipped = markdown.length > MAX_CHARS ? `${markdown.slice(0, MAX_CHARS)}…` : markdown;
  return `Company website (Firecrawl, ${url}):\n${clipped}`;
}

/** Best-effort site URL from a domain. */
export const siteUrl = (domain: string): string => (/^https?:\/\//i.test(domain) ? domain : `https://${domain}`);
