// A provider HTTP response built the way the provider sends it: a real
// `Response` with its status, headers and JSON body, so a parser under test
// sees the same `ok`, `status`, `headers` and error text it gets in production.
//
// When a read log is given, `json()` returns the body wrapped by
// `trackReads`, so the drift check sees which fields the parser read.

import { trackReads, type ReadLog } from "./read-tracker";

export interface ProviderResponseOptions {
  status?: number;
  headers?: Record<string, string>;
  /** Record the parser's field reads under `root` (an endpoint name). */
  track?: { root: string; log: ReadLog };
}

export function providerResponse(body: unknown, options: ProviderResponseOptions = {}): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const response = new Response(text, {
    status: options.status ?? 200,
    headers: { "content-type": "application/json; charset=utf-8", ...options.headers },
  });
  const { track } = options;
  if (track) {
    Object.defineProperty(response, "json", {
      value: async () => trackReads(JSON.parse(text), track.root, track.log),
    });
  }
  return response;
}

/** The URL a parser passed to `fetch`, however it passed it. */
export function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input;
  return new URL(typeof input === "string" ? input : input.url);
}
