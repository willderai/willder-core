// Covers the conformance check itself on a clean clone: every transport is a
// stub, so these tests need no network, no token and no deployed endpoint.
import { describe, expect, it } from "vitest";
import {
  CLIENT_CLASSES,
  ConformanceConfigError,
  formatReport,
  classifyLegacySse,
  readOptions,
  REQUIRED_TOOLS,
  runConformance,
  type ConformanceClient,
  type ConformanceDeps,
  type ConformanceOptions,
} from "./mcp-conformance";

const OPTIONS: ConformanceOptions = {
  url: "https://example.test/api/mcp",
  token: "test-token",
  expectSse: "unsupported",
  skipBridge: false,
};

function okClient(overrides: Partial<ConformanceClient> = {}): ConformanceClient {
  return {
    listTools: async () => ({ tools: REQUIRED_TOOLS.map((name) => ({ name })) }),
    callTool: async () => ({ content: [{ type: "text", text: "no facts found" }] }),
    close: async () => {},
    ...overrides,
  };
}

/**
 * The default endpoint stub: unauthenticated POSTs are refused with 401 and GET
 * is answered with 405, which is the shape the connect pages describe.
 */
function endpoint(getResponse = () => new Response(null, { status: 405 })) {
  return async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    (init?.method ?? "GET") === "GET" ? getResponse() : new Response(null, { status: 401 });
}

function eventStream(): Response {
  return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
}

function sseStep(report: Awaited<ReturnType<typeof runConformance>>) {
  return report.steps.find((s) => s.step === "legacy SSE probe");
}

function deps(overrides: Partial<ConformanceDeps> = {}): ConformanceDeps {
  return {
    connectHttp: async () => okClient(),
    connectSse: () => Promise.reject(new Error("no endpoint event")),
    connectBridge: async () => okClient(),
    fetch: endpoint(),
    now: () => 0,
    ...overrides,
  };
}

describe("readOptions", () => {
  it("reads the endpoint and token from the environment", () => {
    const options = readOptions({ WILLDER_MCP_URL: "https://willder.ai/api/mcp", WILLDER_TOKEN: "t" }, []);
    expect(options).toEqual({
      url: "https://willder.ai/api/mcp",
      token: "t",
      expectSse: "unsupported",
      skipBridge: false,
    });
  });

  it("names the missing endpoint rather than defaulting to one", () => {
    expect(() => readOptions({ WILLDER_TOKEN: "t" }, [])).toThrow(/WILLDER_MCP_URL is not set/);
    expect(() => readOptions({ WILLDER_TOKEN: "t" }, [])).toThrow(ConformanceConfigError);
  });

  it("names the missing token", () => {
    expect(() => readOptions({ WILLDER_MCP_URL: "https://willder.ai/api/mcp" }, [])).toThrow(
      /WILLDER_TOKEN is not set/,
    );
  });

  it("rejects an endpoint that is not a URL", () => {
    expect(() => readOptions({ WILLDER_MCP_URL: "willder.ai", WILLDER_TOKEN: "t" }, [])).toThrow(/not a valid URL/);
  });

  it("accepts the documented flags and rejects an unknown --expect-sse value", () => {
    const env = { WILLDER_MCP_URL: "https://willder.ai/api/mcp", WILLDER_TOKEN: "t" };
    expect(readOptions(env, ["--expect-sse=supported", "--skip-bridge"])).toMatchObject({
      expectSse: "supported",
      skipBridge: true,
    });
    expect(() => readOptions(env, ["--expect-sse=maybe"])).toThrow(/--expect-sse must be/);
  });
});

describe("classifyLegacySse", () => {
  it("reads a 405 as the transport simply not being served", () => {
    expect(classifyLegacySse(405, "application/json")).toBe("not-served");
  });

  it("reads a 200 event stream as the Streamable HTTP stream, not legacy SSE", () => {
    expect(classifyLegacySse(200, "text/event-stream")).toBe("stream-opened");
  });

  it("treats anything else as a problem to report", () => {
    expect(classifyLegacySse(401, "application/json")).toBe("unexpected");
    expect(classifyLegacySse(500, null)).toBe("unexpected");
    expect(classifyLegacySse(200, "application/json")).toBe("unexpected");
  });
});

describe("runConformance", () => {
  it("passes when the endpoint behaves the way the matrix requires", async () => {
    const report = await runConformance(OPTIONS, deps());
    expect(report.ok).toBe(true);
    expect(report.steps.map((s) => s.status)).toEqual(["pass", "pass", "pass", "pass", "pass"]);
  });

  it("fails and names the header clients when a tool is missing from tools/list", async () => {
    const report = await runConformance(
      OPTIONS,
      deps({ connectHttp: async () => okClient({ listTools: async () => ({ tools: [{ name: "memory_query" }] }) }) }),
    );
    expect(report.ok).toBe(false);
    const failure = report.steps.find((s) => s.status === "fail");
    expect(failure?.clientClass).toBe(CLIENT_CLASSES.header);
    expect(failure?.detail).toContain("memory_entity");
  });

  it("fails when the scoped memory_query comes back as a tool error", async () => {
    const report = await runConformance(
      OPTIONS,
      deps({
        connectHttp: async () =>
          okClient({ callTool: async () => ({ isError: true, content: [{ type: "text", text: "Access denied" }] }) }),
      }),
    );
    expect(report.ok).toBe(false);
    expect(report.steps[0]).toMatchObject({ status: "fail", clientClass: CLIENT_CLASSES.header });
    expect(report.steps[0].detail).toContain("Access denied");
  });

  it("fails when an unauthenticated request is not refused", async () => {
    const report = await runConformance(
      OPTIONS,
      deps({
        fetch: async () => new Response(null, { status: 200, headers: { "content-type": "text/event-stream" } }),
      }),
    );
    const authSteps = report.steps.filter((s) => s.clientClass === CLIENT_CLASSES.anyClient);
    expect(authSteps).toHaveLength(2);
    expect(authSteps.every((s) => s.status === "fail")).toBe(true);
    expect(authSteps[0].detail).toContain("HTTP 200");
  });

  it("sends no Authorization header on the missing-token probe and a bad one on the wrong-token probe", async () => {
    const seen: Array<string | undefined> = [];
    await runConformance(
      OPTIONS,
      deps({
        fetch: async (_input, init) => {
          const headers = (init?.headers ?? {}) as Record<string, string>;
          if ((init?.method ?? "GET") === "POST") seen.push(headers.authorization);
          return new Response(null, { status: (init?.method ?? "GET") === "POST" ? 401 : 405 });
        },
      }),
    );
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toMatch(/^Bearer /);
    expect(seen[1]).not.toContain(OPTIONS.token);
  });

  it("accepts a 405 on the legacy SSE probe as 'not served'", async () => {
    const sse = sseStep(await runConformance(OPTIONS, deps()));
    expect(sse?.status).toBe("pass");
    expect(sse?.detail).toContain("405");
  });

  it("accepts a 200 event stream that no legacy SSE client can finish a handshake on", async () => {
    const sse = sseStep(await runConformance(OPTIONS, deps({ fetch: endpoint(eventStream) })));
    expect(sse?.status).toBe("pass");
    expect(sse?.detail).toContain("cannot complete its handshake");
  });

  it("fails the SSE probe when GET answers something neither 405 nor an event stream", async () => {
    const sse = sseStep(
      await runConformance(OPTIONS, deps({ fetch: endpoint(() => new Response(null, { status: 500 })) })),
    );
    expect(sse).toMatchObject({ status: "fail", clientClass: CLIENT_CLASSES.legacySse });
    expect(sse?.detail).toContain("HTTP 500");
  });

  it("fails the SSE probe when legacy SSE really works but the run expected it unserved", async () => {
    const sse = sseStep(
      await runConformance(OPTIONS, deps({ fetch: endpoint(eventStream), connectSse: async () => okClient() })),
    );
    expect(sse?.status).toBe("fail");
    expect(sse?.detail).toContain("--expect-sse=supported");
  });

  it("requires a working tool surface when --expect-sse=supported", async () => {
    const supported = { ...OPTIONS, expectSse: "supported" as const };
    await expect(
      runConformance(supported, deps({ fetch: endpoint(eventStream), connectSse: async () => okClient() })),
    ).resolves.toMatchObject({ ok: true });
    expect(sseStep(await runConformance(supported, deps()))?.detail).toContain("expected to work");
  });

  it("holds the stdio bridge to the same tool surface as direct HTTP", async () => {
    const report = await runConformance(
      OPTIONS,
      deps({ connectBridge: async () => okClient({ listTools: async () => ({ tools: [] }) }) }),
    );
    expect(report.ok).toBe(false);
    const bridge = report.steps.at(-1);
    expect(bridge?.clientClass).toBe(CLIENT_CLASSES.bridge);
    expect(bridge?.detail).toContain("memory_query");
  });

  it("reports a skipped bridge as skipped, not as a pass or a failure", async () => {
    const report = await runConformance({ ...OPTIONS, skipBridge: true }, deps());
    const bridge = report.steps.at(-1);
    expect(bridge?.status).toBe("skip");
    expect(report.ok).toBe(true);
  });

  it("turns a thrown connect error into a named failure instead of crashing", async () => {
    const report = await runConformance(
      OPTIONS,
      deps({ connectHttp: () => Promise.reject(new Error("ECONNREFUSED")) }),
    );
    expect(report.ok).toBe(false);
    expect(report.steps[0]).toMatchObject({ status: "fail", detail: "ECONNREFUSED" });
  });

  it("closes every client it opens, including after a failed assertion", async () => {
    let closes = 0;
    const counting = () =>
      okClient({
        close: async () => {
          closes += 1;
        },
        listTools: async () => ({ tools: [] }),
      });
    await runConformance(OPTIONS, deps({ connectHttp: async () => counting(), connectBridge: async () => counting() }));
    expect(closes).toBe(2);
  });
});

describe("formatReport", () => {
  it("names the broken client class on a failure", async () => {
    const report = await runConformance(
      OPTIONS,
      deps({ connectBridge: () => Promise.reject(new Error("npx not found")) }),
    );
    const text = formatReport(report);
    expect(text).toContain(`BROKEN: ${CLIENT_CLASSES.bridge}`);
    expect(text).toContain("npx not found");
  });

  it("says so plainly when everything passed", async () => {
    expect(formatReport(await runConformance(OPTIONS, deps()))).toContain("All required steps passed.");
  });
});
