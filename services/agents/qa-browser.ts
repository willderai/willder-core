// QA agent — browser tools. Drives a real browser (Playwright/Chromium) so the
// QA agent can black-box test a WEB APP the way a user would: navigate, click, type,
// read the page. Loaded ONLY by runQaAgent when mode="browser", via a dynamic import, so
// Playwright's heavy deps never enter the common module graph (and a missing install
// degrades gracefully to API mode instead of breaking the build).
//
// Isolation: by default this launches Chromium in-process, which is acceptable under the
// trust model (the customer points QA at their OWN deployed product — same risk surface as
// any other outbound HTTP, and every navigation is allow-list-guarded below). The Vercel
// Sandbox microVM (qa-sandbox.ts) is the isolation upgrade; the session abstraction here
// is the seam where that swap happens — nothing above this file changes when it does.
import { createTool } from "@mastra/core";
import { z } from "zod";
import { resolveAndAssertAllowed, assertHostResolvesPublic } from "./qa-tools";

// Indirect specifier so tsc (moduleResolution: bundler) doesn't hard-resolve Playwright
// at build time — it's an optional runtime dep, installed only where browser mode runs.
const PLAYWRIGHT_MODULE = "playwright";

const MAX_TEXT_CHARS = 12_000;
const MAX_ELEMENTS = 60;

export interface BrowserToolsHandle {
  tools: Record<string, unknown>;
  close: () => Promise<void>;
}

/**
 * Boot a browser session bounded to `allowedHosts` and return the Mastra tools that
 * drive it plus a `close()` for teardown. Throws if Playwright isn't installed — the
 * caller (runQaAgent) catches that and falls back to API mode.
 *
 * Isolation seam: by default this launches Chromium IN-PROCESS. When the QA_SANDBOX
 * flag is truthy it instead provisions a
 * Vercel Sandbox microVM and drives Chromium inside it — same signature, same
 * `BrowserToolsHandle` contract, so runQaAgent is unchanged either way. The sandbox path is
 * loaded via dynamic import ONLY on the flag branch, so `@vercel/sandbox` (an optional dep)
 * never enters the default module graph or breaks the in-process path when it isn't installed.
 * If the sandbox can't start, we fall back to the in-process path rather than failing the run.
 */
export async function createBrowserTools(opts: {
  baseUrl: string;
  allowedHosts: string[];
}): Promise<BrowserToolsHandle> {
  const { qaSandboxEnabled } = await import("./qa-sandbox");
  if (qaSandboxEnabled()) {
    try {
      const { createSandboxBrowserTools } = await import("./qa-sandbox");
      return await createSandboxBrowserTools(opts);
    } catch {
      // Sandbox unavailable (dep not installed, no creds, VM start failed) — fall back to the
      // in-process path below rather than failing the run. runQaAgent still catches a total
      // failure (both paths down) and degrades to API mode.
    }
  }
  const { chromium } = (await import(PLAYWRIGHT_MODULE)) as any;
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    // Guard EVERY main-frame navigation/redirect — not just the first browser_navigate.
    // Clicks, form submits, and 3xx redirects to an off-allow-list or internal host are
    // aborted here; subresources (css/img/xhr) are left alone so the page still renders.
    await context.route("**", async (route: any) => {
      const req = route.request();
      if (req.resourceType() !== "document") return route.continue();
      try {
        const u = resolveAndAssertAllowed(req.url(), opts.baseUrl, opts.allowedHosts);
        await assertHostResolvesPublic(new URL(u).hostname);
        return route.continue();
      } catch {
        return route.abort("blockedbyclient");
      }
    });

    const guard = (target: string) => resolveAndAssertAllowed(target, opts.baseUrl, opts.allowedHosts);

    // ---- browser_navigate ---------------------------------------------------
    const navigate = createTool({
      id: "browser_navigate",
      description:
        "Navigate the browser to a path or URL on the target site and wait for it to load. " +
        "Returns the resulting URL, page title, and HTTP status. Only the target host(s) are allowed.",
      inputSchema: z.object({
        path: z.string().describe("Path (e.g. /login) or full URL under the target host"),
      }),
      execute: async ({ context: c }: { context: { path: string } }) => {
        let url: string;
        try {
          url = guard(c.path);
        } catch (e) {
          return { error: String(e instanceof Error ? e.message : e) };
        }
        try {
          const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
          return { url: page.url(), title: await page.title(), status: res?.status() ?? null };
        } catch (e) {
          return { error: String(e instanceof Error ? e.message : e), unreachable: true };
        }
      },
    });

    // ---- browser_read -------------------------------------------------------
    // NOTE: deliberately uses Playwright locator APIs instead of page.evaluate(fn). Under
    // esbuild/tsx (keepNames) a serialized closure references an injected `__name` helper
    // that doesn't exist in the page context → "ReferenceError: __name is not defined".
    // Locator APIs run in the driver, not via a serialized closure, so they're portable
    // across the tsx check scripts and the Next build.
    const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
    const read = createTool({
      id: "browser_read",
      description:
        "Read the current page: its URL, title, visible text, and the interactive elements " +
        "(links, buttons, inputs) you can act on. Use this to decide what to click or type.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const bodyText = clean(
            await page
              .locator("body")
              .innerText({ timeout: 10_000 })
              .catch(() => ""),
          );
          const links = (
            await page
              .locator("a")
              .allInnerTexts()
              .catch(() => [])
          )
            .map(clean)
            .filter(Boolean)
            .slice(0, MAX_ELEMENTS);
          const buttons = (
            await page
              .locator("button, [role=button], input[type=submit]")
              .allInnerTexts()
              .catch(() => [])
          )
            .map(clean)
            .filter(Boolean)
            .slice(0, MAX_ELEMENTS);

          // Inputs carry no innerText — read their identifying attributes one by one.
          const inputLoc = page.locator("input, textarea, select");
          const inputCount = Math.min(await inputLoc.count().catch(() => 0), MAX_ELEMENTS);
          const inputs: string[] = [];
          for (let i = 0; i < inputCount; i++) {
            const el = inputLoc.nth(i);
            const label =
              (await el.getAttribute("aria-label").catch(() => null)) ||
              (await el.getAttribute("placeholder").catch(() => null)) ||
              (await el.getAttribute("name").catch(() => null)) ||
              (await el.getAttribute("type").catch(() => null)) ||
              "field";
            inputs.push(clean(label));
          }

          return {
            url: page.url(),
            title: await page.title(),
            text: bodyText.length > MAX_TEXT_CHARS ? bodyText.slice(0, MAX_TEXT_CHARS) + "\n…[truncated]" : bodyText,
            links,
            buttons,
            inputs,
          };
        } catch (e) {
          return { error: String(e instanceof Error ? e.message : e) };
        }
      },
    });

    // ---- browser_click ------------------------------------------------------
    const click = createTool({
      id: "browser_click",
      description:
        "Click an element. Prefer `text` (visible label of a link/button) or `role`+`name`; " +
        "fall back to a CSS `selector`. Returns the resulting URL/title after any navigation.",
      inputSchema: z.object({
        text: z.string().optional().describe("Visible text of the element to click"),
        selector: z.string().optional().describe("CSS selector, if text isn't enough"),
        role: z.string().optional().describe("ARIA role (e.g. button, link)"),
        name: z.string().optional().describe("Accessible name, used with role"),
      }),
      execute: async ({
        context: c,
      }: {
        context: { text?: string; selector?: string; role?: string; name?: string };
      }) => {
        try {
          const locator = c.selector
            ? page.locator(c.selector)
            : c.role
              ? page.getByRole(c.role as any, c.name ? { name: c.name } : undefined)
              : c.text
                ? page.getByText(c.text, { exact: false })
                : null;
          if (!locator) return { error: "provide one of: text, role(+name), or selector" };
          await locator.first().click({ timeout: 10_000 });
          await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
          return { url: page.url(), title: await page.title() };
        } catch (e) {
          return { error: String(e instanceof Error ? e.message : e) };
        }
      },
    });

    // ---- browser_type -------------------------------------------------------
    const type = createTool({
      id: "browser_type",
      description:
        "Type text into a field, located by its `label`/placeholder or a CSS `selector`. " +
        "Optionally submit (press Enter) after typing.",
      inputSchema: z.object({
        text: z.string().describe("Text to type"),
        label: z.string().optional().describe("Field label, aria-label, or placeholder"),
        selector: z.string().optional().describe("CSS selector, if label isn't enough"),
        submit: z.boolean().optional().describe("Press Enter after typing"),
      }),
      execute: async ({
        context: c,
      }: {
        context: { text: string; label?: string; selector?: string; submit?: boolean };
      }) => {
        try {
          const locator = c.selector
            ? page.locator(c.selector)
            : c.label
              ? page.getByLabel(c.label).or(page.getByPlaceholder(c.label))
              : null;
          if (!locator) return { error: "provide one of: label or selector" };
          await locator.first().fill(c.text, { timeout: 10_000 });
          if (c.submit) {
            await locator.first().press("Enter");
            await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
          }
          return { ok: true, url: page.url() };
        } catch (e) {
          return { error: String(e instanceof Error ? e.message : e) };
        }
      },
    });

    return {
      tools: {
        browser_navigate: navigate,
        browser_read: read,
        browser_click: click,
        browser_type: type,
      },
      close: async () => {
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
      },
    };
  } catch (e) {
    // Partial init (launch ok, context/page/route failed) — don't orphan the browser.
    await browser.close().catch(() => {});
    throw e;
  }
}
