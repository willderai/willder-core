// Exa — semantic web research. Surfaces recent news, funding, hiring, and product
// signals about a company as short summaries we fold into the memory episode.
// Returns a text block, or throws on a hard failure (orchestrator keeps the rest).
import Exa from "exa-js";

const MAX_RESULTS = 5;

export async function researchCompany(name: string, domain?: string): Promise<string> {
  const key = process.env.EXA_API_KEY;
  if (!key) throw new Error("EXA_API_KEY is not set");
  const exa = new Exa(key);

  const query =
    `Recent news, funding, hiring, partnerships, and product updates about ${name}` + (domain ? ` (${domain})` : "");

  const res = await exa.searchAndContents(query, {
    numResults: MAX_RESULTS,
    type: "auto",
    summary: true,
    text: { maxCharacters: 600 },
  });

  const items = (res.results ?? [])
    .map((r) => {
      const blurb = (r.summary || r.text || "").trim().replace(/\s+/g, " ");
      if (!blurb) return null;
      const date = r.publishedDate ? ` (${r.publishedDate.slice(0, 10)})` : "";
      return `- ${r.title ?? r.url}${date}: ${blurb}\n  ${r.url}`;
    })
    .filter(Boolean);

  if (items.length === 0) throw new Error(`Exa found no web signals for ${name}`);
  return `Recent web signals (Exa):\n${items.join("\n")}`;
}
