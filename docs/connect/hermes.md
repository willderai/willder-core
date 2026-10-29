# Connect Hermes (Nous hermes-agent) to Willder

Nous Research's open agent runtime.

**Transport:** Streamable HTTP · **Auth:** `Authorization: Bearer <capability token>` ·
**Endpoint:** `https://willder.ai/api/mcp`

**Half of this row is verified, and the two halves are different claims.** The server's half passes: on 2026-10-05, `npx tsx scripts/mcp-client-probe.ts --client=hermes --transport-only` reached `https://willder.ai/api/mcp` using Streamable HTTP with the exact `Authorization` header this page commits, and the initialisation sequence, `tools/list` and one scoped `memory_query` all answered, with an absent token and a wrong token both refused. **The client's half is unrun.** Nobody has run this client against Willder, so nothing here claims it works. Why: the `hermes` CLI itself is public — `hermes-agent` 0.19.0 on PyPI carries a Trusted Publisher attestation from the GitHub repository `NousResearch/hermes-agent` (checked 2026-10-07) — but a run needs a configured model provider, and no run has been recorded. That needs a person's run recorded in [`manual-runs.json`](manual-runs.json), naming who ran it, when, and on which commit — see [the index](README.md).

## Get a token

Open **Access → Tokens** in your Willder workspace and issue a capability token for the
narrowest scope that answers your questions. The value is shown once; only its hash is stored.
Keep it in the client's secret storage or an environment variable — never in a committed file,
a prompt or a screenshot.

```sh
export WILLDER_TOKEN='<your capability token>'
```

## Install with MCP support

```sh
pip install 'hermes-agent[mcp]'
```

The `mcp` extra is what installs the MCP client: in `hermes-agent` 0.19.0's packaging metadata on
PyPI (checked 2026-10-07) it pins `mcp==1.26.0` and `starlette==1.0.1`, nothing else. Hermes's own MCP page says MCP ships with the standard install, but a live run
against production on 2026-10-06 with plain `pip install hermes-agent` failed with
`mcp.client.streamable_http is not available`. If you see that error, install with the extra.

## Config file

`~/.hermes/config.yaml`, with variables in `~/.hermes/.env`.

```yaml
mcp_servers:
  willder:
    url: https://willder.ai/api/mcp
    headers:
      Authorization: "Bearer ${WILLDER_TOKEN}"
```

## Verify the connection

```sh
hermes mcp test willder
```

## Notes

Hermes defaults to Streamable HTTP, so no `transport` key is needed. It also supports `auth: oauth`, which Willder cannot use yet.

See [the index](README.md) for the other clients and [`mcp/README.md`](../../mcp/README.md) for the tool surface and the token rules.
