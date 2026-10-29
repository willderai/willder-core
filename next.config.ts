import type { NextConfig } from "next";
import { SITE_VIDEO_CONNECT_SRC, SITE_VIDEO_MEDIA_SRC } from "./lib/site-videos";

// The browser-reachable origin of the memory service, for CSP connect-src. Read from
// GRAPHITI_SERVICE_URL (the same variable the server uses to reach it) at build time
// and reduced to a bare origin, since connect-src matches origins, not paths.
// A production build without it fails here rather than shipping a CSP that blocks the
// service; local and preview builds simply leave it out of connect-src.
//
// Exported for its unit test (next.config.test.ts); Next.js reads only the default export.
export function memoryServiceOrigin(url: string | undefined, isProductionBuild: boolean): string | undefined {
  if (!url) {
    if (isProductionBuild) {
      throw new Error(
        "GRAPHITI_SERVICE_URL is not set: a production build needs it to allow the memory service in the Content-Security-Policy connect-src.",
      );
    }
    return undefined;
  }
  try {
    return new URL(url).origin;
  } catch {
    throw new Error(
      "GRAPHITI_SERVICE_URL is not an absolute URL; the Content-Security-Policy connect-src needs its origin.",
    );
  }
}

const connectSrc = [
  "'self'",
  "https://*.clerk.com",
  "https://*.clerk.accounts.dev",
  "https://clerk.willder.ai",
  "wss://clerk.willder.ai",
  memoryServiceOrigin(process.env.GRAPHITI_SERVICE_URL, process.env.VERCEL_ENV === "production"),
  "wss://*.clerk.accounts.dev",
  "https://us.posthog.com",
  "https://accounts.google.com",
  "https://www.googleapis.com",
  "https://content.googleapis.com",
  // The launch film's HLS store, which hls.js fetches from (lib/site-videos.ts); none while unset.
  ...SITE_VIDEO_CONNECT_SRC,
].filter((origin): origin is string => Boolean(origin));

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // va.vercel-scripts.com: Speed Insights' dev debug script
      // (script.debug.js) loads from here directly, outside of Vercel's
      // production same-origin proxy (github.com/vercel/speed-insights/issues/103).
      // Without it, CSP silently blocks the script in local dev.
      // No matching connect-src entry: verified
      // against both the installed @vercel/speed-insights v2 dist and the
      // actual fetched script.debug.js that this origin's script-src loads
      // that the vitals beacon endpoint is always same-origin ('self')
      // here, since willder never passes a `dsn` prop to <SpeedInsights />
      // (the only thing that would switch it to an absolute
      // vitals.vercel-insights.com URL) — and in dev the debug script's
      // default debug mode doesn't send that beacon at all, only logs it.
      // accounts.google.com + apis.google.com: Google Identity Services and the
      // Drive Picker, loaded by components/settings/sources-panel.tsx when
      // NEXT_PUBLIC_GDRIVE_MOCK=false. Without them the loader never resolves and
      // "Connect Drive folder" spins forever (found 2026-09-25 on production).
      "script-src 'self' 'unsafe-eval' 'unsafe-inline' https://clerk.willder.ai https://*.clerk.accounts.dev https://challenges.cloudflare.com https://va.vercel-scripts.com https://accounts.google.com https://apis.google.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob: https://img.clerk.com https://logo.clearbit.com https://*.googleusercontent.com https://ssl.gstatic.com",
      `connect-src ${connectSrc.join(" ")}`,
      // Clerk's device-attestation (client trust) check runs in a blob: worker.
      // Without this, worker-src falls back to script-src, blob: is refused, and
      // password sign-in dead-ends on `needs_client_trust` (found 2026-07-27 —
      // OAuth sign-in was unaffected, which is why it went unnoticed).
      "worker-src 'self' blob:",
      // The landing page's videos: this site, plus the one public Blob store that serves them
      // (lib/site-videos.ts). Without a store set, media stays same-origin as before.
      SITE_VIDEO_MEDIA_SRC,
      // accounts.google.com and docs.google.com host the GIS consent popup and the Drive Picker iframe.
      "frame-src https://challenges.cloudflare.com https://accounts.google.com https://docs.google.com https://content.googleapis.com",
      "frame-ancestors 'none'",
    ].join("; "),
  },
];

// The PostHog reverse proxy (components/posthog-provider.tsx sets api_host "/ingest").
// PostHog's ingestion and asset hosts live under i.posthog.com: us.i.posthog.com for the
// API and us-assets.i.posthog.com for the lazily loaded SDK bundles (exception-autocapture,
// web-vitals, surveys, dead-clicks-autocapture, posthog-recorder). us.posthog.com is the
// app UI (ui_host), and us-assets.posthog.com does not resolve at all, so pointing the
// static rewrite at it made Vercel answer every /ingest/static/*.js with a text/plain 502
// and the browser refused to run them (found 2026-10-23 on production). The static rule
// and /ingest/array rules must come first: /ingest/:path* would otherwise match them too.
// posthog-js posts to /ingest/e/ and /ingest/flags/; Next.js answers those with a 308 to the
// path without the slash before any rewrite runs. That is harmless: 308 keeps the method,
// body and query, the slashless path is rewritten, and PostHog accepts /e and /flags
// (checked 2026-10-23 with next dev), so the site-wide skipTrailingSlashRedirect is not set.
// The browser talks only to 'self' for PostHog, so connect-src needs no asset host.
// Exported for its unit test (next.config.test.ts).
export const POSTHOG_API_HOST = "https://us.i.posthog.com";
export const POSTHOG_ASSETS_HOST = "https://us-assets.i.posthog.com";
export const posthogRewrites = [
  { source: "/ingest/static/:path*", destination: `${POSTHOG_ASSETS_HOST}/static/:path*` },
  // Remote config (/array/<token>/config.js), also served from the asset host.
  { source: "/ingest/array/:path*", destination: `${POSTHOG_ASSETS_HOST}/array/:path*` },
  { source: "/ingest/:path*", destination: `${POSTHOG_API_HOST}/:path*` },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
  async redirects() {
    // Search Console reported a duplicate of the homepage without a
    // user-selected canonical: /index served the same page with a 200.
    // Collapse the legacy index aliases onto the canonical root permanently.
    return [
      { source: "/index", destination: "/", permanent: true },
      { source: "/index.html", destination: "/", permanent: true },
      // The upload-first /guide was retired for the agent path in the docs. Old links and
      // search results land on its replacement.
      { source: "/guide", destination: "/docs/quickstart", permanent: true },
    ];
  },
  // /campaigns, /contacts, /inbox and /activity have no page files, so Next's own
  // not-found handling answers them with a real 404 — but only because proxy.ts's
  // isProtectedRoute doesn't list them either; if it did, the proxy would intercept
  // anonymous requests before Next's filesystem 404 ran and send a 307 to sign-in.
  // Keep all four out of both lists together.
  async rewrites() {
    return posthogRewrites;
  },
};

export default nextConfig;
