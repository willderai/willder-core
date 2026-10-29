// The signed-in browser over any fetch: the part of a Playwright BrowserContext the admin API uses
// (`ctx.request`), sending JSON or a multipart form. The local stack's harness and the database
// suites both use it, so it lives outside the test-only route table, which imports vitest.
//
// The one rule this file enforces: a request is sent exactly as a browser would send it, the
// multipart body encoded once with its content-length.
import type { BrowserContext } from "playwright";
import type { MultipartBody } from "./live-api";

/** The request options `adminApiWith` passes: a JSON body, or a multipart form. */
interface RequestOptions {
  data?: unknown;
  multipart?: MultipartBody["multipart"];
}

/**
 * A multipart form as a browser sends it: strings as fields, file parts as files, encoded
 * once so the request carries its `content-length`, which an upload route reads before the
 * body and refuses without.
 */
async function multipartRequest(multipart: MultipartBody["multipart"]): Promise<RequestInit> {
  const form = new FormData();
  for (const [name, value] of Object.entries(multipart)) {
    if (typeof value === "string") form.append(name, value);
    else form.append(name, new Blob([new Uint8Array(value.buffer)], { type: value.mimeType }), value.name);
  }
  const encoded = new Response(form);
  const body = await encoded.arrayBuffer();
  return {
    body,
    headers: { "content-type": encoded.headers.get("content-type") ?? "", "content-length": String(body.byteLength) },
  };
}

/**
 * The part of a Playwright BrowserContext the admin API uses (`ctx.request`), over `fetchImpl`.
 * Stands in for the signed-in browser `signIn` returns; the session itself is the mocked
 * access context.
 */
export function localBrowserContext(fetchImpl: typeof fetch): BrowserContext {
  const send = async (method: string, url: string, options?: RequestOptions) => {
    const res = await fetchImpl(url, {
      method,
      ...(options?.multipart !== undefined
        ? await multipartRequest(options.multipart)
        : options?.data === undefined
          ? {}
          : { body: JSON.stringify(options.data), headers: { "content-type": "application/json" } }),
    });
    const text = await res.text();
    return { status: () => res.status, json: async () => JSON.parse(text) as unknown, text: async () => text };
  };
  const request = {
    get: (url: string) => send("GET", url),
    delete: (url: string) => send("DELETE", url),
    post: (url: string, options?: RequestOptions) => send("POST", url, options),
    patch: (url: string, options?: RequestOptions) => send("PATCH", url, options),
    put: (url: string, options?: RequestOptions) => send("PUT", url, options),
  };
  return { request } as unknown as BrowserContext;
}
