// What a failed sync tells the person who connected the source.
//
// A connector's request error carries the provider's raw answer (status, JSON
// body, error codes) so it reads well in logs and in Inngest's run history.
// That text is not for the sources page: "GitHub /repos/a/b failed: 401
// {"message":"Bad credentials"...}" names no fix, and a provider's body can
// echo back what it was sent. `sourceSync` stores this module's line in
// `Source.meta.error` instead, and rethrows the original error unchanged so the
// retry and the run history still see the provider's answer.
//
// The one rule: every line is written here and names what the person can do
// next. No part of an error's message is copied into a line, so nothing a
// provider or our own code put there (a body, a code, an id, a token) reaches
// the page. Losing access to the source is not handled here; it ends the run
// through `endAccessLost` with the connector's own message
// (services/connectors/source-access.ts).
import type { SourceType } from "@/lib/source-lists";

/** A connector request that failed with an HTTP status, read from the error's message. */
type RequestFailure = {
  status: number;
  /** What followed the status: the provider's body. Matched, never shown. */
  text: string;
};

/** The lines one provider's failed syncs get, by what went wrong. */
type ProviderCopy = {
  /** The word the provider's connector starts a failed request's message with. */
  prefix: string;
  /** The provider rejected the credential (401). */
  rejected: string;
  /** A rate limit or a quota, which passes on its own (429, or `isRateLimited`). */
  rateLimited: string;
  /** The provider refused the request for another reason (403). */
  refused: string;
  /** The provider does not have what the source points at (404), where that is not lost access. */
  notFound?: string;
  /** The provider failed on its side (5xx). */
  theirSide: string;
  /** Any other status. */
  otherStatus: (status: number) => string;
  /** Anything that is not a provider answer this module reads: a dropped connection, a missing credential, our own error. */
  unexpected: string;
  /** Whether a failed request is a rate limit although its status is not 429. */
  isRateLimited?: (failure: RequestFailure) => boolean;
};

/** Drive's reason codes for a rate limit or a quota, as against a refusal. */
const DRIVE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
  "dailyLimitExceeded",
]);

/** Drive's reason code inside its JSON error body. */
const DRIVE_REASON = /"reason"\s*:\s*"([A-Za-z]+)"/;

/**
 * Drive's body without the file a download names after it (`DriveRequestError`'s
 * subject), so a file called `"reason":"quotaExceeded"` cannot choose the line.
 */
const driveBody = (text: string) => text.split(' (file "')[0];

/** GitHub's wording on a 403 that is its primary or secondary rate limit. */
const GITHUB_RATE_LIMITED = /rate limit/i;

const COPY: Record<SourceType, ProviderCopy> = {
  github: {
    prefix: "GitHub",
    rejected:
      "GitHub rejected this repository's token. It may have expired or been revoked. Create a new token with read access to the repository and reconnect it.",
    rateLimited: "GitHub's rate limit stopped this sync. Nothing needs changing: sync again in an hour.",
    refused: "GitHub refused this sync. Check that the token can still read the repository, then sync again.",
    theirSide: "GitHub had an error on its side during this sync. Sync again in a few minutes.",
    otherStatus: (status) =>
      `GitHub answered this sync with an error (HTTP ${status}). Sync again, and if it fails again, reconnect the repository with a new token.`,
    unexpected:
      "This GitHub sync stopped before it finished. Sync again, and if it fails again, reconnect the repository with a new token.",
    isRateLimited: ({ status, text }) => status === 403 && GITHUB_RATE_LIMITED.test(text),
  },
  gdrive: {
    prefix: "Drive",
    rejected: "Your Google sign-in expired before this sync finished. Sync again and sign in with Google when asked.",
    rateLimited: "Google Drive's usage limit stopped this sync. Nothing needs changing: sync again in a few minutes.",
    refused:
      "Google Drive refused this sync. Check that the folder is still shared with your Google account, then sync again.",
    theirSide: "Google Drive had an error on its side during this sync. Sync again in a few minutes.",
    otherStatus: (status) =>
      `Google Drive answered this sync with an error (HTTP ${status}). Sync again, and if it fails again, disconnect the folder and connect it again.`,
    unexpected:
      "This Google Drive sync stopped before it finished. Sync again and sign in with Google when asked. If it fails again, disconnect the folder and connect it again.",
    isRateLimited: ({ status, text }) =>
      status === 403 && DRIVE_LIMIT_REASONS.has(DRIVE_REASON.exec(driveBody(text))?.[1] ?? ""),
  },
  slack: {
    prefix: "Slack",
    rejected:
      "Slack rejected this channel's token. It may have been revoked or expired. Create a new token and reconnect the channel.",
    rateLimited: "Slack's rate limit stopped this sync. Nothing needs changing: sync again in a few minutes.",
    refused: "Slack refused this sync. Check that the token's app can still read the channel, then sync again.",
    theirSide: "Slack had an error on its side during this sync. Sync again in a few minutes.",
    otherStatus: (status) =>
      `Slack answered this sync with an error (HTTP ${status}). Sync again, and if it fails again, reconnect the channel with a new token.`,
    unexpected:
      "This Slack sync stopped before it finished. Sync again, and if it fails again, reconnect the channel with a new token.",
  },
  figma: {
    prefix: "Figma",
    rejected:
      "Figma rejected this file's token. It may have expired or been revoked. Create a new token that can read the file's comments and reconnect the file.",
    rateLimited: "Figma's rate limit stopped this sync. Nothing needs changing: sync again in a few minutes.",
    // Figma answers a token it no longer accepts with 403 as often as with 401.
    refused:
      "Figma refused this file's token. It may have expired, or lost access to the file. Check that its account can still open the file, then reconnect the file with a new token.",
    notFound:
      "Figma can't find this file. If it was deleted or moved, disconnect this source and connect the file again from its new link.",
    theirSide: "Figma had an error on its side during this sync. Sync again in a few minutes.",
    otherStatus: (status) =>
      `Figma answered this sync with an error (HTTP ${status}). Sync again, and if it fails again, reconnect the file with a new token.`,
    unexpected:
      "This Figma sync stopped before it finished. Sync again, and if it fails again, reconnect the file with a new token.",
  },
  posthog: {
    prefix: "PostHog",
    rejected:
      "PostHog rejected this insight's API key. It may have expired or been revoked. Create a new personal API key that can read insights and reconnect the insight.",
    rateLimited: "PostHog's rate limit stopped this sync. Nothing needs changing: sync again in a few minutes.",
    refused: "PostHog refused this sync. Check that the API key can still read the project, then sync again.",
    theirSide: "PostHog had an error on its side during this sync. Sync again in a few minutes.",
    otherStatus: (status) =>
      `PostHog answered this sync with an error (HTTP ${status}). Sync again, and if it fails again, reconnect the insight with a new API key.`,
    unexpected:
      "This PostHog sync stopped before it finished. Sync again, and if it fails again, reconnect the insight with a new API key.",
  },
  website: {
    prefix: "Website",
    rejected: "The website refused this sync. Check that its pages are public, then sync again.",
    rateLimited: "The website limited how fast it can be read. Nothing needs changing: sync again in a few minutes.",
    refused: "The website refused this sync. Check that its pages are public, then sync again.",
    theirSide: "The website had an error on its side during this sync. Sync again in a few minutes.",
    otherStatus: (status) =>
      `The website answered this sync with an error (HTTP ${status}). Sync again, and if it fails again, disconnect it and connect it again.`,
    unexpected:
      "This website sync stopped before it finished. Sync again, and if it fails again, disconnect it and connect it again.",
  },
};

/**
 * Slack answers most failures with HTTP 200, `"ok": false` and a code
 * (https://api.slack.com/methods/conversations.history#errors). The codes that
 * name something the person can fix get their own line; the rest read as the
 * kind of failure they are.
 */
const SLACK_CODE_LINES: ReadonlyMap<string, string> = new Map([
  [
    "not_in_channel",
    "The Slack app this token belongs to is not in the channel. Add the app to the channel, then sync again.",
  ],
  [
    "missing_scope",
    "This Slack token can't read channel history. Give its app the channels:history scope (groups:history for a private channel), reinstall the app, and reconnect the channel with its new token.",
  ],
  [
    "no_permission",
    "This Slack token's app is not allowed to read the channel. Add the app to the channel and check it has the channels:history scope (groups:history for a private channel), then sync again.",
  ],
  [
    "channel_not_found",
    "Slack can't find this channel with this token. If the channel was deleted, disconnect this source; otherwise add the token's app to the channel and sync again.",
  ],
]);
const SLACK_REJECTED_CODES = new Set([
  "not_authed",
  "invalid_auth",
  "account_inactive",
  "token_revoked",
  "token_expired",
]);
const SLACK_THEIR_SIDE_CODES = new Set(["fatal_error", "internal_error", "service_unavailable", "request_timeout"]);

/**
 * How connectors word a failed request: "<Provider> <request> failed: <status>
 * <provider's body>" (`get` and `readRepository` in github.ts,
 * `DriveRequestError` in gdrive.ts, `getSlackPage` in slack.ts,
 * `listFileComments` in figma.ts, `fetchInsightSnapshot` in posthog.ts).
 */
const REQUEST_FAILED = /^([A-Za-z]+) [^\n]{0,300}? failed[^:\n]{0,300}: (\d{3})(?: |$)/;

/** Slack's `"ok": false` answer: "Slack <method> error: <code>" (slack.ts). */
const SLACK_ERROR_CODE = /^Slack [a-z.]{1,64} error: ([a-z_]{1,64})$/;

/** Slack's `"ok": true` answer that carried no messages list (`getSlackPage`). */
const SLACK_EMPTY_ANSWER = /^Slack [a-z.]{1,64} answered ok with no messages list$/;

/** The failed request in `message`, when it is `prefix`'s. */
function requestFailure(prefix: string, message: string): RequestFailure | null {
  const failed = REQUEST_FAILED.exec(message);
  if (!failed || failed[1] !== prefix) return null;
  return { status: Number(failed[2]), text: message.slice(failed[0].length) };
}

function slackCodeLine(copy: ProviderCopy, code: string): string {
  const own = SLACK_CODE_LINES.get(code);
  if (own) return own;
  if (SLACK_REJECTED_CODES.has(code)) return copy.rejected;
  if (code === "ratelimited") return copy.rateLimited;
  if (SLACK_THEIR_SIDE_CODES.has(code)) return copy.theirSide;
  return copy.unexpected;
}

function statusLine(copy: ProviderCopy, failure: RequestFailure): string {
  const { status } = failure;
  if (status === 401) return copy.rejected;
  if (status === 429 || copy.isRateLimited?.(failure)) return copy.rateLimited;
  if (status === 403) return copy.refused;
  if (status === 404 && copy.notFound) return copy.notFound;
  if (status >= 500) return copy.theirSide;
  return copy.otherStatus(status);
}

/**
 * The line `Source.meta.error` shows for a sync of a `type` source that failed
 * with `e`: chosen by the provider's HTTP status or error code when `e` is that
 * provider's failed request, else the provider's line for a sync that stopped
 * early. Never any of `e`'s own text.
 *
 * `e` is read by its message alone: once a step uses up its retries, Inngest
 * hands `sourceSync` a `StepError` that keeps the original name and message and
 * drops every other field, `status` included.
 */
export function syncFailureMessage(type: SourceType, e: unknown): string {
  const copy = COPY[type];
  const message = e instanceof Error ? e.message : "";
  if (type === "slack") {
    const code = SLACK_ERROR_CODE.exec(message)?.[1];
    if (code) return slackCodeLine(copy, code);
    if (SLACK_EMPTY_ANSWER.test(message)) return copy.theirSide;
  }
  const failure = requestFailure(copy.prefix, message);
  return failure ? statusLine(copy, failure) : copy.unexpected;
}
