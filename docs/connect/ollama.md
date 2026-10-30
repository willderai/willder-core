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

## Fully local: Ollama model + self-hosted Willder

You can run the model and the memory on one machine with nothing hosted: Ollama serves the model
that extracts facts on writes, and a client that supports Ollama holds the MCP connection to a
[self-hosted](../self-host.md) Willder.

**Point extraction at Ollama.** Set `OPENAI_BASE_URL` to Ollama's OpenAI-compatible `/v1`
address, `OPENAI_MODEL_EXTRACT` to the model (`qwen3:14b`, say) and `OPENAI_API_KEY` to any
non-empty value (Ollama ignores it), in `.env` and in the memory service's environment.
[self-host.md](../self-host.md#a-local-model-for-extraction) has the lines to paste.

**Turn a reasoning model's thinking off for extraction.** For qwen3 and other models that think
by default, also set `OPENAI_EXTRACT_EXTRA_BODY` to `{"reasoning_effort":"none"}`. Both the Node
side and the memory service add its fields to every extraction request; unset, nothing is added.

### One run, 2026-10-29

What follows describes one past run and nothing more. It used `qwen3:14b` in Ollama and a
self-hosted engine from `willder-core` at commit `72d62a8`, set up
[without Docker](../self-host.md#without-docker). No other model or machine was tried, and the
run is not recorded in [`manual-runs.json`](manual-runs.json). It predates
`OPENAI_EXTRACT_EXTRA_BODY` and the current `memory_ingest` replies; where they differ, this says
so.

**Thinking.** With `qwen3:14b` thinking (its default), the first write's extraction call took
about two and a half minutes. The MCP call waiting on it timed out at 60 seconds
(`MCP error -32001: Request timed out`), so `npm run selfhost:smoke` failed. The run then had a
proxy in front of Ollama add `"reasoning_effort": "none"` to each request, which is what
`OPENAI_EXTRACT_EXTRA_BODY` now does without one. With thinking off, the smoke passed 9 of 9 and
reported `graph extraction: ok`. Its egress check found no connection to anything other than
`localhost` and `127.0.0.1`.

**The agent.** Ollama only serves the model, so a client has to hold the MCP connection.
[Hermes](hermes.md) 0.19.0 refused this model:
`Model qwen3:14b has a context window of 40,960 tokens, which is below the minimum 64,000 required by Hermes Agent.`
The run used a short Python loop instead. It started Willder's stdio server
(`npm --prefix <willder-core> run --silent mcp`, with `WILLDER_CAPABILITY_TOKEN` in its
environment) through the MCP Python SDK (`mcp` 1.26.0). It offered the model only
`memory_ingest` and `memory_query` through Ollama's `/v1/chat/completions` tool calling, and
returned each tool result to the model. It gave the model no shell, file or web tools.

What it did, with a `team` token for agent `qwen` and a `research` token for `second-agent`:

- **Save:** the model called `memory_ingest` with `content` and `name` and got back
  `Stored and readable now; graph extraction continues in the background. Version: <version id>.`
  On the stdio server the reply waits for extraction, so it now says how extraction ended
  instead, e.g. `Stored and readable now; graph extraction has completed. Version: <version id>.`
- **Ask back, in a new session:** it called `memory_query`, got the fact with its author
  (`"qwen" (agent token)`) and version, and answered from it.
- **Another scope:** the same question with the `research` token returned `No facts found.`
- **Revoke:** after `npm run selfhost:token -- --revoke qwen`, the stdio server would not start:
  `WILLDER_CAPABILITY_TOKEN is not a live token in this database (unknown, expired or revoked)`.

**How reliably `qwen3:14b` called the tools.** These are 12 runs, too few to give a rate:

- No run produced malformed JSON arguments or called a tool that does not exist. Every run made
  exactly one tool call.
- **Questions:** 5 of 5 called `memory_query` correctly. Two answers added a sentence of reasoning
  that was not in the tool result.
- **Saves with thinking on:** 2 of 3 succeeded. One invented a `scopePath` (and a `kind`) and was
  refused.
- **Saves with thinking off:** 0 of 4 succeeded. Each invented a `scopePath` such as
  `system.infrastructure` and was refused by the scope check, which is working as it should. The
  model never retried without the argument. The refusal it read then ended at the permission;
  since then `memory_ingest`'s arguments say `scopePath` is optional and to leave it out, and a
  refusal of a `scopePath` the token does not cover now ends:
  `Access denied: no valid capability for agent qwen granting write on the target scope … If no one gave you that scope, omit scopePath to write to your own scope, the one your token defaults to.`
  Whether `qwen3:14b` now retries has not been tried.
- **Time:** a run took 59 to 191 seconds with thinking on and about 25 seconds with it off.

See [the index](README.md).
