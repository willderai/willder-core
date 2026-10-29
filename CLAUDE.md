# Working on Willder with Claude Code

Willder is shared memory for people and AI agents: scoped project knowledge, retrieved
within a scope, with database-backed access grants and expiring, revocable agent tokens.
`README.md` covers the quickstart and `docs/development.md` local setup; `docs/README.md`
indexes every document and `docs/willder_api.md` is the route reference. `CONTRIBUTING.md`
is the bar a pull request has to meet. `AGENTS.md` holds the Next.js version note; read it
before touching app code.

## Layout

- `app/` Next.js routes and pages; `components/` UI; `lib/` shared helpers.
- `services/` the engine: `access` (grants, tokens, scope checks), `memory` (hybrid
  graph + vector store), `connectors`, `agents`, `audit`.
- `mcp/` the MCP server (stdio locally, hosted Streamable HTTP in production).
- `memory-service/` the Python service around Graphiti and Neo4j.
- `prisma/` schema and migrations; `scripts/` connectivity check scripts and the
  self-host scripts.

## Run the checks

```bash
npm test                       # vitest: *.test.ts (node) and *.test.tsx (jsdom)
npx vitest run path/to/file    # one file
npx tsc --noEmit               # types
npm run lint                   # eslint
npm run lint:dead              # knip: no unreachable file, export or dependency
npm run scope-gate:check       # access-scope lint rules
cd memory-service && .venv/bin/python -m pytest   # Python service tests
```

Tests whose names end in `.live.test.ts`, `.qa.test.ts` or `.realdb.test.ts` need a real
database and skip without one: they read `QA_DATABASE_URL`, which must point at an
isolated Postgres with the `ltree` and `vector` extensions, never a development or
production database — those suites create and delete rows. CI provisions one from the
migrations. `npm run build` refuses to migrate a database it does not recognise as local;
read `build.sh` before changing that.

## The bar for a change

- Readable first: names say what things are, functions do one thing, no cleverness that
  needs a comment to excuse it.
- Documented where it matters: a module comment saying what the file is for and the one
  rule it enforces; doc comments on exports; nothing narrating the obvious.
- Traditional patterns over novelty. Boring, correct and easy to change wins.
- Precise: tests prove the claim, error messages name the fix, no dead code, no secrets,
  no placeholder eras left behind.
- Leave it better: touching a file that breaks these rules means fixing the part you
  touched and saying so in the PR.

## Access control is the product

Every read and write of memory goes through `services/access`. A change that widens what
a token or grant can reach needs a test that proves the old boundary still holds
(`services/access/*.eval.test.ts` are the pattern). Audit records are evidence of a
decision, not proof that a generated answer is right; keep that distinction in copy.

## Secrets and environment

Copy `.env.example` and fill local values; never commit `.env`. `docs/environment.md`
lists every variable the code reads. Capability tokens (`wcap_...`), provider keys and
connection strings never appear in code, fixtures or comments. Fixtures use `localhost`,
reserved example domains and clearly fake tokens.
