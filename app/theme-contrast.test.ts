import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Contrast and cascade rules for app/globals.css, computed from the stylesheet
// itself so a token edit cannot drift past them.
//
// 1. The three text roles hold 4.5:1 and a field's border holds 3:1 (WCAG
//    1.4.11) on every surface they sit on, in both themes. The surfaces include
//    the darkest corner of the app backdrop (components/backdrop.tsx mixes 10%
//    of the action colour into the ground), which is darker than stone in light
//    mode.
// 2. Field defaults never sit outside a cascade layer. An unlayered
//    `.light input` rule once outranked every Tailwind utility, so the field
//    tokens did nothing in light mode and pages patched it with `!`. Outside a
//    layer only two kinds of field rule are allowed, each limited to what it
//    sets: the placeholder colour and focus rings.

const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");

type Rgba = [number, number, number, number];

function themeBlock(pattern: RegExp): string {
  const match = css.match(pattern);
  if (!match) throw new Error(`theme block not found: ${pattern}`);
  return match[1];
}

function prop(block: string, name: string): Rgba {
  const match = block.match(new RegExp(`${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`${name} not found`);
  return parseColor(match[1].trim());
}

function parseColor(value: string): Rgba {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1) as Rgba;
  const rgba = value.match(/^rgba?\(([^)]+)\)$/);
  if (rgba) {
    const [r, g, b, a = 1] = rgba[1].split(",").map(Number);
    return [r, g, b, a];
  }
  throw new Error(`not a literal colour: ${value}`);
}

const over = (fg: Rgba, bg: Rgba): Rgba => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1) as Rgba;
const mix = (a: Rgba, share: number, b: Rgba): Rgba => over([a[0], a[1], a[2], share], b);
const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: Rgba) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const contrast = (a: Rgba, b: Rgba) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const themeTokens = themeBlock(/@theme\s*\{([^}]*)\}/);
const dark = themeBlock(/:root,\s*\.dark\s*\{([^}]*)\}/);
const light = themeBlock(/\n\.light\s*\{([^}]*)\}/);

const themes = {
  dark: { block: dark, palette: themeTokens },
  light: { block: light, palette: light },
};

for (const [theme, { block, palette }] of Object.entries(themes)) {
  const ink = prop(palette, "--color-ink");
  const surfaces: Record<string, Rgba> = {
    ground: prop(block, "--background"),
    card: prop(palette, "--color-surface"),
    panel: prop(block, "--surface-tertiary"),
    overlay: prop(block, "--overlay"),
    "backdrop corner": mix(prop(palette, "--color-gold"), 0.1, ink),
  };
  const fill = prop(block, "--field-background");

  describe(`${theme}: text roles hold 4.5:1 on every surface`, () => {
    for (const token of ["--foreground", "--fg-muted", "--fg-subtle"]) {
      for (const [name, surface] of Object.entries(surfaces)) {
        it(`${token} on the ${name}`, () => {
          expect(contrast(prop(block, token), surface)).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  });

  describe(`${theme}: field borders hold 3:1 and placeholders 4.5:1`, () => {
    for (const [name, surface] of Object.entries(surfaces)) {
      const inside = over(fill, surface);
      for (const token of ["--field-border", "--field-border-hover", "--field-border-focus"]) {
        it(`${token} on the ${name} and on the field fill there`, () => {
          const border = prop(block, token);
          expect(contrast(over(border, surface), surface)).toBeGreaterThanOrEqual(3);
          expect(contrast(over(border, inside), inside)).toBeGreaterThanOrEqual(3);
        });
      }
      it(`--field-placeholder on the field fill over the ${name}`, () => {
        expect(contrast(prop(block, "--field-placeholder"), inside)).toBeGreaterThanOrEqual(4.5);
      });
    }
  });
}

/** The stylesheet with comments and every `@layer … { … }` block removed. */
function unlayered(source: string): string {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "");
  let out = "";
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf("@layer", i);
    if (at === -1) return out + text.slice(i);
    const open = text.indexOf("{", at);
    const semi = text.indexOf(";", at);
    out += text.slice(i, at);
    if (semi !== -1 && semi < open) {
      i = semi + 1; // `@layer a, b;` statement
      continue;
    }
    let depth = 0;
    let j = open;
    for (; j < text.length; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}" && --depth === 0) break;
    }
    i = j + 1;
  }
  return out;
}

const FIELD = /(^|[\s,(>+~:])(input|textarea|select)\b|\[type[~|^$*]?=/;

/** A selector list split on its top-level commas, leaving `:is(a, b)` whole. */
function selectorParts(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "(" || list[i] === "[") depth++;
    else if (list[i] === ")" || list[i] === "]") depth--;
    else if (list[i] === "," && depth === 0) {
      parts.push(list.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(list.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}
const properties = (body: string) =>
  body
    .split(";")
    .map((d) => d.split(":")[0].trim())
    .filter(Boolean);

/** Each unlayered rule's selectors (one per comma part) with the properties it sets. */
const unlayeredFieldRules = [...unlayered(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(([, selectors, body]) =>
  selectorParts(selectors)
    .filter((part) => FIELD.test(part))
    .map((selector) => ({ selector, properties: properties(body), important: body.includes("!important") })),
);

describe("field defaults stay in a cascade layer", () => {
  it("finds the unlayered field rules it checks", () => {
    expect(unlayeredFieldRules.length).toBeGreaterThan(0);
  });

  it("allows only the placeholder colour and focus rings outside a layer", () => {
    const allowed = (rule: (typeof unlayeredFieldRules)[number]) => {
      const only = (names: RegExp) => rule.properties.length > 0 && rule.properties.every((p) => names.test(p));
      if (rule.selector.endsWith("::placeholder")) return only(/^color$/);
      if (rule.selector.endsWith(":focus-visible")) return only(/^outline(-offset|-color|-style|-width)?$/);
      return false;
    };
    expect(unlayeredFieldRules.filter((rule) => !allowed(rule) || rule.important)).toEqual([]);
  });

  it("keeps the light-mode field defaults in the base layer, without !important", () => {
    const base = css.match(/@layer base\s*\{\s*(\.light :where\(input[^{]*)\{([^}]*)\}/);
    expect(base).not.toBeNull();
    expect(base![2]).toMatch(/background-color:\s*var\(--field-background\)/);
    expect(base![2]).toMatch(/border-color:\s*var\(--field-border\)/);
    expect(base![2]).not.toMatch(/!important/);
  });
});
