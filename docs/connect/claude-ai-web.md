# Connect claude.ai (web) to Willder

Claude in the browser. Custom connectors live under **Customize → Connectors → Add custom
connector** (on Team and Enterprise an Owner adds them under **Organization settings →
Connectors**).

**Transport:** Streamable HTTP · **Auth:** OAuth, built but not yet switched on at willder.ai ·
**Endpoint:** `https://willder.ai/api/mcp`

**Steps to connect: none work today.** claude.ai does not deliver a capability token to
Willder, and Willder's OAuth sign-in is off on willder.ai until `MCP_OAUTH_ENABLED` is turned on
there. No claude.ai connection has been recorded yet. The steps below are what the flow asks
for once it is on.

**Not supported, and the check says so rather than skipping the row.**
`npx tsx scripts/mcp-client-probe.ts --client=claude-ai-web --transport-only` records this row
as `unsupported`, which is not a pass: it confirms the endpoint serves no OAuth
authorization-server metadata and no protected-resource metadata, and refuses an
unauthenticated call with 401.

## Why the token header does not work

Every client that connects today sends `Authorization: Bearer <capability token>`. claude.ai
does not send it:

- **It was tried, and no header arrived.** On 2026-10-07 a custom connector on a Max account was
  pointed at a request-inspection URL with authentication set to **No sign-in** and two request
  headers entered, `Authorization` and `X-Willder-Token`. The `initialize` request that arrived
  carried neither; its only headers were standard transport ones. The same morning, claude.ai's
  calls to `https://willder.ai/api/mcp` were refused with 401 and then went looking for OAuth
  discovery, which answered 404.
- **Request headers are a limited beta.** Anthropic's
  [custom connector documentation](https://claude.com/docs/connectors/custom/add-unlisted)
  describes the **Request headers** section as a beta available to a limited set of
  organizations, with header names restricted to an approved list. An account without it has
  no way to send a token at all.

So a capability token has no route from claude.ai to Willder, and this page does not offer one.

Giving the endpoint a no-auth mode instead is not an option: identity comes from the token, and
an unauthenticated MCP endpoint would serve another tenant's memory.

## Connecting, once OAuth is on

1. In claude.ai, open **Customize → Connectors → Add custom connector**, name it Willder and
   paste `https://willder.ai/api/mcp`. Leave the OAuth client ID and secret empty: claude.ai
   registers itself.
2. Choose **Connect**. A Willder page opens; sign in, or create an account.
3. Pick the workspace, the scope it may reach (the narrowest one you administer is chosen for
   you) and **Read** or **Read and write**, then **Allow**. You are back in claude.ai, connected.

Every call then runs as an ordinary capability at that scope, through the same access check and
audit log as a token. Disconnect it under **Integrations → Connected apps** and its next call is
refused. Until a real run is recorded in [`manual-runs.json`](manual-runs.json), this page claims
nothing works.

To use Willder from Claude today, use [Claude Code](claude-code.md), which sends the header and
has been run end to end.

See [the index](README.md) for the other clients and [`mcp/README.md`](../../mcp/README.md) for
the tool surface and the token rules.
