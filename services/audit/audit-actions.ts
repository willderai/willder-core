import type { AccessAction, DerivedAuditAction } from "@/services/access";

// The single canonical description of every action the audit trail can hold,
// as the audit trail presents it: the label a screen renders for it, and
// whether that screen shows the row at all. One map answers both questions,
// so a newly added action cannot be visible-but-unlabelled or
// labelled-but-invisible depending on which file its author found first.
//
// Being a Record over AuditAction is the point: a missing key is a compile
// error, which forces whoever adds an action to decide both questions here
// rather than letting it fall through an open switch or a hand-kept array.
// Consumers that hand-enumerate their own subset disagree: one excludes
// "access.manage" (recorded but shown nowhere), another silently drops
// "memory.delete", and a switch echoes the raw string for anything it does
// not list.
//
// This file must stay free of runtime imports, which is why it is separate
// from services/audit/visibility.ts. The three forms of the visibility rule
// live there and two of them need Prisma at runtime (`Prisma.sql`) plus a
// SQL-escaping helper; `parseAction` reaches THIS file from client
// components (app/(app)/audit/page.tsx, app/(app)/agents/page.tsx), where
// importing that would pull the Prisma client into the browser bundle. The
// `import type` above is erased at compile time, so this module has no
// runtime dependency at all. visibility.ts derives every rule from the map
// below rather than restating it, so the split costs nothing in drift.

/**
 * Every value `audit_log.action` can hold: the actions `check()` authorizes,
 * plus the ones the additive recorders in `services/access/check.ts` write
 * after the fact (see {@link DerivedAuditAction} for why those are a separate
 * union rather than more `AccessAction` members).
 *
 * The two halves differ in what they mean and agree in what this file needs
 * from them -- a label and a visibility rule -- so one exhaustive map covers
 * both and there is still exactly one list of actions in the codebase.
 */
export type AuditAction = AccessAction | DerivedAuditAction;

/** How the audit surfaces decide whether to show a row of a given action. */
type AuditVisibility =
  /** Every row of this action is shown, target aside. */
  | "always"
  /** No row of this action is ever shown. */
  | "never"
  /** An allow row is shown only when its own `target` contains one of these
   * markers. A deny row follows the same markers unless `denyAlways` is set,
   * in which case every deny row of the action is shown, target aside. */
  | { readonly targetContains: readonly string[]; readonly denyAlways?: true };

export interface AuditActionMeta {
  /** Human-readable label for the audit trail's Action column. */
  label: string;
  /** Whether an audit-adjacent screen (the audit list, the actors picker, a
   * run's own trail) surfaces this action. "always" and "never" apply to
   * allow and deny rows alike; the object form can treat deny rows
   * separately (see `denyAlways`). */
  visibility: AuditVisibility;
}

/**
 * Exhaustive over AuditAction. Every audit-adjacent screen derives from
 * this and nothing hand-maintains a parallel list.
 */
export const AUDIT_ACTIONS: Record<AuditAction, AuditActionMeta> = {
  "memory.read": { label: "Read memory", visibility: "always" },
  "memory.entity": { label: "Viewed entity", visibility: "always" },
  "memory.write": { label: "Saved to memory", visibility: "always" },
  "memory.delete": { label: "Removed from memory", visibility: "always" },
  // Every deny row is shown. A refusal is exactly what an org reads its trail
  // for, and a filter that hides denials would leave the page's denied count
  // reassuringly low. Denies here come only from callers without access.manage
  // hitting an admin gate, so they carry none of the volume problem below.
  //
  // Allow rows are not a plain boolean: the action covers both real admin
  // mutations an org wants to see (a grant created/revoked, a fact dispute
  // resolved) and high-volume internal probe/list reads (grants:list,
  // fact_disputes, audit:list) that would drown the mutations out as noise.
  // The action does not separate these; only the row's own `target` does. Every
  // call site (services/access/check.ts's recordAudit(), invoked from
  // app/api/access/grants/route.ts, app/api/access/grants/[id]/route.ts,
  // app/api/facts/disputes/route.ts and
  // app/api/facts/disputes/[id]/resolve/route.ts) already encodes which case
  // it is: "grants:create:<scope>" / "grants:revoke:<id>" /
  // "fact_dispute:<id>" for a real mutation, versus the exact "grants:list" /
  // "fact_disputes" literals for a probe read. recordAudit() prefixes
  // whatever target a caller passes with `${targetPath}/`, so a stored row
  // reads "org_x.dept/grants:create:org_x.dept" -- hence a substring match,
  // not a prefix one. capabilities:* and scopes:* targets are deliberately
  // not markers: their allow rows are out of this rule's boundary and stay
  // hidden (their deny rows are shown, as above). The one
  // exception is "capabilities:leak-revoke:", a token GitHub found in public
  // content and Willder revoked on its own (services/secret-scanning/github.ts):
  // low volume, and exactly the event an org has to be able to see. So is
  // "audit:export:", an administrator copying the audit log out
  // (app/api/audit/export/route.ts): who took the log, and which range.
  "access.manage": {
    label: "Managed access",
    visibility: {
      targetContains: [
        "grants:create:",
        "grants:revoke:",
        "fact_dispute:",
        "capabilities:leak-revoke:",
        "audit:export:",
      ],
      denyAlways: true,
    },
  },

  // The derived half. `check()` records the scope a write was AUTHORIZED
  // against; the guarded store runs the real mutation against
  // `scope ?? input.groupId`, which is a different partition whenever the
  // caller passes no scope. These two rows carry that second path, so an
  // org can see not just that a destructive write was allowed and landed but
  // which partition it landed in -- the difference between a correctly
  // scoped delete and a wrongly scoped one. Low volume: only the three
  // destructive guarded-store methods write them.
  "memory.write.effect": { label: "Write applied to scope", visibility: "always" },
  "memory.delete.effect": { label: "Delete applied to scope", visibility: "always" },

  // Hidden, and listed here rather than left unknown so that stays a decision
  // someone made. Each is internal plumbing read by code, never by a person:
  // `memory.read.factIds` links a read to the fact ids it returned,
  // `*.applied` feeds a brief's staleness check
  // (`auditChangesUnderScope()`), and `brief.acknowledged` backs
  // `latestBriefAcknowledgement()`. Surfacing them would roughly double every
  // audit page's row count with rows that only repeat their neighbours.
  "memory.read.factIds": { label: "Read returned facts", visibility: "never" },
  "memory.write.applied": { label: "Write landed", visibility: "never" },
  "memory.delete.applied": { label: "Delete landed", visibility: "never" },
  "brief.acknowledged": { label: "Acknowledged brief", visibility: "never" },

  // An admin waived one moved or disconnected source that withdrew a brief
  // (services/memory/brief-retirement.ts `unretireBrief`); the brief reads again
  // once no other source withdraws it. Shown because it can re-expose content
  // the product had hidden on its own.
  "brief.unretired": { label: "Waived a source for a withdrawn brief", visibility: "always" },

  // A revoked or expired token presented again: the deny an org checks for
  // after revoking, and at most one row per request the dead token makes.
  "capability.refused": { label: "Refused a revoked or expired token", visibility: "always" },

  // A request refused by a gate other than check() (services/access/refusal.ts):
  // an operation reserved for org owners and admins asked for by someone else, or
  // one reserved for the operator organization. Shown because a refusal is exactly
  // what an org reads its trail for. Not rare: the Settings page asks for the org
  // roles and aliases lists on load, so each visit by a member writes two.
  "access.refused": { label: "Refused: needs a role or organization the caller lacks", visibility: "always" },

  // A person connected a source knowing it lets more people read its content
  // than can read it at the source, or that the source could not say who reads
  // it (services/access/source-widening.ts). Shown because it is exactly the
  // question "who widened access to this?" and the answer must stay findable.
  "source.widening.acknowledged": {
    label: "Connected a source readable by more people than at the source",
    visibility: "always",
  },

  // An agent wrote into a scope content it was shown in a scope that not every reader
  // of the target can read, and declared it (services/access/derived-writes.ts). The row
  // sits in the source scope and names the target in `metadata.sharedInto`. Shown because
  // "where did this scope's content go?" is the question it answers.
  "memory.write.declassified": {
    label: "Shared content from a restricted scope into a wider one",
    visibility: "always",
  },

  // A person erased on request (services/memory/person-erasure.ts): one row per
  // completed request, carrying how many records each store removed and never a
  // value it removed. Shown because it is the record an org produces when asked
  // to prove an erasure happened; its `access.manage` decision row stays hidden
  // with the other probe-like targets.
  "person.erased": { label: "Erased a person", visibility: "always" },
  // One committed step of a person erasure and its counts (services/memory/erasure-accounting.ts),
  // read by the erasure to total its one `person.erased` row, never by a person.
  "person.erasure_step": { label: "Erasure step committed", visibility: "never" },
  // A person erasure request that ended without erasing everything
  // (services/memory/person-erasure-requests.ts): its job failed, needed an operator, could not
  // be queued, or never finished. One row per failed request, carrying the sentence the
  // requester is told and never the person. Shown because an admin who asked for an erasure
  // must be able to see that it did not complete, and send it again.
  "person.erasure_failed": { label: "Erasure did not finish", visibility: "always" },

  // A person disconnected an app they had connected with OAuth
  // (services/access/oauth-connection.ts `revokeOAuthConnection`), ending its
  // capability. Shown because when an app stopped reaching memory, and who stopped
  // it, is what an org asks after the fact.
  "oauth.disconnected": { label: "Disconnected an app", visibility: "always" },

  // An org admin permanently removed a record that was already out of service: a
  // disconnected source, a retired rule or a brief (services/memory/record-removal.ts).
  // One row per removal, written with the delete, naming what went and, for a rule, the
  // versions it replaced and was replaced by. Shown because a record that vanishes
  // has to be explainable from the trail; the removal's `access.manage` decision row
  // stays hidden with the other probe-like targets.
  "record.removed": { label: "Permanently removed a record", visibility: "always" },
};

const ALL_ACTIONS = Object.keys(AUDIT_ACTIONS) as AuditAction[];

/** Actions shown regardless of the row's target. */
export const ALWAYS_VISIBLE_ACTIONS = ALL_ACTIONS.filter((action) => AUDIT_ACTIONS[action].visibility === "always");

/** Actions shown only for certain targets, paired with their markers. */
export const TARGET_CONDITIONAL_ACTIONS = ALL_ACTIONS.flatMap((action) => {
  const { visibility } = AUDIT_ACTIONS[action];
  return typeof visibility === "object" ? [{ action, markers: visibility.targetContains }] : [];
});

/** Target-conditional actions whose deny rows are shown regardless of target. */
export const DENY_ALWAYS_ACTIONS = ALL_ACTIONS.filter((action) => {
  const { visibility } = AUDIT_ACTIONS[action];
  return typeof visibility === "object" && visibility.denyAlways === true;
});

/** The label an audit surface renders for `action`.
 *
 * `action` is the audit_log column, a plain string at the DB/API boundary,
 * not a narrowed AuditAction -- a row written by an older or newer deploy is
 * a real possibility this display layer tolerates, so an unrecognized value
 * falls back to the raw string rather than throwing. A newly added
 * AuditAction cannot reach that fallback, because {@link AUDIT_ACTIONS} is
 * exhaustive. */
export function auditActionLabel(action: string): string {
  return (AUDIT_ACTIONS as Record<string, AuditActionMeta | undefined>)[action]?.label ?? action;
}
