/**
 * Reports unhandled server errors to PostHog error tracking.
 *
 * The one rule: reporting never changes what the request does. It is off
 * unless NEXT_PUBLIC_POSTHOG_KEY is set, it sends only the error and the
 * route it happened on (never headers, bodies, query strings or cookies,
 * which can carry tokens), and any failure to report is swallowed.
 */

const DEFAULT_HOST = "https://us.i.posthog.com";
const REPORT_TIMEOUT_MS = 2000;

/** Where the error happened, as Next.js describes it. */
export interface ServerErrorContext {
  method: string;
  /** Request path; any query string is removed before sending. */
  path: string;
  routePath: string;
  routeType: string;
}

/** Strips the query string and fragment, which may carry tokens. */
export function pathWithoutQuery(path: string): string {
  return path.split(/[?#]/, 1)[0];
}

/** Builds the PostHog `$exception` event body, or null when reporting is off. */
export function buildExceptionEvent(
  error: unknown,
  context: ServerErrorContext,
  apiKey: string | undefined,
): Record<string, unknown> | null {
  if (!apiKey) return null;
  const err = error instanceof Error ? error : new Error(String(error));
  const digest = (err as Error & { digest?: string }).digest;
  return {
    api_key: apiKey,
    event: "$exception",
    distinct_id: "willder-server",
    properties: {
      $exception_list: [{ type: err.name, value: err.message, mechanism: { handled: false, synthetic: false } }],
      $exception_stack_trace_raw: err.stack ?? null,
      $process_person_profile: false,
      digest: digest ?? null,
      method: context.method,
      path: pathWithoutQuery(context.path),
      route_path: context.routePath,
      route_type: context.routeType,
      runtime: "server",
    },
  };
}

/** Sends one server error to PostHog. Never throws. */
export async function reportServerError(
  error: unknown,
  context: ServerErrorContext,
  send: typeof fetch = fetch,
): Promise<void> {
  try {
    const body = buildExceptionEvent(error, context, process.env.NEXT_PUBLIC_POSTHOG_KEY);
    if (!body) return;
    const host = (process.env.POSTHOG_HOST || DEFAULT_HOST).replace(/\/+$/, "");
    await send(`${host}/i/v0/e/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
  } catch {
    // Error reporting is optional; a failed report must not surface to the request.
  }
}
