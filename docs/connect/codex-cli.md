# Connect Codex CLI to Willder

OpenAI's terminal coding agent.

**Transport:** Streamable HTTP · **Auth:** `Authorization: Bearer <capability token>` ·
**Endpoint:** `https://willder.ai/api/mcp`

**Verified end to end on 2026-10-05**, against `https://willder.ai/api/mcp`. Both of the client matrix's claims hold for this row: the server answered the transport and authentication shape this page configures, and Codex CLI itself connected, listed the Willder tools (all of them: the page did not yet set `X-Willder-Tools: coding`) and answered one scoped `memory_query`. Re-run both halves yourself:

```sh
WILLDER_MCP_URL=https://willder.ai/api/mcp WILLDER_TOKEN='<token>' \
  WILLDER_DEPLOYED_COMMIT=<deployed commit> \
  OPENAI_API_KEY=<a key you already have> \
  npx tsx scripts/mcp-client-probe.ts --client=codex-cli
```

## Get a token

Open **Access → Tokens** in your Willder workspace and issue a capability token for the
narrowest scope that answers your questions. The value is shown once; only its hash is stored.
Keep it in the client's secret storage or an environment variable — never in a committed file,
a prompt or a screenshot.

```sh
export WILLDER_TOKEN='<your capability token>'
```

## Config file

`~/.codex/config.toml`

```toml
[mcp_servers.willder]
url = "https://willder.ai/api/mcp"
bearer_token_env_var = "WILLDER_TOKEN"
http_headers = { "X-Willder-Tools" = "coding" }
```

Codex reads the token from the named environment variable at launch, so the value never
enters the config file. `X-Willder-Tools: coding` lists the four tools a coding agent calls
(`memory_query`, `memory_version`, `memory_ingest`, `memory_changes`), so the other tools' descriptions are not sent
to the model on every turn; leave `http_headers` out to list every Willder tool.

**Name your task (optional).** Add `env_http_headers = { "X-Willder-Task" = "WILLDER_TASK" }` to
the table and export `WILLDER_TASK` (a ticket key or branch name) before starting Codex: the first
result of each session then leads with what earlier sessions of that task decided and wrote.

## Verify the connection

```sh
codex mcp get willder
```

## Notes

`codex mcp login` exists for OAuth servers; Willder does not serve OAuth yet.

See [the index](README.md) for the other clients and [`mcp/README.md`](../../mcp/README.md) for the tool surface and the token rules.
