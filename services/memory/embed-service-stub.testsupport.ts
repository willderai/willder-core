// A fake for the memory service's embedding endpoints, for tests that store or read
// rows through PgvectorMemoryStore: POST /embed for one text, POST /embed-batch for many
// (services/memory/embedding-service.ts).
import { vi } from "vitest";

/**
 * Replace fetch with a memory service that embeds each text with `embed`. A text for
 * which `embed` returns null fails its request with a 503, as an overloaded service does.
 * Returns the texts of every request, in order.
 */
export function stubEmbedService(embed: (text: string) => number[] | null): { requests: string[][] } {
  const requests: string[][] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { text?: string; texts?: string[] };
      const texts = body.texts ?? [body.text!];
      requests.push(texts);
      const vectors = texts.map(embed);
      if (vectors.some((v) => v === null)) return new Response("unavailable", { status: 503 });
      const answer = new URL(url).pathname === "/embed-batch" ? { embeddings: vectors } : { embedding: vectors[0] };
      return new Response(JSON.stringify(answer), { status: 200 });
    }),
  );
  return { requests };
}
