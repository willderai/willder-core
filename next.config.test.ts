// Coverage for the one piece of next.config.ts that is computed rather than written
// out: the memory-service origin in the Content-Security-Policy connect-src.
//
// The config's CSP is otherwise a hand-maintained literal, and a wrong connect-src
// does not fail a build or any rendering test -- it fails in a browser, at runtime,
// as a blocked request. So the two failure modes worth pinning are the ones a reader
// cannot see by eye: a value that is not reduced to an origin (connect-src matches
// origins, so a path or trailing slash must not survive into the directive), and an
// `undefined` leaking into the directive when the variable is absent.
import { SITE_VIDEO_MEDIA_SRC } from "./lib/site-videos";
import { describe, expect, it } from "vitest";

import nextConfig, { memoryServiceOrigin, POSTHOG_API_HOST, POSTHOG_ASSETS_HOST, posthogRewrites } from "./next.config";

describe("memoryServiceOrigin", () => {
  it("reduces a URL to its origin, dropping path and trailing slash", () => {
    expect(memoryServiceOrigin("https://memory.example.com", false)).toBe("https://memory.example.com");
    expect(memoryServiceOrigin("https://memory.example.com/", false)).toBe("https://memory.example.com");
    expect(memoryServiceOrigin("https://memory.example.com/api/v1", false)).toBe("https://memory.example.com");
  });

  it("keeps a non-default port, which is part of the origin", () => {
    expect(memoryServiceOrigin("https://memory.example.com:8443/api", false)).toBe("https://memory.example.com:8443");
    expect(memoryServiceOrigin("http://localhost:8000", false)).toBe("http://localhost:8000");
  });

  it("returns nothing for a non-production build with the variable unset", () => {
    // Local and preview builds omit the entry rather than emitting `undefined`
    // into the directive, which would be a literal, meaningless CSP token.
    expect(memoryServiceOrigin(undefined, false)).toBeUndefined();
    expect(memoryServiceOrigin("", false)).toBeUndefined();
  });

  it("fails a production build with the variable unset, naming the variable", () => {
    expect(() => memoryServiceOrigin(undefined, true)).toThrow(/GRAPHITI_SERVICE_URL is not set/);
  });

  it("rejects a value that is not an absolute URL, naming the variable", () => {
    expect(() => memoryServiceOrigin("memory.example.com", false)).toThrow(/not an absolute URL/);
    expect(() => memoryServiceOrigin("/memory", true)).toThrow(/not an absolute URL/);
  });
});

describe("the assembled media-src directive", () => {
  it("is the one lib/site-videos.ts builds, so the hosted videos are allowed", async () => {
    const routes = await nextConfig.headers!();
    const directives = routes
      .flatMap((route) => route.headers)
      .filter((header) => header.key === "Content-Security-Policy")
      .flatMap((header) => header.value.split(";").map((part) => part.trim()));

    expect(directives.filter((directive) => directive.startsWith("media-src"))).toEqual([SITE_VIDEO_MEDIA_SRC]);
  });
});

describe("the assembled connect-src directive", () => {
  it("never contains the string 'undefined'", async () => {
    const routes = await nextConfig.headers!();
    const directives = routes
      .flatMap((route) => route.headers)
      .filter((header) => header.key === "Content-Security-Policy")
      .flatMap((header) => header.value.split(";").map((part) => part.trim()))
      .filter((directive) => directive.startsWith("connect-src"));

    expect(directives.length).toBeGreaterThan(0);
    for (const directive of directives) {
      expect(directive).not.toContain("undefined");
      expect(directive).toContain("'self'");
    }
  });
});

describe("the PostHog /ingest rewrites", () => {
  // Resolve a path the way Next.js does: first matching rule wins, :path* takes the rest.
  function resolve(rules: { source: string; destination: string }[], path: string): string | undefined {
    for (const rule of rules) {
      const prefix = rule.source.replace("/:path*", "");
      if (path === prefix || path.startsWith(`${prefix}/`)) {
        return rule.destination.replace(":path*", path.slice(prefix.length + 1));
      }
    }
    return undefined;
  }

  it("are the rewrites the config returns", async () => {
    const rewrites = await nextConfig.rewrites!();
    expect(rewrites).toEqual(posthogRewrites);
  });

  it("send the lazily loaded SDK bundles to PostHog's asset host", () => {
    for (const bundle of [
      "exception-autocapture",
      "web-vitals",
      "surveys",
      "dead-clicks-autocapture",
      "posthog-recorder",
      "array",
    ]) {
      expect(resolve(posthogRewrites, `/ingest/static/${bundle}.js`)).toBe(
        `https://us-assets.i.posthog.com/static/${bundle}.js`,
      );
    }
  });

  it("send remote config under /ingest/array to PostHog's asset host", () => {
    expect(resolve(posthogRewrites, "/ingest/array/phc_example/config.js")).toBe(
      "https://us-assets.i.posthog.com/array/phc_example/config.js",
    );
    expect(resolve(posthogRewrites, "/ingest/array/phc_example/config")).toBe(
      "https://us-assets.i.posthog.com/array/phc_example/config",
    );
  });

  it("list the rules most specific first, as PostHog's Next.js guide does", () => {
    expect(posthogRewrites.map((rule) => rule.source)).toEqual([
      "/ingest/static/:path*",
      "/ingest/array/:path*",
      "/ingest/:path*",
    ]);
  });

  it("send events, flags and replay to PostHog's ingestion host", () => {
    expect(resolve(posthogRewrites, "/ingest/e/")).toBe("https://us.i.posthog.com/e/");
    expect(resolve(posthogRewrites, "/ingest/flags/")).toBe("https://us.i.posthog.com/flags/");
    expect(resolve(posthogRewrites, "/ingest/s/")).toBe("https://us.i.posthog.com/s/");
  });

  it("use the i.posthog.com hosts, never the UI host or the unresolvable us-assets.posthog.com", () => {
    expect(POSTHOG_API_HOST).toBe("https://us.i.posthog.com");
    expect(POSTHOG_ASSETS_HOST).toBe("https://us-assets.i.posthog.com");
    for (const rule of posthogRewrites) {
      expect(new URL(rule.destination.replace(":path*", "x")).hostname).toMatch(/^us(-assets)?\.i\.posthog\.com$/);
    }
  });

  it("leave the unresolvable us-assets.posthog.com out of the CSP", async () => {
    const routes = await nextConfig.headers!();
    const csp = routes
      .flatMap((route) => route.headers)
      .find((header) => header.key === "Content-Security-Policy")!.value;
    expect(csp).not.toContain("us-assets.posthog.com");
  });
});
