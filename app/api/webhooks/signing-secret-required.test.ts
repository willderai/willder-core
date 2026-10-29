/// <reference types="vite/client" />
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

// One rule for every webhook route, enforced by discovery rather than by a list:
// a route whose caller is an outside service must never answer 2xx when the
// secret it would verify the request with is absent. The per-route test files
// next to this one cover each route's specific behaviour; this one exists so a
// webhook route added later cannot ship without verification simply because
// nobody remembered to write that test.
//
// Each route is exercised with every environment variable it reads set to a
// placeholder EXCEPT the ones that name a signing secret, which are left empty.
// That is the dangerous configuration: the feature is switched on, but the
// request cannot be authenticated. Answering 2xx there means the payload was
// accepted unverified, or (for a sender like Stripe that retries only on a
// non-2xx) silently dropped.

const ROUTES = import.meta.glob<{ POST?: (req: Request) => Promise<Response> }>("./*/route.ts");

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

/** Env var names that hold the secret a request is verified against, including a
 * numbered extra one for a second endpoint (CLERK_WEBHOOK_SECRET_2). */
const SIGNING_SECRET = /(WEBHOOK|SIGNING|SIGNATURE)_(SECRET|KEY)(_\d+)?$/;

/** Env var names a source file reads directly. */
function envNamesIn(source: string): string[] {
  return [...source.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]);
}

/** The local modules a source file imports, resolved to files on disk. */
function localImports(source: string, fromDir: string): string[] {
  const specifiers = [...source.matchAll(/from\s+"((?:@\/|\.\.?\/)[^"]+)"/g)].map((m) => m[1]);
  const resolved: string[] = [];
  for (const spec of specifiers) {
    const base = spec.startsWith("@/") ? join(repoRoot, spec.slice(2)) : join(fromDir, spec);
    for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
      if (existsSync(candidate)) {
        resolved.push(candidate);
        break;
      }
    }
  }
  return resolved;
}

/**
 * The env vars that configure this route: everything its own source reads, plus
 * anything its provider owns that it reads through a helper (Stripe's secret key
 * lives in lib/stripe.ts, not in the route). Scoped to the provider's prefix so
 * unrelated infrastructure config is left exactly as the suite found it.
 */
function configuredEnvNames(routePath: string): string[] {
  const routeFile = join(here, routePath);
  const source = readFileSync(routeFile, "utf8");
  const prefix = routePath.split("/")[1].split("-")[0].toUpperCase();
  const names = new Set(envNamesIn(source));
  for (const dep of localImports(source, dirname(routeFile))) {
    for (const name of envNamesIn(readFileSync(dep, "utf8"))) {
      if (name.startsWith(`${prefix}_`)) names.add(name);
    }
  }
  return [...names];
}

function unsignedRequest(routePath: string): Request {
  return new Request(`http://localhost/api/webhooks/${routePath.split("/")[1]}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "probe", data: { object: {} } }),
  });
}

describe("every webhook route refuses when its signing secret is missing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const paths = Object.keys(ROUTES).sort();

  it("found the webhook routes to check", () => {
    // Guards against the glob silently matching nothing and the suite passing vacuously.
    expect(paths.length).toBeGreaterThanOrEqual(1);
  });

  it.each(paths)("%s does not return 2xx with no signing secret configured", async (routePath) => {
    for (const name of configuredEnvNames(routePath)) {
      vi.stubEnv(name, SIGNING_SECRET.test(name) ? "" : `placeholder-${name}`);
    }
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { POST } = await ROUTES[routePath]();
    expect(POST, `${routePath} exports no POST handler`).toBeTypeOf("function");

    const res = await POST!(unsignedRequest(routePath));

    const is2xx = res.status >= 200 && res.status < 300;
    expect(is2xx, `${routePath} answered ${res.status} to an unverifiable request`).toBe(false);
  });
});
