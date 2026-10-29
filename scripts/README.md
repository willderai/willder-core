# scripts/

One-off TypeScript scripts and health/connectivity checks. Run via npm (each loads
`.env` through `tsx --env-file`). Add new checks here and wire an `npm run` alias.

| Command | Script | Checks |
|---|---|---|
| `npm run db:check` | `check-db.ts` | Neon/Prisma: connect (pg adapter), tables exist, write/read/cascade-delete round-trip |
| `npm run memory:check` | `check-memory.ts` | memory-service `/health` (+ Neo4j), TS `MemoryStore` client reaches it over HTTP |
| `npm run mcp:check` | `check-mcp.ts` | Hosted MCP endpoint (`app/api/mcp/route.ts`): drives it through the plain `@modelcontextprotocol/sdk` client over a real socket — `initialize` → `tools/list` → `memory_query` → `memory_ingest` with a read-only token (must be denied + audited) → `memory_ingest` with a write token (must succeed + audit) → missing/unknown bearer token (401). No Claude-specific assumptions anywhere in the client used |
| `npm run access:check` | `check-access.ts` | UC2 access control: real `check()` on Neon — ltree scope containment, default deny, grants (user/role/everyone), time-bound expiry, agent capability tokens, audit log |
| `npm run campaigns:check` | `check-campaigns.ts` | The copy-agent's access path (allowed/denied + audit) — kept, shared "Test run" infra for every agent role. (The name predates the removal of outbound-sales, which dropped this script's campaign/prospect/draft lifecycle coverage along with the models themselves; a rename is a good follow-up.) |
| `npm run check` | all of the above | full local stack (offline-friendly; opt-in flags off) |

CI-only gate (runs on every push/PR, see `.github/workflows/ci.yml`'s
`route-collision-check` job):

| Command | Script | What it does |
|---|---|---|
| `npm run route-collision:check` | `check-route-collision.sh` | Runs `next start` against an existing production build (the gitignored `.next` output directory) and fails if boot reports a dynamic-route slug collision. `next build` alone misses the "leaf vs. subtree" shape — this only catches at the real boot step |

Documentation scans (no database, no network, safe to run anywhere):

| Command | Script | What it does |
|---|---|---|
| `npm run doc-anchors:check` | `check-doc-anchors.mjs` | Resolves every `#fragment` link in tracked markdown against the headings the target file really has. Exits 1 on any break. A link whose file exists but whose anchor does not renders normally and silently drops the reader at the top of the page, so nothing else catches it |
| `npm run doc-paths:check` | `check-doc-paths.mjs` | Lists repository paths named in markdown that do not exist, skipping what is absent by design (gitignored output, config files a setup guide tells the reader to create). A report rather than a gate; `--max <n>` makes it one |

Run directly (no npm alias, each needs live credentials in `.env`):

| Script | What it probes |
|---|---|
| `npx tsx scripts/check-app-shell-width.ts` | The deployed app shell renders at the documented width (`CHECK_BASE_URL`, `CHECK_PATH`, `CHROMIUM_PATH` — see `docs/environment.md`) |
| `npx tsx scripts/list-connected-mailboxes.ts` | Read-only: lists connected Gmail/Outlook rows (internal ids, never the address) and any inbox watch still live, ahead of revoking grants made before mailbox permissions were cut to identity only. Needs `DATABASE_URL` |

Notes:
- The `check-*` scripts are connectivity/lifecycle smoke checks (deterministic, mostly
  offline). Fast unit logic lives in colocated `*.test.ts` (`npm test`, Vitest).
- `npm run dev:stack` (`dev-stack.sh`) boots all three processes (memory-service
  :8000, Inngest dev :8288, Next dev :3000) with one shared Ctrl-C lifecycle, for
  exercising the agent loop generally against a real Inngest dev server. Other
  checks that used to run against that stack were removed along with the
  outbound-sales models and services they checked.
