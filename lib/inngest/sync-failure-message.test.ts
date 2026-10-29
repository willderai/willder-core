// The line a failed sync stores for the person, per provider and failure: plain
// copy that names the fix, and never the provider's raw answer or anything else
// from the error's message. Slack, Figma and PostHog errors are the ones their
// real connectors throw against a stubbed `fetch`, so a change to a connector's
// wording breaks a row here. Each error is also checked the way a real run
// delivers it: a step that used up its retries reaches `sourceSync`'s catch as
// Inngest's StepError, which keeps only the original name and message.
import { afterEach, describe, expect, it, vi } from "vitest";
import { StepError, serializeError } from "inngest";
import { GitHubConnectorError } from "@/services/connectors/github";
import { DriveRequestError } from "@/services/connectors/gdrive";
import { SOURCE_TYPES } from "@/lib/source-lists";
import { syncFailureMessage } from "./sync-failure-message";

// The mock flags are read when the connectors are imported; the real branches are the ones under test.
vi.hoisted(() => {
  vi.stubEnv("SLACK_MOCK", "false");
  vi.stubEnv("FIGMA_MOCK", "false");
});

/** A token-shaped string planted in every provider answer below; no line may carry it. */
const PLANTED = "xox" + "b-9900112233-4455667788-PlantedSecretAbCdEf";

/** Provider text the rows below send; no line may carry any of it. */
const RAW =
  /Bad credentials|rate limit exceeded for|Validation Failed|raw-drive-text|<html>|\/repos\/|failed:|invalid_auth|token_revoked|Invalid token|throttled|Too Many Requests/;

const githubError = (status: number, body: string) =>
  new GitHubConnectorError(`GitHub /repos/acme/api/issues failed: ${status} ${body}`, status);
const driveError = (status: number, reason: string) =>
  new DriveRequestError(
    "Drive files.list failed",
    status,
    JSON.stringify({ error: { code: status, message: `raw-drive-text ${PLANTED}`, errors: [{ reason }] } }),
  );

/** The error a connector throws when `fetch` answers with `response`. */
async function thrownBy(read: () => Promise<unknown>, response: () => Response): Promise<unknown> {
  vi.stubGlobal("fetch", async () => response());
  return read().then(
    () => {
      throw new Error("the connector did not throw");
    },
    (e: unknown) => e,
  );
}

const httpAnswer =
  (status: number, body: string, statusText = "") =>
  () =>
    new Response(body, { status, statusText });
const slackAnswer = (error: string) => () => Response.json({ ok: false, error, warning: PLANTED });

const slack = async (response: () => Response) =>
  thrownBy(async () => (await import("@/services/connectors/slack")).listChannelMessages("C1", "tok"), response);
const figma = async (response: () => Response) =>
  thrownBy(async () => (await import("@/services/connectors/figma")).listFileComments("file_1", "tok"), response);
const posthog = async (response: () => Response) =>
  thrownBy(
    async () => (await import("@/services/connectors/posthog")).fetchInsightSnapshot("1", "42", "phx_key"),
    response,
  );

afterEach(() => vi.unstubAllGlobals());

describe("syncFailureMessage", () => {
  it.each([
    [
      "github",
      () => githubError(401, `{"message":"Bad credentials ${PLANTED}"}`),
      /rejected this repository's token.*Create a new token.*reconnect it/,
    ],
    [
      "github",
      () => githubError(403, '{"message":"API rate limit exceeded for user ID 1."}'),
      /rate limit stopped this sync.*sync again in an hour/,
    ],
    [
      "github",
      () => githubError(429, '{"message":"You have exceeded a secondary rate limit"}'),
      /rate limit stopped this sync/,
    ],
    [
      "github",
      () => githubError(403, '{"message":"Repository access blocked"}'),
      /refused this sync\. Check that the token can still read the repository/,
    ],
    ["github", () => githubError(502, "<html>Bad gateway</html>"), /error on its side.*Sync again in a few minutes/],
    [
      "github",
      () => githubError(422, '{"message":"Validation Failed"}'),
      /\(HTTP 422\)\. Sync again, and if it fails again, reconnect/,
    ],
    ["gdrive", () => driveError(401, "authError"), /sign-in expired.*Sync again and sign in with Google/],
    // A download names its file last, so a status-like name is never read as the status.
    [
      "gdrive",
      () => new DriveRequestError("Drive file download failed", 401, "{}", 'file "Q3: 500 accounts.pdf"'),
      /sign-in expired/,
    ],
    // Nor does a file name shaped like Drive's reason code choose the line.
    [
      "gdrive",
      () => new DriveRequestError("Drive file download failed", 403, "Forbidden", 'file ""reason":"quotaExceeded""'),
      /refused this sync\. Check that the folder is still shared/,
    ],
    ["gdrive", () => driveError(429, "rateLimitExceeded"), /usage limit stopped this sync/],
    ["gdrive", () => driveError(403, "userRateLimitExceeded"), /usage limit stopped this sync/],
    ["gdrive", () => driveError(403, "dailyLimitExceeded"), /usage limit stopped this sync/],
    [
      "gdrive",
      () => driveError(403, "cannotDownloadFile"),
      /refused this sync\. Check that the folder is still shared/,
    ],
    ["gdrive", () => driveError(503, "backendError"), /error on its side.*Sync again in a few minutes/],
    [
      "gdrive",
      () => driveError(400, "badRequest"),
      /\(HTTP 400\)\. Sync again, and if it fails again, disconnect the folder/,
    ],
    [
      "slack",
      () => slack(slackAnswer("invalid_auth")),
      /rejected this channel's token.*Create a new token and reconnect the channel/,
    ],
    ["slack", () => slack(slackAnswer("token_revoked")), /rejected this channel's token/],
    [
      "slack",
      () => slack(slackAnswer("not_in_channel")),
      /not in the channel\. Add the app to the channel, then sync again/,
    ],
    ["slack", () => slack(slackAnswer("missing_scope")), /channels:history scope.*reconnect the channel/],
    [
      "slack",
      () => slack(slackAnswer("no_permission")),
      /not allowed to read the channel\. Add the app to the channel.*channels:history/,
    ],
    [
      "slack",
      () => slack(slackAnswer("channel_not_found")),
      /can't find this channel.*disconnect this source.*add the token's app/,
    ],
    ["slack", () => slack(slackAnswer("ratelimited")), /Slack's rate limit stopped this sync/],
    ["slack", () => slack(slackAnswer("internal_error")), /Slack had an error on its side/],
    [
      "slack",
      () => slack(slackAnswer("some_new_code")),
      /Slack sync stopped before it finished.*reconnect the channel/,
    ],
    ["slack", () => slack(httpAnswer(429, "", `Too Many Requests ${PLANTED}`)), /Slack's rate limit stopped this sync/],
    ["slack", () => slack(httpAnswer(503, "", `Service Unavailable ${PLANTED}`)), /Slack had an error on its side/],
    [
      "slack",
      () => slack(httpAnswer(400, "", `Bad Request ${PLANTED}`)),
      /\(HTTP 400\).*reconnect the channel with a new token/,
    ],
    ["slack", () => slack(() => Response.json({ ok: true, warning: PLANTED })), /Slack had an error on its side/],
    [
      "figma",
      () => figma(httpAnswer(401, `{"status":401,"err":"Token expired ${PLANTED}"}`)),
      /rejected this file's token.*reconnect the file/,
    ],
    [
      "figma",
      () => figma(httpAnswer(403, `{"status":403,"err":"Invalid token ${PLANTED}"}`)),
      /refused this file's token.*reconnect the file with a new token/,
    ],
    [
      "figma",
      () => figma(httpAnswer(404, `{"status":404,"err":"Not found ${PLANTED}"}`)),
      /can't find this file.*disconnect this source/,
    ],
    [
      "figma",
      () => figma(httpAnswer(429, `{"status":429,"err":"Rate limit ${PLANTED}"}`)),
      /Figma's rate limit stopped this sync/,
    ],
    ["figma", () => figma(httpAnswer(500, `<html>${PLANTED}</html>`)), /Figma had an error on its side/],
    [
      "figma",
      () => figma(httpAnswer(400, `{"err":"${PLANTED}"}`)),
      /\(HTTP 400\).*reconnect the file with a new token/,
    ],
    [
      "posthog",
      () => posthog(httpAnswer(401, `{"detail":"Invalid personal API key ${PLANTED}"}`)),
      /rejected this insight's API key.*reconnect the insight/,
    ],
    [
      "posthog",
      () => posthog(httpAnswer(429, `{"detail":"Request was throttled ${PLANTED}"}`)),
      /PostHog's rate limit stopped this sync/,
    ],
    ["posthog", () => posthog(httpAnswer(502, `<html>${PLANTED}</html>`)), /PostHog had an error on its side/],
    [
      "posthog",
      () => posthog(httpAnswer(400, `{"detail":"${PLANTED}"}`)),
      /\(HTTP 400\).*reconnect the insight with a new API key/,
    ],
  ] as const)(
    "%s: a failed request names the fix, thrown or after a step's retries (row %#)",
    async (type, makeError, line) => {
      const error = await makeError();
      expect(error).toBeInstanceOf(Error);
      for (const delivered of [error, new StepError("list-items", serializeError(error))]) {
        const message = syncFailureMessage(type, delivered);
        expect(message).toMatch(line);
        expect(message).not.toContain(PLANTED);
        expect(message).not.toMatch(RAW);
      }
    },
  );

  // Our own errors carry ids and internals; a dropped connection, or a provider's
  // answer parsed as JSON, carries the provider's text.
  it.each(SOURCE_TYPES)("%s: any other failure gets the provider's one line for it, never the error's text", (type) => {
    const others = [
      new Error(`source src_9's stored credential is missing a token ${PLANTED}`),
      new TypeError(`fetch failed ${PLANTED}`),
      new SyntaxError(`Unexpected token '<', "<html>${PLANTED}" is not valid JSON`),
      // Another provider's failure is not read as this one's.
      type === "github" ? new Error("Slack conversations.history error: invalid_auth") : githubError(401, PLANTED),
      `a thrown string ${PLANTED}`,
      undefined,
    ];
    const lines = new Set(others.map((e) => syncFailureMessage(type, e)));
    expect(lines.size).toBe(1);
    const [line] = lines;
    expect(line).toMatch(/stopped before it finished\. Sync again/);
    expect(line).not.toContain(PLANTED);
    expect(line).not.toMatch(RAW);
  });
});
