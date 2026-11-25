# Willder plugin for Claude Code

Shared memory for AI agents and teams over MCP, with per-agent access control. What one agent
saves, the others read on their next call, with who wrote it.

The plugin adds the `willder` MCP server (`https://willder.ai/api/mcp`, Streamable HTTP, the
coding tool set) and one skill, `willder-memory`, that tells Claude when to read and when to
record.

## Install

```sh
claude plugin marketplace add willderai/willder-core
claude plugin install willder@willder-plugins
```

## Get a token

Open **Access → Tokens** in your Willder workspace and issue a capability token for the
narrowest scope that answers your questions. Export it before starting Claude Code; the plugin
reads it from the environment and never stores it:

```sh
export WILLDER_TOKEN='<your capability token>'
```

Then check the connection with `claude mcp list` and ask Claude to call `memory_query`.

For the session-start hook, task names and capture, see
[docs/connect/claude-code.md](../../docs/connect/claude-code.md). Self-hosting: point the
server at your own URL with `claude mcp add` as that page shows.
