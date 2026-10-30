# Self-hosting Willder

The engine on your own machine, with no willder.ai account and no call to willder.ai: Postgres
with pgvector, Neo4j and the memory service in Docker, the MCP server and the scripts on the
host. At the end an agent writes and reads scoped memory through MCP, a token is refused outside
its scope, and you export a scope to a file. `npm run selfhost:smoke` checks all of that in one
command.

## What it needs

| | For |
|---|---|
| Docker with Compose v2 | Postgres, Neo4j and the memory service ([`docker-compose.yml`](../docker-compose.yml)) |
| Node 20.19+, 22.12+ or 24+ | the MCP server and the scripts; not 21 or 23 ([development.md](development.md#what-you-need)) |
| A few GB of disk | mostly the memory service image (CPU-only torch and the embedding model), plus the two database images |

That is the whole list for the engine (the database, the memory service, the MCP server and
the scripts below). It calls out to one thing at most, and only if you configure it:

- **An OpenAI-compatible model endpoint, for writes.** Fact extraction calls it when memory is
  written. Reads never call it: embeddings run locally in the memory service. A local server
  works. As shipped, [`.env.selfhost.example`](../.env.selfhost.example) names a port where
  nothing listens, so the install calls no model at all: a write is stored and readable, and
  only its graph extraction is skipped.

The web app is optional and outside that claim: it needs a free Clerk development instance to
sign people in, and it also loads Google Fonts, Vercel Analytics' script in development, Next.js
telemetry (`NEXT_TELEMETRY_DISABLED=1` turns that off) and Clerk's own telemetry. The MCP server
and every step below use none of these.

No hosted plan limit applies. The self-host org (and the `local-dev` org `scripts/dev-token.ts`
makes) is stored on the schema's default plan, `free`, but the free plan's 1,000-episode memory
cap is not enforced for it, so memory writes keep being accepted past 1,000
(`isLocalInstallOrg` in [`lib/selfhost-install.ts`](../lib/selfhost-install.ts), checked by
`checkEpisodeCap` in [`services/guardrails.ts`](../services/guardrails.ts)). An install made
before this change needs nothing re-run: the check is made on every write. The cap applies
again if the process looks like a hosted deployment (`VERCEL` or `VERCEL_ENV` set, or a live
`sk_live_`/`pk_live_` Clerk key), and orgs the web app syncs from Clerk keep the hosted plan
rules.

Neo4j's anonymous usage report, Graphiti's telemetry and the Prisma CLI's usage check
(`checkpoint.prisma.io`) are on by default. The compose file turns off the first two,
`.env.selfhost.example` sets `CHECKPOINT_DISABLE=1` for the third, and the memory service
image carries its embedding model and loads it offline.

## Steps

```bash
# 1. Get the code and install (postinstall generates the Prisma client)
git clone <this repository> willder && cd willder
npm install

# 2. One .env for both docker compose and the Node side; change the shared key
cp .env.selfhost.example .env

# 3. Start Postgres, Neo4j and the memory service (the first build takes a few minutes)
docker compose up -d --wait

# 4. Create the tables
npx prisma migrate deploy

# 5. Create the self-host org, its operator and a scope, and mint a token for one agent
npm run selfhost:token -- --scope team --agent claude-code

# 6. Check the whole path: write, scoped read, out-of-scope refusal, export, no outside calls
npm run selfhost:smoke
```

Step 5 prints the token once. Connect any MCP client that starts a stdio server to it, the same
way as [development.md](development.md#ten-minute-path-a-local-mcp-server) step 5:

```bash
claude mcp add -s user willder-local -e WILLDER_CAPABILITY_TOKEN=wcap_... \
  -- npm --prefix "$PWD" run --silent mcp
```

`memory_ingest` stores a fact in the token's scope, `memory_query` reads it back, and a call
for a scope the token does not cover answers `Access denied`.

The smoke prints one line per step and ends with the count:

```
ok    database: reachable and migrated (localhost)
ok    memory service: http://localhost:8000 healthy, Neo4j reachable
ok    tokens: issued write tokens for run_<id>.alpha and run_<id>.beta as operator@self-hosted-smoke.invalid
ok    write: memory_ingest stored the fact in run_<id>.alpha (Version: <id>)
ok    scoped read: memory_query in run_<id>.alpha returned the fact
ok    out-of-scope refusal: the run_<id>.alpha token's read and write in run_<id>.beta were refused
ok    sibling write: memory_ingest stored a second fact in run_<id>.beta, for the export to leave out
ok    export: selfhost:export of run_<id>.alpha: 1 fact(s), its own only, in the docs/export-format.md format
ok    external connections: none besides localhost, 127.0.0.1 (model endpoint: 127.0.0.1)
note  graph extraction: ...

9 of 9 steps passed
```

It starts the real stdio MCP server and the real export command, writes to an org of its own
("Self-host smoke test", never the one step 5 made) and revokes its tokens when it ends. Every
Node process it starts refuses and records any connection to a host other than the database,
the memory service and the model endpoint; the last `ok` line is that record. It reads
connection settings from the environment, so it runs against any stack, not only this compose
file, but its `external connections` line sees only the Node side: what the memory service,
Neo4j and Postgres reach is checked by the workflow below for the compose stack, and is yours
to check on your own.

## Tokens: `npm run selfhost:token`

```
npm run selfhost:token -- [--agent <name>] [--scope <path>] [--permission read|write] [--ttl-hours <hours>]
```

| Option | Default | |
|---|---|---|
| `--agent` | `local-agent` | the agent the token is for |
| `--scope` | the org root | a scope below the root, like `team` or `team.alpha`: lowercase letters, digits and `_`; created if missing |
| `--permission` | `write` | `read` or `write` |
| `--ttl-hours` | `168` | 1 to 2160 |

The first run creates the org "Self-hosted" and its operator, a person with the owner role
(`operator@self-hosted.invalid`); later runs reuse both. The operator issues each token through
the same code as **Access → Tokens** in the web app, so the same rules hold: the token is never
wider than its issuer, it expires, and it is recorded in the audit log. Run it again for each
agent and scope.

### Revoke: `npm run selfhost:token -- --revoke <agent>`

```
npm run selfhost:token -- --revoke <agent> [--scope <path>]
```

Revokes every live token of that agent in the self-host org, or with `--scope` only its tokens
for exactly that scope, and prints each one it revoked by id, scope, permission and expiry,
never the token. It revokes the way `revoke` in **Access → Tokens** does: the operator
(`operator@self-hosted.invalid`) is authorized on the token's scope, the audit log gets the same
`access.manage` allow row (target `<scope>/capabilities:revoke:<token id>`), and nothing waits
for the token to expire. A token revoked already keeps its first revocation time. With no live
token to revoke it says so and exits 1. Name one agent per run.

```
$ npm run selfhost:token -- --revoke claude-code
self-host org <org id>: revoked 1 token(s) of agent claude-code
  <token id>  scope org_<org id>.team, write, was to expire 2026-11-05T08:00:00.000Z
Each one is refused on its next call, and the refusal is in the audit log (npm run selfhost:export).
```

What the agent sees next depends on how it connects. Every refusal below is in the audit log,
which the operator's `npm run selfhost:export` holds as `audit` lines.

- **The MCP endpoint (`/api/mcp`, in the web app):** HTTP 401 with
  `Invalid or unknown capability token.`, and a `capability.refused` deny row for the agent
  that names the token (reason `capability revoked: …`).
- **A stdio MCP server started with the revoked token:** it exits 1 before connecting, with
  `WILLDER_CAPABILITY_TOKEN is not a live token in this database (unknown, expired or revoked)`
  and a pointer to `npm run selfhost:token`, and records the same `capability.refused` row.
- **A stdio MCP server already running when the token is revoked:** it keeps running and
  still lists its tools, but every tool, resource and prompt call after the revoke is refused;
  nothing is read or written. Memory tools answer
  `Access denied: no valid capability for agent <agent> granting read` (or `write`) `on the
  target scope …`; `memory_version` answers `Version not found.`; `send_feedback` answers that
  the session's token is no longer live. Each refusal is a deny row under the call's own action
  (`memory.read`, `memory.write` or `memory.entity`, reason `no valid capability …`), which does
  not name the token. Only `send_feedback` records `capability.refused`. Restart the server to
  get the first case's refusal.

## Export: `npm run selfhost:export`

```
npm run selfhost:export -- [--scope <path>] [--out <file>] [--as <email>]
```

It writes the same JSON Lines file as the web app's export, through the same code, in the format
[export-format.md](export-format.md) describes. `--scope team` exports `team` and everything
below it; without `--scope` it exports everything the person may read. `--as` exports as
another member of the self-host org, and the export follows that person's grants exactly as the
web export does: a scope they cannot read is refused, and the refusal is in the audit log.
Without `--out` the file goes to standard output; `--out` never overwrites a file that exists.

## Where the scripts refuse to run

`selfhost:token`, `selfhost:export` and `selfhost:smoke` act only on the orgs they create
themselves, never on an org synced from Clerk, and they refuse to run at all:

- when `NODE_ENV` is `production`, in a Vercel environment, or with a live Clerk key
  (`sk_live_` or `pk_live_`), which only a hosted deployment holds;
- against a database that is not on this machine, unless `WILLDER_SELFHOST_ALLOW_REMOTE_DB=1`.
  Set it for a Postgres you run elsewhere. Like every script here, a database URL that comes
  from `.env` must also be local; export `DATABASE_URL` in the shell, or pass
  `ENV_FILE=<file>`, to name a remote one on purpose
  ([development.md](development.md#ten-minute-path-a-local-mcp-server)).

The scripts hold `DATABASE_URL`, which reaches every table without the access check
([README](../README.md#credentials-that-bypass-the-authorizer)). So `--as` and the token rules
make the export and the tokens the ones that person would get in the web app; they are not a
boundary against whoever runs the scripts, who can read the database directly.

## A local model for extraction

Any OpenAI-compatible server works as the model endpoint, Ollama included. Set the three model
variables in `.env` to it, and give `OPENAI_API_KEY` any non-empty value if the server takes no
key. For Ollama serving qwen3:14b:

```bash
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_API_KEY=ollama
OPENAI_MODEL_EXTRACT=qwen3:14b
OPENAI_EXTRACT_EXTRA_BODY='{"reasoning_effort":"none"}'
```

`localhost` serves when the memory service runs on this machine too ([without
Docker](#without-docker)). With docker compose, both this machine and the memory service's
container must reach the address, and Ollama listens on localhost only unless `OLLAMA_HOST`
says otherwise.

A reasoning model (qwen3, for one) thinks before every reply unless the request says not to.
Each write makes extraction calls, so a write can then take minutes, and with `npm run mcp` the
reply to `memory_ingest` waits for the Node side's extraction call: on 2026-10-29 qwen3:14b on
Ollama took about 2.5 minutes per call and the client gave up at its 60 s timeout. The last
line above turns the thinking off for extraction requests only.

`OPENAI_EXTRACT_EXTRA_BODY` is a JSON object whose fields are added to every request to the
extraction model, by both the Node side and the memory service; they replace a request's own
sampling fields of the same name. Unset, nothing is added. It may not set `model`, `messages`,
`tools`, `tool_choice`, `functions`, `function_call`, `response_format`, `stream`,
`stream_options` or `n`, nor `store`, `metadata` or `prompt_cache_retention`, which would have
the provider retain your content. Anything but such an object stops `npm run mcp` and the
memory service at startup, and fails each extraction call, with a line naming the variable. Send only fields your server accepts:
some servers refuse a field they do not know.

## Without Docker

Postgres 16 or newer with the `vector` and `ltree` extensions, Neo4j 5.26 or newer, and the memory
service started from `memory-service/` (its [README](../memory-service/README.md)) work the same
way: point `DATABASE_URL`, `DATABASE_URL_UNPOOLED` and `GRAPHITI_SERVICE_URL` at them, and start
the memory service with `GRAPHITI_TELEMETRY_ENABLED=false`, as the compose file does. Turn off
Neo4j's usage report in its `neo4j.conf` with `dbms.usage_report.enabled=false`.

## The web app

The web app is not part of this path. To run it on the same stack, add the keys of a free Clerk
development instance to `.env` and follow the full path in
[development.md](development.md#full-path-the-web-app-with-memory), skipping what this stack already runs. Every variable is in [environment.md](environment.md).

## What was checked, and where

The `Self-host` workflow ([`.github/workflows/selfhost.yml`](../.github/workflows/selfhost.yml))
runs these steps on a clean runner: it builds and starts this compose file, runs steps 4 to 6
and an export, and, while the stack runs, drops and counts every new connection a container
opens to an address outside its Docker network. It fails unless that count is zero, and then
has a container open one such connection on purpose to show the count sees it. The host-side
commands (steps 4 and 5, the export, the smoke and the MCP servers it starts) run with the same
egress guard the smoke uses, and the job fails if it recorded any host. It runs on changes to
the self-host files, weekly, and by hand; a change elsewhere that adds an outside call is caught
by the weekly run, not by that change's own checks.
