// The official MCP conformance suite's reference fixtures, served to a connection that asks for
// them with `X-Willder-Conformance: fixtures`.
//
// @modelcontextprotocol/conformance proves a server implements a protocol feature by calling
// fixtures with fixed names and fixed content: a tool `test_image_content`, a resource
// `test://static-text`, a prompt `test_simple_prompt`, an elicitation with the defaults "John
// Doe", 30 and 95.5, and so on (each scenario's description in the suite names its fixture and
// the reply it expects). No server passes the suite without serving them. Willder's own
// resources and prompts (mcp/resources.ts, mcp/prompts.ts) cannot carry those names, so this
// file serves the suite's, beside Willder's real ones, through the same server, transport and
// client-request relay (mcp/client-requests.ts) a real feature would use.
//
// The one rule: the fixtures read and write no memory, and are listed only to a connection that
// asks for them, so an agent never sees a test tool among the tools its model is shown. They
// run behind the same bearer authentication as every other call. The capabilities only they
// use (logging, resource subscriptions) are declared on that connection only.
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import {
  CreateMessageResultSchema,
  ElicitResultSchema,
  ErrorCode,
  McpError,
  SetLevelRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { askClient, type Asker } from "./client-requests";

/** The request header a connection asks for the fixtures with. */
export const CONFORMANCE_HEADER = "x-willder-conformance";

/**
 * Whether `caller` may be served the fixtures: only an org/agent pair that
 * MCP_CONFORMANCE_AGENTS lists (comma-separated `orgId/agentId`). Unset or empty means nobody.
 * A fixture call can hold a request open for 30 s and reads no memory, so no check() stands in
 * its way; an ordinary token sending the header gets a plain connection. The conformance suite runs
 * with a dedicated agent, in an org with no memory, listed here.
 */
export function conformanceFixturesAllowed(
  caller: { orgId: string; agentId: string },
  env: Record<string, string | undefined> = process.env,
): boolean {
  const listed = (env.MCP_CONFORMANCE_AGENTS ?? "")
    .split(",")
    .map((pair) => pair.trim())
    .filter((pair) => pair !== "");
  return listed.includes(`${caller.orgId}/${caller.agentId}`);
}

/** Whether a connection's {@link CONFORMANCE_HEADER} value asks for the fixtures: "fixtures", in any case. */
export function conformanceFixturesRequested(value: string | null): boolean {
  return value?.trim().toLowerCase() === "fixtures";
}

/** A 1x1 PNG, the suite's "minimal test image". */
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

/** A WAV file with a header and no samples, the suite's "minimal test audio file". */
const WAV_EMPTY = "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

/** The resource the suite subscribes to and unsubscribes from. */
const WATCHED_RESOURCE_URI = "test://watched-resource";

const COMPLETION_WORDS = ["paris", "park", "party"];

function text(value: string) {
  return { type: "text" as const, text: value };
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Register every fixture the suite's required server scenarios call onto `server`, before it
 * connects. A request the fixtures send the client is asked as `asker`, so only that caller's
 * reply is taken.
 */
export function registerConformanceFixtures(server: McpServer, asker: Asker): void {
  // logging/setLevel is accepted and answered, but this stateless endpoint keeps no level
  // between requests, so the logging fixture sends its three info messages whatever was set.
  server.server.registerCapabilities({ logging: {}, resources: { subscribe: true } });
  server.server.setRequestHandler(SetLevelRequestSchema, async () => ({}));
  registerFixtureTools(server, asker);
  registerFixtureResources(server);
  registerFixturePrompts(server);
}

function registerFixtureTools(server: McpServer, asker: Asker): void {
  server.registerTool(
    "test_simple_text",
    { description: "Conformance fixture: returns one text block." },
    async () => ({
      content: [text("This is a simple text response for testing.")],
    }),
  );
  server.registerTool("test_image_content", { description: "Conformance fixture: returns one image." }, async () => ({
    content: [{ type: "image", data: PNG_1X1, mimeType: "image/png" }],
  }));
  server.registerTool(
    "test_audio_content",
    { description: "Conformance fixture: returns one audio clip." },
    async () => ({
      content: [{ type: "audio", data: WAV_EMPTY, mimeType: "audio/wav" }],
    }),
  );
  server.registerTool(
    "test_embedded_resource",
    { description: "Conformance fixture: returns one embedded resource." },
    async () => ({
      content: [
        {
          type: "resource",
          resource: {
            uri: "test://embedded-resource",
            mimeType: "text/plain",
            text: "This is an embedded resource content.",
          },
        },
      ],
    }),
  );
  server.registerTool(
    "test_multiple_content_types",
    { description: "Conformance fixture: returns text, an image and a resource." },
    async () => ({
      content: [
        text("Multiple content types test:"),
        { type: "image", data: PNG_1X1, mimeType: "image/png" },
        {
          type: "resource",
          resource: {
            uri: "test://mixed-content-resource",
            mimeType: "application/json",
            text: '{"test":"data","value":123}',
          },
        },
      ],
    }),
  );
  server.registerTool("test_error_handling", { description: "Conformance fixture: always fails." }, async () => ({
    content: [text("This tool intentionally returns an error for testing")],
    isError: true,
  }));
  server.registerTool(
    "test_tool_with_logging",
    { description: "Conformance fixture: sends three log messages while it runs." },
    async (extra) => {
      for (const [i, data] of [
        "Tool execution started",
        "Tool processing data",
        "Tool execution completed",
      ].entries()) {
        if (i > 0) await pause(50);
        await extra.sendNotification({ method: "notifications/message", params: { level: "info", data } });
      }
      return { content: [text("Tool with logging executed successfully")] };
    },
  );
  server.registerTool(
    "test_tool_with_progress",
    { description: "Conformance fixture: reports progress 0, 50 and 100 of 100." },
    async (extra) => {
      const progressToken = extra._meta?.progressToken;
      if (progressToken !== undefined) {
        for (const [i, progress] of [0, 50, 100].entries()) {
          if (i > 0) await pause(50);
          await extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken, progress, total: 100 },
          });
        }
      }
      return { content: [text(String(progressToken ?? "no progress token"))] };
    },
  );

  server.registerTool(
    "test_sampling",
    {
      description: "Conformance fixture: asks the client's model to answer a prompt.",
      inputSchema: { prompt: z.string().describe("The prompt to send to the LLM") },
    },
    async ({ prompt }, extra) =>
      answered(async () => {
        const result = await askClient(
          server,
          extra,
          asker,
          {
            method: "sampling/createMessage",
            params: { messages: [{ role: "user", content: text(prompt) }], maxTokens: 100 },
          },
          CreateMessageResultSchema,
        );
        return `LLM response: ${result.content.type === "text" ? result.content.text : `[${result.content.type}]`}`;
      }),
  );
  server.registerTool(
    "test_elicitation",
    {
      description: "Conformance fixture: asks the client's user for a name and an email.",
      inputSchema: { message: z.string().describe("The message to show the user") },
    },
    async ({ message }, extra) =>
      answered(async () => {
        const requestedSchema = {
          type: "object",
          properties: {
            username: { type: "string", description: "User's response" },
            email: { type: "string", description: "User's email address" },
          },
          required: ["username", "email"],
        };
        const result = await askClient(
          server,
          extra,
          asker,
          { method: "elicitation/create", params: { message, requestedSchema } },
          ElicitResultSchema,
        );
        return `User response: action=${result.action}, content=${JSON.stringify(result.content ?? {})}`;
      }),
  );
  server.registerTool(
    "test_elicitation_sep1034_defaults",
    { description: "Conformance fixture: asks the client's user with a default for every primitive type." },
    async (extra) =>
      answered(async () => {
        const requestedSchema = {
          type: "object",
          properties: {
            name: { type: "string", description: "User name", default: "John Doe" },
            age: { type: "integer", description: "User age", default: 30 },
            score: { type: "number", description: "User score", default: 95.5 },
            status: {
              type: "string",
              description: "User status",
              enum: ["active", "inactive", "pending"],
              default: "active",
            },
            verified: { type: "boolean", description: "Verification status", default: true },
          },
        };
        const result = await askClient(
          server,
          extra,
          asker,
          {
            method: "elicitation/create",
            params: { message: "Please review and update the form fields with defaults", requestedSchema },
          },
          ElicitResultSchema,
        );
        return `Elicitation completed: action=${result.action}, content=${JSON.stringify(result.content ?? {})}`;
      }),
  );
  server.registerTool(
    "test_elicitation_sep1330_enums",
    { description: "Conformance fixture: asks the client's user with all five enum forms." },
    async (extra) =>
      answered(async () => {
        const options = ["option1", "option2", "option3"];
        const requestedSchema = {
          type: "object",
          properties: {
            untitledSingle: { type: "string", description: "Untitled single-select", enum: options },
            titledSingle: {
              type: "string",
              description: "Titled single-select",
              oneOf: [
                { const: "value1", title: "First Option" },
                { const: "value2", title: "Second Option" },
                { const: "value3", title: "Third Option" },
              ],
            },
            legacyEnum: {
              type: "string",
              description: "Legacy titled enum",
              enum: ["opt1", "opt2", "opt3"],
              enumNames: ["Option One", "Option Two", "Option Three"],
            },
            untitledMulti: {
              type: "array",
              description: "Untitled multi-select",
              items: { type: "string", enum: options },
            },
            titledMulti: {
              type: "array",
              description: "Titled multi-select",
              items: {
                anyOf: [
                  { const: "value1", title: "First Choice" },
                  { const: "value2", title: "Second Choice" },
                  { const: "value3", title: "Third Choice" },
                ],
              },
            },
          },
        };
        const result = await askClient(
          server,
          extra,
          asker,
          {
            method: "elicitation/create",
            params: { message: "Please select options from the enum fields", requestedSchema },
          },
          ElicitResultSchema,
        );
        return `Elicitation completed: action=${result.action}, content=${JSON.stringify(result.content ?? {})}`;
      }),
  );
}

/** A tool reply carrying `run`'s text, or, when asking the client failed, the reason as an error reply. */
async function answered(run: () => Promise<string>): Promise<CallToolResult> {
  try {
    return { content: [text(await run())] };
  } catch (e) {
    return { content: [text(e instanceof Error ? e.message : String(e))], isError: true };
  }
}

function registerFixtureResources(server: McpServer): void {
  server.registerResource(
    "static-text",
    "test://static-text",
    { description: "Conformance fixture: a text resource.", mimeType: "text/plain" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: "This is the content of the static text resource." }],
    }),
  );
  server.registerResource(
    "static-binary",
    "test://static-binary",
    { description: "Conformance fixture: a binary resource.", mimeType: "image/png" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "image/png", blob: PNG_1X1 }],
    }),
  );
  server.registerResource(
    "watched-resource",
    WATCHED_RESOURCE_URI,
    { description: "Conformance fixture: a resource a client subscribes to.", mimeType: "text/plain" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: "Watched resource content" }],
    }),
  );
  server.registerResource(
    "template-data",
    new ResourceTemplate("test://template/{id}/data", { list: undefined }),
    { description: "Conformance fixture: a resource template.", mimeType: "application/json" },
    async (uri, { id }) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ id, templateTest: true, data: `Data for ID: ${String(id)}` }),
        },
      ],
    }),
  );
  // A subscription is accepted for the watched fixture only. This stateless endpoint keeps no
  // subscription and sends no update for one; Willder's own resources are not subscribable, and
  // memory_changes is where a client reads what changed.
  const subscribable = (uri: string) => {
    if (uri !== WATCHED_RESOURCE_URI)
      throw new McpError(
        ErrorCode.InvalidParams,
        "This resource cannot be subscribed to; read memory_changes for what changed.",
        { uri },
      );
    return {};
  };
  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => subscribable(request.params.uri));
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => subscribable(request.params.uri));
}

function registerFixturePrompts(server: McpServer): void {
  server.registerPrompt(
    "test_simple_prompt",
    { description: "Conformance fixture: a prompt without arguments." },
    async () => ({
      messages: [{ role: "user", content: text("This is a simple prompt for testing.") }],
    }),
  );
  server.registerPrompt(
    "test_prompt_with_arguments",
    {
      description: "Conformance fixture: a prompt with two arguments, the first completable.",
      argsSchema: {
        arg1: completable(z.string().describe("First test argument"), (value) =>
          COMPLETION_WORDS.filter((word) => word.startsWith(value)),
        ),
        arg2: z.string().describe("Second test argument"),
      },
    },
    async ({ arg1, arg2 }) => ({
      messages: [{ role: "user", content: text(`Prompt with arguments: arg1='${arg1}', arg2='${arg2}'`) }],
    }),
  );
  server.registerPrompt(
    "test_prompt_with_embedded_resource",
    {
      description: "Conformance fixture: a prompt that embeds a resource.",
      argsSchema: { resourceUri: z.string().describe("URI of the resource to embed") },
    },
    async ({ resourceUri }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "resource",
            resource: { uri: resourceUri, mimeType: "text/plain", text: "Embedded resource content for testing." },
          },
        },
        { role: "user", content: text("Please process the embedded resource above.") },
      ],
    }),
  );
  server.registerPrompt(
    "test_prompt_with_image",
    { description: "Conformance fixture: a prompt with an image." },
    async () => ({
      messages: [
        { role: "user", content: { type: "image", data: PNG_1X1, mimeType: "image/png" } },
        { role: "user", content: text("Please analyze the image above.") },
      ],
    }),
  );
}
