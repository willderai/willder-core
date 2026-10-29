# Security

## Reporting a vulnerability

Email **security@willder.ai**, or use GitHub's private vulnerability reporting on this
repository. Do not open a public issue. Include the route or tool, the steps, and what you
observed; never include a capability token. You will get a reply within three working days,
and a fix or a dated answer before anything is disclosed. Credit is given if you want it.

In scope: anything that lets a token or a person read, write or list memory outside the
scope and permission they hold, a missing or wrong audit row, a secret in the repository,
and the hosted service at willder.ai. The same holds for the code in this repository when
you run it yourself ([docs/self-host.md](docs/self-host.md)). Out of scope: the accuracy of a
generated answer (an audit row records a decision, not a truth), and denial of service by
volume.

Fixes land on `main`; there are no release branches to patch. If you run the engine yourself,
update from `main` to take a fix.

## Running it yourself

`check()` runs inside the application, so anyone holding a database, graph, memory-service or
job-queue credential reaches memory without it. The README's
[Credentials that bypass the authorizer](README.md#credentials-that-bypass-the-authorizer)
lists each one, what it reaches and what reads it. On your own deployment, keep those
credentials as tightly held as the memory itself, and change `GRAPHITI_SERVICE_API_KEY` in
the `.env` you copied from `.env.selfhost.example` before anything listens beyond localhost.

## The access model

- Every actor is a principal of its own. A person has grants; an agent has a capability
  token (`wcap_...`) with one scope, one permission (`read`, `write` or `admin`) and an
  expiry (default seven days, at most ninety). Only the token's hash is stored.
- Scopes are a tree. A grant on a parent covers its children; a token on one project never
  reaches a sibling or a parent.
- Default deny. Every guarded memory operation goes through `check()` in
  `services/access/check.ts`, a database predicate over grants, capability scope, expiry and
  revocation. No model takes part in any access decision.
- Hosted MCP derives the workspace and agent from the bearer token alone. An organization
  named in a prompt or request body does not switch workspaces.
- Revocation updates the row rather than deleting it, so the record that a token existed,
  and when it ended, survives for review. Revoking twice never moves the date.

## What is audited

`check()` writes one append-only `audit_log` row per decision, allow or deny: actor, action,
target scope, decision and reason. Reads, writes, listing, change notices and
administrative actions (scope, grant and token management) are recorded this way. Rows are
visible under **Audit** and through `GET /api/audit`.

**On the hosted MCP endpoint, a revoked or expired token is refused on its next call, before
any tool runs, and that refusal is audited** as a `capability.refused` deny row attributed to
the token's agent and scope. The hosted endpoint resolves the token on every request. The local
stdio server (`npm run mcp`) resolves its token once, at start, so that door check does not
repeat: after a revocation the process keeps running, and each later access decision is refused
by `check()`, which only matches unrevoked, unexpired capabilities, and audited as an ordinary
deny for that action rather than as `capability.refused`. A token that was never issued is
refused without a row, because there is no agent to record it against. Request validation and
tool discovery happen before `check()`, so not every HTTP request produces a row; every access
decision does.

## What a report cannot change

Revocation ends future access. It cannot recall answers already delivered to a client, and
it does not close other tokens or grants the same actor holds. Review all of them when a
credential is exposed, and rotate the exposed one immediately.
