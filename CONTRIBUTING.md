# Contributing

Willder is shared memory for people and AI agents. It is read cold by strangers, so write
every change as if it ships the day it merges. This file covers setup, how to run the
checks, the bar a change has to meet, what a pull request needs, database changes, and
where decisions are recorded. The documentation index is [docs/README.md](docs/README.md).

## Setup

Local setup is in [docs/development.md](docs/development.md): the
[ten-minute path](docs/development.md#ten-minute-path-a-local-mcp-server) for an MCP server
alone, the [full path](docs/development.md#full-path-the-web-app-with-memory) for the web app
with memory. The fast loop needs only Node and `npm install`; the database-backed suites need
the services that document describes. To run the whole engine in Docker instead, see
[docs/self-host.md](docs/self-host.md). Every variable is in
[docs/environment.md](docs/environment.md).

## Running the checks

```bash
npm test                 # Vitest: *.test.ts under node, *.test.tsx under jsdom
npx tsc --noEmit         # typecheck
npm run lint             # ESLint
npm run scope-gate:check # every memory read goes through check()
npm run build            # the Next production build
npx vitest run services/access   # one directory or file
```

The Python memory service has its own suite. Create its virtualenv once
(`cd memory-service && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`),
then run `.venv/bin/python -m pytest` from `memory-service/`.

Suites that need a real Postgres database read `QA_DATABASE_URL` and skip when it is not
set. Point it at an isolated test database on a local server, never a development or
production one: those suites create and delete rows. Each run builds a template database from
the migrations on that server and gives every Vitest worker its own copy, dropped when the run
ends, so the role needs `CREATEDB` and no migration step is needed first
(`tests/setup/test-databases.ts`).
Scripts under `scripts/` named `check-*.ts` are live connectivity checks against the
services in your environment, not unit tests; `scripts/README.md` lists them.

## The bar

- **Readable first.** A reader can follow the file without you. Names say what things are,
  functions do one thing, and nothing clever needs a comment to excuse it.
- **Comments state the rule.** A module comment says what the file is for and the one rule
  it enforces; exported symbols get a doc comment. No comment narrates the obvious.
- **Boring over novel.** Traditional patterns. No dead code, no unused exports, no
  commented-out blocks, no leftovers from an earlier era, and no internal or team names in
  product code.
- **Tests prove the claim.** A test exists for the behaviour the PR claims, fails without
  the change, and names what it checks. A green build alone proves nothing about behaviour.
  A new read surface comes with a leak test: the forbidden read is attempted and refused.
- **Access rules are non-negotiable.** `check()` in front of every read, including counts
  and feeds. No model in any decision path: visibility, relevance, staleness or ordering.
- **Precise claims.** Error messages name the fix. Documentation describes what exists;
  plans and proposals go in an issue.
- **No secrets, ever.** Not in code, tests, fixtures, docs or commit messages. Environment
  variable names are fine; values are not.
- **Leave it better.** Touching a file that breaks these rules means fixing the part you
  touched, not the whole file, and saying so in the PR.

## Pull requests

- Branch from `main`; one change per PR. Open it as a draft until the checks are green.
- **One claim in the title, true on the deployed service.** "Revoked tokens are refused on
  the next call" is a title; "access improvements" is not. The reviewer verifies the claim,
  not the author.
- The description says what changed, why, how it was verified (the command and its
  result), and what was not verified. A merge is not evidence that something works.
- Keep `docs/README.md` current: every file under `docs/` appears there exactly once.
  Moving or renaming a document means fixing every path that pointed at it, code comments
  included.
- Backticked paths in the README and `docs/` must exist in the repository; a path that no
  longer exists is rewritten or removed, not left for the next reader to chase.
- CI runs typecheck, the unit suite, the scope-containment gate, the
  Next build and a boot check. All of them pass before review.

## Database changes

Migrations live under `prisma/migrations` and apply with `npx prisma migrate deploy`. A
migration must apply from an empty database in name order; the CI job checks this. Never
edit a merged migration: Prisma stores its checksum, so an edit makes `migrate deploy`
fail for everyone who already applied it. That covers the comments inside the file too, so
a path named in a merged migration cannot be rewritten afterwards — name paths there that
will not move.

## Where decisions are recorded

A decision a reader would otherwise ask "why" about is recorded in the pull request that
made it and, when it changes how a module behaves, in that module's header comment.

## License

Willder is MIT-licensed ([LICENSE](LICENSE)). A contribution is accepted under the same
license; there is no separate contributor agreement.

## Reporting

Bugs: open an issue with the step, the exact error text and the client. Never include a
token. Security: report a vulnerability privately as [SECURITY.md](SECURITY.md) describes,
not in a public issue.
