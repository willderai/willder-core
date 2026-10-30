# Environment variables

Every variable the code in this repository reads, with the file that reads it and what
happens without it. Generated from a scan of `process.env.*`, `os.environ`/`os.getenv` and
shell `$VAR` reads across TypeScript, Python and shell on 2026-10-01, then classified by
hand. `.env.example` lists the same app-side names in the same groups;
`memory-service/.env.example` lists the memory service's.

Three classes:

- **Boot**: the process does not start, or its first request fails, without it.
- **Feature**: needed only when you use the feature named; unset means that feature is
  off, mocked, or refuses with a message.
- **Dev**: read by a script, a test gate, CI or the build; never by the running product.

Receipts are `file:line` at the time of the scan.

## Boot

| Variable | Read by | Without it |
|---|---|---|
| `DATABASE_URL` | `lib/db.ts:16`, `prisma.config.ts`, `lib/db-startup.ts` | The web server, `npm run mcp`, `npm run db:check` and `scripts/dev-token.ts` stop with one line naming the fix. Keep `.env` local: `scripts/run-check.sh` (every `*:check` and `npm run mcp`) refuses a non-local URL that comes from `.env`, so run production tooling with an explicit URL (an exported `DATABASE_URL` or `ENV_FILE=<file>`). |
| `GRAPHITI_SERVICE_URL` | `services/memory/pgvector-store.ts:37` (defaults to `http://localhost:8000`), `services/memory/graphiti-store.ts:141` (no default) | The web server and `npm run mcp` stop at startup with one line naming it. In a script that skips the check, every memory read and write fails. The localhost default is the pgvector store's only; the Graphiti store throws `MemoryServiceError("GRAPHITI_SERVICE_URL is not set")`. The working value for a fresh clone comes from `.env.example`, not from a code default. |
| `GRAPHITI_SERVICE_API_KEY` | `services/memory/graphiti-store.ts:142`, `services/memory/pgvector-store.ts:38`, `scripts/smoke-test.py:34` | The web server and `npm run mcp` stop at startup with one line naming it. In a script that skips the check, the memory service answers 401. Must equal the value in `memory-service/.env`. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk SDK, via `proxy.ts` (`clerkMiddleware`); `instrumentation.ts` | Production only: `next start` stops at startup with one line naming it. `next dev` runs without it in Clerk's keyless mode, which creates a temporary Clerk application. Not read by `npm run mcp`. |
| `CLERK_SECRET_KEY` | Clerk SDK, via `proxy.ts`; `instrumentation.ts` | Same as above. |
| `WILLDER_CAPABILITY_TOKEN` | `mcp/server.ts` | `npm run mcp` stops with one line: mint one with `scripts/dev-token.ts`. |

`lib/required-env.ts` holds this table as code: `npm run mcp` and the web server
(`instrumentation.ts`) check it before anything else and stop with one line naming each
missing or blank variable, never a stack trace. On Vercel (`VERCEL=1`) the web server logs
that line and keeps serving instead: there the check runs in every function instance, and
exiting would fail every request, public pages included. `lib/required-env.test.ts` reads
this table and fails if a row here has no startup check, or a check has no row. It cannot
see a variable the code reads but nobody added to this table.

The memory service (`memory-service/app/config.py`) boots with `GRAPHITI_SERVICE_API_KEY`,
`NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD` and a non-empty `OPENAI_API_KEY` (a
placeholder serves reads; ingest needs a real key). See the memory-service table below.

## Feature

| Variable | Feature | Read by | Without it |
|---|---|---|---|
| `CRON_SECRET` | The every-minute Vercel cron ping that keeps an `/api/mcp` instance warm (`vercel.json` `crons`) | `app/api/mcp/keep-warm.ts` | The cron ping gets the 401 any tokenless `GET /api/mcp` gets, which still warms the instance and touches no database. Set, Vercel sends it as `Authorization: Bearer <value>` on cron requests and `GET /api/mcp` answers them 204 before authentication. Values shorter than 16 characters count as unset; generate one with `openssl rand -hex 32`. |
| `DATABASE_URL_UNPOOLED` | Migrations in a deploy build | `build.sh:33`, `scripts/lib/local-database-guard.ts` | `build.sh` falls back to `DATABASE_URL`. Set both to the same value locally. |
| `NEXT_PUBLIC_APP_URL` | OAuth callbacks, billing redirects, launch-update links, the confirm link a `memory_ingest` reply gives for an agent's decision; the public origin on which `/api/mcp` accepts a request's Origin header | `app/api/integrations/[id]/callback/route.ts:48`, `app/api/billing/checkout/route.ts:20`, `services/launch-updates/resend.ts:23`, `app/api/mcp/origin.ts`, `mcp/tools/memory-ingest.ts` | Defaults to `http://localhost:3000` or the request origin, so a confirm link points at localhost; launch-update signups are refused; `/api/mcp` refuses every foreign Origin off loopback, including the `Origin: https://claude.ai` that claude.ai's custom connectors send. In production it must be the exact https origin clients reach (no path needed; a trailing slash is ignored). Clients that send no Origin (CLIs, IDE extensions, SDKs) are unaffected by a missing or wrong value. A production server logs one line naming it at startup when it is unset, not a URL, or not https on a public host, and keeps serving; a refused request on an https public host gets a 403 naming the variable and, when it is set to another host, both origins. It is inlined at build time, so a change needs a rebuild. |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL`, `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | Clerk routing | Clerk SDK | Clerk's defaults (`/sign-in`, `/sign-up`). |
| `OPENAI_API_KEY` | Agents (Handoff, Architecture, QA), memory chat, coreference | `lib/llm.ts:9`, `services/agents/runner.ts:34`, `services/resolver/index.ts:75` | Agent runs fail at the model call; coreference is skipped. Any OpenAI-compatible endpoint. |
| `OPENAI_BASE_URL` | Same | `lib/llm.ts:10`, `services/agents/runner.ts:33` | `https://api.openai.com/v1`. Groq: `https://api.groq.com/openai/v1`. |
| `OPENAI_API_VERSION` | Azure OpenAI only | `lib/llm.ts:11` | Unset for every non-Azure endpoint. |
| `OPENAI_MODEL_EXTRACT` | Extraction model id | `lib/llm.ts:25` | `gpt-4o-mini`. |
| `OPENAI_EXTRACT_EXTRA_BODY` | Extra JSON fields sent with every request to the extraction model (ingest distillation, coreference, memory-chat disambiguation), e.g. `{"reasoning_effort":"none"}` for a local reasoning model | `lib/llm-extract-options.ts` | Nothing is added. A JSON object only, and it may not set `model`, `messages`, `tools`, `tool_choice`, `functions`, `function_call`, `response_format`, `stream`, `stream_options`, `n`, `store`, `metadata` or `prompt_cache_retention`; any other value stops `npm run mcp` at startup and fails each call to the extraction model (an ingest's distillation, a write's coreference, a memory-chat request) with a line naming the variable. The memory service reads the same variable. |
| `OPENAI_MODEL_GENERATE` | Generation model id | `lib/llm.ts:26`, `services/agents/runner.ts:29` | `gpt-4o-mini`. |
| `OPENAI_MODEL_ORCHESTRATOR` | Memory-chat orchestrator model id | `lib/llm.ts:27` | `gpt-4o-mini`. |
| `ANTHROPIC_API_KEY` | Agents configured with a `claude-*` model | `services/agents/runner.ts:40` | Those agents fail at the model call. |
| `INNGEST_DEV` | Local Inngest dev server | Inngest SDK; `services/agents/manager.ts:544`, `services/agents/manager-arch.ts:310` | The SDK expects Inngest Cloud keys. Set `1` locally. Ignored by the client in a production build (`NODE_ENV=production`, or `VERCEL_ENV` set), which always runs in cloud mode so `/api/inngest` never accepts an unsigned call (`lib/inngest/client.ts`). |
| `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` | Inngest Cloud (production jobs) | Inngest SDK (`lib/inngest/client.ts` creates the client) | Background ingest, connector sync and agent jobs do not run outside the dev server. |
| `INNGEST_BYPASS` | Run ingest and enrichment inline, no Inngest | `lib/inngest.ts:362`, `app/api/accounts/[id]/enrich/route.ts:38`, `app/api/contacts/[id]/enrich/route.ts:38` | Jobs go through Inngest. `scripts/dev-stack.sh` and `scripts/check-mcp.ts` set it to `1`. |
| `APP_ENCRYPTION_KEY` | Connectors, mailbox OAuth, any customer-pasted key | `lib/crypto.ts:12`, `services/integrations/connector-oauth.ts:98`, `services/integrations/mailbox.ts:183` | Those paths throw "APP_ENCRYPTION_KEY must be a 64-char hex string". Generate with `openssl rand -hex 32`. |
| `CLERK_WEBHOOK_SECRET` | Org-membership and user sync from Clerk | `app/api/webhooks/clerk/route.ts` (`readSigningSecrets`) | With `CLERK_WEBHOOK_SECRET_2` also unset, the webhook refuses every request with 503 and never processes an unverified payload. Required wherever the endpoint is registered. The value must be the `whsec_` secret exactly as Clerk shows it: a value that is set but not a usable secret (an empty, all-zero or too-short key, a stray space or newline) also gets 503 on every request, with the variable named in the log. |
| `CLERK_WEBHOOK_SECRET_2` | A second Clerk webhook endpoint delivering to the same URL, e.g. during a secret rotation | `app/api/webhooks/clerk/route.ts` (`readSigningSecrets`) | Only `CLERK_WEBHOOK_SECRET`'s endpoint is accepted; the second endpoint's events get 401. A request is accepted when its signature verifies against either secret, each checked on its own. Set but not a usable secret: every request gets 503, including the first endpoint's. |
| `NEO4J_URI`, `NEO4J_PASSWORD` | Daily Neo4j keep-alive job (app side) | `lib/inngest.ts:795,798` | The job throws. The memory service reads the same names for the graph itself. |
| `NEO4J_USERNAME` | Daily Neo4j keep-alive job (app side) | `lib/inngest.ts:797` | Defaults to `neo4j`, in both the app and the memory service (`memory-service/app/config.py:19`). |
| `BLOB_READ_WRITE_TOKEN` | Upload storage on Vercel Blob | `app/api/memory/upload/route.ts:126`; `@vercel/blob` | Uploads are extracted inline through the memory service instead. |
| `MCP_OAUTH_ENABLED` | OAuth sign-in for the hosted MCP endpoint (claude.ai, ChatGPT) | `mcp/oauth-discovery.ts` | Off unless exactly `true`. Off, `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` answer 404, a 401 from `/api/mcp` carries no `WWW-Authenticate` challenge, the authorize page (`/oauth/authorize`), `/api/oauth/register`, `/api/oauth/token`, `/api/oauth/authorize` and `/api/access/oauth-connections` answer 404, the Connected apps panel on Integrations is absent, and an OAuth access token on `/api/mcp` is refused as an unknown capability token. On, Willder serves all of them as its own authorization server (`services/access/oauth-authorization.ts`). |
| `MCP_OAUTH_RESOURCES` | OAuth tokens for the hosted MCP endpoint | `mcp/oauth-discovery.ts` | Comma-separated public URLs of `/api/mcp`, such as `https://willder.ai/api/mcp`. A token is issued only for one of them and accepted on `/api/mcp` only for the one it was issued for; the request's own host is never trusted for this. With `MCP_OAUTH_ENABLED` on, a host whose `/api/mcp` is not listed answers its protected-resource metadata with 503 naming this variable, and an authorization request for it is refused with `invalid_target`. Capability tokens are unaffected. |
| `NEXT_PUBLIC_CONNECTORS_ENABLED` | Slack/Figma/PostHog/GitHub connectors panel | `components/settings/connectors-panel.tsx:36` | Panel hidden. |
| `SLACK_MOCK` | Real Slack | `services/connectors/slack.ts:22` | Mock data; production is always real. |
| `FIGMA_MOCK` | Real Figma | `services/connectors/figma.ts:17` | Mock data; production is always real. |
| `GDRIVE_MOCK`, `NEXT_PUBLIC_GDRIVE_MOCK` | Real Google Drive (server, browser picker) | `services/connectors/gdrive.ts:10`, `components/settings/sources-panel.tsx:79` | Mock data. |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID`, `NEXT_PUBLIC_GOOGLE_API_KEY` | Drive picker in the browser. The client ID's leading number is the Cloud project number, passed to the Picker as its app ID so `drive.file` grants the picked folder | `components/settings/sources-panel.tsx:80-81` | Picker cannot open; a client ID without the `<project number>-` prefix is refused. |
| `MAILBOX_OAUTH_MOCK` | Real Gmail/Outlook OAuth | `services/integrations/mailbox.ts:14` | Mock tokens. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Gmail OAuth | `services/integrations/mailbox.ts:66,102-103` | Gmail connect fails. |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | Outlook OAuth | `services/integrations/mailbox.ts:67,145-146` | Outlook connect fails. |
| `GITHUB_TOKEN` | GitHub secret-scanning key fetch rate limit | `services/secret-scanning/github.ts:77` | Unauthenticated requests; works, lower limit. |
| `NEXT_PUBLIC_POSTHOG_KEY` | Product analytics | `components/posthog-provider.tsx:18` | No analytics. |
| `PAYMENTS_ENABLED` | Checkout, portal, metered overage | `services/billing/plans.ts:63` | Payments off regardless of Stripe keys. |
| `STRIPE_SECRET_KEY` | Stripe client | `lib/stripe.ts:11,18` | `getStripe()` returns null; billing routes no-op and the Stripe webhook refuses with 503. |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook | `app/api/webhooks/stripe/route.ts:15-36` | Unset, the webhook refuses every request with 503, whether or not `STRIPE_SECRET_KEY` is set: with it set, Stripe retries rather than losing the event; with it unset, billing is off and an unverifiable request is never acknowledged. |
| `ENRICHMENT_APOLLO_ENABLED` | Apollo firmographics | `services/enrichment/index.ts:50` | Apollo recorded as skipped. |
| `APOLLO_API_KEY` | Apollo | `services/enrichment/apollo.ts:9` | Throws "APOLLO_API_KEY is not set" when enabled. |
| `EXA_API_KEY` | Exa company research | `services/enrichment/exa.ts:9` | Throws "EXA_API_KEY is not set". |
| `FIRECRAWL_API_KEY` | Firecrawl site scrape | `services/enrichment/firecrawl.ts:9` | Throws "FIRECRAWL_API_KEY is not set". |
| `RESEND_API_KEY`, `RESEND_UPDATES_SEGMENT_ID`, `UPDATES_FROM_EMAIL` | Launch-update signups | `services/launch-updates/resend.ts:20-22` | Signup form answers "not open yet". All three plus `NEXT_PUBLIC_APP_URL` are needed. |
| `AUDIT_LOG_RETENTION_DAYS` | Audit log retention, as every audit export states it | `services/audit/retention.ts` | `forever`: audit rows are kept indefinitely. A number below 184 (six months) or anything not a whole number makes `GET /api/audit/export` answer 500 with one line naming the fix. Nothing deletes audit rows either way; the database refuses it (see the module comment). |
| `LAUNCH_UPDATES_ADMIN_CLERK_ORG_ID` | Subscriber export | `app/api/updates/export/route.ts:23` | Nobody can export. |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASEURL` | Tracing | `services/langfuse.ts:11-16` | Tracing is a no-op. |
| `HANDOFF_MANAGER` | Handoff fan-out manager | `services/agents/manager-handoff.ts:35` | Off. |
| `WRITE_ROUTING_POLICY` | Write-side routing policy (read by W5 once it lands; nothing acts on it yet). A plain variable, never sensitive: local parity compares it by value | `services/memory/routing-policy.ts:182` | Off: every write absorbs as today. |
| `ARCH_MANAGER` | Architecture manager route | `services/agents/manager-arch.ts:54` | Off. |
| `QA_MANAGER` | QA manager route | `services/agents/manager.ts:87` | Off. |
| `QA_SANDBOX` | QA browser mode in a Vercel Sandbox | `services/agents/qa-sandbox.ts:45` | In-process Chromium. |
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` | Sandbox credentials off Vercel | `services/agents/qa-sandbox.ts:55-57` | On Vercel the SDK uses OIDC; a partial set is ignored. |
| `AGENT_BROWSER_SNAPSHOT_ID` | Pre-built sandbox snapshot | `services/agents/qa-sandbox.ts:76` | Cold VM, slower start. |
| `GRAPHITI_SEARCH_TIMEOUT_MS`, `GRAPHITI_GRAPH_TIMEOUT_MS`, `GRAPHITI_TIMEOUT_MS` | Memory-service call timeouts | `services/memory/graphiti-store.ts:53-55` | 8000, 15000, 20000 ms. |
| `NODE_ENV`, `VERCEL`, `VERCEL_ENV` | Platform | `NODE_ENV` at `lib/db.ts:19,25`; all three at `build.sh:37,89`, `services/connectors/{slack,figma}.ts`, `scripts/lib/local-database-guard.ts:16-17` | Set by Node and Vercel, not by hand. |
| `ALLOW_PRISMA_MIGRATE_DEPLOY` | Migrations in a non-Vercel build | `build.sh:37` | `build.sh` skips migrations. |
| `MIGRATE_LOCK_ATTEMPTS`, `MIGRATE_LOCK_WAIT_SECONDS` | Migration advisory-lock retry | `build.sh:62-63` | 6 attempts, 10 s. |

## Dev

Scripts, test gates, CI and the agent-side hook. Nothing in the running product reads these.

| Variable | Read by | Purpose |
|---|---|---|
| `ENV_FILE` | `scripts/run-check.sh:10` | Env file for `npm run *:check` and `npm run mcp` (default `.env`). A named file that does not exist prints a warning and the check runs on the ambient environment. |
| `DEV_TOKEN_AGENT`, `DEV_TOKEN_PERMISSION`, `DEV_TOKEN_TTL_HOURS` | `scripts/dev-token.ts:16-24` | Options for the local first token. |
| `WILLDER_SELFHOST_ALLOW_REMOTE_DB` | `scripts/lib/local-database-guard.ts` | `1` lets `npm run selfhost:token`, `selfhost:export` and `selfhost:smoke` use a database on another machine, named in the shell (a URL from `.env` must be local regardless); any other value is refused ([self-host.md](self-host.md#where-the-scripts-refuse-to-run)). |
| `SELFHOST_EGRESS_ALLOW`, `SELFHOST_EGRESS_LOG` | `scripts/lib/egress-guard.mjs` | Set by `scripts/selfhost-smoke.ts` for the processes it starts: the hosts they may reach, and where refused connections are recorded. |
| `CHECKPOINT_DISABLE` | the Prisma CLI | `1` stops `npx prisma` reporting usage to `checkpoint.prisma.io`; `.env.selfhost.example` sets it. |
| `QA_DATABASE_URL` | `*.realdb.test.ts`, `*.qa.test.ts` (76 reads) | Real-Postgres test gate; the suites skip without it. |
| `PROV_PYTHON` | `services/audit/prov-validator.testsupport.ts:12` | A Python 3.13 or newer with `scripts/prov/requirements.txt` installed; the PROV-JSON tests skip without it, and fail in CI. |
| `LIVE_DB_TESTS`, `MEMORY_SERVICE_LIVE`, `HANDOFF_E2E_LIVE`, `HANDOFF_E2E_NEON_HTTP`, `HANDOFF_GATE_C_LIVE` | `services/access/scope-index-plan-shape.test.ts:91`, `services/memory/fact-resolve-route.live.test.ts:23`, `app/api/handoff-*.live.test.ts` | Opt-in gates for live suites. |
| `HANDOFF_LIVE`, `FACTGOV_LIVE` | `scripts/check-handoff.ts:16`, `scripts/check-fact-governance.ts:31` | `1` makes a check script hit real services. |
| `CHECK_BASE_URL`, `CHECK_PATH`, `CHROMIUM_PATH` | `scripts/check-app-shell-width.ts:14-32` | Layout check target and browser. |
| `SMOKE_SESSION_TOKEN` | `scripts/smoke-test.py:35` | Hosted smoke test session. |
| `PORT` | `scripts/check-route-collision.sh:33` | Port for the boot check (default 4590). |
| `WILLDER_TOKEN`, `WILLDER_URL` | `cli/hooks/willder-changes.mjs:73-74` | The Claude Code change-notice hook, in the agent's environment, not the server's. |
| `GITHUB_EVENT_NAME`, `GITHUB_EVENT_PATH`, `GITHUB_OUTPUT`, `CI` | `scripts/ci-realdb-coverage.test.ts:168` | Provided by GitHub Actions. |
| `NEO4J_DELETE_TEST_URI`, `NEO4J_PROVENANCE_TEST_URI`, `RUN_INTEGRATION` | `memory-service/tests/*.py` | Memory-service integration test gates. |

Not listed: shell-local names inside `build.sh` and `scripts/*.sh` (`DB_URL`, `LOG_FILE`...),
fixture names inside tests, `EMBEDDING_DIM` (set, not read, by
`memory-service/app/graphiti_client.py:41`).

## Memory service (`memory-service/.env`)

Read by `memory-service/app/config.py` through pydantic-settings; field names map to
upper-snake variables. The process environment and this file are the only sources: the service
turns off the `.env` walk `graphiti_core` runs at import (`memory-service/app/__init__.py`), so the
app's root `.env` never reaches it. With `WILLDER_LAB_MODE=1` it reads no `.env` at all, and every
Neo4j driver it builds refuses a `NEO4J_URI` that is not this machine
(`memory-service/app/lab_guard.py`). An empty `NEO4J_URI` turns the graph off.

| Variable | Class | Without it |
|---|---|---|
| `GRAPHITI_SERVICE_API_KEY` | Boot | Every request from the app is refused. Same value as the app's. |
| `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD` | Boot | No graph; the service cannot answer. |
| `NEO4J_DATABASE` | Feature | Empty = the connection's home database (right for AuraDB). |
| `OPENAI_API_KEY` | Boot for reads (any non-empty value), real key for ingest | Blank breaks `/search` with a 500; a placeholder serves reads; ingest needs a real key. |
| `OPENAI_BASE_URL`, `OPENAI_MODEL_EXTRACT`, `OPENAI_API_VERSION` | Feature (extraction) | `https://api.openai.com/v1`, `gpt-4o-mini`, unset. |
| `OPENAI_EXTRACT_EXTRA_BODY` | Feature (extraction) | Nothing is added to Graphiti's extraction requests. Same rule as the app's: a JSON object that sets none of the request's own fields, or the service does not start. |
| `BGE_MODEL`, `BGE_DIM` | Feature (embeddings) | `BAAI/bge-small-en-v1.5`, 384. `BGE_DIM` must match the Neo4j vector index. |
| `BLOB_READ_WRITE_TOKEN` | Feature (private blob downloads for `/extract`) | Private upload URLs answer 403 to the extractor. |
| `GRAPHITI_TELEMETRY_ENABLED` | Feature (read by `graphiti_core`, not the app) | Unset means true: Graphiti sends anonymous telemetry. `docker-compose.yml` sets `false`. |
| `HF_HUB_OFFLINE` | Feature (read by `huggingface_hub`) | Unset, the embedder may be fetched from Hugging Face. `docker-compose.yml` sets `1`; its image carries the model. |

## Names documented before and read by nothing

`GROQ_API_KEY`, `GROQ_MODEL_EXTRACT`, `GROQ_MODEL_GENERATE`, `UNIPILE_API_KEY`,
`UNIPILE_DSN` and `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` appeared in the previous
`.env.example` and README but no code reads them. The model client reads `OPENAI_*`; a Groq
key goes in `OPENAI_API_KEY` with `OPENAI_BASE_URL=https://api.groq.com/openai/v1`.

## Keeping this true

The scan is a small Node script over the tree; re-run it after adding a `process.env` read
and add the row here and in `.env.example` in the same change. A name that appears in
`.env.example` but nowhere in code is a documentation bug, not a configuration option.
