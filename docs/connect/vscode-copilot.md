# Connect VS Code (GitHub Copilot agent mode) to Willder

Copilot's agent mode in Visual Studio Code.

**Transport:** Streamable HTTP · **Auth:** `Authorization: Bearer <capability token>` ·
**Endpoint:** `https://willder.ai/api/mcp`

**Half of this row is verified, and the two halves are different claims.** The server's half passes: on 2026-10-05, `npx tsx scripts/mcp-client-probe.ts --client=vscode-copilot --transport-only` reached `https://willder.ai/api/mcp` using Streamable HTTP with the exact `Authorization` header this page commits, and the initialisation sequence, `tools/list` and one scoped `memory_query` all answered, with an absent token and a wrong token both refused. **The client's half is unrun.** Nobody has run this client against Willder, so nothing here claims it works. Why: the Copilot MCP panel is only visible inside VS Code. That needs a person's run recorded in [`manual-runs.json`](manual-runs.json), naming who ran it, when, and on which commit — see [the index](README.md).

## Get a token

Open **Access → Tokens** in your Willder workspace and issue a capability token for the
narrowest scope that answers your questions. The value is shown once; only its hash is stored.
Keep it in the client's secret storage or an environment variable — never in a committed file,
a prompt or a screenshot.

```sh
export WILLDER_TOKEN='<your capability token>'
```

## Config file

`.vscode/mcp.json` in the workspace, or the user `mcp.json` via **MCP: Open User Configuration**.

```json
{
  "inputs": [
    { "type": "promptString", "id": "willder-token", "password": true, "description": "Willder capability token" }
  ],
  "servers": {
    "willder": {
      "type": "http",
      "url": "https://willder.ai/api/mcp",
      "headers": { "Authorization": "Bearer ${input:willder-token}" }
    }
  }
}
```

`${input:...}` prompts once and stores the value in VS Code's secret storage, so the committed
file holds no token. `${env:WILLDER_TOKEN}` also works if you prefer the environment.

**Name your task (optional).** Add `"X-Willder-Task": "${env:WILLDER_TASK}"` to `headers` and
export `WILLDER_TASK` (a ticket key or branch name) before starting VS Code: the first result of
each session then leads with what earlier sessions of that task decided and wrote.

## Verify the connection

Run **MCP: List Servers** and open `willder`; it should report running with its tools. Then use a Willder tool from agent mode.

## Notes

VS Code falls back to SSE only if the server asks for it; `"type": "http"` keeps it on Streamable HTTP.

See [the index](README.md) for the other clients and [`mcp/README.md`](../../mcp/README.md) for the tool surface and the token rules.
