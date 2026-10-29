// The one Inngest client every job registers on. Separate from the jobs so a
// job module can import the client without importing its siblings.
//
// The one rule this file enforces: a deployed copy always runs in cloud mode.
// In dev mode the SDK skips request signing on /api/inngest, so anyone who can
// reach the URL can run any job with any payload. Left to the SDK, the mode
// follows INNGEST_DEV, which means one stray environment variable on a
// deployment would open that door. A production build (`next start`, or any
// Vercel deployment, preview included, since Vercel sets VERCEL_ENV on all of
// them) is pinned to cloud mode, so an unsigned call is refused. Under
// `next dev`, INNGEST_DEV still decides.
import { Inngest } from "inngest";

const deployed = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL_ENV);

export const inngest = new Inngest({ id: "willder", ...(deployed ? { isDev: false } : {}) });
