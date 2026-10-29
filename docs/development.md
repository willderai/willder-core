# Developing Willder

Running Willder on your own machine: the stack it needs, two setup paths, the scripts, how
the pieces fit, and where the environment variables are. The public quickstart in the
[README](../README.md) uses the hosted service and needs none of this.

Contributing rules — the checks a pull request has to pass and the bar it is held to — are
in [CONTRIBUTING.md](../CONTRIBUTING.md).

---

## Stack

| Layer | Tech |
|---|---|
| Web app | Next.js 16 + TypeScript, Tailwind v4, HeroUI |
| App DB | Postgres / Neon — workspaces, scopes (`ltree`), grants, agent tokens, audit records, conventions and briefs |
| Memory graph | Graphiti + Neo4j (AuraDB) — temporal knowledge graph via Python microservice |
| Semantic retrieval | pgvector chunks alongside graph retrieval; available stores and evidence budgets depend on account settings |
| Models | Any OpenAI-compatible endpoint for generation and extraction (`OPENAI_*`); a local BGE embedding model |
| Agents | Mastra tool wrappers and persisted run loops; Handoff, Architecture, QA and custom agents |
| Async jobs | Inngest for ingestion, connector sync and background agent work |
| Auth | Clerk (orgs, B2B-friendly) |
| Sources | Scoped source ingestion; provider credentials and configuration are required for each connector |
| Tracing | Langfuse (traces + eval dataset) |
| MCP surface | Hosted Streamable HTTP for compatible clients; local stdio for development |

Memory search combines graph and vector retrieval. The vector search also has a text leg: a
query of four or more words finds the rows that hold those words in order, and that ranking is
fused in (`services/memory/text-match-fusion.ts`). There is no general four-store router, and
keyword and episodic retrieval remain proposed. The Starter retrieval preset allows only
source/files backends, which this hybrid path does not use, so it returns no facts; an unset
account tier defaults to Enterprise (`services/memory/account-tiers.ts`, `services/memory/hybrid-store.ts`).

---

## What you need

| | Needed for | Size and source |
|---|---|---|
| Node 20.19+, 22.12+ or 24+ | everything | not 21 or 23: Prisma's install refuses them. `.nvmrc` names 20, what CI runs (`.github/workflows/ci.yml`); `nvm install && nvm use` in the checkout switches to it |
| Docker | Postgres with pgvector, Neo4j | `pgvector/pgvector:pg16`, `neo4j:5.26-community` images |
| Python 3.13 | the memory service; the PROV-JSON validator tests (`scripts/prov/requirements.txt`) | what the memory service `Dockerfile` and CI pin |
| Local models | the memory service | the BGE embedder (~130 MB), downloaded by `python -m app.prefetch`; plus torch through `sentence-transformers` |
| A Clerk development instance | the web app only | free at clerk.com; `npm run mcp` does not need it |
| A model key | writing memory, running agents | any OpenAI-compatible key, a free Groq key works; reads work without one |

## Ten-minute path: a local MCP server

Reaches: `npm run mcp` running over stdio with a capability token minted into a local
Postgres, answering `memory_query`. Skips: the memory service (so no facts can be stored or
found, every query answers "No facts found.", and `memory_ingest` fails), Clerk, the web app,
Inngest, model keys. For the whole engine, memory service included, in one `docker compose up`,
see [self-host.md](self-host.md).

```bash
# 1. Postgres with pgvector (the migrations need the `vector` and `ltree` extensions)
docker run -d --name willder-pg -p 5432:5432 \
  -e POSTGRES_PASSWORD=willder -e POSTGRES_DB=willder pgvector/pgvector:pg16
#    No Docker? A local Postgres with pgvector installed works too (checked with Postgres 17): run
#    `createdb willder` and use postgresql://<your user>@localhost:5432/willder in step 2.
#    Keep the user name in the URL; without it Prisma stops with P1010 "User was denied access".

# 2. Install (postinstall generates the Prisma client) and point at that database
npm install
cp .env.example .env
#    set DATABASE_URL and DATABASE_URL_UNPOOLED to postgresql://postgres:willder@localhost:5432/willder
#    set GRAPHITI_SERVICE_API_KEY to any string

# 3. Apply the committed migrations (never creates one, never prompts)
npx prisma migrate deploy

# 4. Mint a first token: writes a local org, root scope and write token into that database,
#    and refuses any database that is not on this machine or NODE_ENV=production
bash scripts/run-check.sh scripts/dev-token.ts

# 5. Connect Claude Code to the local server, from the repository root (paste the token
#    step 4 printed; it is stored in your user-level Claude Code config, not in this repo)
claude mcp add -s user willder-local -e WILLDER_CAPABILITY_TOKEN=wcap_... \
  -- npm --prefix "$PWD" run --silent mcp
```

`claude mcp list` now shows `willder-local` as connected, from any directory. Start `claude`
and ask it to call `memory_query` on `willder-local`; it answers `No facts found.`

Any other client that launches a stdio server takes the same three parts: command `npm`,
arguments `--prefix <absolute path to this checkout> run --silent mcp`, and
`WILLDER_CAPABILITY_TOKEN` in its environment. Keep `--silent`: without it npm prints its
`> willder@0.1.0 mcp` banner on stdout, which is the MCP protocol channel. To check the server
without a client, run `WILLDER_CAPABILITY_TOKEN=wcap_... npm run --silent mcp`: it prints one
`willder MCP server running` line on stderr and then waits for a client on stdin (Ctrl-C to
stop). With no memory service running, each query also logs a `[hybrid] graphiti retrieve
failed` line on stderr; that is expected on this path.

On Node 21 or 23, `npm install` stops before downloading anything:

```
npm error EBADDEVENGINES Invalid semver version "^20.19 || ^22.12 || >=24.0" does not match "v23.7.0" for "runtime"
```

Switch Node (`nvm install && nvm use` in the checkout, or `brew install node@22` and put it
first on `PATH`) and run `npm install` again. npm older than 10.9 skips that check; there
Prisma's own install script stops instead, with "Prisma only supports Node.js versions 20.19+,
22.12+, 24.0+", and the fix is the same.

On Node 20, `npm install` warns `EBADENGINE` for `@prisma/streams-local`, which asks for Node
22. It is a dependency of the Prisma CLI's local-dev tooling, which no step here uses; the
warning does not stop the install.

A variable exported in your shell wins over the same name in `.env`, for every variable and
every step: Prisma in step 3, and `npm run mcp` afterwards. Unset any stale `DATABASE_URL`,
`DATABASE_URL_UNPOOLED` or `GRAPHITI_*` value first, or the local server reads and writes
whatever database and memory service those name instead. `scripts/dev-token.ts` refuses a
database that is not on this machine. `npm run mcp` and the `*:check` scripts refuse one only when
the URL comes from `.env`; an exported URL is taken as your choice.

Timing: a scripted run of these steps with Docker, on a fresh clone with Node 22, took 214 s
from step 1 to `memory_query` answering `No facts found.` (cold image pull 11 s, `npm install`
68 s, steps 3 and 4 about 5 s together). That is machine time, with reading and typing
excluded; nobody has timed a person typing this path, so ten minutes is the budget, not a
measurement. The steps also work with a local Postgres 17 in place of step 1's container.

If a required variable is missing or blank, `npm run mcp` and the web server stop at startup
with one line naming the variable and how to set it, never a stack trace; the list is the Boot
table in [docs/environment.md](environment.md), and `lib/required-env.ts` checks it. (A Vercel
deployment logs the same line and stays up rather than exiting.)

If the database is missing, stopped or unmigrated, `npm run mcp`, `npm run db:check` and
`scripts/dev-token.ts` stop with one line naming the fix, not a Prisma stack, and the two
cases read differently: `Cannot reach a database at localhost:5432. Start Postgres
(docs/development.md, Ten-minute path, step 1) or point DATABASE_URL at a running database.`
when nothing answers, and `Reached the database at localhost:5432, but it has no Willder
tables (no "capabilities" table). Run: npx prisma migrate deploy (docs/development.md,
Ten-minute path, step 3).` when the server is up but step 3 never ran.

## Full path: the web app with memory

Adds the memory service, Neo4j, Clerk and Inngest. Not timed end to end; the memory-service
install (torch plus about 130 MB of model weights) dominates and depends on your connection,
so start it first and do the rest while it runs.

```bash
# Terminal A: memory service install (start this first)
cd memory-service
python3 -m venv .venv && source .venv/bin/activate
# CPU-only torch first: on Linux, plain pip pulls the CUDA build, several GB
# this service never uses. The same index serves macOS and Windows.
pip install torch --index-url https://download.pytorch.org/whl/cpu
pip install -r requirements.txt
# Download the local embedding model (about 130 MB) now, so the first start
# loads it from disk instead of fetching it before it can answer
python -m app.prefetch
```

```bash
# Terminal B, at the same time
# 1. Install deps (postinstall also generates the Prisma client)
npm install

# 2. Postgres as in the ten-minute path (step 1), plus Neo4j
docker run -d --name willder-neo4j -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/willder-local neo4j:5.26-community

# 3. Copy env and fill in the local values from the table below
cp .env.example .env

# 4. Apply the database migrations
npx prisma migrate deploy
```

```bash
# 5. Terminal A, once its install has finished: start the memory service
cp .env.example .env   # fill in the same local values
uvicorn app.main:app --reload --port 8000

# 6. Start the Inngest dev server (another terminal)
npx inngest-cli@latest dev

# 7. Start the app (terminal B)
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Use `npx prisma migrate dev` only once
you change `prisma/schema.prisma` and need a new migration.

**Local values.** Everything else in `.env.example` can stay blank until you use the feature
it names; [docs/environment.md](environment.md) says what each one does.

| Variable | Local value | Needed for |
|---|---|---|
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | `postgresql://postgres:willder@localhost:5432/willder` (both) | everything |
| `GRAPHITI_SERVICE_URL` | `http://localhost:8000` | every memory read and write |
| `GRAPHITI_SERVICE_API_KEY` | any string, the same in `.env` and `memory-service/.env` | every memory read and write |
| `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD` | `bolt://localhost:7687`, `neo4j`, `willder-local` (in `memory-service/.env`) | the memory service |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL_EXTRACT` | a free Groq key, `https://api.groq.com/openai/v1`, `meta-llama/llama-4-scout-17b-16e-instruct` (in `memory-service/.env`) | writing memory: fact extraction calls this model. For reads only, set `OPENAI_API_KEY` to any non-empty placeholder; blank breaks `/search` |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | keys from a free Clerk development instance | the web app (every product page runs through Clerk) |

**What works with no model key.** Reads never call a hosted model: embeddings run locally in
the memory service (BGE on CPU). `OPENAI_API_KEY` still cannot be blank, because
the service builds its OpenAI client on the first call, search included, and an empty key makes
`/search` fail with a 500; a placeholder such as `OPENAI_API_KEY=not-set` serves reads. Writes
call the model: `memory_ingest` extracts facts with it, and there is no offline extraction mode.

---

## Key scripts

```bash
npm test                  # Vitest; *.realdb/*.qa/*.live suites skip unless QA_DATABASE_URL names an isolated test Postgres
npm run build             # build.sh: Prisma generation + Next build; migrations only in deploy mode
npm run db:check          # connectivity check against the configured database
npm run access:check      # access-control smoke against configured data (ltree/grants/audit)
npm run mcp               # start the MCP server (WILLDER_CAPABILITY_TOKEN=wcap_...)
```

Check scripts hit the configured services and may create test data, so use local credentials.
`build.sh` runs migrations only when `VERCEL_ENV` is set or `ALLOW_PRISMA_MIGRATE_DEPLOY=1`.

---

## Architecture in brief

```
Web app → Clerk session → workspace + human actor      ┐
Hosted MCP → bearer capability → workspace + agent actor ┴→ memory operation
  → scope/permission check → access-decision audit → authorized graph + vector retrieval
  → facts / source context / agent tools
Uploads + connected sources → queued processing → scoped memory
Handoff / Architecture / QA → scoped context → persisted briefs
Memory changes → change feed / notices on subsequent tool calls
```

Handoff briefs a scope for a recipient; Architecture plans and surfaces contradictions; QA
probes a supplied application/API, optionally grounded in a memory scope. Outputs need review;
source changes can mark related work stale but never rewrite existing answers or briefs.

---

## Access control

Guarded memory operations use `check()` to evaluate database-backed scope and permission
rules and record allow/deny decisions. The default is deny. Agents authenticate with
capability tokens (`wcap_...`) whose hashes are stored; each token has a scope, permission and
expiry. Hosted MCP and local stdio share the tool implementations.

Authentication failures, invalid requests and tool discovery can occur before a memory
permission check, so there is not necessarily an access-audit row for every HTTP request.
Revocation stops subsequent authorized use of that token or grant; it cannot erase
information already delivered or close other independent credentials.

Scopes are `ltree` paths: `org_<id>` is the root, `org_<id>.dept_sales` a department,
`org_<id>.dept_sales.crm` a resource. Grants identify a grantee, scope and permission. Capability issuance accepts
`{ agentId, scopePath?, permission, ttlHours? }`. Choose an existing narrow scope deliberately;
omitting it defaults to the workspace root. See the [access guide](https://willder.ai/docs/access).

---

## MCP (use Willder from your AI)

For hosted use, issue a token in **Access → Tokens** and configure a compatible remote MCP
client with `https://willder.ai/api/mcp`, Streamable HTTP, and an
`Authorization: Bearer <token>` header. Use the client's secret storage; it needs no source
checkout or database credentials. Configuration formats vary, and clients requiring OAuth
cannot use this bearer-token flow directly.

Discover the current schemas with `tools/list`. Memory tools are `memory_query`,
`memory_entity`, `memory_ingest`, `fact_link_source`, `memory_changes`, `memory_note` and
`get_my_brief`.
Contact tools (`contact_search`, `contact_read`, `contact_upsert`) require workspace-root
permissions. See [the MCP reference](../mcp/README.md) for hosted and local stdio setup.

### Hear about changes while the agent is busy (Claude Code)

Tool results carry scoped change notices on tool calls, not as a refresh of an existing
answer. An agent busy with files and shell may not call Willder for a while; the optional hook
checks `GET /api/changes/notice` on `UserPromptSubmit` and `PostToolUse` (and on `SessionStart`
after a compaction or a `/clear`, to tell the task-start block at once) and, only when
something changed, gives Claude Code one short block of context:

```bash
node cli/willder.mjs init --project /path/to/your/project   # add --url http://localhost:3000 for a local server
```

It also writes the `willder` server into the project's `.mcp.json`, pointing at the same origin.
It reads `WILLDER_TOKEN` from the agent's environment, never writes it to disk, stays silent
without a token or on any error, and shares the server-side cursor with the MCP tool results,
so each change is told once.

---

## Environment variables

Every variable the code reads, classified as required to boot, required for a named feature,
or dev-only, with the file that reads it: [docs/environment.md](environment.md).
`.env.example` lists the same names in the same groups.
