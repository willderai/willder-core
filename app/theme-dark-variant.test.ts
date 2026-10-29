// Regression coverage for the in-app light/dark toggle actually driving Tailwind's
// `dark:` utilities.
//
// next-themes is configured with `attribute="class"`, so it writes a literal
// `.dark` / `.light` class onto <html>. Tailwind v4's `dark:` variant, however,
// defaults to `@media (prefers-color-scheme: dark)` — it does not look at that
// class unless the stylesheet redefines the variant. Without the redefinition
// every `dark:` utility silently tracks the operating system instead of the
// toggle, which is what made the header wordmark disappear: components/marks.tsx
// swaps `hidden dark:block` / `block dark:hidden` between a light-on-dark and a
// dark-on-light lockup, so whenever the OS and the site disagreed about the theme
// the wrong lockup rendered and washed out against the background.
//
// The guard is the compiled CSS rather than the source text, because the source
// line is only a claim about what Tailwind will emit. These tests compile
// app/globals.css with the same Tailwind version the build uses and assert what
// the `dark:` variant actually resolves against.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const repoRoot = resolve(__dirname, "..");
const globalsPath = resolve(repoRoot, "app/globals.css");

/** The wordmark swap in components/marks.tsx — the utilities this bug was seen through. */
const WORDMARK_UTILITIES = ["dark:block", "dark:hidden"];

const CUSTOM_VARIANT_LINE = /^@custom-variant\s+dark\s*\(.*\);\s*$/m;

/**
 * Compiles app/globals.css, optionally with the `dark` variant override removed,
 * and returns the CSS emitted for the wordmark's utilities.
 */
async function compileGlobals({ withDarkVariant }: { withDarkVariant: boolean }) {
  let css = readFileSync(globalsPath, "utf8");
  if (!withDarkVariant) css = css.replace(CUSTOM_VARIANT_LINE, "");

  const compiler = await compile(css, {
    base: dirname(globalsPath),
    loadStylesheet: async (id, basedir) => {
      // The only import app/globals.css makes is `tailwindcss` itself.
      const path = id === "tailwindcss" ? require.resolve("tailwindcss/index.css") : resolve(basedir, id);
      return { path, base: dirname(path), content: readFileSync(path, "utf8") };
    },
  });

  return compiler.build(WORDMARK_UTILITIES);
}

/** The compiled `dark:block` rule, which carries whatever condition gates it. */
function darkBlockRule(css: string) {
  const index = css.indexOf(".dark\\:block");
  expect(index, "compiled CSS should contain a dark:block rule").toBeGreaterThan(-1);
  return css.slice(index, index + 200);
}

describe("the dark: variant follows the in-app theme toggle", () => {
  it("resolves dark: utilities against the .dark class next-themes writes", async () => {
    const css = await compileGlobals({ withDarkVariant: true });
    expect(darkBlockRule(css)).toMatch(/:where\(\.dark,\s*\.dark \*\)/);
  });

  it("does not leave dark: utilities gated on the operating system preference", async () => {
    const css = await compileGlobals({ withDarkVariant: true });
    expect(darkBlockRule(css)).not.toMatch(/prefers-color-scheme/);
  });

  // The inverse of the two assertions above, compiled from the same file with the
  // override removed. It is what makes them meaningful: it reproduces the original
  // bug and proves these tests fail when the fix is absent rather than passing for
  // an unrelated reason.
  it("reproduces the original bug when the variant override is removed", async () => {
    const rule = darkBlockRule(await compileGlobals({ withDarkVariant: false }));
    expect(rule).toMatch(/prefers-color-scheme:\s*dark/);
    expect(rule).not.toMatch(/:where\(\.dark,\s*\.dark \*\)/);
  });

  // A forward guard, not a differential: this passes on main today. The variant
  // override is only correct while next-themes still writes a class. If the provider
  // is switched to `attribute="data-theme"` the override silently stops matching and
  // every dark: utility freezes in its light-mode state, with nothing else noticing.
  it("keeps next-themes writing the class the override matches", () => {
    const provider = readFileSync(resolve(repoRoot, "components/theme-provider.tsx"), "utf8");
    expect(provider).toMatch(/attribute="class"/);
  });
});
