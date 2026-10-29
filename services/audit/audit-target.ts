// How a memory partition is written into an audit_log `target`, and how the
// audit screens read it back. Shared by the writer (services/access/check.ts),
// its callers (services/memory/guarded-store.ts) and the reader
// (components/audit/format.ts) so one encoding is defined once instead of
// being re-derived, differently, on each side.
//
// A partition is named in one of two parallel namespaces:
//
//   group_id     `<orgId>`, `<orgId>.<sub>`
//                The untagged Graphiti/pgvector partition a write lands in
//                when its caller passes no scope. GuardedMemoryStore's
//                assertTenant() guards this shape.
//
//   scope path   `org_<orgId>`, `org_<orgId>.<sub>`
//                A registered ltree scope. Every `Scope.path` row and every
//                target check() records uses it.
//
// They are not interchangeable. `<orgId>` is the untagged partition and
// `org_<orgId>` is the org-root scope, and a write authorized against the
// second can land in the first. A
// target naming a partition therefore has to say which namespace it means,
// which is what GROUP_ID_TARGET_PREFIX marks: without it the two render
// identically and the audit trail cannot answer the one question the row was
// added to answer.
//
// This file must stay free of runtime imports: components/audit/format.ts
// reads the prefix from a client bundle. Same constraint, same reason, as
// services/audit/audit-actions.ts.

/**
 * Marks the partition half of an audit `target` as a raw `group_id` rather
 * than a scope path, as in `group:<orgId>.sales/fact:f1`.
 *
 * Only the group_id half is marked. A scope path stays bare, because every
 * target check() has ever recorded is one and those rows must keep parsing.
 */
export const GROUP_ID_TARGET_PREFIX = "group:";
