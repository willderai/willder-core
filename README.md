# Willder

**Apps, Agents, Teams Synced. Access decided in the database, never in a prompt.**

One memory for every agent you run. Each agent holds its own scoped, expiring token; every
read and write goes through one database check and lands in the audit; revoke a token and
its next call is refused. Connect your Claude Code or Cursor agent over MCP in five minutes.


## Why

You run several agents on real work: a coding agent in the repo, a research agent on a
schedule, a side project's agent. Nothing decides what each may see, tells the others when one
changes something, or records what was read. Willder is the memory they share and the fence
between them: scopes, per-agent tokens, a change feed and an audit, with no model in any
access decision.

## Run it on your machine

This repository is the engine: Postgres with pgvector, Neo4j, the memory service and the MCP
server. It runs on your own machine with no willder.ai account and no call to willder.ai. You
need Docker with Compose v2, Node 20.19+, 22.12+ or 24+, and a few GB of disk. Without Docker,
[docs/self-host.md](docs/self-host.md#without-docker) says what to run instead.

```bash
git clone https://github.com/willderai/willder-core.git && cd willder-core
npm install
cp .env.selfhost.example .env          # then set GRAPHITI_SERVICE_API_KEY to any string
docker compose up -d --wait            # Postgres, Neo4j, the memory service; the first build takes minutes
npx prisma migrate deploy              # create the tables
npm run selfhost:smoke                 # write, scoped read, refusal, export, no outside calls
```

The smoke ends with `9 of 9 steps passed`. [docs/self-host.md](docs/self-host.md) describes each
line it prints and what to do when one fails.

**Mint a token for your agent.** One per agent, scoped and expiring:

```bash
npm run selfhost:token -- --scope team --agent claude-code
```

It prints a `wcap_...` token once. Put it in an environment variable and nowhere else:

```bash
printf 'Willder token: '
stty -echo; read -r WILLDER_TOKEN; stty echo
printf '\n'
export WILLDER_TOKEN
```

**Connect Claude Code** to the local stdio MCP server, from this directory:

```bash
claude mcp add -s user willder-local -e WILLDER_CAPABILITY_TOKEN="$WILLDER_TOKEN" \
  -- npm --prefix "$PWD" run --silent mcp
```

Then tell the agent: `Save this to Willder: we store sessions in Postgres, not Redis, so they survive a restart. Then ask Willder where we store sessions and why.`
It calls `memory_ingest` with two required arguments, `content` (the fact) and `name` (what the
fact is about), and gets back the id a later update passes as `baseVersion`:

```
Stored and readable now; graph extraction continues in the background. Version: <version id>.
```

Then it calls `memory_query`, which returns one bullet per fact with when and who wrote it (an
agent that has only a token is named by it, quoted), notes on what its grant let it read, and the
answer's revision:

```
• we store sessions in Postgres, not Redis, so they survive a restart. (as of <when it was stored>) — from: "claude-code" (agent token) (agent) · version <version id>
revision: <16 hex characters>
```

A token for another scope (`npm run selfhost:token -- --scope research --agent second-agent`)
gets `No facts found.` for the same question. Other clients: [docs/connect/](docs/connect/README.md);
the stdio server and its tools: [mcp/README.md](mcp/README.md#local-stdio-development).

The engine calls out to one thing at most, and only if you configure it: an OpenAI-compatible
model endpoint that extracts facts on writes (a local server works; without one a write is still
stored and readable, and only graph extraction is skipped). The web app is optional: it needs a
free Clerk development instance to sign people in, and
[docs/self-host.md](docs/self-host.md#what-it-needs) lists the other outside calls it makes.
An export is one JSON Lines file in a documented format:
[docs/export-format.md](docs/export-format.md).

Prefer not to run it? The hosted service at [willder.ai](https://willder.ai) runs the same
engine: [docs/quickstart.md](docs/quickstart.md).

## Prove it does not leak

Two checks, about ten minutes, and neither needs an account. The second revokes the
`claude-code` token from [Run it on your machine](#run-it-on-your-machine) (any token you are
willing to revoke works).

**1. Run the leak suite.** From a fresh clone, with Node 20.19, 22.12 or 24:

```bash
git clone https://github.com/willderai/willder-core.git && cd willder-core
npm ci
npm run test:leaks
```

Installing takes about a minute; the suite runs in seconds with no keys and no network. It
is every test file named `*eval.test.ts`, `*leak.test.ts` or `*leakage.test.ts`: `check()`,
the guarded memory reads and the MCP tool bodies run for real, and only the database and
memory backends are stubbed. A pass ends with no failed file. One file,
`app/api/briefs/staleness-scope-leak.test.ts`, reports as skipped unless `QA_DATABASE_URL`
names a test Postgres ([docs/development.md](docs/development.md)). The suite asserts that:

- a token scoped to one team never receives a sibling scope's facts, graph nodes, uploaded
  files or briefs, and the in-scope token still does, so an over-broad filter fails too;
- a revoked or expired token is refused on every memory tool over the real MCP endpoint;
- a call without a real caller identity is denied, never audited under a stand-in actor;
- the account tier can narrow a read and never widen one;
- the same holds with thousands of facts and concurrent callers, and a backend failure is
  reported as a failure, not as an empty answer.

A few cases are named `GAP:`. They pass by pinning a known defect, and each one says what
the correct behaviour is. The suite proves the code; step 2 proves the running service.

**2. Revoke a token and see its next call refused.** Revoke the agent's token from the
terminal:

```bash
npm run selfhost:token -- --revoke claude-code
```

It prints each token it revoked by id, scope, permission and expiry, never the token, and nothing
waits for the token to expire. What the agent sees next depends on how it connects:

- **A stdio MCP server already running**, like the `claude mcp add` connection above: it keeps
  listing its tools, but every memory call after the revoke is refused and nothing is read or
  written. Memory tools answer `Access denied: no valid capability for agent claude-code granting
  read` (or `write`) `on the target scope …`, and each refusal is a deny row in the audit log
  under the call's own action (`memory.read`, `memory.write` or `memory.entity`).
- **A stdio MCP server started with the revoked token** exits before connecting, with
  `WILLDER_CAPABILITY_TOKEN is not a live token in this database (unknown, expired or revoked)`,
  and records a `capability.refused` row.
- **Over HTTP**, the web app's `/api/mcp` or `https://willder.ai/api/mcp` on the hosted service,
  the next call gets `HTTP 401` with `Invalid or unknown capability token.` and a
  `capability.refused` deny row for that agent.

`npm run selfhost:export` holds every one of those refusals as `audit` lines.

## Measured on the hosted service

Measured with dates: the first three rows on the hosted service at willder.ai, the setup row in
a clean container. The harness that produced them is not in this repository. Implementation is
not proof, and nothing here is a guaranteed latency.

| Claim | Evidence | Status |
|---|---|---|
| Access control under failure: scoped tokens, default deny, a token revoked mid-sequence denied on its next call, one audit row per read and per refusal | 2026-10-01: held under six concurrent readers and a revoke mid-sequence | Proven in production at failure load |
| Connected sources: connect, ask, get a cited answer, disconnect, answer gone | 2026-09-26, GitHub: 5 of 5 steps, sync 177.6 s, cited answer in 0.9 s, answer gone 1.6 s after disconnect. Disconnect mid-sync and credential failures are measured separately | Proven in production at normal load (GitHub); other connectors not individually measured |
| Real-time memory: a write is readable by other agents on their next call | 2026-10-02, six concurrent writers: 60 of 60 writes acknowledged, write-to-read p50 575 ms, p95 1025 ms timed from before the write is sent | Proven in production at six concurrent writers |
| Setup: clone to first query, following the ten-minute local path in [docs/development.md](docs/development.md#ten-minute-path-a-local-mcp-server) | 2026-10-07: scripted cold install on a clean Ubuntu 24.04 container, 254.4 s from machine start to the first answer (102.6 s of it after the clone), zero stalls, first answer `No facts found.` Scripted operator, reading time excluded. | One measured sample, not a promised time |

Audit rows are evidence of access decisions, not proof that an answer is correct. The
code-level leak claims are reproduced without an account by `npm run test:leaks`
([Prove it does not leak](#prove-it-does-not-leak)).

## Limits

Each line names the file that makes it true.

- **Who can see what is decided by `check()` in the application, not by the database.** No
  row-level security is enabled (no migration in `prisma/migrations/` creates a policy), so
  the credentials listed in the next section reach memory without `check()`.
- **Source permissions do not carry over.** A connected source takes the access of the
  scope it lands in, not its own sharing list. Connecting asks you to acknowledge any
  widening, people and agents both, before it goes ahead
  (`services/access/source-widening.ts`).
- **Conflicting writes are detected and notified, nothing more.** When two agents write the
  same fact in one scope within one second, the version stored first stays current, the
  later one is recorded as superseded, and its writer is told on its next tool call. Both
  versions stay readable (`services/memory/conflict.ts`, `mcp/README.md`).
- **No cost saving is claimed.** No measure of tokens per run has run on a deployed commit.
- **Connectors read, with one write.** GitHub, Google Drive, Slack, Figma, PostHog and
  websites today (`SourceType` in `prisma/schema.prisma`); no Linear connector. The one
  write into a connected tool is exporting a brief as a new Google Doc in the org's
  connected Drive (`POST /api/briefs/[id]/export-doc`, `createGoogleDoc` in
  `services/connectors/gdrive.ts`). Nothing else writes back to a connected tool
  (`services/connectors/source-readers.ts`).
- **The memory service needs Neo4j and a local embedding model** (about 130 MB), plus an
  extraction model key to write. Reads work without a model key
  (`memory-service/README.md`, `memory-service/app/config.py`).
- **OAuth-only clients cannot connect yet.** claude.ai and ChatGPT sign in with OAuth, which
  is built but off until `MCP_OAUTH_ENABLED` is turned on in production
  (`mcp/oauth-discovery.ts`); until then hosted MCP needs a client that sends the bearer header.
- **MCP has no delete tool.** A fact is replaced with `memory_ingest` and `baseVersion`;
  deleting one goes through the app (`mcp/tools/`, `mcp/README.md`).
- **The Starter account tier returns no facts.** It allows only the `source` and `files`
  stores, and memory search reads only the graph and vector stores
  (`services/memory/account-tiers.ts`, `services/memory/hybrid-store.ts`).

## Credentials that bypass the authorizer

Memory in Postgres is read and written through `check()` in `services/access/check.ts`.
The lint gate `eslint.memory-access.mjs` enforces this in code: a query against a memory
table (a model marked `@memory` in `prisma/schema.prisma`) outside `services/access` and
`services/memory` fails `npm run scope-gate:check` in CI, and no `eslint-disable` comment
can silence it there. The gate does not cover the memory
graph: a few routes and jobs still write it through the unguarded `memory` store export
rather than `guardedMemory`, and the gate does not see those calls. The authorizer runs
inside the application, so a person holding one of these credentials can reach memory
without it.

| Credential | What it reaches without `check()` | Read by |
|---|---|---|
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | Every Postgres table, memory tables included. No row-level security is enabled. `build.sh` runs migrations with it, so it can also change the schema. | `lib/db.ts`, `prisma.config.ts`, `build.sh` |
| `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD` | The memory graph itself: every org's entities, facts and episodes. | `memory-service/app/config.py`, `lib/inngest/scheduled-jobs.ts` |
| `GRAPHITI_SERVICE_API_KEY` | The memory service's HTTP API. It trusts whatever `group_id` the caller sends, so the key can read or write any org's graph partition. | `memory-service/app/main.py` (`require_api_key`), `services/memory/graphiti-store.ts` |
| `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` | Background jobs. The memory-ingest, file-ingest and connector-sync jobs write what their event payload names, because the request that sent the event has already been authorized. A forged event writes memory into any scope. | The Inngest SDK, through `lib/inngest/client.ts` and `app/api/inngest/route.ts` |
| `BLOB_READ_WRITE_TOKEN` | Uploaded source files, stored privately under `memory/<orgId>/`, before extraction. | `@vercel/blob`, through `lib/blob-storage.ts`; `memory-service/app/config.py` |
| `CLERK_WEBHOOK_SECRET`, `CLERK_WEBHOOK_SECRET_2` | A forged membership event writes an episode naming the member into the org's graph through the unguarded store, and deletes that user's row. | `app/api/webhooks/clerk/route.ts` |
| `APP_ENCRYPTION_KEY` | With database access, the sealed connector and mailbox credentials (`Source.encryptedTokens`, `Integration.encryptedTokens`, mailbox OAuth tokens), and through them the connected sources that memory is built from. | `lib/crypto.ts`, `services/integrations/mailbox.ts` |
| `LANGFUSE_SECRET_KEY` | Agent traces. These record the full prompt, including memory an agent was allowed to read. | `services/langfuse.ts` |
| `VERCEL_TOKEN`, or other access to the Vercel project's environment | Every value above. The QA sandbox reads the token wherever it is set, and uses it with `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` (without them, on Vercel, it authenticates by OIDC); a token with access to the project can read its environment. | `services/agents/qa-sandbox.ts`; Vercel |

Credentials that act as someone *through* the authorizer are not on this list, because
`check()` still decides what they can do: capability tokens, a Clerk session, and
`CLERK_SECRET_KEY` (which can sign in as any user). Revoking or narrowing those works as
described above. Rotating one of the credentials in the table is the only way to cut off
whoever holds it.

`npm run bypass-credentials:check` (`scripts/check-bypass-credentials.mjs`) keeps this
table honest: it fails when the code or `.env.example` reads a credential that is neither
listed here nor recorded there with the reason it does not reach memory.

## Reference

- [docs/self-host.md](docs/self-host.md): every self-host step, tokens, revoking, export, refusals, no Docker.
- [mcp/README.md](mcp/README.md): tools, permissions, the local stdio server.
- [docs/development.md](docs/development.md): the web app and local development.
- [docs/willder_api.md](docs/willder_api.md): the route map.
- [docs/architecture.md](docs/architecture.md): the architecture, with diagrams and measured numbers.
- [docs/README.md](docs/README.md): every document in this repository, one line each.

## Contributing and security

[CONTRIBUTING.md](CONTRIBUTING.md) covers tests, lint and what a PR
needs. Report a vulnerability per [SECURITY.md](SECURITY.md), not in a public issue.

MIT, see [LICENSE](LICENSE).
