// QA agent browser tools: live plumbing check. Run with: npm run qa-browser:check
// Boots the real Playwright browser tools against a public site and asserts the core
// loop works end to end WITHOUT the LLM: navigate (allow-list-guarded), read the page,
// and confirm an off-target navigation is blocked. Needs the `playwright` package + a
// Chromium binary installed (`npx playwright install chromium`) and network access.
import { createBrowserTools } from "@/services/agents/qa-browser";
import { printableError } from "./lib/request-headers";

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

async function main() {
  console.log("\n  QA BROWSER CHECK (UC8 Phase 2)\n");
  const target = "https://example.com";
  const { tools, close } = await createBrowserTools({ baseUrl: target, allowedHosts: ["example.com"] });
  try {
    const nav = await (tools.browser_navigate as any).execute({ context: { path: "/" } });
    console.log(
      "  navigate →",
      JSON.stringify({ url: nav?.url, status: nav?.status, error: nav?.error && printableError(nav.error) }),
    );
    assert(!nav?.error && !!nav?.status, "navigates to the target and returns an HTTP status");
    assert(typeof nav?.title === "string", "returns the page title");

    const read = await (tools.browser_read as any).execute({ context: {} });
    console.log(`  read → title="${read?.title}" textLen=${read?.text?.length ?? 0} links=${read?.links?.length ?? 0}`);
    assert(!read?.error && (read?.text?.length ?? 0) > 0, "reads visible page text");
    assert(/example/i.test(read?.title ?? "") || /example/i.test(read?.text ?? ""), "read content matches the page");

    const blocked = await (tools.browser_navigate as any).execute({ context: { path: "https://evil.example.net/" } });
    console.log("  off-host navigate →", JSON.stringify({ error: blocked?.error && printableError(blocked.error) }));
    assert(!!blocked?.error, "off-target navigation is blocked by the allow-list guard");
  } finally {
    await close();
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(printableError(e));
  process.exit(1);
});
