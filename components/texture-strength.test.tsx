// The product shell's background texture runs at half the marketing pages'
// strength through one custom property, --texture-strength (app/globals.css).
// These tests pin the three links in that chain: the shell marks itself, the
// stylesheet lowers the token only when that mark is present, and both texture
// layers (the static grain tile and the Backdrop's light cones) read the token.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Backdrop } from "@/components/backdrop";
import { GrainBackground } from "@/components/grain-background";

const repoRoot = resolve(__dirname, "..");
const globalsCss = readFileSync(resolve(repoRoot, "app/globals.css"), "utf8");
const appLayout = readFileSync(resolve(repoRoot, "app/(app)/layout.tsx"), "utf8");

/** Find an exact selector, including one in a shared list such as :root, .dark. */
function block(selector: string): string {
  const css = globalsCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, selectors]) =>
    selectors.split(",").some((item) => item.trim() === selector),
  );
  expect(rule, `app/globals.css should have a ${selector} rule`).toBeDefined();
  return rule![2];
}

describe("--texture-strength", () => {
  it("defaults to the full texture multiplier on public pages", () => {
    expect(block(":root")).toMatch(/--texture-strength:\s*1;/);
    expect(block(".dark")).toMatch(/--texture-strength:\s*1;/);
  });

  it("drops to half inside the product shell", () => {
    expect(block(":root:has([data-app-shell])")).toMatch(/--texture-strength:\s*0\.5;/);
    expect(appLayout).toMatch(/<main\s+data-app-shell\s/);
  });

  it("scales the grain overlay in both themes", () => {
    // Marketing: 10% dark / 5% light. Product: half of either base opacity.
    expect(block(".grain-overlay")).toMatch(/opacity:\s*calc\(0\.1 \* var\(--texture-strength\)\)/);
    expect(block(".light .grain-overlay")).toMatch(/opacity:\s*calc\(0\.05 \* var\(--texture-strength\)\)/);
  });

  it("connects the static decorative tile to the shared grain opacity", () => {
    const { container } = render(<GrainBackground />);
    const grain = container.querySelector<HTMLElement>(".grain-overlay");
    expect(grain?.getAttribute("aria-hidden")).toBe("true");
    expect(grain?.style.backgroundImage).toContain("/grain.png");
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("scales the Backdrop's light cones", () => {
    const { container } = render(<Backdrop />);
    const cones = container.querySelector("svg");
    expect(cones?.getAttribute("style")).toContain("opacity: var(--texture-strength, 1)");
  });
});
