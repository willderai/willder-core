// App-shell width check: proves page content gets a usable width on a phone, not just
// that nothing scrolls sideways. At 390px the full 240px sidebar used to leave Settings
// panels ~150px; the sidebar now starts as its 72px icon rail below 768px.
//
// Measures the real shell (<aside> sidebar + <main data-app-shell>) at 390, 768 and
// 1280px against a running app. /how-to-use renders inside the same authenticated-app
// layout as /settings but needs no session, so it works against a local `next start`.
//
// Run:  CHECK_BASE_URL=http://localhost:3000 npx tsx scripts/check-app-shell-width.ts
// Needs the `playwright` package and a Chromium binary; CHROMIUM_PATH points at one
// that is not the version Playwright pinned.
import { chromium } from "playwright";
import { printableError } from "./lib/request-headers";

const BASE_URL = (process.env.CHECK_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const PATH = process.env.CHECK_PATH || "/how-to-use";

// The narrowest content column we accept at 390px. The rail leaves 318px; anything
// under 300px means the full sidebar (or something else) is eating the viewport again.
const MIN_PHONE_CONTENT_WIDTH = 300;

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.log(`  ✗ ${msg}`);
    failed++;
  }
}

// The server renders the full sidebar; the client switches a phone to the rail once
// hydrated. So wait (bounded) for the expected sidebar width before measuring, and
// measure anyway on timeout so a regression reports its real numbers.
async function measure(width: number, expectedSidebarWidth: number) {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  try {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    await page.goto(`${BASE_URL}${PATH}`, { waitUntil: "load" });
    await page
      .waitForFunction(
        (expected) => document.querySelector("aside")?.getBoundingClientRect().width === expected,
        expectedSidebarWidth,
        { timeout: 5000 },
      )
      .catch(() => undefined);
    return await page.evaluate(() => ({
      sidebar: document.querySelector("aside")!.getBoundingClientRect().width,
      content: document.querySelector("main[data-app-shell]")!.getBoundingClientRect().width,
      scrollWidth: document.documentElement.scrollWidth,
    }));
  } finally {
    await browser.close();
  }
}

async function main() {
  console.log(`\n  APP SHELL WIDTH CHECK (${BASE_URL}${PATH})\n`);

  const phone = await measure(390, 72);
  console.log(`  390px → sidebar ${phone.sidebar}px, content ${phone.content}px, scrollWidth ${phone.scrollWidth}px`);
  assert(phone.sidebar === 72, "390px: sidebar is the 72px icon rail");
  assert(phone.content >= MIN_PHONE_CONTENT_WIDTH, `390px: content column is at least ${MIN_PHONE_CONTENT_WIDTH}px`);
  assert(phone.scrollWidth <= 390, "390px: no horizontal page scroll");

  for (const width of [768, 1280]) {
    const wide = await measure(width, 240);
    console.log(`  ${width}px → sidebar ${wide.sidebar}px, content ${wide.content}px`);
    assert(wide.sidebar === 240, `${width}px: full 240px sidebar unchanged`);
    assert(wide.content === width - 240, `${width}px: content fills the rest of the viewport`);
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(printableError(e));
  process.exit(1);
});
