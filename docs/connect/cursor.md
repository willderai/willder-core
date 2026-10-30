# Connect Cursor to Willder

An AI-first code editor.

**Transport:** Streamable HTTP · **Auth:** `Authorization: Bearer <capability token>` ·
**Endpoint:** `https://willder.ai/api/mcp`

**Half of this row is verified, and the two halves are different claims.** The server's half passes: on 2026-10-05, `npx tsx scripts/mcp-client-probe.ts --client=cursor --transport-only` reached `https://willder.ai/api/mcp` using Streamable HTTP with the exact `Authorization` header this page commits, and the initialisation sequence, `tools/list` and one scoped `memory_query` all answered, with an absent token and a wrong token both refused. **The client's half is unrun against the hosted endpoint.** Nobody has run Cursor against `https://willder.ai/api/mcp`, so nothing here claims that path works. Why: Cursor is a desktop app, and its MCP settings screen is only visible in its own window. That needs a person's run recorded in [`manual-runs.json`](manual-runs.json), naming who ran it, when, and on which commit — see [the index](README.md). The `cursor-agent` command line has been run against a local, self-hosted install; that run is [below](#local-self-hosted), and it says what it did not check.

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

## Local (self-hosted)

A self-hosted install ([self-host.md](../self-host.md)) has no hosted endpoint: Cursor starts the
repository's stdio MCP server itself, the same server that [self-host.md](../self-host.md#steps)
and [development.md](../development.md#ten-minute-path-a-local-mcp-server) connect Claude Code to
with `npm --prefix ... run --silent mcp`. Mint a token for Cursor from the clone
(`npm run selfhost:token -- --scope team --agent cursor`), export it as `WILLDER_TOKEN` in the
shell you start Cursor from (the repository README shows a way that does not echo it), and put
this in `.cursor/mcp.json` in the project you open in Cursor, with the absolute path of your clone:

```json
{
  "mcpServers": {
    "willder-local": {
      "type": "stdio",
      "command": "npm",
      "args": [
        "--prefix",
        "/absolute/path/to/your/clone",
        "run",
        "--silent",
        "mcp"
      ],
      "env": { "WILLDER_CAPABILITY_TOKEN": "${env:WILLDER_TOKEN}" }
    }
  }
}
```

The file holds only the reference; Cursor fills in the token from the environment it was
started in. A project's servers start unapproved: `cursor-agent mcp list` prints
`willder-local: not loaded (needs approval)` until you approve it once with
`cursor-agent mcp enable willder-local`, which approves this one server. (`--approve-mcps` on a
run also works, but approves every server the project configures.) After that:

```sh
cursor-agent mcp list                     # expect: willder-local: ready
cursor-agent mcp list-tools willder-local # expect: Tools for willder-local (13):
```

**Let it call the tools in print mode.** `cursor-agent -p` answers every tool prompt with no,
so without a rule the first write ends in `User rejected MCP: willder-local-memory_ingest` and
the agent says nothing was saved. Allow this one server, and nothing else, in `.cursor/cli.json`
next to `mcp.json`:

```json
{ "permissions": { "allow": ["Mcp(willder-local:*)"], "deny": [] } }
```

An interactive session asks instead, and needs no rule.

**What was run.** On 2026-10-29, `cursor-agent` 2026.10.22 on its default model (`Auto`), in
print mode from a project holding the two files above, against a fresh clone of the public
repository set up without Docker (Postgres 17, a local Neo4j and the memory service, with
`npm run selfhost:smoke` at `9 of 9 steps passed`). Those runs used the config above without
`"type": "stdio"` and approved with `--approve-mcps`; the three `mcp list` results quoted on
this page were then recorded again with `"type": "stdio"` and `mcp enable willder-local`:

| Step                                                                                         | What Cursor did                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Save this to Willder: we store sessions in Postgres, not Redis, so they survive a restart.` | called `memory_ingest` (`name: "session storage"`, `kind: "decision"`); Willder answered `Recorded decision …; it is proposed in <org>.team, not yet a standing rule …` and `Stored and readable now`                                                                                                                                      |
| `Ask Willder where we store sessions and why.`                                               | called `memory_query`; it returned the fact, marked `[lead to verify: decision …, not confirmed by a person]`, with `your grant allowed this read on the scope "team"`, and Cursor answered `Postgres, not Redis, so they survive a restart`                                                                                               |
| The same question, with a second token minted for `--scope research --agent second-agent`    | `memory_query` returned `No facts found.` with `your grant allowed this read on the scope "research"`                                                                                                                                                                                                                                      |
| The same question after `npm run selfhost:token -- --revoke cursor`                          | the server exits at start, so `cursor-agent mcp list` shows `willder-local: Error: Connection failed` and the agent reports Willder unreachable; it gets nothing from Willder. It did find the earlier sessions' text, the fact included, in Cursor's own transcripts under `~/.cursor/projects/`, which revoking the token does not touch |

Cursor does not show why the server exited. To see it, run the server the way Cursor does:
`WILLDER_CAPABILITY_TOKEN="$WILLDER_TOKEN" npm --prefix <your clone> run --silent mcp </dev/null`
prints `willder MCP server failed: WILLDER_CAPABILITY_TOKEN is not a live token in this database
(unknown, expired or revoked)`, with the command that mints a fresh one.

**Not checked:** the Cursor desktop app's **Settings → MCP** screen and its approval prompt; only
the `cursor-agent` command line was run. A token revoked while a session's server is already
running was not tried here; the server answers that case's next call with `Access denied`
([self-host.md](../self-host.md)), but how Cursor shows it was not seen.

Two things that are Willder's, not Cursor's. When the agent saves something as a `decision`,
Willder stores it as proposed and asks a person to confirm it at a `http://localhost:3000/...`
link; that page is the web app, which a self-hosted install does not run, so the fact stays a
lead to verify — it is still stored and readable. And Cursor's model runs on Cursor's servers:
what the agent reads from Willder goes there with the rest of the conversation, even though
Willder itself makes no outside call. Cursor also keeps its own transcripts of each session on
your machine, under `~/.cursor/projects/`, and a later session's agent may search them. Revoking a
token stops Willder answering; it does not remove what earlier sessions already read, from those
transcripts or from Cursor's servers.

## Notes

Cursor must be started from a shell where `WILLDER_TOKEN` is exported, or it will not see the variable.

See [the index](README.md) for the other clients and [`mcp/README.md`](../../mcp/README.md) for the tool surface and the token rules.
