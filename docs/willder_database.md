> **What actually ships (2026-10-01).** This is the prose companion to
> `prisma/schema.prisma`, which cites it on line 2, as do `types/domain.ts` and
> `prisma/migrations/20260713_fact_disputes/migration.sql`. Most of the tables described
> here exist today under the documented names and fields: `Org`, `User`, `Account`,
> `Contact`, `Conversation`, `Message`, `Agent`, `AgentRun`, `Brief`, `FactDispute`,
> `Scope`, `Grant`, `Capability`, `AuditLog`, `Integration`, `FeedbackEvent`,
> `EntityAlias` and `OrgRole`. Four parts are stale and are flagged inline below: the
> `campaigns` / `campaign_prospects` / `drafts` outbound tables, Stripe
> `subscriptions` / `usage`, the Upstash Redis tier, and §2's claim that no pgvector is
> needed. Read `prisma/schema.prisma` for the authoritative shape.

# Willder Database Plan

Three databases, each with one job, linked by shared ids. Plus optional blob storage.

| Store | Role | Holds |
|---|---|---|
| **Neon (Postgres)** | App system of record | structured app data, access policy, billing |
| **Neo4j** (via Graphiti) | Memory system of record | knowledge graph + vectors |
| ~~**Upstash Redis**~~ | ~~Cache (ephemeral)~~ | **Not built (2026-10-01)** — see §3. |
| *Blob (Vercel/R2)* | *Large files (optional)* | *raw documents/attachments* |

Division of responsibility: **Postgres = app state**, **Neo4j = memory**. Each canonical record has exactly one home. They link by shared ids. (There is no Redis speed layer as shipped — see §3.)

---

## 1. Neon (Postgres) — app system of record

Structured, transactional, relational. Fast list/filter/joins, ACID. **Every table carries `namespace_id` (tenant) and is access-checked.**

**Auth / org**
- `orgs` — id, name, settings, plan
- `users` — id, org_id, email, role (synced from Clerk)

**CRM (structured records)**
- `accounts` — id, org_id, name, domain, status, **entity_id** (→ Neo4j)
- `contacts` — id, org_id, account_id, name, email, title, status, **entity_id** (→ Neo4j)

**Outbound**

> **Removed (2026-10-01).** `campaigns`, `campaign_prospects` and `drafts` went with the
> research-to-outreach era and are not in `prisma/schema.prisma`. `conversations` and
> `messages` below do ship, as `Conversation` and `Message`.

- ~~`campaigns` — id, org_id, name, icp, tone, cadence, status~~
- ~~`campaign_prospects` — campaign_id, contact_id, status (queued/sent/replied/booked)~~
- ~~`drafts` — id, org_id, campaign_id, contact_id, body, status (pending/approved/sent/rejected), edited_body~~
- `conversations` — id, org_id, contact_id, channel, thread_ref
- `messages` — id, conversation_id, direction (out/in), body, sent_at

**Agents**
- `agents` — id, org_id, role, instructions, tone, scope (capability), status
  - `role` includes **`handoff`** (UC6), **`architecture`** (UC7, plans grounded in
    constraints/system-design/UX-UI/business-logic memory) and **`qa`** (UC8, text/diff-level
    review; it does not execute code). Alongside the original `research`/`copy`/
    `custom`. Same table shape for all six — no schema change beyond the enum values.
- `agent_runs` — id, agent_id, status, input, result, started_at, finished_at

**Briefs (v2 — generalized: UC6 Handoff, UC7 Architecture plans, UC8's descoped QA fallback)**
- `briefs` — id, org_id, **type** (`handoff` | `architecture_plan` | `qa_review`), grantee_name?,
  grantee_role?, scope_path, title, summary, sections (JSON: `[{heading, content}]`), diagram?
  (Mermaid text), diagram_url? (`draw.io` link), google_doc_url?, **milestones?** (JSON:
  `[{label, dueDate}]` — populated only for `architecture_plan` outputs that include a schedule,
  null otherwise), created_at. One table, one shape, disambiguated by `type` rather than three
  near-identical tables — same pattern as `agents.role` covering research/copy/handoff/custom.
  Backs the internal shareable link (`GET /api/briefs/:id`), which works with zero setup
  regardless of whether the org has Drive connected. `google_doc_url` is populated on export
  (`POST /api/briefs/:id/export-doc`), reusing the existing `drive.file` OAuth — no new
  integration table, no token storage beyond what `integrations` already holds. Full UC8 (bugs
  found, UI mistakes, run time, per-item tracking) would want richer structure than `sections` —
  deliberately not designed here since only the text-review fallback ships this cycle; revisit
  when the Managed-Agents-based full QA agent actually gets built.

**Fact disputes (v2 — UC9, closes a real gap: `docs/willder_conflict_resolution.md` says dispute
state is "app state (Postgres) referencing the Graphiti edge uuids," but no table existed for it)**
- `fact_disputes` — id, org_id, scope_path, graphiti_fact_uuid (the disputed Neo4j edge),
  proposer_actor_type, proposer_actor_id, existing_actor_type, existing_actor_id, status
  (`disputed` | `resolved_proposer` | `resolved_existing` | `resolved_reconciled` | `rejected`),
  resolved_value? (only for `resolved_reconciled`), resolver_id?, resolved_at?, created_at.
  Populated only for the same-tier-contradiction case (`willder_conflict_resolution.md`'s actual
  dispute case) — the auto-merge case (provenance outranks) never creates a row here, it just
  invalidates-and-appends in Neo4j directly. The scope-admin resolution UI (reusing the existing
  approval-inbox pattern) queries this table for pending (`status = disputed`) rows.

**Access control**
- `scopes` — id, org_id, path (`ltree`)  — the scope tree (namespace → dept → account → deal)
- `grants` — id, scope_id, grantee_id, grantee_type (user/group/role), permission
- `roles` / `groups` — membership
- `capabilities` — id, agent_id, scope, expires_at  — agent capability tokens
- `audit_log` — id, org_id, actor_id, action, target, at  (append-only)

**Integrations / billing / learning**
- `integrations` — id, org_id, provider, encrypted_tokens, status
- ~~`subscriptions`, `usage` — Stripe billing + metered usage~~ — **not built (2026-10-01).** There is no billing schema; `integrations` and `feedback_events` around it do ship.
- `feedback_events` — id, org_id, type (edit/reply/open/meeting), payload, source_ref, created_at  (captured cheaply, processed async)
  - **v2 addition:** an edit/reject event now also writes back to Neo4j as an episode via the
    existing provenance auto-merge rule (human outranks agent → invalidate prior, record
    correction) — the fact-governance mechanism in `docs/willder_conflict_resolution.md`,
    activated rather than a new table. No Postgres schema change; this is a new *consumer* of the
    existing row, not a new column.

**Entity resolver (memory quality layer)**
- `entity_aliases` — id, org_id, entity_type, entity_id, canonical_name, aliases[] — admin-curated alias registry; maps nicknames/pronouns/relational refs to canonical names before Graphiti ingestion. Highest-priority tier in the resolver.
- `org_roles` — id, org_id, role, user_id, aliases[] — maps job titles (CEO, CTO, founder) to specific users. Separate from Clerk permission roles; text-resolution only. Tier 1b in the resolver.

**CRM additions**
- `accounts.owner_id` — nullable FK → users.id; the team member who owns this account. Used by the resolver to generate "owner of Acme Corp" → owner name aliases for memory normalization.

> **Correction (2026-10-01).** This is now false. pgvector *is* used: `MemoryChunk.embedding`
> in `prisma/schema.prisma` is a `vector(384)` column with its own index, written and read
> through raw SQL. Vectors live in Postgres as well as in the memory graph.

*~~Note: no `pgvector` needed — vectors live in Neo4j (below).~~*

---

## 2. Neo4j — memory system of record (via Graphiti)

The knowledge graph + embeddings + vector search. **Partitioned by `group_id` = `namespace_id`; access enforced in the MemoryStore wrapper before any fact returns.**

**Episode (node)** — raw source, kept verbatim for provenance
- uuid, group_id, source, content, embedding, created_at, valid_at

**Entity (node)** — graph node (person/company/deal), deduplicated
- uuid, group_id, name, type, attributes, name_embedding, created_at
- **created_by, actor_type** (human/agent/extraction)

**Fact (edge)** — proposition between entities; the retrieved answer; bi-temporal
- uuid, group_id, subject, predicate, object (entity or literal), fact_text, fact_embedding, confidence
- **source_event_ids** (provenance), **created_by, actor_type, invalidated_by**
- valid_at / invalid_at (real-world truth), created_at / expired_at (when believed)

**Relation (edge)** — typed relationship between entities
**Community (node)** — entity clusters (optional, Graphiti communities)

Retrieval: vector (embeddings) + keyword + graph traversal + fusion, all inside Graphiti, then access-filtered by the wrapper.

---

## 3. Upstash Redis — cache (ephemeral, not a record store)

> **Not built (2026-10-01).** Nothing in this section shipped. The repository has no Redis
> dependency; reads go to Postgres and the memory service, and the access-scoped caching
> described here is handled per call in `services/access` and `services/memory`.

Speed layer over reads. Never the source of truth. Two hard rules: **key by access scope** (or it leaks) and **invalidate on write** (temporal data goes stale).
- Session hot cache — per-agent working set, scoped by access, expires at session end
- Embedding cache — text → vector (safe to cache long; embeddings are stable)
- Query-result cache — short TTL
- Optional: rate-limit counters

---

## 4. Blob storage (optional, defer)

Vercel Blob or Cloudflare R2 for large raw files (uploaded docs, attachments). The *text* is extracted into Neo4j as episodes; large binaries go to blob. Skip until you ingest big files.

---

## Cross-cutting rules

- **Tenant isolation everywhere:** every Postgres row has `namespace_id`; every Neo4j node/edge has `group_id`. No query crosses tenants.
- **Linking:** Postgres `accounts`/`contacts` carry `entity_id` → the Neo4j entity. Postgres = structured + fast; Neo4j = rich memory. A little denormalization (name in both) is fine.
- **Temporal, not destructive:** Neo4j facts invalidate-and-append (never overwrite). Postgres `audit_log` and `feedback_events` are append-only.
- **Vectors live in Neo4j**, not Postgres. No separate vector DB.
- **Access control is built on Postgres** (`scopes`/`grants`/`ltree` + `check()`) and enforced over Neo4j reads via the MemoryStore wrapper.

## The contacts/accounts overlap (the one design call)
Contacts/accounts exist in both worlds:
- **Postgres** holds the structured CRM record (name, email, status) — fast list/filter/segment + campaign joins.
- **Neo4j** holds the memory entity (facts/knowledge).
- **Linked by `entity_id`.** Keeps the app fast and the memory rich without forcing contact-list queries through the graph or stuffing CRM fields into graph nodes.
