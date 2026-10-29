// Covers the reader that turns a committed connect page into a connection plan.
// It runs against the real pages, because a page losing its config block is
// exactly the drift this reader exists to catch.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConnectConfigError,
  configSection,
  materializeConfig,
  parseConnectPage,
  type ConnectShape,
} from "./connect-config";

const PAGES = join(__dirname, "..", "..", "docs", "connect");
const ENDPOINT = "https://willder.ai/api/mcp";

function page(client: string): string {
  return readFileSync(join(PAGES, `${client}.md`), "utf8");
}

/** What each committed page is expected to configure. */
const EXPECTED: Record<string, ConnectShape> = {
  "claude-code": "direct-header",
  "codex-cli": "direct-header",
  continue: "direct-header",
  cursor: "direct-header",
  "gemini-cli": "direct-header",
  goose: "direct-header",
  hermes: "direct-header",
  langchain: "direct-header",
  "open-webui": "direct-header",
  "openai-agents-sdk": "direct-header",
  "vercel-ai-sdk": "direct-header",
  "vscode-copilot": "direct-header",
  windsurf: "direct-header",
  cline: "bridge",
  "lm-studio": "bridge",
  "claude-desktop": "bridge",
  openclaw: "bridge",
  zed: "bridge",
  "claude-ai-web": "none",
  chatgpt: "none",
  ollama: "none",
};

describe("the committed connect pages", () => {
  it("has an expectation for every page", () => {
    const clients = readdirSync(PAGES)
      .filter((name) => name.endsWith(".md") && name !== "README.md")
      .map((name) => name.replace(/\.md$/, ""))
      .sort();
    expect(clients).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [client, shape] of Object.entries(EXPECTED)) {
    it(`reads ${client} as ${shape}`, () => {
      const config = parseConnectPage(page(client), client);
      expect(config.shape).toBe(shape);
      if (shape === "none") {
        expect(config.primary).toBeUndefined();
        return;
      }
      expect(config.primary?.url).toBe(ENDPOINT);
      const bridge = config.primary?.bridge;
      const credential =
        shape === "bridge"
          ? { template: bridge?.envTemplate, placeholder: bridge?.placeholder }
          : { template: config.primary?.header?.template, placeholder: config.primary?.header?.placeholder };
      expect(credential.template).toMatch(/^Bearer /);
      expect(credential.template).toContain(credential.placeholder);
    });
  }

  it("pins one mcp-remote release across every bridge config", () => {
    const pinned = new Set(
      Object.entries(EXPECTED)
        .filter(([, shape]) => shape === "bridge")
        .map(([client]) => parseConnectPage(page(client), client).primary!.bridge!.pinnedPackage),
    );
    expect([...pinned]).toHaveLength(1);
  });

  // The README states counts a reader will believe. It said two pages committed
  // an alternative path when four did, so the counts are checked rather than
  // maintained by hand.
  it("states the alternative-path count the pages actually commit", () => {
    const withAlternatives = Object.keys(EXPECTED)
      .filter((client) => parseConnectPage(page(client), client).alternatives.length > 0)
      .sort();
    expect(withAlternatives).toEqual(["claude-code", "cline", "openclaw"]);
    const readme = readFileSync(join(PAGES, "README.md"), "utf8");
    const alternativePaths = Object.keys(EXPECTED).reduce(
      (total, client) => total + parseConnectPage(page(client), client).alternatives.length,
      0,
    );
    expect(readme).toContain(`the three alternative paths that three of those pages also commit`);
    expect(alternativePaths).toBe(3);
    for (const client of withAlternatives) expect(readme).toContain(`(${client}.md)`);
  });

  it("keeps the no-space rule in every bridge header argument", () => {
    for (const [client, shape] of Object.entries(EXPECTED)) {
      if (shape !== "bridge") continue;
      const args = parseConnectPage(page(client), client).primary!.bridge!.args;
      expect(args.find((arg) => arg.startsWith("Authorization"))).not.toMatch(/^Authorization:\s/);
    }
  });
});

describe("parseConnectPage", () => {
  it("refuses a page that commits a literal capability token", () => {
    const markdown = '## Config\n\n```json\n{ "headers": { "Authorization": "Bearer wcap_abc123def456" } }\n```\n';
    expect(() => parseConnectPage(markdown, "leaky")).toThrow(ConnectConfigError);
  });

  it("reads only the config section, not a token or verify section", () => {
    const markdown = [
      "# Title",
      "## Get a token",
      "```sh",
      `export WILLDER_TOKEN='<your capability token>'`,
      "```",
      "## Config",
      "```json",
      `{ "url": "${ENDPOINT}", "headers": { "Authorization": "Bearer \${WILLDER_TOKEN}" } }`,
      "```",
      "## Verify the connection",
      "```sh",
      `curl ${ENDPOINT}`,
      "```",
    ].join("\n");
    expect(configSection(markdown)).toContain('"url"');
    expect(configSection(markdown)).not.toContain("curl");
    const config = parseConnectPage(markdown, "example");
    expect(config.primary?.source.kind).toBe("json");
  });

  it("reads only the Config section, even when an earlier section commits a usable-looking config", () => {
    // A "Get a token" section's curl example has a URL and an Authorization
    // header too. It is not the config a reader pastes into the client.
    const markdown = [
      "# Title",
      "## Get a token",
      "```sh",
      `curl ${ENDPOINT}/tokens -H "Authorization: Bearer \${WILLDER_ADMIN}"`,
      "```",
      "## Config",
      "```json",
      `{ "url": "${ENDPOINT}", "headers": { "Authorization": "Bearer \${WILLDER_TOKEN}" } }`,
      "```",
    ].join("\n");
    const config = parseConnectPage(markdown, "example");
    expect(config.primary?.source.kind).toBe("json");
    expect(config.primary?.header?.template).toBe("Bearer ${WILLDER_TOKEN}");
    expect(config.alternatives).toHaveLength(0);
  });

  it("commits no config when the page has no Config section at all", () => {
    const markdown = [
      "# Title",
      "## Verify the connection",
      "```json",
      `{ "url": "${ENDPOINT}", "headers": { "Authorization": "Bearer \${WILLDER_TOKEN}" } }`,
      "```",
    ].join("\n");
    expect(parseConnectPage(markdown, "example").shape).toBe("none");
  });

  it("stops the Config section at the next heading", () => {
    const markdown = [
      "## Config",
      "```json",
      `{ "url": "${ENDPOINT}", "headers": { "Authorization": "Bearer \${WILLDER_TOKEN}" } }`,
      "```",
      "## Verify the connection",
      "```json",
      `{ "url": "https://elsewhere.test/api/mcp", "headers": { "Authorization": "Bearer \${OTHER}" } }`,
      "```",
    ].join("\n");
    expect(parseConnectPage(markdown, "example").alternatives).toHaveLength(0);
  });

  it("skips a config block that commits no URL", () => {
    const markdown = [
      "## Config",
      "```json",
      `{ "headers": { "Authorization": "Bearer \${WILLDER_TOKEN}" } }`,
      "```",
    ].join("\n");
    expect(parseConnectPage(markdown, "example").shape).toBe("none");
  });

  it("skips a config block that sets no Authorization header", () => {
    const markdown = ["## Config", "```json", `{ "url": "${ENDPOINT}" }`, "```"].join("\n");
    expect(parseConnectPage(markdown, "example").shape).toBe("none");
  });

  it("skips a config whose credential is a pasted literal rather than an interpolation", () => {
    const markdown = [
      "## Config",
      "```json",
      `{ "url": "${ENDPOINT}", "headers": { "Authorization": "Bearer paste-it-here" } }`,
      "```",
    ].join("\n");
    expect(parseConnectPage(markdown, "example").shape).toBe("none");
  });

  it("reads a graphical client's field table as the primary path, ahead of any block on the page", () => {
    const markdown = [
      "## Config",
      "| Field | Value |",
      "| --- | --- |",
      `| URL | ${ENDPOINT} |`,
      "| Request headers | `Authorization` = `Bearer <your capability token>` |",
      "",
      "```json",
      `{ "url": "${ENDPOINT}", "headers": { "Authorization": "Bearer \${WILLDER_TOKEN}" } }`,
      "```",
    ].join("\n");
    const config = parseConnectPage(markdown, "example");
    expect(config.primary?.source.kind).toBe("table");
    expect(config.alternatives.map((plan) => plan.source.kind)).toEqual(["json"]);
  });

  it("does not read a field table that names no Authorization row as a connection", () => {
    const markdown = ["## Config", "| Field | Value |", "| --- | --- |", `| URL | ${ENDPOINT} |`].join("\n");
    expect(parseConnectPage(markdown, "example").shape).toBe("none");
  });

  it("rejects a bridge config whose args interpolate nothing, so the token would be on the command line", () => {
    const markdown = [
      "## Config",
      "```json",
      '{ "command": "npx", "args": ["-y", "mcp-remote@0.14.3", "' +
        ENDPOINT +
        '", "--header", "Authorization:Bearer literal"] }',
      "```",
    ].join("\n");
    expect(() => parseConnectPage(markdown, "example")).toThrow(/interpolate/);
  });

  // Every bridge config error below would otherwise be read as "this page simply
  // commits no bridge", which is how a broken config becomes an unprobed row.
  const bridgeBlock = (inner: string): string => ["## Config", "```json", `{ ${inner} }`, "```"].join("\n");

  it("refuses a config that runs mcp-remote with no version pin", () => {
    const markdown = bridgeBlock(
      `"command": "npx", "args": ["-y", "mcp-remote", "${ENDPOINT}", "--header", "Authorization:\${AUTH}"], "env": { "AUTH": "Bearer \${WILLDER_TOKEN}" }`,
    );
    expect(() => parseConnectPage(markdown, "example")).toThrow(/no @version pin/);
  });

  // A dist-tag moves, so it is not a pin: `@latest` fetches whatever is newest
  // at the moment a reader pastes the config.
  it("refuses a config that pins mcp-remote to a dist-tag instead of a release", () => {
    const markdown = bridgeBlock(
      `"command": "npx", "args": ["-y", "mcp-remote@latest", "${ENDPOINT}", "--header", "Authorization:\${AUTH}"], "env": { "AUTH": "Bearer \${WILLDER_TOKEN}" }`,
    );
    expect(() => parseConnectPage(markdown, "example")).toThrow(/no @version pin/);
  });

  it("refuses a bridge config that commits no args array", () => {
    expect(() => parseConnectPage(bridgeBlock(`"command": "npx", "note": "mcp-remote@0.14.3"`), "example")).toThrow(
      /commits no "args" array/,
    );
  });

  it("refuses a bridge config whose args array is not valid JSON", () => {
    const markdown = ["## Config", "```json", `{ "command": "npx", "args": ["-y", "mcp-remote@0.14.3",] }`, "```"].join(
      "\n",
    );
    expect(() => parseConnectPage(markdown, "example")).toThrow(/not valid JSON/);
  });

  it("refuses a bridge config whose args are not all strings", () => {
    expect(() =>
      parseConnectPage(bridgeBlock(`"command": "npx", "args": ["-y", "mcp-remote@0.14.3", 7]`), "example"),
    ).toThrow(/not an array of strings/);
  });

  it("refuses a bridge config that commits no command", () => {
    const markdown = bridgeBlock(
      `"args": ["-y", "mcp-remote@0.14.3", "${ENDPOINT}", "--header", "Authorization:\${AUTH}"], "env": { "AUTH": "Bearer \${WILLDER_TOKEN}" }`,
    );
    expect(() => parseConnectPage(markdown, "example")).toThrow(/commits no "command"/);
  });

  it("refuses a bridge config whose args read a variable no env entry sets", () => {
    const markdown = bridgeBlock(
      `"command": "npx", "args": ["-y", "mcp-remote@0.14.3", "${ENDPOINT}", "--header", "Authorization:\${AUTH}"]`,
    );
    expect(() => parseConnectPage(markdown, "example")).toThrow(/no "env" entry sets it/);
  });

  it("refuses a bridge config whose env entry is a pasted token rather than a placeholder", () => {
    const markdown = bridgeBlock(
      `"command": "npx", "args": ["-y", "mcp-remote@0.14.3", "${ENDPOINT}", "--header", "Authorization:\${AUTH}"], "env": { "AUTH": "Bearer paste-it-here" }`,
    );
    expect(() => parseConnectPage(markdown, "example")).toThrow(/commits no token placeholder/);
  });
});

describe("materializeConfig", () => {
  it("puts the token in the file when the client has no interpolation", () => {
    const plan = parseConnectPage(page("goose"), "goose").primary!;
    const materialized = materializeConfig(plan, "wcap_test_value");
    expect(materialized.text).toContain("Bearer wcap_test_value");
    expect(materialized.env).toEqual({});
  });

  it("leaves the file alone and names the variable when the client interpolates", () => {
    const plan = parseConnectPage(page("codex-cli"), "codex-cli").primary!;
    const materialized = materializeConfig(plan, "wcap_test_value");
    expect(materialized.text).not.toContain("wcap_test_value");
    expect(materialized.env).toEqual({ WILLDER_TOKEN: "wcap_test_value" });
  });

  it("strips the client's own interpolation syntax from the variable name", () => {
    const plan = parseConnectPage(page("cursor"), "cursor").primary!;
    expect(materializeConfig(plan, "wcap_test_value").env).toEqual({ WILLDER_TOKEN: "wcap_test_value" });
  });
});
