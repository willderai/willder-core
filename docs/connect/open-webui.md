# Connect Open WebUI to Willder

A self-hosted web front end for local and hosted models (0.6.31 and later speak MCP directly).

**Transport:** Streamable HTTP · **Auth:** `Authorization: Bearer <capability token>` ·
**Endpoint:** `https://willder.ai/api/mcp`

**Steps to connect: four, not one.** One dialog with four fields: type, URL, auth and token. Open WebUI's connection dialog has no file to paste and no command, so this page cannot offer a single step.

**Half of this row is verified, and the two halves are different claims.** The server's half passes: on 2026-10-05, `npx tsx scripts/mcp-client-probe.ts --client=open-webui --transport-only` reached `https://willder.ai/api/mcp` using Streamable HTTP with the exact `Authorization` header this page commits, and the initialisation sequence, `tools/list` and one scoped `memory_query` all answered, with an absent token and a wrong token both refused. **The client's half is unrun.** Nobody has run this client against Willder, so nothing here claims it works. Why: Open WebUI's connection row and tool picker are only visible in a browser. That needs a person's run recorded in [`manual-runs.json`](manual-runs.json), naming who ran it, when, and on which commit — see [the index](README.md).

## Get a token

Open **Access → Tokens** in your Willder workspace and issue a capability token for the
narrowest scope that answers your questions. The value is shown once; only its hash is stored.
Keep it in the client's secret storage or an environment variable — never in a committed file,
a prompt or a screenshot.

```sh
export WILLDER_TOKEN='<your capability token>'
```

## Config file

No file: **Settings → Admin → Integrations → External Tool Servers → + Add Connection**. With auth **Bearer**, the token goes in the field the dialog labels **Key**.

| Field | Value |
|---|---|
| Type | MCP (Streamable HTTP) |
| URL | `https://willder.ai/api/mcp` |
| Auth | Bearer |
| Token | your capability token |

Open WebUI has no free-form header field. `Auth` and `Token` are the two fields you fill, and the
one header it builds from them is written out here so it can be checked against what the endpoint
expects:

| Header it sends | Value |
|---|---|
| `Authorization` = `Bearer <your capability token>` | built from the `Auth` and `Token` fields above |

## Verify the connection

The connection row turns green and the tool picker in a chat lists the Willder tools.

## Notes

Open WebUI speaks Streamable HTTP only; stdio servers need `mcpo`. Willder is already HTTP, so no bridge is involved.

See [the index](README.md) for the other clients and [`mcp/README.md`](../../mcp/README.md) for the tool surface and the token rules.
