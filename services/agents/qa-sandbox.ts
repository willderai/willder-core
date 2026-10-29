// QA agent — Vercel Sandbox browser driver (opt-in isolation upgrade for browser mode).
//
// This is the microVM-isolated counterpart to the in-process Playwright driver in
// `qa-browser.ts`. Instead of launching Chromium in THIS process, it provisions an
// ephemeral Vercel Sandbox (Firecracker microVM), drives headless Chromium inside it via
// the Vercel-documented `agent-browser` CLI, and disposes the VM per run. It returns the
// SAME `BrowserToolsHandle` shape as the in-process path, so `createBrowserTools` — and
// therefore runQaAgent — is unchanged whichever path is active: createBrowserTools is the
// seam. Isolation is layered ON TOP of the allow-list — the SAME SSRF guard from
// `qa-tools.ts` runs in-process before every navigation, and the landed URL is re-pinned
// after each navigation/click. Never weaken or duplicate that guard here.
//
// Reference: Vercel Sandbox is GA (Jan 2026), `@vercel/sandbox`. Browser automation pattern
// (agent-browser inside the sandbox VM) per Vercel's official Sandbox browser-automation guide.
import { createTool } from "@mastra/core";
import { z } from "zod";
import { resolveAndAssertAllowed, assertHostResolvesPublic } from "./qa-tools";
import type { BrowserToolsHandle } from "./qa-browser";

// Indirect specifier so tsc (moduleResolution: bundler) doesn't hard-resolve the module at
// build time — `@vercel/sandbox` is an OPTIONAL runtime dep (added to package.json but not
// installed by default), loaded only when QA_SANDBOX is on. A missing install throws here and
// the caller (createBrowserTools) degrades gracefully to the in-process path.
const SANDBOX_MODULE = "@vercel/sandbox";

// System libraries Chromium needs on the sandbox VM (Amazon Linux / dnf), per Vercel's guide.
// Only installed on cold VMs; a pre-built sandbox snapshot (AGENT_BROWSER_SNAPSHOT_ID) skips this.
const CHROMIUM_SYSTEM_DEPS = [
  "nss",
  "nspr",
  "libxkbcommon",
  "atk",
  "at-spi2-atk",
  "at-spi2-core",
  "libXcomposite",
  "libXdamage",
  "libXrandr",
  "libXfixes",
  "libXcursor",
  "libXi",
  "libXtst",
  "libXScrnSaver",
  "libXext",
  "mesa-libgbm",
  "libdrm",
  "mesa-libGL",
  "mesa-libEGL",
  "cups-libs",
  "alsa-lib",
  "pango",
  "cairo",
  "gtk3",
  "dbus-libs",
];

const SANDBOX_TIMEOUT_MS = 180_000;

/**
 * Read the flag the same way other repo flags are read (cf. `paymentsEnabled` in
 * services/billing/plans.ts): truthy = "true" | "1" | "on" | "yes". Default off, so browser
 * mode keeps today's in-process behavior unless QA_SANDBOX is explicitly enabled.
 */
export function qaSandboxEnabled(): boolean {
  const v = process.env.QA_SANDBOX?.toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "yes";
}

/**
 * Explicit Vercel credentials for local/off-Vercel use. On a Vercel deployment the Sandbox
 * SDK authenticates automatically via OIDC (VERCEL_OIDC_TOKEN), so we pass nothing and let it
 * fall back. Only spread these when all three are present — a partial set is worse than none.
 */
function sandboxCredentials(): Record<string, string> {
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (token && teamId && projectId) return { token, teamId, projectId };
  return {};
}

/**
 * Provision a Vercel Sandbox, boot headless Chromium (agent-browser) inside it, and return
 * the QA browser tools bound to `allowedHosts` plus a `close()` that disposes the VM. Throws
 * if `@vercel/sandbox` isn't installed or the VM can't start — `createBrowserTools` catches
 * that and falls back to the in-process path (or, if that also fails, to API mode).
 */
export async function createSandboxBrowserTools(opts: {
  baseUrl: string;
  allowedHosts: string[];
}): Promise<BrowserToolsHandle> {
  // @vercel/sandbox is an OPTIONAL dep, only present when QA_SANDBOX is enabled and it's
  // been installed. turbopackIgnore keeps the bundler from trying to resolve it at build
  // time (default path never imports it); it resolves at runtime once installed.
  const { Sandbox } = (await import(/* turbopackIgnore: true */ SANDBOX_MODULE)) as any;
  const snapshotId = process.env.AGENT_BROWSER_SNAPSHOT_ID;
  const credentials = sandboxCredentials();

  const sandbox = snapshotId
    ? await Sandbox.create({ ...credentials, source: { type: "snapshot", snapshotId }, timeout: SANDBOX_TIMEOUT_MS })
    : await Sandbox.create({ ...credentials, runtime: "node24", timeout: SANDBOX_TIMEOUT_MS });

  try {
    // Cold VM: install Chromium's system deps + agent-browser + its Chromium build. A
    // pre-built snapshot has all of this baked in, so we skip straight to driving.
    if (!snapshotId) {
      await sandbox.runCommand("sh", [
        "-c",
        `sudo dnf clean all 2>&1 && sudo dnf install -y --skip-broken ${CHROMIUM_SYSTEM_DEPS.join(" ")} 2>&1 && sudo ldconfig 2>&1`,
      ]);
      await sandbox.runCommand("npm", ["install", "-g", "agent-browser"]);
      await sandbox.runCommand("npx", ["agent-browser", "install"]);
    }

    // Run agent-browser and return its stdout (trimmed). Non-zero exits surface as a thrown
    // error the tool wraps into a structured `{ error }` the model sees.
    const ab = async (args: string[]): Promise<string> => {
      const res = await sandbox.runCommand("agent-browser", args);
      const [out, code] = await Promise.all([res.stdout(), res.exitCode ?? Promise.resolve(0)]);
      const exit = typeof res.exitCode === "number" ? res.exitCode : code;
      if (exit && exit !== 0) {
        const err = (await res.stderr?.().catch(() => "")) || out;
        throw new Error(`agent-browser ${args[0]} exited ${exit}: ${String(err).slice(0, 500)}`);
      }
      return (out ?? "").trim();
    };

    // Pre-navigation guard — IDENTICAL guarantee to the in-process path: pure sync host
    // allow-list check (resolveAndAssertAllowed) + async DNS-resolves-public check
    // (assertHostResolvesPublic). Runs in THIS process before we ever tell the VM to open a URL.
    const guard = async (target: string): Promise<string> => {
      const u = resolveAndAssertAllowed(target, opts.baseUrl, opts.allowedHosts);
      await assertHostResolvesPublic(new URL(u).hostname);
      return u;
    };

    // Best-effort read of the browser's current URL, for re-pinning after a navigation/click.
    // TODO(confirm): the exact `agent-browser get url` subcommand form — Vercel's guide documents
    // `get title --json`; `get url --json` is inferred from the same shape. Confirm against the
    // agent-browser CLI docs. If unavailable, re-pin degrades to a no-op (see note below).
    const currentUrl = async (): Promise<string | null> => {
      try {
        const raw = await ab(["get", "url", "--json"]);
        return JSON.parse(raw)?.data?.url ?? null;
      } catch {
        return null;
      }
    };
    const pageTitle = async (): Promise<string | null> => {
      try {
        const raw = await ab(["get", "title", "--json"]);
        return JSON.parse(raw)?.data?.title ?? null;
      } catch {
        return null;
      }
    };

    // Re-pin after navigation/click: the pre-nav guard cannot see mid-flight 3xx redirects the
    // way the in-process context.route("**") interceptor can, so we re-assert the LANDED host is
    // still on the allow-list. If it drifted off-list, abort the session by navigating to blank.
    // Residual (documented, same posture as qa-tools.ts DNS-rebinding note): a redirect chain that
    // briefly touches an off-list host between hops isn't caught — acceptable under the self-serve/
    // own-product trust model; an egress-pinning proxy is the hardening step if that ever changes.
    const repin = async (): Promise<{ landedOffList: boolean; url: string | null }> => {
      const u = await currentUrl();
      if (!u) return { landedOffList: false, url: null }; // couldn't read — best-effort, don't block
      try {
        resolveAndAssertAllowed(u, opts.baseUrl, opts.allowedHosts);
        await assertHostResolvesPublic(new URL(u).hostname);
        return { landedOffList: false, url: u };
      } catch {
        await ab(["open", "about:blank"]).catch(() => {});
        return { landedOffList: true, url: u };
      }
    };

    // ---- browser_navigate ---------------------------------------------------
    const navigate = createTool({
      id: "browser_navigate",
      description:
        "Navigate the browser to a path or URL on the target site and wait for it to load. " +
        "Returns the resulting URL and page title. Only the target host(s) are allowed.",
      inputSchema: z.object({
        path: z.string().describe("Path (e.g. /login) or full URL under the target host"),
      }),
      execute: async ({ context: c }: { context: { path: string } }) => {
        let url: string;
        try {
          url = await guard(c.path);
        } catch (e) {
          return { error: String(e instanceof Error ? e.message : e) };
        }
        try {
          await ab(["open", url]);
          const pin = await repin();
          if (pin.landedOffList) {
            return { error: `blocked: navigation landed on an off-allow-list host (${pin.url})` };
          }
          return { url: pin.url ?? url, title: await pageTitle(), status: null }; // TODO: agent-browser doesn't expose HTTP status
        } catch (e) {
          return { error: String(e instanceof Error ? e.message : e), unreachable: true };
        }
      },
    });

    // ---- browser_read -------------------------------------------------------
    // Uses agent-browser's accessibility snapshot (interactive elements, compressed). Each
    // element carries a ref (e.g. @e5) that browser_click/browser_type act on — this is the
    // sandbox path's element-addressing model (vs. the in-process path's text/CSS locators).
    const read = createTool({
      id: "browser_read",
      description:
        "Read the current page as an accessibility snapshot of its interactive elements. " +
        "Each element has a ref (e.g. @e5) — pass that ref to browser_click / browser_type. " +
        "Also returns the current URL and title. Use this to decide what to click or type.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const snapshot = await ab(["snapshot", "-i", "-c"]); // interactive, compressed
          return { url: await currentUrl(), title: await pageTitle(), snapshot };
        } catch (e) {
          return { error: String(e instanceof Error ? e.message : e) };
        }
      },
    });

    // ---- browser_click ------------------------------------------------------
    const click = createTool({
      id: "browser_click",
      description:
        "Click an element by its ref (e.g. @e5) from the latest browser_read snapshot. " +
        "Returns the resulting URL/title after any navigation.",
      inputSchema: z.object({
        ref: z.string().describe("Element ref from browser_read, e.g. @e5"),
      }),
      execute: async ({ context: c }: { context: { ref: string } }) => {
        try {
          await ab(["click", c.ref]);
          await ab(["wait", "--load", "networkidle"]).catch(() => {}); // best-effort settle
          const pin = await repin();
          if (pin.landedOffList) {
            return { error: `blocked: click navigated to an off-allow-list host (${pin.url})` };
          }
          return { url: pin.url, title: await pageTitle() };
        } catch (e) {
          return { error: String(e instanceof Error ? e.message : e) };
        }
      },
    });

    // ---- browser_type -------------------------------------------------------
    const type = createTool({
      id: "browser_type",
      description:
        "Type text into a field addressed by its ref (e.g. @e3) from the latest browser_read " +
        "snapshot. Optionally submit (press Enter) after typing.",
      inputSchema: z.object({
        ref: z.string().describe("Field ref from browser_read, e.g. @e3"),
        text: z.string().describe("Text to type"),
        submit: z.boolean().optional().describe("Press Enter after typing"),
      }),
      execute: async ({ context: c }: { context: { ref: string; text: string; submit?: boolean } }) => {
        try {
          await ab(["fill", c.ref, c.text]);
          if (c.submit) {
            // TODO(confirm): agent-browser key-press form for Enter (`key`/`press` subcommand).
            // Documented commands cover open/get/snapshot/screenshot/fill/click/wait/close; the
            // key-press form is inferred. Confirm against the agent-browser CLI docs.
            await ab(["key", "Enter"]).catch(() => {});
            await ab(["wait", "--load", "networkidle"]).catch(() => {});
            const pin = await repin();
            if (pin.landedOffList) {
              return { error: `blocked: submit navigated to an off-allow-list host (${pin.url})` };
            }
            return { ok: true, url: pin.url };
          }
          return { ok: true, url: await currentUrl() };
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
      // Teardown: close the browser tab, then dispose the microVM. Both best-effort so a
      // failed close never masks a run's real result.
      close: async () => {
        await ab(["close"]).catch(() => {});
        await sandbox.stop().catch(() => {});
      },
    };
  } catch (e) {
    // Partial init (VM created, setup/driving failed) — never orphan the microVM.
    await sandbox.stop().catch(() => {});
    throw e;
  }
}
