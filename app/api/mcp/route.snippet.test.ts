import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// The MCP settings panel's copy-paste curl snippet must work against the real
// route. A customer-facing snippet nobody ran is the defect this guards
// against.
//
// This test reads the snippet out of the shipped component source and drives
// the REAL route handler with it, so it fails if the snippet drifts, if the
// pinned protocolVersion stops being accepted, or if the route stops handling
// a one-shot initialize. Only resolveCapability is mocked (identity lookup, the
// one part that needs a DB); the MCP server, transport, and tool registration
// are all real.
//
// A one-shot `tools/list` against this stateless route does NOT fail either.
// It returns 200 with the full tool list: `WebStandardStreamableHTTPServerTransport`
// in stateless mode (`sessionIdGenerator: undefined`) does not require an
// `initialize` handshake before it will serve other methods. Both snippets
// work; the second case below pins that fact so a false "tools/list can never
// succeed on a stateless transport" rationale does not get re-derived.

vi.mock("@/services/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/access")>();
  return {
    ...actual,
    resolveCapability: vi.fn(async () => ({
      orgId: "org_1",
      agentId: "agent_1",
      permission: "read",
      scopePath: "org_org_1",
    })),
  };
});

import { POST } from "./route";

const PANEL = path.join(process.cwd(), "components/settings/mcp-panel.tsx");

// Pull the JSON-RPC body out of the `-d '...'` line of the panel's customCurl
// snippet — the literal string a customer copies out of the UI.
function snippetBody(): string {
  const src = readFileSync(PANEL, "utf8");
  const match = /-d '(\{.*?\})'/.exec(src);
  if (!match) throw new Error("could not find the -d JSON body in the panel's curl snippet");
  return match[1]!;
}

function post(body: string): Promise<Response> {
  return POST(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer test-token",
      },
      body,
    }),
  );
}

async function readBody(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  // enableJsonResponse is on, but accept an SSE frame too rather than assuming.
  const line = text.startsWith("data:")
    ? text
        .split("\n")
        .find((l) => l.startsWith("data:"))!
        .slice(5)
        .trim()
    : text;
  return JSON.parse(line);
}

describe("the MCP panel's copy-paste snippet against the real stateless route", () => {
  it("the snippet the panel actually ships succeeds against the real route handler", async () => {
    const res = await post(snippetBody());
    const body = await readBody(res);

    expect(res.status).toBe(200);
    // A protocol error here means the snippet a customer copies does not work.
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
  });

  it("a one-shot tools/list ALSO works — the stateless transport needs no initialize handshake first", async () => {
    // Pins that this call does not "always hit a never-initialized transport
    // and return a protocol error." If a future change ever makes that true,
    // this test fails and whoever is looking will find the real behavior
    // recorded here.
    const res = await post('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}');
    const body = await readBody(res);

    expect(res.status).toBe(200);
    expect(body.error).toBeUndefined();
    const result = body.result as { tools?: unknown[] };
    expect(Array.isArray(result.tools)).toBe(true);
    expect(result.tools!.length).toBeGreaterThan(0);
  });
});
