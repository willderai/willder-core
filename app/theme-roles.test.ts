import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Colours come from the theme roles, never from an alpha step of white or ivory.
//
// Light mode once rescued white and ivory alpha steps (a marble or white colour
// utility with a `/55` or `/[0.03]` suffix) with one `.light` override per step in
// app/globals.css; a step without its override rendered too faint (a marble step is
// forest at that opacity on stone, 3.6:1 at /55) or white on stone. Every page moved to
// the roles (text-fg, text-fg-muted, text-fg-subtle, border-divider, bg-fg/[n]) and the
// overrides were deleted, so a returning step now renders wrong in light mode. This
// test fails on one in any file Tailwind reads class names from (prose .md aside), and
// on any stylesheet rule written to rescue one.

const repoRoot = resolve(__dirname, "..");
const thisFile = resolve(__filename);

/** Directories that never hold source, at any depth. */
const SKIP_ANYWHERE = new Set([".git", ".next", "node_modules", "coverage"]);
/** Directories, relative to the repo root, with no UI source: the Prisma client and the Python service. */
const SKIP_PATHS = new Set(["lib/generated", "memory-service"]);

/** The file types Tailwind reads class names from. Prose (.md) is left out: it names a step only to forbid it. */
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|mdx|html|css|json)$/;

/** Every Tailwind utility that paints a colour. */
const COLOUR_UTILITY =
  "(?:text|bg|border(?:-[xytrblse])?|divide|ring|ring-offset|inset-ring|outline|decoration|placeholder|from|via|to|fill|stroke|shadow|inset-shadow|text-shadow|drop-shadow|caret|accent)";

/** White or ivory, by name, as an arbitrary value, or through the colour variable. */
const WHITE_OR_IVORY =
  "(?:white|marble|\\[(?:white|#fff|#ffffff|#efefe9|(?:var\\()?--color-(?:white|marble)\\)?)\\]|\\(--color-(?:white|marble)\\))";

/** An opacity modifier: `/55`, `/[0.03]`, `/(--alpha)`, or a `@source inline` brace list `/{50,55}`. */
const ALPHA = "\\/(?:\\d+|\\[[^\\]\\s]+\\]|\\([^)\\s]+\\)|\\{[^}\\s]+\\})";

/** An ivory or white rgba() written as an arbitrary value with an alpha below 1. */
const IVORY_RGBA = "\\[rgba?\\((?:239|255)[,_ ]+(?:239|255)[,_ ]+(?:233|255)[,_ /]+0?\\.\\d+\\)\\]";

/**
 * A colour utility on an alpha step of white or ivory, with any variants: `text-marble/55`,
 * `hover:border-white/10`, `bg-white/[0.03]`, `text-[#efefe9]/55`, `bg-[rgba(239,239,233,0.4)]`.
 * Backslashes are removed before matching, so an escaped CSS selector counts too.
 */
const ALPHA_STEP = new RegExp(
  `(?<![\\w-])(?:[\\w-]+:|\\[[^\\]\\s]+\\]:)*${COLOUR_UTILITY}-(?:${WHITE_OR_IVORY}${ALPHA}|${IVORY_RGBA})`,
  "g",
);

/** A selector or at-rule that applies only in light mode. */
const LIGHT_CONTEXT = /\.light\b|:not\(\s*\.dark\s*\)|\[data-theme=["']?light|prefers-color-scheme:\s*light/;

/** A selector aimed at a Tailwind colour utility class, with or without variants. */
const UTILITY_SELECTOR = new RegExp(`\\.(?:[\\w-]+\\\\:)*${COLOUR_UTILITY}-`);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return SKIP_ANYWHERE.has(entry.name) || SKIP_PATHS.has(relative(repoRoot, path)) ? [] : sourceFiles(path);
    }
    return SOURCE_FILE.test(entry.name) && path !== thisFile ? [path] : [];
  });
}

function alphaSteps(text: string): string[] {
  return [...text.replace(/\\/g, "").matchAll(ALPHA_STEP)].map((m) => m[0]);
}

/** An attribute selector that matches class names carrying an alpha step: `[class*="border-white/"]`. */
const STEP_ATTRIBUTE = /\[class[*^$~|]?=["']?[^\]]*(?:white|marble)\//;

/**
 * The selectors in a stylesheet that override a colour utility in light mode (whether the
 * light context is on the selector itself or on an enclosing at-rule), or that match an
 * alpha step through the class attribute in any theme.
 */
function lightUtilityOverrides(css: string): string[] {
  const found: string[] = [];
  const open: string[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      const prelude = text.slice(start, i).trim();
      const lightOverride = UTILITY_SELECTOR.test(prelude) && [...open, prelude].some((p) => LIGHT_CONTEXT.test(p));
      if (lightOverride || STEP_ATTRIBUTE.test(prelude)) found.push(prelude);
      open.push(prelude);
      start = i + 1;
    } else if (text[i] === "}") {
      open.pop();
      start = i + 1;
    } else if (text[i] === ";") {
      start = i + 1;
    }
  }
  return found;
}

/**
 * Data files whose `"diff"` values are verbatim git diffs quoted as test input, not source: they show
 * UI code as it was then. Only those lines are left out; every other line of the file is scanned.
 */
const QUOTED_DIFF_FILES = new Set(["test-fixtures/quoted-diffs.json"]);
const scannedText = (path: string, text: string) =>
  QUOTED_DIFF_FILES.has(relative(repoRoot, path))
    ? text
        .split("\n")
        .map((line) => (/^\s*"diff":\s*"/.test(line) ? "" : line))
        .join("\n")
    : text;

const files = sourceFiles(repoRoot);
const scanned = files.map((path) => relative(repoRoot, path));

describe("colour utilities use the theme roles", () => {
  it("scans the UI source, nested route folders included", () => {
    for (const path of [
      "app/globals.css",
      "app/heroui.css",
      "components/app-nav.tsx",
      "components/auth/sign-in-form.tsx",
      "hooks/use-nav-badges.ts",
    ]) {
      expect(scanned).toContain(path);
    }
    expect(scanned.some((path) => path.startsWith("lib/generated/"))).toBe(false);
    expect(scanned.length).toBeGreaterThan(500);
  });

  it("finds no alpha step of white or ivory in any source file", () => {
    const found = files.flatMap((path) =>
      alphaSteps(scannedText(path, readFileSync(path, "utf8"))).map((cls) => `${relative(repoRoot, path)}: ${cls}`),
    );
    expect(found).toEqual([]);
  });

  it("leaves out only the quoted diffs of a data file that holds them", () => {
    const path = resolve(repoRoot, "test-fixtures/quoted-diffs.json");
    expect(
      alphaSteps(scannedText(path, '  "diff": "+<div className=\\"text-white/50\\">"\n  "why": "text-white/50"')),
    ).toEqual(["text-white/50"]);
  });

  it("finds no light-mode override of a colour utility in any stylesheet", () => {
    const stylesheets = files.filter((path) => path.endsWith(".css"));
    expect(stylesheets.map((path) => relative(repoRoot, path))).toEqual(
      expect.arrayContaining(["app/globals.css", "components/app-nav.module.css"]),
    );
    expect(readFileSync(resolve(repoRoot, "app/globals.css"), "utf8")).toMatch(/\n\.light\s*\{/);
    const found = stylesheets.flatMap((path) =>
      lightUtilityOverrides(readFileSync(path, "utf8")).map((rule) => `${relative(repoRoot, path)}: ${rule}`),
    );
    expect(found).toEqual([]);
  });

  it("recognises every spelling it is meant to refuse", () => {
    const spellings = [
      "text-marble/55",
      "hover:text-marble/80",
      "disabled:text-marble/40",
      "[&>p]:text-marble/50",
      "placeholder:text-marble/30",
      "placeholder-marble/20",
      "text-marble/[0.55]",
      "text-white/70",
      "border-white/10",
      "border-t-white/[0.07]",
      "hover:border-white/20",
      "divide-white/10",
      "bg-white/[0.03]",
      "hover:bg-white/5",
      "ring-white/10",
      "ring-offset-white/10",
      "inset-ring-white/10",
      "outline-white/20",
      "decoration-marble/30",
      "from-white/5",
      "via-white/5",
      "to-white/5",
      "fill-white/10",
      "stroke-marble/40",
      "shadow-white/10",
      "inset-shadow-white/10",
      "text-shadow-white/20",
      "drop-shadow-white/20",
      "caret-white/50",
      "accent-white/10",
      "text-marble/(--alpha)",
      "text-(--color-marble)/55",
      "text-[--color-marble]/55",
      "text-[var(--color-marble)]/55",
      "bg-[white]/5",
      "text-[#efefe9]/55",
      "bg-[#ffffff]/10",
      "text-[rgba(239,239,233,0.55)]",
      "bg-[rgb(255_255_255/0.1)]",
      "text-marble/{50,55}",
      ".light .text-marble\\/55 {",
    ];
    for (const spelling of spellings) expect(alphaSteps(` ${spelling} `), spelling).toHaveLength(1);
    expect(
      alphaSteps(
        "text-marble text-marble-glow bg-white text-fg-muted border-divider bg-fg/[0.03] context-white/10 text-[rgba(239,239,233,1)]",
      ),
    ).toEqual([]);
  });

  it("recognises a light-mode utility override wherever the light context sits, and leaves component rules alone", () => {
    const overrides = [
      ".light .text-marble\\/55 { color: red; }",
      ".light .hover\\:bg-white\\/5:hover { background: red; }",
      ".light .border-divider, .light .x { border-color: red; }",
      ".light .ring-white\\/10 { --tw-ring-color: red; }",
      ".light .placeholder\\:text-fg::placeholder { color: red; }",
      ".light .decoration-accent { text-decoration-color: red; }",
      ".light .from-white\\/5 { --tw-gradient-from: red; }",
      ":root:not(.dark) .text-gold { color: red; }",
      "[data-theme='light'] .bg-white\\/5 { background: red; }",
      "@media (prefers-color-scheme: light) { .shadow-white\\/10 { --tw-shadow-color: red; } }",
      "@layer base { .light .text-fg-subtle { color: red; } }",
      ':root :is(input, textarea, select)[class*="border-white/"] { border-color: red; }',
      ".light [class*='text-marble/'] { color: red; }",
    ];
    for (const css of overrides) expect(lightUtilityOverrides(css), css).toHaveLength(1);
    const components = [
      ".light aside { background-color: red; }",
      ".light .grain-overlay { opacity: 0; }",
      ".light [data-product-shell] { --chart-3: red; }",
      "@layer base { .light :where(input, textarea, select) { border-color: red; } }",
      ".text-marble-glow { color: var(--color-marble); }",
      "/* .light .text-marble\\/55 { color: red; } */",
      "@media (prefers-color-scheme: dark) { .text-fg { color: red; } }",
    ];
    for (const css of components) expect(lightUtilityOverrides(css), css).toEqual([]);
  });
});
