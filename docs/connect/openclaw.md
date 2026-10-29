# Connect OpenClaw (formerly Clawdbot) to Willder

An open agent CLI; renamed from Clawdbot via Moltbot in January 2026.

**Transport:** Streamable HTTP through a pinned `mcp-remote@0.14.3` stdio bridge ·
**Auth:** `Authorization: Bearer <capability token>`, read from the bridge's environment ·
**Endpoint:** `https://willder.ai/api/mcp`

**Half of this row is verified, and the two halves are different claims.** The server's half passes: on 2026-10-05, `npx tsx scripts/mcp-client-probe.ts --client=openclaw --transport-only` reached `https://willder.ai/api/mcp` using the pinned `mcp-remote@0.14.3` command, argv and `env` block on this page, over stdio, and the initialisation sequence, `tools/list` and one scoped `memory_query` all answered, with an absent token and a wrong token both refused. **The client's half is unrun.** Nobody has run this client against Willder, so nothing here claims it works. Why: OpenClaw's own config store and probe output are only visible on the machine running it. That needs a person's run recorded in [`manual-runs.json`](manual-runs.json), naming who ran it, when, and on which commit — see [the index](README.md).

## Get a token

Issue a capability token from **Access → Tokens** for the narrowest scope you need. The value
is shown once. These clients do not document environment interpolation inside `headers`, which
is why the bridge is used: the bridge reads the token from its own `env` block, so the token
lives in one place instead of being pasted into a header string.

```sh
export WILLDER_TOKEN='<your capability token>'
```

## Config

OpenClaw's own config store, written through `openclaw mcp set` (key `mcp.servers`).

```sh
openclaw mcp set willder '{
  "command": "npx",
  "args": ["-y", "mcp-remote@0.14.3", "https://willder.ai/api/mcp", "--header", "Authorization:${AUTH_HEADER}"],
  "env": { "AUTH_HEADER": "Bearer '"$WILLDER_TOKEN"'" }
}'
```

Direct HTTP also works, but `transport` is **mandatory** — the default is SSE:

```sh
openclaw mcp set willder '{"url":"https://willder.ai/api/mcp","transport":"streamable-http","headers":{"Authorization":"Bearer <token>"}}'
```

## Why a bridge

`mcp-remote@0.14.3` is a stdio MCP server that forwards to a remote Streamable HTTP endpoint. It is
pinned to an exact version so an upstream change cannot silently alter how these clients
connect, and it is the only extra component — there is no Willder-specific binary to install.

There is deliberately **no space** after `Authorization:` in the `--header` argument: several
clients do not escape spaces inside `args`, and `mcp-remote` expands `${AUTH_HEADER}` from the
process environment itself, so the token never appears in the command line.

## Verify the connection

```sh
openclaw mcp probe willder --json
```

## Notes

OpenClaw defaults to legacy SSE, which Willder's endpoint does not serve as a usable handshake. Set `transport` or use the bridge. Environment interpolation inside `headers` is unverified.

See [the index](README.md) for the other clients and [`mcp/README.md`](../../mcp/README.md) for
the tool surface and the token rules.
