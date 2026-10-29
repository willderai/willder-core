// The requests the Integrations panels send to change a source (connect, sync,
// disconnect), and what each failure says to the person who clicked.
//
// The rule this file keeps: such a request never hangs and never fails silently.
// - Each one gives up after SOURCE_REQUEST_TIMEOUT_MS.
// - Every failure becomes plain sentences that name what to do next.
// - Only a validation refusal (400) is quoted, because the routes write those for people
//   ("token is required for github"). A 403's reason is written for the audit log (user
//   ids, actions) and a 5xx's can carry a downstream service's raw error, so neither is.
// - When the outcome is unknown (no answer, a timeout, a 504), the message says the
//   action may have happened and to check the list before trying again.
// - A request ends with the panel that sent it: the panel passes `useUnmountSignal()`,
//   so a hung request does not keep its timer, or set state, after the panel is gone.

import { useCallback, useEffect, useRef } from "react";

export type SourceAction = "connect" | "sync" | "disconnect";

/** How long a connect, sync or disconnect may take before the panel stops waiting. */
export const SOURCE_REQUEST_TIMEOUT_MS = 45_000;

/** A route's answer: its status and its JSON body, or null when the body was not JSON. */
export type SourceAnswer = { status: number; ok: boolean; body: Record<string, unknown> | null };

const MAY_HAVE_HAPPENED: Record<SourceAction, string> = {
  connect: "The connect may have gone through.",
  sync: "The sync may have been requested.",
  disconnect: "The disconnect may have gone through.",
};
const CHECK_FIRST = "Check the sources list before trying again.";

/**
 * Sends one request and reads its JSON body. Throws an Error whose message is the
 * sentence to show when no answer arrives, or none arrives in time.
 *
 * `init.signal` is the sender's own lifetime (see `useUnmountSignal`): when it aborts,
 * the request is cancelled and its timer cleared.
 */
export async function sourceRequest(action: SourceAction, url: string, init: RequestInit = {}): Promise<SourceAnswer> {
  const { signal: senderSignal, ...rest } = init;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, SOURCE_REQUEST_TIMEOUT_MS);
  const cancel = () => controller.abort();
  if (senderSignal?.aborted) controller.abort();
  senderSignal?.addEventListener("abort", cancel, { once: true });
  try {
    const res = await fetch(url, { ...rest, signal: controller.signal });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: res.status, ok: res.ok, body: body !== null && typeof body === "object" ? body : null };
  } catch {
    const lead = timedOut
      ? `Willder did not answer within ${SOURCE_REQUEST_TIMEOUT_MS / 1000} seconds.`
      : "Could not reach Willder.";
    throw new Error(`${lead} ${MAY_HAVE_HAPPENED[action]} ${CHECK_FIRST}`);
  } finally {
    clearTimeout(timer);
    senderSignal?.removeEventListener("abort", cancel);
  }
}

/**
 * The calling component's lifetime as an AbortSignal getter: the signal aborts when the
 * component unmounts. A getter, because the signal is made by an effect, so a mount
 * that React runs twice in development gets a live one.
 */
export function useUnmountSignal(): () => AbortSignal | undefined {
  const life = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    life.current = controller;
    return () => controller.abort();
  }, []);
  return useCallback(() => life.current?.signal, []);
}

/** The route's own sentence, when it sent one. */
function reasonOf(body: Record<string, unknown> | null): string | null {
  const error = body?.error;
  return typeof error === "string" && error.trim() !== "" ? error.trim() : null;
}

/** `text` with exactly one closing full stop, so another sentence can follow it. */
function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

const NOT_DONE: Record<SourceAction, string> = {
  connect: "so it was not connected",
  sync: "so no sync was requested",
  disconnect: "so it is still connected",
};

/** What a failed answer says, naming the fix. */
export function sourceFailureMessage(
  action: SourceAction,
  { status, body }: Pick<SourceAnswer, "status" | "body">,
): string {
  const reason = reasonOf(body);
  if (status === 401) return `Your session has ended, ${NOT_DONE[action]}. Sign in again, then try again.`;
  if (status === 403) {
    const scope = action === "disconnect" ? "every scope this source's content is in" : "this source's scope";
    return `You do not have write access to ${scope}, ${NOT_DONE[action]}. Ask an admin of this organization for that access.`;
  }
  if (status === 429) return `Too many requests in a short time, ${NOT_DONE[action]}. Wait a minute, then try again.`;
  if (status === 504)
    return `Willder did not finish answering in time (HTTP 504). ${MAY_HAVE_HAPPENED[action]} ${CHECK_FIRST}`;
  if (status === 404 && action !== "connect")
    return "This source is no longer here. Reload the list to see it as it is now.";
  if (status === 409 && action !== "connect")
    return `This source changed since the list loaded (it may be disconnected or already syncing), ${NOT_DONE[action]}. Reload the list, then try again.`;
  // Both 5xx answers of DELETE /api/sources/:id are failures to remove the source's
  // content, sent before anything is disconnected (app/api/sources/[id]/route.ts).
  if (status >= 500 && action === "disconnect") {
    return `Willder could not remove this source's content from memory (HTTP ${status}), so it is still connected. Try again in a minute.`;
  }
  if (status >= 500) {
    const lead = `Willder could not ${action} it (HTTP ${status}).`;
    // A connect is an upsert on the source, so sending it again cannot add a second copy.
    return action === "connect"
      ? `${lead} Try again in a minute; connecting it again never adds a second copy.`
      : `${lead} Try again in a minute.`;
  }
  return status === 400 && reason
    ? `${sentence(reason)} Fix that, then try again.`
    : `Willder refused this (HTTP ${status}). Reload the page, then try again.`;
}
