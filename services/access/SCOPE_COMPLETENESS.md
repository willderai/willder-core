# Scope-completeness: the other half of a leak test

willder's access-control architecture is a **pre-filter**, not a post-filter.
`check()` (services/access/check.ts) makes one allow/deny decision on the
*query as a whole* (`scope IS the query key`, guarded-store.ts:200 — the
resolved scope becomes the actual partition/containment key the read is run
against), then every guarded store method (`retrieve`, `entity`, and each
MCP tool's own DB query) uses that same scope to decide which ROWS come
back. There is no second, independent filter downstream that re-checks each
row on the way out.

One narrow, deliberate exception: `get_my_brief`'s
`briefId` branch (`mcp/tools.ts:274`) fetches the row by `{ id, orgId }`
first, then calls `check()` against that row's own `scopePath` — a genuine
fetch-then-check, not a pre-filter, for that one lookup. It has to work this
way: there's no scope predicate on a single-row `findFirst` to pre-filter
with without just re-authorizing the caller against itself and saying
nothing about the specific row requested (see the code comment at that
line). It stays correctly audited and does not read the same
"wrong-data-instead-of-denial" risk described below, since it's a single
already-identified row, not a query whose result set narrowing could hide
missing content. Everywhere else in this document, "pre-filter" is accurate
as stated.

That shape has a consequence the leak-scenario convention alone doesn't
cover: an authz bug here doesn't have to look like "denied when it should
allow" or "returned content it shouldn't have." It can just as easily look
like **wrong data** — a correctly-allowed read that silently returns less
than it should, because the query/filter logic narrowed on the wrong
condition. A leak test would never catch that; it only asserts absence.

## The convention

**Every leak-scenario test (asserts out-of-scope content is withheld) gets a
scope-completeness counterpart (asserts in-scope content IS returned).**
Same fixture, same scope relationships, opposite assertion. Skipping the
completeness half means a narrowing bug can ship with the leak suite fully
green — which is exactly what happened, repeatedly, before this convention
existed (see "Why this exists" below).

For a guarded read path, that means a paired case at each scope
relationship that can actually occur between the caller's granted scope and
the content's own scope:

1. **Exact match** — the caller's scope equals the content's scope. The
   simplest positive case; if this doesn't hold nothing else matters.
2. **Ancestor grant, descendant content** — the caller is scoped ABOVE the
   content (e.g. a root-scoped capability, content tagged to a child deal).
   `check()`'s containment rule is `grant @> target`, so a broader grant
   must still surface everything nested below it. The retired outbound
   draft list missed this relationship and let a root token *approve* a
   descendant draft while the list said "No pending drafts" for the same
   token — an approve-what-you-cannot-see mismatch that only a completeness
   assertion, not a leak assertion, would catch.
3. **Null/org-wide content** — untagged content has no scope of its own and
   must remain visible from *any* scope in the org, narrow or broad. This is
   the mirror image of the leak-scenario convention's own "ancestor content
   does NOT leak into a narrower read" case (`services/memory/access-leakage-eval.test.ts`
   Case 2) — only a null-scoped fact is org-wide-visible, an *explicitly*
   root-scoped one is not, and both directions need their own assertion or
   one regressing silently proves the other meaningless.

Not every guarded path has all three relationships available to it — see
the per-path notes below. Where a relationship doesn't structurally apply,
say so in the test file rather than leaving silence a future reader has to
re-derive.

## The template: the control test

`services/memory/access-leakage-eval.test.ts` — the file written for
the leak-scenario convention itself — already carries this shape correctly
in a few places, and is the one place the pattern existed *by accident*
before this file made it standing policy:

- Case 1 (`sibling scope`) pairs a leak assertion (`assertNoLeak` against
  Deal B) with a completeness assertion in the same `it()`
  (`expect(facts.map(...)).toEqual(expect.arrayContaining([...]))` against
  Deal A's own fact **and** its descendant `.notes` fact) — proving the
  narrow-scope read isn't just "nothing leaked" but "the right things came
  back, at both the exact-match and descendant-content relationship."
- Case 4 (Drive read-side enforcement, `memory_query`) does the same for a
  narrow (Deal A) token: `expect(text).toContain(...)` for its own
  Drive-sourced content in the same test that asserts Deal B's Drive content
  never appears.

Both are real completeness assertions living in a leak-scenario file — this
is what "pair it with the leak test, don't write a separate suite" looks
like in practice. New cases below follow the same shape: one `it()` per
scope relationship, added next to (not instead of) the leak assertion it
completes, in the same file as the leak tests it pairs with.

## Why this exists: the narrowing-direction bug keeps shipping, caught only
## by a person

- `memory_ingest` scope defaulting: the write-side default landed with test
  coverage for "denied outside scope" but the "still works inside scope" case
  was found by hand, not by a standing assertion.
- The retired outbound draft and campaign scope paths: the draft list's
  first cut filtered by exact scope equality while `check()` and the approve
  and reject tools already used ltree ancestor-or-self containment — a
  root-scoped token could approve a draft it could not list. Caught in
  review, not by a test, because no test asserted a broader-scoped token
  could see a descendant's content at all. That surface has since been
  removed with the outbound-sales backend; the lesson is why this document
  exists.
- A capability-owner check on agent tokens shipped correctly for the deny
  direction; the allow direction for the token's genuine owner was
  re-verified by a person reading the diff, not by an assertion that a
  legitimately-owned in-scope call still succeeds.
- `get_my_brief`'s malformed-scope guard fixed the crash/bypass on a
  malformed caller scope, and its own test file
  (`mcp/get-my-brief-scope-validation.test.ts`) is careful to include "a
  well-formed caller scopePath is still honored — the guard must not
  swallow valid narrowing" for the *malformed-input* guard specifically.
  But `services/access/brief-scope-leak.eval.test.ts` — the file that
  actually exercises `get_my_brief` against real fixture content — had zero
  positive assertions of any kind: three `it()`s, all three asserting a
  denial or an empty result. Nothing in the suite proved a `get_my_brief`
  call for content that genuinely belongs to the caller's own scope ever
  returns that content. See the fix below.

Each of those gaps stays closed once its completeness case lands — this
document adds the missing completeness half going forward and where an
existing leak-test file had zero positive coverage at all (`get_my_brief`).
If auditing surfaces an actual remaining defect, that's a new fact row to
track, not a reason to reopen a closed case without evidence.

## Coverage by guarded read path

| Path | Exact-match | Ancestor→descendant | Null/org-wide | Notes |
|---|---|---|---|---|
| `memory_query` | ✅ (`services/memory/access-leakage-eval.test.ts` Case 1) | ✅ (Case 5) | ✅ (Case 1's `f-org-wide`, Case 2's negative control) | `services/memory/guarded-store.ts`'s pgvector leg does real ltree-style containment (`scopePath = X OR LIKE 'X.%' OR NULL`), so all three relationships are reachable. |
| `memory_entity` | ✅ (`services/memory/access-flow.test.ts`, `entity` describe block — passes a scope distinct from `groupId` and asserts it's what the query actually runs against, not just the bare-`groupId` default) | ✅ (`services/memory/access-flow.test.ts`'s "found under a real registered descendant scope" case) | ✅ (`services/memory/mcp-read-scope-partition.test.ts`'s org-wide entity-seed case) | `GuardedMemoryStore.entity()`'s exact-`groupId` miss also looks in every real, registered descendant scope under `target` (`descendantScopePaths()`, `services/access/check.ts`, an ltree `<@` lookup) in one call before giving up, the same lookup `app/api/memory/graph/route.ts` uses for its own descendant `groupIds` list. |
| `get_my_brief` | ✅ | ✅ | n/a (briefs always carry a `scopePath`) | See the `get_my_brief` exception noted above. |
| Drive-sourced reads | ✅ (`services/memory/access-leakage-eval.test.ts` Case 4, via `memory_query`) | ✅ (`services/memory/access-leakage-eval.test.ts` Case 6) | n/a (Drive-sourced facts are always tagged with the synced Source's own `scopePath` at ingest, never null — see `lib/inngest.ts`'s `fileIngest`) | `services/memory/hybrid-store.ts`'s ingest split routes `actorType: "extraction"` content to Graphiti ONLY, never pgvector, and Graphiti has no containment of its own — but `GuardedMemoryStore.retrieve()` additionally queries Graphiti over every real, registered descendant scope under the read's own target in one call (`descendantScopePaths()`, at most `MAX_SEARCHED_DESCENDANT_SCOPES`, past which the read names the scopes it skipped) and merges the results in (`mergeFacts()`, the same per-tier merge used elsewhere), so a broader/ancestor-scoped grant reaches a descendant scope's Drive-sourced content instead of silently missing it. Case 5 asserts a fixture with no registered descendant scopes sees none; Case 6 is the same scope/query/fixture with real descendant scopes registered, proving the fan-out. |

The `memory_entity` and Drive-sourced-reads ancestor→descendant relationships
depend on `services/access/check.ts`'s `descendantScopePaths()` plus the
descendant leg in `services/memory/guarded-store.ts`'s `retrieve()` and
`entity()` — without it, a broader/ancestor-scoped grant would
silently miss a descendant scope's content rather than surfacing it.
