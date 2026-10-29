# Connect Ollama to Willder

A local model runtime.

**Ollama has no MCP client of its own.** Its tool-calling API lets a model request a function
call; it does not discover or connect to MCP servers. There is nothing to configure in Ollama
and nothing for Willder to build for it.

**Not applicable, so not verified.** The client matrix records this row `not-applicable` and makes no request for it: there is no client here to connect.

## How to reach Willder with Ollama models

Run a client from this index that supports Ollama as its model provider, and connect *that*
client to Willder:

- [Cline](cline.md) — VS Code, Ollama as provider
- [Continue](continue.md) — VS Code and JetBrains
- [Goose](goose.md) — CLI and desktop
- [Hermes](hermes.md) — open agent runtime
- [LM Studio](lm-studio.md) — desktop
- [Open WebUI](open-webui.md) — self-hosted web UI
- [OpenClaw](openclaw.md) — agent CLI

The MCP connection belongs to the client; Ollama only serves the model.

See [the index](README.md).
