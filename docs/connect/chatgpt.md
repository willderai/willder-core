# Connect ChatGPT to Willder

OpenAI's consumer app. Custom MCP connectors live behind **Settings → Connectors →
Advanced → Developer mode**, available on paid web plans.

**Transport:** Streamable HTTP · **Auth:** OAuth or no auth — there is no request-header field ·
**Endpoint:** `https://willder.ai/api/mcp`

**Steps to connect: none work today.** ChatGPT can only connect with OAuth. Willder's OAuth sign-in
is built and is off on willder.ai until `MCP_OAUTH_ENABLED` is turned on there. No ChatGPT
connection has been recorded yet. The steps below are what the flow asks for once it is on.

**Not supported, and the check says so rather than skipping the row.** On 2026-10-05, `npx tsx scripts/mcp-client-probe.ts --client=chatgpt --transport-only` confirmed what this page claims: the endpoint serves no OAuth authorization-server metadata and no protected-resource metadata (both `.well-known` paths answer 404), and it refuses an unauthenticated call with 401. The row is recorded `unsupported`, which is not a pass.

ChatGPT has no request-header field, so it cannot send an `Authorization` header and
Willder's capability-token flow cannot be used from it. Its path is OAuth 2.1 on `/api/mcp` with
PKCE and dynamic client registration, which Willder serves as its own authorization server.

## Connecting, once OAuth is on

1. In ChatGPT, turn on **Settings → Connectors → Advanced → Developer mode**, then
   **Create** a connector: name it Willder, paste `https://willder.ai/api/mcp`, and choose
   **OAuth**. Leave the client fields empty: ChatGPT registers itself.
2. ChatGPT opens a Willder page; sign in, or create an account.
3. Pick the workspace, the scope it may reach and **Read** or **Read and write**, then
   **Allow**. You are back in ChatGPT, connected.

Every call then runs as an ordinary capability at that scope, through the same access check and
audit log as a token. Disconnect it under **Integrations → Connected apps** and its next call is
refused.

Giving the endpoint a no-auth mode instead is not an option: identity comes from the token,
and an unauthenticated MCP endpoint would serve another tenant's memory.

## Other clients

Clients with their own `mcp login` flow, such as Claude Code, can use the same sign-in, though
none needs it: they all send the header. Registration accepts https redirects and http to a
loopback address on any port; a client that redirects to a custom scheme (`cursor://`) is
refused at registration.

See [the index](README.md).
