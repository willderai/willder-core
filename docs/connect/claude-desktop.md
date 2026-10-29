# Connect Claude Desktop to Willder

Anthropic's desktop app.

**Transport:** stdio, through the pinned `mcp-remote` bridge to Streamable HTTP · **Auth:**
`Authorization: Bearer <capability token>`, sent by the bridge · **Endpoint:**
`https://willder.ai/api/mcp`

**Half of this row is verified, and the two halves are different claims.** The server's half passes: on 2026-10-05, `npx tsx scripts/mcp-client-probe.ts --client=claude-desktop --transport-only` ran the bridge config below against `https://willder.ai/api/mcp`, and the initialisation sequence, `tools/list` and one scoped `memory_query` all answered through the bridge. That run does not test refusal: the bridge path sends a valid token only. **The client's half is unrun.** Nobody has run this client against Willder, so nothing here claims it works. Why: Claude Desktop is a desktop app, and its connection is only visible in its own window. That needs a person's run recorded in [`manual-runs.json`](manual-runs.json), naming who ran it, when, and on which commit — see [the index](README.md).

## Get a token

Open **Access → Tokens** in your Willder workspace and issue a capability token for the
narrowest scope that answers your questions. The value is shown once; only its hash is stored.
Keep it in the client's secret storage or an environment variable — never in a committed file,
a prompt or a screenshot.

```sh
export WILLDER_TOKEN='<your capability token>'
```

## Config file

`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows (**Settings → Developer → Edit Config** opens it). Claude Desktop starts this bridge on your own computer, and the bridge sends the header itself:

```json
{
  "mcpServers": {
    "willder": {
      "command": "npx",
      "args": ["-y", "mcp-remote@0.14.3", "https://willder.ai/api/mcp", "--header", "Authorization:${AUTH_HEADER}"],
      "env": { "AUTH_HEADER": "Bearer <your capability token>" }
    }
  }
}
```

There is deliberately no space after `Authorization:` — Claude Desktop on Windows does not
escape spaces inside `args`, and `mcp-remote` expands `${AUTH_HEADER}` itself. Restart Claude
Desktop after saving the file. The bridge needs Node.js on your `PATH` for `npx`.

## Why not Add custom connector

**Customize → Connectors → Add custom connector** does not work for Willder today. It is the
same connector system claude.ai uses: Anthropic's
[server guide](https://claude.com/docs/connectors/building/index) says "the same connector
infrastructure backs" claude.ai, Claude Desktop, mobile, Cowork and Claude Code's connectors.
That system cannot deliver a capability token:

- **On 2026-10-07 no header arrived.** A custom connector on a Max account, with
  authentication set to **No sign-in** and `Authorization` and `X-Willder-Token` entered as
  request headers, sent an `initialize` request carrying neither. The details are on
  [the claude.ai page](claude-ai-web.md#why-the-token-header-does-not-work).
- **Request headers are a limited beta.** Anthropic's
  [custom connector documentation](https://claude.com/docs/connectors/custom/add-unlisted)
  says the **Request headers** section is "available to a limited set of organizations", and
  that each custom header name needs Anthropic's approval.
- **The other sign-in it supports is OAuth,** which Willder does not serve yet.

The test was run from claude.ai, not from the desktop window. The documentation is the reason
this page treats the two as one: no desktop-only connector run has been recorded. When MCP
OAuth ships on `/api/mcp`, this dialog becomes a second way to connect, and this page will say
so once a run is recorded.

## Verify the connection

**Settings → Developer** lists `willder` as running, and the tool menu in a chat lists the Willder tools. This is a UI flow; it needs a recorded manual run, which has not happened yet.

## Notes

This page first offered the custom connector as the preferred path, on the strength of the
request-headers beta. The 2026-10-07 claude.ai test showed that path sends no token, so the
local bridge is now the only path this page commits.

See [the index](README.md) for the other clients and [`mcp/README.md`](../../mcp/README.md) for the tool surface and the token rules.
