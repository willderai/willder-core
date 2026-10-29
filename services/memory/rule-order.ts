// The order the task-start block serves a scope's rules in.
//
// A block has room for about ten rules (mcp/task-start-notice.ts) and a scope can hold
// hundreds, so the order decides whether an agent starts a task knowing the rule that governs
// it, or a person has to restate that rule. The words a person writes when assigning a task are
// seldom the words of the rule that will govern it, so ranking by shared words alone misses it
// more often than not. Two things predict it better: the task naming the rule, and the rule
// being recent, since a team's newest decisions are the ones its agents have not yet absorbed.
//
// The one rule this file enforces: rules come in three tiers, each whole before the next.
// 1. Every rule the task cites: its id, or its subject when that is a name (a token holding a
//    digit or a joiner, such as `merge-gate-20260921`), written in the task or in a record the
//    task's own sessions wrote. A plain word in a task never cites a rule.
// 2. The NEWEST_RULES_FIRST newest of the rest.
// 3. Every other rule, by relevance to the task (services/memory/relevance.ts).
// Within each tier the newest comes first among equals. No model decides the order.
import { namesIn, rankByRelevance, type TermCounts, type TermWeights } from "./relevance";

/**
 * How many of a scope's newest rules are served after the rules the task cites and before
 * the rest are ranked by relevance: about half of what a block holds once rule lines are
 * compact (mcp/task-start-notice.ts), so relevance still chooses the other half.
 */
export const NEWEST_RULES_FIRST = 5;

/** A rule as ranked: what is served, and how often each term occurs in its subject and text. */
export interface RuleCandidate<T extends { id: string; subject: string }> {
  item: T;
  terms: TermCounts;
}

/** The names ({@link namesIn}) written in any of `texts`: what a task cites. */
export function citedNames(texts: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const text of texts) for (const name of namesIn(text)) names.add(name);
  return names;
}

/**
 * Whether `cited` names `rule`: its id, or its whole subject. `cited` holds only names
 * ({@link citedNames}), so a subject counts only when it is one name, never a plain word.
 */
function isCited(cited: ReadonlySet<string>, rule: { id: string; subject: string }): boolean {
  return cited.has(rule.id.toLowerCase()) || cited.has(rule.subject.trim().toLowerCase());
}

/**
 * `rules`, which arrive newest first, in the order the block serves them: the ones `cited`
 * names, then the {@link NEWEST_RULES_FIRST} newest of the rest, then the rest by relevance to
 * the task `weights` were drawn from. Each rule appears once.
 */
export function orderRules<T extends { id: string; subject: string }>(
  rules: readonly RuleCandidate<T>[],
  weights: TermWeights,
  cited: ReadonlySet<string>,
): T[] {
  const named = rules.filter(({ item }) => isCited(cited, item));
  const rest = rules.filter(({ item }) => !isCited(cited, item));
  const newest = rest.slice(0, NEWEST_RULES_FIRST);
  const byRelevance = rankByRelevance(rest.slice(NEWEST_RULES_FIRST), weights, ({ terms }) => terms);
  return [...named, ...newest, ...byRelevance].map(({ item }) => item);
}
