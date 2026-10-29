// Regression coverage for the Vercel Speed Insights integration in the root
// layout. This is deliberately a wiring test, not a rendering test:
// vitest runs in a `node` environment here (see vitest.config.ts), so there is
// no DOM to mount into, and the failure mode worth guarding against is not
// "the component renders wrong" anyway.
//
// The failure mode this exists for is SILENT LOSS OF TELEMETRY. `<SpeedInsights />`
// contributes nothing to the rendered page a human looks at, produces no output
// in any test, and breaks no build if it is dropped. So every one of these can
// happen and leave the whole suite green while the dashboard quietly goes empty:
//
//  1. A future refactor of app/layout.tsx removes the element (or moves it inside
//     a provider that early-returns) and nobody notices for weeks.
//  2. The import survives but the element does not — an import with no JSX usage
//     is dead code that collects no metrics, and eslint's unused-var rule is at a
//     documented 99-error baseline here, so it would not be the thing that flags it.
//  3. The specifier drifts to `@vercel/speed-insights/react`, which is a REAL
//     export that type-checks and builds cleanly, but is the framework-agnostic
//     entry: it does not do Next App Router route-parameterisation, so every
//     dynamic route reports as its raw resolved path (/briefs/abc123) instead of
//     its route pattern (/briefs/[id]), shattering the per-route aggregates that
//     are the entire point of the feature. A wrong-but-working import is exactly
//     the kind of thing a green build hides.
//  4. The dependency lands in devDependencies, where it type-checks and tests
//     fine locally and is then absent from the production install.
//
// Same spirit as scripts/build-script.test.ts's deployability assertion: an
// integration that is correct in source but not actually wired into what ships
// is worth its own explicit assertion, because no behavior test will catch it.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import nextConfig from "../next.config";

const repoRoot = resolve(__dirname, "..");
const layoutSource = readFileSync(resolve(repoRoot, "app/layout.tsx"), "utf8");
const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));

const PACKAGE = "@vercel/speed-insights";
const SPECIFIER = `${PACKAGE}/next`;

/** The import specifier layout.tsx actually uses for the Speed Insights package,
 * read out of the source rather than assumed, so assertion 3 above is testing the
 * real specifier and not a copy of itself. */
function importedSpecifier(): string | undefined {
  const match = layoutSource.match(/import\s*\{[^}]*\bSpeedInsights\b[^}]*\}\s*from\s*["']([^"']+)["']/);
  return match?.[1];
}

/** Strip comments so a commented-out element cannot pass for a mounted one.
 *
 * Matching `<SpeedInsights />` against raw source would let
 * `{/* <SpeedInsights /> *\/}` keep the suite green while the component is gone.
 *
 * Handles `/* *\/` blocks (which is also how JSX comments are written) and `//`
 * line comments, with the `:` guard so a `https://` inside a string literal is not
 * mistaken for the start of a comment. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Whether a layout source actually mounts the element, comments excluded. */
function mountsSpeedInsights(source: string): boolean {
  return /<SpeedInsights\s*\/>/.test(stripComments(source));
}

const liveLayout = stripComments(layoutSource);

/** JSX nesting depth of `<SpeedInsights />` relative to `<body>`, or null if absent.
 * 0 means a direct child of `<body>`; 1+ means wrapped in that many elements.
 *
 * "Appears after `</PostHogProvider>`" would pass with SpeedInsights nested inside
 * a later provider, so measure depth instead. */
function mountDepth(source: string): number | null {
  const region = stripComments(source).slice(stripComments(source).indexOf("<body"));
  const tag = /<(\/?)([A-Za-z][\w.]*)[^>]*?(\/?)>/g;
  let depth = -1; // <body> itself takes this to 0, so its children sit at 0.
  let m: RegExpExecArray | null;
  while ((m = tag.exec(region)) !== null) {
    const [, closing, name, selfClosing] = m;
    if (name === "SpeedInsights") return depth;
    if (selfClosing) continue;
    depth += closing ? -1 : 1;
  }
  return null;
}

describe("Vercel Speed Insights wiring", () => {
  it("declares the package as a runtime dependency, not a dev one", () => {
    // devDependencies are not installed by Vercel's production install, so this
    // is a deployability assertion, not a tidiness one.
    expect(pkg.dependencies?.[PACKAGE]).toBeTruthy();
    expect(pkg.devDependencies?.[PACKAGE]).toBeUndefined();
  });

  it("imports from the Next.js entry point, which is the one that parameterises routes", () => {
    expect(importedSpecifier()).toBe(SPECIFIER);
  });

  it("resolves that specifier against the installed package's real export map", () => {
    // Guards a specifier that looks right but is not actually exported — the
    // export map is the source of truth here, not our expectation of it.
    const require = createRequire(resolve(repoRoot, "package.json"));
    expect(() => require.resolve(SPECIFIER)).not.toThrow();
  });

  it("actually renders <SpeedInsights /> in the layout, not just imports it", () => {
    // The load-bearing one. An import with no JSX usage collects nothing.
    expect(mountsSpeedInsights(layoutSource)).toBe(true);
  });

  it("does not count a commented-out element as mounted", () => {
    // Guards the guard. Without this, the assertion above passes on a layout that
    // mounts nothing, which is precisely the regression it claims to catch.
    expect(mountsSpeedInsights("<body>{/* <SpeedInsights /> */}</body>")).toBe(false);
    expect(mountsSpeedInsights("<body>// <SpeedInsights />\n</body>")).toBe(false);
    expect(mountsSpeedInsights("<body><SpeedInsights /></body>")).toBe(true);
    // ...and that the ':' guard does not eat a real mount sitting near a URL.
    expect(mountsSpeedInsights('<body>{"https://x.dev"}<SpeedInsights /></body>')).toBe(true);
  });

  it("mounts it inside <body>, so it ships on every route the root layout wraps", () => {
    const body = liveLayout.slice(liveLayout.indexOf("<body"), liveLayout.lastIndexOf("</body>"));
    expect(body).not.toBe("");
    expect(body).toMatch(/<SpeedInsights\s*\/>/);
  });

  it("permits the dev script origin in the CSP, and not the dead intake one", async () => {
    // The CSP in next.config.ts is one long hand-maintained string with no test coverage of
    // its own, so an unrelated edit to it can silently re-block Speed Insights and
    // nothing anywhere goes red. In development the package loads
    // va.vercel-scripts.com/v1/speed-insights/script.debug.js, so dev needs it.
    // Production needs neither entry: with no dsn/basePath props the script-src
    // code path resolves to the same-origin /_vercel/speed-insights/script.js,
    // already covered by 'self'.
    //
    // vitals.vercel-insights.com (connect-src) is NOT needed in either environment,
    // per the installed package's dist and script.debug.js: the vitals beacon endpoint is `dataset.endpoint ||
    // (dsn ? <absolute vercel-insights.com URL> : "/_vercel/speed-insights/vitals")`,
    // and the package always sets dataset.endpoint to a same-origin relative path
    // up front, so the dsn branch (the only thing that produces that absolute URL)
    // is unreachable without a `dsn` prop, which willder's <SpeedInsights /> never
    // passes. In dev the debug script also just logs the beacon by default and
    // never sends it at all, unless `debug={false}` is passed, which it isn't.
    //
    // Read the directives out of the config's own computed headers, not out of its
    // source text: connect-src is assembled from an array now, so a source regex
    // matches nothing and the assertion silently passes on no value at all.
    const routes = await nextConfig.headers!();
    const policies = routes
      .flatMap((route) => route.headers)
      .filter((header) => header.key === "Content-Security-Policy")
      .map((header) => header.value);
    expect(policies.length).toBeGreaterThan(0);

    const directive = (policy: string, name: string) =>
      policy
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${name} `));

    for (const policy of policies) {
      expect(directive(policy, "script-src")).toContain("https://va.vercel-scripts.com");
      expect(directive(policy, "connect-src")).toBeDefined();
      expect(directive(policy, "connect-src")).not.toContain("vitals.vercel-insights.com");
    }
  });

  it("keeps it a direct child of <body>, outside every provider", () => {
    // If it were nested inside any provider, a provider that throws or early-returns
    // would silently take telemetry with it — the same blast-radius reasoning that
    // already puts <Analytics /> at this level.
    expect(mountDepth(layoutSource)).toBe(0);
    expect(liveLayout.slice(liveLayout.lastIndexOf("</PostHogProvider>"))).toMatch(/<Analytics\s*\/>/);
  });

  it("would reject a mount nested inside a provider, wherever that provider sits", () => {
    // Guards the guard, and specifically the case the old suffix check missed: a
    // provider introduced *after* PostHogProvider that swallows the element.
    expect(mountDepth("<body><SpeedInsights /></body>")).toBe(0);
    expect(mountDepth("<body><Provider><SpeedInsights /></Provider></body>")).toBe(1);
    expect(mountDepth("<body><PostHogProvider></PostHogProvider><New><SpeedInsights /></New></body>")).toBe(1);
    expect(mountDepth("<body><A><B><SpeedInsights /></B></A></body>")).toBe(2);
    expect(mountDepth("<body><Other /></body>")).toBeNull();
  });
});
