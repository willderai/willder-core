// Regression coverage for keeping HeroUI's compiled stylesheet (~450KB) out of
// the marketing routes' render-blocking CSS.
//
// `@heroui/styles` ships one pre-built stylesheet covering every HeroUI
// component (modal, table, calendar, autocomplete, ...); it is not
// tree-shaken by usage the way Tailwind's own utility classes are, so
// importing it anywhere in the root layout's CSS graph ships all of it on
// every route. The marketing routes (`/`, `/legal`, `/docs`, `/architecture`)
// render zero `@heroui/react` components, so app/globals.css (imported by the
// root layout, and therefore by every route) must not import it. Instead
// app/heroui.css carries the import, and only the route-group layouts that
// actually render HeroUI components ((app), (auth)) import that file.
//
// This is a wiring test, not a rendering or bundle-size test: vitest here
// has no bundler pass, so the thing worth pinning is that the import lives in
// the right file and is wired into the right layouts, the same failure mode
// speed-insights-wiring.test.ts guards for a different integration — a future
// edit can restore correct-looking behavior in source while silently
// widening (or narrowing) which routes pay for this CSS, and nothing else in
// the suite would notice.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "..");
const read = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");

const HEROUI_IMPORT = /@import\s+["']@heroui\/styles["'];?/;

describe("HeroUI stylesheet scoping", () => {
  it("keeps the HeroUI import out of the global stylesheet every route loads", () => {
    expect(read("app/globals.css")).not.toMatch(HEROUI_IMPORT);
  });

  it("carries the HeroUI import in its own file", () => {
    expect(read("app/heroui.css")).toMatch(HEROUI_IMPORT);
  });

  it("loads that file from the product shell, which renders HeroUI components", () => {
    expect(read("app/(app)/layout.tsx")).toMatch(/import\s+["']\.\.\/heroui\.css["'];?/);
  });

  it("loads that file from the auth routes, which also render HeroUI components", () => {
    expect(read("app/(auth)/layout.tsx")).toMatch(/import\s+["']\.\.\/heroui\.css["'];?/);
  });

  it("does not load heroui.css from the root layout the marketing routes share", () => {
    expect(read("app/layout.tsx")).not.toMatch(/heroui\.css/);
  });
});
