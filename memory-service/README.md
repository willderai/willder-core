# Willder Memory Service

The **Graphiti + Neo4j** memory engine, run as a Python microservice. The Node app
never imports Graphiti directly — it calls this service over HTTP through the
`MemoryStore` interface in `../services/memory/`. Two-DB split: Neon = app state,
Neo4j = memory (see `../docs/willder_database.md`).

## Status
Implemented: `/ingest` and `/ingest-bulk` (Graphiti `add_episode`: model extraction,
local BGE embedding, dedupe, temporal store), `/search` (BM25 and vector search over
graph edges, fused by reciprocal rank), `/embed`, `/graph`, `/extract` (document text), entity
lookup, and fact, entity and episode deletes. Every call is
partitioned by `group_id` (= tenant).

## Run locally
```bash
cd memory-service
python3 -m venv .venv && source .venv/bin/activate
pip install torch --index-url https://download.pytorch.org/whl/cpu   # CPU-only; plain pip pulls CUDA on Linux
pip install -r requirements.txt
python -m app.prefetch   # cache the embedder (~130 MB) before the first start
# env: copy .env.example to .env and fill it in (local values: ../README.md "Local setup")
uvicorn app.main:app --reload --port 8000
curl localhost:8000/health
```

## Tests

```bash
cd memory-service
.venv/bin/python -m pytest
```

That runs the unit tests. The graph deletion, retirement and citation-provenance
suites each need a real Neo4j and skip without one — 78 of 216 tests, including
the consent-deletion evidence suite that proves retired content is no longer
retrievable. To run them, start a throwaway Neo4j with authentication off (the
tests connect with `auth=None`) and point both variables at it:

```bash
docker run --rm -d --name willder-test-neo4j -p 17687:7687 -e NEO4J_AUTH=none neo4j:5.26-community
NEO4J_DELETE_TEST_URI=bolt://127.0.0.1:17687 \
NEO4J_PROVENANCE_TEST_URI=bolt://127.0.0.1:17687 \
  .venv/bin/python -m pytest
```

Port 17687 rather than the default 7687 on purpose: these tests wipe the
database between cases, and the one they wipe must never be your own. CI runs
the same suites against the same image, so a skip here is a gap in what CI
proves, not a test that is allowed to never run.

## API (bearer-authed with GRAPHITI_SERVICE_API_KEY, except /health)
- `GET  /health` — liveness, Neo4j connectivity and graph extraction (`extraction.status`: `ok`, `degraded` with a `reason`, or `unknown`); see "Model-provider refusals"
- `POST /ingest` — `{ group_id, content, source?, name?, reference_time? }` → `{ episode_id }`
- `POST /search` — `{ group_id, query, limit? }` → `{ facts: [{ uuid, fact, valid_at, invalid_at, expired_at, … }] }`
- `GET  /entities/{uuid}?group_id=` — the entity and every fact on it, in the same `Fact` shape as `/search`
- `POST /graph` — `{ group_ids, query?, limit? }` → `{ nodes, edges }`, each edge with `invalid_at` and `expired_at`

  Graphiti keeps an edge a newer one contradicted and retires it: `invalid_at` is when the fact stopped being true, `expired_at` when the graph recorded that. Graphiti sets `expired_at` whenever it records an `invalid_at`, a future one included. An edge is not current once its `invalid_at` has passed, or, with no `invalid_at`, once `expired_at` is set. Every route that returns a fact reports both marks, in UTC. `/entities` and `/graph` return retired edges; `/search` leaves out an edge whose `invalid_at` has passed, so it does not spend the limit, and returns the rest. The app applies the rule itself: it leaves a retired fact out of an answer, marks it in the graph view and reads a cited one as superseded (`retiredAt` in `../services/memory/graphiti-store.ts`).
- `GET  /facts/{uuid}/resolve?group_id=` — existence lookup for one fact inside one group → `{ found: true, uuid, fact, invalid_at, expired_at }`, or `{ found: false }` when that group holds no such fact. A fact in another group answers `found: false` too, so the app can resolve a caller-supplied uuid against an authorized scope without the answer leaking across the boundary. The sub-path and the 200-with-`found`-flag are both deliberate: `DELETE /facts/{uuid}` claims `/facts/<one segment>`, so a service without this route answers a GET there with 405, and a 404 would be indistinguishable from a route that is not deployed yet.

Keep `app/schemas.py` in sync with the `MemoryStore` contract in
`../services/memory/memory-store.ts` and the shared vocabulary in `../types/memory.ts`.

## Neo4j driver settings
Both Neo4j drivers (the raw one behind `/health` and direct Cypher, and the one
Graphiti runs on) share the pool options in `graphiti_client.driver_options()`,
read from `NEO4J_MAX_CONNECTION_LIFETIME_S` (240), `NEO4J_CONNECTION_ACQUISITION_TIMEOUT_S`
(10), `NEO4J_LIVENESS_CHECK_TIMEOUT_S` (30) and `NEO4J_KEEP_ALIVE` (true). AuraDB closes
idle connections after roughly four to five minutes; a pooled connection that outlives
that is "defunct", and before these settings the next query on it failed and
acquisition then blocked for the driver's default 60 s, the same budget the Node app
gives `/ingest`, so the caller saw a timeout (Railway, 2026-10-01: "Failed to read from
defunct connection", "failed to obtain a connection from the pool within 60.0s"). Now
connections retire before Aura closes them, an idle one is pinged before reuse,
acquisition fails in 10 s, and a dead pool is evicted: `/ingest` and `/search` rebuild
the engine and retry once, then answer 503 so the app can retry instead of timing out,
and the 3-minute keepalive resets whichever driver lost its connection.

A busy pool is not a dead one. When every connection is in use and acquisition times
out, the request answers 503 "overloaded" with `Retry-After: 1`, and nothing is reset.
The 503 comes after the 10 s acquisition timeout, not at once: the Node app's `/search`
call gives up at 8 s, so a read sees a timed-out graph leg (reported degraded) rather
than the 503, and its one retry does not wait for `Retry-After`. Callers with a longer
budget (`/ingest`, `/graph`, `/health`'s own 2 s bound) see the 503 or a degraded
health answer. Not resetting has one cost: a half-open idle connection (dropped by the
network without a reset) can also make acquisition time out, and it now costs one
request a 10 s wait and a 503 instead of a reset. Why not reset for load:
closing the shared driver would kill every other request's queries and add a rebuild to
the load (Railway, 2026-10-10: a burst of about 1,350 `/search` calls did exactly that
and the service stopped answering). Only a lost connection resets a driver or the
engine, once however many requests saw it, and concurrent requests share one rebuild.
`/health` waits at most 2 s for Neo4j and answers `"status": "degraded"` when it does
not hear back, and `/embed` needs no Neo4j at all. A request still holding a driver or
engine that another request's lost connection just closed ("Driver closed") retries
once on the replacement. Graphiti's
`Neo4jDriver` takes no pool options (graphiti-core 0.29.1, unpinned in `requirements.txt`; `tests/test_neo4j_pool.py` guards the swap), so `open_graph_driver()`
replaces the driver it builds with one carrying ours.

## Model-provider refusals
`/ingest` and `/ingest-bulk` call the extraction model for every episode. When its
provider refuses (2026-10-16: a 429 `insufficient_quota` with code
`project_spend_limit_exceeded` on every call for a day), the route answers 503 with a
`detail` naming the refusal and `Retry-After` (300 s for a used-up quota or spend limit,
30 s for a rate limit), never 500, and never the provider's own message, which names the
account's project. A quota refusal is not retried inside the service
(`QuotaAwareLLMClient` in `app/graphiti_client.py`): Graphiti's four attempts with backoff
took about 45 s and still failed. A plain rate limit keeps Graphiti's retries. `/health`
reports `extraction.status` `degraded` for 10 minutes after a refused ingest unless one
succeeds sooner, and the top-level `status` with it; the HTTP status stays 200. The state
is per process, which is every ingest while the service runs one worker
(`app/extraction_status.py`). `/extract` answers the same 503 for a refused image call.

## Event-loop watchdog
Every route is async, so a stuck event loop answers nothing, `/health` included, and a
live but silent process is one the platform never restarts (Railway, 2026-10-14: every
route went silent after a Neo4j connection loss until a manual restart).
`app/watchdog.py` stamps a heartbeat on the loop every second and checks it from its own
thread. After `LOOP_STALL_LIMIT_S` (60) without a beat it writes every thread's stack to
stderr, which names the blocking call, and exits with status 70, so the deploy needs an
on-failure restart policy (Railway's default). Awaiting is not stalling: slow Neo4j
calls, model work and extraction leave the loop free to beat.

## Deploy
Railway/Render from the `Dockerfile`. Set `NEO4J_*`, `OPENAI_*` and
`GRAPHITI_SERVICE_API_KEY` as service env vars (the full list is `.env.example`
here and `../docs/environment.md`); the Node app's `GRAPHITI_SERVICE_URL` points
at the deployed URL.
