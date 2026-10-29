# Connect Cursor to Willder

An AI-first code editor.

**Transport:** Streamable HTTP · **Auth:** `Authorization: Bearer <capability token>` ·
**Endpoint:** `https://willder.ai/api/mcp`

**Half of this row is verified, and the two halves are different claims.** The server's half passes: on 2026-10-05, `npx tsx scripts/mcp-client-probe.ts --client=cursor --transport-only` reached `https://willder.ai/api/mcp` using Streamable HTTP with the exact `Authorization` header this page commits, and the initialisation sequence, `tools/list` and one scoped `memory_query` all answered, with an absent token and a wrong token both refused. **The client's half is unrun.** Nobody has run this client against Willder, so nothing here claims it works. Why: Cursor is a desktop app, and its MCP settings screen is only visible in its own window. That needs a person's run recorded in [`manual-runs.json`](manual-runs.json), naming who ran it, when, and on which commit — see [the index](README.md).

## Get a token

Open **Access → Tokens** in your Willder workspace and issue a capability token for the
narrowest scope that answers your questions. The value is shown once; only its hash is stored.
Keep it in the client's secret storage or an environment variable — never in a committed file,
a prompt or a screenshot.

```sh
export WILLDER_TOKEN='<your capability token>'
```

## Config file

`.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for every project.

```json
{
  "mcpServers": {
    "willder": {
      "url": "https://willder.ai/api/mcp",
      "headers": { "Authorization": "Bearer ${env:WILLDER_TOKEN}" }
    }
  }
}
```

**Name your task (optional).** Add `"X-Willder-Task": "${env:WILLDER_TASK}"` to `headers` and
export `WILLDER_TASK` (a ticket key or branch name) before starting Cursor: the first result of each
session then leads with what earlier sessions of that task decided and wrote.

## Verify the connection

**Settings → MCP** should list `willder` as connected with its tools enumerated. Ask the agent to run `memory_query`.

## Notes

Cursor must be started from a shell where `WILLDER_TOKEN` is exported, or it will not see the variable.

See [the index](README.md) for the other clients and [`mcp/README.md`](../../mcp/README.md) for the tool surface and the token rules.
