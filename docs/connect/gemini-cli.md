# Connect Gemini CLI to Willder

Google's terminal agent.

**Transport:** Streamable HTTP · **Auth:** `Authorization: Bearer <capability token>` ·
**Endpoint:** `https://willder.ai/api/mcp`

**Half of this row is verified, and the two halves are different claims.** The server's half passes: on 2026-10-05, `npx tsx scripts/mcp-client-probe.ts --client=gemini-cli --transport-only` reached `https://willder.ai/api/mcp` using Streamable HTTP with the exact `Authorization` header this page commits, and the initialisation sequence, `tools/list` and one scoped `memory_query` all answered, with an absent token and a wrong token both refused. **The client's half is unrun.** Nobody has run this client against Willder, so nothing here claims it works. Why: Gemini CLI answers a query only after a Google sign-in or a `GEMINI_API_KEY`, and a probe must not create either. That needs a person's run recorded in [`manual-runs.json`](manual-runs.json), naming who ran it, when, and on which commit — see [the index](README.md).

## Get a token

Open **Access → Tokens** in your Willder workspace and issue a capability token for the
narrowest scope that answers your questions. The value is shown once; only its hash is stored.
Keep it in the client's secret storage or an environment variable — never in a committed file,
a prompt or a screenshot.

```sh
export WILLDER_TOKEN='<your capability token>'
```

## Config file

`~/.gemini/settings.json`, or `.gemini/settings.json` in the project. `gemini mcp add` writes it.

```sh
gemini mcp add --transport http \
  --header "Authorization: Bearer ${WILLDER_TOKEN}" \
  willder https://willder.ai/api/mcp
```

The settings key it writes is `httpUrl`; `headers` values accept `$WILLDER_TOKEN`.

## Trust the folder first

Gemini CLI's folder trust is a feature you switch on with `"security": { "folderTrust": { "enabled": true } }`
in your user `settings.json`. Once it is on, in an untrusted folder, per Gemini CLI's trusted-folders
page, "**MCP servers do not connect**: The CLI will not attempt to connect to any Model Context
Protocol (MCP) servers." and workspace settings (`.gemini/settings.json` in the project) are not loaded either.
With the folder untrusted, `gemini mcp list` will not show Willder connected.

The first time you run `gemini` in a folder it shows a dialog to trust the folder, trust its parent,
or not trust it. To change the choice later, run `/permissions` inside the CLI. Choices are saved in
`~/.gemini/trustedFolders.json`.

## Verify the connection

```sh
gemini mcp list
```

## Notes

`url` in Gemini's settings means legacy SSE. Use `httpUrl`, or `--transport http`.

See [the index](README.md) for the other clients and [`mcp/README.md`](../../mcp/README.md) for the tool surface and the token rules.
