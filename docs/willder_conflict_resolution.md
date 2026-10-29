> **What actually ships (2026-10-01).** This design is implemented. The agent-context
> precedence rule — this run's prompt > docs attached to this run > memory, and surface
> the loser rather than dropping it — is written verbatim into the three default agent
> prompts in `services/agents/runner.ts`. The "pull request for memory" dispute flow is
> `model FactDispute` and `enum FactDisputeStatus` in `prisma/schema.prisma`, with the
> logic in `services/facts/conflicts.ts`, `services/memory/fact-disputes.ts` and
> `services/memory/scope-dispute-scan.ts`. Two applied migrations cite this document by
> path (`prisma/migrations/20260713_fact_disputes/`,
> `prisma/migrations/20260910_fact_provenance/`), so this path is fixed.

# Willder — Memory Conflict Resolution (design)

**Status: built.** This was a Day 2 design and is now implemented; the note at the top of
this document names the code. Day 2 captured `actorType`/`actorId` on every episode so it
could be built later with zero rework, and it was built alongside UC2 (access control +
scope tree) and the memory/contacts UI (decided 2026-06-08).

## Mental model: pull requests for your company's memory

The org's **confirmed facts are a protected `main` branch.** Assertions are commits.
Most apply cleanly. A human assertion that **contradicts a confirmed fact** opens a
"fact PR" that an authority reviews before it becomes authoritative. Nothing silently
overwrites — no last-writer-wins.

## GitHub → Willder mapping

| GitHub | Willder memory |
|---|---|
| Protected `main` | Confirmed fact set (per org / `group_id`) |
| Commit | An assertion (episode → extracted fact), stamped with its actor |
| Clean push | Assertion that auto-applies (no conflict, or proposer has authority) |
| Pull request | An assertion that contradicts a confirmed fact and needs review |
| CODEOWNERS / required reviewers | The resolving authority for the scope |
| Merge | Approved → new fact authoritative, prior invalidated |
| Merge conflict | Two assertions disagree on same subject + predicate + overlapping validity |
| Close PR (rejected) | Proposed fact recorded as rejected (not silently dropped) |
| History / blame | Temporal edges + episode provenance (Graphiti `valid_at`/`invalid_at` + `episodes`) |
| Branch protection rules | Per-scope policy: which facts need review, who can approve |

## Flow

1. An assertion arrives (human / agent / extraction) via `add_episode`.
2. **Conflict?** (same subject + predicate, overlapping validity, different object, vs a
   *confirmed* fact)
   - **No** → apply directly (clean push). If it's a genuine real-world change over
     time, that's a temporal update: invalidate-old, add-new.
   - **Yes** → authority check:
     - Proposer **outranks** the existing asserter — by provenance (human > agent >
       extraction) or by being the scope owner / an ancestor — → **auto-merge** (their
       assertion wins, prior invalidated, recorded). Like having merge rights.
     - **Same tier, no authority edge** (e.g. two peers) → **open a fact PR**: the fact
       enters `disputed`, both versions are shown with attribution, and it routes to the
       authority. Nothing flips until resolved.
3. Authority **approves** one (or enters a reconciled value) → it becomes authoritative;
   the loser is recorded `rejected`/`superseded` with the resolver stamped; audit-logged.
4. **Same actor** re-asserting their own fact → just an update, no PR (force-push your
   own branch).

## Authority = CODEOWNERS for the scope

- **Flat org (no hierarchy)** → the **scope admin** (admin of the data scope the fact
  belongs to). The common SMB/early-customer case; the simple MVP rung.
- **Hierarchy** → ownership follows the org people-tree; the resolver is the **lowest
  common ancestor** of the two actors (a manager may be the resolver). Enterprise layer.
- **Admins, and users admins appoint, configure ownership / edit the hierarchy** — like
  managing CODEOWNERS + branch-protection.

## Fact states

`confirmed` (on main) · `disputed` (open PR) · `rejected` (closed PR) · `superseded`
(merged-over or time-invalidated). Graphiti provides the temporal layer
(`valid_at`/`invalid_at`/`expired_at`); the PR/dispute states are **app state (Postgres)**
referencing the Graphiti edge uuids. The graph stays the substrate; governance sits above.

## Auto-merge keeps friction near zero

Most assertions auto-apply. Only a **same-tier human-vs-human contradiction on a confirmed
fact** opens a PR. Machine-extracted facts never block a human (provenance). This is what
makes the model cheap in the common case and only "heavy" exactly when a real dispute
exists.

## Product surface

The fact-PR review reuses the **approval-inbox pattern** — one
human-in-command surface for both draft approvals and fact disputes. "PRs for your
company's memory" is also a clean buyer-facing story.

## Agent context precedence (prompt > docs > memory)

The sections above govern **memory-WRITE provenance** — what's trusted when an assertion
lands *in* memory (human > agent > extraction). This section governs a *different*
question: when an agent assembles the context for **a single run**, what wins if its
inputs disagree. Precedence is **prompt > uploaded docs > memory**, ordered by
specificity + recency of intent:

- **Prompt** — what the human asked for *this run* — is the most specific, most recent
  signal of intent, so it wins.
- **Docs attached to this run** beat standing memory: they were handed to the agent
  deliberately, for this task.
- **Memory** is the governed baseline everything else overrides — the org's confirmed
  facts, applied when the prompt/docs are silent.

Two guardrails keep this from becoming silent last-writer-wins:

1. **Never silently drop the loser.** On a conflict the agent proceeds with the winner
   but **surfaces** the discrepancy in its output — "the prompt says X, memory says Y —
   going with X, flagging the discrepancy." The human always sees what was overridden.
2. **Human-asserted memory gets a veto-flag, not a silent override.** If a prompt or doc
   contradicts a **human-tier** memory fact (a locked decision, an access rule), the
   agent does **not** override it silently — it flags it for reconciliation through the
   existing correction/dispute path (the fact-PR flow above). Lower-tier memory
   (agent/extraction) is overridden-with-surfacing per guardrail 1; human-tier gets the
   review gate.

**Relationship to write-provenance.** These are separate axes. Run-context precedence
decides what an agent *acts on now*; write-provenance decides what's *trusted when writing
into memory*. They meet at persistence: when a doc or prompt is persisted into memory, it
enters at its **actor tier** (the human who supplied it, or the agent that derived it) and
from then on follows the normal conflict-resolution flow above — no special standing just
because it once won a run.

This is prompt guidance today (woven into the agent system prompts in
`services/agents/runner.ts` — the QA, architecture, and handoff prompts), not a separate
engine. It reuses the same surface-and-reconcile posture the rest of this doc describes.

## MVP rung vs enterprise (sequencing)

- **MVP:** provenance default (human > agent > extraction) + surface-both-with-attribution
  + flat scope-admin resolve. No tree, no LCA, no escalation routing.
- **Enterprise:** the LCA org-hierarchy escalation. Build when a real customer's org chart
  needs it and disputes are frequent enough to matter.

The enterprise rung is not needed for the core flow: memory only needs to surface facts and
let a human correct them.
