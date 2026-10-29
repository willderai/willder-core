// Covers the first client-matrix claim without touching the network: the
// endpoint is a stub, so these tests check what the probe is willing to call
// verified, which is the part a reader has to trust.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseConnectPage, type ConnectConfig, type ConnectPlan } from "./connect-config";
import { fillPlaceholder, MCP_PROTOCOL_VERSION, probeTransport, TRANSPORT_TIMEOUT_MS } from "./mcp-transport-probe";

const ENDPOINT = "https://willder.test/api/mcp";
const TOKEN = "wcap_test_value";

function headerPage(options: { url?: string; header?: string } = {}): ConnectConfig {
  const url = options.url ?? ENDPOINT;
  const header = options.header ?? "Bearer ${WILLDER_TOKEN}";
  const markdown = [
    "# Example",
    "## Config file",
    "```json",
    `{ "mcpServers": { "willder": { "type": "http", "url": "${url}", "headers": { "Authorization": "${header}" } } } }`,
    "```",
  ].join("\n");
  return parseConnectPage(markdown, "example");
}

/** A stub endpoint that answers the way production does. */
function serverThatWorks(expectedHeader: string): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if ((init?.method ?? "GET") === "GET") {
      return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (headers.get("authorization") !== expectedHeader) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }
    const body = JSON.parse(String(init?.body)) as { method: string; id?: number };
    if (body.method === "notifications/initialized") return new Response("", { status: 202 });
    const result =
      body.method === "initialize"
        ? { protocolVersion: MCP_PROTOCOL_VERSION, serverInfo: { name: "willder" } }
        : body.method === "tools/list"
          ? { tools: [{ name: "memory_query" }, { name: "memory_entity" }, { name: "memory_ingest" }] }
          : { content: [{ type: "text", text: "a fact, cited" }] };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("probeTransport on a header client", () => {
  it("verifies a config that points at the endpoint and sends the committed header", async () => {
    const result = await probeTransport(headerPage(), {
      url: ENDPOINT,
      token: TOKEN,
      fetch: serverThatWorks(`Bearer ${TOKEN}`),
    });
    expect(result.status).toBe("verified");
    expect(result.steps.map((step) => step.name)).toContain("tools/list");
  });

  it("fails a config that points somewhere other than the endpoint under test", async () => {
    const result = await probeTransport(headerPage({ url: "https://elsewhere.test/api/mcp" }), {
      url: ENDPOINT,
      token: TOKEN,
      fetch: serverThatWorks(`Bearer ${TOKEN}`),
    });
    expect(result.status).toBe("failed");
    expect(result.steps[0].detail).toContain("not the endpoint under test");
  });

  it("fails when the endpoint serves a client without a token", async () => {
    const alwaysOk = (async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const result = await probeTransport(headerPage(), { url: ENDPOINT, token: TOKEN, fetch: alwaysOk });
    expect(result.status).toBe("failed");
    expect(result.steps.find((step) => step.name === "refuses an absent or wrong token")?.ok).toBe(false);
  });

  it("fails when a GET is answered as something a legacy SSE client could half-complete", async () => {
    const working = serverThatWorks(`Bearer ${TOKEN}`);
    const oddGet = (async (input: string | URL, init?: RequestInit) =>
      (init?.method ?? "GET") === "GET"
        ? new Response("", { status: 200, headers: { "content-type": "text/plain" } })
        : working(input as string, init)) as unknown as typeof fetch;
    const result = await probeTransport(headerPage(), { url: ENDPOINT, token: TOKEN, fetch: oddGet });
    expect(result.status).toBe("failed");
    expect(result.steps.find((step) => step.name === "no legacy SSE handshake")?.ok).toBe(false);
  });
});

describe("probeTransport on a page with no config", () => {
  const noConfig = parseConnectPage("# Example\n\nNothing to configure.\n", "example");

  it("records an OAuth-only client as unsupported, never as a pass", async () => {
    const notFound = (async (input: string | URL) =>
      String(input).includes("well-known")
        ? new Response("", { status: 404 })
        : new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })) as unknown as typeof fetch;
    const result = await probeTransport(noConfig, { url: ENDPOINT, token: TOKEN, fetch: notFound }, "oauth-only");
    expect(result.status).toBe("unsupported");
  });

  it("records a product with no MCP client as not applicable, with no request made", async () => {
    const refuse = (() => {
      throw new Error("a not-applicable row must make no request");
    }) as unknown as typeof fetch;
    const result = await probeTransport(noConfig, { url: ENDPOINT, token: TOKEN, fetch: refuse }, "no-mcp-client");
    expect(result.status).toBe("not-applicable");
  });

  it("fails a page that lost its config block and claims no reason", async () => {
    const result = await probeTransport(noConfig, { url: ENDPOINT, token: TOKEN });
    expect(result.status).toBe("failed");
    expect(result.steps[0].detail).toContain("commits no connection config");
  });

  it("fails a page recorded as OAuth-only that has started committing a config", async () => {
    const result = await probeTransport(headerPage(), { url: ENDPOINT, token: TOKEN }, "oauth-only");
    expect(result.status).toBe("failed");
    expect(result.steps[0].detail).toContain("oauth-only");
  });
});

describe("fillPlaceholder", () => {
  it("substitutes the client's own interpolation form", () => {
    expect(fillPlaceholder("Bearer ${env:WILLDER_TOKEN}", "${env:WILLDER_TOKEN}", TOKEN)).toBe(`Bearer ${TOKEN}`);
  });
});

// ── Each step's own guard ────────────────────────────────────────────────────
//
// The steps above check a working endpoint and three broken ones. These check
// one requirement at a time, because a probe whose steps can be weakened one by
// one without a red test is a probe that reports "verified" for nothing.

/** The stub endpoint above, with one method's answer replaced. */
function serverExcept(
  expectedHeader: string,
  override: (method: string, headers: Headers) => Response | undefined,
): typeof fetch {
  const working = serverThatWorks(expectedHeader);
  return (async (input: string | URL, init?: RequestInit) => {
    const method =
      (init?.method ?? "GET") === "GET" ? "GET" : (JSON.parse(String(init?.body)) as { method: string }).method;
    return override(method, new Headers(init?.headers)) ?? working(input as string, init);
  }) as unknown as typeof fetch;
}

async function stepOf(config: ConnectConfig, name: string, fetchImpl: typeof fetch) {
  const result = await probeTransport(config, { url: ENDPOINT, token: TOKEN, fetch: fetchImpl });
  return { result, step: result.steps.find((candidate) => candidate.name === name) };
}

describe("the committed-config step", () => {
  it("fails a credential that is not a bearer value", async () => {
    const { result } = await stepOf(
      headerPage({ header: "Token ${WILLDER_TOKEN}" }),
      "committed config",
      serverThatWorks(""),
    );
    expect(result.status).toBe("failed");
    expect(result.steps[0].detail).toContain("not a bearer value");
  });

  it("fails a credential with no interpolation placeholder", async () => {
    // The page reader skips a literal credential, so this shape only reaches the
    // probe when a plan is built by hand — which is exactly when it must be caught.
    const plan: ConnectPlan = {
      shape: "direct-header",
      url: ENDPOINT,
      header: { name: "Authorization", template: "Bearer paste-it-here", placeholder: "${WILLDER_TOKEN}" },
      declaredTransport: "http",
      source: { kind: "json", firstLine: "{", body: "{}" },
    };
    const config: ConnectConfig = {
      client: "example",
      page: "docs/connect/example.md",
      shape: "direct-header",
      primary: plan,
      alternatives: [],
    };
    const { result } = await stepOf(config, "committed config", serverThatWorks(""));
    expect(result.status).toBe("failed");
    expect(result.steps[0].detail).toContain("no interpolation placeholder");
  });

  it("makes no request at all once the committed config is unfollowable", async () => {
    const refuse = (() => {
      throw new Error("a probe must not call the endpoint when the config cannot be followed");
    }) as unknown as typeof fetch;
    const result = await probeTransport(headerPage({ url: "https://elsewhere.test/api/mcp" }), {
      url: ENDPOINT,
      token: TOKEN,
      fetch: refuse,
    });
    expect(result.steps).toHaveLength(1);
  });

  it("fails a bridge argv that sets no Authorization header", async () => {
    const result = await probeTransport(bridgeConfig({ args: ["-y", "mcp-remote@0.14.3", ENDPOINT] }), {
      url: ENDPOINT,
      token: TOKEN,
    });
    expect(result.status).toBe("failed");
    expect(result.steps[0].detail).toContain("sets no Authorization header");
  });

  it("fails a bridge header argument written with a space after the colon", async () => {
    const result = await probeTransport(
      bridgeConfig({ args: ["-y", "mcp-remote@0.14.3", ENDPOINT, "Authorization: ${AUTH}"] }),
      { url: ENDPOINT, token: TOKEN },
    );
    expect(result.status).toBe("failed");
    expect(result.steps[0].detail).toContain("space after the colon");
  });
});

describe("the direct path's steps", () => {
  it("fails an initialize that answers 200 without a protocol version", async () => {
    const { result, step } = await stepOf(
      headerPage(),
      "initialize",
      serverExcept(`Bearer ${TOKEN}`, (method) =>
        method === "initialize"
          ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "willder" } } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          : undefined,
      ),
    );
    expect(step?.ok).toBe(false);
    expect(result.status).toBe("failed");
  });

  it("fails an initialize that carries a protocol version under a non-200 status", async () => {
    const { step } = await stepOf(
      headerPage(),
      "initialize",
      serverExcept(`Bearer ${TOKEN}`, (method) =>
        method === "initialize"
          ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: MCP_PROTOCOL_VERSION } }), {
              status: 500,
              headers: { "content-type": "application/json" },
            })
          : undefined,
      ),
    );
    expect(step?.ok).toBe(false);
  });

  it("fails when the initialized notification is rejected", async () => {
    const { step } = await stepOf(
      headerPage(),
      "notifications/initialized",
      serverExcept(`Bearer ${TOKEN}`, (method) =>
        method === "notifications/initialized" ? new Response("", { status: 500 }) : undefined,
      ),
    );
    expect(step?.ok).toBe(false);
  });

  it("fails when tools/list is missing one of Willder's tools", async () => {
    const { step } = await stepOf(
      headerPage(),
      "tools/list",
      serverExcept(`Bearer ${TOKEN}`, (method) =>
        method === "tools/list"
          ? new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                result: { tools: [{ name: "memory_query" }, { name: "memory_entity" }] },
              }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              },
            )
          : undefined,
      ),
    );
    expect(step?.ok).toBe(false);
    expect(step?.detail).toContain("memory_ingest");
  });

  it("fails a memory_query that answers with no text", async () => {
    const { step } = await stepOf(
      headerPage(),
      "memory_query",
      serverExcept(`Bearer ${TOKEN}`, (method) =>
        method === "tools/call"
          ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 3, result: { content: [] } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          : undefined,
      ),
    );
    expect(step?.ok).toBe(false);
  });

  it("fails a memory_query the server marks as an error, even when it carries text", async () => {
    const { step } = await stepOf(
      headerPage(),
      "memory_query",
      serverExcept(`Bearer ${TOKEN}`, (method) =>
        method === "tools/call"
          ? new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 3,
                result: { isError: true, content: [{ type: "text", text: "scope denied" }] },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            )
          : undefined,
      ),
    );
    expect(step?.ok).toBe(false);
  });

  it("fails when a wrong token is served, even though an absent one is refused", async () => {
    const { step } = await stepOf(
      headerPage(),
      "refuses an absent or wrong token",
      serverExcept(`Bearer ${TOKEN}`, (method, headers) =>
        method === "tools/list" && headers.get("authorization")?.includes("not_a_real_capability_token")
          ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 5, result: { tools: [] } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          : undefined,
      ),
    );
    expect(step?.ok).toBe(false);
  });

  it("fails when an absent token is served, even though a wrong one is refused", async () => {
    const { step } = await stepOf(
      headerPage(),
      "refuses an absent or wrong token",
      serverExcept(`Bearer ${TOKEN}`, (method, headers) =>
        method === "tools/list" && headers.get("authorization") === null
          ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 4, result: { tools: [] } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          : undefined,
      ),
    );
    expect(step?.ok).toBe(false);
  });

  it("fails a GET that is 200 but not an event stream, which a legacy client could half-complete", async () => {
    const { step } = await stepOf(
      headerPage(),
      "no legacy SSE handshake",
      serverExcept(`Bearer ${TOKEN}`, (method) =>
        method === "GET"
          ? new Response("", { status: 200, headers: { "content-type": "application/json" } })
          : undefined,
      ),
    );
    expect(step?.ok).toBe(false);
  });
});

describe("an alternative path the same page commits", () => {
  it("fails the row when the alternative path does not answer", async () => {
    const primary = headerPage().primary!;
    const alternative: ConnectPlan = {
      ...primary,
      url: "https://elsewhere.test/api/mcp",
      source: { ...primary.source, kind: "yaml" },
    };
    const config: ConnectConfig = {
      client: "example",
      page: "docs/connect/example.md",
      shape: "direct-header",
      primary,
      alternatives: [alternative],
    };
    const result = await probeTransport(config, {
      url: ENDPOINT,
      token: TOKEN,
      fetch: serverThatWorks(`Bearer ${TOKEN}`),
    });
    expect(result.status).toBe("failed");
    expect(result.steps.at(-1)?.ok).toBe(false);
    expect(result.steps.at(-1)?.name).toContain("alternative");
  });
});

describe("the OAuth-only row", () => {
  const noConfig = parseConnectPage("# Example\n\nNothing to configure.\n", "example");

  it("fails the metadata step when the endpoint has started serving authorization-server metadata", async () => {
    const serving = (async (input: string | URL) =>
      String(input).includes("oauth-authorization-server")
        ? new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })) as unknown as typeof fetch;
    const result = await probeTransport(noConfig, { url: ENDPOINT, token: TOKEN, fetch: serving }, "oauth-only");
    expect(result.steps.find((step) => step.name.includes("oauth-authorization-server"))?.ok).toBe(false);
  });

  it("fails the refusal step when an unauthenticated call is served", async () => {
    const open = (async (input: string | URL) =>
      String(input).includes("well-known")
        ? new Response("", { status: 404 })
        : new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch;
    const result = await probeTransport(noConfig, { url: ENDPOINT, token: TOKEN, fetch: open }, "oauth-only");
    expect(result.steps.find((step) => step.name === "unauthenticated call refused")?.ok).toBe(false);
  });
});

// ── The bridge path ─────────────────────────────────────────────────────────
//
// These run a real child process over a real stdio pipe, so the argv, the `env`
// block and the newline-delimited exchange are all exercised as written. The
// child is this Node binary with a short inline program instead of
// `mcp-remote`, which keeps the test offline without mocking the part under test.

/** A bridge plan whose command is a Node program this test supplies. */
function bridgeConfig(over: { args?: string[]; program?: string }): ConnectConfig {
  // `Authorization:${AUTH}` is the `--header` argument the real bridge configs
  // commit; it is passed bare here because Node would read a `--header` flag of
  // its own as one of its options.
  const args = over.args ?? ["-e", over.program ?? "", "Authorization:${AUTH}"];
  const plan: ConnectPlan = {
    shape: "bridge",
    url: ENDPOINT,
    declaredTransport: "stdio-bridge",
    bridge: {
      command: process.execPath,
      args,
      pinnedPackage: "mcp-remote@0.14.3",
      envName: "AUTH",
      envTemplate: "Bearer ${WILLDER_TOKEN}",
      placeholder: "${WILLDER_TOKEN}",
    },
    source: { kind: "json", firstLine: "{", body: "{}" },
  };
  return { client: "example", page: "docs/connect/example.md", shape: "bridge", primary: plan, alternatives: [] };
}

/**
 * A stand-in bridge: it answers the ids named in `answers`, and only after it
 * has read the header out of its environment, so a token that never reached the
 * child produces no answers at all. The value it expects arrives in
 * `BRIDGE_EXPECTED_AUTH` rather than in the program text, because the program
 * text is argv and the token must never be there.
 */
function bridgeProgram(answers: Record<number, unknown>): string {
  return `
    const answers = ${JSON.stringify(answers)};
    const expected = process.env.BRIDGE_EXPECTED_AUTH;
    let buffered = "";
    process.stdin.on("data", (chunk) => {
      buffered += chunk;
      const lines = buffered.split("\\n");
      buffered = lines.pop();
      let done = false;
      for (const line of lines) {
        if (!line.trim()) continue;
        const request = JSON.parse(line);
        if (request.id === undefined) continue;
        if (request.id === 3) done = true;
        if (process.env.AUTH !== expected) continue;
        const result = answers[String(request.id)];
        if (result !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
      }
      // An empty write's callback fires after the answers above have flushed down
      // the pipe, which process.exit on its own would truncate.
      if (done) process.stdout.write("", () => process.exit(0));
    });
  `;
}

const WORKING_BRIDGE = {
  1: { protocolVersion: MCP_PROTOCOL_VERSION, serverInfo: { name: "willder" } },
  2: { tools: [{ name: "memory_query" }, { name: "memory_entity" }, { name: "memory_ingest" }] },
  3: { content: [{ type: "text", text: "a fact, cited" }] },
};

describe("probeTransport on a bridge client", () => {
  beforeAll(() => {
    process.env.BRIDGE_EXPECTED_AUTH = `Bearer ${TOKEN}`;
  });
  afterAll(() => {
    delete process.env.BRIDGE_EXPECTED_AUTH;
  });

  it("verifies a bridge that initialises, lists Willder's tools and answers, with the token only in its environment", async () => {
    const result = await probeTransport(bridgeConfig({ program: bridgeProgram(WORKING_BRIDGE) }), {
      url: ENDPOINT,
      token: TOKEN,
    });
    expect(result.steps.map((step) => [step.name, step.ok])).toEqual([
      ["committed config", true],
      ["token stays out of the command line", true],
      ["initialize through the bridge", true],
      ["tools/list", true],
      ["memory_query", true],
    ]);
    expect(result.status).toBe("verified");
  });

  it("fails a bridge whose argv carries the token, so it would show up in a process list", async () => {
    const config = bridgeConfig({
      args: ["-e", bridgeProgram(WORKING_BRIDGE), `Authorization:Bearer ${TOKEN}`],
    });
    const result = await probeTransport(config, { url: ENDPOINT, token: TOKEN });
    expect(result.steps.find((step) => step.name === "token stays out of the command line")?.ok).toBe(false);
    expect(result.status).toBe("failed");
  });

  it("fails a bridge that never returns an initialize result", async () => {
    const { 1: _initialize, ...withoutInitialize } = WORKING_BRIDGE;
    const result = await probeTransport(bridgeConfig({ program: bridgeProgram(withoutInitialize) }), {
      url: ENDPOINT,
      token: TOKEN,
    });
    expect(result.steps.find((step) => step.name === "initialize through the bridge")?.ok).toBe(false);
    expect(result.status).toBe("failed");
  });

  it("keeps why a bridge stopped: the exit code and the end of its stderr, not the startup log", async () => {
    // mcp-remote prints several lines of startup log before anything can fail,
    // so a detail cut from the start of stderr never reaches the reason.
    const banner = "[1] Using callback port derived from the server URL: 10886\\n".repeat(8);
    const program = `process.stderr.write(${JSON.stringify(banner)} + "Error: upstream answered HTTP 503\\n", () => process.exit(1));`;
    const result = await probeTransport(bridgeConfig({ program }), { url: ENDPOINT, token: TOKEN });
    const initialize = result.steps.find((step) => step.name === "initialize through the bridge");
    expect(initialize?.ok).toBe(false);
    expect(initialize?.detail).toMatch(/^exit 1: .*Error: upstream answered HTTP 503$/);
  });

  it("keeps the JSON-RPC error a bridge returned instead of a result", async () => {
    const program = `
      process.stdin.once("data", () => {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "upstream refused the session" } }) + "\\n", () => process.exit(0));
      });
    `;
    const result = await probeTransport(bridgeConfig({ program }), { url: ENDPOINT, token: TOKEN });
    expect(result.steps.find((step) => step.name === "initialize through the bridge")?.detail).toBe(
      "JSON-RPC error: upstream refused the session",
    );
  });

  it("never shows the token from the end of a failed bridge's stderr", async () => {
    const program = `process.stderr.write("sent Authorization: " + process.env.AUTH + "\\n", () => process.exit(1));`;
    const result = await probeTransport(bridgeConfig({ program }), { url: ENDPOINT, token: TOKEN });
    const detail = result.steps.find((step) => step.name === "initialize through the bridge")?.detail ?? "";
    expect(detail).toContain("sent Authorization: Bearer");
    expect(detail).not.toContain(TOKEN);
  });

  it("scrubs the token before cutting stderr, so a cut through the token leaves no piece of it", async () => {
    // A token that is not wcap_-shaped, so only the exact-token scrub can catch
    // it, placed so the kept tail would start partway into it.
    const token = "plain-capability-0123456789";
    const program = `process.stderr.write("a".repeat(400) + process.env.AUTH.slice("Bearer ".length) + "b".repeat(290), () => process.exit(1));`;
    process.env.BRIDGE_EXPECTED_AUTH = `Bearer ${token}`;
    try {
      const result = await probeTransport(bridgeConfig({ program }), { url: ENDPOINT, token });
      const detail = result.steps.find((step) => step.name === "initialize through the bridge")?.detail ?? "";
      expect(detail).toContain("<token>");
      expect(detail).not.toContain(token.slice(-8));
    } finally {
      process.env.BRIDGE_EXPECTED_AUTH = `Bearer ${TOKEN}`;
    }
  });

  it("says a bridge that never answers was killed at the timeout, with what it printed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const program = `process.stderr.write("connecting to upstream\\n"); setInterval(() => {}, 1 << 30);`;
      const pending = probeTransport(bridgeConfig({ program }), { url: ENDPOINT, token: TOKEN });
      // Real time for the child to start and print (setImmediate and Date stay
      // real), then fake time past the limit.
      const startedBy = Date.now() + 1_500;
      while (Date.now() < startedBy) await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(TRANSPORT_TIMEOUT_MS);
      const result = await pending;
      const initialize = result.steps.find((step) => step.name === "initialize through the bridge");
      expect(result.status).toBe("failed");
      expect(initialize?.detail).toBe(
        `no reply within ${TRANSPORT_TIMEOUT_MS / 1000} s, killed: connecting to upstream`,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs the bridge with npm preferring its cache, so a registry round trip is not part of the check", async () => {
    // \`npx -y\` otherwise revalidates the pinned package against the registry on
    // every launch; this stand-in answers only when that is switched off.
    const program = bridgeProgram(WORKING_BRIDGE).replace(
      "const expected = process.env.BRIDGE_EXPECTED_AUTH;",
      'const expected = process.env.npm_config_prefer_offline === "true" ? process.env.BRIDGE_EXPECTED_AUTH : "registry revalidation is on";',
    );
    const result = await probeTransport(bridgeConfig({ program }), { url: ENDPOINT, token: TOKEN });
    expect(result.status).toBe("verified");
  });

  it("waits for every reply when the bridge answers out of order, as mcp-remote does with concurrent requests", async () => {
    // mcp-remote forwards the three requests upstream concurrently, so the
    // memory_query reply can arrive before initialize's. This stand-in answers
    // 3 first, then 1 and 2 well after the probe's poll interval, and then stays
    // up the way mcp-remote does, so only the probe's own wait decides the rows.
    const program = `
      const answers = ${JSON.stringify(WORKING_BRIDGE)};
      const reply = (id) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: answers[id] }) + "\\n");
      process.stdin.once("data", () => {
        reply(3);
        setTimeout(() => reply(1), 600);
        setTimeout(() => reply(2), 900);
      });
      setInterval(() => {}, 1 << 30);
    `;
    const result = await probeTransport(bridgeConfig({ program }), { url: ENDPOINT, token: TOKEN });
    expect(result.steps.map((step) => [step.name, step.ok])).toEqual([
      ["committed config", true],
      ["token stays out of the command line", true],
      ["initialize through the bridge", true],
      ["tools/list", true],
      ["memory_query", true],
    ]);
  });

  it("counts a JSON-RPC error as an answer, so one refused request does not hold the exchange open", async () => {
    const program = `
      process.stdin.once("data", () => {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 3, error: { code: -32603, message: "query refused" } }) + "\\n");
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: ${JSON.stringify(WORKING_BRIDGE[1])} }) + "\\n");
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 2, result: ${JSON.stringify(WORKING_BRIDGE[2])} }) + "\\n");
      });
      setInterval(() => {}, 1 << 30);
    `;
    // The stand-in never exits, so a probe still waiting here would run into the test timeout.
    const result = await probeTransport(bridgeConfig({ program }), { url: ENDPOINT, token: TOKEN });
    expect(result.steps.find((step) => step.name === "initialize through the bridge")?.ok).toBe(true);
    expect(result.steps.find((step) => step.name === "memory_query")?.detail).toBe("JSON-RPC error: query refused");
  });

  it("reassembles a reply that reaches stdout in two chunks", async () => {
    // A large memory_query result can outgrow one pipe read, so a line can end in
    // a later chunk than it started. The probe must join it, not drop it.
    const program = `
      const answers = ${JSON.stringify(WORKING_BRIDGE)};
      const line = (id) => JSON.stringify({ jsonrpc: "2.0", id, result: answers[id] }) + "\\n";
      process.stdin.once("data", () => {
        const split = line(1);
        process.stdout.write(split.slice(0, 20));
        setTimeout(() => process.stdout.write(split.slice(20) + line(2) + line(3)), 400);
      });
      setInterval(() => {}, 1 << 30);
    `;
    const result = await probeTransport(bridgeConfig({ program }), { url: ENDPOINT, token: TOKEN });
    expect(result.steps.find((step) => step.name === "initialize through the bridge")?.ok).toBe(true);
    expect(result.steps.find((step) => step.name === "memory_query")?.ok).toBe(true);
  });

  it("fails a bridge that never returns a tools/list result", async () => {
    const { 2: _list, ...withoutList } = WORKING_BRIDGE;
    const result = await probeTransport(bridgeConfig({ program: bridgeProgram(withoutList) }), {
      url: ENDPOINT,
      token: TOKEN,
    });
    expect(result.steps.find((step) => step.name === "tools/list")?.ok).toBe(false);
    expect(result.status).toBe("failed");
  });

  it("fails a bridge whose tools/list is missing one of Willder's tools", async () => {
    const result = await probeTransport(
      bridgeConfig({ program: bridgeProgram({ ...WORKING_BRIDGE, 2: { tools: [{ name: "memory_query" }] } }) }),
      { url: ENDPOINT, token: TOKEN },
    );
    expect(result.steps.find((step) => step.name === "tools/list")?.detail).toContain("memory_ingest");
    expect(result.status).toBe("failed");
  });

  it("fails a bridge whose memory_query answers nothing", async () => {
    const result = await probeTransport(
      bridgeConfig({ program: bridgeProgram({ ...WORKING_BRIDGE, 3: { content: [] } }) }),
      { url: ENDPOINT, token: TOKEN },
    );
    expect(result.steps.find((step) => step.name === "memory_query")?.ok).toBe(false);
    expect(result.status).toBe("failed");
  });

  it("fails a bridge whose memory_query is marked an error, even when it carries text", async () => {
    const result = await probeTransport(
      bridgeConfig({
        program: bridgeProgram({
          ...WORKING_BRIDGE,
          3: { isError: true, content: [{ type: "text", text: "scope denied" }] },
        }),
      }),
      { url: ENDPOINT, token: TOKEN },
    );
    expect(result.steps.find((step) => step.name === "memory_query")?.ok).toBe(false);
    expect(result.status).toBe("failed");
  });
});
