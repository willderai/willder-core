# Connect Continue to Willder

An open-source IDE assistant for VS Code and JetBrains.

**Transport:** Streamable HTTP · **Auth:** `Authorization: Bearer <capability token>` ·
**Endpoint:** `https://willder.ai/api/mcp`

**Half of this row is verified, and the two halves are different claims.** The server's half passes: on 2026-10-05, `npx tsx scripts/mcp-client-probe.ts --client=continue --transport-only` reached `https://willder.ai/api/mcp` using Streamable HTTP with the exact `Authorization` header this page commits, and the initialisation sequence, `tools/list` and one scoped `memory_query` all answered, with an absent token and a wrong token both refused. **The client's half is unrun.** Nobody has run this client against Willder, so nothing here claims it works. Why: Continue is an IDE extension, and its tool list is only visible in the IDE. That needs a person's run recorded in [`manual-runs.json`](manual-runs.json), naming who ran it, when, and on which commit — see [the index](README.md).

## Get a token

Open **Access → Tokens** in your Willder workspace and issue a capability token for the
narrowest scope that answers your questions. The value is shown once; only its hash is stored.
Keep it in the client's secret storage or an environment variable — never in a committed file,
a prompt or a screenshot.

```sh
export WILLDER_TOKEN='<your capability token>'
```

## Config file

`.continue/mcpServers/willder.yaml` in the project, or `~/.continue/mcpServers/willder.yaml`.

```yaml
name: willder
type: streamable-http
url: https://willder.ai/api/mcp
requestOptions:
  headers:
    Authorization: "Bearer ${{ secrets.WILLDER_TOKEN }}"
```

Add `WILLDER_TOKEN` to Continue's secrets (hub or local `.env`), not to this file.

## Verify the connection

Switch to **Agent** mode — MCP tools are not offered in Chat mode — and check the tools dropdown for the Willder tools.

## Notes

The exact `requestOptions.headers` key has not been confirmed against a running Continue build.

See [the index](README.md) for the other clients and [`mcp/README.md`](../../mcp/README.md) for the tool surface and the token rules.
