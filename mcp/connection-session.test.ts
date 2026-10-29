// The pure half of mcp/connection-session.ts: which requests open a connection, what key a
// session id becomes, and how long a hook poll's block may still be claimed. The route
// behavior is in connection-session.realdb.test.ts and
// app/api/changes/notice/route.abandoned.realdb.test.ts.
import { describe, expect, it } from "vitest";
import { NOTICE_TIMEOUT_MS } from "@/cli/hooks/willder-capture.mjs";
import { HOOK_CLAIM_BUDGET_MS, abandonedSignal, connectionSessionKeyOf, opensConnection } from "./connection-session";

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "0" } },
};
const toolCall = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_my_brief", arguments: {} } };

describe("connection sessions", () => {
  it("opens a connection on an initialize, alone or in a batch, and on nothing else", () => {
    expect(opensConnection(initialize)).toBe(true);
    expect(opensConnection([initialize])).toBe(true);
    expect(opensConnection(toolCall)).toBe(false);
    expect(opensConnection([toolCall])).toBe(false);
    expect(opensConnection({ ...initialize, method: "notifications/initialized", id: undefined })).toBe(false);
    expect(opensConnection(null)).toBe(false);
    expect(opensConnection("initialize")).toBe(false);
  });

  it("keys a session id under the connection prefix, bounded as _meta hints are, and none for a blank one", () => {
    expect(connectionSessionKeyOf("abc")).toBe("mcp:abc");
    expect(connectionSessionKeyOf("  abc\u0000")).toBe("mcp:abc");
    expect(connectionSessionKeyOf("x".repeat(600))).toBe(`mcp:${"x".repeat(512)}`);
    for (const none of [null, undefined, "", "   ", "\u0001"]) expect(connectionSessionKeyOf(none)).toBe("");
  });

  it("ends a hook poll's claim budget before the hook stops waiting, with room for the reply's way back", () => {
    expect(HOOK_CLAIM_BUDGET_MS).toBeLessThanOrEqual(NOTICE_TIMEOUT_MS - 500);
  });

  it("abandons a reply when its caller hangs up, or when its wait runs out", async () => {
    const hangUp = new AbortController();
    const signal = abandonedSignal(new Request("http://localhost/", { signal: hangUp.signal }));
    expect(signal.aborted).toBe(false);
    hangUp.abort();
    expect(signal.aborted).toBe(true);

    const timed = abandonedSignal(new Request("http://localhost/"), 20);
    expect(timed.aborted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(timed.aborted).toBe(true);
  });
});
