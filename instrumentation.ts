// Next.js server hooks. register() runs once when a server instance starts, before it
// serves a request; onRequestError() runs for every unhandled server error.
//
// The one rule: a server missing a required variable says so at startup in one line
// naming it (lib/required-env.ts), instead of starting, reporting "Ready", and then
// answering every request with a database or SDK stack trace. A server you start
// yourself exits; a Vercel deployment logs the line and stays up (see
// checkServerStartupEnv for why). A production server whose NEXT_PUBLIC_APP_URL cannot
// name its public origin logs that too and keeps serving (app/api/mcp/origin.ts).
// Unhandled errors after startup go to error tracking.
import type { Instrumentation } from "next";

/** Next.js startup hook: report, in one line, a web server started without its required environment. */
export async function register(): Promise<void> {
  // The edge runtime has no process.exit, and `next build` runs without the runtime's
  // variables. The import stays inside the Node.js branch so the edge bundle never sees it.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { WEB_SERVER_ENV, checkServerStartupEnv } = await import("./lib/required-env");
  checkServerStartupEnv(WEB_SERVER_ENV, "willder web server");

  // Not a boot variable, so the server keeps serving: without it every page and every
  // native MCP client works, and only the hosted MCP clients that send an Origin are
  // refused. A production server says so here instead of refusing them silently.
  if (process.env.NODE_ENV !== "production") return;
  const { publicOriginConfigProblem } = await import("./app/api/mcp/origin");
  const problem = publicOriginConfigProblem(process.env.NEXT_PUBLIC_APP_URL);
  if (problem) console.error(`willder web server: ${problem}`);
}

/**
 * Next.js calls this for every unhandled server error: a thrown route
 * handler, server action or server render. Errors a route catches and turns
 * into its own response do not arrive here.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { reportServerError } = await import("./lib/error-tracking");
  await reportServerError(error, {
    method: request.method,
    path: request.path,
    routePath: context.routePath,
    routeType: context.routeType,
  });
};
